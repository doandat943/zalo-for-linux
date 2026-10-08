const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const BASE_DIR = path.join(__dirname, '..');
const APP_DIR = path.join(BASE_DIR, 'app');
const DIST_DIR = path.join(BASE_DIR, 'dist');

let ZALO_VERSION = null;
const builtFiles = [];

async function main() {
  try {
    // Read version from package.json.bak
    const packageJsonBakPath = path.join(APP_DIR, 'package.json.bak');
    if (fs.existsSync(packageJsonBakPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonBakPath, 'utf8'));
      ZALO_VERSION = packageJson.version;
      logger.info('Zalo version from package.json.bak:', ZALO_VERSION);

      // Export global outputs for workflow
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `zalo_version=${ZALO_VERSION}\n`);
      }
    } else {
      logger.warn('package.json.bak not found, version will be unknown');
    }

    // Calls run on the native engine (zcall-native/, shipped by extraFiles) in
    // both variants: no Wine runtime, no Full variants.

    // Phase 1: Build original Zalo
    logger.step('PHASE 1: Building Zalo (Original)');
    await build('(Original)', '');

    // Phase 2: Apply ZaDark integration and build final product
    logger.step('PHASE 2: Building Zalo (with ZaDark)');

    // Patch ZaDark directly into APP_DIR
    await integrateZaDark();
    await build('(with ZaDark)', '-ZaDark');

    // Final summary
    logger.step('BUILD SUMMARY');
    if (builtFiles.length > 0) {
      builtFiles.forEach(({ type, name, sizeStr }) => {
        logger.info(`${type} • ${name} (${sizeStr})`);
      });
    } else {
      logger.warn('No AppImage files were built in this run');
    }
  } catch (error) {
    logger.error('Main workflow failed:', error.message);
    process.exit(1);
  }
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : (p.endsWith('.js') ? [p] : []);
  });
}

// electron-builder's extraFiles filter decides what zcall-native/ ships. The
// engine dies at startup if a file it requires was filtered out, so check the
// packaged copy: every relative require resolves, and audio-io.py's opus_play.
function checkEnginePackaged(dir) {
  const missing = [];
  if (!fs.existsSync(dir)) throw new Error('call engine missing from the package: ' + dir);
  for (const file of jsFiles(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)) {
      try { require.resolve(path.resolve(path.dirname(file), m[2])); } catch (_) {
        missing.push(`${path.relative(dir, file)} requires ${m[2]}`);
      }
    }
  }
  if (!fs.existsSync(path.join(dir, 'tools', 'opus_play.py'))) missing.push('audio-io.py imports tools/opus_play.py');
  if (missing.length) throw new Error('call engine incomplete in the package: ' + missing.join('; '));
}

async function integrateZaDark() {
  logger.info('Applying ZaDark patches...');

  try {
    // Verify ZaDark module is available
    const zadarkModulePath = path.join(BASE_DIR, 'plugins', 'zadark', 'build', 'pc', 'zadark-pc.js');
    if (!fs.existsSync(zadarkModulePath)) {
      throw new Error('ZaDark PC module not found - run "npm run prepare-zadark" first');
    }

    const zadarkPC = require(zadarkModulePath);
    zadarkPC.copyZaDarkAssets(BASE_DIR);
    zadarkPC.writeIndexFile(BASE_DIR);
    zadarkPC.writeBootstrapFile(BASE_DIR);
    zadarkPC.writePopupViewerFile(BASE_DIR);
    // Zalo's dark theme strips ZaDark's CSS/scripts from the page (#66).
    await require('./patches/patch-zadark-keep').main(APP_DIR);
    logger.success('ZaDark patches applied successfully');

  } catch (error) {
    logger.error('ZaDark integration failed:', error.message);
    logger.info('Continuing with original app directory...');
  }
}

