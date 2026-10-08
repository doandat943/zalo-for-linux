/**
 * plugins/zcall/incoming.js
 *
 * The incoming call notice (ui/incoming.html): a small frameless window in
 * the top right corner of the screen, as Zalo's macOS one, instead of the
 * call window. window.js shows it for phase 'incoming' and closes it when
 * the call is answered, declined or over; answering opens the call window.
 */

'use strict';

const path = require('path');

// Measured on Zalo for macOS (CSS px = pt): 344 wide, 232 for a voice call,
// 290 with "Trả lời không mở camera"; flush with the top of the work area,
// 10 from its right edge.
const WIDTH = 344;
const HEIGHT_VOICE = 232;
const HEIGHT_VIDEO = 290;
const MARGIN_RIGHT = 10;

let win = null;
let ready = false;
let pending = null;

function size(state) {
  return { width: WIDTH, height: state.video && !state.noAnswer ? HEIGHT_VIDEO : HEIGHT_VOICE };
}

function place(state) {
  const { screen } = require('electron');
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const s = size(state);
  return { x: wa.x + wa.width - s.width - MARGIN_RIGHT, y: wa.y, width: s.width, height: s.height };
}

/** Shows (or updates) the notice for an incoming state. */
function show(state, assetsDir) {
  const { BrowserWindow } = require('electron');
  pending = state;
  if (win && !win.isDestroyed()) {
    win.setBounds(place(state));
    if (ready) win.webContents.send('zcall-incoming-state', state);
    return;
  }
  ready = false;
  win = new BrowserWindow({
    ...place(state),
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: false, // set once shown, see below
    skipTaskbar: false,
    show: false,
    title: 'Zalo: cuộc gọi đến',
    backgroundColor: '#3989ff',
    // Local static page; the only remote content is the avatar image.
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.zcallWindow = true; // main.js: closing it declines, it does not hide to the tray
  win.setMenuBarVisibility(false);
  win.webContents.on('did-finish-load', () => {
    ready = true;
    if (pending) win.webContents.send('zcall-incoming-state', pending);
    win.showInactive();
    // alwaysOnTop of the constructor does not reach a window shown later (X11:
    // no _NET_WM_STATE_ABOVE, the notice stayed under Zalo's main window).
    win.setAlwaysOnTop(true);
    win.moveTop();
    win.flashFrame(true);
  });
  win.on('closed', () => { win = null; ready = false; pending = null; });
  win.loadFile(path.join(__dirname, 'ui', 'incoming.html'), { query: { assets: assetsDir } });
}

/** Closes the notice (answered, declined, cancelled). */
function close() {
  if (!win || win.isDestroyed()) return;
  if (ready) win.webContents.send('zcall-incoming-stop');
  win.destroy();
}

function isOpen() {
  return !!(win && !win.isDestroyed());
}

module.exports = { show, close, isOpen };
