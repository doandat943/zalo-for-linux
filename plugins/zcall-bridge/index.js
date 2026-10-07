/**
 * plugins/zcall-bridge/index.js
 *
 * zcall call-v2 Wine environment manager.
 *
 * Zalo 26.x runs calls through a Qt helper (ZaloCall.exe on Windows). On
 * Linux, the patched main-dist code (scripts/patches/patch-zcall-callv2.js)
 * spawns the Windows ZaloCall.exe under Wine, bridged over named pipes ->
 * TCP by pipebridge.exe (see app/native/qt-call-and-cap/).
 *
 * This plugin prepares the environment before any call can happen:
 *   1. Locates a wine binary, best first: env ZCALL_WINE -> user-picked
 *      custom wine (config) -> downloaded runtime (userData) -> `wine` in
 *      PATH -> Bottles kron4ek runner. Every candidate is validated by
 *      actually running a 32-bit exe (pipebridge --version).
 *   2. If no usable wine exists on first run, ASKS the user (always-on-top
 *      window with browse/download options) and downloads a portable wine
 *      into <userData>/zcall-wine-runtime/ with a progress window —
 *      no root needed, works on any distro.
 *   3. Ensures the wine prefix exists (wineboot), exports
 *      ZCALL_WINE / ZCALL_WINEPREFIX / WINEDEBUG into process.env.
 *   4. On quit, kills the whole wine session of our prefix; on launch,
 *      sweeps stale wine processes of unclean previous exits.
 *   5. Tray menu "Cài đặt gọi điện…" opens a settings window: browse/clear/
 *      remove wine, and pick the call mode.
 *
 * Call mode (zcall-config.json "callMode", chosen in the settings window):
 *   auto   (default) steps 1-3 run at launch: the first call starts at once
 *   lazy   nothing runs at launch; steps 1-3 run in the background when the
 *          call engine is first needed, so that first call takes longer
 *   off    wine is never started; a call attempt shows a notification
 *
 * Configuration (env vars):
 *   ZCALL_WINE                 wine binary (highest priority)
 *   ZCALL_WINEPREFIX           wine prefix (default: <userData>/zcall-wine)
 *   ZCALL_DISABLE              set to anything to force call mode "off"
 *   ZCALL_AUTO_SETUP           '1' to download wine silently (no dialog)
 *   ZCALL_WINE_DOWNLOAD_URL    override the portable wine download URL
 */

'use strict';

const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { startCameraBridge } = require('./camera');

// The Windows helper stays PE32; Wine's Unix side and camera capture are 64-bit.
process.env.WINEARCH = 'wow64';

// Recommended build: 11.14 WoW64. Video calls were verified on classic
// 11.14 and new WoW64 11.17; wine 8.6 is lighter (54MB) but its
// msvcp140/ucrtbase lack _Throw_C_error, which crashes ZaloCall when the
// video pipeline hits an error (e.g. codec/format negotiation).
const WINE_DOWNLOAD_URL =
  'https://github.com/Kron4ek/Wine-Builds/releases/download/11.14/wine-11.14-amd64-wow64.tar.xz';
const RUNTIME_DIRNAME = 'zcall-wine-runtime';
const CONFIG_FILENAME = 'zcall-config.json';
// Last successful validateWine() (writeConfig replaces the whole config file,
// so it lives in its own file).
const CHECK_FILENAME = 'zcall-wine-check.json';
// Re-check a cached wine in the background this long after launch.
const RECHECK_DELAY_MS = 20000;
const CALL_MODES = ['auto', 'lazy', 'off'];

let dialogModule = null;
let BrowserWindowModule = null;
let NotificationModule = null;

function getElectronModules() {
  try {
    const electron = require('electron');
    dialogModule = electron.dialog;
    BrowserWindowModule = electron.BrowserWindow;
    NotificationModule = electron.Notification;
  } catch (e) { /* not running inside Electron (unit tests) */ }
}

// ---------------------------------------------------------------------------
// Config (per-user choices, stored in userData)
// ---------------------------------------------------------------------------

function readConfig(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, CONFIG_FILENAME), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeConfig(userDataDir, cfg) {
  // Callers pass the whole wine state and drop the other keys; the call
  // mode is a separate choice and must survive those writes.
  const saved = readConfig(userDataDir);
  for (const key of ['callMode', 'callModeOn']) {
    if (!(key in cfg) && saved[key]) cfg = Object.assign({}, cfg, { [key]: saved[key] });
  }
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, CONFIG_FILENAME), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[zcall-bridge] could not write config:', e.message);
  }
}

function getCallMode(userDataDir) {
  if (process.env.ZCALL_DISABLE) return 'off';
  const mode = readConfig(userDataDir).callMode;
  return CALL_MODES.includes(mode) ? mode : 'auto';
}

// ---------------------------------------------------------------------------
// Wine discovery
// ---------------------------------------------------------------------------

