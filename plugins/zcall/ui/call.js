/**
 * plugins/zcall/ui/call.js (renderer): the call window.
 *
 * State comes from the engine through plugins/zcall/window.js
 * ('zcall-ui-state'); clicks go back as 'zcall-ui-action'. The capture,
 * H.264 encode (WebCodecs) and decode code is unchanged from the former
 * inline page of window.js; this file adds the layout of Zalo's macOS call
 * window (ui/call.css), its icons and sounds (ui/assets.js).
 */

'use strict';

const { ipcRenderer } = require('electron');
const { setIcon, playSound, stopSound, params } = window.zcallAssets;
const $ = (id) => document.getElementById(id);
const TEST_PATTERN = params.get('test') === '1';
let state = {}; let tick = null;
const act = (action, extra) => ipcRenderer.send('zcall-ui-action', Object.assign({ action }, extra || {}));

$('end').onclick = () => act('hangup');
$('mute').onclick = () => { const on = !state.muted; act('log', { text: 'mute ' + (on ? 'on' : 'off') }); act('mute', { on }); };
$('layout').onclick = () => { document.body.classList.toggle('split'); };
let compactMode = false, autoCompact = false;
$('compactBtn').onclick = () => { autoCompact = false; ipcRenderer.send('zcall-ui-window', compactMode ? 'expand' : 'compact'); };
// Full screen (video and group): the bar's button, F11, a double click on the picture; Esc leaves it.
let fullScreen = false;
const toggleFull = () => { if (state.video && !compactMode) ipcRenderer.send('zcall-ui-window', 'fullscreen'); };
$('full').onclick = toggleFull;
$('main').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleFull(); });
ipcRenderer.on('zcall-ui-fullscreen', (_e, on) => {
  fullScreen = !!on;
  document.body.classList.toggle('fullscreen', fullScreen);
  setIcon($('fullIcon'), fullScreen ? 'fullscreenOff' : 'fullscreen');
  $('full').title = fullScreen ? 'Thoát toàn màn hình (Esc)' : 'Toàn màn hình (F11)';
});
ipcRenderer.on('zcall-ui-compact', (_e, on) => {
  compactMode = on;
  document.body.classList.toggle('compact', on);
  render();
});

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  return (h ? h + ':' : '') + mm + ':' + ss;
}

// Ringback while our call rings; the end tone when a call that was up ends.
function sounds(before) {
  if (state.phase === 'outgoing') playSound('ringback', true); else stopSound('ringback');
  if (state.phase === 'ended' && before && before !== 'ended') playSound('end', false);
}

