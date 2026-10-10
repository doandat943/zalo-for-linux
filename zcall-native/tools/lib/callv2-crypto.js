'use strict';
// call-v2 transport framing between Zalo's main process and the call engine,
// as implemented in Zalo's main-dist/main.js (module "vqv6" + "3Zc2"):
//   - optional first line "<token>\n" (Zalo-Linux adds it, see patch-zcall-callv2.js)
//   - then frames "<hex>$", hex = AES-128-CBC(JSON), IV = 16 zero bytes, PKCS#7
//   - key = ZPC_SECRET_VALUES.callV2TransportAesKey (base64), read at runtime from
//     the user's own copy of main.js so no Zalo secret is stored in this repo.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ZERO_IV = Buffer.alloc(16);

function defaultMainJs() {
  if (process.env.ZALO_MAIN_JS) return process.env.ZALO_MAIN_JS;
  const base = process.env.ZALO_LINUX_DIR || path.join(os.homedir(), 'Zalo-Linux');
  return path.join(base, 'app', 'main-dist', 'main.js');
}

function loadKey(mainJs = defaultMainJs()) {
  const src = fs.readFileSync(mainJs, 'utf8');
  const m = /callV2TransportAesKey:"([A-Za-z0-9+/=]+)"/.exec(src);
  if (!m) throw new Error('callV2TransportAesKey not found in ' + mainJs);
  const key = Buffer.from(m[1], 'base64');
  if (key.length !== 16) throw new Error('unexpected key length ' + key.length);
  return key;
}

function encrypt(json, key) {
  const c = crypto.createCipheriv('aes-128-cbc', key, ZERO_IV);
  return Buffer.concat([c.update(JSON.stringify(json)), c.final()]).toString('hex');
}

function decrypt(hex, key) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, ZERO_IV);
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString();
}

// Incremental parser for one direction of one socket.
// onFrame({ token } | { json, raw } | { error, raw })
class FrameParser {
  constructor(key, { expectToken = true } = {}, onFrame) {
    this.key = key;
    this.buf = '';
    this.needToken = expectToken;
    this.onFrame = onFrame;
  }
  push(chunk) {
    this.buf += chunk.toString('latin1');
    if (this.needToken) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) return;
      const first = this.buf.slice(0, nl);
      // Only treat it as a token if it is not already a hex frame.
      if (!/^[0-9a-f]+\$/.test(this.buf)) {
        this.onFrame({ token: first });
        this.buf = this.buf.slice(nl + 1);
      }
      this.needToken = false;
    }
    let i;
    while ((i = this.buf.indexOf('$')) >= 0) {
      let raw = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!raw) continue;
      // Messages over 4000 hex chars are split: "<hex>#<msgId>#<total>#<index>#".
      const chunk = /^([0-9a-f]*)#(\d+)#(\d+)#(\d+)#$/.exec(raw);
      if (chunk) {
        const [, part, id, total, index] = chunk;
        const parts = (this.chunks = this.chunks || {})[id] = this.chunks[id] || [];
        parts[+index] = part;
        if (parts.filter((p) => p !== undefined).length < +total) continue;
        delete this.chunks[id];
        raw = parts.join('');
      }
      try {
        const text = decrypt(raw, this.key);
        let json;
        try { json = JSON.parse(text); } catch (_) { json = text; }
        this.onFrame({ json, raw });
      } catch (e) {
        this.onFrame({ error: e.message, raw: raw.slice(0, 80) });
      }
    }
  }
}

module.exports = { loadKey, encrypt, decrypt, FrameParser, defaultMainJs };
