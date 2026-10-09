'use strict';
// Control-plane of a native Linux call engine.
//
// Reproduces what ZaloCall does at the IPC boundary with Zalo's Electron main
// process (call-v2): it consumes the zalo->engine frames and produces the
// engine->zalo frames, with the field layout the real engine uses (captures
// 2026-09-29, see docs/REPORT.md). The MediaBackend (backends/zrtc-media.js)
// carries the audio.
//
// Outgoing call, as the real engine does it:
//   makeCall        -> callState incall, show, sendSignal 401 {callId (ours), calleeId, codec "[]\n", type}
//   recvSignal 401  -> media.prepare(): InitZRTP to every server
//                   -> sendSignal 416 {codec, extendData, rtcpAddress, rtpAddress, session}
//   control answer  -> media.start(params.rtpSerIp), sendSignal 408
//   hang up         -> sendSignal 409 (connected) or 405 (not answered),
//                      bubble, sendSignal 406 (stats), callState free
// Incoming call (capture 2026-09-30):
//   control request -> callState incall, getAliasName, sendSignal 407 {callId, callerId}
//   answer          -> action 5, sendSignal 402 {status 0, extendData, caller's server, session},
//                      InitZRTP cmd 12 to that one server, media
//   reject          -> action 8, sendSignal 402 {status 3, empty}, bubble, 406 status 160
//   control end_call (peer hung up) -> showNotification partner_endcall, bubble, 406
// 406 status: 50 connected call, 103 caller cancelled, 160 callee rejected.
// Hanging up is the engine's job: the real engine's call window (Qt) owns the
// end button, so every 409/405 in the captures comes from the engine. Here
// the `ui` object (call-window.js) plays that role.

const { VideoAssembler, avcCodecString } = require('./video');

// A group ping error ends the call only after this long without media.
const GROUP_MEDIA_IDLE_MS = 10000;

const CODEC = '[{"dynamicFptime":0,"frmPtime":20,"name":"opus/16000/1","payload":112}]\n';

