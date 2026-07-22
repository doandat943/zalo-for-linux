const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const NATIVELIBS_DIR = path.join(__dirname, '..', '..', 'nativelibs');
const BUILDER_SCRIPT = path.join(NATIVELIBS_DIR, 'builder.js');
const ZIMAGE_DIR = path.join(NATIVELIBS_DIR, 'zimage');
const VIPS_TAR_URL = 'https://github.com/lovell/sharp-libvips/releases/download/v8.14.5/libvips-8.14.5-linux-x64.tar.gz';

async function main() {
  logger.info('Building zimage from source...');

  if (!fs.existsSync(path.join(ZIMAGE_DIR, 'binding.gyp'))) {
    logger.warn('zimage not found, skipping');
    return;
  }

  execSync(`curl -L -s -S -o "${ZIMAGE_DIR}/vips.tar.gz" "${VIPS_TAR_URL}"`, { cwd: ZIMAGE_DIR });

  execSync(`tar -xzf "${ZIMAGE_DIR}/vips.tar.gz" include lib`, { cwd: ZIMAGE_DIR });

  try {
    execSync(`node "${BUILDER_SCRIPT}" "${ZIMAGE_DIR}"`, {
      cwd: ZIMAGE_DIR,
      stdio: 'pipe'
    });
  } catch (error) {
    logger.error('Failed to build zimage: ', error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    throw new Error(`Failed to build zimage`);
  }

  const releaseDir = path.join(ZIMAGE_DIR, 'build', 'Release');
  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));

  const destDir = path.join(APP_DIR, 'native', 'nativelibs', 'zimage', 'linux_x64');
  fs.ensureDirSync(destDir);

  for (const file of nodeFiles) {
    fs.copyFileSync(
      path.join(releaseDir, file),
      path.join(destDir, file)
    );
  }

  const libvipsSrc = path.join(ZIMAGE_DIR, 'lib', 'libvips-cpp.so.42');
  const libvipsDest = path.join(destDir, 'libvips-cpp.so.42');
  if (fs.existsSync(libvipsSrc)) {
    fs.copyFileSync(libvipsSrc, libvipsDest);
  } else {
    logger.error(`libvips-cpp.so.42 not found at ${libvipsSrc}`);
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