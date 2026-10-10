'use strict';

// RTCP the receiver owes the phone. Until 1.0.4 the engine only read the
// phone's PLI / FIR and sent nothing back, so the phone's send-side bandwidth
// estimator (SendSideCongestionController, "Long feedback delay detected,
// reducing BWE" in macOS ZaloCall) saw a dead return path and stayed on the
// lowest video profile (240p, 8 fps, 30 kbps; measured 2026-10-01).
//
// What ZaloCall.exe sends (strace captures 2026-09-29 / 30, work/captures):
//   audio RTCP (relay MsgType 0x05, P2P kind 7), plain, no SRTCP (srtcp = 0):
//     RTPFB 205 fmt 15 transport-cc, about every 50 ms, covering audio and
//     video together (one transport-wide sequence space);
//     SR 200 with one report block + SDES 202 (empty CNAME), about 1 / s.
//   video RTCP (relay 0x0F, P2P kind 9): SR / RR + SDES, RTPFB 205 fmt 1 NACK,
//     PSFB 206 fmt 1 PLI.
// Sender SSRC = our UID, media SSRC = the peer's UID (audio and video share it).
// Formats are the RFCs' (3550, 4585, draft-holmer-rmcat-transport-wide-cc-01).

const TWCC_EXT_ID = 5;
const NTP_EPOCH_OFFSET = 2208988800; // 1900 -> 1970, seconds
const MAX_TWCC_PACKETS = 400; // per feedback: a few hundred bytes, one UDP packet

// transport-wide sequence number of an RTP packet (one-byte header extension id 5), or null.
function readTwSeq(rtp) {
  if (rtp.length < 16 || (rtp[0] & 0x10) === 0) return null;
  let o = 12 + 4 * (rtp[0] & 0x0f);
  if (o + 4 > rtp.length || rtp.readUInt16BE(o) !== 0xbede) return null;
  const end = Math.min(rtp.length, o + 4 + 4 * rtp.readUInt16BE(o + 2));
  o += 4;
  while (o < end) {
    const b = rtp[o];
    if (b === 0) { o++; continue; }
    const id = b >> 4;
    const len = (b & 0x0f) + 1;
    if (id === 15) return null;
    if (id === TWCC_EXT_ID && len === 2 && o + 3 <= end) return rtp.readUInt16BE(o + 1);
    o += 1 + len;
  }
  return null;
}

// --- transport-cc ------------------------------------------------------------

class TwccRecorder {
  constructor() {
    this.arrivals = new Map(); // unwrapped seq -> arrival time in 250 us units
    this.top = null; // highest unwrapped seq seen
    this.next = null; // first unwrapped seq not reported yet
    this.fbCount = 0;
    this.sent = 0;
  }

  _unwrap(seq) {
    if (this.top === null) return seq;
    let u = seq + (this.top - (this.top & 0xffff));
    if (u - this.top > 0x8000) u -= 0x10000;
    else if (this.top - u > 0x8000) u += 0x10000;
    return u;
  }

  add(seq, nowMs) {
    const u = this._unwrap(seq & 0xffff);
    if (this.next === null) this.next = u;
    if (u < this.next || this.arrivals.has(u)) return; // already reported, or relay + P2P twin
    this.arrivals.set(u, Math.round(nowMs * 4));
    if (this.top === null || u > this.top) this.top = u;
  }

  pending() { return this.next !== null && this.top !== null && this.top >= this.next; }

  // Feedback packets for what arrived since the last call (usually one).
  build(senderSsrc, mediaSsrc) {
    const out = [];
    while (this.pending()) {
      const base = this.next;
      const end = Math.min(this.top, base + MAX_TWCC_PACKETS - 1);
      let any = false;
      for (let s = base; s <= end && !any; s++) any = this.arrivals.has(s);
      if (!any) { this.next = end + 1; continue; } // nothing arrived in this stretch: nothing to report
      out.push(encodeTwcc({
        senderSsrc, mediaSsrc, base, end, arrivals: this.arrivals, fbCount: this.fbCount++ & 0xff,
      }));
      for (let s = base; s <= end; s++) this.arrivals.delete(s);
      this.next = end + 1;
      this.sent++;
    }
    return out;
  }
}

