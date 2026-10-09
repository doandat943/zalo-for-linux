#!/usr/bin/env node
'use strict';
// Native call engine, in place of Zalo's ZaloCall helper. Connects to Zalo's
// two call-v2 TCP sockets, sends the token line, runs EngineCore with a media
// backend and a call window.
//
//   node native-engine/zcall-native.js --token <TK> [--recv 29631] [--send 29632]
//        [--media stub|zrtc] [--send-udp] [--no-window]
//
//   --media stub   signalling only, no media (default; ZCALL_MEDIA)
//   --media zrtc   Zalo relay media; packets leave the machine only with
//                  --send-udp (ZCALL_SEND_UDP=1)
//   --group        group calls (the default; ZCALL_GROUP=0 turns them off and
//                  the call window says they are not supported): audio, camera
//                  (ZCALL_GROUP_CAMERA=0 keeps it local) and screen share.
//
// Zalo-Linux's patched main process spawns it on its own Electron
// (ELECTRON_RUN_AS_NODE) with the ports and a fresh token. It writes
// engine->zalo frames on the recv socket (29631) and reads zalo->engine
// frames on the send socket (29632). With ZCALL_LOG_DIR the log goes to
// <dir>/native-engine-YYYYMMDD.log, else to stderr.

const fs = require('fs');
const net = require('net');
const path = require('path');
const util = require('util');
const { loadKey, encrypt, FrameParser } = require('../tools/lib/callv2-crypto');
const { EngineCore } = require('./engine-core');
const { StubMedia } = require('./backends/stub');
const { ZrtcMediaBackend } = require('./backends/zrtc-media');
const { createCallUi } = require('./ui-client');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const token = opt('token', process.env.ZCALL_TOKEN);
const recvPort = Number(opt('recv', 29631)); // engine -> zalo
const sendPort = Number(opt('send', 29632)); // zalo -> engine
const mediaMode = opt('media', process.env.ZCALL_MEDIA || 'stub');
const sendUdp = args.includes('--send-udp') || process.env.ZCALL_SEND_UDP === '1';
const verbose = args.includes('--verbose') || !!process.env.ZCALL_VERBOSE;
// Group calls are on unless ZCALL_GROUP=0 (live with a phone and the macOS client,
// 2026-10-08: audio, camera and screen share both ways).
const group = args.includes('--group') || process.env.ZCALL_GROUP !== '0';
if (!token) { console.error('need --token <TK> (the value Zalo passes on the command line)'); process.exit(2); }

const key = loadKey();
const stamp = () => new Date().toISOString().slice(11, 23);
const logFile = process.env.ZCALL_LOG_DIR
  ? fs.createWriteStream(path.join(process.env.ZCALL_LOG_DIR, `native-engine-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.log`), { flags: 'a' })
  : null;
const log = (...a) => {
  const line = util.format(stamp(), '[zcall-native]', ...a);
  if (logFile) logFile.write(line + '\n'); else console.error(line);
};
process.on('uncaughtException', (e) => { log('uncaught', e.stack || e); process.exit(1); });
log(`start: media=${mediaMode} sendUdp=${sendUdp} group=${group} ports ${recvPort}/${sendPort}`);

// recv socket: we write engine->zalo frames here.
const recv = net.connect({ host: '127.0.0.1', port: recvPort }, () => recv.write(token + '\n'));
// send socket: we read zalo->engine frames here.
const send = net.connect({ host: '127.0.0.1', port: sendPort }, () => send.write(token + '\n'));

const brief = (f) => `${f.type} ${f.command || (f.data && f.data.act) || ''}`;
const emit = (frame) => {
  log('->', brief(frame), verbose ? JSON.stringify(frame.data) : '');
  try {
    const hex = encrypt(frame, key);
    // call-v2 splits messages over 4000 hex chars: "<hex>#<msgId>#<total>#<index>#$".
    if (hex.length <= 4000) { recv.write(hex + '$'); return; }
    const parts = hex.match(/.{1,4000}/g);
    const id = Date.now(); // the real msgId is a ms timestamp; index is 0-based
    parts.forEach((part, i) => recv.write(`${part}#${id}#${parts.length}#${i}#$`));
  } catch (e) { log('emit failed', e.message); }
};
const media = mediaMode === 'stub' ? new StubMedia(log) : new ZrtcMediaBackend({ log, sendUdp });
// --no-window: no call window. Tests add ZCALL_AUTO_ANSWER=1 to pick up
// incoming calls automatically.
const headless = { open() {}, status() {}, close() {}, onHangup() {},
  incoming(_o, accept) { if (process.env.ZCALL_AUTO_ANSWER) setTimeout(accept, 100); } };
const ui = args.includes('--no-window') ? headless : createCallUi(log);
const engine = new EngineCore({ emit, media, log, ui, group });

const parser = new FrameParser(key, { expectToken: false }, (f) => {
  if (f.error) return log('bad frame', f.error);
  if (f.json && typeof f.json === 'object') {
    // group_request is ~8 KB (callSetting, zrtcConfig): keep group_* whole.
    const act = f.json.data && f.json.data.act;
    const limit = typeof act === 'string' && act.startsWith('group_') ? 65536 : 4000;
    log('<-', brief(f.json), verbose ? JSON.stringify(f.json.data).slice(0, limit) : '');
    try { engine.onZaloFrame(f.json); } catch (e) { log('engine error', e.stack); }
  }
});
send.on('data', (d) => parser.push(d));

let started = false;
const maybeStart = () => { if (!started && !recv.connecting && !send.connecting) { started = true; log('connected; engine ready'); engine.start(); } };
recv.on('connect', maybeStart);
send.on('connect', maybeStart);
const quit = () => { try { engine.hangup('engine-exit'); } catch (_) {} setTimeout(() => process.exit(0), 300); };
for (const [n, s] of [['recv', recv], ['send', send]]) {
  s.on('error', (e) => log(n, 'error', e.message));
  s.on('close', () => { log(n, 'closed'); quit(); });
}
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
