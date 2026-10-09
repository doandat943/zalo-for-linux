'use strict';
// Media backend of the native engine: Zalo's relay transport (ZRTP over UDP
// :4200), SRTP and Opus audio, as ZaloCall does it (docs/ZRTP-SPEC.md).
//
//   prepare()        InitZRTP to every server in recvSignal 401; each answers
//                    (MsgType 2) with a token; the fastest is proposed in 416.
//   start(rtpSerIp)  peer answered: keep that server, EndCall the others,
//                    start audio (type 3 out, type 4 in), Ping every 6 s,
//                    ReqForward status every 1 s.
//   stop()           EndCall, stop audio.
//
// Group calls (params.group, docs/GROUP-CALL.md): the servers of
// group_request callSetting (SFU, port 3000), the group InitZRTP (subCmd 4)
// and ZaviPing (cmd 0x33), no P2P and no 1-1 ReqForward status. VidQual
// request (cmd 32 sub 13, qualityId 0xff) goes out once a member's video
// arrives. VidQualConfig (sub 12) goes out on the same tick when
// groupcall.spatialLayers produced a table.
// Every member's audio
// comes down as type 4 with SSRC = the member's UID, under the one session
// key; audio-io mixes them (--mix). The server tells who is in the room
// (cmd 50, 'roster') and who left (cmd 3, 'memberLeft' / 'peerEnd').
//
// Packets leave the machine only when sendUdp is true (zcall-native.js
// --media zrtc --send-udp). Every packet format here is checked byte for byte
// against the real engine by native-engine/wire-check.js.

const dgram = require('dgram');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const {
  MSG_TYPES,
  COMMANDS,
  wrapMediaPacket,
  buildInitZrtpPacket,
  buildGroupInitZrtpPacket,
  buildShareInitZrtpPacket,
  buildShareZaviPingPacket,
  GROUP_INIT_LAYOUTS,
  buildZaviPingPacket,
  parseRoomUpdated,
  buildPingPacket,
  buildEndCallPacket,
  buildReqForwardPacket,
  buildGroupVidQualReq,
  buildGroupVidQualConfig,
  groupVideoPlan,
  reqForwardStatus,
  P2P,
  buildP2pBind,
  buildP2pBindAnswer,
  buildP2pPong,
  wrapP2pAudio,
  wrapP2pVideo,
  wrapP2pRtcp,
  unwrapPacket,
} = require('../zrtp-packet');
const { masterFromSessId, sessionKeys, parseRtp, unprotectRtp, protectRtp } = require('../srtp-aes');
const { FRAME_SAMPLES, buildAudioRtpHeader, buildGroupAudioRtpHeader, buildGroupVideoRtpHeader } = require('../rtp');
const { packetizeFrame, KEY_PT, DELTA_PT } = require('../video');
const { RtcpFeedback } = require('../rtcp');

// Timings of the real engine (captures 2026-09-29).
const INIT_WAIT_MS = 600;        // all servers answered InitZRTP within ~35 ms
const INIT_RETRY_MS = 1000;
const INIT_TRIES = 3;
const PING_INTERVAL_MS = 6000;   // Ping to the kept server
const TWCC_INTERVAL_MS = 50; // ZaloCall's cadence (captures 2026-09-29)
const RTCP_REPORT_INTERVAL_MS = 1000;
const PLI_MIN_GAP_MS = 1000; // one key frame request per second at most
const RTCP_LOG_MS = 5000;
const SHARE_BURST = 6; // screen packets per 1 ms tick
const AUDIO_TX_LOG_MS = 10000;
// Group ZaviPing period: the real engine takes it from its config
// (GroupCallController +0x85c), value not known yet.
const GROUP_PING_INTERVAL_MS = Number(process.env.ZCALL_GROUP_PING_MS) || 5000;
const STATUS_INTERVAL_MS = 1000; // ReqForward sub 10
const MEDIA_TIMEOUT_MS = 20000;  // no audio from the peer for this long: give up
// P2P binding to the peer's candidates, as the real engine paces it:
// every 100 ms for the first second, then every 400 ms, until the peer answers.
const P2P_BIND_FAST_MS = 100;
const P2P_BIND_SLOW_MS = 400;
const P2P_BIND_GIVE_UP_MS = 15000;
const fs = require('fs');

function parseHostPort(addr) {
  if (!addr || typeof addr !== 'string') return null;
  if (addr.startsWith('[')) {
    const m = addr.match(/^\[([^\]]+)\]:(\d+)$/);
    return m ? { host: m[1], port: parseInt(m[2], 10) } : null;
  }
  const i = addr.lastIndexOf(':');
  if (i <= 0) return null;
  const host = addr.slice(0, i);
  const port = parseInt(addr.slice(i + 1), 10);
  if (!Number.isFinite(port)) return null;
  return { host, port };
}

// RFC 3711 §3.3.1 rollover-counter guess for received packets.
class RocTracker {
  constructor() { this.last = null; this.roc = 0; }
  guess(seq) {
    if (this.last === null) return 0;
    if (this.last - seq > 0x8000) return this.roc + 1;
    if (seq - this.last > 0x8000 && this.roc > 0) return this.roc - 1;
    return this.roc;
  }
  update(seq, roc) {
    if (this.last === null || roc * 0x10000 + seq > this.roc * 0x10000 + this.last) { this.last = seq; this.roc = roc; }
  }
}

class ZrtcMediaBackend extends EventEmitter {
  constructor({ log = () => {}, onAudioPacket = null, sendUdp = false, audio = true } = {}) {
    super();
    this.log = log;
    this.onAudioPacket = onAudioPacket;
    this.sendUdp = !!sendUdp;
    this.audioEnabled = audio;
    this.socket = null;
    this.timers = new Set();
    this.active = false;
    this.params = null;
    this.servers = [];
    this.activeServer = null;
    this.serverToken = 0;
    this.replies = []; // { server, token, rttMs, publicAddr }
    this.refusals = []; // { server, res, hex }: InitZRTP refused
    this.ended = new Set(); // servers already sent EndCall
    this.srtpContext = null;
    this.audio = null;
    this.devices = {}; // { mic, speaker }: PulseAudio source / sink names, kept across calls
    this._resetCounters();
  }

  _resetCounters() {
    this.seq = Math.floor(Math.random() * 0x8000);
    this.ts = Math.floor(Math.random() * 0x7fffffff);
    this.twSeq = 1; // transport-wide sequence, shared by audio and video
    this.vSeq = Math.floor(Math.random() * 0x8000);
    this.vRoc = 0;
    this.vTsBase = Math.floor(Math.random() * 0x7fffffff);
    this.vStart = 0;
    this.vTx = 0;
    this.vLayerSeq = 0; // group: SFU extension packet counter of the camera layer
    this.ctlSeq = 0; // group: header seq of cmd 32 sub 12 / 13, +1 per packet (macOS: 0, 1, 2, ...)
    this.share = null; // group screen share peer (startShare), its own socket and token
    this.vKeySent = false; // the phone shows nothing until our first key frame
    this.groupCameraOn = false; // ZaviPing "sending video" bit (ZCALL_GROUP_CAMERA=0: never)
    this.rtcp = null; // RtcpFeedback, 1-1 calls only (set in onNegotiated)
    this.aTxWin = { n: 0, last: 0, maxGap: 0, gaps40: 0, gaps60: 0, since: Date.now() }; // audio send timing, 10 s log line
    this.audioOctets = 0;
    this.lastPliAt = 0;
    this.rtcpLoggedAt = 0;
    this.vidWanted = new Set(); // group members we asked the SFU to send video for
    this.renderWidth = new Map(); // group: member UID -> width of its tile in pixels, from the window
    this.vidAsked = new Map(); // group: member UID -> the quality id last requested
    this.unknownReplies = new Set();
    this.memberAsks = new Map(); // group: member UID -> what it last asked the SFU for (sub 13)
    this.vidQualLogged = false;
    this.vidCfgLogged = false;
    this.keyRequests = 0;  // PLI / FIR from the peer
    this.roc = 0;
    this.fwdSeq = 1;
    this.rxRoc = new RocTracker();
    this.rxRocs = new Map(); // group: one per member (SSRC)
    this.members = new Map(); // group: SSRC -> packets received
    this.counters = { tx: 0, rx: 0, rxBad: 0, rxSecond: 0, rxP2p: 0 };
    this.rxTypes = {};
    this.p2pPath = null; // { host, port } once the peer reached us directly
    this.p2pSeen = false;
    this.videoStats = { pkts: 0, bad: 0, pt: {}, head: {}, marker: 0 };
    this.videoRoc = new RocTracker();
    this.videoRocs = new Map(); // group: per member (SSRC)
    this.videoMembers = new Map(); // group: SSRC -> { pkts, pt, head }
    this.p2pSeq = 0;
    this.lastRxAt = 0;
    this.startedAt = 0;
  }

