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

const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const MAIN_JS = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');

const REPLACEMENTS = [
  // 1. channel addresses: TCP ports on Linux (inline platform checks — no new
  //    variables: the module scope already uses every short name)
  {
    from: /g="win32"===n\("([^"]+)"\)\.platform\(\),y=g\?"\\\\\\\\.\\\\pipe\\\\PipeZCallSend":"\/tmp\/socketzalosend2021",v=g\?"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv":"\/tmp\/socketzalorecv2021"/,
    to: 'g="win32"===n("$1").platform(),y=g?"\\\\\\\\.\\\\pipe\\\\PipeZCallSend":"linux"===n("$1").platform()?29632:"/tmp/socketzalosend2021",v=g?"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv":"linux"===n("$1").platform()?29631:"/tmp/socketzalorecv2021"',
  },
  // 2. binary path: add Linux branch before the macOS branch
  {
    from: ':(e=u()?o.join(__dirname,"..","native","qt-call-cap-mac","ZaloHelper.app")',
    to: ':("linux"===process.platform?e=o.join(__dirname,"..","native","qt-call-and-cap","ZaloCall.exe"):(e=u()?o.join(__dirname,"..","native","qt-call-cap-mac","ZaloHelper.app")',
  },
  {
    from: 'e=o.join(e,"Contents","MacOS","ZaloCall")),e}();',
    to: 'e=o.join(e,"Contents","MacOS","ZaloCall"))),e}();',
  },
  // 3. spawn: on Linux, start pipebridge then ZaloCall under Wine.
  //    NOTE: `from` is anchored with the leading `;` so it cannot re-match
  //    inside this replacement's own else branch (which keeps the original
  //    text) — without the anchor, every re-run of the patch script nests
  //    another dead linux branch into the ternary.
  {
    from: ';A=i(e,[v,y]),A.stdout.setEncoding("utf8")',
    to: ';"linux"===process.platform?(i(process.env.ZCALL_WINE||"wine",[o.join(__dirname,"..","native","qt-call-and-cap","pipebridge.exe"),"29631","29632"]),A=i(process.env.ZCALL_WINE||"wine",[e,"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv","\\\\\\\\.\\\\pipe\\\\PipeZCallSend"])):A=i(e,[v,y]),A.stdout.setEncoding("utf8")',
    already: ';"linux"===process.platform?(BB||(BB=!0,TK=',
  },
  // 4. listen: TCP on Linux, unix socket elsewhere
  {
    from: 'I.listen(v,(',
    to: 'I.listen("linux"===process.platform?{port:v,host:"127.0.0.1"}:v,(',
  },
  {
    from: 'C.listen(y,(',
    to: 'C.listen("linux"===process.platform?{port:y,host:"127.0.0.1"}:y,(',
  },
  // 5. EADDRINUSE recovery: skip fs.unlink on Linux (v/y are ports there)
  {
    from: 'g||a.unlink(v,',
    to: '"linux"===process.platform||g||a.unlink(v,',
  },
  {
    from: 'g||(U=!1,a.unlink(y,',
    to: '"linux"===process.platform||g||(U=!1,a.unlink(y,',
  },
  // 6. Re-send the init payload right before every makeCall. The helper
  //    rejects makeCall with error -11 ("init_error") if it has not seen
  //    the init data yet; sending D first (same TCP stream, order
  //    preserved) removes that race.
  {
    from: '.on("call-send-to-native",((e,t)=>{t._optional?delete t._optional:K(),O(t)}))',
    to: '.on("call-send-to-native",((e,t)=>{t._optional?delete t._optional:K(),t&&"makeCall"===t.command&&D&&O(D),O(t)}))',
    // step 14 rewrites the start of this handler
    already: 't&&"makeCall"===t.command&&D&&O(D),O(t)}))',
  },
  // 7. Fix the send queue's F flag. On the non-win32 path the flag is only
  //    cleared when the helper sends data back on the send channel — which
  //    it almost never does — so after the first message every further
  //    message stalls in the queue forever (init goes through, makeCall
  //    never arrives). Reset the flag shortly after each write.
  {
    from: /,([$\w]+)=e=>\{if\(U\)if\(F\)[\s\S]{0,1000}?F=!0,e\.write\(t\)/,
    to: '$&,setTimeout((()=>{F=!1,$1(e)}),100)',
    already: /F=!0,e\.write\(t\),setTimeout\(\(\(\)=>\{F=!1,[$\w]+\(e\)\}\),100\)/,
  },
  // 8. Auth token handshake: the main process generates a random token,
  //    passes it to pipebridge, and requires it as the first line of every
  //    TCP connection. Drops connections that do not present the token.
  {
    from: 'let S,O,D,N,A,C=null,I=null,L=!1,P=[],M=!1,k=!0,x=[],F=!1,U=!1',
    to: 'let S,O,D,N,A,C=null,I=null,L=!1,P=[],M=!1,k=!0,x=[],F=!1,U=!1,TK=null',
  },
  // 9. Reset the "native started" flag when the helper spawn FAILS (e.y.
  //    wine missing). Without this, a failed first spawn leaves L=true
  //    forever and later call attempts never re-spawn until app restart.
  {
    from: /A\.on\("error",\(e=>\{d\.zsymb\((\d+),"([^"]+)",\["client error","([^"]+)"\],e\)\}\)\)/,
    to: 'A.on("error",(e=>{L=!1,d.zsymb($1,"$2",["client error","$3"],e)}))',
  },
  {
    from: 'i(process.env.ZCALL_WINE||"wine",[o.join(__dirname,"..","native","qt-call-and-cap","pipebridge.exe"),"29631","29632"]),A=i(process.env.ZCALL_WINE||"wine"',
    to: 'TK="zcall-"+Math.random().toString(36).slice(2)+Date.now().toString(36),i(process.env.ZCALL_WINE||"wine",[o.join(__dirname,"..","native","qt-call-and-cap","pipebridge.exe"),"29631","29632",TK]),A=i(process.env.ZCALL_WINE||"wine"',
    already: 'BB||(BB=!0,TK="zcall-"',
  },
  // 10. Wayland screen-share bridge: preload the streamproxy shim (when the
  //     plugin set ZCALL_PROXY_SO) so ZaloCall's screen-capture reads are
  //     served from the bridge display while the app itself stays native.
  //     Preserve the launcher's preload alongside the screen-share shim.
  {
    from: '[e,"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv","\\\\\\\\.\\\\pipe\\\\PipeZCallSend"]))',
    to: '[e,"\\\\\\\\.\\\\pipe\\\\PipeZCallRecv","\\\\\\\\.\\\\pipe\\\\PipeZCallSend"],{env:Object.assign({},process.env,{LD_PRELOAD:process.env.ZCALL_PROXY_SO||process.env.LD_PRELOAD||""})}))',
    already: 'LD_PRELOAD:[process.env.ZCALL_PROXY_SO,process.env.LD_PRELOAD].filter(Boolean).join(":")',
  },
  {
    from: /e\.on\("data",\(([$\w]+)=>\{Y\(\1\)\}\)\),e\.on\("end"/,
    to: 'e.on("data",(n=>{if(e.t!==!0){e.t=(e.t||"")+n.toString();const p=e.t.indexOf("\\n");if(p<0)return;if(e.t.slice(0,p)!==TK)return e.destroy();n=e.t.slice(p+1),e.t=!0}n&&Y(n)})),e.on("end"',
  },
  {
    from: /e\.on\("data",\(([$\w]+)=>\{d\.zsymb\((\d+),"([^"]+)",\["serverSend on data","([^"]+)"\],\1\),g\|\|\(F=!1,([$\w]+)\(e\)\)\}\)\)/,
    to: 'e.on("data",($1=>{if(e.t!==!0){e.t=(e.t||"")+$1.toString();const i=e.t.indexOf("\\n");if(i<0)return;if(e.t.slice(0,i)!==TK)return e.destroy();$1=e.t.slice(i+1),e.t=!0}d.zsymb($2,"$3",["serverSend on data","$4"],$1),g||(F=!1,$5(e))}))',
    already: /e\.t=!0\}[$\w]+\(e\),d\.zsymb\(/,
  },
  // 11. Helper restart support. The Wayland screen bridge restarts ZaloCall
  //     mid-session (DISPLAY is read at spawn time), so the helper must be
  //     able to die and come back: reset L on exit, and spawn pipebridge
  //     (which owns the auth token) only ONCE per session — pipebridge
  //     re-creates the pipes itself and waits for the next ZaloCall.
  //     (BB, not B: the module already declares B.)
  {
    from: 'F=!1,U=!1,TK=null',
    to: 'F=!1,U=!1,TK=null,BB=!1',
  },
  {
    from: 'TK="zcall-"+Math.random().toString(36).slice(2)+Date.now().toString(36),i(process.env.ZCALL_WINE||"wine",[o.join(__dirname,"..","native","qt-call-and-cap","pipebridge.exe"),"29631","29632",TK]),A=i(process.env.ZCALL_WINE||"wine"',
    to: 'BB||(BB=!0,TK="zcall-"+Math.random().toString(36).slice(2)+Date.now().toString(36),i(process.env.ZCALL_WINE||"wine",[o.join(__dirname,"..","native","qt-call-and-cap","pipebridge.exe"),"29631","29632",TK])),A=i(process.env.ZCALL_WINE||"wine"',
  },
  {
    from: /A\.on\("error",\(e=>\{L=!1,d\.zsymb\((\d+),"([^"]+)",\["client error","([^"]+)"\],e\)\}\)\)/,
    to: 'A.on("error",(e=>{L=!1,d.zsymb($1,"$2",["client error","$3"],e)})),A.on("exit",(()=>{L=!1}))',
  },
  // 12. Queue sends while the helper is restarting instead of writing to a
  //     destroyed socket (unhandled socket error would crash the main
  //     process). The queue is flushed when pipebridge reconnects (token
  //     line below) or after each helper message.
  {
    from: 'O=t=>{g?V(e,t):G(e,t)',
    // No trailing `}`: O is the last statement of the connection callback
    // and the original `}}))` closes O, the callback and C.on( — adding a
    // brace here breaks the bundle syntax.
    to: 'O=t=>{g?V(e,t):e&&!e.destroyed?G(e,t):x.push(t)',
  },
  {
    from: /e\.t=!0\}d\.zsymb\((\d+),"([^"]+)",\["serverSend on data","([^"]+)"\],([$\w]+)\),g\|\|\(F=!1,([$\w]+)\(e\)\)/,
    to: 'e.t=!0}$5(e),d.zsymb($1,"$2",["serverSend on data","$3"],$4),g||(F=!1,$5(e))',
  },
  {
    from: /else if\(e\)\{if\(x\.length\)\{const ([$\w]+)=x\.shift\(\);([$\w]+)\(e,\1\)/,
    to: 'else if(e&&!e.destroyed){if(x.length){const $1=x.shift();$2(e,$1)',
  },
  // 13. Call mode (#80): before the helper start, await the zcall-bridge
  //     plugin's global.__zcallPrepare(). In "lazy" mode it finds and
  //     validates wine only now; in "off" mode it rejects. A rejection lands
  //     in the chain's own .catch, which resets L so the next call retries.
  {
    from: /\}\(\);([$\w]+)\(e,([$\w]+)\)\.then\(\(t=>\{if\(([$\w]+)&&!t\)return L=!1/,
    to: '}();("linux"===process.platform&&global.__zcallPrepare?global.__zcallPrepare().then((()=>$1(e,$2))):$1(e,$2)).then((t=>{if($3&&!t)return L=!1',
    already: /global\.__zcallPrepare\([^)]*\)\.then\(/,
  },
  // 14. The server flag call.launch_native_in_startup makes the renderer
  //     send the "init" message non-optional, which starts the helper at
  //     launch. In "lazy"/"off" mode the plugin sets
  //     global.__zcallDeferStartup: drop that message instead. The init
  //     payload itself (D, from call-init) is re-sent before every makeCall
  //     (step 6).
  {
    from: '.on("call-send-to-native",((e,t)=>{t._optional?delete t._optional:K()',
    to: '.on("call-send-to-native",((e,t)=>{if(global.__zcallDeferStartup&&t&&!t._optional&&"init"===t.command)return;t._optional?delete t._optional:K()',
    already: 'if(global.__zcallDeferStartup&&t&&!t._optional&&"init"===t.command)return;',
  },
  // 15. Pass the triggering message to the mode gate so remote signals can
  //     be blocked silently while local actions retain the settings reminder.
  { from: 'function K(){if(L)', to: 'function K(ZCALL_MESSAGE){if(L)' },
  { from: 'global.__zcallPrepare().then(', to: 'global.__zcallPrepare(ZCALL_MESSAGE).then(' },
  { from: 't._optional?delete t._optional:K(),t&&"makeCall"', to: 't._optional?delete t._optional:K(t),t&&"makeCall"' },
  // Turning calls off kills pipebridge too. The next call must recreate
  // both processes and discard frames queued for the previous session.
  {
    from: 'function K(ZCALL_MESSAGE){if(L)',
    to: 'global.__zcallResetTransport=()=>{L=!1,BB=!1,M=!1,TK=null,P=[],x=[],H()};function K(ZCALL_MESSAGE){if(L)',
  },
  {
    from: '.on("call-send-to-native",((e,t)=>{if(global.__zcallDeferStartup',
    to: '.on("call-send-to-native",((e,t)=>{if(global.__zcallShouldSend&&!global.__zcallShouldSend(t))return;if(global.__zcallDeferStartup',
  },
];

function isAlreadyApplied(content, to) {
  const parts = to.split(/\$\d+/);
  if (parts.length === 1) return content.includes(to) ? to : null;
  for (let start = content.indexOf(parts[0]); start !== -1; start = content.indexOf(parts[0], start + 1)) {
    let end = start + parts[0].length;
    if (parts.slice(1).every(part => {
      const next = content.indexOf(part, end);
      if (next < 0 || next - end > 80) return false;
      end = next + part.length;
      return true;
    })) return content.slice(start, end);
  }
  return null;
}

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    logger.warn('main.js not found, skipping call-v2 patch');
    return;
  }

  let content = fs.readFileSync(MAIN_JS, 'utf8');
  const originalContent = content;
  // Older bundles discarded the launcher's preload; retain it on re-patch.
  content = content.replace(
    'LD_PRELOAD:process.env.ZCALL_PROXY_SO||process.env.LD_PRELOAD||""',
    'LD_PRELOAD:[process.env.ZCALL_PROXY_SO,process.env.LD_PRELOAD].filter(Boolean).join(":")'
  );
  let applied = Number(content !== originalContent);
  let missing = 0;

  for (const [index, { from, to, already }] of REPLACEMENTS.entries()) {
    const done = (already && (typeof already === 'string' ? content.includes(already) && already : already.exec(content)?.[0])) || isAlreadyApplied(content, to);
    if (done) {
      logger.dim('call-v2 patch already applied: ' + done.slice(0, 60) + '...');
      continue;
    }
    const match = typeof from === 'string' ? null : from.exec(content);
    const count = typeof from === 'string' ? content.split(from).length - 1 : Number(!!match);
    if (count === 0) {
      logger.warn(`call-v2 pattern not found at step ${index + 1}`);
      missing++;
      continue;
    }
    content = typeof from === 'string' ? content.split(from).join(to) : content.replace(from, to);
    applied += count;
    logger.dim(`call-v2 patched (x${count}): ${(match ? match[0] : from).slice(0, 60)}...`);
  }

  if (missing) {
    logger.warn(`call-v2 patch incomplete: ${missing} pattern(s) not found`);
    return;
  }
  if (applied > 0) {
    fs.writeFileSync(MAIN_JS, content, 'utf8');
    logger.success('zcall call-v2 patch applied');
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
