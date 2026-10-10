const path = require('path');
const { integrateNativeLib } = require('../utils/nativelib');
const { patchStrings } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const BINDING_REPLACEMENTS = [
  // Load Linux binary for db-cross-v4
  {
    from: /else \{\s*if \(process\.arch === 'x64'\)/,
    to: "else if (process.platform === 'linux') {\n    addon = require('../prebuilt/linux/electron/x64/db-cross-v4-native.node');\n}\nelse {\n    if (process.arch === 'x64')"
  }
];

const PLATFORM_ID_REPLACEMENTS = [
  // PLATFORM ID PATCH
  // ---------------------------------------------------------------
  // Switching the platform ID from 25 to another ID is required to
  // make the patch's features work. The only observed difference
  // is how Zalo's tray icon behaves:
  //
  //   25 -> 23 (macOS)   <- currently used
  //       Zalo's tray icon does not appear, so only our own icon
  //       is shown.
  //
  //   25 -> 24 (Windows)
  //       Zalo's tray icon also appears alongside ours, but the
  //       actual Zalo logo is missing - it shows a default/blank
  //       icon. Result: two tray icons, with the Zalo one looking
  //       wrong.
  // ---------------------------------------------------------------
  {
    from: /case"LINUX":return 25;/g,
    to: 'case"LINUX":return 23;'
  }
];

async function main() {
  integrateNativeLib({
    name: 'db-cross-v4',
    type: 'gyp',
    destDir: path.join(APP_DIR, 'native', 'nativelibs', 'db-cross-v4', 'prebuilt', 'linux', 'electron', 'x64'),
    loaderFile: path.join(APP_DIR, 'native', 'nativelibs', 'db-cross-v4', 'dist', 'binding.js'),
    loaderReplacements: BINDING_REPLACEMENTS
  });

  const mainJsPath = path.join(APP_DIR, 'main-dist', 'main.js');
  patchStrings(mainJsPath, PLATFORM_ID_REPLACEMENTS, 'platform ID (25 -> 23, macOS)');
}

if (require.main === module) {
  main();
}

module.exports = { main };
