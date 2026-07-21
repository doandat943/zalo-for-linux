const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

function minify(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')
    .replace(/\s*\n\s*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}()=,:;<>+\-*/!?&|])\s*/g, '$1')
    .trim();
}

const ORIGINAL_IMAGE_HELPER =
  'getClipboardImage:()=>{const e=r.clipboard.readImage();return{isEmpty:()=>e.isEmpty(),toJPEG:t=>e.toJPEG(t),toPNG:t=>e.toPNG(t)}},';

// These methods are injected into Zalo's $zelectronNative bridge. Keep all
// external calls synchronous: the paste event must be cancelled before its
// dispatch finishes, otherwise Chromium will still run Zalo's broken native
// paste path and may insert duplicate/empty data.
const HELPERS_SOURCE = `
  getClipboardImagePNG: () => {
    const exec = require("child_process").execFileSync;
    const options = { timeout: 1500, maxBuffer: 25 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] };
    const readExternal = (mime) => {
      if (process.platform !== "linux") return null;
      try {
        const data = exec("wl-paste", ["--type", mime], options);
        if (data && data.length) return data;
      } catch (_) {}
      try {
        const data = exec("xclip", ["-selection", "clipboard", "-t", mime, "-o"], options);
        if (data && data.length) return data;
      } catch (_) {}
      return null;
    };
    const asImage = (data) => {
      if (!data || !data.length) return null;
      try {
        const image = r.nativeImage.createFromBuffer(data);
        return image && !image.isEmpty() ? image : null;
      } catch (_) { return null; }
    };
    try {
      let image = r.clipboard.readImage();
      if (!image.isEmpty()) return image.toPNG().toString("base64");
      image = asImage(r.clipboard.readBuffer("image/png"));
      if (!image) {
        for (const mime of ["image/png", "image/jpeg", "image/webp", "image/bmp"]) {
          image = asImage(readExternal(mime));
          if (image) break;
        }
      }
      if (!image) {
        const uriData = readExternal("text/uri-list");
        if (uriData) {
          const uri = uriData.toString("utf8").split(/\\r?\\n/)
            .map(line => line.trim()).find(line => line && !line.startsWith("#") && line.startsWith("file://"));
          if (uri) {
            const filePath = decodeURIComponent(uri.replace(/^file:\\/\\/(localhost)?/, ""));
            image = asImage(require("fs").readFileSync(filePath));
          }
        }
      }
      return image && !image.isEmpty() ? image.toPNG().toString("base64") : null;
    } catch (_) { return null; }
  },

  getClipboardFilePath: () => {
    const exec = require("child_process").execFileSync;
    const options = { timeout: 1500, stdio: ["ignore", "pipe", "ignore"] };
    const read = (mime) => {
      if (process.platform !== "linux") return null;
      try { return exec("wl-paste", ["--type", mime], options); } catch (_) {}
      try { return exec("xclip", ["-selection", "clipboard", "-t", mime, "-o"], options); } catch (_) {}
      return null;
    };
    try {
      const data = read("text/uri-list");
      if (!data) return null;
      const uri = data.toString("utf8").split(/\\r?\\n/)
        .map(line => line.trim()).find(line => line && !line.startsWith("#") && line.startsWith("file://"));
      return uri ? decodeURIComponent(uri.replace(/^file:\\/\\/(localhost)?/, "")) : null;
    } catch (_) { return null; }
  },

  deleteFile: (filePath) => {
    try { require("fs").unlinkSync(filePath); } catch (_) {}
  },

`;

const TEXT_HELPER_SOURCE = `
  getClipboardText: () => {
    try {
      const nativeText = r.clipboard.readText();
      if (nativeText) return nativeText;
    } catch (_) {}
    if (process.platform !== "linux") return "";
    const exec = require("child_process").execFileSync;
    const options = { timeout: 1500, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] };
    const targets = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING"];
    for (const target of targets) {
      try {
        const data = exec("wl-paste", ["--no-newline", "--type", target], options);
        if (data && data.length) return data.toString("utf8").replace(/\\0+$/, "");
      } catch (_) {}
      try {
        const data = exec("xclip", ["-selection", "clipboard", "-t", target, "-o"], options);
        if (data && data.length) return data.toString("utf8").replace(/\\0+$/, "");
      } catch (_) {}
    }
    return "";
  },
`;

