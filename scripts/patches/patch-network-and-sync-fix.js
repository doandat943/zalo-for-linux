const fs = require('fs');
const path = require('path');

let logger;
try {
  logger = require('../utils/logger');
} catch (_) {
  logger = {
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    success: (...args) => console.log('[SUCCESS]', ...args),
    dim: (...args) => console.log(' ', ...args)
  };
}

const APP_DIR = path.join(__dirname, '..', '..', 'app');

/**
 * Patch Zalo network state detection (gwig) and sync controller routing:
 * 1. Force getStateNetwork() to return CONNECTED for OUTSIDE callers so sync and
 *    calls proceed, while the manager's own state machine keeps reading the real
 *    stateCur. Its connectivity probe (_pingToDomain) is left as the original
 *    real XHR check — NOT stubbed to always-resolve (upstream #87, never detects
 *    offline) and NOT tied to navigator.onLine (stays false after resume from
 *    suspend, leaving it stuck offline). The real probe fails when wifi is off
 *    and succeeds once the link is back after resume, so the manager goes
 *    DISCONNECT -> CHECKING -> CONNECTED again in both cases and re-signals the
 *    socket and UI, instead of staying stuck showing "no internet".
 * 2. Remove premature NO_NETWORK (1106) throw in main-startup.
 * 3. Route Sync Messages to SyncMessageController (V1) which sends push confirmation
 *    to mobile devices and saves message data via db-cross-v4 / sqlite3.
 * 4. Enable SQLite backup data adapter flag in main process.
 */
