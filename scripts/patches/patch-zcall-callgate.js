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

const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const PC_DIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');

// Hash part of the filenames changes per Zalo version — glob by prefix.
const GLOB_TARGETS = [
  path.join(PC_DIST, 'compact-app-pc.*.js'),
  path.join(PC_DIST, 'search-worker.*.js'),
  path.join(PC_DIST, 'sync-v2-sub-worker.*.js'),
  path.join(PC_DIST, 'lazy', 'default-login-main-startup-shared-worker-znotification.*.js'),
];

const ORIGINAL = 'let ae=()=>{{const e=$znode.os.release();if(e){if(Number(e.split(".")[0])<17)return ae=()=>!1,!1}}return ae=()=>!0,ae()};';
const PATCHED = 'let ae=()=>{{const e=$znode.os.release();if(e){if("linux"!==$znode.os.platform()&&Number(e.split(".")[0])<17)return ae=()=>!1,!1}}return ae=()=>!0,ae()};';

// Static feature defaults have calls disabled (enableCall:!1, enableVideoCall:!1);
// the server may override them via settings.chat.enable_call, but if it does
// not send them, flip the defaults so calls are available out of the box.
const DEFAULTS_ORIGINAL = 'enableCall:!1,enableTag:!0,enableVideoCall:!1';
const DEFAULTS_PATCHED = 'enableCall:!0,enableTag:!0,enableVideoCall:!0';

async function main() {
  let patchedCount = 0;

  for (const pattern of GLOB_TARGETS) {
    // resolve the first matching file (hashes change per Zalo version)
    const dir = path.dirname(pattern);
    const base = path.basename(pattern);
    const [prefix, suffix] = base.split('*');
    const file = fs.existsSync(dir)
      ? (fs.readdirSync(dir).find(f => f.startsWith(prefix) && f.endsWith(suffix || '')) || null)
      : null;

    if (!file) {
      logger.warn('callgate target not found: ' + pattern);
      continue;
    }
    const filePath = path.join(dir, file);

    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;

    if (!content.includes(PATCHED) && content.includes(ORIGINAL)) {
      content = content.split(ORIGINAL).join(PATCHED);
      changed = true;
    }
    if (content.includes(DEFAULTS_ORIGINAL)) {
      content = content.split(DEFAULTS_ORIGINAL).join(DEFAULTS_PATCHED);
      changed = true;
    }

    if (!changed) {
      logger.dim('callgate already patched: ' + file);
      patchedCount++;
      continue;
    }
    fs.writeFileSync(filePath, content, 'utf8');
    logger.dim('callgate patched: ' + file);
    patchedCount++;
  }

  if (patchedCount > 0) logger.success(`zcall callgate patched (${patchedCount} files)`);
}

if (require.main === module) {
  main();
}

module.exports = { main };
