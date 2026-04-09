const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const APP_DIR = path.join(__dirname, '..', 'app');
const TEMP_DIR = path.join(__dirname, '..', 'temp');

async function main() {
  console.log('🔧 Starting Zalo DMG extraction process...');
  console.log('📂 Work directory:', TEMP_DIR);

  // Create directories
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // Clean up any existing extracted DMG folders
  console.log('🧹 Cleaning up any existing extracted folders...');
  try {
    const zaloFolders = execSync(`find "${TEMP_DIR}" -name "Zalo*" -type d 2>/dev/null || true`, {
      cwd: TEMP_DIR,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim().split('\n').filter(Boolean);

    zaloFolders.forEach(folder => {
      if (fs.existsSync(folder)) {
        fs.rmSync(folder, { recursive: true, force: true });
        console.log(`🗑️  Removed: ${folder}`);
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
    // Find any DMG file in temp directory
    console.log('🔍 Looking for DMG files in:', TEMP_DIR);

    if (!fs.existsSync(TEMP_DIR)) {
      throw new Error('Temp directory not found. Please run "npm run download-dmg" first.');
    }

    const files = fs.readdirSync(TEMP_DIR);
    const dmgFiles = files.filter(file => file.toLowerCase().endsWith('.dmg'));

    if (dmgFiles.length === 0) {
      console.error('❌ No DMG files found in:', TEMP_DIR);
      console.error('💡 Please run "npm run download-dmg" first to download the DMG file.');
      throw new Error('No DMG files found. Download one first.');
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

    // Sort by version (highest first), versioned files before non-versioned
    const sortedFiles = allFiles.sort((a, b) => {
      if (a.version && b.version) {
        return compareVersions(b.version, a.version);
      } else if (a.version && !b.version) {
        return -1; // Versioned files first
      } else if (!a.version && b.version) {
        return 1;
      } else {
        return 0; // Keep original order for files without versions
      }
    });

    // Auto-select based on conditions
    let selectedFile;
    if (sortedFiles.length === 1) {
      selectedFile = sortedFiles[0];
      console.log(`\n🎯 Only one file found, auto-selecting: ${selectedFile.name}`);
    } else if (process.env.ZALO_VERSION) {
      // Auto-select matching version when ZALO_VERSION is specified
      const requestedVersion = process.env.ZALO_VERSION.trim();
      const matchingFile = sortedFiles.find(file =>
        file.version && file.version.raw === requestedVersion
      );

      if (matchingFile) {
        selectedFile = matchingFile;
        console.log(`\n🎯 Auto-selecting version ${requestedVersion}: ${selectedFile.name}`);
      } else {
        console.log(`\n⚠️  Requested version ${requestedVersion} not found in downloaded files.`);
        console.log('📋 Available versions:', sortedFiles.map(f => f.versionStr).join(', '));
        console.log('🔄 Falling back to interactive selection...\n');
        selectedFile = await showInteractiveMenu(sortedFiles);
      }
    } else {
      selectedFile = await showInteractiveMenu(sortedFiles);
    }

    const dmgPath = selectedFile.path;
    const dmgFilename = selectedFile.name;
    const selectedVersion = selectedFile.versionStr;

    console.log('\n📄 DMG filename:', dmgFilename);
    console.log('📦 Version:', selectedVersion);
    console.log('💾 DMG file path:', dmgPath);
    console.log('📊 DMG file size:', selectedFile.size, 'MB');

    // Check for 7z
    console.log('🐧 Checking for required tools...');
    if (!commandExists('7z')) {
      console.error('❌ Dependency missing: 7z is not installed.');
      console.error('Please install it using: sudo apt-get install p7zip-full');
      throw new Error('7z is required for DMG extraction.');
    }
    console.log('✅ 7z is available.');

    // Extract app.asar and app.asar.unpacked directly using the optimized command
    console.log('🔧 Extracting app.asar and app.asar.unpacked from DMG...');
    const extractCommand = `7z x "${dmgPath}" "Zalo*/Zalo.app/Contents/Resources/app.asar*"`;

    try {
      execSync(extractCommand, {
        cwd: TEMP_DIR,
        stdio: 'pipe' // Suppress output to avoid seeing the "Headers Error" 
      });
    } catch (error) {
      // 7z might report "Headers Error" but still extract successfully
      // Check if app.asar was extracted anyway
      console.log('⚠️  7z reported warnings/errors (this is normal for DMG files)');
    }

    console.log('🎉 Extraction completed successfully!');
    console.log(`💾 DMG file preserved at: ${selectedFile.path}`);
    console.log(`📁 Temp directory preserved at: ${TEMP_DIR}`);
  } catch (error) {
    console.error('💥 Extraction failed:', error.message);
    process.exit(1);
  }
}

async function extractAppAsar() {
  // Find Resources directory (contains both app.asar and app.asar.unpacked)
  console.log('🔍 Looking for Zalo Resources directory...');
  const findResourcesCommand = `find "${TEMP_DIR}" -path "*/Zalo.app/Contents/Resources" -type d`;
  let resourcesPaths;

  try {
    const result = execSync(findResourcesCommand, {
      cwd: TEMP_DIR,
      encoding: 'utf8',
      stdio: 'pipe'
    });
    resourcesPaths = result.trim().split('\n').filter(Boolean);
  } catch (error) {
    resourcesPaths = [];
  }
  const resourcesPath = resourcesPaths[0];

  console.log('🎯 Found Resources at:', resourcesPath);

  // Extract app.asar to final location (asar module will automatically handle unpacked files)
  console.log('📂 Extracting app.asar to app directory...');
  const asarModule = require('@electron/asar');

  // Set the working directory to Resources so that unpacked files are resolved correctly
  const originalCwd = process.cwd();
  try {
    process.chdir(resourcesPath);
    await asarModule.extractAll('app.asar', APP_DIR);
  } finally {
    process.chdir(originalCwd);
  }

  console.log('✅ App extracted to:', APP_DIR);

  // Rename package.json to package.json.bak to prevent electron-builder conflicts
  const packageJsonPath = path.join(APP_DIR, 'package.json');
  const packageJsonBakPath = path.join(APP_DIR, 'package.json.bak');

  fs.renameSync(packageJsonPath, packageJsonBakPath);

  // Patch main.js to enable title bar (T,frame:!1 -> T,frame:!0)
  try {
    const mainJsPath = path.join(APP_DIR, 'main-dist', 'main.js');
    if (fs.existsSync(mainJsPath)) {
      let mainContent = fs.readFileSync(mainJsPath, 'utf8');

      if (mainContent.includes('T,frame:!1')) {
        mainContent = mainContent.replace(/T,frame:!1/g, 'T,frame:!0');
        fs.writeFileSync(mainJsPath, mainContent, 'utf8');
        console.log('✅ Patched T,frame:!1 -> T,frame:!0 (title bar enabled)');
      } else {
        console.log('⚠️  Pattern T,frame:!1 not found in main.js, skipping patch');
      }
    } else {
      console.log('⚠️  main.js not present, skipping patch');
    }
  } catch (e) {
    console.error('❌ Failed to patch main.js:', e && e.message);
  }

  // Patch sqlite3: The original DMG only ships macOS (Mach-O) binaries for sqlite3.
  // On Linux, loading these causes "invalid ELF header" errors, which freezes the login screen (>= 25.12.11).
  // We replace them with a real Linux binary from the project's sqlite3 devDependency.
  try {
    const sqliteTargetDir = path.join(APP_DIR, 'native', 'nativelibs', 'sqlite3', 'binding', 'napi-v6-linux-x64');
    fs.mkdirSync(sqliteTargetDir, { recursive: true });

    const targetNodePath = path.join(sqliteTargetDir, 'node_sqlite3.node');
    const sourceNodePath = path.join(__dirname, '..', 'node_modules', 'sqlite3', 'build', 'Release', 'node_sqlite3.node');

    if (fs.existsSync(sourceNodePath)) {
      fs.copyFileSync(sourceNodePath, targetNodePath);
      console.log('✅ SQLite3 Linux binary installed successfully!');
    } else {
      console.log('⚠️  SQLite3 binary not found in node_modules. Run "npm install" first.');
    }
  } catch (e) {
    console.error('❌ Failed to patch sqlite3:', e && e.message);
  }

  // Copy icon for better Linux integration
  try {
    const iconSourcePath = path.join(APP_DIR, 'pc-dist', 'favicon-512x512.png');
    const rootAssetsDir = path.join(__dirname, '..', 'assets', 'icons');
    if (!fs.existsSync(rootAssetsDir)) {
      fs.mkdirSync(rootAssetsDir, { recursive: true });
    }
    const iconTargetPath = path.join(rootAssetsDir, 'zalo.png');
    if (fs.existsSync(iconSourcePath)) {
      fs.copyFileSync(iconSourcePath, iconTargetPath);
      console.log('✅ Icon copied to assets/icons/zalo.png');
    }
  } catch (e) {
    console.error('❌ Failed to copy icon:', e && e.message);
  }
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
  // Extract version from filename like "ZaloSetup-universal-25.8.2.dmg"
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
  // Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
  if (v1.major !== v2.major) return v1.major - v2.major;
  if (v1.minor !== v2.minor) return v1.minor - v2.minor;
  return v1.patch - v2.patch;
}

async function showInteractiveMenu(files) {
  return new Promise((resolve, reject) => {
    let selectedIndex = 0; // Start with first (highest version) selected
    const maxIndex = files.length - 1;

    // Setup terminal for raw mode
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function renderMenu() {
      // Clear screen and move cursor to top
      process.stdout.write('\x1B[2J\x1B[0f');

      console.log('📋 Available DMG files:');
      console.log('   Use ↑↓ arrow keys to navigate, Enter to select, Esc to cancel\n');

      files.forEach((file, index) => {
        const isSelected = index === selectedIndex;
        const bullet = isSelected ? '●' : '○';
        const versionInfo = file.version ? `v${file.versionStr}` : 'no version';
        const sizeInfo = `${file.size}MB`;
        const timeInfo = file.mtime.toLocaleString();

        // Highlight selected item
        const color = isSelected ? '\x1b[36m' : '\x1b[37m'; // Cyan for selected, white for others
        const reset = '\x1b[0m';

        console.log(`${color}  ${bullet} ${file.name}${reset}`);
        console.log(`${color}    Version: ${versionInfo} | Size: ${sizeInfo} | Date: ${timeInfo}${reset}\n`);
      });

      const selectedFile = files[selectedIndex];
      console.log(`\n🎯 Selected: ${selectedFile.name} (v${selectedFile.versionStr})`);
    }

    function cleanup() {
      // Restore terminal
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
    }

    function handleKeypress(key) {
      switch (key) {
        case '\u001b[A': // Up arrow
          selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : maxIndex;
          renderMenu();
          break;

        case '\u001b[B': // Down arrow
          selectedIndex = selectedIndex < maxIndex ? selectedIndex + 1 : 0;
          renderMenu();
          break;

        case '\r': // Enter
        case '\n':
          cleanup();
          resolve(files[selectedIndex]);
          break;

        case '\u001b': // Escape
        case '\u0003': // Ctrl+C
          cleanup();
          console.log('\n❌ Selection cancelled');
          reject(new Error('User cancelled selection'));
          break;

        default:
          // Ignore other keys
          break;
      }
    }

    // Initial render
    renderMenu();

    // Listen for keypress
    process.stdin.on('data', handleKeypress);

    // Handle process interruption
    process.on('SIGINT', () => {
      cleanup();
      console.log('\n❌ Process interrupted');
      process.exit(1);
    });
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
