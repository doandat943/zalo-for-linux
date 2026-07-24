const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const NATIVELIBS_DIR = path.join(__dirname, '..', '..', 'nativelibs');
const BUILDER_SCRIPT = path.join(NATIVELIBS_DIR, 'builder-rust.js');
const ZIMAGE_DIR = path.join(NATIVELIBS_DIR, 'zimage');

async function main() {
  logger.info('Building zimage from source...');

  if (!fs.existsSync(path.join(ZIMAGE_DIR, 'Cargo.toml'))) {
    logger.warn('zimage not found, skipping');
    return;
  }

  try {
    execSync(`node "${BUILDER_SCRIPT}" "${ZIMAGE_DIR}"`, {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'pipe'
    });
  } catch (error) {
    logger.error('Failed to build zimage', error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    throw new Error(`Failed to build zimage`);
  }

  const releaseDir = path.join(ZIMAGE_DIR, 'target', 'release');
  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));

  const destDir = path.join(APP_DIR, 'native', 'nativelibs', 'zimage', 'linux_x64');
  fs.ensureDirSync(destDir);

  for (const file of nodeFiles) {
    fs.copyFileSync(
      path.join(releaseDir, file),
      path.join(destDir, file)
    );
  }

  const indexJsPath = path.join(APP_DIR, 'native', 'nativelibs', 'zimage', 'index.js');
  if (fs.existsSync(indexJsPath)) {
    let content = fs.readFileSync(indexJsPath, 'utf8');

    if (!content.includes("process.platform === 'linux'")) {
      content = content.replace(
        `\t\t} else {\n\t\t\tos = 'darwin_x64';\n\t\t}\n\t}\n}`,
        `\t\t} else {\n\t\t\tos = 'darwin_x64';\n\t\t}\n\t} else if (process.platform === 'linux') {\n\t\tos = 'linux_x64';\n\t}\n}`
      );
      fs.writeFileSync(indexJsPath, content, 'utf8');
      logger.dim('Patched index.js for Linux support');
    }
  }

  logger.success('zimage built and installed');
}

if (require.main === module) {
  main();
}

module.exports = { main };