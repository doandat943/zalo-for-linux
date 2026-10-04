const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

async function main() {
  const mainJsPath = path.join(APP_DIR, 'main-dist', 'main.js');

  if (!fs.existsSync(mainJsPath)) {
    logger.warn('main.js not present, skipping titlebar patch');
    return;
  }

  let content = fs.readFileSync(mainJsPath, 'utf8');

  // Enable the native title bar on Linux, except on native Wayland where
  // Electron 22 draws none: there the window stays frameless and gets its
  // buttons from patch-wayland-titlebar (plugins/wayland-titlebar sets the flag).
  const FRAME = 'T,frame:!global.__zaloNativeWayland';
  if (content.includes('T,frame:!1') || content.includes('T,frame:!0')) {
    content = content.replace(/T,frame:!(?:1|0)(?![\w.])/g, FRAME);
    fs.writeFileSync(mainJsPath, content, 'utf8');
    logger.dim('Patched main.js: native title bar except on native Wayland');
  } else if (content.includes(FRAME)) {
    logger.dim('main.js title bar already patched');
  } else {
    logger.warn('Pattern T,frame:!1 not found in main.js, skipping patch');
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };