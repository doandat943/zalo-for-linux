const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');
const { patchStrings } = require('./patcher');

const NATIVELIBS_DIR = path.join(__dirname, '..', '..', 'nativelibs');
const BUILDER_GYP = path.join(NATIVELIBS_DIR, 'builder.js');
const BUILDER_RUST = path.join(NATIVELIBS_DIR, 'builder-rust.js');

/**
 * Build a native library (C++ or Rust) and install its .node binary into app.
 *
 * @param {object} opts
 * @param {string} opts.name - Library directory name under nativelibs/
 * @param {'rust'|'gyp'} [opts.type='rust'] - Build system
 * @param {string} opts.destDir - Destination directory in app
 * @param {string} [opts.loaderFile] - Path to index.js or binding.js to patch
 * @param {Array<{from: string|RegExp, to: string|Function}>} [opts.loaderReplacements] - Replacements for loaderFile
 */
function integrateNativeLib(opts) {
  const {
    name,
    type = 'rust',
    destDir,
    loaderFile,
    loaderReplacements
  } = opts;

  logger.info(`Building ${name} from source...`);
  const sourceDir = path.join(NATIVELIBS_DIR, name);
  const checkFile = type === 'rust' ? 'Cargo.toml' : 'binding.gyp';

  if (!fs.existsSync(path.join(sourceDir, checkFile))) {
    logger.warn(`${name} not found, skipping`);
    return;
  }

  const builderScript = type === 'rust' ? BUILDER_RUST : BUILDER_GYP;
  try {
    execSync(`node "${builderScript}" "${sourceDir}"`, {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'pipe'
    });
  } catch (error) {
    logger.error(`Failed to build ${name}`, error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    throw new Error(`Failed to build ${name}`);
  }

  const releaseDir = type === 'rust'
    ? path.join(sourceDir, 'target', 'release')
    : path.join(sourceDir, 'build', 'Release');

  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));
  fs.ensureDirSync(destDir);

  for (const file of nodeFiles) {
    fs.copyFileSync(
      path.join(releaseDir, file),
      path.join(destDir, file)
    );
  }

  if (loaderFile && loaderReplacements) {
    patchStrings(loaderFile, loaderReplacements, `${name} loader`);
  }

  logger.success(`${name} built and installed`);
}

module.exports = { integrateNativeLib };