function encodeTwcc({ senderSsrc, mediaSsrc, base, end, arrivals, fbCount }) {
  const count = end - base + 1;
  let firstQ;
  for (let s = base; firstQ === undefined; s++) firstQ = arrivals.get(s); // the caller checked one arrived
  const refUnits = Math.floor(firstQ / 256); // reference time: 64 ms units
  const refQ = refUnits * 256;
  const symbols = [];
  const deltas = [];
  let prevQ = refQ;
  for (let s = base; s <= end; s++) {
    const q = arrivals.get(s);
    if (q === undefined) { symbols.push(0); continue; }
    const d = q - prevQ;
    prevQ = q;
    if (d >= 0 && d <= 255) { symbols.push(1); deltas.push(d); } else { symbols.push(2); deltas.push(Math.max(-32768, Math.min(32767, d))); }
  }
  const chunks = [];
  for (let i = 0; i < symbols.length;) {
    let run = 1;
    while (i + run < symbols.length && symbols[i + run] === symbols[i] && run < 0x1fff) run++;
    if (run >= 8) { chunks.push((symbols[i] << 13) | run); i += run; continue; }
    let v = 0xc000; // status vector, 2-bit symbols (7 per chunk)
    for (let k = 0; k < 7; k++) v |= (i + k < symbols.length ? symbols[i + k] : 0) << (12 - 2 * k);
    chunks.push(v);
    i += 7;
  }
  const deltaBytes = symbols.filter((x) => x === 1).length + 2 * symbols.filter((x) => x === 2).length;
  const len = 4 + 8 + 8 + 2 * chunks.length + deltaBytes;
  const padded = (len + 3) & ~3;
  const b = Buffer.alloc(padded);
  b[0] = 0x8f; b[1] = 205;
  b.writeUInt16BE(padded / 4 - 1, 2);
  b.writeUInt32BE(senderSsrc >>> 0, 4);
  b.writeUInt32BE(mediaSsrc >>> 0, 8);
  b.writeUInt16BE(base & 0xffff, 12);
  b.writeUInt16BE(count, 14);
  b.writeUIntBE(refUnits & 0xffffff, 16, 3);
  b[19] = fbCount & 0xff;
  let o = 20;
  for (const c of chunks) { b.writeUInt16BE(c, o); o += 2; }
  let di = 0;
  for (const s of symbols) {
    if (s === 1) b[o++] = deltas[di++];
    else if (s === 2) { b.writeInt16BE(deltas[di++], o); o += 2; }
  }
  return b;
}

// For tests and for reading the phone's own feedback: { base, count, refUnits, fbCount, status[], deltaQ[] }.
function parseTwcc(b) {
  if (b.length < 20 || (b[0] & 0x1f) !== 15 || b[1] !== 205) return null;
  const count = b.readUInt16BE(14);
  const out = { senderSsrc: b.readUInt32BE(4), mediaSsrc: b.readUInt32BE(8), base: b.readUInt16BE(12), count,
    refUnits: b.readUIntBE(16, 3), fbCount: b[19], status: [], deltaQ: [] };
  let o = 20;
  while (out.status.length < count && o + 2 <= b.length) {
    const c = b.readUInt16BE(o); o += 2;
    if ((c & 0x8000) === 0) {
      const sym = (c >> 13) & 3; const run = c & 0x1fff;
      for (let i = 0; i < run && out.status.length < count; i++) out.status.push(sym);
    } else if (c & 0x4000) {
      for (let k = 0; k < 7 && out.status.length < count; k++) out.status.push((c >> (12 - 2 * k)) & 3);
    } else {
      for (let k = 0; k < 14 && out.status.length < count; k++) out.status.push((c >> (13 - k)) & 1);
    }
  }
  for (const s of out.status) {
    if (s === 1) out.deltaQ.push(b[o++]);
    else if (s === 2) { out.deltaQ.push(b.readInt16BE(o)); o += 2; }
  }
  return out;
}

// --- reports, key frame and NACK requests --------------------------------------

function ntpNow(nowMs) {
  const sec = Math.floor(nowMs / 1000);
  const frac = Math.floor(((nowMs % 1000) / 1000) * 4294967296);
  return { msw: (sec + NTP_EPOCH_OFFSET) >>> 0, lsw: frac >>> 0 };
}

function reportBlock(buf, o, blk) {
  buf.writeUInt32BE(blk.ssrc >>> 0, o);
  buf[o + 4] = blk.fractionLost & 0xff;
  buf.writeUIntBE(blk.cumLost & 0xffffff, o + 5, 3);
  buf.writeUInt32BE(blk.extHighSeq >>> 0, o + 8);
  buf.writeUInt32BE(blk.jitter >>> 0, o + 12);
  buf.writeUInt32BE(blk.lsr >>> 0, o + 16);
  buf.writeUInt32BE(blk.dlsr >>> 0, o + 20);
}

