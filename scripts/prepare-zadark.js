const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ZADARK_DIR = path.join(__dirname, '..', 'plugins', 'zadark');

async function main() {
  console.log('🎨 Preparing ZaDark...');

  try {
    // Check if we should skip - no ZADARK_VERSION means we should skip
    if (!process.env.ZADARK_VERSION) {
      console.log('ℹ️  ZaDark preparation skipped (no ZADARK_VERSION provided)');
      return;
    }
    
    await ensureZaDarkSource();
    await checkoutToTargetVersion();
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

async function checkoutToTargetVersion() {
  const targetVersion = process.env.ZADARK_VERSION;
  
  if (targetVersion) {
    console.log(`🎯 Checking out ZaDark version: ${targetVersion}`);
    try {
      // Fetch to ensure we have the target version
      execSync('git fetch --tags', {
        cwd: ZADARK_DIR,
        stdio: 'inherit'
      });

      // Check if it's a valid git reference
      execSync(`git rev-parse --verify "${targetVersion}"`, {
        cwd: ZADARK_DIR,
        stdio: 'pipe'
      });

      // Checkout the version
      execSync(`git checkout ${targetVersion}`, {
        cwd: ZADARK_DIR,
        stdio: 'inherit'
      });

      console.log(`✅ Checked out ZaDark version: ${targetVersion}`);
    } catch (error) {
      console.warn(`⚠️  Could not checkout ZaDark version ${targetVersion}, using current version`);
      console.warn(`Error: ${error.message}`);
    }
  } else {
    console.log('🔄 Using current ZaDark version (determined by check-versions)');
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
    execSync('npx gulp build', {
      cwd: ZADARK_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'production' }
    });

    console.log('✅ ZaDark PC assets built successfully');
  } catch (error) {
    console.error('❌ Failed to build ZaDark:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };