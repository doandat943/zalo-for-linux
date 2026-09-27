const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

/**
 * Do not show the main window while quitting.
 *
 * A quit Zalo did not start itself (our close-to-quit without a tray host,
 * the tray "Thoát", a session logout) goes through requestQuitApp(): it asks
 * the renderer to save its state ("before-quit") and then calls
 * mainWindow.show(), meant for quitting from the macOS dock. On Linux that
 * brought the just-closed window back for a moment before the app exited.
 * The renderer handshake is kept; only the show() is skipped on Linux.
 */
const SHOW_RE = /(this\.signalBeforeQuitToRender\(\),[\w$]+\)return void this\.quit\(\);)([\w$]+)\|\|this\.mainWindow\.show\(\)/g;
const PATCHED = '||"linux"===process.platform||this.mainWindow.show()';

async function main(appDir = APP_DIR) {
  let patched = 0;
  for (const name of ['main.js', 'compact-app.js']) {
    const file = path.join(appDir, 'main-dist', name);
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(PATCHED)) continue;
    const updated = content.replace(SHOW_RE, `$1$2${PATCHED}`);
    if (updated !== content) {
      fs.writeFileSync(file, updated, 'utf8');
      patched++;
      logger.dim(`Quit without re-showing the window: ${name}`);
    } else if (content.includes('signalBeforeQuitToRender')) {
      logger.warn(`requestQuitApp pattern not found in ${name}; the window may flash on quit`);
    }
  }
  if (patched > 0) logger.success(`Quit flow patched (${patched} files)`);
}

if (require.main === module) {
  main();
}

module.exports = { main };