function findWine() {
  if (process.env.ZCALL_WINE) return process.env.ZCALL_WINE;

  // 1. wine from PATH
  const which = spawnSync('which', ['wine'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();

  // 2. Bottles flatpak kron4ek runners (known-good on this setup)
  const runnersRoot = path.join(os.homedir(), '.var', 'app', 'com.usebottles.bottles', 'data', 'bottles', 'runners');
  if (fs.existsSync(runnersRoot)) {
    const entries = fs.readdirSync(runnersRoot).sort().reverse();
    for (const name of entries) {
      if (!/^kron4ek-wine/.test(name)) continue;
      const candidate = path.join(runnersRoot, name, 'bin', 'wine');
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function findDownloadedWine(userDataDir) {
  const p = path.join(userDataDir, RUNTIME_DIRNAME, 'bin', 'wine');
  return fs.existsSync(p) ? p : null;
}

/**
 * Wine bundled inside the "Full" AppImage variant (app/native/wine-runtime).
 * In the packaged app, app/ sits at the AppImage mount root next to the
 * executable; in dev mode it is the repo's app/ directory.
 */
function findBundledWine() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'app', 'native', 'wine-runtime', 'bin', 'wine'),
    path.join(__dirname, '..', '..', 'app', 'native', 'wine-runtime', 'bin', 'wine')
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Verify that this wine can actually run 32-bit executables (ZaloCall is a
 * PE32 binary). Runs pipebridge.exe --version (a 32-bit exe) with a timeout.
 * Returns true only when it prints the expected output.
 */
function findPipebridgePath() {
  const candidates = [
    // packaged AppImage: app/ sits at the mount root, next to the executable
    path.join(path.dirname(process.execPath), 'app', 'native', 'qt-call-and-cap', 'pipebridge.exe'),
    // packaged alternative: extraFiles under resources/
    path.join(process.resourcesPath || '', 'app', 'native', 'qt-call-and-cap', 'pipebridge.exe'),
    // dev layout: repo/plugins/zcall-bridge -> repo/app/...
    path.join(__dirname, '..', '..', 'app', 'native', 'qt-call-and-cap', 'pipebridge.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Real filesystem path into the zcall-bridge directory. These files are
 * spawned or LD_PRELOADed, so they must live OUTSIDE the asar archive: the
 * package config ships zcall-bridge/ next to app/ at the AppImage mount
 * root. Returns the packaged path when present, else the dev layout.
 */
function zcallBridgePath(...parts) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'zcall-bridge', ...parts),
    path.join(__dirname, '..', '..', 'zcall-bridge', ...parts)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[1];
}

// Console output is redirected by Zalo's own logger after bootstrap, so
// diagnostics go to a file the user can inspect.
function debugLog(msg) {
  try {
    const p = path.join(os.homedir(), '.config', 'ZaloData', 'zcall-debug.log');
    fs.appendFileSync(p, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) { /* ignore */ }
}

function validateWine(winePath, prefix) {
  const pipebridgePath = findPipebridgePath();
  if (!pipebridgePath) {
    debugLog('validate: pipebridge.exe not found (resourcesPath=' + (process.resourcesPath || '') + ')');
    return false;
  }
  // Use the call engine's prefix for validation too, so the app maintains
  // only one prefix. A cold first run needs a generous timeout.
  const valPrefix = prefix;
  try {
    const res = spawnSync(winePath, [pipebridgePath, '--version'], {
      env: Object.assign({}, process.env, { WINEPREFIX: valPrefix, WINEDEBUG: '-all' }),
      encoding: 'utf8',
      timeout: 120000
    });
    if (res.status === 0 && /pipebridge/.test(res.stdout || '')) return true;
    debugLog('validate FAILED wine=' + winePath + ' pipebridge=' + pipebridgePath +
      ' prefix=' + valPrefix +
      ' status=' + res.status +
      ' spawnError=' + (res.error ? res.error.message : '') +
      ' stdout=' + String(res.stdout || '').slice(0, 200) +
      ' stderr=' + String(res.stderr || '').split('\n').slice(0, 4).join(' | '));
    console.error('[zcall-bridge] wine validation failed:', winePath, '(xem zcall-debug.log)');
    return false;
  } catch (e) {
    debugLog('validate THREW wine=' + winePath + ' ' + e.message);
    console.error('[zcall-bridge] wine validation threw:', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Validation cache
//
// validateWine() blocks the main process (spawnSync, cold wineserver: ~1s,
// up to the 120s timeout) on every launch, although the wine rarely changes.
// A successful check is remembered by the size/mtime of wine and pipebridge
// and the prefix. The bundled runtime is mounted at a random path per run, so
// it is keyed as "bundled". A cached wine is used right away and re-checked
// in the background; a failed re-check clears the cache so the next launch
// validates again.
// ---------------------------------------------------------------------------

function fileStamp(p) {
  try {
    const st = fs.statSync(p);
    return st.size + ':' + Math.floor(st.mtimeMs);
  } catch (_) {
    return null;
  }
}

function wineCheckKey(winePath, prefix) {
  const pipebridgePath = findPipebridgePath();
  const wineStamp = fileStamp(winePath);
  const pbStamp = pipebridgePath && fileStamp(pipebridgePath);
  if (!wineStamp || !pbStamp) return null;
  const id = winePath === findBundledWine() ? 'bundled' : winePath;
  return [id, wineStamp, pbStamp, prefix].join('|');
}

function isWineCheckCached(userDataDir, winePath, prefix) {
  const key = wineCheckKey(winePath, prefix);
  if (!key) return false;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(userDataDir, CHECK_FILENAME), 'utf8'));
    return data.key === key;
  } catch (_) {
    return false;
  }
}

function writeWineCheck(userDataDir, winePath, prefix) {
  const key = winePath && wineCheckKey(winePath, prefix);
  const file = path.join(userDataDir, CHECK_FILENAME);
  try {
    if (key) fs.writeFileSync(file, JSON.stringify({ key }));
    else fs.rmSync(file, { force: true });
  } catch (_) { /* cache only */ }
}

// Runs wine without blocking the main process. Resolves { code, out }.
function runWineAsync(winePath, args, prefix, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(kill);
      resolve({ code, out });
    };
    let child;
    try {
      child = spawn(winePath, args, {
        env: Object.assign({}, process.env, { WINEPREFIX: prefix, WINEDEBUG: '-all' }),
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (e) {
      resolve({ code: -1, out: '' });
      return;
    }
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code));
  });
}

// Same check as validateWine(), without blocking the main process.
async function validateWineAsync(winePath, prefix) {
  const pipebridgePath = findPipebridgePath();
  if (!pipebridgePath) return false;
  const { code, out } = await runWineAsync(winePath, [pipebridgePath, '--version'], prefix, 120000);
  if (code === 0 && /pipebridge/.test(out)) return true;
  debugLog('async validate FAILED wine=' + winePath + ' status=' + code);
  return false;
}

function recheckWineLater(userDataDir, winePath, prefix) {
  const timer = setTimeout(async () => {
    if (!findPipebridgePath()) return;
    if (await validateWineAsync(winePath, prefix)) return;
    debugLog('background re-check FAILED wine=' + winePath + ' — cache cleared');
    writeWineCheck(userDataDir, null, prefix);
  }, RECHECK_DELAY_MS);
  if (timer.unref) timer.unref();
}

/**
 * Kill leftover wine processes of OUR prefix (e.g. winedevice orphans left
 * by an unclean kill -9 of a previous session). Safe to run at launch: no
 * legit session exists yet.
 */
function sweepStaleProcesses(prefix) {
  // Leftover helper processes from unclean previous exits (kill -9 etc.)
  killProcessesByPattern('qt-call-and-cap');
  killProcessesByPattern('PipeZCall');
  try {
    for (const name of ['wineserver', 'winedevice.exe']) {
      let out = '';
      try { out = execSync('pgrep -x ' + name, { encoding: 'utf8' }); } catch (_) { continue; }
      for (const pid of out.trim().split('\n')) {
        if (!pid) continue;

        // winedevice is legit only when its parent is a live wineserver;
        // orphans get reparented to systemd/init and must be killed.
        if (name === 'winedevice.exe') {
          let ppid = '';
          try {
            const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
            ppid = (stat.split(') ')[1] || '').split(' ')[1] || '';
          } catch (_) { continue; }
          if (parentIsWineserver(ppid)) continue; // belongs to a live wineserver
          process.kill(Number(pid), 'SIGKILL');
          continue;
        }

        // wineserver: match by the prefix in its environment
        let env = '';
        try { env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8'); } catch (_) { continue; }
        if (env.includes(prefix)) {
          process.kill(Number(pid), 'SIGKILL');
        }
      }
    }
  } catch (_) { /* nothing stale */ }
}

// ---------------------------------------------------------------------------
// Portable wine download + extract
// ---------------------------------------------------------------------------

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      res.on('data', (chunk) => {
        got += chunk.length;
        if (onProgress && total) onProgress(got, total);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => {
      file.close();
      try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
      reject(e);
    });
  });
}

async function installDownloadedWine(userDataDir, onProgress) {
  const runtimeDir = path.join(userDataDir, RUNTIME_DIRNAME);
  const tarball = path.join(userDataDir, 'zcall-wine-download.tar.xz');
  const url = process.env.ZCALL_WINE_DOWNLOAD_URL || WINE_DOWNLOAD_URL;

  fs.mkdirSync(userDataDir, { recursive: true });
  await downloadFile(url, tarball, onProgress);

  fs.mkdirSync(runtimeDir, { recursive: true });
  execSync(`tar -xf "${tarball}" -C "${runtimeDir}" --strip-components=1`, { stdio: 'pipe' });
  fs.unlinkSync(tarball);

  const wine = path.join(runtimeDir, 'bin', 'wine');
  if (!fs.existsSync(wine)) throw new Error('wine binary not found after extract');
  return wine;
}

// ---------------------------------------------------------------------------
// Friendly setup UI (ask -> progress window -> notification)
// ---------------------------------------------------------------------------

let askWindowOpen = false;
let wineDownloadInProgress = false;

/**
 * Custom always-on-top ask window (native dialogs can get covered by the
 * Zalo main window on Linux DEs). Resolves with the user's choice.
 */
function showAskWindow(failedWine) {
  const { ipcMain } = require('electron');
  const win = new BrowserWindowModule({
    width: 540,
    height: 260,
    useContentSize: true,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#232526',
    // Tiny internal window with static HTML — node integration is safe here.
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });
  const downloadUrl = process.env.ZCALL_WINE_DOWNLOAD_URL || WINE_DOWNLOAD_URL;
  const headLine = failedWine
    ? 'Wine trên máy bạn không tương thích với tính năng gọi (không chạy được ứng dụng 32-bit). Tải bản Wine tương thích?'
    : 'Tính năng gọi điện cần Wine. Tải và bật ngay bây giờ?';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    ${DIALOG_CSS}
    ${DOWNLOAD_CSS}
    .check{display:flex;align-items:center;gap:8px;margin:0 0 4px;color:var(--muted);cursor:pointer}
    .check input{margin:0;accent-color:var(--accent)}
    footer{justify-content:space-between}
  </style></head><body>
    <header><h1>Tính năng gọi điện</h1></header>
    <main>
      <p class="lead">${headLine}<br>
        Sẽ tải Wine WoW64 về lưu trong dữ liệu của Zalo — không cần quyền quản trị,
        không ảnh hưởng hệ thống.</p>
      <div id="url" title="Mở nguồn tải trong trình duyệt">Nguồn tải: ${downloadUrl}</div>
      <label class="check"><input type="checkbox" id="never"> Không hỏi lại lần sau nếu không tải</label>
    </main>
    <footer>
      <button class="btn" id="browse">Chọn file wine có sẵn…</button>
      <span class="actions">
        <button class="btn" id="no">Để sau</button>
        <button class="btn primary" id="yes">Tải và bật ngay</button>
      </span>
    </footer>
    <script>
      const {ipcRenderer, shell} = require('electron');
      function answer(download) {
        ipcRenderer.send('zcall-ask-result', {
          download,
          neverAgain: document.getElementById('never').checked
        });
      }
      document.getElementById('yes').onclick = () => answer(true);
      document.getElementById('no').onclick = () => answer(false);
      document.getElementById('browse').onclick = () => ipcRenderer.send('zcall-ask-browse');
      document.getElementById('url').onclick = () => shell.openExternal('${downloadUrl}');
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      ipcMain.removeListener('zcall-ask-result', onResult);
      ipcMain.removeListener('zcall-ask-browse', onBrowse);
      resolve(result || { download: false, neverAgain: false });
      // destroy AFTER resolve: destroy() emits 'closed' synchronously,
      // which would otherwise let the fallback resolve a wrong value first
      try { win.destroy(); } catch (e) { /* already closed */ }
    };
    const onResult = (_e, result) => finish(result);
    const onBrowse = async () => {
      const picked = await dialogModule.showOpenDialog(win, {
        title: 'Chọn file wine',
        properties: ['openFile']
      });
      const chosen = picked.filePaths && picked.filePaths[0];
      if (!chosen) return;
      if (validateWine(chosen, process.env.ZCALL_WINEPREFIX || path.join(os.homedir(), '.config', 'ZaloData', 'zcall-wine'))) {
        finish({ download: false, neverAgain: false, pickedWine: chosen });
      } else {
        dialogModule.showMessageBox(win, {
          type: 'error',
          title: 'Zalo — Tính năng gọi điện',
          message: 'Wine này không dùng được',
          detail: 'File đã chọn không chạy được chế độ WoW64 hoặc không phải wine hợp lệ:\n' + chosen,
          buttons: ['Tải Wine', 'Đóng'], defaultId: 0, cancelId: 1
        }).then(({ response }) => {
          if (response === 0) finish({ download: true, neverAgain: false });
        });
      }
    };
    ipcMain.on('zcall-ask-result', onResult);
    ipcMain.on('zcall-ask-browse', onBrowse);
    // fallback: user closed the window somehow
    win.on('closed', () => finish({ download: false, neverAgain: false }));
  });
}

