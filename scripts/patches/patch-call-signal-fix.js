const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { patchStrings, findTargetFiles } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

/**
 * Patch Zalo Call Signal Queue Deadlock:
 * Fixes outgoing/incoming calls getting stuck at "Đang kết nối..." (Connecting...)
 * caused by Signal 401 (requestCall) and call signaling being held inside requestQueue
 * without ever being dequeued on Linux.
 */
const REPLACEMENTS = [
  // 1. Disable using_queue in call config defaults
  {
    from: /using_queue:1/g,
    to: 'using_queue:0'
  },
  // 2. Bypass using_queue branch in call signal dispatcher
  {
    from: /if\((\w+)\)if\((\w+\.default\.call\.using_queue)\)/g,
    to: 'if($1)if(!1&&$2)'
  },
  // 3. Initialize call queue state variable to "idle" (instead of undefined)
  {
    from: /([A-Za-z0-9_$]+)="idle"[^;]*;function ([A-Za-z0-9_$]+)\(e=\{\}\)\{const\{limit:\w+=1\/0,maxTimeout:\w+=\w+\}=e,\w+=\[\];let ([A-Za-z0-9_$]+);const ([A-Za-z0-9_$]+)=[a-zA-Z0-9_$]+=>\{\3=[a-zA-Z0-9_$]+\}/g,
    to: (match, idleVar, _func, stateVar) => {
      return match.replace(`let ${stateVar};`, `let ${stateVar}=${idleVar};`);
    }
  },
  // 4. Force immediate dequeue when requestQueue is instantiated
  {
    from: /this\.requestQueue=([A-Za-z0-9_$]+)\(\),this\.retryQueue=\[\]/g,
    to: 'this.requestQueue=$1(),this.requestQueue.dequeue(),this.retryQueue=[]'
  }
];

async function main() {
  const pcDistDir = path.join(APP_DIR, 'pc-dist');
  const lazyDir = path.join(pcDistDir, 'lazy');

  if (!fs.existsSync(pcDistDir)) {
    logger.warn('pc-dist directory not found, skipping call-signal fix');
    return;
  }

  const targetFiles = [
    ...findTargetFiles(pcDistDir, /^(compact-app-pc|search-worker|sync-v2-sub-worker)\..*\.js$/),
    ...findTargetFiles(lazyDir, /^default-login-main-startup-shared-worker-znotification\..*\.js$/)
  ];

  for (const filePath of targetFiles) {
    patchStrings(filePath, REPLACEMENTS, `call signal queue: ${path.basename(filePath)}`);
  }

  if (targetFiles.length > 0) {
    logger.success(`Call signal queue deadlock patches applied (${targetFiles.length} files)`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
