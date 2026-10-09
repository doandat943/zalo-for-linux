'use strict';
// 1-1 calls: which rung of the server's video ladder our camera is sent at.
//
// The server gives every call a ladder (zrtc_config.bwProfiles, call 2026-10-08):
//   id 1 240p  8 fps   30 kbps   id 4 360p 20 fps 500 kbps   id 7 720p 24 fps 1100 kbps
//   id 2 240p 10 fps  100 kbps   id 5 360p 24 fps 700 kbps
//   id 3 360p 15 fps  300 kbps   id 6 480p 24 fps 900 kbps
// and the bounds maxWidth / maxHeight (1280x720), codecMaxFps (24), maxBitrate
// (1500), keyFrameIntervalMs (0: key frames only when the phone asks).
// macOS ZaloCall moves on that ladder with webrtc's send-side estimator
// (GoogCc, loss and delay based). Here only the loss part, with the server's own
// thresholds bweSendSideHighLoss (10 %) and bweSendSideLowLoss (2 %): more loss
// than the high mark steps down at once, a few seconds under the low mark step up.
// The loss is what the phone reports about our packets: transport-cc feedback
// (RTPFB fmt 15, every packet we sent carries a transport-wide sequence number)
// or else the fraction lost of its report blocks about our SSRC.
// Without any feedback the start rung is kept: 360p 20 fps 500 kbps, the bitrate
// the window used before (proven on the phone), at the server's frame rate.

const { parseTwcc } = require('./rtcp');

// Landscape sizes of a camera rung (res = the shorter side). 848, not 854: a
// multiple of 16 for the encoder.
const SIZES = { 240: [426, 240], 360: [640, 360], 480: [848, 480], 720: [1280, 720] };
const DEFAULT_LADDER = [
  { id: 1, res: 240, fps: 8, bitrate: 30 }, { id: 2, res: 240, fps: 10, bitrate: 100 },
  { id: 3, res: 360, fps: 15, bitrate: 300 }, { id: 4, res: 360, fps: 20, bitrate: 500 },
  { id: 5, res: 360, fps: 24, bitrate: 700 }, { id: 6, res: 480, fps: 24, bitrate: 900 },
  { id: 7, res: 720, fps: 24, bitrate: 1100 },
];
const START_KBPS = 500;
const MIN_KBPS = 100; // below this (id 1: 8 fps, 30 kbps) the picture is useless; keep id 2
const SAFETY_KEY_MS = 10000; // keyFrameIntervalMs 0: a key frame now and then anyway, in case a PLI is lost
const DOWN_GAP_MS = 2000; // vidBweMinResetMs: one step down per 2 s at most
const UP_HOLD_S = 4; // seconds in a row under the low loss mark before a step up
const MIN_TWCC_PACKETS = 10; // a second of feedback that covers fewer packets says nothing
const LOG_MS = 5000;

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

class SendRate {
  constructor(config = {}, { localSsrc, log = () => {}, onProfile = () => {}, now = () => Date.now() } = {}) {
    const c = config && typeof config === 'object' ? config : {};
    this.localSsrc = localSsrc >>> 0;
    this.log = log;
    this.onProfile = onProfile;
    this.now = now;
    const maxW = num(c.maxWidth, 1280), maxH = num(c.maxHeight, 720);
    const maxFps = num(c.codecMaxFps, 24), maxKbps = num(c.maxBitrate, 1500);
    const src = Array.isArray(c.bwProfiles) && c.bwProfiles.length ? c.bwProfiles : DEFAULT_LADDER;
    this.ladder = src
      .map((p) => ({ id: p.id, res: Number(p.res), fps: Math.min(num(p.fps, 15), maxFps), kbps: Number(p.bitrate) }))
      .filter((p) => SIZES[p.res] && p.kbps >= MIN_KBPS && p.kbps <= maxKbps && SIZES[p.res][0] <= maxW && SIZES[p.res][1] <= maxH)
      .sort((a, b) => a.kbps - b.kbps);
    if (!this.ladder.length) this.ladder = DEFAULT_LADDER.filter((p) => p.kbps >= MIN_KBPS).map((p) => ({ ...p, kbps: p.bitrate }));
    let start = 0;
    this.ladder.forEach((p, i) => { if (p.kbps <= START_KBPS) start = i; });
    if (process.env.ZCALL_VIDEO_RUNG) {
      const i = this.ladder.findIndex((p) => String(p.id) === process.env.ZCALL_VIDEO_RUNG);
      if (i >= 0) start = i;
    }
    this.fixed = process.env.ZCALL_VIDEO_ADAPT === '0';
    this.level = start;
    this.highLoss = num(c.bweSendSideHighLoss, 10) / 100;
    this.lowLoss = num(c.bweSendSideLowLoss, 2) / 100;
    this.keyMs = num(c.keyFrameIntervalMs, SAFETY_KEY_MS);
    // The camera must be captured big enough for the top rung (else it is upscaled).
    this.captureBig = this.ladder.some((p) => SIZES[p.res][0] > 640);
    this.win = this._newWindow();
    this.types = {}; // RTCP from the phone, "PT/fmt" -> count, since the last log line
    this.good = 0;
    this.lastDownAt = 0;
    this.lastLogAt = 0;
    this.history = []; // loss per second since the last log line (%), null = no feedback
    this.totals = { twccPkts: 0, twccLost: 0, rrBlocks: 0, changes: 0 };
    this.log(`send-rate: ladder ${this.ladder.map((p) => `${p.id}:${p.res}p${p.fps}/${p.kbps}k`).join(' ')}, start ${this._name()}, ` +
      `loss marks ${this.lowLoss * 100}..${this.highLoss * 100} %, key every ${this.keyMs} ms` + (this.fixed ? ', adaptation OFF (ZCALL_VIDEO_ADAPT=0)' : ''));
    this.onProfile(this.profile());
  }