  _timer(fn, ms, repeat) {
    const t = repeat ? setInterval(fn, ms) : setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  _clearTimers() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers.clear();
  }

  onNegotiated(params) {
    this.params = params || {};
    this.group = !!this.params.group;
    // Mute and speaker-off belong to the call: the media object lives on, and a
    // mute left from the previous call muted the next one's microphone while the
    // window showed it on (group calls after a muted 1-1 call, 2026-10-09).
    this.muted = !!this.params.muted;
    this.speakerOff = !!this.params.speakerOff;
    this.servers = [];
    const list = Array.isArray(this.params.servers) ? this.params.servers : [];
    for (const s of list) {
      const v4 = parseHostPort(s.rtpaddr || s.rtp || s.rtpAddress);
      if (v4) this.servers.push({ ...v4, raw: s, family: 'udp4' });
    }
    this.activeServer = null;
    this.serverToken = 0;
    this.replies = [];
    this.ended.clear();
    this._resetCounters();
    // 1-1 only: the group SFU's feedback channel is not captured. ZCALL_RTCP=0 turns it off.
    this.rtcp = !this.group && process.env.ZCALL_RTCP !== '0' && this.params.localUid
      ? new RtcpFeedback({ localSsrc: this.params.localUid >>> 0 }) : null;
    // After the counter reset: sub 12 is empty when groupcall has no layers.
    this.videoPlan = this.group ? groupVideoPlan(this.params.config) : null;
    this.log('media: negotiated', { servers: this.servers.length, srtpMode: this.params.srtpMode, sendUdp: this.sendUdp });
    this.srtpContext = null;
    this.plainMedia = false;
    // Group: the SRTP key is zrtcConfig.srtpKey and nothing else
    // (GroupZRtcConfig +0x2a0 -> GroupCallPeer +0x340 -> createAndInitSRTP;
    // no fallback to the session as in 1-1). Empty, createAndInitSRTP fails
    // and GroupCallPeer sends and reads plain RTP (_processReceiveZRtcPacket
    // skips SrtpTransport when there is none). Live test 2026-10-01: empty.
    const groupKey = this.group ? String((this.params.config || {}).srtpKey || '') : '';
    if (this.group && !groupKey) {
      this.plainMedia = true;
      this.log('media: group call without srtpKey: plain RTP, as ZaloCall does');
    }
    const sess = this.group ? groupKey : this.params.sessId;
    if (sess && String(sess).length >= 30) {
      try {
        this.srtpContext = sessionKeys(masterFromSessId(sess));
      } catch (e) {
        this.log('media: SRTP key setup failed', e.message);
      }
    }
  }

  // InitZRTP to every server; resolves with the fastest reply
  // { server, token, rttMs, publicAddr } or null.
  prepare(role = 'caller') {
    this.active = true;
    if (!this.sendUdp) {
      this.log('media: observe-only (no --send-udp), not contacting servers');
      return Promise.resolve(null);
    }
    this._initSocket();
    if (this.group) return this._prepareGroup();
    return this._initZrtp(buildInitZrtpPacket({
      role,
      uid: this.params.localUid || 0,
      peerUid: this.params.peerUid || 0,
      callId: this.params.callId || 0,
      sessId: this.params.sessId || '',
    }));
  }

  // Group InitZRTP: the payload layout is not settled (docs/GROUP-CALL.md
  // §2), so a refusal moves on to the next candidate. The one that works is
  // kept in <ZCALL_LOG_DIR>/group-init-layout and tried first next time;
  // ZCALL_GROUP_INIT_LAYOUT forces one.
  async _prepareGroup() {
    const saved = process.env.ZCALL_LOG_DIR ? path.join(process.env.ZCALL_LOG_DIR, 'group-init-layout') : null;
    let first = process.env.ZCALL_GROUP_INIT_LAYOUT || '';
    if (!first && saved) try { first = fs.readFileSync(saved, 'utf8').trim(); } catch (_) {}
    const layouts = process.env.ZCALL_GROUP_INIT_LAYOUT ? [first]
      : [...new Set([first, ...GROUP_INIT_LAYOUTS].filter((l) => GROUP_INIT_LAYOUTS.includes(l)))];
    for (const layout of layouts) {
      if (!this.active) return null;
      this.replies = [];
      this.refusals = [];
      const best = await this._initZrtp(buildGroupInitZrtpPacket({
        host: !!this.params.host,
        uid: this.params.localUid || 0,
        sessId: this.params.sessId || '',
        callId: this.params.callId || 0,
        hostCall: this.params.hostCall || 0,
        layout,
      }));
      if (best) {
        this.log(`media: group InitZRTP accepted with layout "${layout}"`);
        if (saved && layout !== first) try { fs.writeFileSync(saved, layout + '\n'); } catch (_) {}
        return best;
      }
      if (!this.refusals.length) return null; // no answer at all: network, not the layout
      this.log(`media: group InitZRTP layout "${layout}" refused: ${this.refusals.map((r) => `res ${r.res} (${r.hex})`).join(', ')}`);
    }
    return null;
  }

  // Send one InitZRTP packet to every server; resolves with the fastest
  // accepting reply { server, token, rttMs, publicAddr }, or null once every
  // server refused (this.refusals) or the tries ran out.
  _initZrtp(packet) {
    this.refusals = [];
    return new Promise((resolve) => {
      let tries = 0;
      const send = () => {
        tries++;
        this.initSentAt = Date.now();
        for (const server of this.servers) {
          if (!this.replies.some((r) => r.server === server)) this._send(packet, server, 'InitZRTP');
        }
      };
      const finish = () => {
        this._onInitReply = null;
        if (!this.replies.length) { this.log(this.refusals.length ? 'media: every server refused InitZRTP' : 'media: no server answered InitZRTP'); resolve(null); return; }
        const best = this.replies.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
        this.activeServer = best.server;
        this.serverToken = best.token;
        this.log(`media: ${this.replies.length}/${this.servers.length} servers answered, best rtt ${best.rttMs} ms`);
        // Group: every cmd 32 / 33 header carries this token. 0 here means the SFU's
        // answer did not hold one where the 1-1 answer has it: the raw reply shows.
        if (this.group) this.log(`media: group InitZRTP reply, token ${best.token >>> 0}: ${best.hex}`);
        resolve(best);
      };
      let waiting = null;
      this._onInitReply = () => {
        if (this.replies.length + this.refusals.length >= this.servers.length) { clearTimeout(waiting); this.timers.delete(waiting); finish(); return; }
        if (!waiting) waiting = this._timer(finish, INIT_WAIT_MS);
      };
      const retry = () => {
        if (!this._onInitReply || this.replies.length || this.refusals.length) return;
        if (tries >= INIT_TRIES) { finish(); return; }
        send();
        this._timer(retry, INIT_RETRY_MS);
      };
      send();
      this._timer(retry, INIT_RETRY_MS);
    });
  }

