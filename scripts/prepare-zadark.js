#!/usr/bin/env node

/**
 * Prepare ZaDark - Clone and build ZaDark assets
 * This script prepares ZaDark for later integration during build
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ZADARK_DIR = path.join(__dirname, '..', 'plugins', 'zadark');

// Get ZaDark version from environment variable
const ZADARK_VERSION = process.env.ZADARK_VERSION;

console.log('🎨 Preparing ZaDark...');

async function prepareZaDark() {
  try {
    await ensureZaDarkSource();
    await updateSource();
    if (process.env.CI === 'true' && ZADARK_VERSION) await checkoutZaDarkVersion();
    await addRequiredExports();
    await buildZaDarkAssets();

    console.log('🎉 ZaDark preparation completed successfully!');
    console.log(`📁 ZaDark ready at: ${ZADARK_DIR}`);

  } catch (error) {
    console.error('💥 ZaDark preparation failed:', error.message);
    process.exit(1);
  }
}

async function ensureZaDarkSource() {
  if (!fs.existsSync(ZADARK_DIR)) {
    console.log('❌ ZaDark submodule not found!');
    console.log('💡 Please run: git submodule update --init --recursive');
    throw new Error('ZaDark submodule not initialized. Run "git submodule update --init --recursive"');
  } else {
    console.log('📁 ZaDark submodule found');
  }
}

async function updateSource() {
  console.log('🔄 Updating ZaDark submodule to latest tag...');
  try {
    // Fetch latest tags
    execSync('git fetch --tags', {
      cwd: ZADARK_DIR,
      stdio: 'inherit'
    });
    
    // Get latest tag
    const latestTag = execSync('git tag --sort=-version:refname | head -1', {
      cwd: ZADARK_DIR,
      encoding: 'utf8'
    }).trim();
    
    if (latestTag) {
      // Checkout latest tag
      execSync(`git checkout ${latestTag}`, {
        cwd: ZADARK_DIR,
        stdio: 'inherit'
      });
      console.log(`✅ ZaDark submodule updated to latest tag: ${latestTag}`);
    } else {
      console.warn('⚠️ No tags found, using current version');
    }
  } catch (error) {
    console.warn('⚠️ Could not update ZaDark submodule to latest tag, using current version');
    console.warn(`Error: ${error.message}`);
  }
}

async function checkoutZaDarkVersion() {
  console.log(`🎯 CI mode: Checking out ZaDark version: ${ZADARK_VERSION}`);

  try {
    // Check if it's a valid git reference
    execSync(`git rev-parse --verify "${ZADARK_VERSION}"`, {
      cwd: ZADARK_DIR,
      stdio: 'pipe'
    });

    // Checkout the version
    execSync(`git checkout ${ZADARK_VERSION}`, {
      cwd: ZADARK_DIR,
      stdio: 'inherit'
    });

    console.log(`✅ Checked out ZaDark version: ${ZADARK_VERSION}`);
  } catch (error) {
    console.warn(`⚠️  Could not checkout ZaDark version ${ZADARK_VERSION}, using current version`);
    console.warn(`Error: ${error.message}`);
  }
}

async function buildZaDarkAssets() {
  const assetsDir = path.join(ZADARK_DIR, 'build', 'pc', 'assets');
  const shouldBuildAssets = !fs.existsSync(assetsDir);

  if (!shouldBuildAssets) {
    console.log('✅ ZaDark PC assets already built and up to date');
    return;
  }

  console.log('🔨 Building ZaDark PC assets...');

  try {
    // Install dependencies
    console.log('📦 Installing ZaDark dependencies...');
    execSync('npm install --silent', {
      cwd: ZADARK_DIR,
      stdio: 'pipe'
    });

    // Build PC version
    console.log('⚙️  Building PC assets...');
    execSync('npm run build', {
      cwd: ZADARK_DIR,
      stdio: 'pipe'
    });

    console.log('✅ ZaDark PC assets built successfully');
  } catch (error) {
    console.error('❌ Failed to build ZaDark:', error.message);
    process.exit(1);
  }
}

async function addRequiredExports() {
  console.log('📝 Adding required exports to ZaDark module...');
  const zadarkModulePath = path.join(ZADARK_DIR, 'src', 'pc', 'zadark-pc.js');

  if (!fs.existsSync(zadarkModulePath)) {
    console.warn('⚠️  ZaDark module not found at expected location');
    return;
  }

  const zadarkContent = fs.readFileSync(zadarkModulePath, 'utf8');
  const requiredExports = ['copyZaDarkAssets', 'writeIndexFile', 'writeBootstrapFile', 'writePopupViewerFile'];
  const exportSection = zadarkContent.match(/module\.exports\s*=\s*\{[\s\S]*?\}/);

  if (!exportSection) {
    console.warn('⚠️  Could not find module.exports section');
    return;
  }

  const hasAllExports = requiredExports.every(func => exportSection[0].includes(func));

  if (hasAllExports) {
    console.log('✅ ZaDark module exports are already available');
    return;
  }

  console.log('🔧 Adding missing exports to ZaDark module...');

  const originalExports = exportSection[0];
  const updatedExports = originalExports.replace(
    /,\s*uninstallZaDark\s*\}/,
    `,
  uninstallZaDark,

  // Additional exports for build integration
  copyZaDarkAssets,
  writeIndexFile,
  writeBootstrapFile,
  writePopupViewerFile
}`
  );

  const updatedContent = zadarkContent.replace(exportSection[0], updatedExports);
  fs.writeFileSync(zadarkModulePath, updatedContent);
  console.log('✅ Added exports to ZaDark module');
}

// Run preparation
prepareZaDark();
