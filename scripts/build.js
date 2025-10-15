const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(__dirname, '..');
const APP_DIR = path.join(BASE_DIR, 'app');

let ZALO_VERSION = null;

async function main() {
  console.log('🚀 Building Zalo for Linux...');

  try {
    // Read version from package.json.bak
    const packageJsonBakPath = path.join(APP_DIR, 'package.json.bak');
    if (fs.existsSync(packageJsonBakPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonBakPath, 'utf8'));
      ZALO_VERSION = packageJson.version;
      console.log('📝 Read Zalo version from package.json.bak:', ZALO_VERSION);

      // Export global outputs for workflow
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `zalo_version=${ZALO_VERSION}\n`);
      }
    } else {
      console.warn('⚠️  package.json.bak not found, version will be unknown');
    }

    // Phase 1: Build original Zalo
    console.log('\n🔥 PHASE 1: Building Zalo (Original)...\n');

    await build('(Original)', '');

    // Phase 2: Apply ZaDark integration and build final product
    console.log('\n🔥 PHASE 2: Building Zalo (with ZaDark)...\n');

    // Patch ZaDark directly into APP_DIR
    await integrateZaDark();
    await build('(with ZaDark)', '-ZaDark');

    // Final summary
    console.log('\n🎉 ===== BUILD SUMMARY =====');
    const distDir = path.join(BASE_DIR, 'dist');

    if (fs.existsSync(distDir)) {
      const allFiles = fs.readdirSync(distDir)
        .filter(f => f.endsWith('.AppImage'))
        .sort()
        .map(f => {
          const filePath = path.join(distDir, f);
          const size = fs.statSync(filePath).size;
          const sizeStr = size > 1024 * 1024
            ? `${Math.round(size / 1024 / 1024)}MB`
            : `${Math.round(size / 1024)}KB`;

          const type = f.includes('+ZaDark-') ? '🎨 ZaDark' : '📦 Original';
          return `  ${type} • ${f} (${sizeStr})`;
        })
        .join('\n') || '  (no AppImage files)';
      console.log('\n📁 All built files in dist/:');
      console.log(allFiles);
    }

  } catch (error) {
    console.error('💥 Main workflow failed:', error.message);
    process.exit(1);
  }
}

async function integrateZaDark() {
  // ZaDark Integration (always applied in this project)
  console.log('🎨 Applying ZaDark patches...');

  try {
    // Verify ZaDark module is available
    const zadarkModulePath = path.join(BASE_DIR, 'plugins', 'zadark', 'build', 'pc', 'zadark-pc.js');
    if (!fs.existsSync(zadarkModulePath)) {
      throw new Error('ZaDark PC module not found - run "npm run prepare-zadark" first');
    }

    // Import ZaDark PC module
    console.log('🎯 Applying ZaDark patches to app directory...');

    const zadarkPC = require(zadarkModulePath);
    zadarkPC.copyZaDarkAssets(BASE_DIR);
    zadarkPC.writeIndexFile(BASE_DIR);
    zadarkPC.writeBootstrapFile(BASE_DIR);
    zadarkPC.writePopupViewerFile(BASE_DIR);
    console.log('✅ ZaDark patches applied successfully');

  } catch (error) {
    console.error('❌ ZaDark integration failed:', error.message);
    console.log('💡 Continuing with original app directory...');
  }
}

async function build(buildName = '', outputSuffix = '') {
  try {
    // Get git commit hash for filename
    const commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();

    // Set artifact name and build command based on build type
    let artifactName;
    let buildCommand;

    if (outputSuffix === '-ZaDark') {
      // Read ZaDark version for custom naming
      const zadarkPackagePath = path.join(BASE_DIR, 'plugins', 'zadark', 'package.json');
      let zadarkVersion = 'unknown';

      if (fs.existsSync(zadarkPackagePath)) {
        try {
          const zadarkPackage = JSON.parse(fs.readFileSync(zadarkPackagePath, 'utf8'));
          zadarkVersion = zadarkPackage.version;
        } catch (error) {
          console.warn('⚠️ Could not read ZaDark version, using "unknown"');
        }
      }

      artifactName = `Zalo-${ZALO_VERSION}+ZaDark-${zadarkVersion}-${commitHash}.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      console.log(`🔨 Building${buildName ? ` ${buildName}` : ''} with Zalo: ${ZALO_VERSION}, ZaDark: ${zadarkVersion}, Commit: ${commitHash}`);
    } else {
      artifactName = `Zalo-${ZALO_VERSION}-${commitHash}.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      console.log(`🔨 Building${buildName ? ` ${buildName}` : ''} with Zalo: ${ZALO_VERSION}, Commit: ${commitHash}`);
    }
    console.log(`📝 Command: ${buildCommand}`);

    // Capture build output to get file information
    const buildOutput = execSync(buildCommand, {
      stdio: 'pipe',
      cwd: path.join(BASE_DIR),
      encoding: 'utf8'
    });

    console.log(`✅ Completed!`);

    // Debug: Show build output
    console.log('\n🔍 Build Output:');
    console.log(buildOutput);

    // Parse build output to find AppImage file
    const appImageMatch = buildOutput.match(/file=(dist\/.*\.AppImage)/);
    let appImageFile = null;
    let appImageName = null;

    if (appImageMatch) {
      appImageFile = appImageMatch[1];
      appImageName = path.basename(appImageFile);

      console.log(`📦 AppImage: ${appImageFile}`);

      // Get file size
      if (fs.existsSync(appImageFile)) {
        const fileSize = fs.statSync(appImageFile).size;

        console.log(`📏 Size: ${fileSize} bytes`);

        // Calculate SHA256 for logging
        try {
          const sha256Output = execSync(`sha256sum "${appImageFile}"`, { encoding: 'utf8' });
          const fileSha256 = sha256Output.split(' ')[0];
          console.log(`🔐 SHA256: ${fileSha256}`);
        } catch (error) {
          console.warn('⚠️ Could not calculate SHA256');
        }
      } else {
        console.warn(`⚠️ AppImage file not found: ${appImageFile}`);
      }
    } else {
      console.warn('⚠️ Could not find AppImage in build output');
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

      console.log(`\n📋 Exported ${prefix.replace('_', '')} build info to GitHub Actions`);
    }
  } catch (error) {
    console.error('💥 Build failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };