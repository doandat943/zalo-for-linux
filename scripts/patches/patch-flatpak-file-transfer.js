const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const START = '// --- Zalo Linux Flatpak File Transfer ---';
const END = '// --- End Zalo Linux Flatpak File Transfer ---';

// gdbus prints a GVariant (as,) tuple. Parse only this type, never eval output.
function parsePortalFiles(output) {
  let text = output.trim();
  const prefix = text.match(/^\(\s*(?:@as\s*)?\[/);
  if (!prefix) throw new Error('Invalid FileTransfer response');
  let pos = prefix[0].length;
  const files = [];
  const whitespace = () => { while (/\s/.test(text[pos] || '') && pos < text.length) pos++; };
  whitespace();
  while (text[pos] !== ']') {
    const quote = text[pos++];
    if (quote !== '"' && quote !== "'") throw new Error('Invalid portal path');
    let value = '', closed = false;
    while (pos < text.length) {
      let char = text[pos++];
      if (char === quote) { closed = true; break; }
      if (char === '\\') {
        char = text[pos++];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '\\': '\\', "'": "'", '"': '"' };
        if (!Object.prototype.hasOwnProperty.call(escapes, char)) throw new Error('Invalid portal escape');
        char = escapes[char];
      }
      value += char;
    }
    if (!closed || !value.startsWith('/') || value.includes('\0')) throw new Error('Invalid portal path');
    files.push(value);
    whitespace();
    if (text[pos] === ',') { pos++; whitespace(); }
    else if (text[pos] !== ']') throw new Error('Invalid portal file list');
  }
  if (!/^\]\s*,?\s*\)$/.test(text.slice(pos))) throw new Error('Invalid FileTransfer response');
  return files;
}

// Electron 22 filters the portal MIME out of drop events. Read that one target
// from XDND through Flatpak's existing X11 socket; no host command or addon.
function readDragKey() {
  const net = require('net'), fs = require('fs'), path = require('path');
  const display = /^(?:unix)?:([0-9]+)(?:\.[0-9]+)?$/.exec(process.env.DISPLAY || '');
  if (!display) return Promise.resolve('');
  const pad = length => (length + 3) & ~3;
  let name = Buffer.alloc(0), cookie = Buffer.alloc(0);
  try {
    const auth = fs.readFileSync(process.env.XAUTHORITY || path.join(require('os').homedir(), '.Xauthority'));
    let pos = 0;
    const field = () => {
      const length = auth.readUInt16BE(pos); pos += 2;
      if (pos + length > auth.length) throw new Error('Invalid Xauthority');
      const value = auth.subarray(pos, pos + length); pos += length; return value;
    };
    while (pos < auth.length) {
      const family = auth.readUInt16BE(pos); pos += 2;
      field();
      const number = field(), method = field(), data = field();
      if ((family === 256 || family === 65535) && (!number.length || number.toString() === display[1]) && method.toString() === 'MIT-MAGIC-COOKIE-1') {
        name = method; cookie = data; break;
      }
    }
  } catch (_) { /* Xhost-authorized connections can have no cookie. */ }
  const hello = Buffer.alloc(12 + pad(name.length) + pad(cookie.length));
  hello[0] = 108; hello.writeUInt16LE(11, 2);
  hello.writeUInt16LE(name.length, 6); hello.writeUInt16LE(cookie.length, 8);
  name.copy(hello, 12); cookie.copy(hello, 12 + pad(name.length));

  return new Promise(resolve => {
    const socket = net.createConnection(`/tmp/.X11-unix/X${display[1]}`);
    let buffered = Buffer.alloc(0), connected = false, finished = false, sequence = 0;
    const pending = new Map();
    const timeout = setTimeout(() => finish(''), 1500);
    function finish(key) {
      if (finished) return;
      finished = true; clearTimeout(timeout); socket.destroy();
      for (const request of pending.values()) request.reject(new Error('XDND connection closed'));
      pending.clear(); resolve(key);
    }
    const request = (opcode, bytes, detail = 0) => {
      const message = Buffer.alloc(pad(4 + bytes.length));
      message[0] = opcode; message[1] = detail; message.writeUInt16LE(message.length / 4, 2); bytes.copy(message, 4);
      sequence = (sequence + 1) & 65535;
      socket.write(message);
      return sequence;
    };
    const reply = (opcode, bytes, detail = 0) => new Promise((resolve, reject) => {
      const seq = request(opcode, bytes, detail); pending.set(seq, { resolve, reject });
    });
    const atom = async value => {
      const text = Buffer.from(value), bytes = Buffer.alloc(4 + text.length);
      bytes.writeUInt16LE(text.length, 0); text.copy(bytes, 4);
      return (await reply(16, bytes)).readUInt32LE(8);
    };
    let windowId, selection, target, property;
    async function start(setup) {
      const vendorLength = setup.readUInt16LE(24), formats = setup[29];
      const rootOffset = 40 + pad(vendorLength) + formats * 8;
      if (!setup[28] || rootOffset + 4 > setup.length) throw new Error('Missing X11 screen');
      const base = setup.readUInt32LE(12), mask = setup.readUInt32LE(16);
      windowId = (base | (mask & -mask)) >>> 0;
      const create = Buffer.alloc(28);
      create.writeUInt32LE(windowId, 0); create.writeUInt32LE(setup.readUInt32LE(rootOffset), 4);
      create.writeUInt16LE(1, 12); create.writeUInt16LE(1, 14);
      request(1, create); // Unmapped window, all other fields CopyFromParent.
      selection = await atom('XdndSelection');
      const ownerBytes = Buffer.alloc(4); ownerBytes.writeUInt32LE(selection);
      if (!(await reply(23, ownerBytes)).readUInt32LE(8)) return finish('');
      target = await atom('application/vnd.portal.filetransfer');
      property = await atom('_ZALO_PORTAL_TRANSFER');
      const convert = Buffer.alloc(20);
      [windowId, selection, target, property, 0].forEach((v, i) => convert.writeUInt32LE(v, i * 4));
      request(24, convert);
    }
    async function selectionReady(message) {
      if (message.readUInt32LE(8) !== windowId || message.readUInt32LE(12) !== selection || message.readUInt32LE(16) !== target) return;
      if (message.readUInt32LE(20) !== property) return finish('');
      const bytes = Buffer.alloc(20);
      [windowId, property, 0, 0, 1024].forEach((v, i) => bytes.writeUInt32LE(v, i * 4));
      const value = await reply(20, bytes, 1);
      const length = value.readUInt32LE(16);
      if (value[1] !== 8 || value.readUInt32LE(8) !== target || value.readUInt32LE(12) || length > 4096 || 32 + length > value.length) return finish('');
      finish(value.subarray(32, 32 + length).toString('utf8').replace(/\0+$/, '').trim());
    }
    socket.once('connect', () => socket.write(hello));
    socket.on('error', () => finish(''));
    socket.on('close', () => finish(''));
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 1024 * 1024) return finish('');
      while (!finished) {
        if (!connected) {
          if (buffered.length < 8) return;
          const length = 8 + buffered.readUInt16LE(6) * 4;
          if (buffered.length < length) return;
          const setup = buffered.subarray(0, length); buffered = buffered.subarray(length);
          if (setup[0] !== 1 || setup.length < 40) return finish('');
          connected = true; void start(setup).catch(() => finish(''));
        } else {
          if (buffered.length < 32) return;
          const type = buffered[0] & 127;
          const length = type === 1 ? 32 + buffered.readUInt32LE(4) * 4 : 32;
          if (length > 1024 * 1024) return finish('');
          if (buffered.length < length) return;
          const message = buffered.subarray(0, length); buffered = buffered.subarray(length);
          if (type === 0) return finish('');
          if (type === 1) {
            const seq = message.readUInt16LE(2), waiter = pending.get(seq);
            if (waiter) { pending.delete(seq); waiter.resolve(message); }
          } else if (type === 31) void selectionReady(message).catch(() => finish(''));
        }
      }
    });
  });
}

function installMain(parseFiles, readDragKey) {
  if (process.platform !== 'linux') return;
  const fs = require('fs');
  if (!process.env.FLATPAK_ID && !fs.existsSync('/.flatpak-info')) return;
  if (global.__zaloFlatpakFileTransfer) return;
  global.__zaloFlatpakFileTransfer = true;
  const { ipcMain } = require('electron');
  const { execFile } = require('child_process');
  const path = require('path');

  async function inspect(paths) {
    return Promise.all(paths.map(async filePath => {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('Unsupported file type');
      await fs.promises.access(filePath, fs.constants.R_OK);
      return { path: filePath, name: path.basename(filePath), size: stat.size, lastModified: stat.mtimeMs, isDirectory: stat.isDirectory() };
    }));
  }
  async function retrieve(key) {
    // Use the filtered session-bus socket supplied by Flatpak. Portal names
    // are allowed by default: no session-bus socket or host/home permission.
    const output = await new Promise((resolve, reject) => {
      execFile('gdbus', ['call', '--session', '--dest', 'org.freedesktop.portal.Documents',
        '--object-path', '/org/freedesktop/portal/documents',
        '--method', 'org.freedesktop.portal.FileTransfer.RetrieveFiles', '--timeout', '5',
        JSON.stringify(key), '{}'], { timeout: 7000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    const files = parseFiles(output);
    if (!files.length) throw new Error('Empty FileTransfer response');
    return files;
  }

  ipcMain.handle('zalo-linux-resolve-transferred-files', async (event, request) => {
    if (!request || !Array.isArray(request.paths) || request.paths.length > 1024 ||
        request.paths.some(p => typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) ||
        typeof request.key !== 'string' || request.key.length > 4096 || request.key.includes('\0') ||
        (request.drag !== undefined && typeof request.drag !== 'boolean')) {
      throw new Error('Invalid file transfer request');
    }
    let paths = request.paths;
    let key = request.key;
    if (request.drag && !key) {
      try { key = await readDragKey(); }
      catch (err) { console.warn('[Flatpak file transfer] XDND unavailable:', err.message); }
    }
    if (key) {
      try { paths = await retrieve(key); }
      catch (err) { console.warn('[Flatpak file transfer] Portal unavailable:', err.code || 'Portal request failed'); }
    }
    if (paths.length) {
      try { return await inspect(paths); }
      catch (err) { console.warn('[Flatpak file transfer] File access denied:', err.message); }
    }
    // Only the sender's token can grant access automatically. Never prompt,
    // guess a document path, or forward an inaccessible zero-byte File.
    return [];
  });
}

function installPreload(installRenderer) {
  if (process.platform !== 'linux') return;
  const fs = require('fs');
  if (!process.env.FLATPAK_ID && !fs.existsSync('/.flatpak-info')) return;
  const { ipcRenderer, clipboard, contextBridge, webFrame } = require('electron');
  const { fileURLToPath } = require('url');
  const granted = new Set();
  const api = {
    clipboardKey: async () => {
      // Chromium is still consuming the native selection during paste. Read
      // its extra MIME target after that transaction releases the clipboard.
      await new Promise(resolve => setTimeout(resolve, 0));
      return Buffer.from(clipboard.readBuffer('application/vnd.portal.filetransfer')).toString('utf8');
    },
    fileURLToPath,
    needsAccess: files => files.some(file => {
      if (!file.path) return false;
      try {
        const stat = fs.statSync(file.path);
        fs.accessSync(file.path, fs.constants.R_OK);
        return stat.isFile() && stat.size !== file.size;
      } catch (_) { return true; }
    }),
    resolve: async request => {
      const entries = await ipcRenderer.invoke('zalo-linux-resolve-transferred-files', request);
      for (const entry of entries) {
        if (!entry.isDirectory) granted.add(entry.path);
        // trustBlob loses custom File.path across contextBridge. Trust the
        // granted path through the same internal helper in the preload world.
        window.$zFileManager?.trustPathFromBlob(entry.path);
      }
      return entries;
    },
    read: async filePath => {
      if (!granted.has(filePath)) throw new Error('File was not granted by the transfer');
      return new Uint8Array(await fs.promises.readFile(filePath));
    }
  };
  if (process.contextIsolated) contextBridge.exposeInMainWorld('__zaloFlatpakTransfer', api);
  else window.__zaloFlatpakTransfer = api;
  // Files and their path expandos must be created in Zalo's world. The bridge
  // copies custom File properties away when crossing context isolation.
  void webFrame.executeJavaScript(`(${installRenderer.toString()})();`).catch(err => console.warn('[Flatpak file transfer]', err.message));
}

function installRenderer() {
  const api = window.__zaloFlatpakTransfer;
  if (!api || window.__zaloFlatpakTransferInstalled) return;
  window.__zaloFlatpakTransferInstalled = true;
  const MIME = 'application/vnd.portal.filetransfer';
  const replayed = new WeakSet();
  let pendingDrag = null;
  window.addEventListener('dragenter', event => {
    if (replayed.has(event) || pendingDrag || !Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    // Ask for the XDND token while the sender still owns the selection.
    pendingDrag = api.resolve({ key: '', paths: [], drag: true }).catch(err => {
      console.warn('[Flatpak file transfer] Unable to prepare drag:', err.message);
      return [];
    });
  }, true);
  window.addEventListener('dragleave', event => {
    // Chromium sends dragenter(new child) BEFORE dragleave(old child).
    // Preserve the token across overlays; clear it only when leaving the window.
    if (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= innerWidth || event.clientY >= innerHeight) pendingDrag = null;
  }, true);
  window.addEventListener('dragend', () => { pendingDrag = null; }, true);
  function endDrag() {
    pendingDrag = null;
    // Reuse Zalo's global dragend cleanup even when resolution fails.
    const chat = document.getElementById('chatView');
    if (chat) chat.dispatchEvent(new DragEvent('dragend', { dataTransfer: new DataTransfer(), bubbles: true }));
  }

  function capture(event) {
    const data = event.type === 'paste' ? event.clipboardData : event.dataTransfer;
    if (!data) return null;
    const types = Array.from(data.types || []);
    const files = Array.from(data.files || []);
    if (!files.length) for (const item of Array.from(data.items || [])) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    let key = data.getData(MIME);
    let clipboardKey;
    // Only query the native clipboard for file transfers; text paste stays
    // synchronous and never touches Electron's clipboard/image APIs.
    const unknownFiles = !files.length && types.includes('Files') && !types.some(t => t.startsWith('image/'));
    if (!key && event.type === 'paste' && (files.some(f => f.path) || unknownFiles || types.includes(MIME) || types.includes('text/uri-list'))) {
      clipboardKey = api.clipboardKey().catch(() => '');
    }
    key = key.replace(/\0+$/, '').trim();
    const uriPaths = data.getData('text/uri-list').split(/\r?\n/).filter(line => line.startsWith('file:')).map(uri => api.fileURLToPath(uri));
    const paths = files.map(file => file.path).filter(Boolean);
    if (!files.length) paths.push(...uriPaths);
    if (!key && !paths.length && !unknownFiles) return null;
    let needsAccess = Boolean(key || unknownFiles || (!files.length && uriPaths.length));
    if (api.needsAccess(files.map(file => ({ path: file.path, size: file.size })))) needsAccess = true;
    if (!needsAccess) return null;
    // Copy strings now: DataTransfer becomes protected after this callback.
    const strings = types.filter(t => t !== 'Files' && t !== MIME).map(t => [t, data.getData(t)]);
    return { key, clipboardKey, paths, files, strings, drag: event.type === 'drop' ? pendingDrag : null };
  }

  async function restore(transfer, target) {
    if (!transfer.key && transfer.clipboardKey) transfer.key = (await transfer.clipboardKey).replace(/\0+$/, '').trim();
    let entries = transfer.drag ? await transfer.drag : [];
    // Never reuse a token from an earlier/different drag or the clipboard.
    if (entries.length && transfer.files.length && (entries.length !== transfer.files.length || !transfer.files.every(file => entries.some(entry => entry.name === file.name)))) entries = [];
    if (!entries.length) entries = await api.resolve({ key: transfer.key, paths: transfer.paths });
    if (!entries.length || !target.isConnected) return;
    const dt = new DataTransfer();
    const directories = new Set();
    for (const [type, value] of transfer.strings) {
      // Do not retain URI/HTML references to paths which were denied access.
      if (type !== 'text/uri-list' && type !== 'text/html') dt.setData(type, value);
    }
    for (const entry of entries) {
      const original = transfer.files.find(file => file.name === entry.name);
      const bytes = entry.isDirectory ? [] : await api.read(entry.path);
      if (!entry.isDirectory && bytes.length !== entry.size) throw new Error('Transferred file changed while reading');
      const file = new File([bytes], entry.name, { type: original ? original.type : '', lastModified: entry.lastModified });
      Object.defineProperty(file, 'path', { value: entry.path });
      dt.items.add(file);
      if (entry.isDirectory) directories.add(file);
      // Reuse Zalo's trust mechanism for subsequent native reads/chunk uploads.
      if (window.$zFileManager) window.$zFileManager.trustBlob(file);
    }
    if (directories.size) {
      // Chromium recreates DataTransferItem wrappers on each lookup. Keep
      // stable items so Zalo's existing directory check sees the granted folder.
      const items = Array.from(dt.items);
      for (const item of items) {
        const file = item.kind === 'file' && item.getAsFile();
        if (directories.has(file)) {
          Object.defineProperty(item, 'webkitGetAsEntry', { value: () => ({ isDirectory: true, isFile: false, name: file.name, fullPath: file.path }) });
        }
      }
      Object.defineProperty(dt, 'items', { value: items });
    }
    // Reuse Zalo's existing file-drop upload and preview for both ingress paths.
    // Replaying paste would also invoke the legacy clipboard image patch.
    const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    replayed.add(drop);
    target.style.display = 'block';
    const enter = new DragEvent('dragenter', { dataTransfer: dt, bubbles: true });
    replayed.add(enter);
    target.dispatchEvent(enter);
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(drop);
  }
  function receive(event) {
    if (replayed.has(event)) return;
    let target = event.type === 'paste' ? document.getElementById('dragOverlayInputbox') :
      event.target instanceof Element && event.target.closest('#dragOverlayInputbox, #dragOverlayMessageView');
    // A portal-only drag may have no Files MIME type, so Zalo may not have
    // shown an overlay. Still accept it within the actual chat drop areas.
    if (!target && event.type === 'drop' && event.target instanceof Element) {
      if (event.target.closest('.chat-input-container')) target = document.getElementById('dragOverlayInputbox');
      else if (event.target.closest('#messageViewContainer')) target = document.getElementById('dragOverlayMessageView');
    }
    if (!target) { if (event.type === 'drop') pendingDrag = null; return; }
    let transfer;
    try { transfer = capture(event); }
    catch (err) {
      event.preventDefault();
      event.stopImmediatePropagation();
      endDrag();
      console.warn('[Flatpak file transfer] Invalid transfer:', err.message);
      return;
    }
    if (!transfer) { if (event.type === 'drop') pendingDrag = null; return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    // Release the blocking overlay immediately, including slow/denied portal
    // requests. The captured promise remains attached to this transfer.
    endDrag();
    void restore(transfer, target)
      .catch(err => console.warn('[Flatpak file transfer] Unable to read files:', err.message))
      .finally(endDrag);
  }
  // Window capture runs before the legacy document image-paste listener,
  // even if executeJavaScript finishes after DOMContentLoaded.
  window.addEventListener('paste', receive, true);
  window.addEventListener('drop', receive, true);
}

function inject(content, source) {
  const block = `${START}\n${source}\n${END}\n`;
  const start = content.indexOf(START);
  if (start === -1) return block + content;
  const end = content.indexOf(END, start);
  if (end === -1) throw new Error('Flatpak file-transfer patch end marker not found');
  return content.slice(0, start) + block + content.slice(end + END.length).replace(/^\r?\n/, '');
}

function patchFlatpakFileTransfer(content, preload = false) {
  return inject(content, preload ? `(${installPreload.toString()})(${installRenderer.toString()});` : `(${installMain.toString()})(${parsePortalFiles.toString()}, ${readDragKey.toString()});`);
}

async function main() {
  logger.info('Patching Flatpak file transfers...');
  let updated = 0;
  for (const [name, preload] of [['main.js', false], ['compact-app.js', false], ['preload-render.js', true], ['compact-app-preload.js', true]]) {
    const filePath = path.join(APP_DIR, 'main-dist', name);
    if (!fs.existsSync(filePath)) logger.warn(`File-transfer bundle not found: ${name}`);
    const original = fs.readFileSync(filePath, 'utf8');
    const patched = patchFlatpakFileTransfer(original, preload);
    if (patched !== original) {
      fs.writeFileSync(filePath, patched, 'utf8');
      logger.dim(`Patched Flatpak file transfer in ${name}`);
      updated++;
    }
  }
  logger.success(`Flatpak file-transfer patch applied (${updated} updated)`);
}

if (require.main === module) {
  main().catch(error => {
    logger.error('Flatpak file-transfer patch failed:', error.message);
    process.exit(1);
  });
}

module.exports = { main };
