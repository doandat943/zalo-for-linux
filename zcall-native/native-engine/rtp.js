'use strict';
// RTP header of outgoing audio, as ZaloCall writes it (capture 2026-09-29,
// 6645 type-3 packets):
//   90 70 | seq | ts | ssrc | be de 00 01 | 51 <tw seq hi> <tw seq lo> 00
// V=2, X=1, PT 112 (opus/16000/1), timestamp +320 per 20 ms frame (16 kHz
// clock), SSRC = local UID, one-byte header extension (RFC 8285) id 5 len 2 =
// transport-wide sequence number (transport-cc), padded to 4 bytes.

const AUDIO_PT = 112;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const TWCC_EXT_ID = 5;

function buildAudioRtpHeader({ seq, ts, ssrc, twSeq, marker = false, pt = AUDIO_PT }) {
  const h = Buffer.alloc(20);
  h[0] = 0x90;
  h[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(ts >>> 0, 4);
  h.writeUInt32BE(ssrc >>> 0, 8);
  h.writeUInt16BE(0xbede, 12);
  h.writeUInt16BE(1, 14);
  h[16] = (TWCC_EXT_ID << 4) | 1;
  h.writeUInt16BE(twSeq & 0xffff, 17);
  h[19] = 0;
  return h;
}

// Group video adds the SFU one-byte extension after transport-cc. BuildRTPHeaderExtension
// walks types in order, so id 5 comes first and the SFU id (12 or 14) second.
// VideoRtpRtcp::_create (0x1002a45e0): CallType 2 → short id 12 (3 data bytes,
// header nibble 2); CallType 1 → long id 14 (7 data bytes, nibble 6). CallType is
// the mode dword at GroupCallPeer+0x390 (GroupCallConfig, fromJson from codec).
// Short payload, BuildVideoGroupCallExtension: byte0 = (spatial*3+temporal)<<4 |
// (spatial2*3+temporal2), byte1 = SFUExtensionData[5], byte2 = [4]. Layer 0 with
// the other fields zero is 00 00 00. 1-1 stays buildAudioRtpHeader (CallType 0).
// The macOS client's uplink (capture 2026-10-08, 5277 packets): byte0 is the layer,
// 0x03 for its lowest and 0x33 for its second, sent together; byte1/byte2 is a packet
// counter of that layer, 1 for its first packet and +1 on every packet, no break.
// The SFU forwards one layer and numbers the packets from that counter: a value that
// repeats inside a frame (ours did) breaks every multi-packet frame on the way.
// layerSeq is that counter (byte1 = high, byte2 = low). ZCALL_SFU_BYTE0 (hex)
// overrides byte0 for a test.
const AUDIO_LEVEL_EXT_ID = 2;
const ABS_SEND_TIME_EXT_ID = 3;
const CAPTURE_NTP_EXT_ID = 13;
const SFU_BYTE0 = process.env.ZCALL_SFU_BYTE0 ? (parseInt(process.env.ZCALL_SFU_BYTE0, 16) & 0xff) : 0x03;

// Every packet of the macOS client carries, in this order (capture 2026-10-08):
//   id 3  abs-send-time, 3 bytes, 6.18 fixed seconds of the sender's clock
//   id 5  transport-wide sequence
//   id 12 SFU layer (above)
//   id 13 7 bytes: the frame's capture time on the NTP clock, the low 24 bits of the
//         NTP seconds and the 32-bit fraction (equal on every packet of a frame,
//         a few ms before it is sent; 0 seconds off on every packet checked).
// 19 bytes, one byte of padding, extension length 5. The Mac's own receiver showed
// our camera without 3 and 13; the phone asked for it (layer 0) and drew only the
// avatar (live 2026-10-08 02:02). captureMs is the frame's capture time (Date.now
// scale), sendMs the send time.
const NTP_UNIX_OFFSET = 2208988800;
function buildGroupVideoRtpHeader({ seq, ts, ssrc, twSeq, marker = false, pt, sfu, layerSeq = 0, captureMs = Date.now(), sendMs = Date.now() }) {
  const long = !!(sfu && sfu.long);
  const id = (sfu && sfu.id) || (long ? 14 : 12);
  const dataLen = long ? 7 : 3;
  const extBytes = 4 + 3 + (1 + dataLen) + 8;
  const padded = (extBytes + 3) & ~3;
  const h = Buffer.alloc(12 + 4 + padded);
  h[0] = 0x90;
  h[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(ts >>> 0, 4);
  h.writeUInt32BE(ssrc >>> 0, 8);
  h.writeUInt16BE(0xbede, 12);
  h.writeUInt16BE(padded / 4, 14);
  let o = 16;
  h[o++] = (ABS_SEND_TIME_EXT_ID << 4) | 2;
  const abs = Math.floor(sendMs * 262.144) % 0x1000000; // (ms << 18) / 1000, 24 bits
  h[o++] = (abs >> 16) & 0xff; h[o++] = (abs >> 8) & 0xff; h[o++] = abs & 0xff;
  h[o++] = (TWCC_EXT_ID << 4) | 1;
  h.writeUInt16BE(twSeq & 0xffff, o); o += 2;
  h[o++] = ((id & 0x0f) << 4) | (long ? 6 : 2);
  h[o++] = SFU_BYTE0;
  h.writeUInt16BE(layerSeq & 0xffff, o); o += 2;
  if (long) o += 4;
  writeCaptureNtp(h, o, captureMs);
  return h;
}

// Group audio: the capture NTP time (id 13, as on video) on every packet. The macOS
// client's group audio carries id 2 (audio level) and id 13 on all 2097 packets of the
// capture; receivers line video up with audio by it. With id 13 on our video only,
// neither the Mac nor the phone drew our camera until it was restarted (2026-10-08
// 02:12). transport-cc stays, as on our 1-1 audio. 1-1 keeps buildAudioRtpHeader.
// id 2 is the audio level (RFC 6464, V bit 0 as the Mac sends it, -dBov 0..127),
// which an SFU uses to pick who is speaking. Order 2, 5, 13; 13 bytes, padded to 16.
function buildGroupAudioRtpHeader({ seq, ts, ssrc, twSeq, marker = false, pt = AUDIO_PT, captureMs = Date.now(), level = 127 }) {
  const h = Buffer.alloc(12 + 4 + 16);
  h[0] = 0x90;
  h[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(ts >>> 0, 4);
  h.writeUInt32BE(ssrc >>> 0, 8);
  h.writeUInt16BE(0xbede, 12);
  h.writeUInt16BE(4, 14);
  h[16] = (AUDIO_LEVEL_EXT_ID << 4) | 0;
  h[17] = Math.min(127, Math.max(0, level | 0));
  h[18] = (TWCC_EXT_ID << 4) | 1;
  h.writeUInt16BE(twSeq & 0xffff, 19);
  writeCaptureNtp(h, 21, captureMs);
  return h;
}

// id 13 element at o: header byte, low 24 bits of the NTP seconds, 32-bit fraction.
function writeCaptureNtp(h, o, captureMs) {
  h[o++] = (CAPTURE_NTP_EXT_ID << 4) | 6;
  const ntp = captureMs / 1000 + NTP_UNIX_OFFSET;
  const sec = Math.floor(ntp);
  const frac = Math.floor((ntp - sec) * 0x100000000) >>> 0;
  h[o++] = (sec >> 16) & 0xff; h[o++] = (sec >> 8) & 0xff; h[o++] = sec & 0xff;
  h.writeUInt32BE(frac, o);
  return o + 4;
}

// Read the fields back (for checks against captured packets).
function readAudioRtpHeader(rtp) {
  if (rtp.length < 20 || rtp[0] !== 0x90 || rtp.readUInt16BE(12) !== 0xbede) return null;
  return {
    marker: !!(rtp[1] & 0x80),
    pt: rtp[1] & 0x7f,
    seq: rtp.readUInt16BE(2),
    ts: rtp.readUInt32BE(4),
    ssrc: rtp.readUInt32BE(8),
    twSeq: (rtp[16] >> 4) === TWCC_EXT_ID ? rtp.readUInt16BE(17) : null,
  };
}

module.exports = { AUDIO_PT, FRAME_SAMPLES, buildAudioRtpHeader, buildGroupAudioRtpHeader, buildGroupVideoRtpHeader, readAudioRtpHeader };
