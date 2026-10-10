/**
 * patch-zcall-callgate.js
 *
 * Fixes the call-button gate that accidentally disables calls on Linux.
 *
 * Zalo's call controller computes a support flag from the OS release version:
 *
 *   let ae=()=>{{
 *     const e=$znode.os.release();
 *     if(e){ if(Number(e.split(".")[0])<17) return ae=()=>!1,!1 }
 *   }
 *   return ae=()=>!0,ae()};
 *   const ie=ae();   // -> isSupport() uses this
 *
 * This was written for macOS (Darwin kernel >= 17), but on Linux
 * os.release() is the Linux kernel version (e.g. "7.0.0-30-generic"),
 * so Number("7") < 17 makes the gate false and the call button stays
 * disabled / makeCall() hits the "[zcall-v2] Call is not supported!" stub.
 *
 * Patch: skip the version check on Linux, keep it intact on other platforms.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { patchStrings, findTargetFiles } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const REPLACEMENTS = [
  // 1. Skip Darwin kernel check on Linux
  {
    from: /let (\w+)=\(\)=>\{\{const (\w+)=\$znode\.os\.release\(\);if\(\2\)\{if\((?:"linux"!==\$znode\.os\.platform\(\)&&)?Number\(\2\.split\("\."\)\[0\]\)<17\)return \1=\(\)=>!1,!1\}\}return \1=\(\)=>!0,\1\(\)\};/g,
    to: 'let $1=()=>{{const $2=$znode.os.release();if($2){if("linux"!==$znode.os.platform()&&Number($2.split(".")[0])<17)return $1=()=>!1,!1}}return $1=()=>!0,$1()};'
  },
  // 2. Static feature defaults have calls disabled (enableCall:!1, enableVideoCall:!1);
  //    flip the defaults so calls are available out of the box on Linux.
  {
    from: /enableCall:!(?:0|1),(enableTag:!0,)enableVideoCall:!(?:0|1)/g,
    to: 'enableCall:!0,$1enableVideoCall:!0'
  }
];

async function main() {
  // If we are on aa64, skip the patch (because the binary is x64 only)
  if (process.arch === 'arm64' || process.arch === 'aarch64') {
    logger.info('skipping callgate patch on arm64');
    return;
  }

  const pcDistDir = path.join(APP_DIR, 'pc-dist');
  const lazyDir = path.join(pcDistDir, 'lazy');

  if (!fs.existsSync(pcDistDir)) {
    logger.warn('pc-dist directory not found, skipping callgate patch');
    return;
  }

  const targetFiles = [
    ...findTargetFiles(pcDistDir, /^(compact-app-pc|search-worker|sync-v2-sub-worker)\..*\.js$/),
    ...findTargetFiles(lazyDir, /^default-login-main-startup-shared-worker-znotification\..*\.js$/)
  ];

  for (const filePath of targetFiles) {
    patchStrings(filePath, REPLACEMENTS, `callgate: ${path.basename(filePath)}`);
  }

  if (targetFiles.length > 0) {
    logger.success(`zcall callgate patched (${targetFiles.length} files)`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
