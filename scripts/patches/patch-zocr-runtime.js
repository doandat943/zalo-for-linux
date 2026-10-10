#!/usr/bin/env node
"use strict";
const { execSync, execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { createHash } = require('node:crypto');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const ZOCR_DIR = path.join(__dirname, '..', '..', 'zocr');
const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');
const ONNXRUNTIME_URL = `https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-linux-${process.arch === 'arm64' ? 'aarch64' : 'x64'}-1.30.0.tgz`;

// Extract the 32-byte seed used by the OCR model vault.
function extractKey(data) {
  function requireBytes(offset, length) {
    if (offset < 0 || offset + length > data.length) {
      throw new Error('Truncated host executable.');
    }
  }

  requireBytes(0, 64);
  if (data.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Missing DOS MZ signature.');
  }
  const peOffset = data.readUInt32LE(0x3c);
  requireBytes(peOffset, 24);
  if (!data.subarray(peOffset, peOffset + 4).equals(Buffer.from('PE\0\0'))) {
    throw new Error('Missing PE signature.');
  }
  const count = data.readUInt16LE(peOffset + 6);
  const table = peOffset + 24 + data.readUInt16LE(peOffset + 20);
  requireBytes(table, count * 40);

  const sections = [];
  for (let i = 0; i < count; i++) {
    const entry = table + i * 40;
    sections.push({
      name: data.toString('latin1', entry, entry + 8).replace(/\0+$/, ''),
      virtualSize: data.readUInt32LE(entry + 8),
      rva: data.readUInt32LE(entry + 12),
      rawSize: data.readUInt32LE(entry + 16),
      rawOffset: data.readUInt32LE(entry + 20),
    });
  }
  const text = sections.findLast(section => section.name === '.text');
  if (!text) {
    throw new Error('Missing executable .text section.');
  }
  requireBytes(text.rawOffset, text.rawSize);
  const textDigest = createHash('sha256')
    .update(data.subarray(text.rawOffset, text.rawOffset + text.rawSize))
    .digest('hex');

  function chunk(rva) {
    const section = sections.find(section =>
      rva >= section.rva && rva < section.rva + Math.max(section.virtualSize, section.rawSize));
    if (!section) throw new Error(`Unmapped RVA: 0x${rva.toString(16)}`);
    const offset = section.rawOffset + rva - section.rva;
    requireBytes(offset, 32);
    return data.subarray(offset, offset + 32);
  }

  const first = chunk(0x4411f6);
  const second = chunk(0x441216);
  return {
    seed_key: Buffer.from(first.map((byte, i) => byte ^ second[i])).toString('hex'),
    text_digest_key: textDigest,
  };
}


function patch(source) {
  const replacements = [
    {
      from: 'Ce=["zocr-host.exe"',
      to: 'Ce=process.platform==="linux"?["zocr-host","libonnxruntime.so","zocr/models.zmdl","seed_key","text_digest_key"]:["zocr-host.exe"'
    },
    {
      from: 'join)(e,"zocr-host.exe")',
      to: 'join)(e,process.platform==="linux"?"zocr-host":"zocr-host.exe")'
    },
    {
      from: 'function We(e,r){return e?',
      to: 'function We(e,r){if(process.platform==="linux")return(0,$.join)(__dirname,"../../ocr");return e?'
    },
    {
      from: 'switch(K){case"win32":',
      to: 'switch(K){case"linux":if(G!=="x64"&&G!=="arm64")k=new Error(`Unsupported architecture on Linux: ${G}`);break;case"win32":'
    },
    {
      from: 'function Ie(){return K===',
      to: 'function Ie(){if(K==="linux")return G==="x64"||G==="arm64"?null:"unsupported-platform";return K==='
    },
    {
      from: 'if(K==="win32"){let{engine:',
      to: 'if(K==="win32"||K==="linux"){let{engine:'
    }
  ];
  for (const { from, to } of replacements) {
    if (source.split(to).length === 2) continue;
    if (source.split(from).length !== 2) {
      throw new Error(`loader does not match expected source: ${from}`);
    }
    source = source.replace(from, to);
  }
  return source;
}

function build() {
  logger.info('Building zocr-host from source...');
  if (!fs.existsSync(path.join(ZOCR_DIR, 'Cargo.toml'))) {
    logger.warn('zocr not found, skipping');
    return false;
  }

  try {
    execSync('cargo build --release', { cwd: ZOCR_DIR, stdio: 'pipe' });
  } catch (error) {
    logger.error('Failed to build zocr-host', error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    if (error.stderr) logger.dim(error.stderr.toString());
    throw new Error('Failed to build zocr-host');
  }

  const destDir = path.join(APP_DIR, 'native', 'ocr');
  fs.ensureDirSync(destDir);
  fs.copyFileSync(
    path.join(ZOCR_DIR, 'target', 'release', 'zocr-host'),
    path.join(destDir, 'zocr-host')
  );
  const version = process.env.ZALO_WIN_VERSION;
  if (!version) throw new Error('ZALO_WIN_VERSION is required; run prepare-app.js first');
  const pluginsDir = path.join(TEMP_DIR, `Zalo-Win-${version}`, `Zalo-${version}`, 'plugins', 'ocr');
  for (const file of ['zocr/models.zmdl', 'THIRD_PARTY_NOTICES.txt']) {
    fs.copySync(path.join(pluginsDir, file), path.join(destDir, file));
    logger.dim(`Copied ${file} to ${path.relative(APP_DIR, destDir)}`);
  }
  const keys = extractKey(fs.readFileSync(path.join(pluginsDir, 'zocr-host.exe')));
  for (const [name, value] of Object.entries(keys)) {
    fs.writeFileSync(path.join(destDir, name), value + '\n', { mode: 0o600 });
    logger.dim(`Key written to ${path.relative(APP_DIR, destDir)}/${name}`);
  }
  logger.success('zocr-host built and installed');
  return true;
}

function installOnnxRuntime() {
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error(`Unsupported architecture for ONNX Runtime: ${process.arch}`);
  }
  fs.ensureDirSync(TEMP_DIR);
  const filename = path.basename(new URL(ONNXRUNTIME_URL).pathname);
  const archive = path.join(TEMP_DIR, filename);
  if (!fs.existsSync(archive)) {
    logger.info('Downloading ONNX Runtime...');
    try {
      execFileSync('wget', ['--progress=bar:force', ONNXRUNTIME_URL, '-O', archive], { stdio: 'inherit' });
    } catch (error) {
      fs.removeSync(archive);
      throw new Error(`Failed to download ONNX Runtime: ${error.message}`);
    }
  } else {
    logger.dim('Using cached ONNX Runtime archive');
  }

  logger.info('Extracting ONNX Runtime...');
  const extractDir = path.join(TEMP_DIR, filename.replace(/\.tgz$/, ''));
  fs.ensureDirSync(extractDir);
  execFileSync('tar', ['-xzf', archive, '-C', extractDir, '--strip-components=1'], { stdio: 'pipe' });
  const destDir = path.join(APP_DIR, 'native', 'ocr');
  fs.ensureDirSync(destDir);
  fs.copySync(
    fs.realpathSync(path.join(extractDir, 'lib', 'libonnxruntime.so')),
    path.join(destDir, 'libonnxruntime.so')
  );
  logger.success('libonnxruntime.so installed');
}

async function main() {
  if (!build()) return;
  installOnnxRuntime();
  
  logger.info('Patching OCR runtime for Linux...');
  const file = path.join(APP_DIR, 'native', 'nativelibs', 'zocr', 'zocr.min.js');
  const source = fs.readFileSync(file, 'utf8');
  const updated = patch(source);
  if (updated === source) {
    logger.success('OCR runtime already patched');
    return;
  }
  fs.writeFileSync(file, updated, 'utf8');
  logger.dim(`Patched ${path.relative(APP_DIR, file)}`);
  logger.success('OCR runtime patched for Linux');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    logger.error('Failed to patch OCR runtime', error.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
