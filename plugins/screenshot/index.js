/**
 * plugins/screenshot/index.js
 *
 * Screenshot plugin - intercepts Zalo's screenshot IPC calls and
 * delegates to native Linux screenshot tools.
 */

'use strict';

const { exec, execSync } = require('child_process');

// Screenshot tools (in priority order)
const SCREENSHOT_TOOLS = [
  { name: 'deepin-screen-recorder', cmd: 'deepin-screen-recorder' },
  { name: 'spectacle',              cmd: 'spectacle -rbc' },
  { name: 'flameshot',              cmd: 'flameshot gui' },
  { name: 'gnome-screenshot',       cmd: 'gnome-screenshot -ac' },
  { name: 'xfce4-screenshooter',    cmd: 'xfce4-screenshooter -rc' },
  { name: 'mate-screenshot',        cmd: 'mate-screenshot -i' },
  { name: 'ksnapshot',              cmd: 'ksnapshot' },
  { name: 'scrot',                  cmd: 'scrot' }
];

let _mainWindow = null;
let _ipcMain    = null;

function register({ ipcMain }) {
  _ipcMain = ipcMain;

  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = function (channel, handler) {
    if (channel === 'screen-capture') {
      const wrappedHandler = async (event, ...args) => {
        const opts = args[0];
        const hideWindow = opts && opts.captureMode === false;

        // Hide window for "screenshot without Zalo window" mode
        if (hideWindow && _mainWindow && !_mainWindow.isDestroyed()) {
          _mainWindow.hide();
        }

        try {
          await _triggerScreenshot();
        } catch (e) {
          console.error('[Screenshot Plugin]', e.message);
        }

        // Restore window
        if (hideWindow && _mainWindow && !_mainWindow.isDestroyed()) {
          _mainWindow.show();
          if (_mainWindow.isMinimized()) _mainWindow.restore();
          _mainWindow.focus();
          if (!_mainWindow.webContents.isDestroyed()) {
            _mainWindow.webContents.send('show-from-tray');
          }
        }

        return true;
      };
      return originalHandle(channel, wrappedHandler);
    }
    return originalHandle(channel, handler);
  };
}

function _triggerScreenshot() {
  return new Promise((resolve) => {
    for (const tool of SCREENSHOT_TOOLS) {
      try {
        execSync(`which ${tool.name}`, { stdio: 'ignore' });
        console.log(`[Screenshot Plugin] Using ${tool.name}`);
        exec(tool.cmd, (err) => {
          if (err) console.error(`[Screenshot Plugin] ${tool.name} error:`, err.message);
        });
        setTimeout(() => resolve(true), 1500);
        return;
      } catch (e) { /* tool not found, try next */ }
    }
    console.warn('[Screenshot Plugin] No screenshot tool found');
    resolve(false);
  });
}

function setMainWindow(win) {
  _mainWindow = win;
}

module.exports = { register, setMainWindow };
