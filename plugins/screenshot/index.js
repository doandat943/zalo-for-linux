/**
 * plugins/screenshot/index.js
 *
 * Screenshot plugin - intercepts Zalo's screenshot IPC calls and
 * delegates to native Linux screenshot tools.
 */

'use strict';

const { exec, execSync } = require('child_process');

function isCommandAvailable(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const executeCmd = (cmd) => {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
};

// DE specific tools
const deTools = [
  { de: 'COSMIC', name: 'cosmic-screenshot', cmd: 'cosmic-screenshot' },
  { de: 'KDE',    name: 'spectacle',         cmd: 'spectacle -rbc' },
  { de: 'GNOME',  name: 'gnome-screenshot',  cmd: 'gnome-screenshot -ac' },
  { de: 'DEEPIN', name: 'deepin-screen-recorder', cmd: 'deepin-screen-recorder' },
  { de: 'XFCE',   name: 'xfce4-screenshooter',    cmd: 'xfce4-screenshooter -rc' },
  { de: 'MATE',   name: 'mate-screenshot',        cmd: 'mate-screenshot -i' }
];

// Universal tools (fallback)
const universalTools = [
  { name: 'dms', cmd: 'dms screenshot' },
  { name: 'ksnapshot',      cmd: 'ksnapshot' },
  { name: 'flameshot', cmd: 'flameshot gui' },
  { name: 'scrot',     cmd: 'scrot -s' },
];

const allTools = [...deTools, ...universalTools];

// Detect the best available screenshot tool based on the current desktop environment
function getDEScreenshotTool() {
  const currentDesktop = (process.env.XDG_CURRENT_DESKTOP || '').toUpperCase();
  const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase();

  for (const item of deTools) {
    if (currentDesktop.includes(item.de)) {
      if (isCommandAvailable(item.name)) {
        return item;
      }
    }
  }

  return null;
}

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
  return new Promise(async (resolve) => {
    const customToolName = (process.env.SCREENSHOT_TOOL || '').trim().toLowerCase();
    
    // Use set custom tool if specified in the environment variable
    if (customToolName) {
      const matchedTool = allTools.find(t => t.name.toLowerCase() === customToolName);

      if (matchedTool) {
        try {
          console.log(`[Screenshot Plugin] Using custom ENV tool: ${matchedTool.name}`);
          await executeCmd(matchedTool.cmd);
          resolve(true);
          return;
        } catch (e) {
          console.error(`[Screenshot Plugin] Custom ENV tool (${matchedTool.name}) failed: ${e.message}. Falling back...`);
        }
      } else {
        console.warn(`[Screenshot Plugin] Custom tool '${customToolName}' not supported. Falling back...`);
      }
    }

    // Try DE-specific tools first
    try {
      const deTool = getDEScreenshotTool();

      if (deTool) {
        console.log(`[Screenshot Plugin] Detected DE: ${process.env.XDG_CURRENT_DESKTOP || 'Unknown'} -> Using ${deTool.name}`);
        await executeCmd(deTool.cmd);
        resolve(true);
        return;
      } else {
        console.log('[Screenshot Plugin] No matching DE tool found, falling back to universal tools...');
      }
    } catch (e) { console.error(`[Screenshot Plugin] ${tool.name} failed: ${e.message}.`) /* fall back to universal tools */ } 
    
    // Try universal tools as a fallback
    for (const tool of universalTools) {
      try {
        isCommandAvailable(tool.name);
        console.log(`[Screenshot Plugin] Using ${tool.name}`);
        await executeCmd(tool.cmd);
        resolve(true);
        return;
      } catch (e) { console.error(`[Screenshot Plugin] ${tool.name} failed: ${e.message}.`) /* tool not found, try next */ }
    }
    console.warn('[Screenshot Plugin] No screenshot tool found');
    resolve(false);
  });
}

function setMainWindow(win) {
  _mainWindow = win;
}

module.exports = { register, setMainWindow };
