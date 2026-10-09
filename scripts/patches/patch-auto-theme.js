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

const THEME_MAIN_INJECTION = `
// --- Zalo Linux Auto Dark/Light Theme Sync ---
(function(){
  // Injected into the main-window factory: guard against re-runs when the
  // main window is recreated (duplicate handle() throws, duplicate monitors).
  if (process.platform !== "linux" || global.__zaloThemeSync) return;
  global.__zaloThemeSync = true;
  const { app: _app, ipcMain: _ipc, BrowserWindow: _bw, nativeTheme: _nt } = require("electron");

  function isLinuxDark() {
    try {
      const { execSync: _es } = require("child_process");
      // The portal reflects the host; sandbox GSettings can be defaults.
      try {
        const o = _es('dbus-send --session --print-reply=literal --dest=org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.Settings.Read string:"org.freedesktop.appearance" string:"color-scheme" 2>/dev/null', { timeout: 1000 }).toString();
        if (o.includes("uint32 1")) return true;
        if (o.includes("uint32 2")) return false;
      } catch (_) {}
      try {
        const o = _es("gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null", { timeout: 1000 }).toString();
        if (o.includes("prefer-dark")) return true;
        if (o.includes("prefer-light")) return false;
      } catch (_) {}
      try {
        const o = _es("gsettings get org.gnome.desktop.interface gtk-theme 2>/dev/null", { timeout: 1000 }).toString().toLowerCase();
        if (o.includes("dark")) return true;
      } catch (_) {}
    } catch (_) {}
    return false;
  }

  _ipc.removeHandler("zalo-linux-get-theme");
  _ipc.handle("zalo-linux-get-theme", () => isLinuxDark() ? "dark" : "light");

  let _lastDark = null;
  function syncTheme() {
    const d = isLinuxDark();
    if (d !== _lastDark) {
      _lastDark = d;
      _nt.themeSource = d ? "dark" : "light";
      _bw.getAllWindows().forEach((w) => {
        try {
          if (w && !w.isDestroyed() && w.webContents) {
            w.webContents.send("zalo-linux-theme-change", d ? "dark" : "light");
          }
        } catch (_) {}
      });
    }
  }

  syncTheme();
  // Poll host portal changes too: sandbox GSettings monitors may stay silent.
  // isLinuxDark() blocks the main process, so poll sparingly.
  let _quitting = false;
  let _poll = null;
  const _startPoll = () => { if (!_poll && !_quitting) _poll = setInterval(syncTheme, 10000); };
  _startPoll();
  try {
    const { spawn: _sp } = require("child_process");
    const _w = _sp("gsettings", ["monitor", "org.gnome.desktop.interface", "color-scheme"], { stdio: ["ignore", "pipe", "ignore"] });
    _w.stdout.on("data", () => syncTheme());
    _w.on("error", _startPoll);
    _w.on("exit", _startPoll);
    // The monitor never exits on its own: without this every app launch
    // left one orphaned gsettings process behind.
    const _stop = () => { _quitting = true; try { _w.kill(); } catch (_) {} };
    _app.on("will-quit", _stop);
    process.on("exit", _stop);
  } catch (_) { _startPoll(); }
})();
`;

// Every version of the main.js injection above (closing `})();` at column 0).
const THEME_MAIN_BLOCK_RE = /\/\/ --- Zalo Linux Auto Dark\/Light Theme Sync ---\n\(function\(\)\{[\s\S]*?\n\}\)\(\);\n?/;

const THEME_PRELOAD_INJECTION = `
// --- Zalo Linux Auto Dark/Light Theme Sync ---
(function() {
  if (process.platform !== "linux") return;
  const { ipcRenderer } = require("electron");

  function applyTheme(isDark) {
    if (isDark) {
      document.documentElement.classList.add("dark");
      if (document.body) document.body.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
      if (document.body) document.body.classList.remove("dark");
    }
    try {
      const confStr = localStorage.getItem("za_theme");
      let conf = confStr ? JSON.parse(confStr) : {};
      if (conf.theme_setting === 2 || !conf.theme) {
        conf.theme = isDark ? "dark" : "light";
        conf.theme_setting = 2;
        localStorage.setItem("za_theme", JSON.stringify(conf));
      }
    } catch (_) {}
  }

  ipcRenderer.on("zalo-linux-theme-change", (e, mode) => {
    applyTheme(mode === "dark");
  });

  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", (e) => applyTheme(e.matches));
    applyTheme(mq.matches);
  } catch (_) {}

  ipcRenderer.invoke("zalo-linux-get-theme").then((mode) => {
    applyTheme(mode === "dark");
  }).catch(() => {});
})();
`;

async function main() {
  const mainDistDir = path.join(APP_DIR, 'main-dist');

  // 1. Patch main-dist/main.js
  const mainJsPath = path.join(mainDistDir, 'main.js');
  if (fs.existsSync(mainJsPath)) {
    let content = fs.readFileSync(mainJsPath, 'utf8');
    const block = THEME_MAIN_INJECTION.replace(/^\n/, '');
    if (THEME_MAIN_BLOCK_RE.test(content)) {
      const updated = content.replace(THEME_MAIN_BLOCK_RE, () => block);
      if (updated !== content) {
        fs.writeFileSync(mainJsPath, updated, 'utf8');
        logger.dim('Updated auto theme watcher in main.js');
      }
    } else if (!content.includes('zalo-linux-theme-change')) {
      const anchor = 'Ae=m.createWithMultiWindow(i,o,gn,oe(),t),g(Ae),v(Ae.webContents),et.setMainWindow(Ae)';
      if (content.includes(anchor)) {
        content = content.replace(anchor, `${anchor};\n${THEME_MAIN_INJECTION}\n`);
      } else {
        content += '\n' + THEME_MAIN_INJECTION + '\n';
      }
      fs.writeFileSync(mainJsPath, content, 'utf8');
      logger.dim('Injected auto theme watcher into main.js');
    }
  }

  // 2. Patch main-dist/preload-render.js
  const preloadJsPath = path.join(mainDistDir, 'preload-render.js');
  if (fs.existsSync(preloadJsPath)) {
    let content = fs.readFileSync(preloadJsPath, 'utf8');
    if (!content.includes('zalo-linux-theme-change')) {
      content = content.trimEnd() + '\n' + THEME_PRELOAD_INJECTION + '\n';
      fs.writeFileSync(preloadJsPath, content, 'utf8');
      logger.dim('Injected auto theme sync into preload-render.js');
    }
  }

  logger.success('Auto Dark/Light theme patch applied');
}

if (require.main === module) {
  main();
}

module.exports = { main };
