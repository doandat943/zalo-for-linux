const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const NATIVELIBS_DIR = path.join(__dirname, '..', '..', 'nativelibs');
const BUILDER_SCRIPT = path.join(NATIVELIBS_DIR, 'builder-rust.js');
const MP4THUMB_DIR = path.join(NATIVELIBS_DIR, 'mp4thumb');

async function main() {
  logger.info('Building mp4thumb from source...');

  if (!fs.existsSync(path.join(MP4THUMB_DIR, 'Cargo.toml'))) {
    logger.warn('mp4thumb not found, skipping');
    return;
  }

  try {
    execSync(`node "${BUILDER_SCRIPT}" "${MP4THUMB_DIR}"`, {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'pipe'
    });
  } catch (error) {
    logger.error('Failed to build mp4thumb', error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    throw new Error(`Failed to build mp4thumb`);
  }

  const releaseDir = path.join(MP4THUMB_DIR, 'target', 'release');
  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));

  const destDir = path.join(APP_DIR, 'native', 'nativelibs', 'mp4thumb', 'linux');
  fs.ensureDirSync(destDir);

  for (const file of nodeFiles) {
    fs.copyFileSync(
      path.join(releaseDir, file),
      path.join(destDir, file)
    );
  }

  const indexJsPath = path.join(APP_DIR, 'native', 'nativelibs', 'mp4thumb', 'index.js');
  if (fs.existsSync(indexJsPath)) {
    let content = fs.readFileSync(indexJsPath, 'utf8');

    if (!content.includes("process.platform === 'linux'")) {
      content = content.replace(
        `else {\n            if(process.arch === 'arm64'){`,
        `else if(process.platform === 'linux') {\n            thumbModule = require(\`./linux/mp4thumb.node\`);\n        }\n        else {\n            if(process.arch === 'arm64'){`
      );
      fs.writeFileSync(indexJsPath, content, 'utf8');
      logger.dim('Patched index.js for Linux support');
    }
  }

  logger.success('mp4thumb built and installed');
}

if (require.main === module) {
  main();
}

module.exports = { main };