const PASTE_HANDLER = `// ZALO LINUX CLIPBOARD PASTE FIX V2
try {
  const fs = require('fs'), os = require('os'), path = require('path');
  fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('zalo_clip_')).forEach(name => {
    try { fs.unlinkSync(path.join(os.tmpdir(), name)); } catch (_) {}
  });
} catch (_) {}

window.addEventListener('DOMContentLoaded', () => {
  function insertText(target, text) {
    if (!target || !text) return false;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart == null ? target.value.length : target.selectionStart;
      const end = target.selectionEnd == null ? start : target.selectionEnd;
      target.setRangeText(text, start, end, 'end');
      target.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: text
      }));
      return true;
    }
    const editable = target.isContentEditable ? target : target.closest && target.closest('[contenteditable="true"]');
    if (!editable) return false;
    editable.focus();
    return document.execCommand('insertText', false, text);
  }

  function tryPasteImage() {
    if (!window.$zelectronNative || !window.$zelectronNative.getClipboardImagePNG) return false;
    try {
      const base64 = window.$zelectronNative.getClipboardImagePNG();
      if (!base64) return false;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const file = new File([bytes], 'image.png', { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const target = document.getElementById('dragOverlayInputbox');
      if (!target) return false;
      target.style.display = 'block';
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true }));
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true }));
      target.dispatchEvent(new DragEvent('drop', {
        dataTransfer: transfer, bubbles: true, cancelable: true
      }));
      return true;
    } catch (_) { return false; }
  }

  let lastPaste = 0;
  document.addEventListener('paste', event => {
    const now = Date.now();
    if (now - lastPaste < 150) return;
    lastPaste = now;

    const eventText = event.clipboardData && event.clipboardData.getData('text/plain');
    if (eventText) return;

    if (tryPasteImage()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const fallbackText = window.$zelectronNative && window.$zelectronNative.getClipboardText
      ? window.$zelectronNative.getClipboardText() : '';
    if (fallbackText && insertText(event.target || document.activeElement, fallbackText)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
});
`;

function replaceClipboardHelpers(content, fileName) {
  const helpers = minify(HELPERS_SOURCE);
  const textHelper = minify(TEXT_HELPER_SOURCE);
  const helperStart = content.indexOf('getClipboardImagePNG:');
  const textStart = helperStart >= 0 ? content.indexOf('getClipboardText:', helperStart) : -1;

  if (helperStart >= 0 && textStart > helperStart) {
    content = content.slice(0, helperStart) + helpers + content.slice(textStart);
  } else if (content.includes(ORIGINAL_IMAGE_HELPER)) {
    content = content.replace(ORIGINAL_IMAGE_HELPER, ORIGINAL_IMAGE_HELPER + helpers);
  } else {
    throw new Error(`Clipboard image helper anchor not found in ${fileName}`);
  }

  const nativeTextPattern = /getClipboardText:\(\)=>r\.clipboard\.readText\(\),/;
  if (nativeTextPattern.test(content)) {
    content = content.replace(nativeTextPattern, textHelper);
  } else if (!content.includes('getClipboardText:()=>{try{const nativeText=')) {
    throw new Error(`Clipboard text helper anchor not found in ${fileName}`);
  }
  return content;
}

async function main() {
  logger.info('Patching Linux clipboard text and image paste...');
  const preloadFiles = [
    'preload-render.js',
    'preload-noti.js',
    'preload-shared-worker.js',
    'preload-sqlite.js',
    'compact-app-preload.js'
  ];

  for (const fileName of preloadFiles) {
    const filePath = path.join(APP_DIR, 'main-dist', fileName);
    if (!fs.existsSync(filePath)) {
      logger.warn(`Skipping ${fileName} (not found)`);
      continue;
    }
    const original = fs.readFileSync(filePath, 'utf8');
    let content = replaceClipboardHelpers(original, fileName);

    if (fileName === 'preload-render.js') {
      const oldHandler = /^\/\/ (?:CLIPBOARD IMAGE PASTE FIX|ZALO LINUX CLIPBOARD PASTE FIX V2)[\s\S]*?(?=__ZaBUNDLENAME__)/;
      content = oldHandler.test(content)
        ? content.replace(oldHandler, PASTE_HANDLER)
        : PASTE_HANDLER + content;
    }

    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
      logger.dim(`Patched clipboard support in ${fileName}`);
    }
  }
  logger.success('Linux clipboard paste patch applied');
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Clipboard patch failed:', error.message);
    process.exit(1);
  });
}

module.exports = { main, minify, replaceClipboardHelpers };
