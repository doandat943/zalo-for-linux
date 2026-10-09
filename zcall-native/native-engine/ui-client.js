'use strict';
// Call window drawn by Zalo-Linux itself (plugins/zcall-native-ui): the
// engine sends the call state over a loopback socket and gets the user's
// clicks back. Zalo-Linux passes the socket in ZCALL_UI_PORT / ZCALL_UI_TOKEN;
// without them (engine run on its own) the zenity window is used instead.
//
// Protocol: one JSON object per line.
//   engine -> ui  {type:"state", phase, name, avatar, text, since, video, muted, speakerOff, peerCamOff, peerMuted, peerSharing, cameraEncode?, members?}
//                 {type:"keyframe"}                    encode the next camera frame as a key frame
//                 {type:"speaking", src, on}           group: member src is talking (or stopped)
//                 {type:"close", text}
//   ui -> engine  {action:"hangup"|"accept"|"reject"|"mute"|"speaker"|"camera", on?}
//                 {action:"videoFrame", key, data, screen, w, h}   our camera or screen, H.264 Annex-B (base64)
//                 {action:"device", kind:"mic"|"speaker", id}   PulseAudio source / sink ("" = default)
//                 {action:"screen", on}               our screen replaces the camera
//                 {action:"log", text}                a line for the engine log
//                 {action:"tile", src, width}        group: a member's tile is this wide (pixels)
//                 {action:"needkey", why}            the decoder broke: PLI to the phone

const net = require('net');
const { CallWindow } = require('./call-window');

class ElectronCallUi {
  constructor({ port, token, log = () => {} }) {
    this.log = log;
    this.cb = { hangup: () => {}, mute: () => {}, speaker: () => {}, videoFrame: () => {}, camera: () => {}, device: () => {}, screen: () => {} };
    this.incomingCb = null;
    this.state = null;
    this.fallback = null;
    this.buf = '';
    this.sock = net.connect({ host: '127.0.0.1', port }, () => this.sock.write(token + '\n'));
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('error', (e) => { this.log('call ui:', e.message); this._useFallback(); });
    this.sock.on('close', () => this._useFallback());
  }

  onHangup(cb) { this.cb.hangup = cb; if (this.fallback) this.fallback.onHangup(cb); }
  onMute(cb) { this.cb.mute = cb; }
  onSpeaker(cb) { this.cb.speaker = cb; }
  onVideoFrame(cb) { this.cb.videoFrame = cb; }
  onCamera(cb) { this.cb.camera = cb; }
  onDevice(cb) { this.cb.device = cb; }
  onScreen(cb) { this.cb.screen = cb; }
  onNeedKey(cb) { this.cb.needKey = cb; }
  onTile(cb) { this.cb.tile = cb; }

  open({ title, text, avatar, video = false }) {
    this.incomingCb = null;
    this._state({ phase: 'outgoing', name: title, avatar, text, since: 0, video, muted: false, speakerOff: false });
  }

  // noAnswer: only a dismiss button (a call we cannot take).
  incoming({ title, text, avatar, video = false, noAnswer = false, inviter = '' }, onAccept, onReject) {
    this.incomingCb = { onAccept, onReject };
    this._state({ phase: 'incoming', name: title, avatar, text, since: 0, video, muted: false, speakerOff: false, noAnswer, inviter });
    if (this.fallback) this._fallbackIncoming();
  }

  _fallbackIncoming() {
    const s = this.state;
    this.fallback.incoming({ title: s.name, text: s.text },
      () => this._onAction({ action: 'accept' }), (why) => this._onAction({ action: 'reject', why }));
  }

  status(text, since = 0) {
    if (!this.state) return;
    this._state({ ...this.state, phase: since ? 'connected' : this.state.phase === 'incoming' ? 'connecting' : this.state.phase, text, since });
  }

  // The peer turned its camera / mic off or on.
  peer({ camOff, muted, sharing }) {
    if (!this.state) return;
    this._state({ ...this.state, peerCamOff: !!camOff, peerMuted: !!muted, peerSharing: !!sharing });
  }

  // Group camera: exact width, height, bitrate (bps), fps, keyMs from layer 0.
  setCameraEncode(profile) {
    if (!this.state || !profile) return;
    this._state({ ...this.state, cameraEncode: profile });
  }