function render() {
  const s = state;
  const ended = s.phase === 'ended';
  const name = s.name || 'Zalo';
  document.title = 'Zalo Call - ' + name;
  for (const p of ['outgoing', 'connecting', 'connected', 'ended']) document.body.classList.toggle('phase-' + p, s.phase === p);
  document.body.classList.toggle('is-video', !!s.video);
  $('status').textContent = s.phase === 'connected' && !ended ? '' : (s.text || '');
  $('peerName').textContent = name;
  const av = $('avatar'), bg = $('bg');
  if (s.avatar) {
    const url = 'url("' + String(s.avatar).replace(/["\\\n]/g, '') + '")';
    av.style.backgroundImage = url; bg.style.backgroundImage = url; av.textContent = '';
  } else {
    av.style.backgroundImage = ''; bg.style.backgroundImage = ''; av.textContent = name.trim().charAt(0).toUpperCase();
  }
  // The peer's camera off: drop its last (frozen) frame, show the avatar.
  if (s.peerCamOff) document.body.classList.remove('has-video');
  $('peerCam').classList.toggle('hide', !(s.video && s.peerCamOff && s.phase === 'connected'));
  $('peerMic').classList.toggle('hide', !(s.peerMuted && s.phase === 'connected'));
  $('peerShare').classList.toggle('hide', !(s.peerSharing && s.phase === 'connected'));
  // Micro: on / off. Camera: only in a video call (grey in a voice call, as in Zalo).
  setIcon($('micIcon'), s.muted ? 'micOff' : 'mic');
  $('mute').title = s.muted ? 'Bật micro' : 'Tắt micro';
  const camUsable = !!s.video && !noCamera;
  $('cam').disabled = !camUsable;
  $('camCaret').disabled = !s.video;
  setIcon($('camIcon'), !camUsable ? 'camDisabled' : (camOn ? 'cam' : 'camOff'));
  setIcon($('camCaret').firstElementChild, s.video ? 'caret' : 'caretDisabled');
  $('cam').title = noCamera ? 'Không có camera' : (camOn ? 'Tắt camera' : 'Bật camera');
  setIcon($('screenIcon'), sharing ? 'shareOff' : 'share');
  $('screen').title = sharing ? 'Dừng chia sẻ màn hình' : 'Chia sẻ màn hình';
  $('compactBtn').classList.toggle('hide', !(compactMode || sharing));
  $('compactBtn').textContent = compactMode ? 'Phóng to' : 'Thu gọn';
  clearInterval(tick);
  const upd = () => { $('timer').textContent = s.since && !ended ? fmt(Date.now() - s.since) : ''; };
  upd(); if (s.since && !ended) tick = setInterval(upd, 500);
}

// Group: our camera is a tile like the others (first), 1-1 it is the 170x96 corner view.
const selfTile = document.createElement('div');
selfTile.className = 'tile';
const selfLabel = document.createElement('span');
selfLabel.className = 'label';
selfLabel.textContent = 'Bạn';
function placeSelf() {
  const self = $('self');
  const group = document.body.classList.contains('has-tiles');
  if (group && document.body.classList.contains('has-self')) {
    if (self.parentNode !== selfTile) { selfTile.append(self, selfLabel); }
    if (selfTile.parentNode !== $('stage')) $('stage').prepend(selfTile);
  } else {
    if (self.parentNode !== $('pip')) $('pip').prepend(self);
    if (selfTile.parentNode) selfTile.remove();
  }
  layoutTiles();
}
// The largest 16:9 tiles, 5 apart, that fit the picture area.
const GAP = 5;
function layoutTiles() {
  const stage = $('stage');
  const boxes = Array.from(stage.children);
  const n = boxes.length;
  if (!n) return;
  const W = stage.clientWidth, H = stage.clientHeight;
  let best = { w: 0, h: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (W - (cols - 1) * GAP) / cols;
    let h = w * 9 / 16;
    if (h * rows + (rows - 1) * GAP > H) { h = (H - (rows - 1) * GAP) / rows; w = h * 16 / 9; }
    if (w > best.w) best = { w: Math.floor(w), h: Math.floor(h) };
  }
  for (const b of boxes) { b.style.width = best.w + 'px'; b.style.height = best.h + 'px'; }
}
window.addEventListener('resize', layoutTiles);
new MutationObserver(placeSelf).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// Group layer 0. open() and a 1-1 state omit the key, which clears it.
// status() keeps the key once the engine has set it.
let cameraEncode = null, screenEncode = null;
let camChosen = false; // camStartOff ("Trả lời không mở camera") applies once per call
ipcRenderer.on('zcall-ui-state', (_e, s) => {
  const before = state.phase;
  state = s || {};
  cameraEncode = state.cameraEncode || null;
  screenEncode = state.screenEncode || null;
  if (!camChosen && state.phase) { camChosen = true; if (state.camStartOff) camOn = false; }
  if (state.phase !== 'connected') {
    stopVideo(); stopLocal(); sharing = false;
    if (pendingScreen) { pendingScreen.stop(); pendingScreen = null; }
  }
  else if (state.video && camOn && !local && !sharing) startLocal();
  else if (local && local.kind === 'camera' && !sharing && local.big !== undefined && local.big !== wantBigCapture()) {
    act('log', { text: 'camera capture size changes: restart' });
    stopLocal(); startLocal();
  }
  else if (state.video && !camOn && before !== 'connected') act('camera', { on: false });
  sounds(before);
  render();
});

// --- what we send (camera or screen): capture, preview, H.264 encode, frames to the engine ---
const self = $('self'); const sg = self.getContext('2d');
// local: the capture running, { kind: 'camera' | 'screen', stop }.
let camOn = true, noCamera = false, sharing = false, local = null, enc = null, nFrames = 0, nextDue = 0, encErrLogged = false;
let camPref = null, curCamId = ''; // saved choice { id, label }; the camera in use
let capFps = 0; // frame rate the camera says it delivers (0: unknown)
// Encoder settings per source. Level 3.0 (avc1.42E01E) holds 640 px: a
// 1920x1080 camera (Iriun) encoded as is never shows on the phone. The
// screen needs level 4.0 (avc1.42E028) for 1280 px at any aspect ratio.
const PROFILES = {
  camera: { fps: 15, maxSide: 640, bitrate: 500000, codec: 'avc1.42E01E' },
  screen: { fps: 10, maxSide: 1280, bitrate: 1500000, codec: 'avc1.42E028' }
};
const KEY_MS = 2000; // screen, and the camera until the engine's profile came
let forceKey = true, lastKeyAt = 0; // key frame now (engine asked: start, PLI) / every keyMs
let scaler = null, scalerG = null;
// One object per layer-0 key, so the encoder is not reconfigured every frame.
let groupProfile = null, groupKey = '';
let groupScreen = null, groupScreenKey = '';
function sendProfile() {
  if (sharing) {
    // Group: the server's limit on the shorter side and bitrate (engine screenEncode).
    const s = screenEncode;
    if (!s || !(s.maxShort > 0)) return PROFILES.screen;
    const k = s.maxShort + '/' + s.bitrate;
    if (!groupScreen || groupScreenKey !== k) {
      groupScreenKey = k;
      groupScreen = Object.assign({}, PROFILES.screen, { maxShort: s.maxShort, bitrate: s.bitrate > 0 ? s.bitrate : PROFILES.screen.bitrate, codec: 'avc1.42E01F', screen: true });
    }
    return groupScreen;
  }
  const e = cameraEncode;
  if (!e || !(e.width > 0) || !(e.height > 0)) return PROFILES.camera;
  const w = e.width & ~1, h = e.height & ~1;
  const fps = e.fps > 0 ? e.fps : PROFILES.camera.fps;
  const bitrate = e.bitrate > 0 ? e.bitrate : PROFILES.camera.bitrate;
  const keyMs = e.keyMs > 0 ? e.keyMs : 1000;
  const codec = Math.max(w, h) <= 640 ? 'avc1.42E01E' : 'avc1.42E028';
  const key = w + 'x' + h + '@' + fps + '/' + bitrate + '/' + keyMs + '/' + codec;
  if (groupProfile && groupKey === key) return groupProfile;
  groupKey = key;
  groupProfile = { fps: fps, width: w, height: h, bitrate: bitrate, keyMs: keyMs, codec: codec, exact: true, rung: e.rung || 0 };
  return groupProfile;
}
$('cam').onclick = () => {
  if (noCamera) return;
  camOn = !camOn;
  if (!sharing) { if (camOn) startLocal(); else { stopLocal(); act('camera', { on: false }); } }
  render();
};
$('screen').onclick = () => { if (sharing) stopScreen(); else startScreen(); };
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// What the send path did in the last 5 s, one log line: frames the capture gave,
// skipped for the frame rate, skipped with the encoder queue full, handed to the
// encoder, chunks out (key), queue size and encoder state now. Group camera froze
// after ~3 s on 2026-10-08 (14 frames in 11 s left the engine): this shows where.
// Also the bytes out (kbps the encoder really gives against the bitrate asked) and why
// key frames were made: start (new encoder / call start), asked (the phone's PLI),
// timer (keyMs).
const tx = { got: 0, rep: 0, rate: 0, full: 0, enc: 0, out: 0, key: 0, bytes: 0, kStart: 0, kAsked: 0, kTimer: 0, at: performance.now() };
function txReport(now) {
  if (now - tx.at < 5000) return;
  const P = enc && enc.profile;
  act('log', { text: 'send ' + (sharing ? 'screen' : 'camera') + ' 5s: got ' + tx.got + ', repeated ' + tx.rep + ', rate-skip ' + tx.rate + ', queue-skip ' + tx.full +
    ', encoded ' + tx.enc + ', out ' + tx.out + ' (' + tx.key + ' key: start ' + tx.kStart + ', asked ' + tx.kAsked + ', timer ' + tx.kTimer + '), ' +
    Math.round(tx.bytes * 8 / ((now - tx.at) / 1000) / 1000) + ' kbps, queue ' + (enc ? enc.encodeQueueSize : '-') + ', encoder ' + (enc ? enc.state : 'none') +
    (P ? ' ' + enc.w + 'x' + enc.h + '@' + P.fps + ' ' + Math.round(P.bitrate / 1000) + 'k' + (P.rung ? ' rung ' + P.rung : '') : '') });
  tx.got = tx.rep = tx.rate = tx.full = tx.enc = tx.out = tx.key = tx.bytes = tx.kStart = tx.kAsked = tx.kTimer = 0; tx.at = now;
}
// Also when the capture gives nothing at all (then 'got 0' says so).
setInterval(() => { if (local) txReport(performance.now()); }, 5000);
// A camera that stops for seconds (Iriun Webcam over Wi-Fi measured 2026-10-08:
// 25, 30, 5 frames, then nothing for 9 s, then 28 / s again, outside Zalo too):
// the phone keeps the last picture only if frames keep coming, and a member who
// starts watching in such a gap gets no key frame at all. So the last camera
// frame is encoded again, REPEAT_FPS times a second, after REPEAT_AFTER_MS
// without a new one (the key frame interval still applies).
const REPEAT_AFTER_MS = 600, REPEAT_FPS = 4;
let held = null, heldAt = 0, repeatAt = 0;
function holdFrame(frame) {
  if (held) try { held.close(); } catch (_) {}
  held = null;
  try { held = frame.clone(); heldAt = performance.now(); } catch (_) {}
}
function dropHeld() { if (held) try { held.close(); } catch (_) {} held = null; }
setInterval(() => {
  const now = performance.now();
  if (!held || !local || local.kind !== 'camera' || sharing) return;
  if (now - heldAt < REPEAT_AFTER_MS || now - repeatAt < 1000 / REPEAT_FPS) return;
  repeatAt = now;
  let f = null;
  // A fresh timestamp: the encoder is given frames in increasing time.
  try { f = new VideoFrame(held, { timestamp: Math.round(now * 1000) }); } catch (_) { dropHeld(); return; }
  tx.rep++;
  nextDue = 0; // the frame-rate gate is for the capture, not for these
  encodeFrame(f, true);
}, 100);
function encodeFrame(frame, repeat) {
  let current = frame;
  if (!repeat) {
    tx.got++;
    if (local && local.kind === 'camera' && !sharing) holdFrame(frame);
  }
  txReport(performance.now());
  try {
    const P = sendProfile();
    const now = performance.now();
    // Frame-rate gate on a schedule, not on the gap to the last frame: a 15 fps
    // camera has frames 55-75 ms apart, and "at least 61 ms since the last one"
    // let only 44 of its 75 frames in 5 s through (8.8 fps sent, logs 2026-10-08/09).
    const iv = 1000 / P.fps;
    if (now + iv * 0.5 < nextDue) { tx.rate++; return; }
    nextDue = Math.max(nextDue + iv, now - iv * 0.5);
    let w, h, src = current;
    if (P.exact) {
      // Exactly the announced layer, so the SPS matches sub 12. The camera fills it,
      // cut at the centre (a 16:9 camera in the 2:1 layer loses a little at the top
      // and bottom), instead of the black bars of a fit.
      // Software encoder: the hardware path on this N100 stalled the preview.
      w = P.width; h = P.height;
      if (!scaler || scaler.width !== w || scaler.height !== h) { scaler = new OffscreenCanvas(w, h); scalerG = scaler.getContext('2d'); }
      const sw = current.displayWidth || w, sh = current.displayHeight || h;
      const cover = Math.max(w / sw, h / sh);
      const cw = Math.min(sw, Math.round(w / cover)), ch = Math.min(sh, Math.round(h / cover));
      const cx = Math.floor((sw - cw) / 2), cy = Math.floor((sh - ch) / 2);
      scalerG.drawImage(current, cx, cy, cw, ch, 0, 0, w, h);
      const ts = current.timestamp;
      const cam = current;
      current = new VideoFrame(scaler, { timestamp: ts });
      cam.close();
      src = scaler;
    } else {
      let k = Math.min(1, P.maxSide / Math.max(current.displayWidth, current.displayHeight));
      if (P.maxShort > 0) k = Math.min(k, P.maxShort / Math.min(current.displayWidth, current.displayHeight));
      w = Math.round(current.displayWidth * k) & ~1; h = Math.round(current.displayHeight * k) & ~1;
      if (k < 1) {
        if (!scaler || scaler.width !== w || scaler.height !== h) { scaler = new OffscreenCanvas(w, h); scalerG = scaler.getContext('2d'); }
        scalerG.drawImage(current, 0, 0, w, h);
        const ts = current.timestamp;
        const cam = current;
        current = new VideoFrame(scaler, { timestamp: ts });
        cam.close();
        src = scaler;
      }
    }
    if (!enc || enc.state === 'closed' || enc.w !== w || enc.h !== h || enc.profile !== P) {
      if (enc && enc.state !== 'closed') try { enc.close(); } catch (e1) {}
      enc = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
          tx.out++; tx.bytes += chunk.byteLength; if (chunk.type === 'key') tx.key++;
          act('videoFrame', { key: chunk.type === 'key', data: b64(data), screen: P === PROFILES.screen || !!P.screen, w: w, h: h });
        },
        error: (err) => {
          if (!encErrLogged) { encErrLogged = true; act('log', { text: 'encoder error ' + ((err && err.message) || err || 'unknown') }); }
          enc = null;
        },
      });
      // OpenH264 spends bitrate / framerate per frame: a 15 fps camera on a 24 fps rung
      // got 676 of 1100 kbps ("Actual input framerate 15 is different from framerate
      // in setting 24"). Tell it the rate it really gets.
      const fr = capFps > 0 && !sharing ? Math.min(P.fps, capFps) : P.fps;
      const cfg = { codec: P.codec, width: w, height: h, bitrate: P.bitrate, framerate: fr, avc: { format: 'annexb' }, latencyMode: 'realtime' };
      if (P.exact) cfg.hardwareAcceleration = 'prefer-software';
      enc.configure(cfg);
      act('log', { text: 'encoder ' + P.codec + ' ' + w + 'x' + h + '@' + fr + ' ' + Math.round(P.bitrate / 1000) + ' kbps, key every ' + (P.keyMs || KEY_MS) + ' ms' +
        (P.rung ? ', rung ' + P.rung : '') + (cfg.hardwareAcceleration ? ', ' + cfg.hardwareAcceleration : '') });
      enc.w = w; enc.h = h; enc.profile = P; nFrames = 0;
    }
    if (self.width !== w || self.height !== h) { self.width = w; self.height = h; if (selfTile.parentNode) layoutTiles(); }
    sg.drawImage(src, 0, 0);
    document.body.classList.add('has-self');
    if (enc.encodeQueueSize >= 3) tx.full++;
    if (enc.encodeQueueSize < 3) {
      tx.enc++;
      const keyEvery = P.keyMs || KEY_MS;
      const first = nFrames++ === 0;
      const key = forceKey || first || now - lastKeyAt >= keyEvery;
      if (key) {
        if (first) tx.kStart++; else if (forceKey) tx.kAsked++; else tx.kTimer++;
        forceKey = false; lastKeyAt = now;
      }
      enc.encode(current, { keyFrame: key });
    }
  } catch (err) {
    if (!encErrLogged) { encErrLogged = true; act('log', { text: 'encode failed ' + ((err && err.message) || err || 'unknown') }); }
    try { if (enc && enc.state !== 'closed') enc.close(); } catch (e2) {}
    enc = null;
  } finally {
    try { current.close(); } catch (e3) {}
  }
}
// Frames of the track to the encoder until cap.stop(). onFirst(frame)
// decides about the first one (true: encode it); onEnd() when the track
// ends by itself.
function runTrack(track, cap, onFirst, onEnd) {
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  let alive = true, first = true;
  cap.stop = () => { alive = false; track.stop(); try { reader.cancel(); } catch (_) {} };
  (async () => {
    try {
      while (alive) {
        const { value, done } = await reader.read();
        if (done) break;
        if (first && onFirst) { first = false; if (!onFirst()) { value.close(); continue; } }
        if (alive) encodeFrame(value); else value.close();
      }
    } catch (err) {
      act('log', { text: 'capture stopped ' + ((err && err.message) || err || 'unknown') });
    }
    if (alive && onEnd) onEnd();
  })();
}
// 1-1 rungs above 640 px and group layers above 640 px are cut from a 1280x720 capture.
function wantBigCapture() {
  return !!(cameraEncode && (cameraEncode.width > 640 || cameraEncode.captureBig));
}
async function startLocal() {
  if (local) return;
  local = { kind: 'camera', stop: () => {} };
  const mine = local;
  try {
    // Capture at the size the 1-1 path already used. The group layer is
    // scaled in the canvas; ideal 480x240 froze the camera on this PC.
    // A group layer larger than 640 px (720x360 by default) is cut from a 1280x720
    // capture, so it keeps its detail; 1-1 stays at 640x360.
    const big = wantBigCapture();
    mine.big = big;
    const fps = cameraEncode && cameraEncode.fps > 0 ? cameraEncode.fps : PROFILES.camera.fps;
    const want = { width: { ideal: big ? 1280 : 640 }, height: { ideal: big ? 720 : 360 }, frameRate: { ideal: Math.max(fps, PROFILES.camera.fps) } };
    const camId = await chosenCamera();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: camId ? Object.assign({ deviceId: { exact: camId } }, want) : want, audio: false }); }
    catch (e) { if (!camId) throw e; stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false }); }
    if (local !== mine) { stream.getTracks().forEach((t) => t.stop()); return; }
    const track = stream.getVideoTracks()[0];
    const st = (track.getSettings && track.getSettings()) || {};
    curCamId = st.deviceId || '';
    capFps = st.frameRate > 0 ? Math.round(st.frameRate) : 0;
    act('log', { text: 'camera capture ' + st.width + 'x' + st.height + '@' + st.frameRate + ' (asked ' + want.width.ideal + 'x' + want.height.ideal + '@' + want.frameRate.ideal + ')' });
    runTrack(track, local);
    act('camera', { on: true });
  } catch (e) {
    if (!TEST_PATTERN) { noCamera = true; camOn = false; local = null; act('camera', { on: false }); render(); return; }
    // No camera: a moving test pattern (ZCALL_TEST_VIDEO=1).
    const c = new OffscreenCanvas(360, 640); const g2 = c.getContext('2d'); let i = 0;
    capFps = PROFILES.camera.fps;
    const timer = setInterval(() => {
      i++;
      g2.fillStyle = 'hsl(' + (i * 4 % 360) + ',70%,45%)'; g2.fillRect(0, 0, 360, 640);
      g2.fillStyle = '#fff'; g2.font = 'bold 44px sans-serif'; g2.textAlign = 'center';
      g2.fillText('Zalo Linux', 180, 280); g2.fillText(new Date().toLocaleTimeString(), 180, 350);
      g2.beginPath(); g2.arc(180 + 120 * Math.sin(i / 10), 480, 30, 0, 7); g2.fill();
      encodeFrame(new VideoFrame(c, { timestamp: i * 66666 }));
    }, 1000 / PROFILES.camera.fps);
    local.stop = () => clearInterval(timer);
    act('camera', { on: true });
  }
}
// Our screen in place of the camera. On Wayland the desktop's portal asks
// which screen only once the capture runs. GNOME denies the portal's dialog
// the focus and puts it right under the focused window: with this window
// minimized that was Zalo's main window, which hid the dialog. So the window
// goes compact in the screen's corner and keeps the focus: the dialog comes
// right under it, above Zalo's main window. The camera stays on until the first screen frame;
// cancelling, or 60 s without a pick, gives up. Stopping it from the
// desktop's indicator ends the share.
// A failure within 3 s of the click is not the user cancelling: the first
// capture after a launch sometimes fails at once, the second works. So
// that one is retried, once. While sharing, the window is compact.
let pendingScreen = null;
async function startScreen(attempt = 1) {
  if (sharing || (pendingScreen && attempt === 1)) return;
  const cap = pendingScreen = { kind: 'screen', stop: () => {} };
  const t0 = performance.now();
  const giveUp = (why) => {
    if (pendingScreen !== cap) return;
    pendingScreen = null;
    cap.stop();
    act('log', { text: 'screen share attempt ' + attempt + ': ' + why });
    if (attempt === 1 && why !== 'timeout' && performance.now() - t0 < 3000 && state.phase === 'connected') {
      setTimeout(() => startScreen(2), 300);
      return;
    }
    if (autoCompact) { autoCompact = false; ipcRenderer.send('zcall-ui-window', 'expand'); }
  };
  if (attempt === 1 && !compactMode) { autoCompact = true; ipcRenderer.send('zcall-ui-window', 'compact'); }
  let stream;
  try {
    const id = await ipcRenderer.invoke('zcall-ui-screen-source');
    if (!id) throw new Error('no screen source');
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: PROFILES.screen.fps } } });
  } catch (e) {
    giveUp((e && e.name) + ': ' + (e && e.message)); // cancelled in the portal, or no capture
    return;
  }
  if (pendingScreen !== cap || state.phase !== 'connected') { stream.getTracks().forEach((t) => t.stop()); giveUp('call over'); return; }
  const track = stream.getVideoTracks()[0];
  setTimeout(() => giveUp('timeout'), 60000);
  runTrack(track, cap, () => {
    if (pendingScreen !== cap || state.phase !== 'connected') { giveUp('call over'); return false; }
    pendingScreen = null;
    act('log', { text: 'screen share started (attempt ' + attempt + ')' });
    if (!compactMode) { autoCompact = true; ipcRenderer.send('zcall-ui-window', 'compact'); }
    stopLocal(); // the camera
    sharing = true;
    forceKey = true;
    local = cap;
    act('screen', { on: true });
    act('camera', { on: true }); // the phone shows our video only while it thinks the camera is on
    render();
    return true;
  }, () => { if (local === cap) stopScreen(); else giveUp('ended before a frame'); });
}
function stopScreen() {
  if (!sharing) return;
  sharing = false;
  if (autoCompact) { autoCompact = false; ipcRenderer.send('zcall-ui-window', 'expand'); }
  stopLocal();
  act('screen', { on: false });
  if (camOn && state.phase === 'connected') startLocal(); else act('camera', { on: false });
  render();
}
function stopLocal() {
  if (local) { local.stop(); local = null; }
  dropHeld();
  curCamId = '';
  if (enc && enc.state !== 'closed') try { enc.close(); } catch (_) {}
  enc = null;
  encErrLogged = false;
  document.body.classList.remove('has-self');
}

