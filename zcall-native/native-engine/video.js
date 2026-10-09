'use strict';
// Received video: RTP payloads -> whole H.264 access units (Annex-B), in order.
//
// What the phone sends when we announce h264 and no HEVC (call 2026-10-01):
//   PT 98  key frames (SPS/PPS/IDR, High profile), PT 97 other frames, one
//          RTP sequence for both; PT 100 (own sequence, FEC?) is ignored.
//   Payload: an Annex-B chunk, either whole (starts 00 00 ..) or a fragment
//          with a 2-byte header 1c 80 (first), 1c 00 (middle), 1c 40 (last).
//   The RTP marker bit ends a frame; all packets of a frame share the timestamp.
// Same packetization as the H.265 the phone sends to the Windows engine.
//
// Frames go out in sequence order. Over P2P packets arrive up to ~13 late,
// so a frame that is complete but not next waits a little (REORDER_*). If the
// gap does not fill, decoding goes on anyway: the decoder conceals the damage,
// while waiting for the next key frame would freeze the picture for tens of
// seconds (the phone sends key frames rarely: 2 in a 20 s call). Only the very
// first frame must be a key frame.

const VIDEO_PTS = new Set([97, 98]);
const KEY_PT = 98;
const REORDER_FRAMES = 3; // complete frames held while an earlier one is missing
const REORDER_MS = 200;
const MAX_PENDING = 30; // incomplete frames kept (by timestamp)

class VideoAssembler {
  // group: any PT (the group packetization is not captured yet), key frames
  // told by their NAL units (SPS / IDR), and the H.264 SVC units (14 prefix,
  // 15 subset SPS, 20 extension) dropped so the base layer decodes as AVC.
  // onGap: a frame went out with packets missing before it (the picture is
  // damaged until the next key frame): the caller asks the phone for one.
  constructor(onFrame, now = () => Date.now(), { group = false, onGap = null } = {}) {
    this.onFrame = onFrame; // ({ key, data, ts })
    this.onGap = onGap;
    this.now = now;
    this.group = group;
    this.pending = new Map(); // ts -> { parts: Map(idx -> payload), key, end }
    this.ready = new Map(); // first idx -> { key, data, ts, last, since }
    this.lastIdx = -1; // last packet of the last frame handed on
    this.started = false; // a key frame went out
    this.needKey = false; // group: a gap broke the GOP; drop until the next key
    this.sps = null; // group: last SPS / PPS, prepended to a key that lacks them
    this.pps = null;
    this.stats = { frames: 0, dropped: 0, keys: 0, gaps: 0 };
    // Group diagnostics (2026-10-09: members arrive as 180x320 even when a
    // bigger layer is asked for): bytes per NAL type since the last read
    // (14/15/20 = the SVC units that are dropped), and the picture size of the
    // last SPS (7) and subset SPS (15, an SVC enhancement layer).
    this.nalBytes = {};
    this.spsSize = { 7: null, 15: null };
  }

  push({ ts, pt, marker, payload, seq, roc = 0 }) {
    if ((!this.group && !VIDEO_PTS.has(pt)) || !payload.length) return;
    const idx = roc * 0x10000 + seq;
    if (idx <= this.lastIdx) return; // late, or a duplicate (relay + P2P)
    let f = this.pending.get(ts);
    if (!f) {
      f = { parts: new Map(), key: false, end: null };
      this.pending.set(ts, f);
      if (this.pending.size > MAX_PENDING) { this.pending.delete(this.pending.keys().next().value); this.stats.dropped++; }
    }
    f.parts.set(idx, payload);
    if (pt === KEY_PT) f.key = true;
    if (marker) f.end = idx;
    if (f.end !== null) this._complete(ts, f);
    this._flush();
  }

  _complete(ts, f) {
    const idxs = [...f.parts.keys()].sort((a, b) => a - b);
    const first = f.parts.get(idxs[0]);
    if (isFragment(first) && first[1] !== 0x80) return; // first fragment still missing
    for (let i = 1; i < idxs.length; i++) if (idxs[i] !== idxs[i - 1] + 1) return; // hole
    if (idxs[idxs.length - 1] !== f.end) return;
    this.pending.delete(ts);
    let data = Buffer.concat(idxs.map((i) => { const p = f.parts.get(i); return isFragment(p) ? p.subarray(2) : p; }));
    let key = f.key;
    if (this.group) {
      const units = nalUnits(data);
      for (const u of units) {
        const t = u[0] & 0x1f;
        this.nalBytes[t] = (this.nalBytes[t] || 0) + u.length;
        if (t === 7 || t === 15) {
          const d = spsSize(u);
          if (d) this.spsSize[t] = d.width + 'x' + d.height;
        }
      }
      key = units.some((u) => (u[0] & 0x1f) === 7 || (u[0] & 0x1f) === 5);
      const kept = units.filter((u) => !SVC_NALS.has(u[0] & 0x1f));
      if (!kept.length) { this.pending.delete(ts); this.stats.dropped++; return; }
      if (kept.length !== units.length) data = Buffer.concat(kept.flatMap((u) => [START_CODE, u]));
      // The phone repeats SPS only every few dozen seconds. A decoder that
      // errored on a loss stays frozen until the next in-band SPS, so keep
      // the last parameter sets and put them on a key that arrived without.
      for (const u of kept) {
        const t = u[0] & 0x1f;
        if (t === 7) this.sps = Buffer.from(u);
        else if (t === 8) this.pps = Buffer.from(u);
      }
      if (key && this.sps) {
        const hasSps = kept.some((u) => (u[0] & 0x1f) === 7);
        const hasPps = kept.some((u) => (u[0] & 0x1f) === 8);
        if (!hasSps || (!hasPps && this.pps)) {
          const parts = [];
          if (!hasSps) parts.push(START_CODE, this.sps);
          if (!hasPps && this.pps) parts.push(START_CODE, this.pps);
          parts.push(data);
          data = Buffer.concat(parts);
        }
      }
    }
    this.ready.set(idxs[0], { key, data, ts, last: f.end, since: this.now() });
  }

