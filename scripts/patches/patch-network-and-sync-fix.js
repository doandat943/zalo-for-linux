const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { patchStrings, findTargetFiles } = require('../utils/patcher');

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

  // gwig network manager, shared by the renderer and worker bundles.
  const NETWORK_STATE_FIX = [
    {
      from: 'networkConnected(){this.getStateNetwork()!==u.CONNECTED&&',
      to: 'networkConnected(){this.stateCur!==u.CONNECTED&&'
    },
    {
      from: 'const n=()=>{this.getStateNetwork()===u.CHECKING?',
      to: 'const n=()=>{this.stateCur===u.CHECKING?'
    },
    {
      from: 't<=0?(this.getStateNetwork()===u.CONNECTED?',
      to: 't<=0?(this.stateCur===u.CONNECTED?'
    },
    {
      from: 'getStateNetwork(){return this.stateCur}',
      to: 'getStateNetwork(){return u.CONNECTED}'
    }
    // NOTE: _pingToDomain is deliberately NOT replaced. The original code probes
    // the real network (XHR). Both the upstream #87 stub (always resolve -> never
    // detects offline) and the earlier navigator.onLine variant (stays false after
    // resume from suspend -> stuck offline) were wrong. The real probe fails when
    // wifi is off and succeeds once the link is back after resume, so CHECKING
    // resolves correctly in both cases.
  ];

  // 1. main-startup bundle in lazy/
  const startupFiles = findTargetFiles(lazyDir, /^main-startup\..*\.js$/);
  for (const f of startupFiles) {
    patchStrings(f, [
      // 1. Bypass offline guard and closed socket check in startup
      {
        from: /[\w.]+\.getStateNetwork\(\)===[\w.]+\.DISCONNECT\|\|[\w.]+\.getSocketState\(\)!==[\w.]+\.OPEN/g,
        to: '!1'
      },
      // 2. Bypass feature disabled check by server config
      {
        from: /checkFeatureEnabled\(\)\{return this\.configService\.isFeatureEnabled\(\)\?\{ok:!0\}:.*?reason:"feature_disabled"\}\)\}/g,
        to: 'checkFeatureEnabled(){return{ok:!0}}'
      },
      // 3. Bypass network disconnected check in guard
      {
        from: /checkNetwork\(\)\{const \w+=.*?reason:"network_disconnected".*?\}\}/g,
        to: 'checkNetwork(){return{ok:!0}}'
      },
      // 4. Force cross settings enabled
      {
        from: /isEnable\(\)\{const \w+=this\.config\.get\("cross_setting\.offFeature"\),\w+=this\.config\.get\("cross_setting\.enable"\);return!\w+&&\w+\}/g,
        to: 'isEnable(){return !0}'
      },
      {
        from: /isEnableResume\(\)\{return!!this\.isEnable\(\)&&this\.config\.get\("cross_setting\.enableResume"\)\}/g,
        to: 'isEnableResume(){return !0}'
      },
      // 5. Allow all sync sources (first time login, manual sync, missing e2ee messages...)
      {
        from: /isEnableBySrc\(\w+\)\{if\(this\.metricts\.onCheckSyncSuggestion\(\w+\),!this\.isEnable\(\)\)return!1;switch\(\w+\)\{.*?\}return!0\}/g,
        to: 'isEnableBySrc(e){return!0}'
      },
      // 6. Disable Sync V2 flag in SyncController to fall back to Sync V1
      {
        from: /isFeatureEnabled\(\)\{return this\.syncConfigService\.isFeatureEnabled\(\)\}/g,
        to: 'isFeatureEnabled(){return !1}'
      },
      {
        from: /isFeatureEnabledBySyncSource\((\w+)\)\{return this\.syncConfigService\.isFeatureEnabledBySyncSource\(\1\)\}/g,
        to: 'isFeatureEnabledBySyncSource($1){return !1}'
      }
    ]);
  }

  // 2. default-login bundle in lazy/
  const defaultLoginFiles = findTargetFiles(lazyDir, /^default-login-main-startup-shared-worker-znotification\..*\.js$/);
  for (const f of defaultLoginFiles) {
    patchStrings(f, [
      // Direct transfer_msg control events to SyncMessageController (Sync V1)
      {
        from: /case"transfer_msg":[\w.]+\.ModuleContainer\.resolve\([\w.]+\.SyncController\)\.isFeatureEnabled\(\)\?[\w.]+\._processSync2Ctrl\(\w+\[\w+\]\):([\w.]+\.SyncMessageController\.handleTransferAfterLoginCtrlEvents\(\w+\[\w+\]\);break;)/g,
        to: 'case"transfer_msg":$1'
      },
      ...NETWORK_STATE_FIX,
      {
        from: 'this.stateCur=u.NOT_SET',
        to: 'this.stateCur=u.CONNECTED'
      },
      // Enable call flags
      {
        from: /canUseIpcCall\(\)\{return \w+\.default\.enable_ipc_call&&\w+\}/g,
        to: 'canUseIpcCall(){return !0}'
      },
      {
        from: /isSupport\(\)\{return!!\w+\.default\.enable_mac_call&&\(\w+\.default\.enableCall&&\w+\)\}/g,
        to: 'isSupport(){return !0}'
      },
      {
        from: /isSupportVideoCall\(\)\{return this\.isSupport\(\)&&\w+\.default\.enableVideoCall\}/g,
        to: 'isSupportVideoCall(){return !0}'
      }
    ]);
  }

  // 3. Other worker & renderer bundles
  const otherBundles = [
    ...findTargetFiles(pcDistDir, /^compact-app-pc\..*\.js$/),
    ...findTargetFiles(pcDistDir, /^search-worker\..*\.js$/),
    ...findTargetFiles(pcDistDir, /^sync-v2-sub-worker\..*\.js$/)
  ];
  for (const f of otherBundles) {
    patchStrings(f, [
      // Direct transfer_msg control events to SyncMessageController (Sync V1)
      {
        from: /case"transfer_msg":[\w.]+\.ModuleContainer\.resolve\([\w.]+\.SyncController\)\.isFeatureEnabled\(\)\?[\w.]+\._processSync2Ctrl\(\w+\[\w+\]\):([\w.]+\.SyncMessageController\.handleTransferAfterLoginCtrlEvents\(\w+\[\w+\]\);break;)/g,
        to: 'case"transfer_msg":$1'
      },
      ...NETWORK_STATE_FIX,
      {
        from: 'this.stateCur=u.NOT_SET',
        to: 'this.stateCur=u.CONNECTED'
      },
      // Enable call flags
      {
        from: /canUseIpcCall\(\)\{return \w+\.default\.enable_ipc_call&&\w+\}/g,
        to: 'canUseIpcCall(){return !0}'
      },
      {
        from: /isSupport\(\)\{return!!\w+\.default\.enable_mac_call&&\(\w+\.default\.enableCall&&\w+\)\}/g,
        to: 'isSupport(){return !0}'
      },
      {
        from: /isSupportVideoCall\(\)\{return this\.isSupport\(\)&&\w+\.default\.enableVideoCall\}/g,
        to: 'isSupportVideoCall(){return !0}'
      }
    ]);
  }

  // 4. preload-sqlite.js
  const preloadSqlite = path.join(mainDistDir, 'preload-sqlite.js');
  if (fs.existsSync(preloadSqlite)) {
    patchStrings(preloadSqlite, [
      {
        from: 'cross_setting:{offFeature:!1,isMobileSupport:!1,',
        to: 'cross_setting:{enable:!0,offFeature:!1,isMobileSupport:!0,'
      },
      {
        from: 'try{let t=1==e.settings.chat.enable_call;at.enableCall=t}catch(ht){}',
        to: 'try{let t=1==e.settings.chat.enable_call;at.enableCall=!0}catch(ht){}'
      },
      {
        from: 'try{let t=1==e.settings.chat.enable_video_call;at.enableVideoCall=t}catch(ht){}',
        to: 'try{let t=1==e.settings.chat.enable_video_call;at.enableVideoCall=!0}catch(ht){}'
      },
      {
        from: 'enable_group_call_for_user:0,enable_group_call_entry_for_group:0',
        to: 'enable_group_call_for_user:1,enable_group_call_entry_for_group:1'
      }
    ]);
  }

  // 5. Enable SQLite backup data adapter flag in main process
  const mainJs = path.join(mainDistDir, 'main.js');
  if (fs.existsSync(mainJs)) {
    patchStrings(mainJs, [
      {
        from: 'const a=!1,s="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",l="CREATE_BACKING_UP_FOR_NO_SESSION";const d=!1',
        to: 'const a=!0,s="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",l="CREATE_BACKING_UP_FOR_NO_SESSION";const d=!0'
      }
    ]);
  }

  const utilSqlite = path.join(mainDistDir, 'utility-process-sqlite.js');
  if (fs.existsSync(utilSqlite)) {
    patchStrings(utilSqlite, [
      {
        from: 'const s=!1,a="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",u="CREATE_BACKING_UP_FOR_NO_SESSION";const l=!1',
        to: 'const s=!0,a="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",u="CREATE_BACKING_UP_FOR_NO_SESSION";const l=!0'
      }
    ]);
  }

  logger.success('Network and sync patches applied');
}

if (require.main === module) {
  main();
}

module.exports = { main };
