/**
 * plugins/zcall/window.js
 *
 * The call window. The engine (its own process) connects to a loopback
 * socket opened here, sends the call state and gets the user's clicks back;
 * the window is an always-on-top BrowserWindow with the desktop's title bar,
 * laid out as Zalo's macOS call window (ui/call.html, .css, .js; Zalo's own
 * icons, sounds and fonts from app/zcall-assets/). An incoming call shows
 * the notice of incoming.js (ui/incoming.*) first. The socket is passed to
 * the engine in ZCALL_UI_PORT / ZCALL_UI_TOKEN (inherited through the spawn);
 * the engine's first line is the token. Then one JSON object per line:
 *
 *   engine -> ui  {type:"state", phase, name, avatar, text, since, video, muted,
 *                  speakerOff, peerCamOff, peerMuted, peerSharing, cameraEncode?}
 *                 {type:"video", key, codec, data}   one received H.264 frame (Annex-B, base64)
 *                 {type:"keyframe"}                  the phone needs a key frame
 *                 {type:"speaking", src, on}         group: member src talks (tile border, speaker layout)
 *                 {type:"close", text}
 *   ui -> engine  {action:"hangup"|"accept"|"reject"|"mute"|"speaker"|"camera", on?}
 *                 {action:"videoFrame", key, data, screen, w, h}   our camera or screen, H.264 Annex-B (base64)
 *                 {action:"device", kind:"mic"|"speaker", id}   PulseAudio source / sink ("" = default)
 *                 {action:"screen", on}               our screen replaces the camera
 *
 * phase: outgoing | incoming | connecting | connected | ended.
 *
 * Video: the camera is encoded with WebCodecs (H.264 baseline, software) at the
 * engine's cameraEncode: in a 1-1 call the rung of the server's ladder that the
 * engine picks from the phone's loss reports (send-rate.js: 360p 20 fps 500 kbps
 * at first, up to 720p 24 fps 1100 kbps), key frames at the start, when the
 * engine asks (the phone's PLI) and every keyMs (10 s); in a group call layer 0
 * of the SFU table. That exact size is cut from the camera's centre; the camera
 * is captured at 1280x720 when the size is above 640 px, else 640x360 (asking
 * the device for 480x240 stalled the preview). Without cameraEncode: 15 fps, at
 * most 640 px, a key frame every 2 s. With ZCALL_TEST_VIDEO=1 and no camera, a
 * moving test pattern is sent instead. Sharing the screen replaces the camera
 * (10 fps, at most 1280 px) and ignores cameraEncode.
 *
 * Devices: the ▲ on the micro pill (micro and speakers), on the camera pill,
 * or the gear (all of them) picks the device, also during a call. Microphones and speakers come from PipeWire (pactl), cameras from
 * Chromium; the choice is saved in <userData>/zcall-devices.json and sent to
 * the engine whenever it connects.
 */

'use strict';

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const incoming = require('./incoming');

// Zalo's macOS call window, measured (CSS px = pt): voice 450x672, video and
// group 640x400 (content, under the desktop's own title bar).
const VOICE_WIDTH = 450;
const VOICE_HEIGHT = 672;
const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 400;
const COMPACT_WIDTH = 320; // compact: the picture (180) and the bar (50) in the screen's corner
const COMPACT_HEIGHT = 230;
const COMPACT_MARGIN = 16;
// Video and group windows can be resized, maximized and made full screen;
// below this content size the bar's tools would overlap the pills.
const VIDEO_MIN_WIDTH = 560;
const VIDEO_MIN_HEIGHT = 350;
const STATE_WAIT_MS = 1000; // leaving full screen / maximized is async on Linux
const CLOSE_DELAY_MS = 1500; // keep "Đã kết thúc" visible a moment

// Zalo's own call icons, sounds and fonts (scripts/extract-zcall-assets.js):
// app/ next to the root main.js in a checkout, next to the executable when packaged.
const ASSETS_DIR = (() => {
  const dev = path.join(__dirname, '..', '..', 'app', 'zcall-assets');
  return fs.existsSync(dev) ? dev : path.join(path.dirname(process.execPath), 'app', 'zcall-assets');
})();

let server = null;
let client = null;
let win = null;
let winReady = false;
let lastState = null;
let closeTimer = null;
let videoMode = false;
let compact = null; // the normal bounds while the window is compact
let camStartOff = false; // "Trả lời không mở camera": the call window starts with the camera off

// --- devices: { mic, speaker } PulseAudio names, camera { id, label }; '' / null = default ---
let prefsFile = null;
let prefs = null;

