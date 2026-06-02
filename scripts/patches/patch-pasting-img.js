const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

// Minify JS to match Zalo's bundler output style (no newlines, single
// spaces, no block comments). Preserves string literals.
function minify(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, '')                              // block comments
    .replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')                        // line comments (avoid ://, // in strings)
    .replace(/\s*\n\s*/g, '')                                      // strip newlines + indent
    .replace(/\s+/g, ' ')                                          // collapse runs of whitespace
    .replace(/\s*([{}()=,:;<>+\-*/!?&|])\s*/g, '$1')               // drop space around operators/punct
    .trim();
}

async function main() {
  const preloadFiles = [
    'preload-render.js',
    'preload-noti.js',
    'preload-shared-worker.js',
    'preload-sqlite.js',
    'compact-app-preload.js'
  ];

  // Match pattern (must stay minified to match the minified Zalo source)
  const original = 'getClipboardImage:()=>{const e=r.clipboard.readImage();return{isEmpty:()=>e.isEmpty(),toJPEG:t=>e.toJPEG(t),toPNG:t=>e.toPNG(t)}},';

  // 4 new clipboard helpers. Source is kept readable; `minify()` runs at
  // patch time so it blends into the surrounding minified Zalo code.
  const helpersSource = `
    // Read the clipboard as a base64-encoded PNG. Tries Electron's
    // readImage() first; if it returns an empty NativeImage, falls back
    // to readBuffer('image/png') + createFromBuffer().
    getClipboardImagePNG: () => {
        let e = r.clipboard.readImage();
        if (e.isEmpty()) {
            try {
                const buf = r.clipboard.readBuffer("image/png");
                if (buf && buf.length > 0) {
                    e = r.nativeImage.createFromBuffer(buf);
                }
            } catch (_) {}
        }
        if (e.isEmpty()) return null;
        return e.toPNG().toString("base64");
    },

    // Return the local filesystem path of a file that the user copied
    // (e.g. an image file copied from a file manager). Wayland exposes
    // such copies as 'text/uri-list', so we shell out to wl-paste /
    // xclip to read it. Returns null if the clipboard has no file URI.
    getClipboardFilePath: () => {
        const _rc = (t) => {
            const _ex = require("child_process").execFileSync;
            const _o = { timeout: 1e3, stdio: ["ignore", "pipe", "ignore"] };
            try {
                const _b = _ex("wl-paste", ["--type", t], _o);
                if (_b && _b.length > 0) return _b;
            } catch (_) {}
            try {
                const _b = _ex("xclip", ["-selection", "clipboard", "-t", t, "-o"], _o);
                if (_b && _b.length > 0) return _b;
            } catch (_) {}
            return null;
        };
        try {
            const _b = _rc("text/uri-list");
            if (!_b) return null;
            const text = _b.toString().trim();
            if (!text) return null;
            const uri = text.split("\\n")[0].trim();
            if (!uri.startsWith("file://")) return null;
            return decodeURIComponent(uri.replace("file://", ""));
        } catch (_) { return null; }
    },

    // Delete a file at the given path. Swallow errors.
    deleteFile: (p) => {
        try { require("fs").unlinkSync(p); } catch (_) {}
    },

    // Save the clipboard image to a temp .png file and return its path.
    // Preferred for large images (avoids base64 33% bloat). Tries the
    // Electron API first; if that yields nothing, falls back to the
    // external clipboard tools (works on both Wayland and X11).
    saveClipboardImageToTemp: () => {
        const _rc = (t) => {
            const _ex = require("child_process").execFileSync;
            const _o = { timeout: 1e3, stdio: ["ignore", "pipe", "ignore"] };
            try {
                const _b = _ex("wl-paste", ["--type", t], _o);
                if (_b && _b.length > 0) return _b;
            } catch (_) {}
            try {
                const _b = _ex("xclip", ["-selection", "clipboard", "-t", t, "-o"], _o);
                if (_b && _b.length > 0) return _b;
            } catch (_) {}
            return null;
        };
        try {
            const _fs = require("fs"), _os = require("os"), _path = require("path");
            let e = r.clipboard.readImage();
            if (e.isEmpty()) {
                try {
                    const buf = r.clipboard.readBuffer("image/png");
                    if (buf && buf.length > 0) e = r.nativeImage.createFromBuffer(buf);
                } catch (_) {}
            }
            if (e.isEmpty()) {
                const _b = _rc("image/png");
                if (_b && _b.length > 0) {
                    const tmpPath = _path.join(_os.tmpdir(), "zalo_clip_" + Date.now() + ".png");
                    _fs.writeFileSync(tmpPath, _b);
                    return tmpPath;
                }
                return null;
            }
            const tmpPath = _path.join(_os.tmpdir(), "zalo_clip_" + Date.now() + ".png");
            _fs.writeFileSync(tmpPath, e.toPNG());
            return tmpPath;
        } catch (err) { return String(err); }
    },
`;

  // Paste handler. Prepended to preload-render.js, sits BEFORE the
  // minified `__ZaBUNDLENAME__` line, so it can stay readable.
  const pasteHandler = `// CLIPBOARD IMAGE PASTE FIX
// Cleanup old temp files on startup
try {
    const _fs = require('fs'), _os = require('os'), _path = require('path');
    _fs.readdirSync(_os.tmpdir()).filter(f => f.startsWith('zalo_clip_')).forEach(f => {
        try { _fs.unlinkSync(_path.join(_os.tmpdir(), f)); } catch(_) {}
    });
} catch(_) {}
window.addEventListener('DOMContentLoaded', () => {
    async function tryPasteImage() {
        if (!window.$zelectronNative) return;
        try {
            let file = null;
            const b64 = window.$zelectronNative.getClipboardImagePNG && window.$zelectronNative.getClipboardImagePNG();
            if (b64) {
                const binary = atob(b64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                file = new File([bytes], 'image.png', { type: 'image/png' });
            } else {
                const filePath = window.$zelectronNative.getClipboardFilePath && window.$zelectronNative.getClipboardFilePath();
                if (!filePath) return;
                const ext = filePath.split('.').pop().toLowerCase();
                const imageExts = ['png','jpg','jpeg','gif','webp','bmp','tiff','tif','avif','jxl'];
                if (!imageExts.includes(ext)) return;
                const res = await fetch('file://' + filePath);
                const blob = await res.blob();
                file = new File([blob], filePath.split('/').pop(), { type: blob.type || 'image/png' });
            }
            if (!file) return;
            const dt = new DataTransfer();
            dt.items.add(file);
            const target = document.getElementById('dragOverlayInputbox');
            if (!target) return;
            target.style.display = 'block';
            target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
            target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
            target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        } catch(err) {}
    }
    let _lastPaste = 0;
    document.addEventListener('paste', async (e) => {
        const now = Date.now();
        if (now - _lastPaste < 200) return;
        _lastPaste = now;
        await tryPasteImage();
    }, true);
});
`;

  const helpers = minify(helpersSource);

  for (const file of preloadFiles) {
    const filePath = path.join(APP_DIR, 'main-dist', file);
    if (!fs.existsSync(filePath)) {
      logger.warn(`Skipping ${file} (not found)`);
      continue;
    }

    let content = fs.readFileSync(filePath, 'utf8');

    if (!content.includes('getClipboardImagePNG:()=>{let e=r.clipboard.readImage()')) {
      if (content.includes(original)) {
        content = content.replace(original, original + helpers);
        logger.dim(`Patched clipboard helpers in ${file}`);
      } else {
        logger.warn(`Pattern not found in ${file}, skipping helpers`);
      }
    }

    if (file === 'preload-render.js' && !content.includes('tryPasteImage')) {
      content = pasteHandler + content;
      logger.dim(`Patched tryPasteImage listener in ${file}`);
    }

    fs.writeFileSync(filePath, content, 'utf8');
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
