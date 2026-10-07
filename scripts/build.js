const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const BASE_DIR = path.join(__dirname, '..');
const APP_DIR = path.join(BASE_DIR, 'app');
const DIST_DIR = path.join(BASE_DIR, 'dist');
const TEMP_DIR = path.join(BASE_DIR, 'temp');

let ZALO_VERSION = null;
const builtFiles = [];

// Check architecture
const isArm64 = process.arch === 'arm64' || process.arch === 'aarch64';

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

    // A leftover bundled runtime (e.g. from a crashed previous run) would
    // silently bloat the standard variants — start clean; Phase 3 re-bundles.
    fs.rmSync(path.join(APP_DIR, 'native', 'wine-runtime'), { recursive: true, force: true });

    // Phase 1: Build original Zalo
    logger.step('PHASE 1: Building Zalo (Original)');
    await build('(Original)', '');

    // Phase 1.5: Full variant of the original (no ZaDark) — wine bundled.
    logger.step('PHASE 2: Building Zalo (Full — wine bundled, no ZaDark)');
    await bundleWineRuntime();
    await build('(Full — wine bundled)', '-Full');
    // Remove the runtime again — the standard variants must not contain it,
    // and a leftover from a previous run would silently bloat them (and the
    // next Full build) to the Full size.
    fs.rmSync(path.join(APP_DIR, 'native', 'wine-runtime'), { recursive: true, force: true });

    // Phase 2: Apply ZaDark integration and build final product
    logger.step('PHASE 3: Building Zalo (with ZaDark)');

    // Patch ZaDark directly into APP_DIR
    await integrateZaDark();
    await build('(with ZaDark)', '-ZaDark');

    // Phase 3: Full variant of the ZaDark build — wine bundled, so the call
    // feature works out of the box with no first-run download.
    logger.step('PHASE 4: Building Zalo (Full — wine bundled, with ZaDark)');
    await bundleWineRuntime();
    await build('(Full — wine bundled)', '-ZaDark-Full');
    fs.rmSync(path.join(APP_DIR, 'native', 'wine-runtime'), { recursive: true, force: true });

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

// Keep in sync with WINE_DOWNLOAD_URL in plugins/zcall-bridge/index.js
const WINE_DOWNLOAD_URL = (isArm64) ?
  'https://github.com/DMKha241/hangover/releases/download/hangover-11.16/hangover_11.16_arm64.tar.xz' :
  'https://github.com/Kron4ek/Wine-Builds/releases/download/11.14/wine-11.14-amd64-wow64.tar.xz';

async function bundleWineRuntime() {

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const target = path.join(APP_DIR, 'native', 'wine-runtime');
  if (fs.existsSync(path.join(target, 'bin', 'wine'))) {
    logger.dim('wine runtime already bundled, skipping download');
    return;
  }
  const tarball = path.join(TEMP_DIR, 'wine-bundle.tar.xz');
  const cacheSource = tarball + '.source';
  const cached = fs.existsSync(tarball) && fs.existsSync(cacheSource) &&
    fs.readFileSync(cacheSource, 'utf8').trim() === WINE_DOWNLOAD_URL;
  try {
    if (!cached) {
      logger.info('Downloading portable wine for the Full variant...');
      try {
        execSync(`curl -L --fail -o "${tarball}" "${WINE_DOWNLOAD_URL}"`, {
          cwd: BASE_DIR, stdio: 'inherit'
        });
        fs.writeFileSync(cacheSource, WINE_DOWNLOAD_URL + '\n');
      } catch(err) {
        // remove partial downloads
        if (fs.existsSync(tarball)) {
          fs.unlinkSync(tarball);
        }
        throw new Error(`Download failed: ${err.message}`);
      }
    } else {
      logger.info('Using cached portable wine tarball from temp directory...');
    }
    fs.mkdirSync(target, { recursive: true });
    execSync(`tar -xf "${tarball}" -C "${target}" --strip-components=1`, {
      cwd: BASE_DIR, stdio: 'pipe'
    });
  } catch (error) {
    logger.error('Failed to bundle wine runtime:', error.message);
    throw error;
  }
  if (!fs.existsSync(path.join(target, 'bin', 'wine'))) {
    throw new Error('wine binary not found after extract');
  }
  logger.success('wine runtime bundled into app/native/wine-runtime');
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

    if (outputSuffix === '-ZaDark' || outputSuffix === '-Zadark-Full') {
      // Read ZaDark version for custom naming (the Full variant also builds
      // on the ZaDark-integrated app directory)
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

      const variantSuffix = outputSuffix === '-Zadark-Full' ? '-Full' : '';
      artifactName = `Zalo-${ZALO_VERSION}+ZaDark-${zadarkVersion}-${commitHash}${variantSuffix}${archSuffix}.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      buildCommandst2 = `chmod +x "${St2script}" && "${St2script}" "${ZALO_VERSION}" "${artifactName}" "${DIST_DIR}"`;
      logger.info(`Building ${buildName} with Zalo: ${ZALO_VERSION}, ZaDark: ${zadarkVersion}, Commit: ${commitHash}`);
    } else if (outputSuffix === '-Full') {
      artifactName = `Zalo-${ZALO_VERSION}-Original-${commitHash}-Full${archSuffix}.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      buildCommandst2 = `chmod +x "${St2script}" && "${St2script}" "${ZALO_VERSION}" "${artifactName}" "${DIST_DIR}"`;
      logger.info(`Building ${buildName} with Zalo: ${ZALO_VERSION}, Commit: ${commitHash}`);
    } else {
      artifactName = `Zalo-${ZALO_VERSION}-Original-${commitHash}${archSuffix}.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      buildCommandst2 = `chmod +x "${St2script}" && "${St2script}" "${ZALO_VERSION}" "${artifactName}" "${DIST_DIR}"`;
      logger.info(`Building ${buildName} with Zalo: ${ZALO_VERSION}, Commit: ${commitHash}`);
    }
    // Write build-info.json to the app directory so the AppImage will contain its metadata
    const buildInfo = {
      version: ZALO_VERSION,
      zadarkVersion: (outputSuffix === '-ZaDark' || outputSuffix === '-Zadark-Full') ? zadarkVersion : null,
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

    // Capture build output to get file information
    const combinedCommand = `${buildCommand} && ${buildCommandst2}`;

    const buildOutput = execSync(combinedCommand, {
      stdio: 'pipe',
      cwd: path.join(BASE_DIR),
      encoding: 'utf8'
    });

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
          type: outputSuffix === '-Zadark-Full' ? '🍷 Full (ZaDark)' : outputSuffix === '-Full' ? '🍷 Full' : outputSuffix === '-ZaDark' ? '🎨 ZaDark' : '📦 Original',
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
      const prefix = outputSuffix === '-Full' ? 'full_' : outputSuffix === '-Zadark-Full' ? 'zadark_full_' : outputSuffix === '-ZaDark' ? 'zadark_' : 'original_';

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