  // Peer answered: keep its server (rtpSerIp) and start media.
  start(role = 'caller', rtpSerIp = null) {
    this.active = true;
    if (!this.sendUdp) { this.log(`media: start role=${role} (observe-only)`); return; }
    const want = parseHostPort(rtpSerIp);
    const match = want && this.replies.find((r) => r.server.host === want.host && r.server.port === want.port);
    if (match) {
      this.activeServer = match.server;
      this.serverToken = match.token;
    } else if (want) {
      this.log('media: peer chose a server we have no token for; keeping ours');
    }
    if (!this.activeServer) { this.log('media: no server'); this.emit('failed', 'no-server'); return; }
    for (const r of this.replies) if (r.server !== this.activeServer) this._sendEndCall(r.server, r.token);
    this.log('media: started');
    this.startedAt = Date.now();
    this.lastRxAt = Date.now();
    if (this.group) {
      // Members may all be muted: no media timeout, the server's cmd 3 and
      // Zalo's group_end_call end the call.
      // Loopback check of our camera, as for the screen: ask the SFU for our own
      // UID, layer 0. 'video rx member <our uid>' then shows whether it forwards
      // the camera (host or not). Diagnostic, ZCALL_CAM_LOOPBACK=1.
      if (process.env.ZCALL_CAM_LOOPBACK === '1' && this.params.localUid) this.vidWanted.add(this.params.localUid >>> 0);
      this._sendPing();
      this._timer(() => this._sendPing(), GROUP_PING_INTERVAL_MS, true);
      this._timer(() => this._checkGroupKey(), 3000);
      if (this.audioEnabled) this._startAudio();
      return;
    }
    this._timer(() => this._sendPing(), PING_INTERVAL_MS, true);
    this._timer(() => this._sendStatus(), STATUS_INTERVAL_MS, true);
    this._timer(() => this._send(this._fwd(8, Buffer.from([4, 0, 0, 0, 0, 0, 0, 0]), 0), this.activeServer, 'ReqForward'), 200);
    this._timer(() => {
      if (Date.now() - this.lastRxAt > MEDIA_TIMEOUT_MS) { this.log('media: no audio from peer'); this.emit('timeout'); }
    }, 2000, true);
    if (this.rtcp) {
      this._timer(() => this._sendTwcc(), TWCC_INTERVAL_MS, true);
      this._timer(() => this._sendRtcpReports(), RTCP_REPORT_INTERVAL_MS, true);
    }
    if (this.audioEnabled) this._startAudio();
    this._p2pStart();
  }

  // Punch the NAT towards the peer's P2P candidates (IPv4 only for now). The
  // calling phone moves its audio to P2P on its own; without this our NAT
  // drops it and relay audio thins out, then stops (live test 2026-09-30).
  _p2pStart() {
    const cands = (this.params.p2pCandidates || [])
      .map((c, index) => ({ host: c.ip, port: Number(c.port), index }))
      .filter((c) => c.host && /^\d+\.\d+\.\d+\.\d+$/.test(c.host) && c.port > 0);
    if (!cands.length) return;
    const t0 = Date.now();
    const bind = () => {
      if (!this.active || this.p2pPath || Date.now() - t0 > P2P_BIND_GIVE_UP_MS) return;
      for (const c of cands) {
        this._send(buildP2pBind({ role: this.params.role, callId: this.params.callId, seq: this.p2pSeq, index: c.index }), c, 'P2P bind');
      }
      this.p2pSeq++;
      this._timer(bind, Date.now() - t0 < 1000 ? P2P_BIND_FAST_MS : P2P_BIND_SLOW_MS);
    };
    this.log(`media: P2P binding to ${cands.length} candidate(s)`);
    bind();
  }

  _onP2p(msg, rinfo) {
    const from = { host: rinfo.address, port: rinfo.port };
    const kind = msg[7];
    if (!this.p2pSeen) { this.p2pSeen = true; this.log(`media: first P2P packet from the peer (kind ${kind})`); }
    if (kind === P2P.BIND_PEER && msg.length >= 19) {
      const answer = buildP2pBindAnswer({ role: this.params.role, callId: this.params.callId, request: msg, peerAddr: `${rinfo.address}|${rinfo.port}` });
      this._send(answer, from, 'P2P answer');
    } else if (kind === P2P.KEEPALIVE && msg[9] === 1) {
      this._send(buildP2pPong({ role: this.params.role, ping: msg }), from, 'P2P pong');
      this._p2pUp(from);
    } else if (kind === P2P.VIDEO && msg.length > P2P.HEADER_LEN + 12) {
      this._p2pUp(from);
      this._onVideo(msg.subarray(P2P.HEADER_LEN));
    } else if (kind === P2P.VIDEO_RTCP && msg.length > P2P.HEADER_LEN) {
      this._onVideoRtcp(msg.subarray(P2P.HEADER_LEN));
      if (this.rtcp) this.rtcp.onRtcp('video', msg.subarray(P2P.HEADER_LEN), Date.now());
    } else if (kind === P2P.AUDIO_RTCP && msg.length > P2P.HEADER_LEN) {
      if (this.rtcp) this.rtcp.onRtcp('audio', msg.subarray(P2P.HEADER_LEN), Date.now());
    } else if (kind === P2P.AUDIO && msg.length > P2P.HEADER_LEN + 12) {
      this.counters.rxP2p++;
      this._p2pUp(from);
      this._onAudio(msg.subarray(P2P.HEADER_LEN));
    }
  }

  _p2pUp(from) {
    if (this.p2pPath && this.p2pPath.host === from.host && this.p2pPath.port === from.port) return;
    this.p2pPath = from;
    this.log('media: P2P path up');
  }