// Sender report (PT 200) with reception blocks, as ZaloCall's 52-byte SR.
function buildSr({ ssrc, nowMs, rtpTs, packets, octets, blocks = [] }) {
  const b = Buffer.alloc(28 + 24 * blocks.length);
  b[0] = 0x80 | blocks.length; b[1] = 200;
  b.writeUInt16BE(b.length / 4 - 1, 2);
  b.writeUInt32BE(ssrc >>> 0, 4);
  const n = ntpNow(nowMs);
  b.writeUInt32BE(n.msw, 8); b.writeUInt32BE(n.lsw, 12);
  b.writeUInt32BE(rtpTs >>> 0, 16); b.writeUInt32BE(packets >>> 0, 20); b.writeUInt32BE(octets >>> 0, 24);
  blocks.forEach((blk, i) => reportBlock(b, 28 + 24 * i, blk));
  return b;
}

// Receiver report (PT 201), for a stream we only receive (video).
function buildRr({ ssrc, blocks = [] }) {
  const b = Buffer.alloc(8 + 24 * blocks.length);
  b[0] = 0x80 | blocks.length; b[1] = 201;
  b.writeUInt16BE(b.length / 4 - 1, 2);
  b.writeUInt32BE(ssrc >>> 0, 4);
  blocks.forEach((blk, i) => reportBlock(b, 8 + 24 * i, blk));
  return b;
}

// SDES with an empty CNAME: the 12 bytes ZaloCall appends.
function buildSdes(ssrc) {
  const b = Buffer.alloc(12);
  b[0] = 0x81; b[1] = 202; b.writeUInt16BE(2, 2);
  b.writeUInt32BE(ssrc >>> 0, 4);
  b[8] = 1; // CNAME, length 0, end of list
  return b;
}

function buildPli(senderSsrc, mediaSsrc) {
  const b = Buffer.alloc(12);
  b[0] = 0x81; b[1] = 206; b.writeUInt16BE(2, 2);
  b.writeUInt32BE(senderSsrc >>> 0, 4); b.writeUInt32BE(mediaSsrc >>> 0, 8);
  return b;
}

// Generic NACK (RTPFB fmt 1): seqs sorted ascending, 16-bit; one PID + BLP per 17 packets.
function buildNack(senderSsrc, mediaSsrc, seqs) {
  const items = [];
  for (let i = 0; i < seqs.length;) {
    const pid = seqs[i] & 0xffff;
    let blp = 0;
    let j = i + 1;
    for (; j < seqs.length; j++) {
      const d = ((seqs[j] - pid) & 0xffff);
      if (d < 1 || d > 16) break;
      blp |= 1 << (d - 1);
    }
    items.push([pid, blp]);
    i = j;
  }
  const b = Buffer.alloc(12 + 4 * items.length);
  b[0] = 0x81; b[1] = 205; b.writeUInt16BE(b.length / 4 - 1, 2);
  b.writeUInt32BE(senderSsrc >>> 0, 4); b.writeUInt32BE(mediaSsrc >>> 0, 8);
  items.forEach(([pid, blp], i) => { b.writeUInt16BE(pid, 12 + 4 * i); b.writeUInt16BE(blp, 14 + 4 * i); });
  return b;
}

// --- reception statistics (RFC 3550 A.1 / A.3 / 6.4.1) ---------------------------

class RxStats {
  constructor(clockHz) {
    this.clockHz = clockHz;
    this.ssrc = 0;
    this.started = false;
    this.baseSeq = 0; this.maxSeq = 0; this.cycles = 0;
    this.received = 0; this.expectedPrior = 0; this.receivedPrior = 0;
    this.jitter = 0; this.transit = null;
    this.seen = new Set(); // extended seqs of the last 512 packets: relay + P2P deliver twice
    this.lsr = 0; this.lsrAt = 0; // the peer's last SR
  }

  onPacket(rtp, nowMs) {
    const seq = rtp.readUInt16BE(2);
    const ts = rtp.readUInt32BE(4);
    if (!this.started) {
      this.started = true; this.ssrc = rtp.readUInt32BE(8) >>> 0; this.baseSeq = seq; this.maxSeq = seq;
    } else {
      const d = (seq - this.maxSeq) & 0xffff;
      if (d !== 0 && d < 0x8000) { if (seq < this.maxSeq) this.cycles += 0x10000; this.maxSeq = seq; }
    }
    const ext = this.cycles + seq;
    if (this.seen.has(ext)) return;
    this.seen.add(ext);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
    this.received++;
    const arrival = (nowMs * this.clockHz) / 1000;
    const transit = arrival - ts;
    if (this.transit !== null) {
      const dd = Math.abs(transit - this.transit);
      this.jitter += (dd - this.jitter) / 16;
    }
    this.transit = transit;
  }