async function main() {
  const pcDistDir = path.join(APP_DIR, 'pc-dist');
  const mainDistDir = path.join(APP_DIR, 'main-dist');
  const lazyDir = path.join(pcDistDir, 'lazy');

  if (!fs.existsSync(pcDistDir)) {
    logger.warn('pc-dist directory not found, skipping network-and-sync fix');
    return;
  }

  function patchFile(filePath, replacements) {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;

    for (const [from, to] of replacements) {
      if (typeof from === 'string') {
        if (content.includes(from)) {
          content = content.split(from).join(to);
          changed = true;
        }
      } else if (from instanceof RegExp) {
        if (from.test(content)) {
          content = content.replace(from, to);
          changed = true;
        }
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, content, 'utf8');
      logger.dim(`Applied network & sync fix to ${path.basename(filePath)}`);
      return true;
    }
    return false;
  }

  function findFiles(dir, pattern) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => pattern.test(f))
      .map(f => path.join(dir, f));
  }

  // gwig network manager, shared by the renderer and worker bundles.
  const NETWORK_STATE_FIX = [
    ['networkConnected(){this.getStateNetwork()!==u.CONNECTED&&', 'networkConnected(){this.stateCur!==u.CONNECTED&&'],
    ['const n=()=>{this.getStateNetwork()===u.CHECKING?', 'const n=()=>{this.stateCur===u.CHECKING?'],
    ['t<=0?(this.getStateNetwork()===u.CONNECTED?', 't<=0?(this.stateCur===u.CONNECTED?'],
    ['getStateNetwork(){return this.stateCur}', 'getStateNetwork(){return u.CONNECTED}']
    // NOTE: _pingToDomain is deliberately NOT replaced. The original code probes
    // the real network (XHR). Both the upstream #87 stub (always resolve -> never
    // detects offline) and the earlier navigator.onLine variant (stays false after
    // resume from suspend -> stuck offline) were wrong. The real probe fails when
    // wifi is off and succeeds once the link is back after resume, so CHECKING
    // resolves correctly in both cases.
  ];

  // 1. main-startup bundle in lazy/
  const startupFiles = findFiles(lazyDir, /^main-startup\..*\.js$/);
  for (const f of startupFiles) {
    patchFile(f, [
      ['ge.b.getStateNetwork()===ge.a.DISCONNECT||_g.default.getSocketState()!==mg.l.OPEN', '!1'],
      [
        'checkFeatureEnabled(){return this.configService.isFeatureEnabled()?{ok:!0}:(this.logger.zsymb(9,"Oh4jaU",["Guard feature disabled by server config","VpsUI8"]),{ok:!1,reason:"feature_disabled"})}',
        'checkFeatureEnabled(){return{ok:!0}}'
      ],
      [
        'checkNetwork(){const e=ge.b.getStateNetwork();return e!==ge.a.DISCONNECT?{ok:!0}:(this.logger.zsymb(9,"3m6V8S",["Guard network disconnected","zonrE1"],{networkState:e}),{ok:!1,reason:"network_disconnected",networkState:e})}',
        'checkNetwork(){return{ok:!0}}'
      ],
      [
        'isEnable(){const e=this.config.get("cross_setting.offFeature"),t=this.config.get("cross_setting.enable");return!e&&t}',
        'isEnable(){return !0}'
      ],
      [
        'isEnableResume(){return!!this.isEnable()&&this.config.get("cross_setting.enableResume")}',
        'isEnableResume(){return !0}'
      ]
    ]);
  }

  // 2. default-login bundle in lazy/
  const defaultLoginFiles = findFiles(lazyDir, /^default-login-main-startup-shared-worker-znotification\..*\.js$/);
  for (const f of defaultLoginFiles) {
    patchFile(f, [
      ['const a=!0,s=!0,r=!0', 'const a=!0,s=!1,r=!0'],
      ...NETWORK_STATE_FIX,
      ['this.stateCur=u.NOT_SET', 'this.stateCur=u.CONNECTED'],
      ['canUseIpcCall(){return A.default.enable_ipc_call&&ne}', 'canUseIpcCall(){return !0}'],
      ['isSupport(){return!!A.default.enable_mac_call&&(A.default.enableCall&&se)}', 'isSupport(){return !0}'],
      ['isSupportVideoCall(){return this.isSupport()&&A.default.enableVideoCall}', 'isSupportVideoCall(){return !0}']
    ]);
  }

  // 3. Other worker & renderer bundles
  const otherBundles = [
    ...findFiles(pcDistDir, /^compact-app-pc\..*\.js$/),
    ...findFiles(pcDistDir, /^search-worker\..*\.js$/),
    ...findFiles(pcDistDir, /^sync-v2-sub-worker\..*\.js$/)
  ];
  for (const f of otherBundles) {
    patchFile(f, [
      ['const a=!0,i=!0,o=!0', 'const a=!0,i=!1,o=!0'],
      ...NETWORK_STATE_FIX,
      ['this.stateCur=u.NOT_SET', 'this.stateCur=u.CONNECTED'],
      ['canUseIpcCall(){return A.default.enable_ipc_call&&ne}', 'canUseIpcCall(){return !0}'],
      ['isSupport(){return!!A.default.enable_mac_call&&(A.default.enableCall&&ie)}', 'isSupport(){return !0}'],
      ['isSupportVideoCall(){return this.isSupport()&&A.default.enableVideoCall}', 'isSupportVideoCall(){return !0}']
    ]);
  }

  // 4. preload-sqlite.js
  const preloadSqlite = path.join(mainDistDir, 'preload-sqlite.js');
  if (fs.existsSync(preloadSqlite)) {
    patchFile(preloadSqlite, [
      ['cross_setting:{offFeature:!1,isMobileSupport:!1,', 'cross_setting:{enable:!0,offFeature:!1,isMobileSupport:!0,'],
      ['try{let t=1==e.settings.chat.enable_call;at.enableCall=t}catch(ht){}', 'try{let t=1==e.settings.chat.enable_call;at.enableCall=!0}catch(ht){}'],
      ['try{let t=1==e.settings.chat.enable_video_call;at.enableVideoCall=t}catch(ht){}', 'try{let t=1==e.settings.chat.enable_video_call;at.enableVideoCall=!0}catch(ht){}'],
      ['enable_group_call_for_user:0,enable_group_call_entry_for_group:0', 'enable_group_call_for_user:1,enable_group_call_entry_for_group:1']
    ]);
  }

  // 5. Enable SQLite backup data adapter flag in main process
  const mainJs = path.join(mainDistDir, 'main.js');
  if (fs.existsSync(mainJs)) {
    patchFile(mainJs, [
      [
        'const a=!1,s="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",l="CREATE_BACKING_UP_FOR_NO_SESSION";const d=!1',
        'const a=!0,s="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",l="CREATE_BACKING_UP_FOR_NO_SESSION";const d=!0'
      ]
    ]);
  }

  const utilSqlite = path.join(mainDistDir, 'utility-process-sqlite.js');
  if (fs.existsSync(utilSqlite)) {
    patchFile(utilSqlite, [
      [
        'const s=!1,a="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",u="CREATE_BACKING_UP_FOR_NO_SESSION";const l=!1',
        'const s=!0,a="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",u="CREATE_BACKING_UP_FOR_NO_SESSION";const l=!0'
      ]
    ]);
  }

  logger.success('Network and sync patches applied');
}

if (require.main === module) {
  main();
}

module.exports = { main };
