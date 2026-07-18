const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const NATIVELIBS_DIR = path.join(__dirname, '..', '..', 'nativelibs');
const BUILDER_SCRIPT = path.join(NATIVELIBS_DIR, 'builder-rust.js');
const FILE_UTILITIES_DIR = path.join(NATIVELIBS_DIR, 'file-utilities');

async function main() {
  logger.info('Building file-utilities from source...');

  if (!fs.existsSync(path.join(FILE_UTILITIES_DIR, 'Cargo.toml'))) {
    logger.warn('file-utilities not found, skipping');
    return;
  }

  try {
    execSync(`node "${BUILDER_SCRIPT}" "${FILE_UTILITIES_DIR}"`, {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'pipe'
    });
  } catch (error) {
    logger.error('Failed to build file-utilities', error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    throw new Error(`Failed to build file-utilities`);
  }

  const releaseDir = path.join(FILE_UTILITIES_DIR, 'target', 'release');
  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));

  const destDir = path.join(APP_DIR, 'native', 'nativelibs', 'file-utilities', 'linux');
  fs.ensureDirSync(destDir);

  for (const file of nodeFiles) {
    fs.copyFileSync(
      path.join(releaseDir, file),
      path.join(destDir, file)
    );
  }

  const indexJsPath = path.join(APP_DIR, 'native', 'nativelibs', 'file-utilities', 'index.js');
  if (fs.existsSync(indexJsPath)) {
    let content = fs.readFileSync(indexJsPath, 'utf8');

    if (!content.includes("case 'linux':")) {
      content = content.replace(
        `default:\n      throw new Error(\`Unsupported OS: \${platform}, architecture: \${arch}\`)\n  }\n}`,
        `case 'linux':\n      switch (arch) {\n        case 'x64':\n          return join(__dirname, 'linux', 'file-utilities.node')\n        default:\n          throw new Error(\`Unsupported architecture on Linux: \${arch}\`)\n      }\n    default:\n      throw new Error(\`Unsupported OS: \${platform}, architecture: \${arch}\`)\n  }\n}`
      );
      fs.writeFileSync(indexJsPath, content, 'utf8');
      logger.dim('Patched index.js for Linux support');
    }
  }

  logger.success('file-utilities built and installed');
}

if (require.main === module) {
  main();
}

module.exports = { main };