function showProgressWindow() {
  const win = new BrowserWindowModule({
    width: 520,
    height: 170,
    useContentSize: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    backgroundColor: '#232526',
    // Tiny internal window with static HTML — node integration is safe here.
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });
  const downloadUrl = process.env.ZCALL_WINE_DOWNLOAD_URL || WINE_DOWNLOAD_URL;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    ${DIALOG_CSS}
    ${DOWNLOAD_CSS}
    body{-webkit-app-region:drag}
    .track{height:6px;border-radius:99px;background:var(--hover);overflow:hidden}
    #bar{width:0;height:100%;border-radius:99px;background:var(--accent);transition:width .3s}
    #label{margin-top:8px;font-size:12.5px;color:var(--muted)}
    #url{margin:6px 0 0}
  </style></head><body>
    <header><h1>Tính năng gọi điện</h1></header>
    <main>
      <p class="lead">Đang tải Wine WoW64, vui lòng chờ…</p>
      <div class="track"><div id="bar"></div></div>
      <div id="label">0%</div>
      <div id="url" title="Mở nguồn tải trong trình duyệt">${downloadUrl}</div>
    </main>
    <script>
      const {ipcRenderer, shell} = require('electron');
      ipcRenderer.on('progress', (e, pct, text) => {
        document.getElementById('bar').style.width = pct + '%';
        document.getElementById('label').textContent = text;
      });
      document.getElementById('url').onclick = () => {
        shell.openExternal('${downloadUrl}');
      };
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return {
    set(pct, text) {
      try { win.webContents.send('progress', pct, text); } catch (e) { /* window closed */ }
    },
    close() {
      try { win.destroy(); } catch (e) { /* already closed */ }
    }
  };
}

