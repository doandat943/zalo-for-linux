/**
 * Build helper for nativelibs.
 *
 * Usage:
 *   node nativelibs/builder.js <addon-path>
 *
 * Examples:
 *   node nativelibs/builder.js nativelibs/db-cross-v4
 *   node nativelibs/builder.js ./path/to/addon
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../scripts/utils/logger');

const PACKAGE_JSON = require(path.join(__dirname, '..', 'package.json'));
const ELECTRON_VERSION = PACKAGE_JSON.devDependencies.electron.replace(/^\^/, '');

const libDir = process.argv[2];
const buildDir = path.join(libDir, 'build');
const releaseBinary = path.join(buildDir, 'Release');

logger.dim(`Lib dir: ${libDir}`);
logger.dim(`Electron: ${ELECTRON_VERSION}`);

const nodeModules = path.join(libDir, 'node_modules');
if (!fs.existsSync(nodeModules)) {
  execSync('npm install --no-audit --no-fund --loglevel=error', {
    cwd: libDir,
    stdio: 'ignore'
  });
}

execSync(
  `npx node-gyp configure --target=${ELECTRON_VERSION} --arch=x64 --dist-url=https://www.electronjs.org/headers build`,
  { cwd: libDir, stdio: 'ignore' }
);

const files = fs.readdirSync(releaseBinary).filter(f => f.endsWith('.node'));
if (files.length === 0) {
  throw new Error(`Build succeeded but binary not found in ${releaseBinary}`);
}

const binaryPath = path.join(releaseBinary, files[0]);
logger.dim(`Binary: ${files[0]} (${(fs.statSync(binaryPath).size / 1024).toFixed(1)} KB)`);