// JsonCpp writes keys sorted and ends with a newline; mirror that.
function jsonCpp(v) {
  const sort = (x) => (Array.isArray(x) ? x.map(sort)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return JSON.stringify(sort(v)) + '\n';
}

// callId must fit a signed 32-bit int: the server answers requestcall,
// cancel and logendcall with error 114 ("invalid parameters") for callIds
// above 2^31 - 1 (live test 2026-09-30). The real engine's are ~1.83e9.
function newCallId() {
  return 1000000000 + Math.floor(Math.random() * (0x7fffffff - 1000000000));
}

function parseMaybeJson(s) {
  if (typeof s !== 'string') return s || {};
  try { return JSON.parse(s); } catch (_) { return {}; }
}

class MediaBackend {
  onNegotiated(_params) {}
  prepare(_role) { return Promise.resolve(null); }
  start(_role, _rtpSerIp) {}
  stop() {}
  setMute(_on) {}
  stats() { return null; }
  on() { return this; }
}

const noUi = { open() {}, status() {}, close() {}, onHangup() {}, incoming() {} };

class EngineCore {
  // emit(frame) sends one engine->zalo frame: { type, command, data }.
  // group: group calls (zcall-native.js: on unless ZCALL_GROUP=0); otherwise
  // the call window says they are not supported.
  constructor({ emit, media = new MediaBackend(), log = () => {}, ui = noUi, group = false }) {
    this.emit = emit;
    this.groupEnabled = !!group;
    this.media = media;
    this.log = log;
    this.ui = ui;
    this.call = null;
    this.local = {};
    this.ui.onHangup(() => this.hangup('local'));
    if (typeof this.ui.onMute === 'function') {
      this.ui.onMute((on) => {
        // A dead audio process must not swallow the signal: the phone learns
        // the mute from 12098, not from the silence alone.
        try { this.media.setMute(on); } catch (e) { this.log('mute:', e.message); }
        if (this.call) this.call.muted = !!on; // handed to the media of this call (onNegotiated)
        if (this.call && this.call.group) {
          this.log('group mute', on ? 'on' : 'off');
          this._groupBroadcast();
        } else this._micState(!on);
      });
    }
    // Device picked in the call window (or the saved choice, sent when the window connects).
    if (typeof this.ui.onDevice === 'function') {
      this.ui.onDevice((kind, name) => { if (this.media.setDevice) this.media.setDevice(kind, name); });
    }
    if (typeof this.ui.onSpeaker === 'function') {
      this.ui.onSpeaker((on) => {
        if (this.call) this.call.speakerOff = !!on;
        if (this.media.setSpeaker) this.media.setSpeaker(on);
      });
    }
    // Our camera, encoded by the call window (H.264 Annex-B frames).
    if (typeof this.ui.onVideoFrame === 'function') {
      this.ui.onVideoFrame((f) => { if (this.call && this.call.state === 'connected' && this.media.sendVideoFrame) this.media.sendVideoFrame(f); });
    }
    if (typeof this.ui.onCamera === 'function') this.ui.onCamera((on) => this._camMic(on));
    if (typeof this.ui.onScreen === 'function') this.ui.onScreen((on) => this._screenShare(on));
    if (typeof this.ui.onTile === 'function') this.ui.onTile((src, width) => { if (this.call && this.call.group && this.media.setMemberRenderWidth) this.media.setMemberRenderWidth(src, width); });
    if (typeof this.ui.onNeedKey === 'function') this.ui.onNeedKey((why) => this._askPeerKey('window ' + why));
    if (typeof media.on === 'function') {
      media.on('timeout', () => this.hangup('media-timeout'));
      media.on('failed', (why) => this.hangup(`media-${why}`));
      media.on('peerEnd', (why) => (this.call && this.call.group ? this._groupEnded(why || 'server') : this._peerEnded('server')));
      media.on('roster', (uids) => this._groupRoster(uids));
      media.on('memberLeft', (uid) => this._groupMemberLeft(uid, 'server'));
      media.on('memberAudio', (uid) => this._groupMemberIn(uid));
      media.on('video', (pkt) => this._onVideoPacket(pkt));
      media.on('keyframe', (why) => this._requestKeyFrame(why));
      // 1-1: the rung of the server's ladder our camera is encoded at (send-rate.js).
      media.on('sendProfile', (p) => {
        if (this.call && !this.call.group && this.ui.setCameraEncode) this.ui.setCameraEncode(p);
      });
    }
  }

  start() {
    this.emit({ type: 'update', command: 'native-ready', data: {} });
  }

  onZaloFrame(f) {
    if (!f || typeof f !== 'object') return;
    const data = f.data && typeof f.data === 'object' ? f.data : {};
    switch (f.type) {
      case 'update': return this._onUpdate(f.command, data);
      case 'request': return this._onRequest(f.command, data);
      case 'control': return this._onControl(data.act, data);
      case 'recvSignal': return this._onRecvSignal(f.command, data);
      case 'response': return; // answers to our requests (getAliasName, ...): nothing to do
      default: this.log('unhandled type', f.type, f.command);
    }
  }

  _onUpdate(command, data) {
    // init / updateLocal / updateLang / advancedOptions: local config, no reply.
    if ((command === 'init' || command === 'updateLocal') && data.local) this.local = { ...this.local, ...data.local };
  }

  _onRequest(command, data) {
    switch (command) {
      case 'makeCall': return this._makeCall(data);
      case 'endCall': return this.hangup('zalo');
      case 'listDevice':
        this.emit({ type: 'response', command: 'listDevice', data: { audioIn: [], audioOut: [], video: [] } });
        return;
      case 'ping':
      case 'hide':
        return;
      default:
        this.log('unhandled request', command);
    }
  }

  _makeCall(data) {
    if (this.call) { this.log('makeCall while in a call; ignored'); return; }
    // type 1 voice, 3 video; 5 / 6 the same for a group (with groupInfo).
    if (data.type === 5 || data.type === 6 || data.groupInfo) {
      const g = data.groupInfo || {};
      if (this.groupEnabled) { this._groupOutgoing(data); return; }
      this.emit({ type: 'response', command: 'show', data: { error: 0, extendData: 'success' } });
      this.emit({ type: 'update', command: 'callState', data: { state: 'free' } });
      this._groupNotSupported(g.name || g.groupName || 'Gọi nhóm', g.avatar || '');
      return;
    }
    const partner = (data.partner && data.partner[0]) || {};
    this.call = {
      role: 'caller',
      peerId: String(partner.id || ''),
      peerName: partner.name || '',
      avatar: partner.avatar || '',
      type: data.type,
      callId: newCallId(),
      state: 'calling',
      startedAt: 0,
    };
    const c = this.call;
    this.emit({ type: 'update', command: 'callState', data: { state: 'incall' } });
    this.emit({ type: 'response', command: 'show', data: { error: 0, extendData: 'success' } });
    this.emit({ type: 'sendSignal', command: 401, data: { callId: c.callId, calleeId: c.peerId, codec: '[]\n', type: c.type } });
    if (c.type === 3) this._camMic();
    this.ui.open({ title: c.peerName || 'Zalo', text: 'Đang gọi…', avatar: c.avatar, video: c.type === 3 });
  }

  // Our screen replaces the camera in the video stream. A 1-1 call tells the
  // phone with 12064 (/api/voicecall/requestsharescreen {uidTo, callId, status}).
  // A group call uses 12044 (/api/voicecall/group/sharescreen). status 1 starts
  // and 0 stops (ZSharedWindowsManager::coreDoShare / coreStopShare). The
  // server answers with shareScreenId; that id is what the follow-up carries
  // (onRequestComplete stores response+0x8, then coreDoShare sends 12044).
  _screenShare(on) {
    const c = this.call;
    if (!c || c.state !== 'connected') return;
    c.sharing = !!on;
    this.log('screen share', on ? 'on' : 'off');
    if (c.group) {
      // The screen's own peer (UID = shareScreenId) once the server gave the id.
      if (!on && this.media.stopShare) this.media.stopShare();
      if (on && c.shareScreenId > 0 && this.media.startShare) this.media.startShare(c.shareScreenId);
      const st = this._groupState(c);
      this.emit({
        type: 'sendSignal',
        command: 12044,
        data: {
          audioState: st.audioState,
          callId: c.callId,
          data: jsonCpp({ shareScreenId: c.shareScreenId || 0 }),
          hostCall: c.hostCall,
          status: on ? 1 : 0,
          userId: c.localUid,
          videoState: st.videoState,
        },
      });
      return;
    }
    this.emit({ type: 'sendSignal', command: 12064, data: { callId: c.callId, status: on ? 1 : 0, uidTo: c.peerId } });
  }

  // Group calls are not implemented (separate SFU signalling and media).
  // Ours: say so in the call window for a few seconds instead of calling anyone.
  _groupNotSupported(title, avatar) {
    const text = 'Gọi nhóm chưa được hỗ trợ trên Linux';
    this.log('group call: not supported');
    this.ui.open({ title, text, avatar });
    setTimeout(() => { if (!this.call) this.ui.close(text); }, 3000).unref();
  }

  // Someone else's (control group_request): show it like an incoming call,
  // with only a dismiss button, for up to 45 s. A 1-1 call takes over.
  _incomingGroup(d) {
    this.log('incoming group call', d.id, '(not supported)');
    if (this.call) return;
    const notice = this.groupNotice = {};
    const dismiss = () => {
      if (this.groupNotice !== notice) return;
      this.groupNotice = null;
      if (!this.call) this.ui.close('Đã bỏ qua cuộc gọi nhóm');
    };
    this.ui.incoming({
      title: d.groupName || 'Cuộc gọi nhóm',
      text: `${d.Dname || 'Ai đó'} đang gọi nhóm. Gọi nhóm chưa được hỗ trợ trên Linux.`,
      avatar: d.groupAvatar || d.avatar || '',
      noAnswer: true,
    }, dismiss, dismiss);
    setTimeout(dismiss, 45000).unref();
  }

  // Camera / mic state (12006 -> /api/voicecall/conf, the phone gets it as
  // onoff_camera / mute_audio); -1 leaves a field unchanged. Without a camera
  // the real engine sends isOnCam 0, isOnMic -1; the call window reports ours
  // when it starts. A group call does not use 12006: UiOnOffCameraEvent only
  // sendBroadcast, and the wire videoState is the inverse of "camera on".
  _camMic(camOn) {
    const c = this.call;
    if (!c) return;
    const cam = camOn === undefined ? 0 : camOn ? 1 : 0;
    if (c.group) {
      c.cameraOn = cam === 1;
      if (this.media.setGroupCamera) this.media.setGroupCamera(cam === 1);
      this.log('group camera', c.cameraOn ? 'on' : 'off');
      if (c.state === 'connected') this._groupBroadcast();
      return;
    }
    this.emit({ type: 'sendSignal', command: 12006, data: { callId: c.callId, calleeId: c.peerId, data: '', isOnCam: cam, isOnMic: -1 } });
  }

  // Despite its name, isOnMic is a mute flag for the phone: 1 shows our mic
  // as off, 0 clears it (live test 2026-10-01).
  _micState(micOn) {
    const c = this.call;
    if (!c || c.state !== 'connected') return;
    this.emit({ type: 'sendSignal', command: 12006, data: { callId: c.callId, calleeId: c.peerId, data: '', isOnCam: -1, isOnMic: micOn ? 0 : 1 } });
  }

  _onControl(act, data) {
    const c = this.call;
    const d = data.data || {};
    if (typeof act === 'string' && act.startsWith('group_')) {
      if (this.groupEnabled) this._onGroupControl(act, d);
      else if (act === 'group_request') this._incomingGroup(d);
      return;
    }
    switch (act) {
      case 'request': // incoming 1-1 call
        return this._incoming(d);
      case 'ring_ring':
        if (c && c.state === 'calling') { c.state = 'ringing'; this.ui.status('Đang đổ chuông…'); }
        return;
      case 'answer': {
        if (!c || c.role !== 'caller' || c.state === 'connected') return;
        const params = parseMaybeJson(d.params);
        // A declining phone also sends "answer", with status 3 and no
        // extendData (the same status our 402 uses to decline): no media.
        const status = Number(d.status || params.status || 0);
        if (status !== 0) {
          this.log('peer declined, answer status', status);
          this._finish(103, status === 3 ? 'Người nhận đã từ chối' : 'Không liên lạc được');
          return;
        }
        c.state = 'connected';
        c.startedAt = Date.now();
        this.media.start(c.role, params.rtpSerIp);
        this.emit({ type: 'sendSignal', command: 408, data: { callId: c.callId, calleeId: c.peerId } });
        if (c.type === 3) this._camMic();
        this.ui.status('Đã kết nối', c.startedAt);
        return;
      }
      case 'end_call':
      case 'cancel':
      case 'reject':
      case 'busy':
        if (c && d.callId && String(d.callId) !== String(c.callId)) return; // another call
        this._peerEnded(act);
        return;
      case 'answer_ack':
        return;
      // The peer's camera / mic (params.type; capture 2026-10-01):
      // onoff_camera 1 on, 0 off; mute_audio 1 muted, 0 not.
      // share_screen: assumed the same way (1 sharing, 0 not; not captured yet).
      case 'onoff_camera':
      case 'mute_audio':
      case 'share_screen': {
        if (!c || (d.callId && String(d.callId) !== String(c.callId))) return;
        const p = parseMaybeJson(d.params);
        const type = Number(p.type !== undefined ? p.type : p.status);
        if (act === 'onoff_camera') c.peerCamOff = type === 0;
        else if (act === 'mute_audio') c.peerMuted = type === 1;
        else { c.peerSharing = type === 1; this.log('peer share_screen', JSON.stringify(p)); }
        if (typeof this.ui.peer === 'function') this.ui.peer({ camOff: !!c.peerCamOff, muted: !!c.peerMuted, sharing: !!c.peerSharing });
        return;
      }
      default:
        this.log('unhandled control', act);
    }
  }

  _incoming(d) {
    if (this.call) { this.log('incoming call while in a call; ignored'); return; }
    this.groupNotice = null; // a group call notice gives way
    const params = parseMaybeJson(d.params);
    const ext = parseMaybeJson(params.extendData);
    const addr = (ext.serverAddr && ext.serverAddr[0]) || {};
    this.call = {
      role: 'callee',
      peerId: String(d.uidN || ''),       // caller's Zalo id (18-19 digits)
      peerUid: Number(d.uidFrom) || 0,    // caller's media UID (9 digits)
      localUid: Number(d.uidTo) || 0,
      peerName: params.Dname || '',
      avatar: params.avatar || '',
      type: ext.callType === 1 ? 3 : 1,
      callId: Number(d.callId),
      sessId: d.session || params.sessId,
      // The callee uses the caller's server (d.rtpAddress == extendData.serverAddr[0].rtp).
      server: { rtpaddr: d.rtpAddress, rtcpaddr: d.rtcpAddress, rtpIPv6: addr.rtpIPv6 || '', rtcpIPv6: addr.rtcpIPv6 || '' },
      config: params.zrtc_config || {},
      p2p: Array.isArray(ext.p2p) ? ext.p2p : [], // the caller's P2P candidates
      state: 'incoming',
      startedAt: 0,
    };
    const c = this.call;
    this.emit({ type: 'update', command: 'callState', data: { state: 'incall' } });
    this.emit({ type: 'request', command: 'getAliasName', data: { noisedId: c.peerId } });
    this.emit({ type: 'sendSignal', command: 407, data: { callId: c.callId, callerId: c.peerId } });
    const kind = c.type === 3 ? 'Cuộc gọi video đến' : 'Cuộc gọi thoại đến';
    this.ui.incoming({ title: c.peerName || 'Zalo', text: kind, avatar: c.avatar, video: c.type === 3 },
      () => this.answer(), (why) => this.reject(why));
  }

  // Callee picks up: InitZRTP to the caller's server first, so that 402 can
  // carry our P2P candidates (the phone ignores our P2P binding without them).
  answer() {
    const c = this.call;
    if (!c || c.role !== 'callee' || c.state !== 'incoming') return;
    c.state = 'connected';
    c.startedAt = Date.now();
    this.emit({ type: 'request', command: 'action', data: { id: 5 } });
    this.media.onNegotiated({
      muted: !!c.muted,
      speakerOff: !!c.speakerOff,
      servers: [c.server],
      config: c.config,
      srtpMode: c.config.srtpMode,
      sessId: c.sessId,
      callId: c.callId,
      role: c.role,
      localUid: c.localUid,
      peerUid: c.peerUid,
      p2pCandidates: c.p2p,
    });
    this.ui.status('Đang kết nối…');
    this.media.prepare('callee').then((best) => {
      if (this.call !== c || c.state === 'ended') return;
      const p2p = typeof this.media.localCandidates === 'function' ? this.media.localCandidates(best && best.publicAddr) : [];
      this.emit({
        type: 'sendSignal',
        command: 402,
        data: {
          callId: c.callId,
          callerId: c.peerId,
          codec: CODEC,
          extendData: jsonCpp(this._extendData(c, c.server, null, { numServers: 0, p2p, sP2P: 1, select2side: 1, supportCallBusy: 0 })),
          rtcpAddress: c.server.rtcpaddr,
          rtpAddress: c.server.rtpaddr,
          session: c.sessId,
          status: 0,
        },
      });
      if (!best && this.media.sendUdp) { this.ui.status('Không kết nối được máy chủ'); this.hangup('no-server'); return; }
      this.media.start('callee', c.server.rtpaddr);
      this.ui.status('Đã kết nối', c.startedAt);
    });
  }

  // Callee declines (button, or no answer before the window times out).
  reject(why = 'reject') {
    const c = this.call;
    if (!c || c.role !== 'callee' || c.state !== 'incoming') return;
    this.log('reject:', why);
    this.emit({ type: 'request', command: 'action', data: { id: 8 } });
    this.emit({
      type: 'sendSignal',
      command: 402,
      data: { callId: c.callId, callerId: c.peerId, codec: '[]\n', extendData: '{}\n', rtcpAddress: '', rtpAddress: '', session: c.sessId, status: 3 },
    });
    this._finish(160);
  }

  // The phone needs a key frame (start of our video, PLI / FIR): ask the
  // call window's encoder, at most every 500 ms.
  _requestKeyFrame(why) {
    const c = this.call;
    if (!c || c.state !== 'connected' || typeof this.ui.requestKeyFrame !== 'function') return;
    const now = Date.now();
    if (c.keyAskedAt && now - c.keyAskedAt < 500) return;
    c.keyAskedAt = now;
    if (why !== 'start') this.log('key frame requested:', why);
    this.ui.requestKeyFrame();
  }

  // The picture from the phone is damaged (a hole in the stream, a decoder error):
  // ask it for a key frame (RTCP PLI; the backend limits this to one a second).
  _askPeerKey(why) {
    const c = this.call;
    if (!c || c.state !== 'connected' || c.group || typeof this.media.requestPeerKeyFrame !== 'function') return;
    this.media.requestPeerKeyFrame(why);
  }

  // A line in the log every 5 s of video: frames handed to the window per second, key frames,
  // holes. This is what shows whether the phone really sends more after our feedback.
  _noteVideoRx(c) {
    const now = Date.now();
    const v = c.videoRx || (c.videoRx = { since: now, frames: 0, total: 0 });
    v.frames++; v.total++;
    if (now - v.since < 5000) return;
    const s = c.video.stats;
    this.log(`video rx: ${(v.frames * 1000 / (now - v.since)).toFixed(1)} fps, ${v.total} frames, ${s.keys} key, ${s.gaps} gaps, ${s.dropped} dropped`);
    v.since = now; v.frames = 0;
  }

  // Group: the same line per member. Frames the assembler made but could not hand on (no key frame with an
  // SPS yet) are counted in noCodec: when they grow and nothing shows, that is why.
  _noteMemberRx(v, uid) {
    const now = Date.now();
    if (!v.since) v.since = now;
    v.frames++;
    if (now - v.since < 5000) return;
    const s = v.asm.stats;
    // NAL bytes of the period by type (14/15/20: SVC units, dropped before decoding)
    // and the sizes of the last SPS / subset SPS: tells whether a bigger layer
    // is in the stream as SVC (and thrown away) or not sent at all.
    const nal = Object.entries(v.asm.nalBytes).map(([t, n]) => `${t}:${Math.round(n / 1024)}k`).join(' ');
    v.asm.nalBytes = {};
    const sps = v.asm.spsSize;
    this.log(`video rx member ${uid}: ${(v.frames * 1000 / (now - v.since)).toFixed(1)} fps, ${s.frames} frames, ${s.keys} key, ${s.gaps} gaps, ${s.dropped} dropped, ${v.noCodec} without codec; ` +
      `nal ${nal || '-'}; sps ${sps[7] || '-'}, subset sps ${sps[15] || '-'}` + (this.media && this.media.vidAsked ? `; asked quality 0x${(this.media.vidAsked.get(uid >>> 0) ?? 0xff).toString(16)}` : ''));
    v.since = now; v.frames = 0;
  }

  // Received video packets -> frames -> call window (decoded there with WebCodecs).
  _onVideoPacket(pkt) {
    const c = this.call;
    if (!c || c.state !== 'connected' || typeof this.ui.video !== 'function') return;
    if (c.group) {
      // One stream per member: the window shows one tile per src (UID).
      if (!c.videos) c.videos = new Map();
      let v = c.videos.get(pkt.ssrc);
      if (!v) {
        v = { codec: null, since: 0, frames: 0, noCodec: 0 };
        v.asm = new VideoAssembler((f) => {
          if (f.key) v.codec = avcCodecString(f.data) || v.codec;
          if (!v.codec) { v.noCodec++; return; }
          this._noteMemberRx(v, pkt.ssrc);
          this.ui.video({ key: f.key, codec: v.codec, data: f.data, src: pkt.ssrc });
        }, undefined, { group: true });
        c.videos.set(pkt.ssrc, v);
      }
      v.asm.push(pkt);
      return;
    }
    if (!c.video) {
      c.video = new VideoAssembler((f) => {
        if (f.key) c.videoCodec = avcCodecString(f.data) || c.videoCodec;
        this._noteVideoRx(c);
        this.ui.video({ key: f.key, codec: c.videoCodec || 'avc1.64001e', data: f.data });
      }, undefined, { onGap: () => this._askPeerKey('gap') });
    }
    c.video.push(pkt);
  }

  // The other side hung up, cancelled or declined.
  _peerEnded(why) {
    const c = this.call;
    if (!c || c.state === 'ended') return;
    this.log('peer ended:', why);
    if (c.state === 'connected') {
      this.emit({ type: 'request', command: 'showNotification', data: { isGroup: false, reason: 'partner_endcall', toUid: c.peerId, userId: c.peerId } });
    }
    this._finish(c.state === 'connected' ? 50 : 103);
  }

  _onRecvSignal(command, data) {
    const c = this.call;
    switch (String(command)) {
      case '401': // server's answer: media servers + zrtc_config + sessId
        if (!c || c.state !== 'calling') return;
        if (data.status || !Array.isArray(data.servers) || !data.servers.length) {
          this.log('recvSignal 401 without servers', data.status, data.msg);
          this.ui.status('Không gọi được');
          this._finish(103);
          return;
        }
        c.sessId = data.sessId;
        c.localUid = Number(data.fromId) || Number(this.local.id) || 0;
        this.media.onNegotiated({
          muted: !!c.muted,
          speakerOff: !!c.speakerOff,
          servers: data.servers,
          config: data.zrtc_config || {},
          srtpMode: data.zrtc_config && data.zrtc_config.srtpMode,
          sessId: data.sessId,
          callId: c.callId,
          role: c.role,
          localUid: c.localUid,
          // Media UIDs are the 9-digit numbers of 401 (fromId/toId), not the
          // 18-19 digit Zalo ids of makeCall.
          peerUid: Number(data.toId) || 0,
        });
        this.media.prepare(c.role).then((best) => {
          if (this.call !== c || c.state === 'ended') return;
          const chosen = best ? best.server.raw : data.servers[0];
          if (!best && this.media.sendUdp) { this.ui.status('Không kết nối được máy chủ'); this.hangup('no-server'); return; }
          this._send416(c, chosen, best && best.publicAddr);
        });
        return;
      // Zalo's answer to our group ping. An error ("uid invalid timestamp",
      // error -1) means our account is no longer in the call, e.g. it hung up
      // on another device: ZCallGroupInfo::receiveResponsePing ends the call
      // ("ping fail"). Live test 2026-10-01: started right after the phone,
      // on the same account, left.
      case '12433': // answer to our group call request: servers + session
        if (c && c.group && c.role === 'caller' && c.state === 'calling') this._groupRequestAnswered(data);
        return;
      case '12434':
      case '12437':
        if (c && c.group) this.log(`recvSignal ${command}`, JSON.stringify(parseMaybeJson(data.params || data.data)).slice(0, 300));
        return;
      case '12097': {
        if (!c || !c.group || c.state !== 'connected') return;
        const r = parseMaybeJson(data.data);
        // -3 "List incall empty": nobody in the call yet, normal while our
        // own call is still ringing (live test 2026-10-01).
        if (Number(r.error) === -3 && c.role === 'caller' && !c.answered) return;
        if (r.error !== undefined && Number(r.error) !== 0) {
          // A ping error alone is not enough: "uid invalid timestamp" also
          // came 36 s into a call whose audio and video kept flowing (live
          // test 2026-10-01). End only once the media stopped too.
          const idle = this.media.lastRxAt ? Date.now() - this.media.lastRxAt : Infinity;
          if (idle < GROUP_MEDIA_IDLE_MS) { this.log('group ping fail:', r.error, r.message || '', '(media still flowing; staying)'); return; }
          this.log('group ping fail:', r.error, r.message || '');
          this._groupFinish(50, 'Cuộc gọi nhóm đã kết thúc', { signals: true });
        }
        return;
      }
      case '409': // ack of our 409/405 (the call is already finished then)
      case '405':
        if (c && c.state !== 'ended') this._peerEnded(`recvSignal ${command}`);
        return;
      case '402':
      case '407':
      case '416':
      case '408':
      case '406':
      case '12006':
      case '12064':
        return; // acks of what we sent
      case '12044': {
        // Group screen share. The answer's params carry shareScreenId; the
        // real client stores it and sends 12044 again with that id.
        if (!c || !c.group) return;
        let r = parseMaybeJson(data.data || data.params);
        if (r && typeof r.params === 'string') r = parseMaybeJson(r.params);
        const id = Number(r && r.shareScreenId);
        this.log('group share response', JSON.stringify(r).slice(0, 300));
        if (!(id > 0)) return;
        const prev = c.shareScreenId || 0;
        c.shareScreenId = id;
        if (c.sharing && prev !== id) this._screenShare(true);
        return;
      }
      default:
        this.log('recvSignal', command);
    }
  }

  // extendData of 416 (caller) and 402 (callee), keys as the real engine sends them.
  _extendData(c, server, publicAddr, extra = {}) {
    const p2p = [];
    if (publicAddr && publicAddr.includes('|')) {
      const [ip, port] = publicAddr.split('|');
      p2p.push({ ip, port: Number(port), type: 1 });
    }
    return {
      callType: c.type === 3 ? 1 : 0,
      fecTP: 0,
      gccAudio: 1,
      gccEarlyCall: 0,
      gccMode: 1,
      gccSVLR: 1,
      maxFT: 60,
      newZrtc: 1,
      p2p,
      packetMode: 2,
      platform: 2,
      sP2P: 0, // relay only: no P2P in the native engine yet
      serverAddr: [{ rtcp: server.rtcpaddr, rtcpIPv6: server.rtcpIPv6, rtp: server.rtpaddr, rtpIPv6: server.rtpIPv6, tpType: 0 }],
      spTcp: 1,
      srtcp: 0,
      srtpMode: 1,
      supportCallBusy: 1,
      supportHevcDecode: 0,
      tpType: 0,
      video: { codec: [{ name: 'h264', payload: 97 }] },
      ...extra,
    };
  }

  _send416(c, server, publicAddr) {
    this.emit({
      type: 'sendSignal',
      command: 416,
      data: {
        callId: c.callId,
        calleeId: c.peerId,
        codec: CODEC,
        extendData: jsonCpp(this._extendData(c, server, publicAddr)),
        rtcpAddress: server.rtcpaddr,
        rtpAddress: server.rtpaddr,
        session: c.sessId,
      },
    });
  }

  // Local hang up (call window, Zalo, media loss): tell the peer, then finish.
  hangup(why) {
    const c = this.call;
    if (!c || c.state === 'ended') return;
    this.log('hangup:', why);
    if (c.group) { this._groupHangup(why); return; }
    if (c.state === 'incoming') { this.reject(why); return; }
    if (c.state === 'connected') {
      this.emit({ type: 'sendSignal', command: 409, data: { callId: c.callId, toId: c.peerId } });
    } else {
      this.emit({ type: 'sendSignal', command: 405, data: { callId: c.callId, callType: c.type === 3 ? 1 : 0, status: 0, toId: c.peerId } });
    }
    this._finish(c.state === 'connected' ? 50 : 103);
  }

  // ---- Group calls: someone else's (incoming) ----
  // Signals as ZCallGroupInfo / ZMessageSerializer build them (macOS ZaloCall
  // 26.9.10): every one carries callId and hostCall, the rest in a JsonCpp
  // string `data`, which is what Zalo's JS destructures.
  //   control group_request -> callState incall, 12439 ringring
  //   answer   -> group InitZRTP to callSetting.servers, then 12436 status 0,
  //               12098 broadcast, 12097 ping every `interval`
  //   decline  -> 12436 status 3
  //   hang up  -> 12438 endcall, 12446 finish, callState free
  // The callee never sends 12434 (only the caller does: ZCallGroupInfo +0x9b0).

  _onGroupControl(act, d) {
    const c = this.call;
    if (act === 'group_request') return this._groupIncoming(d);
    if (!c || !c.group) return;
    const id = d.id !== undefined ? d.id : d.callId;
    if (id !== undefined && Number(id) !== c.callId) return; // another group call
    const who = Number(d.userId || d.fromId) || 0;
    switch (act) {
      case 'group_broadcast': // member state, sent every few seconds
        if (who && who !== c.localUid) this._groupMember(who, { state: Number(d.callState) === 3 ? 'incall' : 'ringing', muted: Number(d.audioState) === 1 });
        return;
      case 'group_answer':
        if (who && who !== c.localUid) { this._groupMember(who, { state: 'incall' }); this._groupGreet(who); }
        return;
      // fromId = the member being rung, receiverId = us (log 2026-10-01).
      case 'group_ring_ring':
        if (who && who !== c.localUid && !(c.members.get(who) || {}).state) this._groupMember(who, { state: 'ringing' });
        return;
      case 'group_end_call':
      case 'group_cancel':
        // Not answered yet: the caller gave up, or our account answered /
        // declined on another device (fromId = our UID).
        if (c.state === 'incoming' && (!who || who === c.hostCall || who === c.localUid)) {
          this.log('group call over before we answered:', act, who === c.localUid ? 'handled on another device' : 'cancelled');
          this._groupFinish(0, 'Cuộc gọi nhóm đã kết thúc', { signals: false });
          return;
        }
        // In the call: Zalo says we left (the server dropped us, or it is the
        // echo of our own 12438, which then finds the call already over).
        if (who === c.localUid) {
          this.log('group call: Zalo reports our own end_call');
          this._groupFinish(c.state === 'connected' ? 50 : 0, 'Cuộc gọi nhóm đã kết thúc', { signals: false });
          return;
        }
        if (who) this._groupMemberLeft(who, act);
        return;
      default:
        this.log('group control', act);
    }
  }

  // ---- Outgoing group call (ZCallGroupInfo::requestCall) ----
  //   makeCall type 5 / 6 + groupInfo -> 12433 requestCallGroup
  //   recvSignal 12433 (callSetting: servers, session) -> InitZRTP as host (cmd 11)
  //   -> 12434 (our server + session; Zalo rings the members), 12098, 12097
  //   nobody answers in RING_TIMEOUT -> 12437 cancel; hang up -> 12438 + 12446
  _groupOutgoing(data) {
    const g = data.groupInfo || {};
    const ids = (Array.isArray(data.partner) ? data.partner : []).map((p) => String(p.id || '')).filter(Boolean);
    this.call = {
      group: true,
      role: 'caller',
      state: 'calling',
      callId: newCallId(),
      hostCall: 0,
      groupIdStr: String(g.id || ''),
      groupId: 0,
      localUid: 0,
      callType: data.type === 6 ? 1 : 0,
      sessId: '',
      servers: [],
      config: {},
      title: g.name || g.groupName || 'Cuộc gọi nhóm',
      avatar: g.avatar || '',
      maxUsers: Number(g.maxUsers) || 8,
      invited: ids,
      inviteNames: (data.partner || []).map((p) => p.name || ''),
      members: new Map(),
      pingMs: 9000,
      startedAt: 0,
      muted: false,
    };
    const c = this.call;
    this.log(`outgoing group call ${c.callId}: ${ids.length} member(s)`);
    this.emit({ type: 'update', command: 'callState', data: { state: 'incall' } });
    this.emit({ type: 'response', command: 'show', data: { error: 0, extendData: 'success' } });
    // ZMessageSerializer::requestCallGroup: typeRequest from the constant 6
    // (6 -> 1), partners and data.noiseId = the invited Zalo ids, as JsonCpp strings.
    this.emit({
      type: 'sendSignal',
      command: 12433,
      data: {
        callId: c.callId,
        data: jsonCpp({ extraData: '', groupAvatar: c.avatar, groupId: c.groupIdStr, groupName: c.title, maxUsers: c.maxUsers, noiseId: jsonCpp(ids) }),
        groupId: c.groupIdStr,
        partners: jsonCpp(ids),
        typeRequest: 1,
      },
    });
    // video: the call window only opens the camera (and shows its button) when
    // this is set. Group calls were leaving it off, so getUserMedia never ran
    // and a virtual camera that works for 1-1 was never captured.
    this.ui.open({ title: c.title, text: 'Đang gọi nhóm…', avatar: c.avatar, video: true });
    c.ringTimer = setTimeout(() => {
      if (this.call === c && !c.answered && c.state !== 'ended') { this.log('group call: nobody answered'); this._groupHangup('no-answer'); }
    }, Number(process.env.ZCALL_GROUP_RING_MS) || 60000);
    if (c.ringTimer.unref) c.ringTimer.unref();
  }

  // recvSignal 12433 (_parseRequestCallResponseGroupDetail: callId,
  // callSetting, session, groupId, maxUsers, status, msg, failedId, ...).
  _groupRequestAnswered(data) {
    const c = this.call;
    const p = { ...parseMaybeJson(data.data), ...parseMaybeJson(data.params) };
    const setting = parseMaybeJson(p.callSetting);
    this.log('group call request answered:', JSON.stringify({ keys: Object.keys(p), status: p.status, msg: p.msg, settingKeys: Object.keys(setting) }));
    const status = Number(p.status !== undefined ? p.status : data.status) || 0;
    c.hostCall = Number(data.hostCall || p.hostCall) || 0;
    c.localUid = c.hostCall;
    if (p.callId) c.callId = Number(p.callId);
    if (p.groupId && Number(p.groupId) < 0x7fffffff) c.groupId = Number(p.groupId);
    if (p.interval) c.pingMs = Number(p.interval) < 1000 ? Number(p.interval) * 1000 : Number(p.interval);
    c.sessId = setting.session || p.session || '';
    c.servers = Array.isArray(setting.servers) ? setting.servers : [];
    c.config = parseMaybeJson(setting.zrtcConfig);
    if (status !== 0 || !c.sessId || !c.servers.length || !c.localUid) {
      this.log('group call request refused / incomplete');
      c.state = 'failed';
      this.ui.status(p.msg ? `Không gọi được: ${p.msg}` : 'Không gọi được nhóm');
      setTimeout(() => this._groupFinish(0, 'Không gọi được nhóm', { signals: false }), 3000).unref();
      return;
    }
    c.state = 'connecting';
    this.media.onNegotiated({
      muted: !!c.muted,
      speakerOff: !!c.speakerOff,
      group: true,
      host: true,
      servers: c.servers,
      config: c.config,
      sessId: c.sessId,
      callId: c.callId,
      role: 'caller',
      localUid: c.localUid,
      hostCall: c.hostCall,
    });
    this._groupCameraProfile();
    this.media.prepare('caller').then((best) => {
      if (this.call !== c || c.state !== 'connecting') return;
      if (!best && this.media.sendUdp) {
        c.state = 'failed';
        this.ui.status('Không vào được cuộc gọi nhóm (máy chủ từ chối)');
        setTimeout(() => this._groupFinish(0, 'Không vào được cuộc gọi nhóm', { signals: false }), 3000).unref();
        return;
      }
      this.media.start('caller', null);
      c.state = 'connected';
      c.startedAt = Date.now();
      const srv = (best && best.server && best.server.raw) || c.servers[0] || {};
      // ZMessageSerializer::sendRequestZRtpCallGroup, values as
      // ZCallGroupInfo::onCallJoinMeetingSuccess passes them.
      this.emit({
        type: 'sendSignal',
        command: 12434,
        data: {
          callId: c.callId,
          callType: c.callType,
          data: jsonCpp({
            codec: '',
            data: jsonCpp({ groupAvatar: c.avatar, groupName: c.title, hostCall: c.hostCall, maxUsers: c.maxUsers, noiseId: c.invited }),
            extendData: '',
            rtcpAddress: srv.rtcpaddr || '',
            rtcpAddressIPv6: srv.rtcpaddrIPv6 || srv.rtcpIPv6 || '',
            rtpAddress: srv.rtpaddr || '',
            rtpAddressIPv6: srv.rtpaddrIPv6 || srv.rtpIPv6 || '',
          }),
          groupId: c.groupIdStr,
          // Added by the same helper as in 12433 (requestCallGroup+0x840):
          // the people Zalo rings. Without it nobody rang (live test 2026-10-01).
          partners: jsonCpp(c.invited),
          session: c.sessId,
        },
      });
      this._groupBroadcast();
      c.pingTimer = setInterval(() => this._groupPing(), c.pingMs);
      if (c.pingTimer.unref) c.pingTimer.unref();
      this.ui.status('Đang đổ chuông…', 0);
    });
  }

  _groupIncoming(d) {
    if (this.call) { this.log('group call while in a call; ignored', d.id); return; }
    this.groupNotice = null;
    const setting = parseMaybeJson(d.callSetting);
    const localUid = Number(d.receiverId) || 0;
    const members = new Map();
    for (const p of Array.isArray(d.partnerInfo) ? d.partnerInfo : []) {
      const uid = Number(p.userId) || 0;
      if (!uid || uid === localUid) continue;
      members.set(uid, { name: p.name || '', state: Number(p.callState) === 3 ? 'incall' : 'ringing', muted: Number(p.audioState) === 1 });
    }
    const interval = Number(d.interval) || 0;
    this.call = {
      group: true,
      role: 'callee',
      state: 'incoming',
      callId: Number(d.id),
      hostCall: Number(d.hostCall) || 0,
      groupId: Number(d.groupId) || 0,
      localUid,
      callType: Number(d.callType) === 1 ? 1 : 0,
      sessId: setting.session || d.session || '',
      servers: Array.isArray(setting.servers) ? setting.servers : [],
      config: parseMaybeJson(setting.zrtcConfig),
      title: d.groupName || 'Cuộc gọi nhóm',
      avatar: d.groupAvatar || '',
      members,
      // 12097 period; `interval` unit not known (seconds if small).
      pingMs: interval ? (interval < 1000 ? interval * 1000 : interval) : 10000,
      startedAt: 0,
      muted: false,
    };
    const c = this.call;
    this.log(`incoming group call ${c.callId}: ${c.servers.length} server(s), ${members.size} member(s), session ${c.sessId.length} chars`);
    if (!c.sessId || !c.servers.length || !c.localUid) {
      this.log('group_request without session / servers / receiverId; not answering');
      this.call = null;
      this._incomingGroup(d);
      return;
    }
    this.emit({ type: 'update', command: 'callState', data: { state: 'incall' } });
    this.emit({ type: 'sendSignal', command: 12439, data: { callId: c.callId, data: jsonCpp({ callType: 1, extraData: '', status: 1 }), hostCall: c.hostCall, session: c.sessId, status: 1 } });
    const host = (c.members.get(c.hostCall) || {}).name || d.Dname || 'Ai đó';
    this.ui.incoming({ title: c.title, text: `${host} mời bạn vào cuộc gọi nhóm`, inviter: host, avatar: c.avatar, video: true },
      () => this._groupAnswer(), (why) => this._groupReject(why));
  }

  _groupAnswer() {
    const c = this.call;
    if (!c || !c.group || c.state !== 'incoming') return;
    c.state = 'connecting';
    this.media.onNegotiated({
      muted: !!c.muted,
      speakerOff: !!c.speakerOff,
      group: true,
      host: false,
      servers: c.servers,
      config: c.config,
      srtpMode: c.config.srtpMode,
      sessId: c.sessId,
      callId: c.callId,
      role: 'callee',
      localUid: c.localUid,
      hostCall: c.hostCall,
    });
    this._groupCameraProfile();
    this.ui.status('Đang kết nối…');
    this.media.prepare('callee').then((best) => {
      if (this.call !== c || c.state !== 'connecting') return;
      if (!best && this.media.sendUdp) {
        // Leave the reason on screen for a moment before the window closes.
        c.state = 'failed';
        this.ui.status('Không vào được cuộc gọi nhóm (máy chủ từ chối)');
        this._groupSendAnswer(c, 3);
        setTimeout(() => this._groupFinish(0, 'Không vào được cuộc gọi nhóm', { signals: false }), 3000).unref();
        return;
      }
      this.media.start('callee', null);
      c.state = 'connected';
      c.startedAt = Date.now();
      this._groupSendAnswer(c, 0);
      this._groupBroadcast();
      c.pingTimer = setInterval(() => this._groupPing(), c.pingMs);
      if (c.pingTimer.unref) c.pingTimer.unref();
      this._groupStatus();
    });
  }

  _groupReject(why = 'reject') {
    const c = this.call;
    if (!c || !c.group || c.state !== 'incoming') return;
    this.log('group reject:', why);
    this._groupSendAnswer(c, 3);
    this._groupFinish(0, 'Đã từ chối cuộc gọi nhóm', { signals: false });
  }

  // 12436: status 0 accept, 3 decline (ZCallGroupInfo::_trySendAcceptSignal / _rejectCurrentCall).
  _groupSendAnswer(c, status) {
    this.emit({
      type: 'sendSignal',
      command: 12436,
      data: {
        callId: c.callId,
        data: jsonCpp({ callType: c.callType, codec: '', extendData: '', groupId: c.groupId, status }),
        hostCall: c.hostCall,
        session: c.sessId,
        status,
      },
    });
  }

  // videoState is the inverse of "camera on". OnTurnOnCamera(true) stores
  // !arg at ZPingUserData+0x8, and a phone that is sending video keeps
  // videoState 0 (live 2026-10-03, member 133222413). audioState 1 is muted.
  // Layer 0 of the SFU table. The window encodes exactly this size. Absent
  // when groupcall.spatialLayers did not produce a row.
  _groupCameraProfile() {
    const plan = this.media && this.media.videoPlan;
    if (plan && plan.encode && this.ui.setCameraEncode) this.ui.setCameraEncode(plan.encode);
    // The screen: shorter side 720 px (ZCALL_SHARE_RES), maxShrScreenBr kbps (1500 in
    // the group config). 480 px / 900 kbps (maxShrScreenRes / minShrScreenBr) was
    // too blurred to read on the Mac and the phone (2026-10-08); the 70-packet key
    // frame of 720p goes out paced (zrtc-media SHARE_BURST) and arrives whole.
    const cfg = (this.call && this.call.config) || (this.media && this.media.params && this.media.params.config) || {};
    const maxShort = Number(process.env.ZCALL_SHARE_RES) > 0 ? Math.trunc(Number(process.env.ZCALL_SHARE_RES)) : 720;
    const kbps = Number(cfg.maxShrScreenBr) > 0 ? Math.trunc(Number(cfg.maxShrScreenBr)) : 1500;
    if (this.ui.setScreenEncode) this.ui.setScreenEncode({ maxShort, bitrate: kbps * 1000 });
  }

  _groupState(c) {
    return { audioState: c.muted ? 1 : 0, callId: c.callId, callState: 3, hostCall: c.hostCall, userId: c.localUid, videoState: c.cameraOn ? 0 : 1 };
  }

  // A member who joins after our camera / mic change never got that 12098: the
  // phone then drew our tile as camera off (avatar) although it subscribed to our
  // video, and showed it only after we turned the camera off and on again (live
  // 2026-10-08, our outgoing group call). Say our state again when someone joins,
  // and once more 2 s later, once per member and call.
  _groupGreet(uid) {
    const c = this.call;
    if (!c || !c.group || c.state !== 'connected') return;
    if (uid === c.shareScreenId) return; // our own screen share peer
    c.greeted = c.greeted || new Set();
    if (c.greeted.has(uid)) return;
    c.greeted.add(uid);
    this.log('group: member', uid, 'joined, our state again');
    this._groupBroadcast();
    setTimeout(() => { if (this.call === c) this._groupBroadcast(); }, 2000).unref();
  }

  _groupBroadcast() {
    const c = this.call;
    if (c && c.group && c.state === 'connected') this.emit({ type: 'sendSignal', command: 12098, data: this._groupState(c) });
  }

  _groupPing() {
    const c = this.call;
    if (c && c.group && c.state === 'connected') this.emit({ type: 'sendSignal', command: 12097, data: this._groupState(c) });
  }

  _groupMember(uid, info) {
    const c = this.call;
    if (!c || !c.group || uid === c.localUid) return;
    const m = c.members.get(uid) || { name: '' };
    c.members.set(uid, { ...m, ...info });
    if (info.state === 'incall') c.answered = true;
    this._groupStatus();
  }

  _groupMemberIn(uid) {
    const c = this.call;
    if (c && c.group && uid !== c.localUid && (c.members.get(uid) || {}).state !== 'incall') this._groupMember(uid, { state: 'incall' });
  }

  // The server's list of who is in the room (cmd 50).
  _groupRoster(uids) {
    const c = this.call;
    if (!c || !c.group) return;
    const inRoom = new Set(uids);
    for (const uid of inRoom) {
      if (uid === c.localUid) continue;
      if ((c.members.get(uid) || {}).state !== 'incall') this._groupGreet(uid);
      this._groupMember(uid, { state: 'incall' });
    }
    for (const [uid, m] of c.members) if (m.state === 'incall' && !inRoom.has(uid)) c.members.set(uid, { ...m, state: 'left' });
    this._groupStatus();
    this._groupCheckEmpty('roster');
  }

  _groupMemberLeft(uid, why) {
    const c = this.call;
    if (!c || !c.group || uid === c.localUid) return;
    const m = c.members.get(uid);
    if (!m || m.state === 'left') return;
    this.log('group member left:', uid, why);
    c.members.set(uid, { ...m, state: 'left' });
    this._groupStatus();
    this._groupCheckEmpty(why);
  }

  // Everyone else gone: the real engine ends the call (_countIncallPartner).
  _groupCheckEmpty(why) {
    const c = this.call;
    if (!c || !c.group || c.state !== 'connected') return;
    const others = [...c.members.values()].filter((m) => m.state === 'incall' || m.state === 'ringing');
    if (!others.length) { this.log('group call: nobody left', why); this._groupHangup('alone'); }
  }

  _groupStatus() {
    const c = this.call;
    if (!c || !c.group || c.state !== 'connected') return;
    const names = [...c.members.values()].filter((m) => m.state === 'incall').map((m) => m.name || 'Thành viên');
    const waiting = c.role === 'caller' && !c.answered ? 'Đang đổ chuông…' : 'Đang chờ người khác…';
    const text = names.length ? `${names.length + 1} người: Bạn, ${names.join(', ')}` : waiting;
    if (text !== c.statusText) { c.statusText = text; this.ui.status(text, c.startedAt); }
  }

  // The server removed us (host ended the meeting, or kicked us).
  _groupEnded(why) {
    const c = this.call;
    if (!c || !c.group || c.state === 'ended') return;
    this.log('group call ended by the server:', why);
    this._groupFinish(c.state === 'connected' ? 50 : 0, why === 'kicked' ? 'Bạn đã bị mời ra khỏi cuộc gọi' : 'Cuộc gọi nhóm đã kết thúc');
  }

  _groupHangup(why) {
    const c = this.call;
    if (!c || c.state === 'ended') return;
    if (c.state === 'incoming') { this._groupReject(why); return; }
    if (c.role === 'caller' && !c.answered) { this._groupCancel(why); return; }
    this._groupFinish(c.state === 'connected' ? 50 : 0, null);
  }

  // Caller gives up before anyone answered: 12437 {callId, hostCall,
  // data {callType, duration, extraData, groupId}} (ZCallGroupInfo::_cancelCurrentCall).
  _groupCancel(why) {
    const c = this.call;
    this.log('group call cancelled:', why);
    if (c.hostCall) {
      this.emit({
        type: 'sendSignal',
        command: 12437,
        data: { callId: c.callId, data: jsonCpp({ callType: c.callType, duration: 0, extraData: '', groupId: c.groupId }), hostCall: c.hostCall },
      });
    }
    this._groupFinish(0, why === 'no-answer' ? 'Không ai trả lời' : 'Đã huỷ cuộc gọi nhóm', { signals: false });
  }

  // 12438 endcall {callId, hostCall, data {callType, duration, extraData,
  // groupId, status}} (status 7 for reasons 19-23, else 0), then 12446.
  _groupFinish(status, closeText, { signals = true } = {}) {
    const c = this.call;
    if (!c || c.state === 'ended') return;
    const connected = c.state === 'connected';
    c.state = 'ended';
    clearInterval(c.pingTimer);
    clearTimeout(c.ringTimer);
    const stats = (connected && this.media.stats()) || {};
    this.media.stop();
    const duration = connected ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
    if (signals && connected) {
      this.emit({
        type: 'sendSignal',
        command: 12438,
        data: { callId: c.callId, data: jsonCpp({ callType: c.callType, duration, extraData: '', groupId: c.groupId, status: 0 }), hostCall: c.hostCall },
      });
      this.emit({
        type: 'sendSignal',
        command: 12446,
        data: {
          callId: c.callId,
          callType: c.callType,
          data: JSON.stringify({ Codec: ['opus/16000/1', '20'], RxTotalPkt: stats.rx || 0, TxTotalPkt: stats.tx || 0, sysInfo: 'native-engine' }),
          duration,
          hostCall: c.hostCall,
          joinTime: c.startedAt,
          status,
        },
      });
    }
    this.emit({ type: 'update', command: 'callState', data: { state: 'free' } });
    this.ui.close(closeText || (connected ? `Kết thúc — ${duration} s` : 'Đã kết thúc'));
    this.call = null;
  }

  _finish(status, closeText) {
    const c = this.call;
    if (!c || c.state === 'ended') return;
    const connected = c.state === 'connected';
    c.state = 'ended';
    const stats = (c.sessId && this.media.stats()) || {}; // no media before recvSignal 401
    this.media.stop();
    const duration = connected ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
    const role = c.role === 'caller';
    this.emit({ type: 'update', command: 'bubble', data: { duration, partnerId: c.peerId, role } });
    this.emit({
      type: 'sendSignal',
      command: 406,
      data: {
        callId: c.callId,
        data: JSON.stringify({
          Codec: ['opus/16000/1', '20'],
          NewZRTC: 1,
          RxTotalPkt: stats.rx || 0,
          SrtpMode: 1,
          TxTotalPkt: stats.tx || 0,
          sysInfo: 'native-engine',
        }),
        duration,
        partnerId: c.peerId,
        role,
        status,
      },
    });
    this.emit({ type: 'update', command: 'callState', data: { state: 'free' } });
    this.ui.close(closeText || (connected ? `Kết thúc — ${duration} s` : 'Đã kết thúc'));
    this.call = null;
  }
}

module.exports = { EngineCore, MediaBackend, jsonCpp, newCallId };
