const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const NATIVELIBS_DIR = path.join(__dirname, '..', '..', 'nativelibs');
const BUILDER_SCRIPT = path.join(NATIVELIBS_DIR, 'builder-rust.js');
const FILE_UTILS_DIR = path.join(NATIVELIBS_DIR, 'file-utils');

async function main() {
  logger.info('Building file-utils from source...');

  if (!fs.existsSync(path.join(FILE_UTILS_DIR, 'Cargo.toml'))) {
    logger.warn('file-utils not found, skipping');
    return;
  }

  try {
    execSync(`node "${BUILDER_SCRIPT}" "${FILE_UTILS_DIR}"`, {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'pipe'
    });
  } catch (error) {
    logger.error('Failed to build file-utils', error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    throw new Error(`Failed to build file-utils`);
  }

  const releaseDir = path.join(FILE_UTILS_DIR, 'target', 'release');
  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));

  const destDir = path.join(APP_DIR, 'native', 'nativelibs', 'file-utils', 'linux');
  fs.ensureDirSync(destDir);

  for (const file of nodeFiles) {
    fs.copyFileSync(
      path.join(releaseDir, file),
      path.join(destDir, file)
    );
  }

  const indexJsPath = path.join(APP_DIR, 'native', 'nativelibs', 'file-utils', 'index.js');
  if (fs.existsSync(indexJsPath)) {
    let content = fs.readFileSync(indexJsPath, 'utf8');

    if (!content.includes("process.platform === 'linux'")) {
      content = content.replace(
        `} else {\n    return {error: 'not support'};\n  }`,
        `} else if (process.platform === 'linux'){\n    if (process.arch === 'x64') {\n      return require('./linux/file-utils.node');\n    }\n  } else {\n    return {error: 'not support'};\n  }`
      );
      fs.writeFileSync(indexJsPath, content, 'utf8');
      logger.dim('Patched index.js for Linux support');
    }
  }

  logger.success('file-utils built and installed');
}

if (require.main === module) {
  main();
}

module.exports = { main };