  // Our P2P candidates for 416/402: host addresses (type 0) on the socket's
  // port, and the public address the server saw in its InitZRTP reply (type 1).
  localCandidates(publicAddr) {
    const out = [];
    const port = this.socket ? this.socket.address().port : 0;
    if (port) {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ ip: a.address, port, type: 0 });
      }
    }
    if (publicAddr && publicAddr.includes('|')) {
      const [ip, p] = publicAddr.split('|');
      out.push({ ip, port: Number(p), type: 1 });
    }
    return out;
  }

  setMute(on) {
    this.muted = !!on;
    if (this.audio) this.audio.stdin.write(Buffer.from([0x4d, on ? 1 : 0]));
  }

  // Speaker off: keep decoding (timing, stats) but play silence.
  setSpeaker(off) {
    this.speakerOff = !!off;
    if (this.audio) this.audio.stdin.write(Buffer.from([0x53, off ? 1 : 0]));
  }

  // Use another microphone (kind 'mic') or speaker ('speaker'); empty name:
  // the system default. Applies at once during a call, else from the next one.
  setDevice(kind, name) {
    if (kind !== 'mic' && kind !== 'speaker') return;
    this.devices[kind] = name || '';
    if (!this.audio) return;
    const n = Buffer.from(name || '', 'utf8');
    const h = Buffer.from([0x44, kind === 'mic' ? 0x69 : 0x6f, n.length >> 8, n.length & 0xff]);
    this.audio.stdin.write(Buffer.concat([h, n]));
  }

  stop() {
    this.stopShare();
    if (this.active && this.params) {
      if (this.activeServer && this.serverToken) this._sendEndCall(this.activeServer, this.serverToken);
      for (const r of this.replies) this._sendEndCall(r.server, r.token);
    }
    if (this.startedAt) this.log('media: stopped', JSON.stringify({ ...this.counters, rxTypes: this.rxTypes, video: this.videoStats, videoTx: this.vTx, keyRequests: this.keyRequests, rtcp: this.rtcp ? this.rtcp.counters : undefined, members: Object.fromEntries(this.members), videoMembers: Object.fromEntries(this.videoMembers) }));
    this.startedAt = 0;
    this.active = false;
    this._onInitReply = null;
    this._clearTimers();
    if (this.audio) {
      try { this.audio.stdin.end(); } catch (_) {}
      const a = this.audio;
      setTimeout(() => { try { a.kill(); } catch (_) {} }, 1000);
      this.audio = null;
    }
    const sock = this.socket;
    this.socket = null;
    if (sock) setTimeout(() => { try { sock.close(); } catch (_) {} }, 100); // let EndCall leave
  }

  stats() {
    return { ...this.counters, durationMs: this.startedAt ? Date.now() - this.startedAt : 0 };
  }

  // Group: the SRTP key is assumed to be the 1-1 one (session[:30] + KDF;
  // GroupCallPeer::createAndInitSRTP uses the same SrtpTransport). Received
  // packets check it: say so in the log either way.
  _checkGroupKey() {
    const { rx, rxBad } = this.counters;
    if (this.plainMedia) this.log(`media: group plain RTP: ${rx} good, ${rxBad} bad, ${this.members.size} member(s) heard`);
    else if (rx) this.log(`media: group SRTP key OK (${rx} good, ${rxBad} bad, ${this.members.size} member(s) heard)`);
    else if (rxBad) this.log(`media: group SRTP key WRONG? ${rxBad} audio packets failed authentication, none passed`);
    else this.log('media: no group audio yet (members muted, or nothing forwarded)');
  }

  _startAudio() {
    const script = path.join(__dirname, '..', 'audio-io.py');
    const args = [script];
    if (this.devices.mic) args.push('--mic', this.devices.mic);
    if (this.devices.speaker) args.push('--speaker', this.devices.speaker);
    if (this.group) args.push('--mix');
    // ZCALL_AUDIO_ARGS replaces the group config (a live override). 1-1 keeps
    // audio-io's own defaults: this capture's 20 kbps / FEC off is the group
    // zrtcConfig, and 1-1 was already working at 32 kbps with FEC.
    // The jitter buffer floor of the server's config (minAudioDelayMs, 80-100 in
    // 1-1 calls), as macOS NetEq; audio-io's default (100) without it.
    const minDelay = Number(this.params.config && this.params.config.minAudioDelayMs);
    if (minDelay > 0) args.push('--min-delay', String(Math.trunc(minDelay)));
    if (process.env.ZCALL_AUDIO_ARGS) args.push(...process.env.ZCALL_AUDIO_ARGS.split(' ').filter(Boolean));
    else if (this.group) {
      const audioArgs = groupAudioArgs(this.params.config);
      if (audioArgs.length) {
        args.push(...audioArgs);
        this.log('media: group audio', audioArgs.join(' '));
      }
    }
    this.audio = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // audio-io's own messages go to the engine log.
    let errBuf = '';
    this.audio.stderr.setEncoding('utf8');
    this.audio.stderr.on('data', (d) => {
      const lines = (errBuf + d).split('\n');
      errBuf = lines.pop();
      for (const l of lines) if (l.trim()) this.log(l.replace(/^\[audio-io\] /, 'audio: '));
    });
    this.audio.on('exit', (code) => this.log('media: audio-io exited', code));
    if (this.muted) this.setMute(true);
    if (this.speakerOff) this.setSpeaker(true);
    this.audio.stdin.on('error', () => {});
    let buf = Buffer.alloc(0);
    this.audio.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      // 'A' u16 len, Opus (older audio-io) or 'L' u8 level, u16 len, Opus.
      for (;;) {
        if (buf.length >= 3 && buf[0] === 0x41) {
          const n = buf.readUInt16BE(1);
          if (buf.length < 3 + n) break;
          this._sendAudioFrame(buf.subarray(3, 3 + n));
          buf = buf.subarray(3 + n);
        } else if (buf.length >= 4 && buf[0] === 0x4c) {
          const n = buf.readUInt16BE(2);
          if (buf.length < 4 + n) break;
          this._sendAudioFrame(buf.subarray(4, 4 + n), buf[1]);
          buf = buf.subarray(4 + n);
        } else break;
      }
    });
  }

  _sendAudioFrame(opus, level = 127) {
    if (!this.active || !this.activeServer || (!this.srtpContext && !this.plainMedia)) return;
    const ssrc = this.params.localUid >>> 0;
    const hdr = (this.group ? buildGroupAudioRtpHeader : buildAudioRtpHeader)({ seq: this.seq, ts: this.ts, ssrc, twSeq: this.twSeq, level });
    const rtp = this.plainMedia ? Buffer.concat([hdr, Buffer.from(opus)])
      : protectRtp(hdr, Buffer.from(opus), this.srtpContext, this.seq, ssrc, this.roc);
    this._send(wrapMediaPacket({ msgType: MSG_TYPES.AUDIO_RTP, token: this.serverToken, payload: rtp }), this.activeServer, 'audio');
    // Same packet over P2P once the peer reached us: it drops duplicates by seq.
    if (this.p2pPath) this._send(wrapP2pAudio({ role: this.params.role, callId: this.params.callId, rtp }), this.p2pPath, 'P2P audio');
    this.counters.tx++;
    this.audioOctets += opus.length;
    this._noteAudioTx();
    this.seq = (this.seq + 1) & 0xffff;
    if (this.seq === 0) this.roc++;
    this.ts = (this.ts + FRAME_SAMPLES) >>> 0;
    this.twSeq = (this.twSeq + 1) & 0xffff;
  }

  // One encoded frame from the call window (H.264 Annex-B). Same RTP layout
  // as the phone's video: SSRC = our UID (shared with audio), 90 kHz clock,
  // PT 98 key / 97 other, transport-cc extension, marker on the last packet.
  // Relay: MsgType 13 with the token (like audio type 3); P2P: kind 8.
  // Until a key frame went out, other frames are useless to the phone: drop
  // them and ask for a key frame ('keyframe' event) instead.
  // Group calls with an empty srtpKey send plain RTP: our H.264 goes out that way
  // (type 13, PT 98/97) with the header of buildGroupVideoRtpHeader. On by default
  // since it works with a phone and the macOS client (2026-10-08);
  // ZCALL_GROUP_CAMERA=0 keeps the camera to ourselves.
  _groupCameraSend() {
    return this.group && this.plainMedia && process.env.ZCALL_GROUP_CAMERA !== '0';
  }

  setGroupCamera(on) { this.groupCameraOn = !!on; }

  sendVideoFrame({ key, data, screen = false, w = 0, h = 0 }) {
    // Group: the screen goes out on the share peer (SSRC = shareScreenId), never in
    // the camera stream, which the phone shows in our own tile.
    if (this.group && screen) { this._sendShareFrame({ key, data, w, h }); return; }
    const groupCam = this._groupCameraSend();
    if (!this.active || !this.activeServer || !this.startedAt) return;
    if (!this.srtpContext && !groupCam) return;
    if (!key && !this.vKeySent) { this.emit('keyframe', 'start'); return; }
    if (key) this.vKeySent = true;
    const ssrc = this.params.localUid >>> 0;
    if (!this.vStart) this.vStart = Date.now();
    const ts = (this.vTsBase + (Date.now() - this.vStart) * 90) >>> 0;
    const chunks = packetizeFrame(data);
    const sfu = groupCam && this.videoPlan && this.videoPlan.sfu;
    const captureMs = Date.now(); // id 13 of every packet of this frame
    chunks.forEach((chunk, i) => {
      const hdrArgs = { seq: this.vSeq, ts, ssrc, twSeq: this.twSeq, marker: i === chunks.length - 1, pt: key ? KEY_PT : DELTA_PT, layerSeq: sfu ? (this.vLayerSeq = (this.vLayerSeq + 1) & 0xffff) : 0, captureMs };
      const hdr = sfu ? buildGroupVideoRtpHeader(Object.assign({ sfu }, hdrArgs)) : buildAudioRtpHeader(hdrArgs);
      const rtp = groupCam ? Buffer.concat([hdr, chunk])
        : protectRtp(hdr, chunk, this.srtpContext, this.vSeq, ssrc, this.vRoc);
      this._send(wrapMediaPacket({ msgType: MSG_TYPES.VIDEO_RTP, token: this.serverToken, payload: rtp }), this.activeServer, 'video');
      if (this.p2pPath) this._send(wrapP2pVideo({ role: this.params.role, callId: this.params.callId, rtp }), this.p2pPath, 'P2P video');
      this.vSeq = (this.vSeq + 1) & 0xffff;
      if (this.vSeq === 0) this.vRoc++;
      this.twSeq = (this.twSeq + 1) & 0xffff;
    });
    this.vTx++;
    if (groupCam && this.vTx === 1) {
      const ext = sfu ? ('SFU id ' + sfu.id + (sfu.long ? ' long' : ' short') + ', layer 0') : 'no SFU extension';
      const head = chunks[0].subarray(0, Math.min(8, chunks[0].length)).toString('hex');
      this.log('media: group camera probe: plain H.264, type 13, PT 98/97, ' + ext + ', payload ' + head);
    }
  }

  // When our 20 ms audio frames really leave (the phone's jitter buffer sees
  // these gaps): one line per 10 s, the longest gap and how many were over
  // 40 / 60 ms. audio-io encodes on the microphone's clock; a busy event loop
  // (video in and out) would show here.
  _noteAudioTx() {
    const w = this.aTxWin;
    const now = Date.now();
    if (w.last) {
      const gap = now - w.last;
      if (gap > w.maxGap) w.maxGap = gap;
      if (gap > 40) w.gaps40++;
      if (gap > 60) w.gaps60++;
    }
    w.last = now;
    w.n++;
    if (now - w.since < AUDIO_TX_LOG_MS) return;
    this.log(`audio tx: ${w.n} frames in ${((now - w.since) / 1000).toFixed(1)} s, max gap ${w.maxGap} ms, gaps >40 ms ${w.gaps40}, >60 ms ${w.gaps60}` +
      (this.p2pPath ? ', relay + P2P' : ', relay'));
    this.aTxWin = { n: 0, last: now, maxGap: 0, gaps40: 0, gaps60: 0, since: now };
  }

  // Group screen share (macOS GroupCallPeer::_startShareScreenPeer -> ShareScreenPeer):
  // a second peer with its own UDP socket and UID = shareScreenId, InitZRTP to the
  // server the call uses, its own token, ZaviPing on the group tick, a one-layer
  // VidQualConfig (sub 12) for that UID, and the screen as plain RTP with
  // SSRC = shareScreenId. The phone opens a tile for the share UID once 12097 lists
  // it (type 1, ownerId = us); until this peer sends, that tile stays black.
  startShare(shareId) {
    shareId >>>= 0;
    if (!this.group || !this.sendUdp || !this.active || !this.activeServer || !shareId) return;
    if (this.share && this.share.uid === shareId) return;
    this.stopShare();
    const sock = dgram.createSocket('udp4');
    const sh = { uid: shareId, sock, token: 0, timers: [], seq: Math.floor(Math.random() * 0x8000), twSeq: 1, layerSeq: 0, ctlSeq: 0,
      keySent: false, queue: [], draining: false, tsBase: Math.floor(Math.random() * 0x7fffffff), start: 0, tx: 0, w: 0, h: 0, cfgLogged: false, unknown: new Set() };
    this.share = sh;
    sock.on('error', (err) => this.log('media: share socket error:', err.message));
    sock.on('message', (msg) => this._onShareMessage(sh, msg));
    const sessId = this.params.sessId || '';
    const init = buildShareInitZrtpPacket({ uid: shareId, sessId });
    let tries = 0;
    const sendInit = () => {
      if (this.share !== sh || sh.token) return;
      if (tries++ >= INIT_TRIES) { this.log('media: share peer: no answer to InitZRTP'); return; }
      this._shareSend(sh, init, 'share InitZRTP');
      sh.timers.push(setTimeout(sendInit, INIT_RETRY_MS));
    };
    this.log(`media: share peer ${shareId}: InitZRTP to ${this.activeServer.host}:${this.activeServer.port}`);
    sendInit();
  }

  stopShare() {
    const sh = this.share;
    if (!sh) return;
    this.share = null;
    if (this.vidWanted.delete(sh.uid)) { this.vidAsked.delete(sh.uid); }
    for (const t of sh.timers) { clearTimeout(t); clearInterval(t); }
    if (sh.token && this.activeServer) {
      this._shareSend(sh, buildEndCallPacket({ uid: sh.uid, token: sh.token, callId: (this.params && this.params.callId) || 0 }), 'share EndCall');
    }
    this.log(`media: share peer ${sh.uid} stopped, ${sh.tx} frame(s) sent`);
    setTimeout(() => { try { sh.sock.close(); } catch (_) {} }, 100);
  }

  _shareSend(sh, packet, what) {
    if (!this.activeServer) return;
    sh.sock.send(packet, this.activeServer.port, this.activeServer.host, (err) => {
      if (err) this.log(`media: ${what} send error:`, err.message);
    });
  }

  _onShareMessage(sh, msg) {
    if (this.share !== sh || !msg.length) return;
    if (msg[0] === MSG_TYPES.VIDEO_FEC && msg.length > 5) { this._onShareRtcp(sh, msg.subarray(5)); return; }
    const p = unwrapPacket(msg);
    if (!p) return;
    if (p.msgType === MSG_TYPES.SERVER_REPLY && (p.cmd === COMMANDS.INIT_CALL_CALLER || p.cmd === COMMANDS.INIT_CALL_CALLEE)) {
      if (sh.token) return;
      if (p.res !== 0 || !p.serverToken) { this.log(`media: share peer InitZRTP refused, res ${p.res}: ${msg.toString('hex')}`); return; }
      sh.token = p.serverToken >>> 0;
      sh.start = Date.now();
      this.log(`media: share peer ${sh.uid} accepted, token ${sh.token}`);
      const tick = () => {
        if (this.share !== sh) return;
        this._shareSend(sh, buildShareZaviPingPacket({ uid: sh.uid, token: sh.token, sessId: this.params.sessId || '' }), 'share ZaviPing');
        this._sendShareVidQualConfig(sh);
      };
      tick();
      sh.timers.push(setInterval(tick, GROUP_PING_INTERVAL_MS));
      this.emit('keyframe', 'share');
      // Loopback check: ask the SFU for our own screen on the main peer, layer 0.
      // What comes back (video rx member <shareId>) shows whether the SFU forwards
      // it and whether it decodes, without another device. Diagnostic, ZCALL_SHARE_LOOPBACK=1.
      if (process.env.ZCALL_SHARE_LOOPBACK === '1') { this.vidWanted.add(sh.uid); this._sendVidQual(); }
      return;
    }
    const key = `${p.msgType}/${p.cmd}/${p.subCmd}`;
    if (sh.unknown.has(key) || sh.unknown.size >= 10) return;
    sh.unknown.add(key);
    this.log(`media: share peer reply type ${p.msgType} cmd ${p.cmd} sub ${p.subCmd}, ${msg.length} bytes: ${msg.subarray(0, Math.min(msg.length, 64)).toString('hex')}`);
  }

  // PLI / FIR for the share SSRC: a key frame of the screen.
  _onShareRtcp(sh, buf) {
    for (let o = 0; o + 12 <= buf.length;) {
      if ((buf[o] >> 6) !== 2) return;
      const len = (buf.readUInt16BE(o + 2) + 1) * 4;
      const fmt = buf[o] & 0x1f;
      if (buf[o + 1] === 206 && (fmt === 1 || (fmt === 4 && o + 16 <= buf.length))) {
        const target = fmt === 1 ? buf.readUInt32BE(o + 8) : buf.readUInt32BE(o + 12);
        if (target === sh.uid) { this.log('media: share peer: key frame request'); this.emit('keyframe', 'share-pli'); }
      }
      o += len;
    }
  }

  // One layer, the size the window encodes the screen at; bitrate in kbps (the
  // camera table's unit), maxShrScreenBr of zrtcConfig (1500 by default).
  _sendShareVidQualConfig(sh) {
    if (!sh.w || !sh.h) return;
    const cfg = (this.params && this.params.config) || {};
    const kbps = Number(cfg.maxShrScreenBr) > 0 ? Math.trunc(Number(cfg.maxShrScreenBr)) : 1500;
    const pkt = buildGroupVidQualConfig({ uid: sh.uid, token: sh.token, seq: sh.ctlSeq++, layers: [{ id: 0, a: kbps, b: sh.w, c: sh.h }] });
    this._shareSend(sh, pkt, 'share VidQualConfig');
    if (!sh.cfgLogged) { sh.cfgLogged = true; this.log(`media: share VidQualConfig ${sh.w}x${sh.h} ${kbps} kbps: ${pkt.toString('hex')}`); }
  }

  // A screen key frame is tens of packets. Sent in one burst the SFU or the path
  // loses some, and with no retransmission the picture never decodes. Out in
  // groups of SHARE_BURST, one group per millisecond tick.
  _drainShare(sh) {
    if (sh.draining) return;
    sh.draining = true;
    const step = () => {
      if (this.share !== sh) { sh.queue.length = 0; sh.draining = false; return; }
      for (const pkt of sh.queue.splice(0, SHARE_BURST)) this._shareSend(sh, pkt, 'share video');
      if (sh.queue.length) setTimeout(step, 1); else sh.draining = false;
    };
    step();
  }

  _sendShareFrame({ key, data, w, h }) {
    const sh = this.share;
    if (!sh || !sh.token) return;
    if (w > 0 && h > 0 && (w !== sh.w || h !== sh.h)) { sh.w = w; sh.h = h; this._sendShareVidQualConfig(sh); }
    if (!key && !sh.keySent) { this.emit('keyframe', 'share-start'); return; }
    if (key) sh.keySent = true;
    const ts = (sh.tsBase + (Date.now() - sh.start) * 90) >>> 0;
    const sfu = (this.videoPlan && this.videoPlan.sfu) || { id: 12, long: false };
    const chunks = packetizeFrame(data);
    const captureMs = Date.now();
    chunks.forEach((chunk, i) => {
      const hdr = buildGroupVideoRtpHeader({ captureMs, sfu, seq: sh.seq, ts, ssrc: sh.uid, twSeq: sh.twSeq, marker: i === chunks.length - 1, pt: key ? KEY_PT : DELTA_PT, layerSeq: (sh.layerSeq = (sh.layerSeq + 1) & 0xffff) });
      sh.queue.push(wrapMediaPacket({ msgType: MSG_TYPES.VIDEO_RTP, token: sh.token, payload: Buffer.concat([hdr, chunk]) }));
      sh.seq = (sh.seq + 1) & 0xffff;
      sh.twSeq = (sh.twSeq + 1) & 0xffff;
    });
    this._drainShare(sh);
    sh.tx++;
    if (sh.tx === 1) this.log(`media: share peer first frame (${key ? 'key' : 'delta'}, ${w}x${h}, ${chunks.length} packet(s))`);
  }

  // One RTCP compound: relay (MsgType 5 audio / 0x0F video, 5-byte header) and, once the
  // peer reached us directly, P2P (kind 7 / 9) as well, like the audio and video RTP.
  _sendRtcp(video, rtcp) {
    if (!this.active || !this.activeServer || !this.startedAt) return;
    this._send(wrapMediaPacket({ msgType: video ? MSG_TYPES.VIDEO_FEC : MSG_TYPES.AUDIO_FEC, token: this.serverToken, payload: rtcp }), this.activeServer, 'RTCP');
    if (this.p2pPath) this._send(wrapP2pRtcp({ role: this.params.role, callId: this.params.callId, video, rtcp }), this.p2pPath, 'P2P RTCP');
  }

  // Transport-wide feedback for everything the phone sent (audio + video share one
  // sequence space): what its send-side bandwidth estimator lives on.
  _sendTwcc() {
    if (!this.rtcp) return;
    for (const pk of this.rtcp.twccPackets()) this._sendRtcp(false, pk);
  }

  _sendRtcpReports() {
    if (!this.rtcp) return;
    const now = Date.now();
    this._sendRtcp(false, this.rtcp.audioReport(now, { rtpTs: this.ts, packets: this.counters.tx, octets: this.audioOctets }));
    const v = this.rtcp.videoReport(now);
    if (v) this._sendRtcp(true, v);
    if (now - this.rtcpLoggedAt >= RTCP_LOG_MS) {
      this.rtcpLoggedAt = now;
      const c = this.rtcp.counters;
      const b = this.rtcp.video.started ? this.rtcp.video.block(now) : null;
      this.log(`rtcp: sent twcc ${c.twcc}, reports ${c.reports}, pli ${c.pli}` + (b ? `; video from phone: ${this.rtcp.video.received} pkts, lost ${b.cumLost}, jitter ${b.jitter}` : ''));
    }
  }

  // Ask the phone for a key frame (the picture broke: a hole in the stream, or the
  // decoder gave up). PLI on the video RTCP channel, at most once a second.
  requestPeerKeyFrame(why) {
    if (!this.rtcp) return;
    const now = Date.now();
    if (now - this.lastPliAt < PLI_MIN_GAP_MS) return;
    const pli = this.rtcp.pli();
    if (!pli) return;
    this.lastPliAt = now;
    this._sendRtcp(true, pli);
    this.log('rtcp: PLI to the phone (' + why + ')');
  }

  _initSocket() {
    if (this.socket || !this.sendUdp) return;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => this._onUdpMessage(msg, rinfo));
    this.socket.on('error', (err) => this.log('media: socket error:', err.message));
  }

  _send(packet, server, what) {
    if (!this.socket || !server) return;
    this.socket.send(packet, server.port, server.host, (err) => {
      if (err) this.log(`media: ${what} send error:`, err.message);
    });
  }

  _fwd(subCmd, payload, seq) {
    return buildReqForwardPacket({ uid: this.params.localUid || 0, token: this.serverToken, seq, subCmd, payload });
  }

  _sendStatus() {
    const rx = this.counters.rxSecond;
    this.counters.rxSecond = 0;
    this._send(this._fwd(10, reqForwardStatus(rx), this.fwdSeq++), this.activeServer, 'ReqForward');
  }

  // Ask the SFU for each member we are watching. qualityId 0xff is what
  // getVideoQualityIdReceiving returns when the layer table is empty
  // (VideoQuality 0). No capture has shown another id. Sent again on the
  // ZaviPing tick so a member who starts late is still requested.
  _noteVideoMember(ssrc) {
    const uid = ssrc >>> 0;
    if (!uid || uid === ((this.params && this.params.localUid) >>> 0)) return;
    if (this.vidWanted.has(uid)) return;
    this.vidWanted.add(uid);
    this._sendVidQual();
  }

  // Our send layers. _monitorCall sends this whenever the table is non-empty.
  // The ZaviPing tick is the Linux stand-in for that loop. No extension id
  // yet, so the camera encodes only layer 0 (videoPlan.encode).
  _sendVidQualConfig() {
    const plan = this.videoPlan;
    if (!this.group || !this.activeServer || !plan || !plan.layers.length) return;
    // Only the layer the window encodes. With 0 / 3 / 6 announced the phone asked
    // for 3 (its tile is wider than layer 0), which we never send, and our tile
    // froze on the first picture (live 2026-10-08 17:25). The share peer, one layer,
    // was asked for 0 at once.
    const layers = plan.send || plan.layers.filter((L) => L.id === 0);
    const pkt = buildGroupVidQualConfig({
      uid: this.params.localUid || 0, token: this.serverToken, seq: this.ctlSeq++, layers,
    });
    this._send(pkt, this.activeServer, 'VidQualConfig');
    if (!this.vidCfgLogged) {
      this.vidCfgLogged = true;
      const e = plan.encode;
      this.log(`media: VidQualConfig ${layers.length} layer(s), encode ${e.width}x${e.height} ${e.bitrate} bps ${e.fps} fps: ${pkt.toString('hex')}`);
    }
  }

  _sendVidQual() {
    if (!this.group || !this.activeServer || !this.vidWanted.size) return;
    const entries = [...this.vidWanted].map((uid) => ({ uid, qualityId: this.qualityIdFor(uid) }));
    this._send(buildGroupVidQualReq({
      uid: this.params.localUid || 0, token: this.serverToken, seq: this.ctlSeq++, entries,
    }), this.activeServer, 'VidQual');
    for (const e of entries) {
      if (this.vidAsked.get(e.uid) === e.qualityId) continue;
      this.vidAsked.set(e.uid, e.qualityId);
      this.log(`media: VidQualReq member ${e.uid}: quality id 0x${e.qualityId.toString(16)}` + (this.renderWidth.has(e.uid) ? `, tile ${this.renderWidth.get(e.uid)} px` : ', tile size unknown'));
    }
  }

  // Which layer of a member to ask the SFU for. macOS GroupCallController::
  // getVideoQualityIdReceiving(uid, renderWidth) (disassembled 2026-10-07): walk the
  // partner's layers from the top and take the first whose width <= the tile's width,
  // layer 0 at the least; id = spatial * 3 + temporal, so the best frame rate of the
  // chosen size. Without the partner's own table we use the call's (same zrtc_config)
  // and its narrower side as the width, which a portrait phone camera really has: a
  // landscape sender gets a layer that is bigger than it needs, never smaller.
  // 0xff (what the engine always sent before) stays until the window reported the tile.
  qualityIdFor(uid) {
    if (this.share && (uid >>> 0) === this.share.uid) return 0; // our own screen, loopback check
    if (process.env.ZCALL_CAM_LOOPBACK === '1' && (uid >>> 0) === ((this.params && this.params.localUid) >>> 0)) return 0; // our own camera, loopback check
    const plan = this.videoPlan;
    const w = this.renderWidth.get(uid);
    if (process.env.ZCALL_GROUP_QUALITY === '0' || !plan || !plan.layers.length || !w) return 0xff;
    let pick = plan.layers[0];
    for (const L of plan.layers) if (Math.min(L.b, L.c) <= w) pick = L;
    return pick.id & 0xff;
  }

  // The window drew (or resized) the tile of this member.
  setMemberRenderWidth(uid, width) {
    uid >>>= 0;
    width = Math.max(0, Math.round(Number(width) || 0));
    if (!uid || !this.group || this.renderWidth.get(uid) === width) return;
    this.renderWidth.set(uid, width);
    if (this.vidWanted.has(uid) && this.qualityIdFor(uid) !== this.vidAsked.get(uid)) this._sendVidQual();
  }

  _sendPing() {
    if (this.group) {
      const uid = this.params.localUid || 0;
      const videoOn = this._groupCameraSend() && this.groupCameraOn;
      this._send(buildZaviPingPacket({ uid, token: this.serverToken, sessId: this.params.sessId || '', videoOn }), this.activeServer, 'ZaviPing');
      this._sendVidQual();
      this._sendVidQualConfig();
      return;
    }
    const packet = buildPingPacket({ uid: this.params.localUid || 0, token: this.serverToken, sessId: this.params.sessId || '' });
    this._send(packet, this.activeServer, 'Ping');
  }

  _sendEndCall(server, token) {
    const key = `${server.host}:${server.port}`;
    if (this.ended.has(key)) return;
    this.ended.add(key);
    this._send(buildEndCallPacket({ uid: this.params.localUid || 0, token, callId: this.params.callId || 0 }), server, 'EndCall');
  }

  _onUdpMessage(msg, rinfo) {
    if (msg.length) this.rxTypes[msg[0]] = (this.rxTypes[msg[0]] || 0) + 1;
    // P2P media straight from the peer (7f | u16 dir | u32 token | u8 kind | 00 | SRTP).
    // When the phone calls us it sends much of its audio this way even though
    // we announce sP2P 0; kind 6 = audio, same SRTP keys and sequence as relay.
    if (msg[0] === MSG_TYPES.P2P_EXT) {
      if (this.active && this.params) this._onP2p(msg, rinfo);
      return;
    }
    // RTCP video (plaintext, 5-byte header): the peer's key frame requests.
    if (msg[0] === MSG_TYPES.VIDEO_FEC && msg.length > 5) {
      if (this.active && this.startedAt) { this._onVideoRtcp(msg.subarray(5)); if (this.rtcp) this.rtcp.onRtcp('video', msg.subarray(5), Date.now()); }
      return;
    }
    // RTCP audio (plaintext): the phone's SR, whose time our reports echo back (LSR / DLSR).
    if (msg[0] === MSG_TYPES.AUDIO_FEC && msg.length > 5) {
      if (this.active && this.startedAt && this.rtcp) this.rtcp.onRtcp('audio', msg.subarray(5), Date.now());
      return;
    }
    const p = unwrapPacket(msg);
    if (!p) return;
    if (p.msgType === MSG_TYPES.SERVER_REPLY && (p.cmd === COMMANDS.INIT_CALL_CALLER || p.cmd === COMMANDS.INIT_CALL_CALLEE)) {
      const server = this.servers.find((s) => s.host === rinfo.address && s.port === rinfo.port);
      if (!server || this.replies.some((r) => r.server === server)) return;
      if (p.res !== 0) {
        if (this.refusals.some((r) => r.server === server)) return;
        this.log('media: InitZRTP refused, res =', p.res, 'reply', msg.toString('hex'));
        this.refusals.push({ server, res: p.res, hex: msg.subarray(18).toString('hex') });
        if (this._onInitReply) this._onInitReply();
        return;
      }
      this.replies.push({ server, token: p.serverToken, rttMs: Date.now() - this.initSentAt, publicAddr: p.publicAddr, hex: msg.toString('hex') });
      if (this._onInitReply) this._onInitReply();
      return;
    }
    if (this.group && p.msgType === MSG_TYPES.SERVER_REPLY && (p.cmd === COMMANDS.END_CALL || p.cmd === COMMANDS.ROOM_UPDATED)) {
      if (this.active && this.startedAt) this._onGroupControl(p);
      return;
    }
    // The server tells us the peer hung up (seen 20 ms before control end_call).
    if (p.msgType === MSG_TYPES.SERVER_REPLY && p.cmd === COMMANDS.END_CALL) {
      if (this.active && this.startedAt) this.emit('peerEnd');
      return;
    }
    if (p.isMedia && p.msgType === MSG_TYPES.AUDIO_RTP_DOWN) this._onAudio(p.payload);
    else if (p.isMedia && p.msgType === MSG_TYPES.VIDEO_DOWN) this._onVideo(p.payload);
    else if (this.group && !p.isMedia && p.cmd === COMMANDS.REQ_FORWARD && p.subCmd === 0x0d) this._onMemberVidQualReq(msg);
    else if (this.group && !p.isMedia) this._noteUnknownReply(p, msg);
  }

  // cmd 32 sub 13 relayed from another member: the layer that member asks the SFU
  // for, per sender (u8 count, then u32 LE uid + u8 qualityId). 0xff = do not send
  // me this sender's video (macOS getVideoQualityIdReceiving: tile width 0, or no
  // layer table for that sender). Logged whenever a member's request changes.
  _onMemberVidQualReq(msg) {
    if (msg.length < 24) return;
    const from = msg.readUInt32LE(10);
    const n = msg[23];
    const asks = [];
    for (let i = 0, o = 24; i < n && o + 5 <= msg.length; i++, o += 5) {
      asks.push(`${msg.readUInt32LE(o)}=0x${msg[o + 4].toString(16)}`);
    }
    const line = asks.join(' ');
    if (this.memberAsks.get(from) === line) return;
    this.memberAsks.set(from, line);
    this.log(`media: member ${from} asks the SFU for: ${line || '(nothing)'}`);
  }

  // Compound RTCP: PSFB (206) fmt 1 PLI / fmt 4 FIR aimed at our SSRC (= our UID).
  _onVideoRtcp(buf) {
    const ours = (this.params && this.params.localUid) >>> 0;
    for (let o = 0; o + 12 <= buf.length;) {
      if ((buf[o] >> 6) !== 2) return;
      const len = (buf.readUInt16BE(o + 2) + 1) * 4;
      const fmt = buf[o] & 0x1f;
      if (buf[o + 1] === 206 && (fmt === 1 || (fmt === 4 && o + 16 <= buf.length))) {
        const target = fmt === 1 ? buf.readUInt32BE(o + 8) : buf.readUInt32BE(o + 12);
        if (target === ours) {
          this.keyRequests++;
          this.emit('keyframe', fmt === 1 ? 'pli' : 'fir');
        }
      }
      o += len;
    }
  }

  // Received video: decrypt (own ROC: same SSRC as audio), then hand the
  // RTP payload on. Stats + optional dump (ZCALL_DUMP_VIDEO=1) for analysis.
  _onVideo(rtp) {
    if ((!this.srtpContext && !this.plainMedia) || rtp.length < 12) return;
    const seq = rtp.readUInt16BE(2);
    // Group: one stream per member (SSRC), each with its own ROC.
    let tracker = this.videoRoc;
    if (this.group) {
      const ssrc = rtp.readUInt32BE(8);
      tracker = this.videoRocs.get(ssrc);
      if (!tracker) { tracker = new RocTracker(); this.videoRocs.set(ssrc, tracker); }
    }
    const roc = tracker.guess(seq);
    let got = null;
    if (this.plainMedia) {
      const p = (rtp[0] >> 6) === 2 ? parseRtp(rtp) : null;
      if (p && p.payload.length) got = { seq: p.seq, ssrc: p.ssrc, opus: p.payload };
    } else got = unprotectRtp(rtp, this.srtpContext, roc);
    const v = this.videoStats;
    v.pkts++;
    if (!got) { v.bad++; return; }
    tracker.update(seq, roc);
    this.lastRxAt = Date.now();
    if (this.rtcp) this.rtcp.onRtp('video', rtp, this.lastRxAt);
    if (this.group) {
      // What the group packetization looks like (not captured before):
      // PTs and the first payload bytes, per member.
      let m = this.videoMembers.get(got.ssrc);
      if (!m) {
        m = { pkts: 0, pt: {}, head: {} };
        this.videoMembers.set(got.ssrc, m);
        this.log('media: first video from member', got.ssrc, 'PT', rtp[1] & 0x7f);
        // The phone's own uplink is the packet the SFU already accepted. One
        // line of the RTP header (extension included) so the next call can be
        // compared with the 24-byte id-12 header we send. Not parsed here.
        this.log('media: first video rtp', rtp.subarray(0, Math.min(40, rtp.length)).toString('hex'));
      }
      m.pkts++;
      this._noteMemberRtpExt(got.ssrc, m, rtp);
      m.pt[rtp[1] & 0x7f] = (m.pt[rtp[1] & 0x7f] || 0) + 1;
      const hd = got.opus.subarray(0, got.opus[0] === 0x1c ? 2 : 5).toString('hex');
      if (Object.keys(m.head).length < 12 || m.head[hd]) m.head[hd] = (m.head[hd] || 0) + 1;
    }
    const pt = rtp[1] & 0x7f;
    const marker = !!(rtp[1] & 0x80);
    const ts = rtp.readUInt32BE(4);
    v.pt[pt] = (v.pt[pt] || 0) + 1;
    if (marker) v.marker++;
    const head = got.opus.subarray(0, 2).toString('hex');
    v.head[head] = (v.head[head] || 0) + 1;
    if (v.pkts === 1) this.log(`media: first video from peer (PT ${pt})`);
    if (process.env.ZCALL_DUMP_VIDEO && process.env.ZCALL_LOG_DIR) {
      // record: u32 len, u16 seq, u32 ts, u8 pt|marker<<7, payload
      const h = Buffer.alloc(11);
      h.writeUInt32BE(got.opus.length + 7, 0);
      h.writeUInt16BE(seq, 4);
      h.writeUInt32BE(ts, 6);
      h[10] = pt | (marker ? 0x80 : 0);
      try { fs.appendFileSync(require('path').join(process.env.ZCALL_LOG_DIR, this.group ? `video-dump-${got.ssrc}.bin` : 'video-dump.bin'), Buffer.concat([h, got.opus])); } catch (_) {}
    }
    this.emit('video', { seq, ts, pt, marker, payload: got.opus, roc, ssrc: got.ssrc });
    if (this.group) this._noteVideoMember(got.ssrc);
  }

  // Group: the one-byte RTP header extensions of a member's video as the SFU
  // forwards it. Each new id 12 / 14 (SFU) value is logged with the PT and marker of
  // its packet, at most 16 per member, so the next call shows what the layer bytes
  // of a sender the SFU accepts look like on key and delta frames.
  _noteMemberRtpExt(ssrc, m, rtp) {
    if (!(rtp[0] & 0x10) || rtp.length < 16 || rtp.readUInt16BE(12) !== 0xbede) return;
    const end = Math.min(rtp.length, 16 + rtp.readUInt16BE(14) * 4);
    const ids = [];
    let sfu = null;
    for (let o = 16; o < end;) {
      if (rtp[o] === 0) { o++; continue; }
      const id = rtp[o] >> 4;
      const len = (rtp[o] & 0x0f) + 1;
      if (id === 15 || o + 1 + len > end) break;
      ids.push(id);
      if (id === 12 || id === 14) sfu = rtp.subarray(o + 1, o + 1 + len).toString('hex');
      o += 1 + len;
    }
    if (!m.sfu) {
      m.sfu = new Set();
      this.log(`media: member ${ssrc} video extension ids ${ids.join(',')}`);
    }
    if (sfu === null || m.sfu.has(sfu) || m.sfu.size >= 16) return;
    m.sfu.add(sfu);
    this.log(`media: member ${ssrc} SFU ext ${sfu} (PT ${rtp[1] & 0x7f}${rtp[1] & 0x80 ? ', marker' : ''}, packet ${m.pkts})`);
  }

  // Group: what else the server sends (the partners' layer tables, the answer to our
  // quality requests, screen share streams are not captured yet). One line per kind.
  _noteUnknownReply(p, msg) {
    const key = `${p.msgType}/${p.cmd}/${p.subCmd}`;
    if (this.unknownReplies.has(key) || this.unknownReplies.size >= 30) return;
    this.unknownReplies.add(key);
    this.log(`media: server reply type ${p.msgType} cmd ${p.cmd} sub ${p.subCmd}, ${msg.length} bytes: ${msg.subarray(0, Math.min(msg.length, 64)).toString('hex')}`);
  }

  // GroupCallController::handleZRTPPacket: cmd 50 = the UIDs in the room
  // (header UID = ours); cmd 3 = someone left, header UID = who, subCmd =
  // reason. Our own UID: subCmd 1 the host ended the meeting, 2 we were kicked.
  _onGroupControl(p) {
    const ours = (this.params.localUid || 0) >>> 0;
    if (p.cmd === COMMANDS.ROOM_UPDATED) {
      if (p.uid !== ours) return;
      const uids = parseRoomUpdated(p.data);
      if (!uids) return;
      this.log('media: room', uids.join(','));
      this.emit('roster', uids.filter((u) => u && u !== ours));
      return;
    }
    if (p.uid === ours) {
      // Reason 0 / 0x62 about ourselves is not acted on by the real engine
      // (only 1 and 2 are); 0x62 came ~60 s into the live test of 2026-10-01.
      if (p.subCmd !== 1 && p.subCmd !== 2) { this.log('media: CMD_CLOSE about us, reason', p.subCmd, '(ignored, as ZaloCall)'); return; }
      this.log('media: removed from the room, reason', p.subCmd);
      this.emit('peerEnd', p.subCmd === 2 ? 'kicked' : 'host-ended');
    } else {
      this.log('media: member left', p.uid, 'reason', p.subCmd);
      this.emit('memberLeft', p.uid, p.subCmd);
    }
  }

  _onAudio(rtp) {
    if ((!this.srtpContext && !this.plainMedia) || rtp.length < 12) return;
    const seq = rtp.readUInt16BE(2);
    let tracker = this.rxRoc;
    if (this.group) {
      const ssrc = rtp.readUInt32BE(8);
      tracker = this.rxRocs.get(ssrc);
      if (!tracker) { tracker = new RocTracker(); this.rxRocs.set(ssrc, tracker); }
    }
    const roc = tracker.guess(seq);
    let got = null;
    if (this.plainMedia) {
      const p = (rtp[0] >> 6) === 2 ? parseRtp(rtp) : null;
      if (p && p.payload.length) got = { seq: p.seq, ssrc: p.ssrc, opus: p.payload };
    } else got = unprotectRtp(rtp, this.srtpContext, roc);
    if (!got) { this.counters.rxBad++; return; }
    tracker.update(seq, roc);
    if (this.group) {
      const n = (this.members.get(got.ssrc) || 0) + 1;
      this.members.set(got.ssrc, n);
      if (n === 1) { this.log('media: first audio from member', got.ssrc); this.emit('memberAudio', got.ssrc); }
    }
    if (this.rtcp) this.rtcp.onRtp('audio', rtp, Date.now());
    this.counters.rx++;
    this.counters.rxSecond++;
    this.lastRxAt = Date.now();
    if (this.counters.rx === 1) this.log('media: first audio from peer');
    if (typeof this.onAudioPacket === 'function') this.onAudioPacket(got.opus, this.srtpContext);
    if (this.audio) {
      const h = Buffer.alloc(11);
      h[0] = 0x46;
      h.writeUInt32BE((roc * 0x10000 + seq) >>> 0, 1);
      h.writeUInt32BE(got.ssrc >>> 0, 5);
      h.writeUInt16BE(got.opus.length, 9);
      this.audio.stdin.write(Buffer.concat([h, got.opus]));
    }
  }
}

// Group encoder flags from the same zrtcConfig macOS reads. Absent keys keep
// audio-io's defaults. audioBitrate is kbps (fromJson stores it as given).
function groupAudioArgs(config) {
  const c = config && typeof config === 'object' ? config : {};
  const args = [];
  const br = Number(c.audioBitrate);
  if (br > 0) args.push('--bitrate', String(Math.trunc(br) * 1000));
  if (c.opusComplex !== undefined && c.opusComplex !== null && Number.isFinite(Number(c.opusComplex)) && Number(c.opusComplex) >= 0) {
    args.push('--complexity', String(Math.trunc(Number(c.opusComplex))));
  }
  if (c.audioFecInband === false) args.push('--no-fec');
  if (c.audioHighPassFilter === false) args.push('--no-high-pass');
  return args;
}

module.exports = { ZrtcMediaBackend, parseHostPort, groupAudioArgs };
