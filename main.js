const { app, BrowserWindow, Menu, Tray, ipcMain, screen } = require('electron');
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

// Hidden windows Zalo uses as background processes, never the main window.
const BACKGROUND_WINDOW_TITLES = ['Shared Worker', 'SQLite'];

// Linux optimizations & environment defaults
if (process.platform === 'linux') {
  const uid = process.getuid ? process.getuid() : 1000;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  if (!process.env.PULSE_SERVER) {
    process.env.PULSE_SERVER = `unix:${runtimeDir}/pulse/native`;
  }
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

const screenshotPlugin = require('./plugins/screenshot');
const launcherBadgePlugin = require('./plugins/launcher-badge');
const userscriptsPlugin = require('./plugins/userscripts');
const zcallBridgePlugin = require('./plugins/zcall-bridge');
const trayHost = require('./plugins/tray-host');
// Created with the main window: the screen module is not usable before 'ready'.
let windowState = null;
const startHidden = require('./plugins/start-hidden').createStartHiddenController({
  onMaximize: () => { if (windowState) windowState.requestMaximize(); }
});

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

// Native Wayland windows cannot be moved by the app, only X11/XWayland ones.
function isNativeWayland() {
  const platform = app.commandLine.getSwitchValue('ozone-platform');
  const hint = app.commandLine.getSwitchValue('ozone-platform-hint');
  return platform === 'wayland' ||
    (hint === 'wayland' || hint === 'auto') && process.env.XDG_SESSION_TYPE === 'wayland';
}

function showMainWindow() {
  startHidden.release();
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

// Launching Zalo again (dock, menu, notification) starts a second instance
// that only hands its arguments to the running one: Zalo's
// second-instance.js quits it during bootstrap, but 'ready' and 'before-quit'
// still fire in it. It must not start the tray or the plugins, nor tear the
// call engine down: zcall-bridge kills every qt-call-and-cap / wine process
// of our prefix at launch and quit, which ended the running instance's calls.
function isPrimaryInstance() {
  return app.hasSingleInstanceLock();
}

app.on('before-quit', () => {
  isAppQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// Zalo cancels the first quit to let the renderer save its state, then quits
// again, so 'before-quit' fires twice. Tearing the call engine down there
// (pkill + wineserver -k, ~3 s, synchronous) ran twice and held up Zalo's own
// quit flow. 'will-quit' fires once, after every window is closed.
app.on('will-quit', () => {
  if (isPrimaryInstance()) zcallBridgePlugin.shutdown();
});

// Registered before Zalo's bootstrap, so this runs before Zalo's own
// second-instance handler tries to show the window.
app.on('second-instance', () => {
  startHidden.release();
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
    if (!mainWindow && !BACKGROUND_WINDOW_TITLES.includes(win.getTitle())) {
      mainWindow = win;
      screenshotPlugin.setMainWindow(win);

      if (!windowState) {
        windowState = require('./plugins/window-state').createWindowStateController({
          screen,
          canPosition: !isNativeWayland(),
          stateFile: path.join(app.getPath('userData'), 'zalo-linux-window-state.json')
        });
      }
      windowState.attach(win);

      // Only start hidden when the tray exists, otherwise the window
      // would be unreachable.
      if (tray && trayHost.isAvailable()) startHidden.attach(win);

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
            label: 'Cài đặt gọi điện…',
            click: () => {
              zcallBridgePlugin.openSetupDialog({ userDataDir: app.getPath('userData') });
            }
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
      if (isAppQuitting) return;
      if (tray && trayHost.isAvailable() && (win === mainWindow || win.getTitle().includes('Zalo'))) {
        event.preventDefault();
        setTimeout(() => {
          if (!isAppQuitting && !win.isDestroyed()) {
            win.hide();
          }
        }, 50);
      } else if (win === mainWindow) {
        // No tray host (stock GNOME): the tray icon is invisible, so a hidden
        // window could never be reopened or quit. Quit instead.
        event.preventDefault();
        isAppQuitting = true;
        setImmediate(() => app.quit());
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
  if (!isPrimaryInstance()) return;
  try { Menu.setApplicationMenu(null); } catch (_) { }

  trayHost.init();

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
  screenshotPlugin.register({ ipcMain });
  userscriptsPlugin.register({ app, ipcMain, BrowserWindow });
  zcallBridgePlugin.launch({ userDataDir: app.getPath('userData') });
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
