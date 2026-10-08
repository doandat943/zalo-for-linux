/**
 * extract-zcall-assets.js
 *
 * The call window's icons and sounds, taken from Zalo's own macOS call
 * helper (Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall, a Qt
 * Widgets program), plus the Zalo Segoe UI fonts of app/pc-dist. Nothing is
 * committed: everything comes from the DMG at build time, into
 * app/zcall-assets/.
 *
 * ZaloCall compiles its files in with Qt's resource system (rcc, format 3).
 * qInitResources_ZaloCallWindows() hands the three tables to
 * qRegisterResourceData(3, tree, names, data) with three RIP-relative `lea`;
 * the symbol table has the function, so no address is hard-coded:
 *   tree   22-byte nodes: name offset u32, flags u16, then
 *          dir: child count u32, first child u32 / file: country u16,
 *          language u16, data offset u32; then a u64 modification time
 *          flags: 1 zlib, 2 directory, 4 zstd
 *   names  u16 length, u32 hash, UTF-16BE name
 *   data   u32 size, bytes (zlib: u32 big-endian plain size first)
 */

const fs = require('fs-extra');
const path = require('path');
const zlib = require('zlib');
const logger = require('./utils/logger');

const APP_DIR = path.join(__dirname, '..', 'app');
const TEMP_DIR = path.join(__dirname, '..', 'temp');
const OUT_DIR = path.join(APP_DIR, 'zcall-assets');
const SYMBOL = '__Z30qInitResources_ZaloCallWindowsv';

// What plugins/zcall/ui uses: the build fails if one is missing.
const REQUIRED = [
  'icon2/resources/offical-v2/endcall.png',
  'icon2/resources/offical-v2/accept_audiocall.png',
  'icon2/resources/offical-v2/accept_videocall.png',
  'icon2/resources/offical-v2/camera1.png',
  'icon2/resources/offical-v2/camera_off1.png',
  'icon2/resources/offical-v2/camera_disabled1.png',
  'icon2/resources/offical-v2/mic1.png',
  'icon2/resources/offical-v2/mic_off1.png',
  'icon2/resources/offical-v2/mic_disabled1.png',
  'icon2/resources/offical-v2/mic3.png',
  'icon2/resources/offical-v2/speak.png',
  'icon/resources/svg/dropup.svg',
  'icon/resources/svg/dropupdisable.svg',
  'icon/resources/svg/setting.svg',
  'icon/resources/svg/sharescreen.svg',
  'icon/resources/svg/sharescreenoff.svg',
  'icon/resources/svg/grid.svg',
  'icon/resources/offical/close_white.png',
  'icon/resources/offical/icn_callsetting_check.png',
  'sound/zalo_ringtone.mp3',
  'sound/zalo_ringback.mp3',
  'sound/endcall.mp3',
  'fonts/ZaloSegoeUI-Regular.ttf',
  'fonts/ZaloSegoeUI-Semibold.ttf',
  'fonts/ZaloSegoeUI-Bold.ttf',
];

// The x86_64 slice of a universal Mach-O (the `lea` decoding below is x86-64).
function x86Slice(buf) {
  const magic = buf.readUInt32BE(0);
  if (magic === 0xcafebabe) {
    const n = buf.readUInt32BE(4);
    for (let i = 0; i < n; i++) {
      const o = 8 + 20 * i;
      if (buf.readUInt32BE(o) === 0x01000007) return buf.subarray(buf.readUInt32BE(o + 8), buf.readUInt32BE(o + 8) + buf.readUInt32BE(o + 12));
    }
    throw new Error('ZaloCall has no x86_64 slice');
  }
  if (magic === 0xcffaedfe && buf.readUInt32LE(4) === 0x01000007) return buf;
  throw new Error('ZaloCall is not an x86_64 Mach-O');
}

