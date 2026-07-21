const { app, BrowserWindow, Menu, Tray, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const appDir = fs.existsSync(path.join(__dirname, 'app'))
  ? path.join(__dirname, 'app')
  : path.join(path.dirname(process.execPath), 'app');

const iconPath = path.join(appDir, 'pc-dist', 'favicon-512x512.png');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
app.setName('zalo');
let tray = null;
let mainWindow = null;
let isAppQuitting = false;

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

const zaluxPlugin = require('./plugins/zalux');
const screenshotPlugin = require('./plugins/screenshot');
const launcherBadgePlugin = require('./plugins/launcher-badge');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toggleDevTools() {
  try {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win && win.webContents) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  } catch (e) {
    console.error('Toggle DevTools failed', e);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
  try {
    mainWindow.webContents.send('show-from-tray');
  } catch (e) {
    console.error('Failed to send show-from-tray:', e);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on('before-quit', () => {
  isAppQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('browser-window-created', (_evt, win) => {
  try {
    if (fs.existsSync(iconPath)) {
      win.setIcon(iconPath);
    }

    win.setMenuBarVisibility(false);
    if (win.removeMenu) win.removeMenu();
    win.autoHideMenuBar = true;

    // Track the main Zalo window for tray menu
    if (!mainWindow && win.getTitle() !== 'Shared Worker') {
      mainWindow = win;
      screenshotPlugin.setMainWindow(win);

      mainWindow.webContents.on('before-input-event', (_event, input) => {
        if ((input.control) && input.shift && input.key.toLowerCase() === 'i') {
          toggleDevTools();
        }
      });

      if (tray) {
        const contextMenu = Menu.buildFromTemplate([
          {
            label: 'Mở Zalo',
            click: showMainWindow
          },
          {
            label: 'Ẩn Zalo',
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.hide();
              }
            }
          },
          {
            label: 'Toggle DevTools',
            click: toggleDevTools
          },
          {
            label: 'Thoát',
            click: () => {
              isAppQuitting = true;
              if (tray) {
                tray.destroy();
                tray = null;
              }
              app.quit();
            }
          }
        ]);
        tray.setContextMenu(contextMenu);
      }
    }

    // Minimize to tray instead of closing.
    // The 50ms delay lets `event.preventDefault()` settle before hiding —
    // hiding immediately causes "Show" to be a no-op on some Linux DEs
    // (fixes #27).
    win.on('close', (event) => {
      if (!isAppQuitting && tray && (win === mainWindow || win.getTitle().includes('Zalo'))) {
        event.preventDefault();
        setTimeout(() => {
          if (!isAppQuitting && !win.isDestroyed()) {
            win.hide();
          }
        }, 50);
      }
    });
  } catch (e) {
    console.error('Error in browser-window-created:', e);
  }
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

app.once('ready', () => {
  try { Menu.setApplicationMenu(null); } catch (_) { }

  if (fs.existsSync(iconPath)) {
    try {
      tray = new Tray(iconPath);
      tray.setToolTip('Zalo');
      tray.on('click', showMainWindow);
      tray.on('double-click', showMainWindow);
    } catch (e) {
      console.error('Tray init failed:', e);
    }
  }

// Register plugins
  launcherBadgePlugin.register({ app, ipcMain });
  zaluxPlugin.register({ app, ipcMain, BrowserWindow, appDir });
  screenshotPlugin.register({ ipcMain });
});

// ---------------------------------------------------------------------------
// Bootstrap Zalo
// ---------------------------------------------------------------------------

function bootstrap() {
  const bootstrapPath = path.join(appDir, 'bootstrap.js');
  if (!fs.existsSync(bootstrapPath)) {
    console.error('Zalo bootstrap.js not found at:', bootstrapPath);
    return;
  }
  process.chdir(appDir);
  try {
    require(bootstrapPath);
  } catch (e) {
    console.error('Error loading Zalo:', e);
  }
}

bootstrap();
