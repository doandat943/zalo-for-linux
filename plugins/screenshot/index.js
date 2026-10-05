/**
 * plugins/screenshot/index.js
 *
 * Screenshot plugin - intercepts Zalo's screenshot IPC calls and
 * delegates to native Linux screenshot tools.
 */

'use strict';

const { exec, execSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

// Screenshot tools (in priority order)
const SCREENSHOT_TOOLS = [
  { name: 'cosmic-screenshot',      cmd: 'cosmic-screenshot' },
  { name: 'deepin-screen-recorder', cmd: 'deepin-screen-recorder' },
  { name: 'spectacle',              cmd: 'spectacle -rbcn' },
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

        let success = false;
        try {
          // hide() makes Zalo close background windows after 10s. Portal dialogs
          // can take longer; Wayland also crashes on hide()/show() in Electron 22.
          if (hideWindow && _mainWindow && !_mainWindow.isDestroyed()) {
            if (global.__zaloNativeWayland || process.env.FLATPAK_ID || fs.existsSync('/.flatpak-info')) {
              _mainWindow.minimize();
            } else {
              _mainWindow.hide();
            }
          }
          success = await _triggerScreenshot();
        } catch (e) {
          console.error('[Screenshot Plugin]', e.message);
        } finally {
          if (hideWindow && _mainWindow && !_mainWindow.isDestroyed()) {
            if (_mainWindow.isMinimized()) _mainWindow.restore();
            _mainWindow.show();
            _mainWindow.focus();
            _mainWindow.moveTop();
            if (!_mainWindow.webContents.isDestroyed()) {
              _mainWindow.webContents.send('show-from-tray');
            }
          }
        }

        // Auto-paste captured screenshot into chat
        if (success) {
          const targetSender = (event && event.sender && !event.sender.isDestroyed())
            ? event.sender
            : (_mainWindow && !_mainWindow.isDestroyed() ? _mainWindow.webContents : null);

          if (targetSender && !targetSender.isDestroyed()) {
            setTimeout(() => {
              try {
                if (!targetSender.isDestroyed()) {
                  targetSender.send('zalo-linux-auto-paste-screenshot');
                }
              } catch (_) {}
            }, 300);
          }
        }

        return true;
      };
      return originalHandle(channel, wrappedHandler);
    }
    return originalHandle(channel, handler);
  };
}

async function _triggerScreenshot() {
  if (process.env.FLATPAK_ID || fs.existsSync('/.flatpak-info')) {
    if ((process.env.XDG_CURRENT_DESKTOP || '').split(':').some(de => de.toUpperCase() === 'KDE')) {
      const success = await _triggerPortalScreenshot(true);
      if (success !== null) return success; // Cancellation must not open the portal.
    }
    return _triggerPortalScreenshot();
  }
  return new Promise((resolve) => {
    for (const tool of SCREENSHOT_TOOLS) {
      try {
        execSync(`which ${tool.name}`, { stdio: 'ignore' });
        console.log(`[Screenshot Plugin] Using ${tool.name}`);
        exec(tool.cmd, (err) => {
          if (err) console.error(`[Screenshot Plugin] ${tool.name} error:`, err.message);
          resolve(!err);
        });
        return;
      } catch (e) { /* tool not found, try next */ }
    }
    console.warn('[Screenshot Plugin] No screenshot tool found');
    resolve(false);
  });
}

function _triggerPortalScreenshot(spectacle = false) {
  // Read through Electron's ASAR support; python cannot open files inside ASAR.
  const script = fs.readFileSync(path.join(__dirname, 'portal.py'), 'utf8');
  // This Flatpak app directory has the same path on the host. Spectacle can
  // write here without granting access to Pictures or arbitrary host commands.
  const directory = spectacle
    ? fs.mkdtempSync(path.join(require('electron').app.getPath('userData'), 'screenshot-'))
    : null;
  const args = ['-c', script];
  if (spectacle) args.push('--spectacle', path.join(directory, 'capture.png'));
  return new Promise((resolve) => {
    execFile('python3', args, { timeout: 120000 }, (err, stdout) => {
      if (err) {
        console.error('[Screenshot Plugin] Portal error:', err.message);
        // Only an unavailable API falls back; timeout/failure after launch stops.
        return resolve(spectacle && err.code === 3 ? null : false);
      }
      const uri = stdout.trim();
      if (!uri) return resolve(false); // User cancelled.
      try {
        const { clipboard, nativeImage } = require('electron');
        const image = nativeImage.createFromPath(fileURLToPath(uri));
        if (image.isEmpty()) return resolve(false);
        clipboard.writeImage(image);
        resolve(true);
      } catch (e) {
        console.error('[Screenshot Plugin] Portal image error:', e.message);
        resolve(false);
      }
    });
  }).finally(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });
}

function setMainWindow(win) {
  _mainWindow = win;
}

module.exports = { register, setMainWindow };