// Segments (vmaddr -> file offset) and the address of one symbol.
function machO(b) {
  if (b.readUInt32LE(0) !== 0xfeedfacf) throw new Error('not a 64-bit Mach-O');
  const ncmds = b.readUInt32LE(16);
  const segs = [];
  let symtab = null;
  let o = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = b.readUInt32LE(o), size = b.readUInt32LE(o + 4);
    if (cmd === 0x19) { // LC_SEGMENT_64
      segs.push({ vmaddr: Number(b.readBigUInt64LE(o + 24)), vmsize: Number(b.readBigUInt64LE(o + 32)), fileoff: Number(b.readBigUInt64LE(o + 40)) });
    } else if (cmd === 0x2) { // LC_SYMTAB
      symtab = { symoff: b.readUInt32LE(o + 8), nsyms: b.readUInt32LE(o + 12), stroff: b.readUInt32LE(o + 16) };
    }
    o += size;
  }
  if (!symtab) throw new Error('ZaloCall has no symbol table');
  const off = (va) => {
    const s = segs.find((x) => va >= x.vmaddr && va < x.vmaddr + x.vmsize);
    if (!s) throw new Error('unmapped address 0x' + va.toString(16));
    return s.fileoff + va - s.vmaddr;
  };
  const find = (name) => {
    const want = Buffer.from(name + '\0', 'latin1');
    for (let i = 0; i < symtab.nsyms; i++) {
      const e = symtab.symoff + 16 * i;
      const strx = b.readUInt32LE(e);
      if (b.compare(want, 0, want.length, symtab.stroff + strx, symtab.stroff + strx + want.length) === 0) {
        return Number(b.readBigUInt64LE(e + 8));
      }
    }
    throw new Error('symbol not found: ' + name);
  };
  return { off, find };
}

// tree / names / data from the three `lea disp32(%rip), %rsi|%rdx|%rcx` of qInitResources.
function resourceTables(b, m) {
  const fn = m.find(SYMBOL);
  const code = m.off(fn);
  const regs = { 0x35: 'tree', 0x15: 'names', 0x0d: 'data' };
  const t = {};
  for (let i = 0; i < 64; i++) {
    const p = code + i;
    if (b[p] === 0x48 && b[p + 1] === 0x8d && regs[b[p + 2]] && !t[regs[b[p + 2]]]) {
      const target = fn + i + 7 + b.readInt32LE(p + 3);
      t[regs[b[p + 2]]] = m.off(target);
    }
  }
  if (!t.tree || !t.names || !t.data) throw new Error('resource tables not found in ' + SYMBOL);
  return t;
}

function readTree(b, t) {
  const files = [];
  const name = (o) => {
    const len = b.readUInt16BE(t.names + o);
    // swap16 works in place: on a copy, names are shared between entries.
    return Buffer.from(b.subarray(t.names + o + 6, t.names + o + 6 + 2 * len)).swap16().toString('utf16le');
  };
  const walk = (i, dir, depth) => {
    if (depth > 32) throw new Error('resource tree too deep');
    const p = t.tree + 22 * i;
    const flags = b.readUInt16BE(p + 4);
    const full = i === 0 ? '' : path.posix.join(dir, name(b.readUInt32BE(p)));
    if (flags & 2) {
      const count = b.readUInt32BE(p + 6), first = b.readUInt32BE(p + 10);
      for (let c = first; c < first + count; c++) walk(c, full, depth + 1);
      return;
    }
    const d = t.data + b.readUInt32BE(p + 10);
    let bytes = b.subarray(d + 4, d + 4 + b.readUInt32BE(d));
    if (flags & 4) throw new Error('zstd resource not supported: ' + full);
    if (flags & 1) bytes = zlib.inflateSync(bytes.subarray(4));
    files.push({ name: full, bytes });
  };
  walk(0, '', 0);
  return files;
}

function findFile(dir, test) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, test); if (r) return r; }
    else if (test(e.name)) return p;
  }
  return null;
}

// Zalo Segoe UI of the macOS app (pc-dist/…/Zalo-Segoe-UI[-Weight].<hash>.ttf).
function copyFonts() {
  const pc = path.join(APP_DIR, 'pc-dist');
  for (const [weight, re] of [
    ['Regular', /^Zalo-Segoe-UI\.[0-9a-f]+\.ttf$/],
    ['Semibold', /^Zalo-Segoe-UI-Semibold\.[0-9a-f]+\.ttf$/],
    ['Bold', /^Zalo-Segoe-UI-Bold\.[0-9a-f]+\.ttf$/],
  ]) {
    const src = findFile(pc, (n) => re.test(n));
    if (src) fs.copySync(src, path.join(OUT_DIR, 'fonts', `ZaloSegoeUI-${weight}.ttf`));
  }
}

async function main() {
  const helper = findFile(TEMP_DIR, (n) => n === 'ZaloCall');
  if (!helper) throw new Error('ZaloCall not extracted from the DMG (temp/Zalo*/Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall)');
  const b = x86Slice(fs.readFileSync(helper));
  const files = readTree(b, resourceTables(b, machO(b)));
  fs.removeSync(OUT_DIR);
  for (const f of files) fs.outputFileSync(path.join(OUT_DIR, f.name), f.bytes);
  copyFonts();
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(OUT_DIR, f)));
  if (missing.length) throw new Error('call assets missing: ' + missing.join(', '));
  logger.success(`Call assets: ${files.length} files from ZaloCall, fonts from pc-dist`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}