  _flush() {
    for (;;) {
      if (!this.ready.size) return;
      const next = this.ready.get(this.lastIdx + 1);
      if (next && this.lastIdx >= 0) { this._emit(this.lastIdx + 1, next); continue; }
      // Nothing in order: wait a little for the late packets, then skip the gap.
      const firstIdx = Math.min(...this.ready.keys());
      const oldest = this.ready.get(firstIdx);
      const waited = this.now() - oldest.since;
      if (this.lastIdx >= 0 && this.ready.size <= REORDER_FRAMES && waited < REORDER_MS) return;
      if (!this.started && !oldest.key) { this.ready.delete(firstIdx); this.stats.dropped++; continue; }
      if (this.lastIdx >= 0) {
        this.stats.gaps++;
        if (this.onGap) this.onGap();
        // 1-1 key frames are rare, so a hole is decoded through. Group keys
        // arrive about once a second; feeding the broken delta makes
        // WebCodecs error and then sit on the last picture.
        if (this.group) this.needKey = true;
      }
      this._emit(firstIdx, oldest);
    }
  }

  _emit(firstIdx, fr) {
    if (this.group && this.needKey && !fr.key) {
      this.ready.delete(firstIdx);
      this.lastIdx = fr.last;
      this.stats.dropped++;
      return;
    }
    this.ready.delete(firstIdx);
    this.lastIdx = fr.last;
    if (fr.key) this.needKey = false;
    // Incomplete frames from before this point can no longer be used.
    for (const [t, f] of this.pending) if (Math.max(...f.parts.keys()) <= this.lastIdx) { this.pending.delete(t); this.stats.dropped++; }
    this.started = this.started || fr.key;
    this.stats.frames++;
    if (fr.key) this.stats.keys++;
    this.onFrame({ key: fr.key, data: fr.data, ts: fr.ts });
  }
}

const SVC_NALS = new Set([14, 15, 20]);
const START_CODE = Buffer.from([0, 0, 0, 1]);

// NAL units of an Annex-B buffer (without their start codes).
function nalUnits(annexB) {
  const starts = [];
  for (let i = 0; i + 2 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) { starts.push(i + 3); i += 2; }
  }
  return starts.map((st, k) => {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : annexB.length;
    while (end > st && annexB[end - 1] === 0) end--; // 4-byte start codes and trailing zeros
    return annexB.subarray(st, end);
  }).filter((u) => u.length);
}

// Picture size coded in an SPS (NAL 7) or subset SPS (NAL 15) unit (with its
// one-byte NAL header), or null. H.264 7.3.2.1.1, cropping applied (4:2:0).
function spsSize(nal) {
  const b = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; // emulation prevention
    b.push(nal[i]);
  }
  let pos = 0;
  const bit = () => { if (pos >= b.length * 8) throw new Error('eof'); const v = (b[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return v; };
  const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
  const ue = () => { let z = 0; while (!bit()) { if (++z > 31) throw new Error('ue'); } return bits(z) + (2 ** z - 1); };
  const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
  try {
    const profile = bits(8); bits(16); ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue(); if (chroma === 3) bit();
      ue(); ue(); bit();
      if (bit()) {
        for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
          if (!bit()) continue;
          let last = 8, next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
        }
      }
    }
    ue();
    const poc = ue();
    if (poc === 0) ue();
    else if (poc === 1) { bit(); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
    ue(); bit();
    const wMbs = ue() + 1, hMap = ue() + 1;
    const frameMbsOnly = bit();
    if (!frameMbsOnly) bit();
    bit();
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (bit()) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
    const cx = chroma === 0 ? 1 : 2, cy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return { width: wMbs * 16 - cx * (cl + cr), height: (2 - frameMbsOnly) * hMap * 16 - cy * (ct + cb) };
  } catch (_) {
    return null;
  }
}

function isFragment(p) {
  return p.length >= 2 && p[0] === 0x1c && (p[1] & 0x3f) === 0;
}

// avc1.PPCCLL from the SPS of a key frame (WebCodecs codec string).
function avcCodecString(annexB) {
  for (let i = 0; i + 7 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1 && (annexB[i + 3] & 0x1f) === 7) {
      return 'avc1.' + [annexB[i + 4], annexB[i + 5], annexB[i + 6]].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  }
  return null;
}

// Outgoing video: one H.264 access unit (Annex-B) -> RTP payloads, the way
// the phone packs its own: whole if it fits, else 1c 80 / 1c 00 / 1c 40
// fragments of at most MAX_CHUNK bytes. The caller sets the marker on the last.
const MAX_CHUNK = 1068; // the phone's fragments carry 1068 bytes (1070 with the header)

function packetizeFrame(annexB, maxChunk = MAX_CHUNK) {
  if (annexB.length <= maxChunk) return [annexB];
  const out = [];
  for (let off = 0; off < annexB.length; off += maxChunk) {
    const end = Math.min(off + maxChunk, annexB.length);
    const flag = off === 0 ? 0x80 : end === annexB.length ? 0x40 : 0x00;
    out.push(Buffer.concat([Buffer.from([0x1c, flag]), annexB.subarray(off, end)]));
  }
  return out;
}

module.exports = { VideoAssembler, avcCodecString, packetizeFrame, nalUnits, spsSize, KEY_PT, DELTA_PT: 97 };
