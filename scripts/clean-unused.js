const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');

const APP_DIR = path.join(__dirname, '..', 'app');
const APP_NATIVE = path.join(APP_DIR, 'native');
const APP_NATIVE_LIBS = path.join(APP_NATIVE, 'nativelibs');

const CLEAN_NATIVELiBS =[
    "db-cross-v4/prebuilt/darwin",
    "file-utilities/darwin",
    "file-utilities/darwin-arm",
    "file-utils/darwin",
    "file-utils/darwin-arm",
    "file-utils/ia32",
    "file-utils/x64",
    "mp4thumb/darwin-arm64",
    "mp4thumb/darwin-x64",
    "sqlite3/binding/napi-v6-darwin-arm64",
    "sqlite3/binding/napi-v6-darwin-x64",
    "v8-profiles/profiler_electron1.8_mac.node",
    "zcall/zcall_mac.node",
    "zfile/win32",
    "zfile/win64",
    "zimage/darwin_arm64",
    "zimage/darwin_x64",
    "zjxl/build/darwin_arm64",
    "zjxl/build/darwin_x64",
    "zocr/darwin-arm64",
    "zocr/darwin-x64",
    "zwalker/darwin-arm64",
    "zwalker/darwin-x64",
]

async function main() {
  logger.info('Cleaning unused nativelibs...');

  for(const dir of CLEAN_NATIVELiBS) {
    const dirPath = path.join(APP_NATIVE_LIBS, dir);
    try {
      await fs.access(dirPath);
      await fs.remove(dirPath);
      logger.dim('Cleaned', dirPath);
    } catch (e) {
      logger.warn('Could not find', dirPath);
    }
  }
}

module.exports = { main };