/**
 * plugins/zalux/index.js
 *
 * Zalux plugin entry point.
 * Wires updater behaviour into the Electron app without polluting main.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const updater = require('./updater');

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

let _appDir      = null;
let _isPackaged  = false;
let _ipcMain     = null;
let _BrowserWindow = null;
let _mainWindow  = null;

/** Last known result from checkUpdates() — cached so the window
 *  can render immediately when the user clicks the icon. */
let _lastCheckResult = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wire the Zalux plugin into the running Electron app.
 */
function register({ app, ipcMain, BrowserWindow, appDir }) {
  _appDir        = appDir;
  _isPackaged    = app.isPackaged;
  _ipcMain       = ipcMain;
  _BrowserWindow = BrowserWindow;

  updater.init({
    appDir,
    getMainWindow: () => _mainWindow
  });

  app.on('browser-window-created', (_evt, win) => {
    _onWindowCreated(win);
  });

  // Allow renderer to request a fresh check
  ipcMain.on('zalux-check-update', () => {
    _runCheck(false);
  });
}

// ---------------------------------------------------------------------------
// Window hook
// ---------------------------------------------------------------------------

function _onWindowCreated(win) {
  // Intercept the document.title trick from the inject script
  win.on('page-title-updated', (event, title) => {
    if (title !== 'ZALUX_TRIGGER') return;
    event.preventDefault();
    _openVersionWindow();
  });

  // Inject sidebar icon into every page
  win.webContents.on('dom-ready', () => {
    const script = getInjectScript();
    win.webContents.executeJavaScript(script).catch(() => {});
  });

  // Track the first real Zalo window
  if (!_mainWindow && win.getTitle() !== 'Shared Worker') {
    _mainWindow = win;

    // Silent background check 10 seconds after startup
    setTimeout(() => _runCheck(false), 10000);
  }
}

// ---------------------------------------------------------------------------
// Check logic
// ---------------------------------------------------------------------------

function _runCheck(openWindowAfter) {
  updater.checkUpdates((result) => {
    _lastCheckResult = result;
    updater.showBadge(result.needsUpdate);
  });
}

// ---------------------------------------------------------------------------
// Version info window
// ---------------------------------------------------------------------------

function _openVersionWindow() {
  const winPath = path.join(__dirname, 'index.html');

  const versionWin = new _BrowserWindow({
    parent: _mainWindow,
    modal: true,
    width: 420,
    height: 500,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: true,
    title: 'Zalux',
    center: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const iconPath = path.join(_appDir, 'pc-dist', 'favicon-512x512.png');
  if (fs.existsSync(iconPath)) {
    try { versionWin.setIcon(iconPath); } catch (_) {}
  }

  versionWin.setMenuBarVisibility(false);
  if (versionWin.removeMenu) versionWin.removeMenu();
  versionWin.loadFile(winPath);

  versionWin.webContents.once('did-finish-load', () => {
    if (_lastCheckResult) {
      // Send cached result immediately
      _sendVersionInfo(versionWin, _lastCheckResult);
    } else {
      // No cached result — tell UI to show loading, then do a fresh check
      versionWin.webContents.send('version-checking');
      updater.checkUpdates((result) => {
        _lastCheckResult = result;
        updater.showBadge(result.needsUpdate);
        if (!versionWin.isDestroyed()) {
          _sendVersionInfo(versionWin, result);
        }
      });
    }
  });

  // Wire download button
  _ipcMain.removeAllListeners('zalux-start-download');
  _ipcMain.on('zalux-start-download', () => {
    if (_lastCheckResult && _lastCheckResult.asset && _lastCheckResult.currentAppImagePath) {
      updater.downloadAndSwap(
        _lastCheckResult.asset,
        _lastCheckResult.currentAppImagePath,
        versionWin
      );
    }
  });

  // Allow window to trigger a manual re-check
  _ipcMain.removeAllListeners('zalux-refresh');
  _ipcMain.on('zalux-refresh', () => {
    if (versionWin.isDestroyed()) return;
    versionWin.webContents.send('version-checking');
    updater.checkUpdates((result) => {
      _lastCheckResult = result;
      updater.showBadge(result.needsUpdate);
      if (!versionWin.isDestroyed()) {
        _sendVersionInfo(versionWin, result);
      }
    });
  });
}

function _sendVersionInfo(win, result) {
  const { isAppImage, needsUpdate, buildInfo, remoteInfo, error } = result;
  const iconPath = path.join(_appDir, 'pc-dist', 'favicon-512x512.png');
  const svgLogo  = path.join(_appDir, 'pc-dist', 'assets', 'logo-new.146dfa01c78183631d33b77999a18288.svg');

  win.webContents.send('version-info', {
    isAppImage,
    needsUpdate,
    error: error || null,
    localVersion:  buildInfo ? buildInfo.version       : null,
    localZadark:   buildInfo ? buildInfo.zadarkVersion  : null,
    localCommit:   buildInfo ? buildInfo.commit         : null,
    remoteVersion: remoteInfo ? remoteInfo.zaloVersion  : null,
    remoteZadark:  remoteInfo ? remoteInfo.zadarkVersion : null,
    remoteCommit:  remoteInfo ? remoteInfo.commit        : null,
    logoPath: 'file://' + (fs.existsSync(svgLogo) ? svgLogo : iconPath)
  });
}

// ---------------------------------------------------------------------------
// Inject script loader
// ---------------------------------------------------------------------------

function getInjectScript() {
  return fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
}

module.exports = { register, getInjectScript };
