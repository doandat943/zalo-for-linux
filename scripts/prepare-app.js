const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');

const APP_DIR = path.join(__dirname, '..', 'app');
const TEMP_DIR = path.join(__dirname, '..', 'temp');

async function main() {
  // Create directories
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // Clean up any existing extracted DMG folders
  try {
    const zaloFolders = execSync(`find "${TEMP_DIR}" -name "Zalo*" -type d 2>/dev/null || true`, {
      cwd: TEMP_DIR,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim().split('\n').filter(Boolean);

    zaloFolders.forEach(folder => {
      if (fs.existsSync(folder)) {
        fs.rmSync(folder, { recursive: true, force: true });
        logger.dim(`Cleaned up folder: ${folder}`);
      }
    });
  } catch (error) { }

  if (fs.existsSync(APP_DIR)) {
    fs.rmSync(APP_DIR, { recursive: true, force: true });
  }

  await extractDMG();
  await extractAppAsar();
}

async function extractDMG() {
  try {
    if (!fs.existsSync(TEMP_DIR)) {
      throw new Error('Temp directory not found. Please run "npm run download-dmg" first.');
    }

    const files = fs.readdirSync(TEMP_DIR);
    const dmgFiles = files.filter(file => file.toLowerCase().endsWith('.dmg'));

    if (dmgFiles.length === 0) {
      logger.error('No DMG files found in:', TEMP_DIR);
      logger.info('Please run "npm run download-dmg" first to download the DMG file.');
      throw new Error('No DMG files found');
    }

    // Prepare file list with versions and metadata
    const allFiles = dmgFiles.map(file => {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      const version = parseVersion(file);

      return {
        name: file,
        path: filePath,
        version: version,
        versionStr: version ? version.raw : 'unknown',
        size: (stats.size / 1024 / 1024).toFixed(2),
        mtime: stats.mtime
      };
    });

    // Sort by version (highest first)
    const sortedFiles = allFiles.sort((a, b) => {
      if (a.version && b.version) return compareVersions(b.version, a.version);
      if (a.version && !b.version) return -1;
      if (!a.version && b.version) return 1;
      return 0;
    });

    let selectedFile;
    if (sortedFiles.length === 1) {
      selectedFile = sortedFiles[0];
      logger.info(`Auto-selecting DMG: ${selectedFile.name}`);
    } else if (process.env.ZALO_VERSION) {
      const requestedVersion = process.env.ZALO_VERSION.trim();
      const matchingFile = sortedFiles.find(file => file.version && file.version.raw === requestedVersion);

      if (matchingFile) {
        selectedFile = matchingFile;
        logger.info(`Auto-selecting version ${requestedVersion}: ${selectedFile.name}`);
      } else {
        logger.warn(`Requested version ${requestedVersion} not found in downloaded files.`);
        selectedFile = await showInteractiveMenu(sortedFiles);
      }
    } else {
      selectedFile = await showInteractiveMenu(sortedFiles);
    }

    const dmgPath = selectedFile.path;

    if (!commandExists('7z')) {
      logger.error('Dependency missing: 7z is not installed. Run: sudo apt-get install p7zip-full');
      throw new Error('7z is required for DMG extraction.');
    }

    logger.info(`Extracting app.asar from ${selectedFile.name}...`);
    const extractCommand = `7z x "${dmgPath}" "Zalo*/Zalo.app/Contents/Resources/app.asar*"`;

    try {
      execSync(extractCommand, { cwd: TEMP_DIR, stdio: 'pipe' });
    } catch (error) {
      // 7z might report "Headers Error" but still extract successfully
      logger.dim('Note: 7z reported warnings/errors (normal for DMG files)');
    }

    logger.success('Extraction completed successfully');
  } catch (error) {
    logger.error('Extraction failed:', error.message);
    process.exit(1);
  }
}

async function extractAppAsar() {
  const findResourcesCommand = `find "${TEMP_DIR}" -path "*/Zalo.app/Contents/Resources" -type d`;
  let resourcesPaths;

  try {
    const result = execSync(findResourcesCommand, { cwd: TEMP_DIR, encoding: 'utf8', stdio: 'pipe' });
    resourcesPaths = result.trim().split('\n').filter(Boolean);
  } catch (error) {
    resourcesPaths = [];
  }
  const resourcesPath = resourcesPaths[0];

  logger.info(`Extracting app.asar to app directory...`);
  const asarModule = require('@electron/asar');

  const originalCwd = process.cwd();
  try {
    process.chdir(resourcesPath);
    await asarModule.extractAll('app.asar', APP_DIR);
  } finally {
    process.chdir(originalCwd);
  }

  logger.success('App directory extracted');

  // Rename package.json to package.json.bak
  const packageJsonPath = path.join(APP_DIR, 'package.json');
  const packageJsonBakPath = path.join(APP_DIR, 'package.json.bak');
  fs.renameSync(packageJsonPath, packageJsonBakPath);

  // Apply patches
  logger.info('Applying platform patches...');
  
  const { main: patchTitlebar } = require('./patches/patch-titlebar');
  await patchTitlebar();

  const { main: patchPastingImg } = require('./patches/patch-pasting-img');
  await patchPastingImg();

  const { main: patchSqlite3 } = require('./patches/patch-sqlite3');
  await patchSqlite3();

  const { main: patchDbCrossV4 } = require('./patches/patch-db-cross-v4');
  await patchDbCrossV4();

  const { main: patchFixImageResizeLinux } = require('./patches/patch-fix-image-resize-linux');
  await patchFixImageResizeLinux();

  const { main: patchFixImageResizeCanvas } = require('./patches/patch-fix-image-resize-canvas');
  await patchFixImageResizeCanvas();
}

function commandExists(command) {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function parseVersion(filename) {
  const versionMatch = filename.match(/(\d+)\.(\d+)\.(\d+)/);
  if (versionMatch) {
    return {
      major: parseInt(versionMatch[1]),
      minor: parseInt(versionMatch[2]),
      patch: parseInt(versionMatch[3]),
      raw: `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}`
    };
  }
  return null;
}

function compareVersions(v1, v2) {
  if (v1.major !== v2.major) return v1.major - v2.major;
  if (v1.minor !== v2.minor) return v1.minor - v2.minor;
  return v1.patch - v2.patch;
}

async function showInteractiveMenu(files) {
  // Omitted complex menu code for brevity in this tool - using existing logic without changes
  return new Promise((resolve, reject) => {
    let selectedIndex = 0;
    const maxIndex = files.length - 1;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function renderMenu() {
      process.stdout.write('\x1B[2J\x1B[0f');
      console.log('📋 Available DMG files:');
      console.log('   Use ↑↓ arrow keys to navigate, Enter to select, Esc to cancel\n');
      files.forEach((file, index) => {
        const isSelected = index === selectedIndex;
        const color = isSelected ? '\x1b[36m' : '\x1b[37m';
        console.log(`${color}  ${isSelected ? '●' : '○'} ${file.name}\x1b[0m`);
      });
    }

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
    }

    function handleKeypress(key) {
      if (key === '\u001b[A') selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : maxIndex;
      else if (key === '\u001b[B') selectedIndex = selectedIndex < maxIndex ? selectedIndex + 1 : 0;
      else if (key === '\r' || key === '\n') { cleanup(); resolve(files[selectedIndex]); }
      else if (key === '\u001b' || key === '\u0003') { cleanup(); reject(new Error('Cancelled')); }
      renderMenu();
    }
    renderMenu();
    process.stdin.on('data', handleKeypress);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
