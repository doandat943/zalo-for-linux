const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const ZADARK_DIR = path.join(__dirname, '..', 'plugins', 'zadark');

async function main() {
  try {
    // Check if we should skip - no ZADARK_VERSION means we should skip
    if (!process.env.ZADARK_VERSION) {
      logger.info('ZaDark preparation skipped (no ZADARK_VERSION provided)');
      return;
    }
    
    await ensureZaDarkSource();
    await checkoutToTargetVersion();
    await addRequiredExports();
    await buildZaDarkAssets();

    logger.success('ZaDark preparation completed successfully');

  } catch (error) {
    logger.error('ZaDark preparation failed:', error.message);
    process.exit(1);
  }
}

async function ensureZaDarkSource() {
  if (!fs.existsSync(ZADARK_DIR)) {
    logger.error('ZaDark submodule not found. Please run: git submodule update --init --recursive');
    throw new Error('ZaDark submodule not initialized');
  } else {
    logger.info('ZaDark submodule found');
  }
}

async function checkoutToTargetVersion() {
  const targetVersion = process.env.ZADARK_VERSION;
  
  if (targetVersion) {
    logger.info(`Checking out ZaDark version: ${targetVersion}`);
    try {
      // Fetch to ensure we have the target version
      execSync('git fetch --tags', {
        cwd: ZADARK_DIR,
        stdio: 'pipe'
      });

      // Check if it's a valid git reference
      execSync(`git rev-parse --verify "${targetVersion}"`, {
        cwd: ZADARK_DIR,
        stdio: 'pipe'
      });

      // Checkout the version
      execSync(`git checkout ${targetVersion}`, {
        cwd: ZADARK_DIR,
        stdio: 'pipe'
      });

      logger.success(`Checked out ZaDark version: ${targetVersion}`);
    } catch (error) {
      logger.warn(`Could not checkout ZaDark version ${targetVersion}, using current version`);
    }
  } else {
    logger.info('Using current ZaDark version');
  }
}

async function addRequiredExports() {
  logger.info('Checking ZaDark module exports...');
  const zadarkModulePath = path.join(ZADARK_DIR, 'src', 'pc', 'zadark-pc.js');

  if (!fs.existsSync(zadarkModulePath)) {
    logger.warn('ZaDark module not found at expected location');
    return;
  }

  const zadarkContent = fs.readFileSync(zadarkModulePath, 'utf8');
  const requiredExports = ['copyZaDarkAssets', 'writeIndexFile', 'writeBootstrapFile', 'writePopupViewerFile'];
  const exportSection = zadarkContent.match(/module\.exports\s*=\s*\{[\s\S]*?\}/);

  if (!exportSection) {
    logger.warn('Could not find module.exports section');
    return;
  }

  const hasAllExports = requiredExports.every(func => exportSection[0].includes(func));

  if (hasAllExports) {
    logger.success('ZaDark module exports are already available');
    return;
  }

  logger.info('Adding missing exports to ZaDark module...');

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
  logger.success('Added exports to ZaDark module');
}

async function buildZaDarkAssets() {
  const assetsDir = path.join(ZADARK_DIR, 'build', 'pc', 'assets');
  const shouldBuildAssets = !fs.existsSync(assetsDir);

  if (!shouldBuildAssets) {
    logger.success('ZaDark PC assets already built');
    return;
  }

  if (!shouldBuildAssets && !shouldRebuildModule) {
    logger.success('ZaDark PC assets already built');
    return;
  }

  logger.info('Building ZaDark PC assets...');

  try {
    // Install dependencies
    logger.dim('Installing dependencies...');
    execSync('npm install --silent', {
      cwd: ZADARK_DIR,
      stdio: 'pipe'
    });

    // Build PC version
    logger.dim('Running gulp build...');
    execSync('npx gulp build', {
      cwd: ZADARK_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'production' }
    });

    logger.success('ZaDark PC assets built successfully');
  } catch (error) {
    logger.error('Failed to build ZaDark');
    throw error;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };