'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');

const MAX_SCRIPT_SIZE = 2 * 1024 * 1024;
const IPC = {
  list: 'userscripts:list',
  save: 'userscripts:save',
  remove: 'userscripts:remove',
  toggle: 'userscripts:toggle',
  importFile: 'userscripts:import-file'
};

let BrowserWindowRef;
let mainWindow;
let managerWindow;
let storePath;

function parseMetadata(code) {
  const metadata = {};
  const block = String(code).match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/i);
  if (!block) return metadata;

  const lines = block[1].split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*\/\/\s*@([\w:-]+)\s+(.+?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2];
    if (metadata[key] === undefined) metadata[key] = value;
    else if (Array.isArray(metadata[key])) metadata[key].push(value);
    else metadata[key] = [metadata[key], value];
  }
  return metadata;
}

function metadataValues(metadata, key) {
  if (metadata[key] === undefined) return [];
  return Array.isArray(metadata[key]) ? metadata[key] : [metadata[key]];
}

function firstMetadataValue(metadata, key) {
  return metadataValues(metadata, key)[0] || '';
}

function normalizeScript(input, existing) {
  const code = typeof input.code === 'string' ? input.code : '';
  if (!code.trim()) throw new Error('Nội dung userscript không được để trống.');
  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_SIZE) {
    throw new Error('Userscript không được lớn hơn 2 MB.');
  }

  const metadata = parseMetadata(code);
  const suppliedName = typeof input.name === 'string' ? input.name.trim() : '';
  const name = suppliedName || firstMetadataValue(metadata, 'name') ||
    (existing && existing.name) || 'Untitled userscript';
  if (name.length > 160) throw new Error('Tên userscript không được dài hơn 160 ký tự.');

  return {
    id: existing ? existing.id : crypto.randomBytes(16).toString('hex'),
    name,
    description: firstMetadataValue(metadata, 'description'),
    version: firstMetadataValue(metadata, 'version'),
    enabled: typeof input.enabled === 'boolean'
      ? input.enabled
      : (existing ? existing.enabled : true),
    code,
    metadata,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function readScripts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return Array.isArray(parsed.scripts) ? parsed.scripts : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Cannot read userscripts:', error);
    return [];
  }
}

function writeScripts(scripts) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporaryPath = storePath + '.tmp';
  fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, scripts }, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, storePath);
}

function publicScript(script) {
  return {
    id: script.id,
    name: script.name,
    description: script.description,
    version: script.version,
    enabled: script.enabled,
    code: script.code,
    createdAt: script.createdAt,
    updatedAt: script.updatedAt
  };
}

function assertManagerSender(event) {
  if (!managerWindow || managerWindow.isDestroyed() || event.sender !== managerWindow.webContents) {
    throw new Error('Userscripts request was rejected.');
  }
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function scriptMatches(script, realUrl) {
  const metadata = script.metadata || parseMetadata(script.code);
  // Desktop Zalo is loaded from a local file. This alias lets normal Zalo-web
  // @match rules work for imported Tampermonkey scripts.
  const urls = [realUrl, 'https://chat.zalo.me/'];
  const includes = [...metadataValues(metadata, 'match'), ...metadataValues(metadata, 'include')];
  const excludes = [...metadataValues(metadata, 'exclude-match'), ...metadataValues(metadata, 'exclude')];
  const test = (pattern) => {
    try {
      if (pattern === '<all_urls>') return true;
      if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
        const lastSlash = pattern.lastIndexOf('/');
        const expression = new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
        return urls.some((url) => expression.test(url));
      }
      return urls.some((url) => globToRegExp(pattern).test(url));
    } catch (_) { return false; }
  };
  if (excludes.some(test)) return false;
  return includes.length === 0 || includes.some(test);
}

function buildExecution(script) {
  const info = {
    script: {
      name: script.name,
      version: script.version || '',
      description: script.description || ''
    },
    scriptHandler: 'Zalo for Linux Userscripts',
    version: '1.0.0'
  };
  const namespace = 'zalux-userscript:' + script.id + ':';
  const sourceName = script.name.replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 80) || script.id;

  return `(function () {
    const GM_info = ${JSON.stringify(info)};
    const unsafeWindow = window;
    const prefix = ${JSON.stringify(namespace)};
    const GM_getValue = (key, fallback) => {
      const value = localStorage.getItem(prefix + key);
      if (value === null) return fallback;
      try { return JSON.parse(value); } catch (_) { return fallback; }
    };
    const GM_setValue = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
    const GM_deleteValue = (key) => localStorage.removeItem(prefix + key);
    const GM_listValues = () => Object.keys(localStorage)
      .filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    const GM_addStyle = (css) => {
      const style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      return style;
    };
    try {
      (function (GM_info, unsafeWindow, GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_addStyle) {
${script.code}
      })(GM_info, unsafeWindow, GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_addStyle);
    } catch (error) {
      console.error('[Userscript: ${sourceName}]', error);
    }
  })();\n//# sourceURL=userscript://${sourceName}.user.js`;
}

