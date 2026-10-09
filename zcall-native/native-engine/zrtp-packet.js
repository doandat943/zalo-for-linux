'use strict';

/**
 * ZRTPPacket wire format, taken from ARM64
 * zrtc::ZRTPPacket::_buildPacketInternal / initZRTPPacket* on macOS ZaloCall,
 * and checked byte for byte against packets the real engine sent
 * (native-engine/wire-check.js).
 *
 *  - Media (MsgType 3/5/7/13/15): 1 byte type + uint32 LE server token + payload.
 *  - Control (MsgType 1, client -> server) and reply (MsgType 2, server -> client):
 *      0 type | 1 magic | 2 u32 0 | 6 u32 seq | 10 u32 local UID | 14 u32 server token
 *      18 u16 cmd | 20 u8 subCmd | 21.. payload
 *  - InitZRTP cmd 11 (caller) / 12 (callee): payload u32 callId, u32 peer UID,
 *    u16str sessId (+ u16str extra when non-empty). Token is 0: the
 *    server hands it out in its MsgType 2 reply.
 *  - Ping cmd 2: payload u16str sessId. EndCall cmd 3: payload u32 callId.
 */

const MSG_TYPES = {
  CONTROL: 0x01,
  SERVER_REPLY: 0x02,   // server -> client answer to a control request (InitZRTP, cmd 32)
  AUDIO_RTP: 0x03,       // client → server, 5-byte hdr + RTP PT 112 (wire 2026-09-29)
  AUDIO_RTP_DOWN: 0x04,  // server → client (observed; not in macOS 0xa0a8 bitmask)
  AUDIO_FEC: 0x05,     // the name is old: captures show RTCP audio (transport-cc, SR), plain; native-engine/rtcp.js
  AUDIO_RTCP: 0x07,
  VIDEO_RTP: 0x0d,
  VIDEO_DOWN: 0x0e,      // server → client (observed)
  VIDEO_FEC: 0x0f,     // likewise RTCP video (SR / RR, NACK, PLI)
  P2P_EXT: 0x7f,
};

const COMMANDS = {
  PING: 2,
  END_CALL: 3,
  INIT_CALL_CALLER: 11,
  INIT_CALL_CALLEE: 12,
  ECHO: 5,          // server RTT probe before InitZRTP (payload: decimal seq)
  CHANGE_ADDRESS: 14,
  REQ_FORWARD: 32,  // relayed to the peer via the server; sub 10 ~1/s ping/pong, sub 8 once
  GROUP_MESSAGE: 33, // group: server -> client, GroupCallController::_handleZRTPReqGroupCallMessage
  ROOM_UPDATED: 50,  // group: server -> client, CMD_ZAVI_ROOM_UPDATED (u32 UIDs in the room)
  INIT_ZAVI_PING: 0x33,
};

const MAGIC_BYTE = 0x7e;
const CONTROL_HEADER_LEN = 21;
const MEDIA_HEADER_LEN = 5;

function isMediaType(t) {
  return t === 0x03 || t === 0x04 || t === 0x05 || t === 0x07 || t === 0x0d || t === 0x0e || t === 0x0f;
}

function wrapMediaPacket({ msgType = MSG_TYPES.AUDIO_RTP, token = 0, payload }) {
  if (!Buffer.isBuffer(payload)) throw new TypeError('payload must be a Buffer');
  const buf = Buffer.allocUnsafe(MEDIA_HEADER_LEN + payload.length);
  buf[0] = msgType;
  buf.writeUInt32LE(token >>> 0, 1);
  payload.copy(buf, 5);
  return buf;
}