// Received video: H.264 Annex-B frames decoded with WebCodecs, drawn on the canvas.
// 1-1 is one stream on #video. A group call is one decoder per member (src):
// two people sharing one decoder errors after a few frames and the last
// picture stays up.
const canvas = $('video'); const g = canvas.getContext('2d');
let dec = null, decCodec = null, ts = 0;
let decErrLogged = false, shown = 0, shownSince = 0, shownTotal = 0, rxBytes = 0;
const tiles = new Map();
// 1-1: the decoder broke (or a decode call threw): say so, and ask the phone for a key frame
// (the engine sends the PLI), instead of staying on the last picture until the next one.
function decoderBroke(why) {
  dec = null;
  if (!decErrLogged) { decErrLogged = true; act('log', { text: 'video decode: ' + why }); }
  act('needkey', { why: 'decoder' });
}
function stopVideo() {
  if (dec && dec.state !== 'closed') try { dec.close(); } catch (_) {}
  dec = null; decCodec = null;
  decErrLogged = false; shown = 0; shownSince = 0; shownTotal = 0;
  for (const t of tiles.values()) {
    if (t.dec && t.dec.state !== 'closed') try { t.dec.close(); } catch (_) {}
    if (t.ro) t.ro.disconnect();
    if (t.rt) clearTimeout(t.rt);
  }
  tiles.clear();
  document.body.classList.remove('has-video', 'has-tiles');
  placeSelf();
  $('stage').textContent = '';
}
function annexB(m) {
  const bin = atob(m.data); const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return data;
}
function newDecoder(codec) {
  if (dec && dec.state !== 'closed') try { dec.close(); } catch (_) {}
  decCodec = codec;
  dec = new VideoDecoder({
    output: (f) => {
      if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
        canvas.width = f.displayWidth; canvas.height = f.displayHeight;
        act('log', { text: 'video ' + f.displayWidth + 'x' + f.displayHeight });
      }
      g.drawImage(f, 0, 0);
      const now = Date.now(); shown++; shownTotal++;
      if (!shownSince) shownSince = now;
      if (now - shownSince >= 5000) {
        act('log', { text: 'video shown ' + (shown * 1000 / (now - shownSince)).toFixed(1) + ' fps, ' + f.displayWidth + 'x' + f.displayHeight + ', ' + shownTotal + ' frames, ' +
          Math.round(rxBytes * 8 / ((now - shownSince) / 1000) / 1000) + ' kbps in, decode queue ' + (dec ? dec.decodeQueueSize : '-') + ', shown at ' + canvas.clientWidth + 'x' + canvas.clientHeight + ' css px' });
        shown = 0; shownSince = now; rxBytes = 0;
      }
      f.close();
      if (!state.peerCamOff) document.body.classList.add('has-video');
    },
    error: (e) => decoderBroke((e && e.message) || String(e)), // the next key frame restarts it
  });
  // Software: the hardware path refuses these streams on this Electron.
  dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-software' });
}
function showMember(m) {
  let t = tiles.get(m.src);
  if (!t) {
    const c = document.createElement('canvas');
    const box = document.createElement('div');
    box.className = 'tile';
    box.appendChild(c);
    $('stage').appendChild(box);
    t = { box, canvas: c, g: c.getContext('2d'), dec: null, codec: null, ts: 0, errLogged: false, sentW: 0, ro: null, rt: 0 };
    tiles.set(m.src, t);
    // The engine asks the server for the layer that fits this tile (macOS does the same
    // from the tile's render width): tell it the width in pixels, and again when it changes.
    const src = m.src;
    const reportWidth = () => {
      t.rt = 0;
      const w = Math.round(c.getBoundingClientRect().width * (window.devicePixelRatio || 1));
      if (w > 0 && w !== t.sentW) { t.sentW = w; act('tile', { src, width: w }); }
    };
    t.ro = new ResizeObserver(() => { if (!t.rt) t.rt = setTimeout(reportWidth, 300); });
    t.ro.observe(c);
    document.body.classList.add('has-video', 'has-tiles');
    placeSelf();
  }
  if (m.key && (!t.dec || t.dec.state === 'closed' || m.codec !== t.codec)) {
    if (t.dec && t.dec.state !== 'closed') try { t.dec.close(); } catch (_) {}
    t.codec = m.codec;
    const src = m.src;
    t.dec = new VideoDecoder({
      output: (f) => {
        if (t.canvas.width !== f.displayWidth || t.canvas.height !== f.displayHeight) {
          t.canvas.width = f.displayWidth; t.canvas.height = f.displayHeight;
          act('log', { text: 'video ' + src + ' ' + f.displayWidth + 'x' + f.displayHeight + ' (tile ' + t.sentW + ' px)' });
        }
        t.g.drawImage(f, 0, 0);
        const now = Date.now(); t.shown = (t.shown || 0) + 1;
        if (!t.shownSince) t.shownSince = now;
        if (now - t.shownSince >= 5000) {
          act('log', { text: 'video shown ' + src + ' ' + (t.shown * 1000 / (now - t.shownSince)).toFixed(1) + ' fps, ' + f.displayWidth + 'x' + f.displayHeight +
            ', ' + Math.round((t.rxBytes || 0) * 8 / ((now - t.shownSince) / 1000) / 1000) + ' kbps in, tile ' + t.sentW + ' px' });
          t.shown = 0; t.shownSince = now; t.rxBytes = 0;
        }
        f.close();
        document.body.classList.add('has-video', 'has-tiles');
      },
      error: (e) => {
        t.dec = null;
        if (!t.errLogged) { t.errLogged = true; act('log', { text: 'video decode ' + src + ': ' + (e && e.message ? e.message : e) }); }
      },
    });
    t.dec.configure({ codec: m.codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-software' });
  }
  t.rxBytes = (t.rxBytes || 0) + Math.floor(m.data.length * 3 / 4);
  if (!t.dec || t.dec.state !== 'configured') return;
  try { t.dec.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: t.ts += 66666, data: annexB(m) })); }
  catch (e) {
    t.dec = null;
    if (!t.errLogged) { t.errLogged = true; act('log', { text: 'video decode ' + m.src + ': ' + (e && e.message ? e.message : e) }); }
  }
}
ipcRenderer.on('zcall-ui-video', (_e, m) => {
  if (state.phase !== 'connected') return;
  if (m.src) { showMember(m); return; }
  rxBytes += Math.floor(m.data.length * 3 / 4);
  if (m.key && (!dec || dec.state === 'closed' || m.codec !== decCodec)) newDecoder(m.codec);
  if (!dec || dec.state !== 'configured') return;
  try { dec.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: ts += 66666, data: annexB(m) })); } catch (e) { decoderBroke((e && e.message) || String(e)); }
});
ipcRenderer.on('zcall-ui-keyframe', () => { forceKey = true; });