  onSr(buf, nowMs) {
    if (buf.length < 28) return;
    this.lsr = (((buf.readUInt32BE(8) & 0xffff) << 16) | (buf.readUInt32BE(12) >>> 16)) >>> 0;
    this.lsrAt = nowMs;
  }

  block(nowMs) {
    if (!this.started) return null;
    const extHigh = this.cycles + this.maxSeq;
    const expected = extHigh - this.baseSeq + 1;
    const lost = expected - this.received;
    const expInt = expected - this.expectedPrior;
    const recInt = this.received - this.receivedPrior;
    this.expectedPrior = expected; this.receivedPrior = this.received;
    const lostInt = expInt - recInt;
    const fraction = expInt <= 0 || lostInt <= 0 ? 0 : Math.min(255, Math.floor((lostInt * 256) / expInt));
    return {
      ssrc: this.ssrc,
      fractionLost: fraction,
      cumLost: Math.max(-0x800000, Math.min(0x7fffff, lost)),
      extHighSeq: extHigh >>> 0,
      jitter: Math.round(this.jitter),
      lsr: this.lsr,
      dlsr: this.lsrAt ? Math.round(((nowMs - this.lsrAt) * 65536) / 1000) >>> 0 : 0,
    };
  }
}

// All of it, for one call: feed it every received RTP / RTCP packet, ask it for
// what to send.
class RtcpFeedback {
  constructor({ localSsrc }) {
    this.localSsrc = localSsrc >>> 0;
    this.twcc = new TwccRecorder();
    this.audio = new RxStats(16000);
    this.video = new RxStats(90000);
    this.peerSsrc = 0; // media SSRC of the phone (its UID), from the first packet
    this.counters = { twcc: 0, reports: 0, pli: 0, nack: 0 };
  }

  onRtp(kind, rtp, nowMs) {
    if (rtp.length < 12) return;
    if (!this.peerSsrc) this.peerSsrc = rtp.readUInt32BE(8) >>> 0;
    const tw = readTwSeq(rtp);
    if (tw !== null) this.twcc.add(tw, nowMs);
    (kind === 'video' ? this.video : this.audio).onPacket(rtp, nowMs);
  }

  // Compound RTCP from the phone: remember its SR time for our DLSR.
  onRtcp(kind, buf, nowMs) {
    const st = kind === 'video' ? this.video : this.audio;
    for (let o = 0; o + 4 <= buf.length;) {
      if ((buf[o] >> 6) !== 2) return;
      const len = (buf.readUInt16BE(o + 2) + 1) * 4;
      if (buf[o + 1] === 200 && o + len <= buf.length) st.onSr(buf.subarray(o, o + len), nowMs);
      o += len;
    }
  }

  twccPackets() {
    if (!this.peerSsrc) return [];
    const pk = this.twcc.build(this.localSsrc, this.peerSsrc);
    this.counters.twcc += pk.length;
    return pk;
  }

  // Audio channel: SR (we send audio) with the audio reception block, + SDES.
  audioReport(nowMs, { rtpTs, packets, octets }) {
    const blk = this.audio.block(nowMs);
    this.counters.reports++;
    return Buffer.concat([buildSr({ ssrc: this.localSsrc, nowMs, rtpTs, packets, octets, blocks: blk ? [blk] : [] }), buildSdes(this.localSsrc)]);
  }

  // Video channel: RR with the video reception block, + SDES. Null before any video.
  videoReport(nowMs) {
    const blk = this.video.block(nowMs);
    if (!blk) return null;
    this.counters.reports++;
    return Buffer.concat([buildRr({ ssrc: this.localSsrc, blocks: [blk] }), buildSdes(this.localSsrc)]);
  }

  pli() {
    if (!this.video.started) return null;
    this.counters.pli++;
    return buildPli(this.localSsrc, this.video.ssrc);
  }
}

module.exports = {
  TWCC_EXT_ID, readTwSeq, TwccRecorder, encodeTwcc, parseTwcc, ntpNow,
  buildSr, buildRr, buildSdes, buildPli, buildNack, RxStats, RtcpFeedback,
};
