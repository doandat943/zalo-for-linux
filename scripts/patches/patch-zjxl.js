const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const NATIVELIBS_DIR = path.join(__dirname, '..', '..', 'nativelibs');
const BUILDER_SCRIPT = path.join(NATIVELIBS_DIR, 'builder-rust.js');
const ZJXL_DIR = path.join(NATIVELIBS_DIR, 'zjxl');

async function main() {
  logger.info('Building zjxl from source...');

  if (!fs.existsSync(path.join(ZJXL_DIR, 'Cargo.toml'))) {
    logger.warn('zjxl not found, skipping');
    return;
  }

  try {
    execSync(`node "${BUILDER_SCRIPT}" "${ZJXL_DIR}"`, {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'pipe'
    });
  } catch (error) {
    logger.error('Failed to build zjxl', error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    throw new Error(`Failed to build zjxl`);
  }

  const releaseDir = path.join(ZJXL_DIR, 'target', 'release');
  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));

  const destDir = path.join(APP_DIR, 'native', 'nativelibs', 'zjxl', 'build', 'linux_x64');
  fs.ensureDirSync(destDir);

  for (const file of nodeFiles) {
    fs.copyFileSync(
      path.join(releaseDir, file),
      path.join(destDir, file)
    );
  }

  const indexJsPath = path.join(APP_DIR, 'native', 'nativelibs', 'zjxl', 'index.js');
  if (fs.existsSync(indexJsPath)) {
    let content = fs.readFileSync(indexJsPath, 'utf8');

    if (!content.includes("process.platform === 'linux'")) {
      content = content.replace(
        `} else {\n    return { error: 'not support' };\n  }`,
        `} else if (process.platform === 'linux') {\n    if (process.arch === 'arm64') nodeAddon = require('./build/linux_arm64/jxl.node');\n    else nodeAddon = require('./build/linux_x64/jxl.node');\n  } else {\n    return { error: 'not support' };\n  }`
      );
      fs.writeFileSync(indexJsPath, content, 'utf8');
      logger.dim('Patched index.js for Linux support');
    }
  }

  logger.success('zjxl built and installed');
}

if (require.main === module) {
  main();
}

module.exports = { main };