  // Group screen share: the shorter side at most maxShort px, bitrate bps.
  setScreenEncode(profile) {
    if (!this.state || !profile) return;
    this._state({ ...this.state, screenEncode: profile });
  }

  requestKeyFrame() {
    this._send({ type: 'keyframe' });
  }

  // Group: the members (src = UID, name, avatar, muted, camOff, state) for the tiles.
  members(list) {
    if (!this.state) return;
    this._state({ ...this.state, members: list });
  }

  // Group: member src started / stopped talking (tile border, speaker layout).
  speaking(src, on) {
    this._send({ type: 'speaking', src, on: !!on });
  }

  // One received video frame (H.264 Annex-B): the window decodes and shows it.
  // src: the member (group calls, one tile each); absent in 1-1 calls.
  video({ key, codec, data, src }) {
    this._send({ type: 'video', key, codec, data: data.toString('base64'), src });
  }

  close(text) {
    this.incomingCb = null;
    this.state = null;
    this._send({ type: 'close', text: text || '' });
    if (this.fallback) this.fallback.close(text);
  }

  _state(s) {
    this.state = s;
    this._send({ type: 'state', ...s });
    if (this.fallback) {
      if (s.phase === 'outgoing') this.fallback.open({ title: s.name, text: s.text });
      else if (s.phase !== 'incoming') this.fallback.status(s.text, s.since);
    }
  }

  _send(msg) {
    if (this.fallback || this.sock.destroyed) return;
    try { this.sock.write(JSON.stringify(msg) + '\n'); } catch (_) {}
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      this._onAction(m);
    }
  }

  _onAction(m) {
    switch (m.action) {
      case 'accept':
        if (this.incomingCb) { const c = this.incomingCb; this.incomingCb = null; c.onAccept(); }
        return;
      case 'reject':
        if (this.incomingCb) { const c = this.incomingCb; this.incomingCb = null; c.onReject(m.why || 'reject'); }
        return;
      case 'hangup':
        if (this.incomingCb) { const c = this.incomingCb; this.incomingCb = null; c.onReject('reject'); return; }
        this.cb.hangup();
        return;
      case 'videoFrame':
        if (typeof m.data === 'string') this.cb.videoFrame({ key: !!m.key, data: Buffer.from(m.data, 'base64'), screen: !!m.screen, w: m.w | 0, h: m.h | 0 });
        return;
      case 'camera':
        this.cb.camera(!!m.on);
        return;
      case 'screen':
        this.cb.screen(!!m.on);
        return;
      case 'tile': // group: the window drew the tile of member src at this many pixels wide
        if (this.cb.tile) this.cb.tile(Number(m.src) >>> 0, Number(m.width) || 0);
        return;
      case 'needkey': // the window's decoder gave up: ask the phone for a key frame
        if (this.cb.needKey) this.cb.needKey(String(m.why || 'decoder').slice(0, 40));
        return;
      case 'log':
        this.log('window:', String(m.text || '').slice(0, 300));
        return;
      case 'device':
        if (m.kind === 'mic' || m.kind === 'speaker') this.cb.device(m.kind, typeof m.id === 'string' ? m.id : '');
        return;
      case 'mute':
        if (this.state) this.state = { ...this.state, muted: !!m.on };
        this.cb.mute(!!m.on);
        return;
      case 'speaker':
        if (this.state) this.state = { ...this.state, speakerOff: !!m.on };
        this.cb.speaker(!!m.on);
        return;
      default:
        this.log('call ui: unknown action', m.action);
    }
  }

  // The UI socket is gone (Zalo-Linux without the plugin, or it closed):
  // carry on with zenity, re-showing the current state there.
  _useFallback() {
    if (this.fallback) return;
    this.fallback = new CallWindow(this.log);
    this.fallback.onHangup(this.cb.hangup);
    const s = this.state;
    if (!s) return;
    if (s.phase === 'incoming' && this.incomingCb) {
      this._fallbackIncoming();
    } else {
      this.fallback.open({ title: s.name, text: s.text });
      if (s.since) this.fallback.status(s.text, s.since);
    }
  }
}

// The call window to use: Zalo-Linux's own when it offers one, else zenity.
function createCallUi(log) {
  const port = Number(process.env.ZCALL_UI_PORT);
  const token = process.env.ZCALL_UI_TOKEN;
  if (port && token) return new ElectronCallUi({ port, token, log });
  return new CallWindow(log);
}

module.exports = { ElectronCallUi, createCallUi };
