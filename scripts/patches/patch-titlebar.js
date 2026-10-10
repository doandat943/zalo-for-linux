const path = require('path');
const logger = require('../utils/logger');
const { patchStrings } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const REPLACEMENTS = [
  // Enable the native title bar on Linux, except on native Wayland where
  // Electron 22 draws none: there the window stays frameless and gets its
  // buttons from patch-wayland-titlebar (plugins/wayland-titlebar sets the flag).
  {
    from: /T,frame:!(?:1|0)(?![\w.])/g,
    to: 'T,frame:!global.__zaloNativeWayland'
  }
];

async function main() {
  patchStrings(path.join(APP_DIR, 'main-dist', 'main.js'), REPLACEMENTS, 'main.js: native title bar except on native Wayland');
}

if (require.main === module) {
  main();
}

module.exports = { main };
