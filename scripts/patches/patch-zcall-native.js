/**
 * patch-zcall-native.js
 *
 * Runs Zalo's calls on the native Linux engine (zcall-native/).
 *
 * Zalo's main process starts a call helper (ZaloCall.exe on Windows,
 * ZaloHelper.app on macOS) and talks to it over two local channels carrying
 * AES-encrypted JSON: named pipes on Windows, unix sockets on macOS. On Linux
 * this patch makes it
 *   - listen on loopback TCP ports 29631 (helper -> Zalo) and 29632
 *     (Zalo -> helper), and require a per-launch token as the first line of
 *     each connection;
 *   - spawn zcall-native/native-engine/zcall-native.js (path in
 *     ZCALL_ENGINE_JS, set by plugins/zcall) on Zalo's own Electron
 *     (ELECTRON_RUN_AS_NODE) with the ports and the token;
 *   - await plugins/zcall's global.__zcallPrepare() first (system packages).
 * Transport crypto, message handling and renderer IPC are untouched; Windows
 * and macOS keep their branches.
 *
 * Also fixes two bugs of the non-Windows path that the helper exposes:
 * makeCall racing the init message, and a send queue that stalls after the
 * first message.
 */

const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const MAIN_JS = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');

// The first line a connection must send: `e` is the socket, `X` the chunk.
const tokenCheck = (X) =>
  `if(e.t!==!0){e.t=(e.t||"")+${X}.toString();const p=e.t.indexOf("\\n");if(p<0)return;` +
  `if(e.t.slice(0,p)!==TK)return e.destroy();${X}=e.t.slice(p+1),e.t=!0}`;

