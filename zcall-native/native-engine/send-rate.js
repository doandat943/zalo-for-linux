'use strict';
// 1-1 calls: which rung of the server's video ladder our camera is sent at.
//
// The server gives every call a ladder (zrtc_config.bwProfiles, call 2026-10-08):
//   id 1 240p  8 fps   30 kbps   id 4 360p 20 fps 500 kbps   id 7 720p 24 fps 1100 kbps
//   id 2 240p 10 fps  100 kbps   id 5 360p 24 fps 700 kbps
//   id 3 360p 15 fps  300 kbps   id 6 480p 24 fps 900 kbps
// and the bounds maxWidth / maxHeight (1280x720), codecMaxFps (24), maxBitrate
// (1500), startupBitrate (300), keyFrameIntervalMs (0: key frames only when the
// phone asks). macOS ZaloCall moves on that ladder with webrtc's send-side
// estimator (GoogCc): delay based (the queue that builds before packets get lost),
// loss based (bweSendSideHighLoss 10 % / bweSendSideLowLoss 2 %), and a sender that
// cuts its rate when the receiver's feedback stops ("Feedback timed out", "Long
// feedback delay detected, reducing BWE"). Here the same three signals, coarser:
//   - queueing delay from transport-cc: every packet we send carries a
//     transport-wide sequence number; the phone's feedback says when each one
//     arrived, so arrival - send time, against its minimum over the last seconds,
//     is the queue on the path;
//   - loss from transport-cc (else the phone's report blocks);
//   - no feedback for FEEDBACK_TIMEOUT_S while we send video;
//   plus the loss of what we receive (the phone's audio): on a shared Wi-Fi /
//   uplink our own video starves the other direction too.
// Why: a test on a Dell OptiPlex 9020 (2026-10-10) climbed 500 -> 1100 kbps in
// 15 s on "no loss" while feedback seconds were missing, and the call lost 18 % of
// the phone's audio and 27 % of its video, both ways crackling. Steps up need
// UP_HOLD_S clean seconds of transport-cc, never report blocks alone, and wait
// longer after each step down that followed a step up.

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
const START_KBPS = 300; // zrtc_config startupBitrate when absent
const MIN_KBPS = 100; // below this (id 1: 8 fps, 30 kbps) the picture is useless; keep id 2
const SAFETY_KEY_MS = 10000; // keyFrameIntervalMs 0: a key frame now and then anyway, in case a PLI is lost
const DOWN_GAP_MS = 2000; // vidBweMinResetMs: one step down per 2 s at most
const UP_HOLD_S = 4; // clean seconds of transport-cc in a row before a step up
const BACKOFF_MIN_MS = 10000; // after a step down, no step up for this long ...
const BACKOFF_MAX_MS = 60000; // ... doubled (up to this) when a step up was followed by a step down
const FEEDBACK_TIMEOUT_S = 2; // seconds without transport-cc while sending video: step down
const QUEUE_HOLD_MS = 40; // queueing delay that stops steps up
const QUEUE_DOWN_MS = 150; // and that steps down
const DOWNLINK_HOLD = 0.02; // loss of what we receive that stops steps up
const DOWNLINK_DOWN = 0.10; // and that steps down
const BASE_WINDOW_S = 15; // the minimum delay is taken over this many seconds
const MIN_TWCC_PACKETS = 10; // a second of feedback that covers fewer packets says nothing
const SENT_KEEP = 4000; // send times kept (transport-wide seq -> ms)
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
    const startKbps = num(c.startupBitrate, START_KBPS);
    let start = 0;
    this.ladder.forEach((p, i) => { if (p.kbps <= startKbps) start = i; });
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
    this.sent = new Map(); // transport-wide seq (16 bit) -> send time (ms)
    this.win = this._newWindow();
    this.minDelays = []; // [time, smallest arrival - send of that second]
    this.types = {}; // RTCP from the phone, "PT/fmt" -> count, since the last log line
    this.good = 0;
    this.noFeedback = 0;
    this.lastDownAt = 0;
    this.lastUpAt = 0;
    this.backoffMs = BACKOFF_MIN_MS;
    this.lastLogAt = 0;
    this.history = []; // per second since the last log line: "loss%/queue ms/downlink%"
    this.totals = { twccPkts: 0, twccLost: 0, rrBlocks: 0, changes: 0, downs: 0 };
    this.log(`send-rate: ladder ${this.ladder.map((p) => `${p.id}:${p.res}p${p.fps}/${p.kbps}k`).join(' ')}, start ${this._name()}, ` +
      `loss marks ${this.lowLoss * 100}..${this.highLoss * 100} %, queue marks ${QUEUE_HOLD_MS}..${QUEUE_DOWN_MS} ms, key every ${this.keyMs} ms` +
      (this.fixed ? ', adaptation OFF (ZCALL_VIDEO_ADAPT=0)' : ''));
    this.onProfile(this.profile());
  }

  _newWindow() { return { twccRecv: 0, twccLost: 0, rr: [], delays: [] }; }

  _name(p = this.ladder[this.level]) { return `id ${p.id} ${SIZES[p.res][0]}x${SIZES[p.res][1]} ${p.fps} fps ${p.kbps} kbps`; }

  // What the window encodes: the exact size (cut from the camera), fps, bitrate, key interval.
  profile() {
    const p = this.ladder[this.level];
    const [width, height] = SIZES[p.res];
    return { width, height, fps: p.fps, bitrate: p.kbps * 1000, keyMs: this.keyMs, captureBig: this.captureBig, rung: p.id };
  }

  // Every packet we send (audio and video share the transport-wide sequence).
  onSent(twSeq, ms = this.now()) {
    this.sent.set(twSeq & 0xffff, ms);
    if (this.sent.size > SENT_KEEP) this.sent.delete(this.sent.keys().next().value);
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
      if (pt === 205 && fmt === 15) this._onTwcc(pkt);
      else if (pt === 200 || pt === 201) {
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

  // Loss, and arrival - send time of each packet the phone got (its clock minus ours:
  // an unknown constant, so only its rise above the recent minimum is used).
  _onTwcc(pkt) {
    const fb = parseTwcc(pkt);
    if (!fb || fb.senderSsrc === this.localSsrc) return;
    let arrivalMs = fb.refUnits * 64;
    let d = 0;
    fb.status.forEach((st, i) => {
      if (st === 0) { this.win.twccLost++; return; }
      this.win.twccRecv++;
      arrivalMs += fb.deltaQ[d++] / 4;
      const sentMs = this.sent.get((fb.base + i) & 0xffff);
      if (sentMs !== undefined) this.win.delays.push(arrivalMs - sentMs);
    });
  }

  // Once a second (the RTCP report timer). sending: our camera is on and encoding;
  // downLoss: share of the phone's packets we did not get in that second (0..1, or null).
  tick(sending = true, downLoss = null) {
    const now = this.now();
    const w = this.win;
    this.win = this._newWindow();
    const total = w.twccRecv + w.twccLost;
    this.totals.twccPkts += total; this.totals.twccLost += w.twccLost; this.totals.rrBlocks += w.rr.length;
    const twcc = total >= MIN_TWCC_PACKETS;
    let loss = null, src = '';
    if (twcc) { loss = w.twccLost / total; src = 'twcc'; }
    else if (w.rr.length) { loss = Math.max(...w.rr); src = 'rr'; }
    let queue = null;
    if (w.delays.length) {
      const sorted = w.delays.slice().sort((a, b) => a - b);
      this.minDelays.push([now, sorted[0]]);
      this.minDelays = this.minDelays.filter(([t]) => now - t <= BASE_WINDOW_S * 1000);
      const base = Math.min(...this.minDelays.map(([, v]) => v));
      queue = Math.max(0, Math.round(sorted[Math.floor(sorted.length / 2)] - base));
    }
    this.noFeedback = twcc ? 0 : this.noFeedback + 1;
    this.history.push(`${loss === null ? '-' : Math.round(loss * 1000) / 10}/${queue === null ? '-' : queue}/${downLoss === null ? '-' : Math.round(downLoss * 1000) / 10}`);
    if (!this.fixed && sending) {
      const pct = (x) => (x * 100).toFixed(1) + ' %';
      let down = null, hold = false;
      if (this.noFeedback >= FEEDBACK_TIMEOUT_S) down = `no transport-cc for ${this.noFeedback} s`;
      else if (loss !== null && loss > this.highLoss) down = `loss ${pct(loss)} (${src}) > ${this.highLoss * 100} %`;
      else if (queue !== null && queue > QUEUE_DOWN_MS) down = `queue ${queue} ms > ${QUEUE_DOWN_MS} ms`;
      else if (downLoss !== null && downLoss > DOWNLINK_DOWN) down = `we lose ${pct(downLoss)} of the phone's packets`;
      else if (!twcc || (loss !== null && loss >= this.lowLoss) || (queue !== null && queue > QUEUE_HOLD_MS) ||
        (downLoss !== null && downLoss > DOWNLINK_HOLD)) hold = true;
      if (down) {
        this.good = 0;
        if (this.level > 0 && now - this.lastDownAt >= DOWN_GAP_MS) {
          // A step down soon after a step up: that rung was too much, wait longer next time.
          this.backoffMs = now - this.lastUpAt < 15000 ? Math.min(BACKOFF_MAX_MS, this.backoffMs * 2) : BACKOFF_MIN_MS;
          this.lastDownAt = now;
          this.totals.downs++;
          this._set(this.level - 1, down);
        }
      } else if (hold) this.good = 0;
      else if (++this.good >= UP_HOLD_S && this.level < this.ladder.length - 1 && now - this.lastDownAt >= this.backoffMs) {
        this.good = 0;
        this.lastUpAt = now;
        this._set(this.level + 1, `clean for ${UP_HOLD_S} s (loss ${pct(loss)}, queue ${queue === null ? '-' : queue + ' ms'})`);
      }
    }
    if (now - this.lastLogAt >= LOG_MS) {
      this.lastLogAt = now;
      const types = Object.entries(this.types).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
      this.types = {};
      this.log(`send-rate: ${this._name()}${sending ? '' : ' (camera off)'}; loss%/queue ms/downlink% per s [${this.history.join(' ')}]; rtcp from phone ${types}`);
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