// --- device menu (▲ on the pills, the gear): micro and speakers from PipeWire, cameras from Chromium ---
const menu = $('menu');
ipcRenderer.invoke('zcall-ui-devices').then((d) => { camPref = d.prefs.camera || null; }).catch(() => {});
async function cameras() {
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ id: d.deviceId, label: d.label || ('Camera ' + (i + 1)) }));
}
// The saved camera if it is plugged in (ids can change: fall back to the name).
async function chosenCamera() {
  if (!camPref) return null;
  const cams = await cameras();
  const m = cams.find((c) => c.id === camPref.id) || cams.find((c) => camPref.label && c.label === camPref.label);
  return m ? m.id : null;
}
function closeMenu() {
  menu.classList.remove('show'); menu.textContent = ''; menu.dataset.kind = '';
  document.querySelectorAll('.caret.open').forEach((b) => b.classList.remove('open'));
}
// Sections: mic -> micro + loa (as Zalo's micro menu), camera -> camera, all (gear) -> the three.
async function sections(kind) {
  const out = [];
  if (kind === 'mic' || kind === 'all') {
    const d = await ipcRenderer.invoke('zcall-ui-devices');
    for (const k of ['mic', 'speaker']) {
      const list = k === 'mic' ? d.mics : d.speakers;
      out.push({
        kind: k, title: k === 'mic' ? 'Chọn micro' : 'Chọn loa', icon: k === 'mic' ? 'menuMic' : 'menuSpeaker',
        items: list.concat([{ id: '', label: 'Thiết bị mặc định' }]),
        current: list.some((x) => x.id === d.prefs[k]) ? d.prefs[k] : '',
      });
    }
  }
  if (kind === 'camera' || (kind === 'all' && state.video)) {
    const items = await cameras();
    out.push({ kind: 'camera', title: 'Chọn camera', icon: 'camDisabled', items, current: curCamId || (await chosenCamera()) || (items[0] && items[0].id) });
  }
  return out;
}
async function openMenu(kind, anchor) {
  if (menu.dataset.kind === kind) { closeMenu(); return; }
  const secs = await sections(kind);
  menu.textContent = '';
  secs.forEach((sec, i) => {
    if (i) { const l = document.createElement('div'); l.className = 'sep'; menu.appendChild(l); }
    const h = document.createElement('div'); h.className = 'h';
    const hi = document.createElement('img'); setIcon(hi, sec.icon);
    h.append(hi, sec.title); menu.appendChild(h);
    if (!sec.items.length) { const r = document.createElement('div'); r.className = 'h'; r.textContent = 'Không tìm thấy thiết bị'; menu.appendChild(r); }
    for (const it of sec.items) {
      const r = document.createElement('div'); r.className = 'it'; r.title = it.label;
      if (it.id === sec.current) { const ck = document.createElement('img'); setIcon(ck, 'check'); r.appendChild(ck); }
      r.append(it.label);
      r.onclick = (e) => { e.stopPropagation(); closeMenu(); pick(sec.kind, it); };
      menu.appendChild(r);
    }
  });
  // Right edge 19 past the pill (as measured on Zalo's micro menu), inside the window.
  const r = anchor.getBoundingClientRect();
  const right = Math.min(window.innerWidth - 8, Math.max(318, r.right + 19));
  menu.style.left = (right - 310) + 'px';
  menu.dataset.kind = kind;
  menu.classList.add('show');
  document.querySelectorAll('.caret').forEach((b) => b.classList.toggle('open', b.dataset.kind === kind));
}
function pick(kind, it) {
  act('device', { kind, id: it.id, label: it.label });
  if (kind !== 'camera') return;
  camPref = { id: it.id, label: it.label };
  if (local && local.kind === 'camera' && it.id !== curCamId) { stopLocal(); startLocal(); }
}
document.querySelectorAll('.caret').forEach((b) => {
  b.onclick = (e) => { e.stopPropagation(); if (!b.disabled) openMenu(b.dataset.kind, b.parentElement).catch(closeMenu); };
});
$('settings').onclick = (e) => { e.stopPropagation(); openMenu('all', $('settings')).catch(closeMenu); };
document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu.dataset.kind) closeMenu();
  else if (e.key === 'Escape' && fullScreen) ipcRenderer.send('zcall-ui-window', 'leave-fullscreen');
  else if (e.key === 'F11') { e.preventDefault(); toggleFull(); }
});
render();
