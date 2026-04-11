const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain } = require('electron');
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

let tray = null;
let mainWindow = null;
let isAppQuitting = false;

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

const zalux = require('./plugins/zalux');

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

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on('before-quit', () => {
  isAppQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  try { globalShortcut.unregisterAll(); } catch (_) { }
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

      if (tray) {
        const contextMenu = Menu.buildFromTemplate([
          {
            label: 'Show',
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
                mainWindow.focus();
              }
            }
          },
          {
            label: 'Hide',
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
            label: 'Quit',
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

    // Minimize to tray instead of closing
    win.on('close', (event) => {
      if (!isAppQuitting && tray) {
        event.preventDefault();
        win.hide();
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
      tray.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
      globalShortcut.register('CommandOrControl+Shift+I', toggleDevTools);
    } catch (e) {
      console.error('Tray init failed:', e);
    }
  }

  // Register Zalux Updater plugin
  zalux.register({ app, ipcMain, BrowserWindow, appDir });
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