function runEnabledScripts(win) {
  if (!win || win.isDestroyed()) return;
  const url = win.webContents.getURL();
  if (!url.includes('/pc-dist/index.html') && !url.includes('/pc-dist/child.html')) return;

  for (const script of readScripts()) {
    if (!script.enabled || !scriptMatches(script, url)) continue;
    win.webContents.executeJavaScript(buildExecution(script), true).catch((error) => {
      console.error(`Userscript "${script.name}" failed:`, error);
    });
  }
}

function openManager() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    return;
  }

  managerWindow = new BrowserWindowRef({
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    title: 'Userscripts manager',
    backgroundColor: '#f4f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  managerWindow.setMenuBarVisibility(false);
  if (managerWindow.removeMenu) managerWindow.removeMenu();
  managerWindow.loadFile(path.join(__dirname, 'manager.html'));
  managerWindow.on('closed', () => { managerWindow = null; });
}

function registerIpc(ipcMain) {
  ipcMain.handle(IPC.list, (event) => {
    assertManagerSender(event);
    return readScripts().map(publicScript);
  });
  ipcMain.handle(IPC.save, (event, input) => {
    assertManagerSender(event);
    const scripts = readScripts();
    const index = input.id ? scripts.findIndex((script) => script.id === input.id) : -1;
    if (input.id && index < 0) throw new Error('Không tìm thấy userscript.');
    const saved = normalizeScript(input, index >= 0 ? scripts[index] : null);
    if (index >= 0) scripts[index] = saved;
    else scripts.unshift(saved);
    writeScripts(scripts);
    return publicScript(saved);
  });
  ipcMain.handle(IPC.remove, (event, id) => {
    assertManagerSender(event);
    const scripts = readScripts();
    const next = scripts.filter((script) => script.id !== id);
    if (next.length === scripts.length) throw new Error('Không tìm thấy userscript.');
    writeScripts(next);
    return true;
  });
  ipcMain.handle(IPC.toggle, (event, id, enabled) => {
    assertManagerSender(event);
    const scripts = readScripts();
    const script = scripts.find((item) => item.id === id);
    if (!script) throw new Error('Không tìm thấy userscript.');
    script.enabled = Boolean(enabled);
    script.updatedAt = new Date().toISOString();
    writeScripts(scripts);
    return publicScript(script);
  });
  ipcMain.handle(IPC.importFile, async (event) => {
    assertManagerSender(event);
    const result = await dialog.showOpenDialog(managerWindow, {
      title: 'Import userscript',
      properties: ['openFile'],
      filters: [
        { name: 'Userscript', extensions: ['js'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const stat = fs.statSync(result.filePaths[0]);
    if (stat.size > MAX_SCRIPT_SIZE) throw new Error('Userscript không được lớn hơn 2 MB.');
    const code = fs.readFileSync(result.filePaths[0], 'utf8');
    const metadata = parseMetadata(code);
    return { code, suggestedName: firstMetadataValue(metadata, 'name') || path.basename(result.filePaths[0], '.js') };
  });
}

function register({ app, ipcMain, BrowserWindow }) {
  BrowserWindowRef = BrowserWindow;
  storePath = path.join(app.getPath('userData'), 'userscripts.json');
  registerIpc(ipcMain);

  app.on('browser-window-created', (_event, win) => {
    if (!mainWindow && win.getTitle() !== 'Shared Worker') mainWindow = win;

    win.on('page-title-updated', (event, title) => {
      if (title !== 'USERSCRIPTS_MANAGER_TRIGGER') return;
      event.preventDefault();
      openManager();
    });
    win.webContents.on('dom-ready', () => {
      const url = win.webContents.getURL();
      if (!url.includes('/pc-dist/index.html') && !url.includes('/pc-dist/child.html')) return;
      const menuScript = fs.readFileSync(path.join(__dirname, 'inject-menu.js'), 'utf8');
      win.webContents.executeJavaScript(menuScript, true).catch(() => {});
      runEnabledScripts(win);
    });
  });
}

module.exports = { register, parseMetadata, scriptMatches, normalizeScript, buildExecution };