function loadPrefs() {
  if (prefs) return prefs;
  prefs = { mic: '', speaker: '', camera: null };
  try {
    prefsFile = path.join(require('electron').app.getPath('userData'), 'zcall-devices.json');
    Object.assign(prefs, JSON.parse(fs.readFileSync(prefsFile, 'utf8')));
  } catch (_) { /* first run */ }
  return prefs;
}

function savePrefs() {
  if (!prefsFile) return;
  try { fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2)); } catch (e) { console.error('[zcall-window] save devices:', e.message); }
}

function pactl(args) {
  return new Promise((resolve) => {
    execFile('pactl', args, { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

// Inputs without the monitors of outputs; outputs. Each { id, label }.
async function listAudio(kind) {
  const json = await pactl(['-f', 'json', 'list', kind]);
  let list = [];
  try {
    list = JSON.parse(json).map((d) => ({ id: d.name, label: d.description || d.name }));
  } catch (_) {
    // pactl without -f json (PulseAudio < 16): names only.
    list = (await pactl(['list', 'short', kind])).split('\n').map((l) => l.split('\t')[1]).filter(Boolean).map((n) => ({ id: n, label: n }));
  }
  // Not the monitors, nor the engine's own processed devices (zcall_ec_*: picking them would loop).
  return list.filter((d) => !d.id.endsWith('.monitor') && !d.id.startsWith('zcall_ec_'));
}

async function audioDevices() {
  const [mics, speakers, defMic, defSpeaker] = await Promise.all([
    listAudio('sources'), listAudio('sinks'), pactl(['get-default-source']), pactl(['get-default-sink']),
  ]);
  return { mics, speakers, defaultMic: defMic.trim(), defaultSpeaker: defSpeaker.trim(), prefs: loadPrefs() };
}

function sendDevicePrefs() {
  const p = loadPrefs();
  if (p.mic) send({ action: 'device', kind: 'mic', id: p.mic });
  if (p.speaker) send({ action: 'device', kind: 'speaker', id: p.speaker });
}

function send(msg) {
  if (client && !client.destroyed) {
    try { client.write(JSON.stringify(msg) + '\n'); } catch (_) { /* engine gone */ }
  }
}

function pushState(state) {
  if (camStartOff && state && !state.camStartOff) state = { ...state, camStartOff: true };
  lastState = state;
  if (win && !win.isDestroyed() && winReady) win.webContents.send('zcall-ui-state', state);
}

function ensureWindow() {
  const { BrowserWindow } = require('electron');
  clearTimeout(closeTimer);
  if (win && !win.isDestroyed()) return win;
  winReady = false;
  win = new BrowserWindow({
    width: VOICE_WIDTH,
    height: VOICE_HEIGHT,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'Zalo Call',
    backgroundColor: '#000000',
    // Local static page; the only remote content is the avatar image.
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.zcallWindow = true; // main.js: closing it ends the call, it does not hide to the tray
  // No menu bar at all: a hidden one comes back when full screen ends (25 px).
  win.removeMenu();
  // The size above counted the (now removed) menu bar in: 25 px too tall without this.
  win.setContentSize(VOICE_WIDTH, VOICE_HEIGHT);
  win.webContents.on('did-finish-load', () => {
    winReady = true;
    if (lastState) win.webContents.send('zcall-ui-state', lastState);
  });
  // Closing the window during a call ends it.
  win.on('close', () => {
    if (lastState && lastState.phase !== 'ended') send({ action: 'hangup' });
    lastState = null;
  });
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
  win.on('closed', () => { win = null; winReady = false; videoMode = false; compact = null; compacting = false; });
  // From a file, not a data: URL: WebCodecs (video) needs a secure context.
  win.loadFile(path.join(__dirname, 'ui', 'call.html'), {
    query: { assets: ASSETS_DIR, test: process.env.ZCALL_TEST_VIDEO === '1' ? '1' : '0' },
  });
  return win;
}

// Content size, keeping the window's centre.
function setContent(w, h) {
  const [x, y] = win.getPosition();
  const [cw, ch] = win.getContentSize();
  setBounds({ x: Math.round(x + (cw - w) / 2), y: Math.round(y + (ch - h) / 2), width: w, height: h });
}

// Video or group call (or its first frame): the 640x400 landscape window.
function enterVideoMode() {
  if (videoMode || !win || win.isDestroyed()) return;
  videoMode = true;
  if (compact) { // back to the video size when expanded
    compact = { x: Math.round(compact.x + (compact.width - VIDEO_WIDTH) / 2), y: Math.round(compact.y + (compact.height - VIDEO_HEIGHT) / 2), width: VIDEO_WIDTH, height: VIDEO_HEIGHT };
    return;
  }
  setContent(VIDEO_WIDTH, VIDEO_HEIGHT);
  applySizing();
}

// Voice and compact: a fixed size. Video and group: the user's size, the
// title bar's maximize button, full screen (F11, double click, the bar's button).
function applySizing() {
  // Linux: setResizable(false) saves the size limits and setResizable(true)
  // puts them back, so the minimum is cleared before and set after. 1x1, not
  // 0x0: Electron 22 ignores setMinimumSize(0, 0).
  const free = videoMode && !compact;
  win.setMaximizable(free); // macOS / Windows; Linux follows resizable
  win.setFullScreenable(free);
  if (free) {
    win.setResizable(true);
    const [ow, oh] = win.getSize();
    const [cw, ch] = win.getContentSize();
    win.setMinimumSize(VIDEO_MIN_WIDTH + ow - cw, VIDEO_MIN_HEIGHT + oh - ch);
  } else {
    win.setMinimumSize(1, 1);
    win.setResizable(false);
  }
}

function sendFullScreen() {
  if (win && !win.isDestroyed() && winReady) win.webContents.send('zcall-ui-fullscreen', win.isFullScreen());
}

// Resolves once the window has left full screen / maximized (or after STATE_WAIT_MS).
function leaveState(isOn, event, leave) {
  if (!isOn()) return Promise.resolve();
  return new Promise((resolve) => {
    const w = win;
    const done = () => { clearTimeout(t); w.removeListener(event, done); resolve(); };
    const t = setTimeout(done, STATE_WAIT_MS);
    w.once(event, done);
    leave();
  });
}

// Content size at a position from getPosition(). Known issue: under X11 with
// the window manager's title bar, getPosition() gives the content's corner but
// setPosition() places the frame's, so a compact / expand cycle leaves the
// window one title bar (32 px on GNOME) lower; reading the position back on
// 'move' did not fix it reliably.
function setBounds(b) {
  win.setResizable(true);
  win.setContentSize(b.width, b.height);
  win.setResizable(videoMode && !compact);
  win.setPosition(b.x, b.y);
}

// Compact: a small tile in the bottom-right corner of the window's screen,
// so it hides little of a shared screen; expanding restores the bounds.
// A full screen or maximized window leaves that state first and gets it back
// on expand.
// compact: { x, y } outer position, { width, height } content size, of the
// normal window; full / max: its state before.
let compacting = false;
let compactJob = Promise.resolve(); // the last compact / expand, awaited before the screen picker
async function setCompact(on) {
  if (!win || win.isDestroyed() || compacting || !!compact === on) return;
  if (on) {
    compacting = true;
    const full = win.isFullScreen();
    const max = win.isMaximized();
    try {
      await leaveState(() => win.isFullScreen(), 'leave-full-screen', () => win.setFullScreen(false));
      if (win.isDestroyed()) return;
      await leaveState(() => win.isMaximized(), 'unmaximize', () => win.unmaximize());
      if (win.isDestroyed()) return;
    } finally { compacting = false; }
    const [x, y] = win.getPosition();
    const [width, height] = win.getContentSize();
    compact = { x, y, width, height, full, max };
    applySizing();
    const wa = require('electron').screen.getDisplayMatching(win.getBounds()).workArea;
    win.setResizable(true);
    win.setContentSize(COMPACT_WIDTH, COMPACT_HEIGHT);
    win.setResizable(false);
    const [ow, oh] = win.getSize();
    win.setPosition(wa.x + wa.width - ow - COMPACT_MARGIN, wa.y + wa.height - oh - COMPACT_MARGIN);
  } else {
    const before = compact;
    compact = null;
    setBounds(before);
    applySizing();
    if (before.max) win.maximize();
    if (before.full) win.setFullScreen(true);
  }
  win.webContents.send('zcall-ui-compact', on);
  win.focus();
}

function onEngineMessage(m) {
  if (m.type === 'state') {
    // Incoming: the notice in the screen's corner, not the call window.
    if (m.phase === 'incoming') {
      lastState = m;
      camStartOff = false;
      incoming.show(m, ASSETS_DIR);
      return;
    }
    if (incoming.isOpen()) {
      incoming.close();
      // Missed or declined before answering: nothing else to show.
      if (m.phase === 'ended') { lastState = null; return; }
    }
    if (m.phase === 'outgoing') camStartOff = false;
    const state = camStartOff ? { ...m, camStartOff: true } : m;
    const first = !lastState || lastState.phase === 'ended' || lastState.phase === 'incoming';
    const w = ensureWindow();
    pushState(state);
    w.setTitle('Zalo Call - ' + (m.name || 'Zalo'));
    if (m.video) enterVideoMode();
    if (first) {
      w.show();
      w.focus();
    }
  } else if (m.type === 'keyframe') {
    if (win && !win.isDestroyed() && winReady) win.webContents.send('zcall-ui-keyframe');
  } else if (m.type === 'speaking') {
    if (win && !win.isDestroyed() && winReady) win.webContents.send('zcall-ui-speaking', m);
  } else if (m.type === 'video') {
    if (!win || win.isDestroyed() || !winReady || !lastState || lastState.phase !== 'connected') return;
    enterVideoMode();
    win.webContents.send('zcall-ui-video', m);
  } else if (m.type === 'close') {
    if (incoming.isOpen()) incoming.close();
    if (!win || win.isDestroyed()) { lastState = null; return; }
    pushState({ ...(lastState || {}), phase: 'ended', text: m.text || 'Đã kết thúc' });
    closeTimer = setTimeout(() => {
      lastState = null;
      if (win && !win.isDestroyed()) win.destroy();
    }, CLOSE_DELAY_MS);
  }
}

function onConnection(sock) {
  const token = process.env.ZCALL_UI_TOKEN;
  let authed = false;
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!authed) {
        if (line !== token) { sock.destroy(); return; }
        authed = true;
        if (client && client !== sock) client.destroy(); // engine restarted
        client = sock;
        sendDevicePrefs();
        continue;
      }
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      onEngineMessage(m);
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => {
    if (client !== sock) return;
    client = null;
    // Engine died mid-call: do not leave a dead window around.
    if (lastState) onEngineMessage({ type: 'close', text: 'Mất kết nối với bộ gọi điện' });
  });
}

/** Opens the socket and exports ZCALL_UI_PORT / ZCALL_UI_TOKEN. Call before the engine starts. */
function start() {
  if (server) return;
  const { ipcMain } = require('electron');
  process.env.ZCALL_UI_TOKEN = crypto.randomBytes(16).toString('hex');
  server = net.createServer(onConnection);
  server.on('error', (e) => console.error('[zcall-window]', e.message));
  server.listen(0, '127.0.0.1', () => {
    process.env.ZCALL_UI_PORT = String(server.address().port);
  });
  ipcMain.handle('zcall-ui-devices', () => audioDevices());
  // The screen to share. With PipeWire capture (Wayland, see zcall.configure)
  // this asks the desktop's portal, which lets the user pick one.
  ipcMain.handle('zcall-ui-screen-source', async () => {
    await compactJob; // out of full screen and compact before the portal's dialog opens
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const s = sources.find((x) => x.id.startsWith('screen:')) || sources[0];
    return s ? s.id : null;
  });
  // Compact / expand, from the page. Picking the screen to share happens with
  // the window compact and focused: GNOME puts the portal's dialog right under
  // the focused window, so above Zalo's main window (see ui/call.js).
  ipcMain.on('zcall-ui-window', (_e, op) => {
    if (!win || win.isDestroyed()) return;
    if (op === 'compact' || op === 'expand') {
      if (win.isMinimized()) win.restore();
      win.show();
      compactJob = setCompact(op === 'compact').catch((e) => console.error('[zcall-window] compact:', e.message));
    } else if (op === 'fullscreen') { // toggle, video / group only
      if (videoMode && !compact && !compacting) win.setFullScreen(!win.isFullScreen());
    } else if (op === 'leave-fullscreen') {
      if (win.isFullScreen()) win.setFullScreen(false);
    }
  });
  // The notice's answer: accept, maybe with the camera off; the call window opens with the next state.
  ipcMain.on('zcall-incoming-answer', (_e, opts) => {
    camStartOff = !!(opts && opts.camStartOff);
    send({ action: 'accept' });
  });
  ipcMain.on('zcall-ui-action', (_e, action) => {
    if (!action || typeof action.action !== 'string') return;
    if (action.action === 'videoFrame') { send(action); return; } // hot path
    if (action.action === 'device') {
      const p = loadPrefs();
      if (action.kind === 'camera') { p.camera = action.id ? { id: String(action.id), label: String(action.label || '') } : null; savePrefs(); return; }
      if (action.kind !== 'mic' && action.kind !== 'speaker') return;
      p[action.kind] = typeof action.id === 'string' ? action.id : '';
      savePrefs();
      send({ action: 'device', kind: action.kind, id: p[action.kind] });
      return;
    }
    if (lastState && (action.action === 'mute' || action.action === 'speaker')) {
      lastState = { ...lastState, [action.action === 'mute' ? 'muted' : 'speakerOff']: !!action.on };
      pushState(lastState);
    }
    send(action);
  });
}

function stop() {
  if (win && !win.isDestroyed()) win.destroy();
  incoming.close();
  if (server) server.close();
  server = null;
}

module.exports = { start, stop };