async function promptAndInstall(userDataDir, failedWine, directDownload = false) {
  getElectronModules();
  if (!BrowserWindowModule) return null;
  if (askWindowOpen || wineDownloadInProgress) return null; // never show two ask/download windows
  askWindowOpen = true;

  let result;
  try {
    result = directDownload ? { download: true } : await showAskWindow(failedWine);
  } finally {
    askWindowOpen = false;
  }

  if (!result.download) {
    // User picked an existing wine file: save it and use it.
    if (result.pickedWine) {
      const prefix = process.env.ZCALL_WINEPREFIX || path.join(userDataDir, 'zcall-wine');
      writeConfig(userDataDir, { wineSetup: 'ready', winePath: result.pickedWine });
      process.env.ZCALL_WINE = result.pickedWine;
      process.env.ZCALL_WINEPREFIX = prefix;
      if (!process.env.WINEDEBUG) process.env.WINEDEBUG = '-all';
      console.log('[zcall-bridge] custom wine selected:', result.pickedWine);
      return result.pickedWine;
    }
    // "Để sau": ask again on next launch; ticked "không hỏi lại" -> never.
    writeConfig(userDataDir, { wineSetup: result.neverAgain ? 'declined-permanent' : 'declined' });
    return null;
  }

  const progress = showProgressWindow();
  wineDownloadInProgress = true;
  try {
    debugLog('install: starting download of portable wine');
    let lastUpdate = 0;
    const wine = await installDownloadedWine(userDataDir, (got, total) => {
      const now = Date.now();
      if (now - lastUpdate < 500) return; // throttle IPC updates
      lastUpdate = now;
      const pct = Math.round((got / total) * 100);
      progress.set(pct, `Đang tải… ${Math.round(got / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB (${pct}%)`);
    });
    debugLog('install: downloaded, extracting...');
    progress.set(100, 'Đang giải nén và chuẩn bị…');

    // First prefix init (~10-30s, done once)
    const prefix = process.env.ZCALL_WINEPREFIX || path.join(userDataDir, 'zcall-wine');
    spawnSync(wine, ['wineboot', '-u'], {
      env: Object.assign({}, process.env, { WINEPREFIX: prefix, WINEDEBUG: '-all' }),
      stdio: 'ignore',
      timeout: 180000
    });

    // Verify the freshly downloaded wine actually works on this machine —
    // This verifies the PE32 helper under the selected WoW64 runtime.
    if (!validateWine(wine, prefix)) {
      const hint = getWineInstallHint();
      throw new Error(
        'Wine WoW64 không khởi động được trên máy này.\n\n' +
        hint.title + '\n' + hint.command
      );
    }

    progress.close();
    debugLog('install: SUCCESS wine=' + wine + ' prefix=' + prefix);

    process.env.ZCALL_WINE = wine;
    process.env.ZCALL_WINEPREFIX = prefix;
    if (!process.env.WINEDEBUG) process.env.WINEDEBUG = '-all';
    writeConfig(userDataDir, { wineSetup: 'ready' });

    if (NotificationModule && NotificationModule.isSupported()) {
      new NotificationModule({
        title: 'Zalo',
        body: 'Tính năng gọi điện đã sẵn sàng! Hãy thử gọi một cuộc.'
      }).show();
    }
    return wine;
  } catch (e) {
    debugLog('install FAILED: ' + String((e && e.message) || e) + '\n' + String((e && e.stack) || '').split('\n').slice(0, 3).join('\n'));
    progress.close();
    const parent = BrowserWindowModule.getFocusedWindow() || BrowserWindowModule.getAllWindows()[0];
    if (dialogModule) {
      await dialogModule.showMessageBox(parent, {
        type: 'error',
        title: 'Zalo — Tính năng gọi điện',
        message: 'Không thể tải Wine',
        detail: String((e && e.message) || e) + '\n\nBạn có thể thử lại từ menu khay hệ thống, hoặc cài Wine bằng lệnh: sudo apt install wine'
      });
    }
    return null;
  } finally {
    wineDownloadInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function wineCandidates(userDataDir) {
  // Candidate wines, best first: explicit env -> user-picked custom wine ->
  // our portable runtime (version we control and test) -> system wine ->
  // Bottles runners.
  const downloadedWine = findDownloadedWine(userDataDir);
  const systemWine = findWine();
  const candidates = [];
  if (process.env.ZCALL_WINE) {
    // resolve relative paths — AppImage runs may change the working directory
    candidates.push(path.resolve(process.env.ZCALL_WINE));
  }
  const cfgSaved = readConfig(userDataDir);
  if (cfgSaved.winePath && fs.existsSync(cfgSaved.winePath) && candidates.indexOf(cfgSaved.winePath) === -1) {
    candidates.push(cfgSaved.winePath);
  }
  // Bundled runtime first among the auto-discovered ones: it is paired with
  // the exact app release (Full variant) and needs no download.
  const bundledWine = findBundledWine();
  if (bundledWine) candidates.push(bundledWine);
  if (downloadedWine && candidates.indexOf(downloadedWine) === -1) candidates.push(downloadedWine);
  if (systemWine && candidates.indexOf(systemWine) === -1) candidates.push(systemWine);
  return { candidates, downloadedWine };
}

// Blocking discovery, used at launch in "auto" mode.
function findUsableWineSync(userDataDir, prefix) {
  const { candidates, downloadedWine } = wineCandidates(userDataDir);
  let failedWine = null;
  for (const candidate of candidates) {
    // Ensure the prefix exists before validating (validation needs a booted prefix)
    if (!fs.existsSync(path.join(prefix, 'drive_c'))) {
      console.log('[zcall-bridge] initializing wine prefix:', prefix);
      try {
        spawnSync(candidate, ['wineboot', '-u'], {
          env: Object.assign({}, process.env, { WINEPREFIX: prefix, WINEDEBUG: '-all' }),
          stdio: 'ignore',
          timeout: 180000
        });
      } catch (e) {
        console.error('[zcall-bridge] wineboot failed:', e.message);
      }
    }

    // A wine is only usable if it can run 32-bit executables.
    if (isWineCheckCached(userDataDir, candidate, prefix)) {
      recheckWineLater(userDataDir, candidate, prefix);
      return { wine: candidate, downloadedWine, failedWine };
    }
    if (validateWine(candidate, prefix)) {
      writeWineCheck(userDataDir, candidate, prefix);
      return { wine: candidate, downloadedWine, failedWine };
    }
    console.error('[zcall-bridge] wine cannot run 32-bit apps, skipping:', candidate);
    failedWine = candidate;
  }
  return { wine: null, downloadedWine, failedWine };
}

// Same discovery without blocking the main process, used in "lazy" mode.
// onSlow fires once before the first wineboot or uncached validation.
async function findUsableWineAsync(userDataDir, prefix, onSlow) {
  const { candidates, downloadedWine } = wineCandidates(userDataDir);
  let failedWine = null;
  let slowNotified = false;
  const slow = () => {
    if (slowNotified) return;
    slowNotified = true;
    if (onSlow) onSlow();
  };
  for (const candidate of candidates) {
    if (!fs.existsSync(path.join(prefix, 'drive_c'))) {
      slow();
      console.log('[zcall-bridge] initializing wine prefix:', prefix);
      await runWineAsync(candidate, ['wineboot', '-u'], prefix, 180000);
    }
    if (isWineCheckCached(userDataDir, candidate, prefix)) {
      recheckWineLater(userDataDir, candidate, prefix);
      return { wine: candidate, downloadedWine, failedWine };
    }
    slow();
    if (await validateWineAsync(candidate, prefix)) {
      writeWineCheck(userDataDir, candidate, prefix);
      return { wine: candidate, downloadedWine, failedWine };
    }
    console.error('[zcall-bridge] wine cannot run 32-bit apps, skipping:', candidate);
    failedWine = candidate;
  }
  return { wine: null, downloadedWine, failedWine };
}

// No usable wine. At launch the user is only asked when they have not
// declined for good; on a call attempt they asked for it, so always ask.
function handleNoWine(userDataDir, { downloadedWine, failedWine }, onCall) {
  const cfg = readConfig(userDataDir);

  // Downloaded runtime exists but cannot start: re-downloading would loop
  // forever — guide the user
  // instead, once, without nagging every launch.
  if (downloadedWine && failedWine === downloadedWine) {
    console.error('[zcall-bridge] downloaded WoW64 runtime failed validation');
    if (onCall || (cfg.wineSetup !== 'broken' && process.env.ZCALL_AUTO_SETUP !== '1')) {
      writeConfig(userDataDir, { wineSetup: 'broken' });
      showBrokenWineDialog(downloadedWine, userDataDir);
    }
    return;
  }

  // No usable wine: ask the user (async — never block the ready handler).
  // Silent only when the user ticked "không hỏi lại" on a previous
  // decline, unless ZCALL_AUTO_SETUP=1 forces a silent download.
  if (!onCall && cfg.wineSetup === 'declined-permanent' && process.env.ZCALL_AUTO_SETUP !== '1') {
    console.error('[zcall-bridge] wine setup declined permanently — calls unavailable');
    return;
  }
  console.log('[zcall-bridge] no usable wine, prompting user to set up...');
  promptAndInstall(userDataDir, failedWine).then((w) => {
    if (w) console.log('[zcall-bridge] portable wine ready:', w);
  }).catch((e) => console.error('[zcall-bridge] setup failed:', e.message));
}

let wineActivated = false;
let cameraBridge = null;
let cameraReady = Promise.resolve();

// Exports the environment the patched main-dist spawn code reads and starts
// the screen-share watchers. Runs once per session.
function activateWine(wine, prefix) {
  process.env.ZCALL_WINE = wine;
  process.env.ZCALL_WINEPREFIX = prefix;
  if (!process.env.WINEDEBUG) process.env.WINEDEBUG = '-all';
  if (wineActivated) return;
  wineActivated = true;

  cameraBridge = startCameraBridge({ log: message => debugLog('camera: ' + message) });
  cameraReady = cameraBridge.ready.then(({ port, token, format }) => {
    process.env.ZCALL_CAMERA_PORT = String(port);
    process.env.ZCALL_CAMERA_TOKEN = token;
    if (format) {
      process.env.ZCALL_CAMERA_WIDTH = String(format.width);
      process.env.ZCALL_CAMERA_HEIGHT = String(format.height);
      process.env.ZCALL_CAMERA_FPS_NUM = String(format.num);
      process.env.ZCALL_CAMERA_FPS_DEN = String(format.den);
    } else {
      for (const name of ['ZCALL_CAMERA_WIDTH', 'ZCALL_CAMERA_HEIGHT', 'ZCALL_CAMERA_FPS_NUM', 'ZCALL_CAMERA_FPS_DEN'])
        delete process.env[name];
    }
    const hook = zcallBridgePath('camera-hook.dll');
    if (fs.existsSync(hook)) {
      const winePath = 'Z:' + hook.replace(/\//g, '\\');
      const result = spawnSync(wine, ['regsvr32', '/s', winePath], {
        env: { ...process.env, WINEPREFIX: prefix, WINEARCH: 'wow64' },
        encoding: 'utf8', timeout: 15000
      });
      if (result.status === 0) {
        process.env.ZCALL_CAMERA_HOOK_LOG = 'Z:' + path.join(os.homedir(), '.config', 'ZaloData', 'zcall-camera-hook.log').replace(/\//g, '\\');
        console.log('[zcall-bridge] WoW64 camera COM hook registered');
      } else {
        throw new Error('camera COM hook registration failed: ' + (result.error || result.stderr || result.status));
      }
    } else {
      throw new Error('camera-hook.dll missing; run setup-zcall-bridge.js');
    }
  });
  cameraReady.catch(error => {
    console.error('[zcall-bridge]', error.message);
    wineActivated = false;
    if (cameraBridge) cameraBridge.close();
    cameraBridge = null;
  });

  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 1000}`;
  if (!process.env.PULSE_SERVER) {
    process.env.PULSE_SERVER = `unix:${runtimeDir}/pulse/native`;
  }

  // Streamproxy: the capture shim is preloaded into the helper at ALL times.
  // It is inert while the bridge display is down (captures fall through to
  // the real display) and it signals a share request via a file, which the
  // watcher below turns into an automatic bridge start — no tray click
  // needed when the user hits "Share screen".
  const proxySo = zcallBridgePath('streamproxy.so');
  if (fs.existsSync(proxySo)) {
    process.env.ZCALL_PROXY_SO = proxySo;
    process.env.ZCALL_PROXY_LOG = path.join(os.homedir(), '.config', 'ZaloData', 'zcall-proxy.log');
    process.env.ZCALL_PROXY_REQUEST = path.join(os.homedir(), '.config', 'ZaloData', 'zcall-share.request');
    // Warm the resolution cache now so the first share-screen request does
    // not pay the synchronous xrandr call while the user waits.
    try {
      const out = execSync('xrandr --query 2>/dev/null | grep -m1 "\\*" | awk \'{print $1}\'', { encoding: 'utf8' });
      if (/^\d+x\d+$/.test(out.trim())) cachedBridgeRes = out.trim();
    } catch (e) { /* default */ }
    watchShareRequests();
    watchCallState();
  }

  console.log('[zcall-bridge] wine ready:', wine, '(prefix:', prefix + ')');
}

// Held until clicked or closed: a garbage-collected Notification never
// emits 'click'.
const liveNotifications = new Set();

function notify(body, onClick) {
  getElectronModules();
  if (NotificationModule && NotificationModule.isSupported()) {
    const n = new NotificationModule({ title: 'Zalo', body });
    if (onClick) {
      liveNotifications.add(n);
      n.on('click', () => { liveNotifications.delete(n); onClick(); });
      n.on('close', () => liveNotifications.delete(n));
    }
    n.show();
  }
}

// The patched main-dist (patch-zcall-callv2.js) awaits global.__zcallPrepare()
// right before it spawns the call engine; a rejection aborts that start and
// Zalo retries on the next call.
let preparing = null;

function prepareOnCall(userDataDir, prefix) {
  if (wineActivated) return cameraReady.then(() => process.env.ZCALL_WINE);
  if (!preparing) {
    preparing = findUsableWineAsync(userDataDir, prefix, () => {
      notify('Đang chuẩn bị tính năng gọi điện lần đầu, vui lòng chờ trong giây lát…');
    }).then((found) => {
      preparing = null;
      if (found.wine) {
        activateWine(found.wine, prefix);
        return cameraReady.then(() => found.wine);
      }
      handleNoWine(userDataDir, found, true);
      throw new Error('no usable wine');
    }, (e) => {
      preparing = null;
      throw e;
    });
  }
  return preparing;
}

function winePrefix(userDataDir) {
  return process.env.ZCALL_WINEPREFIX || path.join(userDataDir, 'zcall-wine');
}

// Sets the hooks the patched main-dist reads for this mode. `live` is a
// change while the app runs: a wine that was never prepared (the app was
// started with calls off) is then prepared on the next call.
function installGate(mode, userDataDir, live) {
  // Zalo starts the call engine at launch when the server asks for it
  // (call.launch_native_in_startup); the patched main-dist skips that start
  // while this is set, so only a real call reaches __zcallPrepare.
  global.__zcallDeferStartup = mode !== 'auto';

  if (mode === 'off') {
    global.__zcallPrepare = () => {
      // Clickable: without a tray host (stock GNOME) the tray menu entry
      // is unreachable, so this is a way back to the settings.
      notify('Tính năng gọi điện đang tắt. Bấm vào đây để mở Cài đặt gọi điện.',
        () => openSetupDialog({ userDataDir }));
      return Promise.reject(new Error('calls disabled'));
    };
  } else if (mode === 'lazy' || (live && !wineActivated)) {
    const prefix = winePrefix(userDataDir);
    global.__zcallPrepare = () => prepareOnCall(userDataDir, prefix);
  } else {
    global.__zcallPrepare = () => cameraReady;
  }
}

/**
 * Saves and applies a call mode while the app runs (ZaDark switch, settings
 * window). Turning calls off also stops a running call engine, which ends a
 * call in progress. Preparing wine at launch ("auto") starts with the next
 * launch.
 */
function setCallMode(userDataDir, mode) {
  if (!CALL_MODES.includes(mode)) return;
  const cfg = readConfig(userDataDir);
  cfg.callMode = mode;
  if (mode !== 'off') cfg.callModeOn = mode;
  writeConfig(userDataDir, cfg);

  const effective = getCallMode(userDataDir);
  installGate(effective, userDataDir, true);
  console.log('[zcall-bridge] call mode set to', effective);
  // Let the switch animation finish: killWineSession blocks for ~2 s.
  if (effective === 'off' && process.env.ZCALL_WINEPREFIX) setTimeout(shutdown, 300);
  pushSwitchState(userDataDir);
}

function launch({ userDataDir }) {
  process.env.WINEARCH = 'wow64';
  const firstRun = needsFirstRunChoice(userDataDir);
  const mode = firstRun ? 'lazy' : getCallMode(userDataDir);
  installGate(mode, userDataDir, false);
  if (firstRun) setTimeout(() => showFirstRunWindow(userDataDir), FIRST_RUN_DELAY_MS);

  if (mode === 'off') {
    console.log('[zcall-bridge] call mode off — wine not started');
    return false;
  }

  const prefix = winePrefix(userDataDir);
  process.env.WINEPREFIX = prefix;

  // Clean stale wine processes from unclean previous exits
  sweepStaleProcesses(prefix);

  if (mode === 'lazy') {
    console.log('[zcall-bridge] call mode lazy — wine is prepared on the first call');
    return false;
  }

  const found = findUsableWineSync(userDataDir, prefix);
  if (!found.wine) {
    handleNoWine(userDataDir, found, false);
    return false;
  }
  activateWine(found.wine, prefix);
  return true;
}

// ---------------------------------------------------------------------------
// ZaDark popup switch (inject-switch.js)
// ---------------------------------------------------------------------------

const SWITCH_TRIGGER = 'ZCALL_SWITCH_TRIGGER:';
const switchContents = new Set();

function switchState(userDataDir) {
  const mode = getCallMode(userDataDir);
  let note;
  if (process.env.ZCALL_DISABLE) note = 'Đang bị tắt bởi biến môi trường ZCALL_DISABLE.';
  else if (mode === 'off') note = 'Đã tắt: Zalo không chạy Wine, không gọi và nhận cuộc gọi được.';
  else if (mode === 'lazy') note = 'Wine chỉ chạy khi có cuộc gọi.';
  else note = 'Wine được chuẩn bị sẵn khi mở Zalo.';
  return { enabled: mode !== 'off', note };
}

function pushSwitchState(userDataDir) {
  const js = 'window.__zcallSwitchUpdate&&window.__zcallSwitchUpdate(' +
    JSON.stringify(switchState(userDataDir)) + ')';
  for (const contents of switchContents) {
    if (contents.isDestroyed()) {
      switchContents.delete(contents);
      continue;
    }
    contents.executeJavaScript(js, true).catch(() => {});
  }
}

/**
 * Adds the call switch to the ZaDark popup of every Zalo window. Only the
 * ZaDark variants have that popup; elsewhere the script finds nothing and
 * stays idle.
 */
function injectSwitch({ app, userDataDir }) {
  const script = fs.readFileSync(path.join(__dirname, 'inject-switch.js'), 'utf8');
  app.on('browser-window-created', (_e, win) => {
    win.on('page-title-updated', (event, title) => {
      if (!title.startsWith(SWITCH_TRIGGER)) return;
      event.preventDefault();
      const command = title.slice(SWITCH_TRIGGER.length);
      if (command === 'settings') openSetupDialog({ userDataDir });
      else if (command === 'on') setCallMode(userDataDir, readConfig(userDataDir).callModeOn || 'auto');
      else if (command === 'off') setCallMode(userDataDir, 'off');
    });
    win.webContents.on('dom-ready', () => {
      if (!win.webContents.getURL().includes('/pc-dist/index.html')) return;
      switchContents.add(win.webContents);
      const state = 'window.__zcallSwitchState=' + JSON.stringify(switchState(userDataDir)) + ';';
      win.webContents.executeJavaScript(state + script, true).catch(() => {});
    });
  });
}

/**
 * Watches the share-request file touched by the streamproxy shim when
 * ZaloCall starts capturing while the bridge display is down. Starting the
 * bridge pops the compositor's permission dialog automatically.
 */
let lastAutoBridgeAt = 0;
function watchShareRequests() {
  setInterval(() => {
    const f = process.env.ZCALL_PROXY_REQUEST;
    if (!f || !fs.existsSync(f)) return;
    try { fs.unlinkSync(f); } catch (e) { /* gone */ }
    if (!isWaylandSession() || screenBridgeActive()) return;
    // Cooldown: if the user denied the portal, don't nag again right away
    // (the tray menu remains available for a manual retry).
    if (Date.now() - lastAutoBridgeAt < 90000) return;
    lastAutoBridgeAt = Date.now();
    debugLog('screenbridge: share request detected — starting bridge');
    startScreenBridge();
  }, 200);
}

// ZaloCall -> renderer signal sent when screen sharing is turned on
// (status 1) or off (status 0) during a call.
const SIGNAL_SCREEN_SHARE = 12064;

/**
 * Stops the screen bridge when sharing stops or the call ends (#91).
 * ZaloCall reports both to the renderer through the main process: sharing
 * as call-send-signal 12064 {status}, the call as call-update/callState
 * (Zalo treats every state except "free" as a running call). Without this,
 * Xvfb, the portal stream and the gst pipeline stayed up until the app quit.
 */
function watchCallState() {
  let electron;
  try { electron = require('electron'); } catch (e) { return; }
  const stop = (why) => {
    if (!screenBridgeActive()) return;
    debugLog('screenbridge: ' + why + ' — stopping bridge');
    stopScreenBridge();
    // The next share must not wait out the denial cooldown.
    lastAutoBridgeAt = 0;
  };
  const hook = (contents) => {
    if (!contents || contents.__zcallStateHooked) return;
    contents.__zcallStateHooked = true;
    const send = contents.send;
    contents.send = function (channel, command, data, ...rest) {
      if (channel === 'call-update' && command === 'callState' &&
          data && data.state === 'free') {
        stop('call ended');
      } else if (channel === 'call-send-signal' && Number(command) === SIGNAL_SCREEN_SHARE &&
          data && Number(data.status) === 0) {
        stop('sharing stopped');
      }
      return send.call(this, channel, command, data, ...rest);
    };
  };
  electron.webContents.getAllWebContents().forEach(hook);
  electron.app.on('web-contents-created', (_e, contents) => hook(contents));
}

/**
 * Guidance when the portable WoW64 runtime cannot start. The classic
 * runtime's distro-specific 32-bit library instructions no longer apply.
 */
function getWineInstallHint() {
  return {
    title: 'Cần Wine hỗ trợ WoW64.',
    command: 'Mở Cài đặt gọi điện để tải lại Wine WoW64 hoặc chọn bản Wine hệ thống.'
  };
}

function showBrokenWineDialog(winePath, userDataDir) {
  getElectronModules();
  if (!dialogModule) return Promise.resolve(null);
  const hint = getWineInstallHint();
  const parent = BrowserWindowModule.getFocusedWindow() || BrowserWindowModule.getAllWindows()[0];
  return dialogModule.showMessageBox(parent, {
    type: 'warning',
    title: 'Zalo — Tính năng gọi điện',
    message: 'Wine này không hỗ trợ WoW64 hoặc không khởi động được',
    detail: hint.title + '\n\nBấm Tải Wine để tải bản Wine tương thích trong cửa sổ tiến trình.\n\n' +
      'Wine: ' + winePath,
    buttons: ['Tải Wine', 'Đóng'], defaultId: 0, cancelId: 1
  }).then(({ response }) => {
    if (response === 0) return promptAndInstall(userDataDir, winePath, true);
    return null;
  }).catch(error => console.error('[zcall-bridge] wine download failed:', error.message));
}

// Shared look of the call windows (settings, first run, download ask and
// progress): ZaDark's palette, font and blue accent, light and dark themes.
const DIALOG_CSS = `
    :root{color-scheme:dark;--bg:#232526;--card:#2d3031;--hover:#343637;--border:#464849;--text:#e5e5e5;--muted:#9e9f9f;
      --accent:#0e70ff;--accent-hover:#035bdc;--accent-text:#3989ff;--accent-bg:#0f2345;--input:#2d3031;--danger:#ff6b6b}
    @media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#fff;--card:#fbfbfd;--hover:#eeeff2;--border:#e1e4ea;--text:#001a33;
      --muted:#72808e;--accent-text:#0068ff;--accent-bg:#e5efff;--input:#f4f5f7;--danger:#d93025}}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 "Open Sans",system-ui,Cantarell,"Noto Sans",Ubuntu,sans-serif;user-select:none}
    header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px 20px;-webkit-app-region:drag}
    h1{margin:0;font-size:16px;font-weight:600}
    h2{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
    main{padding:0 20px}
    section{margin-bottom:16px}
    button,input,label{-webkit-app-region:no-drag;font:inherit}
    .icon{width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--muted);font-size:16px;cursor:pointer}
    .icon:hover{background:var(--hover);color:var(--text)}
    .modes{display:flex;flex-direction:column;gap:6px}
    .mode{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--card);cursor:pointer}
    .mode:hover{background:var(--hover)}
    .mode input{margin:3px 0 0;accent-color:var(--accent);width:16px;height:16px;flex:none}
    .mode b{display:block;font-weight:600}
    .mode small{display:block;color:var(--muted);font-size:12.5px;margin-top:1px}
    .mode:has(input:checked){border-color:var(--accent);background:var(--accent-bg)}
    .note{min-height:18px;margin:6px 2px 0;font-size:12.5px;color:var(--accent-text)}
    .status{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--card);margin-bottom:8px}
    .badge{flex:none;font-size:12px;font-weight:600;padding:1px 8px;border-radius:99px;color:var(--accent-text);border:1px solid var(--accent-text)}
    .badge.missing{color:var(--muted);border-color:var(--border)}
    .status .info{flex:1;min-width:0}
    .btn.small{flex:none;padding:5px 10px;font-size:13px}
    .result{margin:-2px 2px 8px;font-size:12.5px;white-space:pre-wrap;user-select:text}
    .result:empty{display:none}
    .result.ok{color:var(--accent-text)}
    .result.fail{color:var(--danger)}
    code{display:block;font:13px/1.4 ui-monospace,"DejaVu Sans Mono",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text}
    .status small{display:block;color:var(--muted);font-size:12px}
    .pathrow{display:flex;gap:8px;margin-bottom:8px}
    .pathrow input{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--input);color:var(--text);user-select:text}
    .pathrow input:focus{outline:none;border-color:var(--accent)}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .btn{padding:8px 12px;border:0;border-radius:8px;background:var(--hover);color:var(--text);cursor:pointer;white-space:nowrap;transition:background .25s}
    .btn:hover{background:var(--border)}
    .btn.primary{background:var(--accent);color:#fff}
    .btn.primary:hover{background:var(--accent-hover)}
    .btn.danger:hover{color:var(--danger)}
    #wineSec.dim{opacity:.55}
    footer{display:flex;justify-content:flex-end;padding:4px 20px 18px}
`;

// Extra rules shared by the download ask and progress windows.
const DOWNLOAD_CSS = `
    .lead{margin:0 0 10px;color:var(--muted)}
    #url{font-size:12px;color:var(--accent-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;margin-bottom:12px;-webkit-app-region:no-drag}
    #url:hover{text-decoration:underline}
    .actions{display:flex;gap:8px}
`;

let setupWin = null;

// Delay so the question comes up over Zalo's window, not before it.
const FIRST_RUN_DELAY_MS = 3000;

// Asked once, when no call mode was ever chosen. Scripted installs
// (ZCALL_AUTO_SETUP=1) and ZCALL_DISABLE skip it.
function needsFirstRunChoice(userDataDir) {
  if (process.env.ZCALL_DISABLE || process.env.ZCALL_AUTO_SETUP === '1') return false;
  return !CALL_MODES.includes(readConfig(userDataDir).callMode);
}

/**
 * First-run question (#80): calls or messages only. Until it is answered
 * the session runs as "lazy", so no wine starts behind the user's back.
 * Closing the window keeps the default ("auto").
 */
function showFirstRunWindow(userDataDir) {
  getElectronModules();
  if (!BrowserWindowModule) return;
  const { ipcMain } = require('electron');
  const win = new BrowserWindowModule({
    width: 500,
    height: 470,
    useContentSize: true,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: '#232526',
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    ${DIALOG_CSS}
    .lead{margin:0 0 14px;color:var(--muted)}
  </style></head><body>
    <header><h1>Bạn có dùng Zalo để gọi điện không?</h1></header>
    <main>
      <p class="lead">Gọi điện trên Linux cần chạy thêm Wine, tốn thêm bộ nhớ và CPU.
        Có thể đổi lại bất cứ lúc nào trong Cài đặt → Cài đặt gọi điện.</p>
      <div class="modes">
        <label class="mode"><input type="radio" name="mode" value="auto" checked>
          <span><b>Có, tôi hay gọi điện</b><small>Chuẩn bị Wine sẵn khi mở Zalo, gọi nhanh nhất.</small></span></label>
        <label class="mode"><input type="radio" name="mode" value="lazy">
          <span><b>Thỉnh thoảng</b><small>Chỉ chạy Wine khi có cuộc gọi. Cuộc gọi đầu chậm hơn vài giây.</small></span></label>
        <label class="mode"><input type="radio" name="mode" value="off">
          <span><b>Không, tôi chỉ nhắn tin</b><small>Không chạy Wine. Không gọi và nhận cuộc gọi được.</small></span></label>
      </div>
    </main>
    <footer><button class="btn primary" id="save">Lưu</button></footer>
    <script>
      const {ipcRenderer} = require('electron');
      document.getElementById('save').onclick = () => {
        ipcRenderer.send('zcall-firstrun', document.querySelector('input[name=mode]:checked').value);
      };
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  let answered = false;
  const onAnswer = (_e, mode) => {
    answered = true;
    setCallMode(userDataDir, mode);
    try { win.destroy(); } catch (e) { /* closed */ }
  };
  ipcMain.once('zcall-firstrun', onAnswer);
  win.on('closed', () => {
    ipcMain.removeListener('zcall-firstrun', onAnswer);
    if (!answered) setCallMode(userDataDir, 'auto');
  });
}

function openSetupDialog({ userDataDir }) {
  getElectronModules();
  if (!BrowserWindowModule) return;
  // One settings window: the tray, the ZaDark switch and the "calls off"
  // notification all open it.
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    return;
  }
  const { ipcMain } = require('electron');
  const prefix = process.env.ZCALL_WINEPREFIX || path.join(userDataDir, 'zcall-wine');

  const win = new BrowserWindowModule({
    width: 540,
    height: 640,
    useContentSize: true,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: '#232526',
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });
  setupWin = win;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    ${DIALOG_CSS}
  </style></head><body>
    <header>
      <h1>Cài đặt gọi điện</h1>
      <button class="icon" id="x" title="Đóng (Esc)">✕</button>
    </header>
    <main>
      <section>
        <h2>Chế độ gọi điện</h2>
        <div class="modes">
          <label class="mode"><input type="radio" name="mode" value="auto">
            <span><b>Chuẩn bị sẵn khi mở Zalo</b><small>Gọi nhanh nhất. Wine chạy mỗi lần mở Zalo.</small></span></label>
          <label class="mode"><input type="radio" name="mode" value="lazy">
            <span><b>Chỉ chuẩn bị khi bấm gọi</b><small>Mở Zalo nhẹ hơn. Cuộc gọi đầu tiên chậm hơn vài giây.</small></span></label>
          <label class="mode"><input type="radio" name="mode" value="off">
            <span><b>Tắt tính năng gọi điện</b><small>Không chạy Wine. Dành cho người chỉ nhắn tin.</small></span></label>
        </div>
        <p class="note" id="modeNote"></p>
      </section>
      <section id="wineSec">
        <h2>Wine</h2>
        <div class="status">
          <span class="badge" id="badge">…</span>
          <div class="info"><code id="winePath">Đang kiểm tra…</code><small id="saved"></small></div>
          <button class="btn small" id="test">Kiểm tra</button>
        </div>
        <p class="result" id="testResult"></p>
        <div class="pathrow">
          <input id="pathInput" placeholder="Đường dẫn wine, ví dụ /usr/bin/wine">
          <button class="btn primary" id="setpath">Dùng</button>
        </div>
        <div class="grid">
          <button class="btn" id="browse">Chọn file wine…</button>
          <button class="btn" id="download">Tải Wine WoW64</button>
          <button class="btn" id="clear">Bỏ lựa chọn đã lưu</button>
          <button class="btn danger" id="remove">Xóa wine đã tải</button>
        </div>
      </section>
    </main>
    <footer><button class="btn primary" id="close">Xong</button></footer>
    <script>
      const {ipcRenderer} = require('electron');
      const $ = (id) => document.getElementById(id);
      // pass the command as the first IPC argument so the shared main
      // handler can match it; the value (typed path, mode) comes second
      const send = (cmd, arg) => ipcRenderer.send(cmd, cmd, arg);
      const closeWin = () => { send('zcall-cfg-close'); setTimeout(() => window.close(), 80); };
      $('browse').onclick = () => send('zcall-cfg-browse');
      $('download').onclick = () => send('zcall-cfg-download');
      $('clear').onclick = () => send('zcall-cfg-clear');
      $('remove').onclick = () => send('zcall-cfg-remove');
      $('test').onclick = () => {
        $('test').disabled = true;
        $('testResult').className = 'result';
        $('testResult').textContent = 'Đang chạy thử wine…';
        send('zcall-cfg-test');
      };
      ipcRenderer.on('zcall-cfg-test', (e, ok, text) => {
        $('test').disabled = false;
        $('testResult').className = 'result ' + (ok ? 'ok' : 'fail');
        $('testResult').textContent = text;
      });
      $('setpath').onclick = () => send('zcall-cfg-setpath', $('pathInput').value.trim());
      $('pathInput').onkeydown = (e) => { if (e.key === 'Enter') $('setpath').click(); };
      $('close').onclick = closeWin;
      $('x').onclick = closeWin;
      for (const r of document.querySelectorAll('input[name=mode]')) {
        r.onchange = () => send('zcall-cfg-mode', r.value);
      }
      ipcRenderer.on('zcall-cfg-mode', (e, mode, note) => {
        const r = document.querySelector('input[name=mode][value="' + mode + '"]');
        if (r) r.checked = true;
        $('modeNote').textContent = note || '';
        $('wineSec').classList.toggle('dim', mode === 'off');
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWin(); });
      ipcRenderer.on('zcall-cfg-status', (e, st) => {
        $('badge').textContent = st.wine ? 'Sẵn sàng' : 'Chưa có';
        $('badge').classList.toggle('missing', !st.wine);
        $('winePath').textContent = st.wine || 'Chưa có wine, chưa gọi điện được';
        $('winePath').title = st.wine || '';
        $('saved').textContent = st.saved ? 'Đã lưu lựa chọn: ' + st.saved : 'Tự dò wine';
      });
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  const currentWine = () => process.env.ZCALL_WINE || findWine() || findDownloadedWine(userDataDir);
  const pushStatus = () => {
    const status = { wine: currentWine() || '', saved: readConfig(userDataDir).winePath || '' };
    try { win.webContents.send('zcall-cfg-status', status); } catch (e) { /* closed */ }
  };
  pushStatus();

  // A change applies at once; only preparing wine at launch waits for the
  // next start.
  const launchMode = getCallMode(userDataDir);
  const pushMode = () => {
    const mode = getCallMode(userDataDir);
    let note = '';
    if (mode === 'auto' && launchMode !== 'auto') note = 'Đã bật. Wine được chuẩn bị sẵn từ lần mở Zalo sau.';
    else if (mode !== launchMode) note = 'Đã áp dụng.';
    if (process.env.ZCALL_DISABLE) note = 'Đang bị tắt bởi biến môi trường ZCALL_DISABLE.';
    try { win.webContents.send('zcall-cfg-mode', mode, note); } catch (e) { /* closed */ }
  };
  win.webContents.on('did-finish-load', () => { pushStatus(); pushMode(); });

  const onIpc = (_e, cmd, arg) => {
    if (cmd === 'zcall-cfg-close') { try { win.destroy(); } catch (e) {} return; }
    if (cmd === 'zcall-cfg-mode') {
      setCallMode(userDataDir, arg);
      pushMode();
      return;
    }
    if (cmd === 'zcall-cfg-test') {
      const reply = (ok, text) => {
        try { win.webContents.send('zcall-cfg-test', ok, text); } catch (e) { /* closed */ }
      };
      const wine = currentWine();
      if (!wine) {
        reply(false, 'Chưa có wine. Bấm "Tải wine về" hoặc chọn file wine có sẵn.');
        return;
      }
      validateWineAsync(wine, prefix).then((ok) => {
        if (ok) {
          writeWineCheck(userDataDir, wine, prefix);
          reply(true, '✓ Wine chạy được ứng dụng 32-bit, sẵn sàng gọi điện.');
        } else {
          const hint = getWineInstallHint();
          reply(false, '✗ Wine không chạy được ứng dụng 32-bit.\n' + hint.title + '\n' + hint.command.split('\n')[0] +
            (hint.command.includes('dpkg') ? '\n' + hint.command.split('\n')[1] : ''));
        }
      });
      return;
    }
    if (cmd === 'zcall-cfg-browse') {
      dialogModule.showOpenDialog(win, { title: 'Chọn file wine', properties: ['openFile'] }).then((picked) => {
        const chosen = picked.filePaths && picked.filePaths[0];
        if (!chosen) return;
        if (validateWine(chosen, prefix)) {
          writeConfig(userDataDir, { wineSetup: 'ready', winePath: chosen });
          process.env.ZCALL_WINE = chosen;
          process.env.ZCALL_WINEPREFIX = prefix;
          pushStatus();
          new NotificationModule({ title: 'Zalo', body: 'Đã chọn wine: ' + chosen }).show();
        } else {
          showBrokenWineDialog(chosen, userDataDir).then(pushStatus);
        }
      });
      return;
    }
    if (cmd === 'zcall-cfg-setpath') {
      const typed = String(arg || '').trim();
      if (!typed) {
        dialogModule.showMessageBox(win, {
          type: 'info', title: 'Zalo — Tính năng gọi điện',
          message: 'Chưa nhập đường dẫn',
          detail: 'Hãy nhập đường dẫn đầy đủ tới file wine, ví dụ /usr/bin/wine'
        });
        return;
      }
      if (!fs.existsSync(typed)) {
        dialogModule.showMessageBox(win, {
          type: 'error', title: 'Zalo — Tính năng gọi điện',
          message: 'Không tìm thấy file',
          detail: 'Đường dẫn không tồn tại:\n' + typed
        });
        return;
      }
      if (!validateWine(typed, prefix)) {
        showBrokenWineDialog(typed, userDataDir).then(pushStatus);
        return;
      }
      writeConfig(userDataDir, { wineSetup: 'ready', winePath: typed });
      process.env.ZCALL_WINE = typed;
      process.env.ZCALL_WINEPREFIX = prefix;
      pushStatus();
      dialogModule.showMessageBox(win, {
        type: 'info', title: 'Zalo — Tính năng gọi điện',
        message: 'Đã lưu đường dẫn wine',
        detail: typed + '\n\nLần mở app sau sẽ dùng wine này (có thể bỏ bằng nút "Bỏ lựa chọn wine đã lưu").'
      });
      return;
    }
    if (cmd === 'zcall-cfg-download') {
      win.destroy();
      promptAndInstall(userDataDir, null, true);
      return;
    }
    if (cmd === 'zcall-cfg-clear') {
      const cfg = readConfig(userDataDir);
      if (cfg.winePath) {
        delete cfg.winePath;
        writeConfig(userDataDir, cfg);
        pushStatus();
        dialogModule.showMessageBox(win, {
          type: 'info', title: 'Zalo — Tính năng gọi điện',
          message: 'Đã bỏ lựa chọn wine đã lưu',
          detail: 'Lần mở app sau sẽ tự dò wine lại (wine tải về → wine hệ thống).\nWine đang dùng phiên này: ' + (process.env.ZCALL_WINE || '(không có)')
        });
      } else {
        dialogModule.showMessageBox(win, {
          type: 'info', title: 'Zalo — Tính năng gọi điện',
          message: 'Không có lựa chọn wine nào đang lưu',
          detail: 'App đang dùng wine theo chế độ tự dò. Không có gì để bỏ.'
        });
      }
      return;
    }
    if (cmd === 'zcall-cfg-remove') {
      const runtime = path.join(userDataDir, RUNTIME_DIRNAME);
      if (!fs.existsSync(runtime)) {
        dialogModule.showMessageBox(win, {
          type: 'info', title: 'Zalo — Tính năng gọi điện',
          message: 'Không có wine đã tải về',
          detail: 'Chưa có thư mục wine tải về trên máy này.'
        });
        return;
      }
      dialogModule.showMessageBox(win, {
        type: 'warning', buttons: ['Xóa', 'Hủy'], defaultId: 1, cancelId: 1,
        title: 'Zalo — Tính năng gọi điện',
        message: 'Xóa wine đã tải về?',
        detail: 'Sẽ xóa thư mục ' + runtime + '\nBạn có thể tải lại bất cứ lúc nào.'
      }).then(({ response }) => {
        if (response === 0) {
          try { fs.rmSync(runtime, { recursive: true, force: true }); } catch (e) {}
          const cfg = readConfig(userDataDir);
          delete cfg.winePath;
          writeConfig(userDataDir, cfg);
          pushStatus();
          dialogModule.showMessageBox(win, {
            type: 'info', title: 'Zalo — Tính năng gọi điện',
            message: 'Đã xóa wine đã tải về',
            detail: 'Thư mục đã bị xóa. Lần mở app sau sẽ hỏi lại hoặc tự dò wine hệ thống.'
          });
        }
      });
      return;
    }
  };
  const CFG_CHANNELS = ['zcall-cfg-browse', 'zcall-cfg-download', 'zcall-cfg-clear',
                        'zcall-cfg-remove', 'zcall-cfg-close', 'zcall-cfg-setpath', 'zcall-cfg-mode', 'zcall-cfg-test'];
  for (const c of CFG_CHANNELS) ipcMain.on(c, onIpc);
  win.on('closed', () => {
    for (const c of CFG_CHANNELS) {
      ipcMain.removeListener(c, onIpc);
    }
  });
}

function killProcessesByPattern(pattern) {
  try {
    const out = execSync('pgrep -f ' + pattern, { encoding: 'utf8' });
    for (const pid of out.trim().split('\n')) {
      if (!pid || Number(pid) === process.pid) continue;
      try { process.kill(Number(pid), 'SIGKILL'); } catch (_) { /* gone */ }
    }
  } catch (_) { /* no matches */ }
}


function parentIsWineserver(ppid) {
  try {
    return fs.readFileSync('/proc/' + ppid + '/comm', 'utf8').trim() === 'wineserver';
  } catch (e) {
    return false;
  }
}

function killWineSession(prefix) {
  // 1. Kill the wine loader + helper processes spawned by the app. Their
  //    cmdlines contain the engine path (dev: .../app/native/qt-call-and-cap,
  //    packaged: /tmp/.mount_zalo*/app/native/qt-call-and-cap). pipebridge
  //    sleeps forever and never exits on its own.
  killProcessesByPattern('qt-call-and-cap');
  killProcessesByPattern('PipeZCall');

  // 2. Kill the wineserver serving our prefix.
  const wine = process.env.ZCALL_WINE;
  if (wine) {
    const wineserverPath = path.join(path.dirname(wine), 'wineserver');
    if (fs.existsSync(wineserverPath)) {
      try {
        spawnSync(wineserverPath, ['-k'], {
          env: Object.assign({}, process.env, { WINEPREFIX: prefix, WINEDEBUG: '-all' }),
          stdio: 'ignore',
          timeout: 10000
        });
      } catch (e) {
        console.error('[zcall-bridge] wineserver -k failed:', e.message);
      }
    }
  }

  // 3. Hard-kill lingering wineserver/winedevice of our prefix.
  try {
    for (const name of ['wineserver', 'winedevice.exe']) {
      let out = '';
      try { out = execSync('pgrep -x ' + name, { encoding: 'utf8' }); } catch (_) { continue; }
      for (const pid of out.trim().split('\n')) {
        if (!pid) continue;
        if (name === 'winedevice.exe') {
          // winedevice is legit only when its parent is a live wineserver;
          // orphans get reparented to systemd/init and must be killed.
          let ppid = '';
          try {
            const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
            ppid = (stat.split(') ')[1] || '').split(' ')[1] || '';
          } catch (_) { continue; }
          if (parentIsWineserver(ppid)) continue;
        } else {
          let env = '';
          try { env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8'); } catch (_) { continue; }
          if (!env.includes(prefix)) continue;
        }
        try { process.kill(Number(pid), 'SIGKILL'); } catch (_) { /* gone */ }
      }
    }
  } catch (_) { /* nothing left */ }

  // 4. Second pass: the wineserver death is async — winedevice processes
  //    whose parent just died are still orphan checkable after a short wait.
  try { execSync('sleep 2'); } catch (_) { /* ignore */ }
  try {
    let out = '';
    try { out = execSync('pgrep -x winedevice.exe', { encoding: 'utf8' }); } catch (_) { return; }
    for (const pid of out.trim().split('\n')) {
      if (!pid) continue;
      let ppid = '';
      try {
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        ppid = (stat.split(') ')[1] || '').split(' ')[1] || '';
      } catch (_) { continue; }
      if (!parentIsWineserver(ppid)) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch (_) { /* gone */ }
      }
    }
  } catch (_) { /* nothing left */ }
}

function shutdown() {
  if (cameraBridge) cameraBridge.close();
  cameraBridge = null;
  wineActivated = false;
  const prefix = process.env.ZCALL_WINEPREFIX;
  if (!prefix) return;
  killWineSession(prefix);
  stopScreenBridge();
}

// ---------------------------------------------------------------------------
// Wayland screen-share bridge
//
// On Wayland, wine's X11 screen capture cannot see the desktop (XWayland is
// isolated). This bridge renders the Wayland screen into a headless Xvfb
// display via the XDG ScreenCast portal. ZaloCall keeps running natively on
// the real display; the streamproxy.so shim (LD_PRELOAD, preloaded via
// ZCALL_PROXY_SO in the patched spawn env) redirects its screen-capture
// reads (XGetImage/XShmGetImage/xcb_get_image on the root) to the bridge
// display, so "share screen" captures the bridged content while the call UI
// stays a normal window. The shim also touches a request file when a
// capture starts while the bridge is down — watchShareRequests() turns that
// into an automatic bridge start, so the compositor's permission dialog
// pops by itself when the user hits "Share screen".
// ---------------------------------------------------------------------------

const BRIDGE_DISPLAY = ':99';
let bridgeProcs = [];
let bridgeGranted = false;
let cachedBridgeRes = null;

function isWaylandSession() {
  return process.env.XDG_SESSION_TYPE === 'wayland';
}

function screenBridgeActive() {
  return bridgeProcs.some((p) => p && p.exitCode === null && !p.killed);
}

function startScreenBridge() {
  getElectronModules();
  if (screenBridgeActive()) {
    if (dialogModule) {
      dialogModule.showMessageBox({
        type: 'info',
        title: 'Zalo — Chia sẻ màn hình',
        message: 'Bridge đang hoạt động',
        detail: 'Màn hình ảo ' + BRIDGE_DISPLAY + ' đã sẵn sàng. Cuộc gọi hoạt động hoàn toàn như bình thường — khi bấm Share screen, hình chia sẻ sẽ được lấy từ màn hình thật qua bridge.'
      });
    }
    return true;
  }

  const pyPath = zcallBridgePath('screenbridge.py');
  if (!fs.existsSync(pyPath)) {
    if (dialogModule) {
      dialogModule.showMessageBox({
        type: 'error', title: 'Zalo — Chia sẻ màn hình',
        message: 'Thiếu thành phần bridge',
        detail: 'Không tìm thấy screenbridge.py tại:\n' + pyPath
      });
    }
    return false;
  }

  // streamproxy.so (LD_PRELOAD shim) redirects ZaloCall's screen-capture
  // reads from the real display root to the bridge display, so the call UI
  // stays 100% native while "share screen" captures the bridged stream.
  // It is compiled by scripts/setup-zcall-bridge.js.
  const proxySoPath = zcallBridgePath('streamproxy.so');
  if (!fs.existsSync(proxySoPath)) {
    if (dialogModule) {
      dialogModule.showMessageBox({
        type: 'error', title: 'Zalo — Chia sẻ màn hình',
        message: 'Thiếu thành phần streamproxy',
        detail: 'Không tìm thấy ' + path.basename(proxySoPath) + ' tại:\n' + proxySoPath +
          '\n\nChạy "node scripts/setup-zcall-bridge.js" để build lại.'
      });
    }
    return false;
  }

  // Resolve the real screen resolution for the Xvfb screen. Cached from app
  // launch — the synchronous xrandr call would add ~200ms of latency right
  // when the user is waiting for the permission dialog.
  let res = cachedBridgeRes;
  if (!res) {
    res = '1920x1080';
    try {
      const out = execSync('xrandr --query 2>/dev/null | grep -m1 "\\*" | awk \'{print $1}\'', { encoding: 'utf8' });
      if (/^\d+x\d+$/.test(out.trim())) res = out.trim();
    } catch (e) { /* default */ }
    cachedBridgeRes = res;
  }
  const [w, h] = res.split('x');

  // Missing system deps fail silently otherwise (gst then reports
  // "Could not open display" and the shim cannot reach :99).
  const missingDeps = [];
  for (const dep of ['Xvfb', 'python3', 'xdotool', 'gst-launch-1.0']) {
    try {
      const r = execSync('which ' + dep, { encoding: 'utf8' });
      if (!r.trim()) missingDeps.push(dep);
    } catch (e) { missingDeps.push(dep); }
  }
  for (const plugin of ['pipewiresrc', 'ximagesink']) {
    try {
      execSync('gst-inspect-1.0 ' + plugin, { stdio: 'ignore' });
    } catch (e) { missingDeps.push('gst plugin ' + plugin); }
  }
  if (missingDeps.length) {
    if (dialogModule) {
      dialogModule.showMessageBox({
        type: 'error', title: 'Zalo — Chia sẻ màn hình',
        message: 'Thiếu thành phần hệ thống: ' + missingDeps.join(', '),
        detail: 'Cài để bật share screen:\n\n' +
          '  Fedora:  sudo dnf install xorg-x11-server-Xvfb xdotool python3-dbus gstreamer1-plugins-base gstreamer1-plugins-bad-free\n' +
          '  Ubuntu:  sudo apt install xvfb xdotool python3-dbus gstreamer1.0-plugins-base gstreamer1.0-plugins-bad\n' +
          '  Arch:    sudo pacman -S xorg-server-xvfb xdotool python-dbus gst-plugins-base gst-plugins-bad'
      });
    }
    debugLog('screenbridge: missing system deps: ' + missingDeps.join(', '));
    return false;
  }

  stopScreenBridge();
  bridgeGranted = false;
  try {
    // Headless Xvfb holds the bridged stream; ZaloCall keeps running on the
    // real display (native UI) and the streamproxy shim redirects its
    // screen-capture reads to this display.
    const xvfb = spawn('Xvfb', [BRIDGE_DISPLAY, '-screen', '0', w + 'x' + h + 'x24'], { stdio: ['ignore', 'ignore', 'pipe'] });
    xvfb.stderr.on('data', (d) => debugLog('screenbridge xvfb: ' + String(d).trim().slice(0, 200)));
    bridgeProcs.push(xvfb);
    const py = spawn('python3', [pyPath, BRIDGE_DISPLAY], { stdio: ['ignore', 'ignore', 'pipe'] });
    py.stderr.on('data', (d) => {
      const s = String(d).trim().slice(0, 300);
      debugLog('screenbridge: ' + s);
      // The user granted the portal and gst is rendering into :99 — from
      // now on the shim's proxied grabs return the stream. (The helper is
      // never restarted: the shim is preloaded from app launch, and its
      // fall-through handles the bridge-down state.)
      if (s.indexOf('got pipewire node') !== -1) {
        bridgeGranted = true;
        debugLog('screenbridge: granted — stream ready on ' + BRIDGE_DISPLAY);
      }
    });
    py.on('exit', (code) => {
      debugLog('screenbridge: python exited code=' + code + ' granted=' + bridgeGranted);
      // After a call-end stop this python is no longer ours; a bridge
      // started since then must not be torn down by its late exit event.
      if (bridgeProcs.includes(py)) stopScreenBridge();
    });
    bridgeProcs.push(py);
    // Let gst create its window, then stretch every window on the Xvfb
    // display over the whole screen (the gst window title is
    // "gst-launch-1.0", so match anything).
    setTimeout(() => {
      try {
        execSync(`xdotool search --display ${BRIDGE_DISPLAY} "" 2>/dev/null | while read wid; do xdotool windowsize $wid ${w} ${h} windowmove $wid 0 0; done`, { stdio: 'ignore' });
      } catch (e) { debugLog('screenbridge xdotool: ' + e.message); }
    }, 5000);
  } catch (e) {
    debugLog('screenbridge start failed: ' + e.message);
    return false;
  }

  debugLog('screenbridge started on ' + BRIDGE_DISPLAY + ' res=' + res);
  return true;
}

function stopScreenBridge() {
  for (const p of bridgeProcs) {
    try { if (p && !p.killed) p.kill(); } catch (e) { /* gone */ }
  }
  bridgeProcs = [];
}

module.exports = {
  launch,
  injectSwitch,
  openSetupDialog,
  shutdown,
  // internal (testability)
  _installDownloadedWine: installDownloadedWine,
};