// [what, from, to]: `from` is a string or a RegExp on Zalo's minified
// main-dist/main.js. `n("...")` is the bundle's require, `i` its spawn.
//
// 26.10.10 minifies the same function with different names than 26.9.10:
// the Win32 flag and the send-path variable swap (`y`/`g`), and the send
// function swaps with the cached init payload (`D`/`O`). Patterns keep
// whichever name that build used. Recv path stays `v`.
const STEPS = [
  ['loopback TCP ports on Linux',
    /([yg])="win32"===n\("([^"]+)"\)\.platform\(\),([yg])=\1\?"\\\\\\\\.\\\\pipe\\\\PipeZCallSend":"\/tmp\/socketzalosend2021",v=\1\?"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv":"\/tmp\/socketzalorecv2021"/,
    '$1="win32"===n("$2").platform(),$3=$1?"\\\\\\\\.\\\\pipe\\\\PipeZCallSend":"linux"===n("$2").platform()?29632:"/tmp/socketzalosend2021",' +
    'v=$1?"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv":"linux"===n("$2").platform()?29631:"/tmp/socketzalorecv2021"'],
  ['listen on 127.0.0.1 (recv)', 'I.listen(v,(', 'I.listen("linux"===process.platform?{port:v,host:"127.0.0.1"}:v,('],
  ['listen on 127.0.0.1 (send)',
    /C\.listen\(([gy]),\(/g,
    'C.listen("linux"===process.platform?{port:$1,host:"127.0.0.1"}:$1,('],
  // EADDRINUSE recovery unlinks the socket file. On Linux the path is a port.
  ['no unlink of a port (recv)',
    /([yg])\|\|a\.unlink\(v,/g,
    '"linux"===process.platform||$1||a.unlink(v,'],
  ['no unlink of a port (send)',
    /([yg])\|\|\(U=!1,a\.unlink\(([gy]),/g,
    '"linux"===process.platform||$1||(U=!1,a.unlink($2,'],
  ['token variable',
    /let S,[DO],[DO],N,A,C=null,I=null,L=!1,P=\[\],M=!1,k=!0,x=\[\],F=!1,U=!1/,
    '$&,TK=null'],
  ['token check (recv)',
    /e\.on\("data",\(([$\w]+)=>\{([$\w]+)\(\1\)\}\)\),e\.on\("end"/,
    `e.on("data",(n=>{${tokenCheck('n')}n&&$2(n)})),e.on("end"`],
  ['token check (send)',
    /e\.on\("data",\(([$\w]+)=>\{d\.zsymb\((\d+),"([^"]+)",\["serverSend on data","([^"]+)"\],\1\),([yg])\|\|\(F=!1,([$\w]+)\(e\)\)\}\)\)/,
    `e.on("data",($1=>{${tokenCheck('$1')}d.zsymb($2,"$3",["serverSend on data","$4"],$1),$5||(F=!1,$6(e))}))`],
  ['engine path on Linux',
    ':(e=u()?o.join(__dirname,"..","native","qt-call-cap-mac","ZaloHelper.app")',
    ':("linux"===process.platform?e=process.env.ZCALL_ENGINE_JS||"":(e=u()?o.join(__dirname,"..","native","qt-call-cap-mac","ZaloHelper.app")'],
  ['engine path on Linux (close)', 'e=o.join(e,"Contents","MacOS","ZaloCall")),e}();', 'e=o.join(e,"Contents","MacOS","ZaloCall"))),e}();'],
  // plugins/zcall checks the system packages (and tells the user) first.
  ['await __zcallPrepare',
    /\}\(\);([$\w]+)\(e,([$\w]+)\)\.then\(\(t=>\{if\(([$\w]+)&&!t\)return L=!1/,
    '}();("linux"===process.platform&&global.__zcallPrepare?global.__zcallPrepare().then((()=>$1(e,$2))):$1(e,$2)).then((t=>{if($3&&!t)return L=!1'],
  ['spawn the engine',
    /;A=i\(e,\[v,([gy])\]\),A\.stdout\.setEncoding\("utf8"\)/,
    ';"linux"===process.platform?(TK="zcall-"+Math.random().toString(36).slice(2)+Date.now().toString(36),' +
    'A=i(process.execPath,[e,"--recv",String(v),"--send",String($1),"--token",TK],{env:Object.assign({},process.env,{ELECTRON_RUN_AS_NODE:"1"})})):' +
    'A=i(e,[v,$1]),A.stdout.setEncoding("utf8")'],
  // A failed or ended engine must not leave "started" set, or no call
  // would start it again until Zalo restarts.
  ['restart after the engine ends',
    /A\.on\("error",\(e=>\{d\.zsymb\((\d+),"([^"]+)",\["client error","([^"]+)"\],e\)\}\)\)/,
    'A.on("error",(e=>{L=!1,d.zsymb($1,"$2",["client error","$3"],e)})),A.on("exit",(()=>{L=!1}))'],
  // The helper rejects makeCall (-11 "init_error") before it has seen init:
  // send init first (same stream, order kept). $1 is the send function,
  // $2 is the cached init payload (they swap names between Zalo versions).
  ['init before makeCall',
    /\.on\("call-send-to-native",\(\(e,t\)=>\{t\._optional\?delete t\._optional:K\(\),([DO])\(t\)\}\)\)\.on\("call-init",\(\(e,t\)=>\{t&&t\._optional&&delete t\._optional,([DO])=t\}\)\)/,
    '.on("call-send-to-native",((e,t)=>{t._optional?delete t._optional:K(),t&&"makeCall"===t.command&&$2&&$1($2),$1(t)})).on("call-init",((e,t)=>{t&&t._optional&&delete t._optional,$2=t}))'],
  // Off Windows the "sending" flag is only cleared when the helper writes on
  // the send channel, which it hardly ever does: every message after the
  // first stalled. Clear it shortly after each write.
  ['send queue stall',
    /,([$\w]+)=e=>\{if\(U\)if\(F\)[\s\S]{0,1000}?F=!0,e\.write\(t\)/,
    '$&,setTimeout((()=>{F=!1,$1(e)}),100)'],
  // An engine that ended leaves a destroyed socket: queue instead of writing.
  ['no write to a closed socket',
    /([DO])=t=>\{([yg])\?V\(e,t\):G\(e,t\)/,
    '$1=t=>{$2?V(e,t):e&&!e.destroyed?G(e,t):x.push(t)'],
  ['no write to a closed socket (queue)',
    /else if\(e\)\{if\(x\.length\)\{const ([$\w]+)=x\.shift\(\);([$\w]+)\(e,\1\)/,
    'else if(e&&!e.destroyed){if(x.length){const $1=x.shift();$2(e,$1)'],
];

function foundIn(content, from) {
  if (typeof from === 'string') return content.includes(from);
  from.lastIndex = 0;
  const ok = from.test(content);
  from.lastIndex = 0;
  return ok;
}

async function main(mainJs = MAIN_JS) {
  if (!fs.existsSync(mainJs)) {
    throw new Error('native call patch: main.js not found');
  }
  let content = fs.readFileSync(mainJs, 'utf8');
  if (content.includes('ZCALL_ENGINE_JS')) {
    logger.dim('native call patch already applied');
    return true;
  }
  const missing = [];
  for (const [what, from, to] of STEPS) {
    if (!foundIn(content, from)) { missing.push(what); continue; }
    content = typeof from === 'string' ? content.split(from).join(to) : content.replace(from, to);
  }
  if (missing.length) {
    // A partial patch would leave calls half wired: keep main.js as it was.
    throw new Error('native call patch not applied, Zalo changed: ' + missing.join('; '));
  }
  fs.writeFileSync(mainJs, content, 'utf8');
  logger.success('native call patch applied');
  return true;
}

if (require.main === module) main(process.argv[2]);

module.exports = { main };