  _newWindow() { return { twccRecv: 0, twccLost: 0, rr: [] }; }

  _name(p = this.ladder[this.level]) { return `id ${p.id} ${SIZES[p.res][0]}x${SIZES[p.res][1]} ${p.fps} fps ${p.kbps} kbps`; }

  // What the window encodes: the exact size (cut from the camera), fps, bitrate, key interval.
  profile() {
    const p = this.ladder[this.level];
    const [width, height] = SIZES[p.res];
    return { width, height, fps: p.fps, bitrate: p.kbps * 1000, keyMs: this.keyMs, captureBig: this.captureBig, rung: p.id };
  }

  // Compound RTCP from the phone (either channel).
  onRtcp(kind, buf) {
    for (let o = 0; o + 4 <= buf.length;) {
      if ((buf[o] >> 6) !== 2) return;
      const len = (buf.readUInt16BE(o + 2) + 1) * 4;
      if (o + len > buf.length) return;
      const pt = buf[o + 1], fmt = buf[o] & 0x1f;
      const key = `${kind[0]}${pt}/${fmt}`;
      this.types[key] = (this.types[key] || 0) + 1;
      const pkt = buf.subarray(o, o + len);
      if (pt === 205 && fmt === 15) {
        const fb = parseTwcc(pkt);
        if (fb && fb.senderSsrc !== this.localSsrc) {
          for (const st of fb.status) { if (st === 0) this.win.twccLost++; else this.win.twccRecv++; }
        }
      } else if (pt === 200 || pt === 201) {
        const first = pt === 200 ? 28 : 8;
        for (let i = 0; i < fmt; i++) {
          const b = first + 24 * i;
          if (b + 24 > len) break;
          if (pkt.readUInt32BE(b) >>> 0 === this.localSsrc) this.win.rr.push(pkt[b + 4] / 256);
        }
      }
      o += len;
    }
  }

  // Once a second (the RTCP report timer). sending: our camera is on and encoding.
  tick(sending = true) {
    const now = this.now();
    const w = this.win;
    this.win = this._newWindow();
    const total = w.twccRecv + w.twccLost;
    this.totals.twccPkts += total; this.totals.twccLost += w.twccLost; this.totals.rrBlocks += w.rr.length;
    let loss = null, src = '';
    if (total >= MIN_TWCC_PACKETS) { loss = w.twccLost / total; src = 'twcc'; }
    else if (w.rr.length) { loss = Math.max(...w.rr); src = 'rr'; }
    this.history.push(loss === null ? null : Math.round(loss * 1000) / 10);
    if (!this.fixed && sending && loss !== null) {
      if (loss > this.highLoss) {
        this.good = 0;
        if (this.level > 0 && now - this.lastDownAt >= DOWN_GAP_MS) { this.lastDownAt = now; this._set(this.level - 1, `loss ${(loss * 100).toFixed(1)} % (${src}) > ${this.highLoss * 100} %`); }
      } else if (loss < this.lowLoss) {
        if (++this.good >= UP_HOLD_S && this.level < this.ladder.length - 1) { this.good = 0; this._set(this.level + 1, `loss under ${this.lowLoss * 100} % (${src}) for ${UP_HOLD_S} s`); }
      } else this.good = 0;
    }
    if (now - this.lastLogAt >= LOG_MS) {
      this.lastLogAt = now;
      const types = Object.entries(this.types).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
      this.types = {};
      this.log(`send-rate: ${this._name()}${sending ? '' : ' (camera off)'}; loss %/s [${this.history.map((x) => (x === null ? '-' : x)).join(' ')}]; rtcp from phone ${types}`);
      this.history = [];
    }
  }

  _set(level, why) {
    const from = this._name();
    this.level = level;
    this.totals.changes++;
    this.log(`send-rate: ${from} -> ${this._name()} (${why})`);
    this.onProfile(this.profile());
  }
}

module.exports = { SendRate, SIZES, DEFAULT_LADDER };
