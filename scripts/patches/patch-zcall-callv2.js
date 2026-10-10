/**
 * patch-zcall-callv2.js
 *
 * Makes the call-v2 helper (ZaloCall.exe) work on Linux by spawning it under
 * Wine with a named-pipe -> TCP bridge.
 *
 * Background:
 *   Zalo PC 26.x does not use the old zcall .node addon anymore. The main
 *   process spawns a Qt helper (plugins/capture/ZaloCall.exe on Windows,
 *   ZaloHelper.app on macOS) and talks to it over two local channels with
 *   AES-128-CBC-encrypted JSON:
 *     - Windows: named pipes  \\.\pipe\PipeZCallRecv / PipeZCallSend
 *     - macOS:   unix sockets /tmp/socketzalorecv2021 / socketzalosend2021
 *
 *   On Linux neither branch works (no macOS helper; Wine 9.9+ removed AF_UNIX
 *   support, so unix sockets are out). This patch:
 *     1. makes the main process listen on TCP ports 29631/29632 on Linux
 *     2. spawns pipebridge.js under Wine (pure-Node, Electron 2 runtime),
 *        which hosts the named pipes and pumps bytes to the TCP ports
 *     3. spawns the Windows ZaloCall.exe under Wine with the named-pipe args
 *
 *   The transport crypto, message handling and renderer IPC stay untouched.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { patchStrings } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const MAIN_JS = path.join(APP_DIR, 'main-dist', 'main.js');

const REPLACEMENTS = [
  // 1. Channel addresses: TCP ports on Linux (inline platform checks)
  {
    from: /g="win32"===n\("([^"]+)"\)\.platform\(\),y=g\?"\\\\\\\\.\\\\pipe\\\\PipeZCallSend":"\/tmp\/socketzalosend2021",v=g\?"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv":"\/tmp\/socketzalorecv2021"/,
    to: 'g="win32"===n("$1").platform(),y=g?"\\\\\\\\.\\\\pipe\\\\PipeZCallSend":"linux"===n("$1").platform()?29632:"/tmp/socketzalosend2021",v=g?"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv":"linux"===n("$1").platform()?29631:"/tmp/socketzalorecv2021"'
  },
  // 2. Binary path: Linux ZaloCall.exe branch before the macOS branch
  {
    from: ':(e=u()?o.join(__dirname,"..","native","qt-call-cap-mac","ZaloHelper.app")',
    to: ':("linux"===process.platform?e=o.join(__dirname,"..","native","qt-call-and-cap","ZaloCall.exe"):(e=u()?o.join(__dirname,"..","native","qt-call-cap-mac","ZaloHelper.app")'
  },
  {
    from: 'e=o.join(e,"Contents","MacOS","ZaloCall")),e}();',
    to: 'e=o.join(e,"Contents","MacOS","ZaloCall"))),e}();'
  },
  // 3. Global call state variables (auth token TK, pipebridge-spawned flag BB)
  {
    from: 'let S,O,D,N,A,C=null,I=null,L=!1,P=[],M=!1,k=!0,x=[],F=!1,U=!1',
    to: 'let S,O,D,N,A,C=null,I=null,L=!1,P=[],M=!1,k=!0,x=[],F=!1,U=!1,TK=null,BB=!1'
  },
  // 4. Spawn: start pipebridge then ZaloCall under Wine with LD_PRELOAD streamproxy
  {
    from: ';A=i(e,[v,y]),A.stdout.setEncoding("utf8")',
    to: ';"linux"===process.platform?(BB||(BB=!0,TK="zcall-"+Math.random().toString(36).slice(2)+Date.now().toString(36),i(process.env.ZCALL_WINE||"wine",[o.join(__dirname,"..","native","qt-call-and-cap","pipebridge.exe"),"29631","29632",TK])),A=i(process.env.ZCALL_WINE||"wine",[e,"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv","\\\\\\\\.\\\\pipe\\\\PipeZCallSend"],{env:Object.assign({},process.env,{LD_PRELOAD:process.env.ZCALL_PROXY_SO||process.env.LD_PRELOAD||""})})):A=i(e,[v,y]),A.stdout.setEncoding("utf8")'
  },
  // 5. Server listen: TCP on Linux, unix socket elsewhere
  {
    from: 'I.listen(v,(',
    to: 'I.listen("linux"===process.platform?{port:v,host:"127.0.0.1"}:v,('
  },
  {
    from: 'C.listen(y,(',
    to: 'C.listen("linux"===process.platform?{port:y,host:"127.0.0.1"}:y,('
  },
  // 6. EADDRINUSE recovery: skip fs.unlink on Linux (v/y are port numbers)
  {
    from: 'g||a.unlink(v,',
    to: '"linux"===process.platform||g||a.unlink(v,'
  },
  {
    from: 'g||(U=!1,a.unlink(y,',
    to: '"linux"===process.platform||g||(U=!1,a.unlink(y,'
  },
  // 7. Send queue: clear the F flag shortly after each write to prevent stall
  {
    from: /,([$\w]+)=e=>\{if\(U\)if\(F\)[\s\S]{0,1000}?F=!0,e\.write\(t\)/,
    to: '$&,setTimeout((()=>{F=!1,$1(e)}),100)'
  },
  // 8. Auth token handshake verification for receive and send sockets
  {
    from: /e\.on\("data",\(([$\w]+)=>\{Y\(\1\)\}\)\),e\.on\("end"/,
    to: 'e.on("data",(n=>{if(e.t!==!0){e.t=(e.t||"")+n.toString();const p=e.t.indexOf("\\n");if(p<0)return;if(e.t.slice(0,p)!==TK)return e.destroy();n=e.t.slice(p+1),e.t=!0}n&&Y(n)})),e.on("end"'
  },
  {
    from: /e\.on\("data",\(([$\w]+)=>\{d\.zsymb\((\d+),"([^"]+)",\["serverSend on data","([^"]+)"\],\1\),g\|\|\(F=!1,([$\w]+)\(e\)\)\}\)\)/,
    to: 'e.on("data",($1=>{if(e.t!==!0){e.t=(e.t||"")+$1.toString();const i=e.t.indexOf("\\n");if(i<0)return;if(e.t.slice(0,i)!==TK)return e.destroy();$1=e.t.slice(i+1),e.t=!0}$5(e),d.zsymb($2,"$3",["serverSend on data","$4"],$1),g||(F=!1,$5(e))}))'
  },
  // 9. Reset L flag on helper error and exit so subsequent calls can re-spawn
  {
    from: /A\.on\("error",\(e=>\{d\.zsymb\((\d+),"([^"]+)",\["client error","([^"]+)"\],e\)\}\)\)/,
    to: 'A.on("error",(e=>{L=!1,d.zsymb($1,"$2",["client error","$3"],e)})),A.on("exit",(()=>{L=!1}))'
  },
  // 10. Queue sends while the helper is restarting instead of writing to a destroyed socket
  {
    from: 'O=t=>{g?V(e,t):G(e,t)',
    to: 'O=t=>{g?V(e,t):e&&!e.destroyed?G(e,t):x.push(t)'
  },
  {
    from: /else if\(e\)\{if\(x\.length\)\{const ([$\w]+)=x\.shift\(\);([$\w]+)\(e,\1\)/,
    to: 'else if(e&&!e.destroyed){if(x.length){const $1=x.shift();$2(e,$1)'
  },
  // 11. Lazy wine validation hook before helper start
  {
    from: /\}\(\);([$\w]+)\(e,([$\w]+)\)\.then\(\(t=>\{if\(([$\w]+)&&!t\)return L=!1/,
    to: '}();("linux"===process.platform&&global.__zcallPrepare?global.__zcallPrepare().then((()=>$1(e,$2))):$1(e,$2)).then((t=>{if($3&&!t)return L=!1'
  },
  // 12. Defer startup init and re-send init payload before makeCall
  {
    from: '.on("call-send-to-native",((e,t)=>{t._optional?delete t._optional:K()',
    to: '.on("call-send-to-native",((e,t)=>{if(global.__zcallDeferStartup&&t&&!t._optional&&"init"===t.command)return;t._optional?delete t._optional:K(),t&&"makeCall"===t.command&&D&&O(D)'
  }
];

async function main() {
  // If we are on aa64, skip the patch (because the binary is x64 only)
  if (process.arch === 'arm64' || process.arch === 'aarch64') {
    logger.info('skipping call-v2 patch on arm64');
    return;
  }

  if (!fs.existsSync(MAIN_JS)) {
    logger.warn('main.js not found, skipping call-v2 patch');
    return;
  }

  patchStrings(MAIN_JS, REPLACEMENTS, 'zcall call-v2');
  logger.success('zcall call-v2 patch applied');
}

if (require.main === module) {
  main();
}

module.exports = { main };
