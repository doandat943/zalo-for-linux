/**
 * plugins/wayland-titlebar/index.js
 *
 * Window controls on native Wayland (#57).
 *
 * patch-titlebar gives the main window a native frame (`frame: true`), which
 * the window manager decorates on X11/XWayland. Under native Wayland
 * (`--ozone-platform=wayland`) Electron 22 draws no decorations, so the window
 * had no close/minimize/maximize buttons and could not be moved.
 *
 * On native Wayland `global.__zaloNativeWayland` is set before Zalo creates
 * its windows, so the patched `frame:!global.__zaloNativeWayland` leaves them
 * frameless. Zalo's own title bar (`#titleBar`, a `-webkit-app-region: drag`
 * strip that the compositor can move) stays, and patch-wayland-titlebar adds
 * the three buttons to it; they talk to this plugin over IPC.
 *
 * Electron 22 also crashes on native Wayland when a window that was hidden is
 * shown again ("gtk_shell::get_gtk_surface already requested", SIGTRAP), with
 * or without a frame. Closing to tray hides the window, so reopening Zalo from
 * the dock or tray killed it. There, hiding a window that has been shown
 * minimizes it instead, which restores fine.
 */

'use strict';

const CHANNEL_ENABLED = 'zalo-wayland-titlebar:enabled';
const CHANNEL_ACTION = 'zalo-wayland-titlebar:action';
const CHANNEL_MAXIMIZED = 'zalo-wayland-titlebar:maximized';

function isNativeWayland(app, env = process.env) {
  const platform = app.commandLine.getSwitchValue('ozone-platform');
  const hint = app.commandLine.getSwitchValue('ozone-platform-hint');
  return platform === 'wayland' ||
    ((hint === 'wayland' || hint === 'auto') && env.XDG_SESSION_TYPE === 'wayland');
}

// Must run before Zalo creates its windows: the frame option reads the flag
// and every window's preload asks CHANNEL_ENABLED synchronously.
function init({ app, ipcMain }) {
  const enabled = process.platform === 'linux' && isNativeWayland(app);
  global.__zaloNativeWayland = enabled;
  ipcMain.on(CHANNEL_ENABLED, (event) => {
    event.returnValue = enabled;
  });
  return enabled;
}

function register({ app, ipcMain, BrowserWindow }) {
  if (global.__zaloNativeWayland !== true) return;

  ipcMain.on(CHANNEL_ACTION, (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (action === 'minimize') {
      win.minimize();
    } else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') {
      win.close();
    }
  });

  app.on('browser-window-created', (_event, win) => {
    // Background windows (Shared Worker, SQLite) are never shown: leave their
    // hide() alone, minimize() would map them.
    let shown = false;
    win.on('show', () => { shown = true; });
    const originalHide = win.hide;
    win.hide = function (...args) {
      if (shown && !win.isDestroyed()) return win.minimize();
      return originalHide.apply(this, args);
    };

    const send = (maximized) => {
      if (!win.isDestroyed()) win.webContents.send(CHANNEL_MAXIMIZED, maximized);
    };
    win.on('maximize', () => send(true));
    win.on('unmaximize', () => send(false));
  });
}

module.exports = { init, register, isNativeWayland };
