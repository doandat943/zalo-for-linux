/**
 * Build helper for nativelibs (for Rust-based addons).
 *
 * Usage:
 *   node nativelibs/builder-rust.js <addon-path>
 *
 * Examples:
 *   node nativelibs/builder-rust.js nativelibs/db-cross-v4
 *   node nativelibs/builder-rust.js ./path/to/addon
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../scripts/utils/logger');

const PACKAGE_JSON = require(path.join(__dirname, '..', 'package.json'));
const ELECTRON_VERSION = PACKAGE_JSON.devDependencies.electron.replace(/^\^/, '');

const libDir = process.argv[2];
const buildDir = path.join(libDir, 'target');
const releaseBinary = path.join(buildDir, 'release');

logger.dim(`Lib dir: ${libDir}`);
logger.dim(`Electron: ${ELECTRON_VERSION}`);

execSync(
  `cargo build --release`,
  { cwd: libDir, stdio: 'ignore' }
);

const files = fs.readdirSync(releaseBinary).filter(f => f.endsWith('.so'));
if (files.length === 0) {
  throw new Error(`Build succeeded but binary not found in ${releaseBinary}`);
}

for (const file of files) {
  const newName = file.replace(/^lib/, '').replace(/\.so$/, '.node').replace(/_/g, '-');
  fs.renameSync(
    path.join(releaseBinary, file),
    path.join(releaseBinary, newName)
  );
}

const nodeFiles = fs.readdirSync(releaseBinary).filter(f => f.endsWith('.node'));
const binaryPath = path.join(releaseBinary, nodeFiles[0]);
logger.dim(`Binary: ${nodeFiles[0]} (${(fs.statSync(binaryPath).size / 1024).toFixed(1)} KB)`);