async function build(buildName = '', outputSuffix = '') {
  try {
    // Get git commit hash for filename
    const commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const St2script = path.join(BASE_DIR, 'scripts', 'build-stage2.sh');

    // Add the arch suffix for builds
    const archSuffix = (process.arch === 'arm64' || process.arch === 'aarch64') ? '-aarch64' : '-x86_64';

    // Set artifact name and build command based on build type
    let artifactName;
    let buildCommand;
    let zadarkVersion = null;

    if (outputSuffix === '-ZaDark') {
      // Read ZaDark version for custom naming
      const zadarkPackagePath = path.join(BASE_DIR, 'plugins', 'zadark', 'package.json');
      zadarkVersion = 'unknown';

      if (fs.existsSync(zadarkPackagePath)) {
        try {
          const zadarkPackage = JSON.parse(fs.readFileSync(zadarkPackagePath, 'utf8'));
          zadarkVersion = zadarkPackage.version;
        } catch (error) {
          logger.warn('Could not read ZaDark version, using "unknown"');
        }
      }

      artifactName = `Zalo-Linux-Native-${ZALO_VERSION}+ZaDark-${zadarkVersion}-${commitHash}${archSuffix}.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      buildCommandst2 = `chmod +x "${St2script}" && "${St2script}" "${ZALO_VERSION}" "${artifactName}" "${DIST_DIR}"`;
      logger.info(`Building ${buildName} with Zalo: ${ZALO_VERSION}, ZaDark: ${zadarkVersion}, Commit: ${commitHash}`);
    } else {
      artifactName = `Zalo-Linux-Native-${ZALO_VERSION}-Original-${commitHash}${archSuffix}.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      buildCommandst2 = `chmod +x "${St2script}" && "${St2script}" "${ZALO_VERSION}" "${artifactName}" "${DIST_DIR}"`;
      logger.info(`Building ${buildName} with Zalo: ${ZALO_VERSION}, Commit: ${commitHash}`);
    }
    // Write build-info.json to the app directory so the AppImage will contain its metadata
    const buildInfo = {
      version: ZALO_VERSION,
      zadarkVersion: outputSuffix === '-ZaDark' ? zadarkVersion : null,
      commit: commitHash,
      buildDate: new Date().toISOString()
    };
    
    const buildInfoPath = path.join(APP_DIR, 'pc-dist', 'build-info.json');
    if (fs.existsSync(path.join(APP_DIR, 'pc-dist'))) {
      fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2), 'utf8');
      logger.dim(`Wrote metadata: ${buildInfoPath}`);
    } else {
      logger.warn('pc-dist directory not found, skipping build-info.json');
    }

    logger.dim(`Command: ${buildCommand}`);
    logger.dim(`Command (Stage 2): ${buildCommandst2}`);

    // Capture build output to get file information. Between the two stages,
    // check that the unpacked app carries the whole call engine.
    let buildOutput = execSync(buildCommand, { stdio: 'pipe', cwd: path.join(BASE_DIR), encoding: 'utf8' });
    const unpacked = fs.readdirSync(DIST_DIR).filter((d) => /^linux(-arm64)?-unpacked$/.test(d));
    if (!unpacked.length) throw new Error('electron-builder output (linux-unpacked) not found in dist/');
    for (const d of unpacked) checkEnginePackaged(path.join(DIST_DIR, d, 'zcall-native'));
    logger.success('call engine files are all in the package');
    buildOutput += execSync(buildCommandst2, { stdio: 'pipe', cwd: path.join(BASE_DIR), encoding: 'utf8' });

    // Parse build output to find AppImage file
    const appImageMatch = buildOutput.match(/file=(dist\/.*\.AppImage)/);
    let appImageFile = null;
    let appImageName = null;

    if (appImageMatch) {
      appImageFile = appImageMatch[1];
      appImageName = path.basename(appImageFile);

      // Get file size
      if (fs.existsSync(path.join(BASE_DIR, appImageFile))) {
        const fullPath = path.join(BASE_DIR, appImageFile);
        const size = fs.statSync(fullPath).size;
        const sizeStr = size > 1024 * 1024
          ? `${Math.round(size / 1024 / 1024)}MB`
          : `${Math.round(size / 1024)}KB`;

        // Calculate SHA256 for logging
        let fileSha256 = 'unknown';
        try {
          const sha256Output = execSync(`sha256sum "${fullPath}"`, { encoding: 'utf8' });
          fileSha256 = sha256Output.split(' ')[0];
        } catch (error) {
          logger.warn('Could not calculate SHA256');
        }
        
        logger.success(`Built ${appImageName} (${sizeStr})`);
        logger.dim(`SHA256: ${fileSha256}`);
        
        builtFiles.push({
          type: outputSuffix === '-ZaDark' ? '🎨 ZaDark' : '📦 Original',
          name: appImageName,
          sizeStr
        });
      } else {
        logger.warn(`AppImage file not found: ${appImageFile}`);
      }
    } else {
      logger.warn('Could not find AppImage path in build output');
    }

    // Export build info to GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
      const prefix = outputSuffix === '-ZaDark' ? 'zadark_' : 'original_';

      // Export build-specific info
      const specificOutputs = [
        `${prefix}appimage_file=${appImageFile || ''}`,
        `${prefix}appimage_name=${appImageName || ''}`
      ];

      specificOutputs.forEach(output => {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, output + '\n');
      });

      logger.dim(`Exported ${prefix.replace('_', '')} build info to GitHub Actions`);
    }
  } catch (error) {
    logger.error('Build failed:', error.message);
    if (error.stdout) logger.dim('STDOUT:', error.stdout.toString());
    if (error.stderr) logger.dim('STDERR:', error.stderr.toString());
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };