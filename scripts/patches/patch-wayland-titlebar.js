const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const PATCH_START = '// ZALO LINUX WAYLAND TITLEBAR START';
const PATCH_END = '// ZALO LINUX WAYLAND TITLEBAR END';

// Minimize / maximize / close buttons for Zalo's own title bar on native
// Wayland, where the window has no frame (see plugins/wayland-titlebar).
// They only appear when the main process says the session is native Wayland.
function getPreloadScript() {
  return `${PATCH_START}
(function () {
  if (process.platform !== 'linux') return;
  const { ipcRenderer } = require('electron');
  let enabled = false;
  try { enabled = ipcRenderer.sendSync('zalo-wayland-titlebar:enabled') === true; } catch (_) {}
  if (!enabled) return;

  const ID = 'zalo-wayland-controls';
  const ICONS = {
    minimize: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" stroke="currentColor" stroke-width="1.2"/></svg>',
    maximize: '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    restore: '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="3" width="5.5" height="5.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 3V1.5h5.5V7H7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    close: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.2"/></svg>'
  };
  const CSS = [
    '#' + ID + '{position:fixed;top:0;right:0;height:24px;display:flex;z-index:2147483647;-webkit-app-region:no-drag;}',
    '#' + ID + ' button{width:40px;height:24px;border:0;padding:0;margin:0;background:transparent;color:var(--text-primary,#333);display:flex;align-items:center;justify-content:center;cursor:default;outline:none;}',
    '#' + ID + ' button:hover{background:rgba(127,127,127,.2);}',
    '#' + ID + ' button.close:hover{background:#e81123;color:#fff;}',
    // Keep Zalo's "update" button in the title bar clear of ours.
    '#titleBar .titlebar__btns{right:120px !important;}'
  ].join('');

  let maxButton = null;
  function setMaximized(maximized) {
    if (!maxButton) return;
    maxButton.innerHTML = maximized ? ICONS.restore : ICONS.maximize;
    maxButton.title = maximized ? 'Restore' : 'Maximize';
  }

  function button(action, title) {
    const b = document.createElement('button');
    b.className = action;
    b.title = title;
    b.innerHTML = ICONS[action];
    b.addEventListener('click', () => ipcRenderer.send('zalo-wayland-titlebar:action', action));
    b.addEventListener('dblclick', (e) => e.stopPropagation());
    return b;
  }

  function inject() {
    if (!document.body || document.getElementById(ID)) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const bar = document.createElement('div');
    bar.id = ID;
    bar.appendChild(button('minimize', 'Minimize'));
    maxButton = button('maximize', 'Maximize');
    bar.appendChild(maxButton);
    bar.appendChild(button('close', 'Close'));
    document.body.appendChild(bar);
  }

  ipcRenderer.on('zalo-wayland-titlebar:maximized', (_e, maximized) => setMaximized(maximized));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
${PATCH_END}`;
}

async function main() {
  const preloadPath = path.join(APP_DIR, 'main-dist', 'preload-render.js');

  if (!fs.existsSync(preloadPath)) {
    logger.warn('preload-render.js not present, skipping Wayland titlebar patch');
    return;
  }

  let content = fs.readFileSync(preloadPath, 'utf8');
  const script = getPreloadScript();

  if (content.includes(PATCH_START) && content.includes(PATCH_END)) {
    const start = content.indexOf(PATCH_START);
    const end = content.indexOf(PATCH_END, start) + PATCH_END.length;
    content = content.slice(0, start) + script + content.slice(end);
    fs.writeFileSync(preloadPath, content, 'utf8');
    logger.dim('Updated preload-render.js: Wayland window controls');
    return;
  }

  content = content.trimEnd() + '\n' + script + '\n';
  fs.writeFileSync(preloadPath, content, 'utf8');
  logger.dim('Patched preload-render.js: Wayland window controls');
}

if (require.main === module) {
  main();
}

module.exports = { main };