function buildControlHeader({
  msgType = MSG_TYPES.CONTROL,
  magic = MAGIC_BYTE,
  field02 = 0,
  seq = 0,
  uid = 0,
  token = 0,
  cmd,
  subCmd = 0,
}) {
  if (cmd == null) throw new TypeError('cmd is required');
  const buf = Buffer.alloc(CONTROL_HEADER_LEN);
  buf[0] = msgType;
  buf[1] = magic;
  buf.writeUInt32LE(field02 >>> 0, 2);
  buf.writeUInt32LE(seq >>> 0, 6);
  buf.writeUInt32LE(uid >>> 0, 10);
  buf.writeUInt32LE(token >>> 0, 14);
  buf.writeUInt16LE(cmd >>> 0, 18);
  buf[20] = subCmd & 0xff;
  return buf;
}

function u16String(s) {
  const data = Buffer.isBuffer(s) ? s : Buffer.from(String(s || ''), 'utf8');
  const out = Buffer.allocUnsafe(2 + data.length);
  out.writeUInt16LE(data.length, 0);
  data.copy(out, 2);
  return out;
}

function u32(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/**
 * RequestInitZRTP (cmd 11 caller / 12 callee), sent to every candidate server.
 * initZRTPPacketRequestInitCall(isCaller, uid, peer, callId, sessId, subCmd,
 * extra, flag): subCmd |= 4 when flag is set. An empty extra is not written
 * (caller 185 B with a 154-byte sessId, callee 183 B with a 152-byte session).
 * subCmd is 2 for both roles on the wire. The callee sends it to the one
 * server the caller chose, right after answering.
 */
function buildInitZrtpPacket({
  role = 'caller',
  uid = 0,
  peerUid = 0,
  callId = 0,
  sessId = '',
  extra = '',
  subCmd = 0x02,
}) {
  const caller = role === 'caller';
  const header = buildControlHeader({
    magic: MAGIC_BYTE,
    uid,
    cmd: caller ? COMMANDS.INIT_CALL_CALLER : COMMANDS.INIT_CALL_CALLEE,
    subCmd,
  });
  const parts = [header, u32(callId), u32(peerUid), u16String(sessId)];
  // Empty extra is not written for either role (callee packet: 183 B with a
  // 152-byte session, capture 2026-09-30).
  if (extra && extra.length) parts.push(u16String(extra));
  return Buffer.concat(parts);
}

// Group calls (SFU, port 3000) use the same 21-byte control header. From the
// x86_64 disassembly of macOS ZaloCall 26.9.10 (docs/GROUP-CALL.md, not yet
// checked against a capture):
//  - InitZRTP: initZRTPPacketRequestInitCall(uid, callId, isHost, sessId, ...)
//    cmd 11 host / 12 others, subCmd 4. _buildPacketInternal writes the
//    callId/peer slots (+0x38/+0x3c) unless subCmd is 6, and the group init
//    leaves them 0: payload u32 0, u32 0, u16str session, u16str extra.
//    extra (_sendRequestInitZRTPAllSelectedServer) is 4 bytes:
//    [debugLoopback 0, 5, sending video (1), 1].
//  - Ping: initZRTPPacketRequestInitZaviPing, cmd 0x33 subCmd 1, magic 0x7e,
//    with the server's token; payload u32 0, u32 0, u16str session,
//    u16str extra [0, 5, sending video (1)].
// The first live test (2026-10-01) got a refusal for that layout, so
// `layout` picks one of the candidates (the backend tries them in turn):
//   zero        u32 0, u32 0, session, extra                (static reading, subCmd 4)
//   sub6        subCmd 6: u32 callId, u8 isHost, u8 5, u8 loopback 0, session,
//               extra — the +0xe4..+0xea fields the group init does fill
//               (_buildPacketInternal writes them for subCmd 6 only)
//   callId      u32 callId, u32 0, session, extra           (subCmd 4)
//   callIdHost  u32 callId, u32 hostCall, session, extra    (subCmd 4)
// Byte 2 is 1 while we send video. _sendRequestInitZRTPAllSelectedServer writes
// (state & ~2) != 0; the macOS client sends 1 in every ZaviPing while its camera is
// on and 0 once, when it was turned off (capture 2026-10-08). Read as "camera off"
// before, ours said 0 with the camera on, and the SFU stopped forwarding our camera
// at the next ping, 1 to 4 s after a member asked for it (the Mac's downlink).
function groupExtra(videoOn = true, initZrtp = true) {
  const b = [0, 5, videoOn ? 1 : 0];
  if (initZrtp) b.push(1);
  return Buffer.from(b);
}

const GROUP_INIT_LAYOUTS = ['zero', 'sub6', 'callId', 'callIdHost'];

function buildGroupInitZrtpPacket({ host = false, uid = 0, sessId = '', videoOn = true, callId = 0, hostCall = 0, layout = 'zero' }) {
  const header = buildControlHeader({
    magic: MAGIC_BYTE,
    uid,
    cmd: host ? COMMANDS.INIT_CALL_CALLER : COMMANDS.INIT_CALL_CALLEE,
    subCmd: layout === 'sub6' ? 0x06 : 0x04,
  });
  const extra = u16String(groupExtra(videoOn, true));
  if (layout === 'sub6') return Buffer.concat([header, u32(callId), Buffer.from([host ? 1 : 0, 5, 0]), u16String(sessId), extra]);
  const a = layout === 'zero' ? 0 : callId;
  const b = layout === 'callIdHost' ? hostCall : 0;
  return Buffer.concat([header, u32(a), u32(b), u16String(sessId), extra]);
}

// Screen share in a group call: a second peer (macOS ShareScreenPeer, its own UDP
// socket) whose UID is the shareScreenId 12044 answered. ShareScreenPeer::_initZrtp
// calls the group initZRTPPacketRequestInitCall with isHost false (+0x94 cleared in
// start), so cmd 12, subCmd 4, and extra [0, ShareScreenPeerConfig+0x6a, 1, 0], where
// _startShareScreenPeer sets +0x6a to 0xff. _sendRequestZRTPPing sends a ZaviPing
// with the share UID and token and an empty extra, which is not written.
function buildShareInitZrtpPacket({ uid = 0, sessId = '' }) {
  const header = buildControlHeader({ magic: MAGIC_BYTE, uid, cmd: COMMANDS.INIT_CALL_CALLEE, subCmd: 0x04 });
  return Buffer.concat([header, u32(0), u32(0), u16String(sessId), u16String(Buffer.from([0, 0xff, 1, 0]))]);
}

function buildShareZaviPingPacket({ uid = 0, token = 0, sessId = '' }) {
  const header = buildControlHeader({ magic: MAGIC_BYTE, uid, token, cmd: COMMANDS.INIT_ZAVI_PING, subCmd: 0x01 });
  return Buffer.concat([header, u32(0), u32(0), u16String(sessId)]);
}

function buildZaviPingPacket({ uid = 0, token = 0, sessId = '', videoOn = true }) {
  const header = buildControlHeader({ magic: MAGIC_BYTE, uid, token, cmd: COMMANDS.INIT_ZAVI_PING, subCmd: 0x01 });
  return Buffer.concat([header, u32(0), u32(0), u16String(sessId), u16String(groupExtra(videoOn, false))]);
}

// CMD_ZAVI_ROOM_UPDATED (MsgType 2 cmd 50, header UID = ours): u32 LE UID of
// everyone in the room (handleZRTPPacket rejects a length that is not a
// multiple of 4).
function parseRoomUpdated(data) {
  if (!Buffer.isBuffer(data) || data.length % 4) return null;
  const out = [];
  for (let o = 0; o < data.length; o += 4) out.push(data.readUInt32LE(o));
  return out;
}

function buildPingPacket({ uid = 0, token = 0, sessId = '' }) {
  // initZRTPPacketRequestPing overwrites the magic with 1.
  const header = buildControlHeader({ magic: 0x01, uid, token, cmd: COMMANDS.PING, subCmd: 0x01 });
  return Buffer.concat([header, u16String(sessId)]);
}

// Sent to the chosen server on hangup, and to every other server that
// answered InitZRTP once the best one is picked (~2 s after InitZRTP).
function buildEndCallPacket({ uid = 0, token = 0, callId = 0 }) {
  const header = buildControlHeader({ magic: MAGIC_BYTE, uid, token, cmd: COMMANDS.END_CALL, subCmd: 0 });
  return Buffer.concat([header, u32(callId)]);
}

// ReqForward (cmd 32): relayed by the server to the peer, acked with MsgType 2.
// Each side sends sub 10 once a second with its own seq; payload is six u32:
// [20, a, 1, 1, audio packets received in the last second, b]. a and b are 0
// in 96/133 captured packets (else a ~24, b 2-7: meaning not known yet).
// Sub 8 with payload [4, 0] is sent once, ~0.2 s after media starts.
function buildReqForwardPacket({ uid = 0, token = 0, seq = 0, subCmd, payload = Buffer.alloc(0) }) {
  const header = buildControlHeader({ magic: 0x01, seq, uid, token, cmd: COMMANDS.REQ_FORWARD, subCmd });
  return Buffer.concat([header, payload]);
}

function reqForwardStatus(rxPerSecond, a = 0, b5 = 0) {
  const b = Buffer.alloc(24);
  [20, a, 1, 1, rxPerSecond, b5].forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
  return b;
}

// Group video control, from x86_64 _buildPacketInternal (jump table) and the
// initZRTPPacketGroup* setters. Same 21-byte header as ReqForward: magic 1,
// seq = GroupCallController+0xe0 (no writer found; stays 0), uid = +0xa0,
// token = +0xc8. The body is one u16str, except cmd 33 which has none.
// Not sent yet. qualityId 0xff is what the empty-table path returns
// (VideoQuality 0); 0 is VideoQuality 1; 2 and 3 copy a byte out of the
// peer's layer records. No capture has checked which id the SFU wants.
function buildGroupVidQualPacket({ uid = 0, token = 0, seq = 0, subCmd, entries }) {
  const body = Buffer.alloc(1 + entries.length * 5);
  body[0] = entries.length & 0xff;
  entries.forEach((e, i) => {
    body.writeUInt32LE(e.uid >>> 0, 1 + i * 5);
    body[1 + i * 5 + 4] = e.qualityId & 0xff;
  });
  const header = buildControlHeader({ magic: 0x01, seq, uid, token, cmd: COMMANDS.REQ_FORWARD, subCmd });
  return Buffer.concat([header, u16String(body)]);
}

// sub 13: ask the SFU for each member's layer. sendVideoQualityRequest writes
// min(n, 200) entries of u32 partnerUid + u8 qualityId.
function buildGroupVidQualReq(opts) {
  return buildGroupVidQualPacket({ ...opts, subCmd: 0x0d });
}

// sub 12: tell the SFU our layers. Each entry is 9 bytes: id, bitrate
// (bitrateKbps * 10, the value BuildQualityBitrateConfigs stores at +8),
// width, height. Built from zrtcConfig.groupcall by groupVideoPlan.
function buildGroupVidQualConfig({ uid = 0, token = 0, seq = 0, layers }) {
  const body = Buffer.alloc(1 + layers.length * 9);
  body[0] = layers.length & 0xff;
  layers.forEach((L, i) => {
    const o = 1 + i * 9;
    body[o] = L.id & 0xff;
    body.writeUInt32LE(L.a >>> 0, o + 1);
    body.writeUInt16LE(L.b & 0xffff, o + 5);
    body.writeUInt16LE(L.c & 0xffff, o + 7);
  });
  const header = buildControlHeader({ magic: 0x01, seq, uid, token, cmd: COMMANDS.REQ_FORWARD, subCmd: 0x0c });
  return Buffer.concat([header, u16String(body)]);
}

// Layers macOS sends on sub 12, from GroupZRtcConfig::fromJson +
// BuildQualityBitrateConfigs (mode of codec 60/61, flag false).
// id = spatialIndex * 3 + temporalIndex. Bitrate on the wire is
// bitrateKbps / 2^(temporalNum-1-temporalIndex), in kbps (macOS capture).
// Width and height are maxWidth/maxHeight * factorNum/factorDen.
// An empty or unusable table returns null: the real sender skips the packet.
// encode is only spatial 0 / temporal 0. sfu is the extension registered for
// that mode: codec 60/61 → short id 12, codec 4 → none, anything else → long
// id 14. Only layer 0 is encoded, so the backend announces only that row.
function groupVideoPlan(config) {
  if (!config || typeof config !== 'object') return null;
  const gc = config.groupcall;
  if (!gc || typeof gc !== 'object' || !Array.isArray(gc.spatialLayers)) return null;
  const temporal = Number.isFinite(Number(gc.temporalNum)) ? (Number(gc.temporalNum) & 0xff) : 0;
  if (!temporal) return null;
  const maxW = Number(config.maxWidth) > 0 ? Math.trunc(Number(config.maxWidth)) : 1280;
  const maxH = Number(config.maxHeight) > 0 ? Math.trunc(Number(config.maxHeight)) : 720;
  const keyMs = Number(config.keyFrameIntervalMs) > 0 ? Math.trunc(Number(config.keyFrameIntervalMs)) : 1000;
  const layers = [];
  const rows = []; // temporal 0 of each spatial layer: the sizes we can encode at
  let encode = null;
  let spatial = 0;
  for (const raw of gc.spatialLayers) {
    if (!raw || typeof raw !== 'object') continue;
    if (!Number.isFinite(Number(raw.factorNum)) || !Number.isFinite(Number(raw.factorDen))) continue;
    const num = Number(raw.factorNum) & 0xff;
    const den = Number(raw.factorDen) & 0xff;
    const kbps = Number(raw.bitrateKbps);
    const fps = Number(raw.fps);
    if (!den || !Number.isFinite(kbps) || !Number.isFinite(fps) || fps <= 0) continue;
    const width = Math.trunc(maxW * num / den) & ~1;
    const height = Math.trunc(maxH * num / den) & ~1;
    if (width <= 0 || height <= 0) continue;
    // kbps on the wire: the macOS client announces 100 / 300 / 700 for 480x240 /
    // 720x360 / 960x480 (capture 2026-10-08), not kbps * 10.
    const divided = Math.trunc(kbps);
    for (let t = 0; t < temporal; t++) {
      const wire = Math.trunc(divided / (1 << (temporal - 1 - t))) >>> 0;
      const id = spatial * 3 + t;
      layers.push({ id, a: wire, b: width, c: height });
      if (t === 0) rows.push({ width, height, fps: Math.trunc(fps), kbps: wire });
    }
    spatial++;
  }
  if (!layers.length || !rows.length) return null;
  // One layer goes out, announced as id 0 (send). The macOS client sends two at
  // once, 480x240 / 100 kbps and 720x360 / 300 kbps, 12 fps, and the phone and the
  // Mac asked it for the second (capture 2026-10-08); our 480x240 looked soft next
  // to it. So the second row by default: spatial index ZCALL_GROUP_CAM_LAYER (0, 1, 2).
  const want = process.env.ZCALL_GROUP_CAM_LAYER !== undefined ? Number(process.env.ZCALL_GROUP_CAM_LAYER) : 1;
  const row = rows[Math.min(Math.max(0, Math.trunc(want) || 0), rows.length - 1)];
  encode = { width: row.width, height: row.height, fps: row.fps, bitrate: row.kbps * 1000, keyMs };
  const send = [{ id: 0, a: row.kbps, b: row.width, c: row.height }];
  // fromJson writes this mode at GroupZRtcConfig+0x2f0, which is the CallType
  // dword _startPeer passes to VideoRtpRtcp. Codec 60 or 61 → 2, codec 4 → 3,
  // otherwise 1. Only 1 and 2 register an SFU extension.
  const codec = Number(gc.codec);
  let sfu = { id: 14, long: true };
  if (codec === 60 || codec === 61) sfu = { id: 12, long: false };
  else if (codec === 4) sfu = null;
  return { layers, encode, send, sfu };
}

// cmd 33, no body. sub 14 MultiSync, sub 15 reference clock. Sent only when
// GroupCallController+0xabc is set. Same uid / token / seq as VidQual.
function buildGroupSyncPacket({ uid = 0, token = 0, seq = 0, subCmd }) {
  return buildControlHeader({ magic: 0x01, seq, uid, token, cmd: COMMANDS.GROUP_MESSAGE, subCmd });
}

// P2P (MsgType 0x7f), sent straight between the two clients (capture of the
// real engine answering a call, 2026-09-30). 9-byte header:
//   7f | 00 | role (0 caller, 1 callee) | u32 LE callId | kind | 00
// kind 1  binding to each remote candidate: u16 LE seq, u32 BE candidate index
// kind 2  binding from the peer: seq, index, u32 LE len + "ip|port" we were
//         reached at, then ff
// kind 3  answer to kind 2: same seq and index, u32 LE len + "ip|port" of the
//         peer as we see it (no ff)
// kind 4  keepalive: byte 9 = 1 ping / 2 pong; the pong is the ping with our
//         role and byte 9 = 2
// kind 6  audio (SRTP, same keys and sequence as relay), 7 audio RTCP, 8/9 video
const P2P = { HEADER_LEN: 9, BIND: 1, BIND_PEER: 2, BIND_ANSWER: 3, KEEPALIVE: 4, AUDIO: 6, AUDIO_RTCP: 7, VIDEO: 8, VIDEO_RTCP: 9 };

function p2pHeader(role, callId, kind) {
  const h = Buffer.alloc(P2P.HEADER_LEN);
  h[0] = MSG_TYPES.P2P_EXT;
  h[2] = role === 'callee' ? 1 : 0;
  h.writeUInt32LE(callId >>> 0, 3);
  h[7] = kind;
  return h;
}

function buildP2pBind({ role, callId, seq = 0, index }) {
  const b = Buffer.alloc(6);
  b.writeUInt16LE(seq & 0xffff, 0);
  b.writeUInt32BE(index >>> 0, 2);
  return Buffer.concat([p2pHeader(role, callId, P2P.BIND), b]);
}

// Answer a kind 2 from the peer, seen coming from peerAddr ("ip|port").
function buildP2pBindAnswer({ role, callId, request, peerAddr }) {
  const addr = Buffer.from(peerAddr, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(addr.length, 0);
  return Buffer.concat([p2pHeader(role, callId, P2P.BIND_ANSWER), request.subarray(9, 15), len, addr]);
}

function buildP2pPong({ role, ping }) {
  const pong = Buffer.from(ping);
  pong[2] = role === 'callee' ? 1 : 0;
  pong[9] = 2;
  return pong;
}

function wrapP2pAudio({ role, callId, rtp }) {
  return Buffer.concat([p2pHeader(role, callId, P2P.AUDIO), rtp]);
}

function wrapP2pVideo({ role, callId, rtp }) {
  return Buffer.concat([p2pHeader(role, callId, P2P.VIDEO), rtp]);
}

// RTCP over P2P (kind 7 audio, 9 video): plain compound packets, no SRTCP.
function wrapP2pRtcp({ role, callId, video, rtcp }) {
  return Buffer.concat([p2pHeader(role, callId, video ? P2P.VIDEO_RTCP : P2P.AUDIO_RTCP), rtcp]);
}

function unwrapPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1) return null;
  const msgType = buf[0];

  if (msgType === MSG_TYPES.AUDIO_RTP_DOWN || msgType === MSG_TYPES.VIDEO_DOWN) {
    // Server -> client media: 1-byte header, RTP right after (no token).
    return { isMedia: true, msgType, payload: buf.slice(1) };
  }
  if (isMediaType(msgType)) {
    if (buf.length < MEDIA_HEADER_LEN) return { isMedia: true, msgType, truncated: true, raw: buf };
    return {
      isMedia: true,
      msgType,
      token: buf.readUInt32LE(1),
      payload: buf.slice(5),
    };
  }

  if ((msgType === MSG_TYPES.CONTROL || msgType === MSG_TYPES.SERVER_REPLY) && buf.length >= CONTROL_HEADER_LEN) {
    const data = buf.slice(CONTROL_HEADER_LEN);
    const parsed = {
      isMedia: false,
      msgType,
      magic: buf[1],
      field02: buf.readUInt32LE(2),
      seq: buf.readUInt32LE(6),
      uid: buf.readUInt32LE(10),
      token: buf.readUInt32LE(14),
      cmd: buf.readUInt16LE(18),
      subCmd: buf[20],
      data,
    };
    const initCmd = parsed.cmd === COMMANDS.INIT_CALL_CALLER || parsed.cmd === COMMANDS.INIT_CALL_CALLEE;
    if (initCmd && msgType === MSG_TYPES.SERVER_REPLY && data.length >= 4) {
      // Server answer to InitZRTP: result, callId, the token for media
      // headers, and our address as the server sees it ("ip|port").
      // A refusal is the result alone (_parsePacketInternal stops there).
      // The group SFU's answer (subCmd 4) stops after the token: 12 bytes, no
      // address (live 2026-10-08: 00000000 00000000 13e6df28).
      parsed.res = data.readUInt32LE(0);
      if (parsed.res === 0 && data.length >= 12) {
        parsed.callId = data.readUInt32LE(4);
        parsed.serverToken = data.readUInt32LE(8);
        if (data.length >= 14) {
          const n = data.readUInt16LE(12);
          parsed.publicAddr = data.slice(14, 14 + n).toString('latin1');
        }
      }
    } else if (initCmd && data.length >= 10) {
      parsed.callId = data.readUInt32LE(0);
      parsed.peerUid = data.readUInt32LE(4);
      const n1 = data.readUInt16LE(8);
      parsed.sessId = data.slice(10, 10 + n1);
      const off = 10 + n1;
      if (data.length >= off + 2) parsed.extra = data.slice(off + 2, off + 2 + data.readUInt16LE(off));
    } else if (parsed.cmd === COMMANDS.PING && data.length >= 2) {
      parsed.sessId = data.slice(2, 2 + data.readUInt16LE(0));
    } else if (parsed.cmd === COMMANDS.END_CALL && data.length >= 4) {
      parsed.callId = data.readUInt32LE(0);
    }
    return parsed;
  }

  if (msgType === MSG_TYPES.P2P_EXT && buf.length >= 9) {
    return {
      isMedia: false,
      msgType,
      b1: buf[1],
      b2: buf[2],
      field38: buf.readUInt32LE(3),
      cmd: buf.readUInt16LE(7),
      data: buf.slice(9),
    };
  }

  return { isMedia: false, msgType, raw: buf };
}

module.exports = {
  MSG_TYPES,
  COMMANDS,
  MAGIC_BYTE,
  CONTROL_HEADER_LEN,
  MEDIA_HEADER_LEN,
  wrapMediaPacket,
  buildControlHeader,
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
  reqForwardStatus,
  buildGroupVidQualReq,
  buildGroupVidQualConfig,
  groupVideoPlan,
  buildGroupSyncPacket,
  P2P,
  buildP2pBind,
  buildP2pBindAnswer,
  buildP2pPong,
  wrapP2pAudio,
  wrapP2pVideo,
  wrapP2pRtcp,
  unwrapPacket,
};
