const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const NATIVELIBS_DIR = path.join(__dirname, '..', '..', 'nativelibs');
const BUILDER_SCRIPT = path.join(NATIVELIBS_DIR, 'builder.js');
const DB_CROSS_V4_DIR = path.join(NATIVELIBS_DIR, 'db-cross-v4');

async function main() {
  logger.info('Building db-cross-v4 from source...');

  if (!fs.existsSync(path.join(DB_CROSS_V4_DIR, 'binding.gyp'))) {
    logger.warn('db-cross-v4 not found, skipping');
    return;
  }

  try {
    execSync(`node "${BUILDER_SCRIPT}" "${DB_CROSS_V4_DIR}"`, {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'pipe'
    });
  } catch (error) {
    logger.error('Failed to build db-cross-v4', error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    throw new Error(`Failed to build db-cross-v4`);
  }

  const releaseDir = path.join(DB_CROSS_V4_DIR, 'build', 'Release');
  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));

  const destDir = path.join(APP_DIR, 'native', 'nativelibs', 'db-cross-v4', 'prebuilt', 'linux', 'electron', 'x64');
  fs.ensureDirSync(destDir);

  for (const file of nodeFiles) {
    fs.copyFileSync(
      path.join(releaseDir, file),
      path.join(destDir, file)
    );
  }

  const bindingJsPath = path.join(APP_DIR, 'native', 'nativelibs', 'db-cross-v4', 'dist', 'binding.js');
  if (fs.existsSync(bindingJsPath)) {
    let content = fs.readFileSync(bindingJsPath, 'utf8');

    if (!content.includes("process.platform === 'linux'")) {
      content = content.replace(
        /else \{\s*if \(process\.arch === 'x64'\)/,
        `else if (process.platform === 'linux') {\n    addon = require('../prebuilt/linux/electron/x64/db-cross-v4-native.node');\n}\nelse {\n    if (process.arch === 'x64')`
      );
      fs.writeFileSync(bindingJsPath, content, 'utf8');
      logger.dim('Patched binding.js for Linux support');
    }
  }

  const mainJsPath = path.join(APP_DIR, 'main-dist', 'main.js');
  if (fs.existsSync(mainJsPath)) {
    let content = fs.readFileSync(mainJsPath, 'utf8');

    // PLATFORM ID PATCH
    // ---------------------------------------------------------------
    // Switching the platform ID from 25 to another ID is required to
    // make the patch's features work. The only observed difference
    // is how Zalo's tray icon behaves:
    //
    //   25 → 23 (macOS)   ← currently used
    //       Zalo's tray icon does not appear, so only our own icon
    //       is shown.
    //
    //   25 → 24 (Windows)
    //       Zalo's tray icon also appears alongside ours, but the
    //       actual Zalo logo is missing — it shows a default/blank
    //       icon. Result: two tray icons, with the Zalo one looking
    //       wrong.
    // ---------------------------------------------------------------
    if (content.includes('case"LINUX":return 25;')) {
      content = content.replace(/case"LINUX":return 25;/g, 'case"LINUX":return 23;');
      fs.writeFileSync(mainJsPath, content, 'utf8');
      logger.dim('Patched platform ID (25 -> 23, macOS)');
    }
  }

  logger.success('db-cross-v4 built and installed');
}

if (require.main === module) {
  main();
}

module.exports = { main };