const path = require('path');
const logger = require('../utils/logger');
const { patchStrings } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

/**
 * Do not show the main window while quitting.
 *
 * A quit Zalo did not start itself (our close-to-quit without a tray host,
 * the tray "Quit", a session logout) goes through requestQuitApp(): it asks
 * the renderer to save its state ("before-quit") and then calls
 * mainWindow.show(), meant for quitting from the macOS dock. On Linux that
 * brought the just-closed window back for a moment before the app exited.
 * The renderer handshake is kept; only the show() is skipped on Linux.
 */
const REPLACEMENTS = [
  // Skip mainWindow.show() on Linux during quit
  {
    from: /(this\.signalBeforeQuitToRender\(\),[\w$]+\)return void this\.quit\(\);)([\w$]+)\|\|this\.mainWindow\.show\(\)/g,
    to: '$1$2||"linux"===process.platform||this.mainWindow.show()'
  }
];

async function main() {
  for (const name of ['main.js', 'compact-app.js']) {
    patchStrings(path.join(APP_DIR, 'main-dist', name), REPLACEMENTS, `quit flow: ${name}`);
  }
  logger.success('Quit flow patched (2 files)');
}

if (require.main === module) {
  main();
}

module.exports = { main };
