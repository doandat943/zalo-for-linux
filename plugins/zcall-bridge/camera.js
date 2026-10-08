'use strict';

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

function nativeExecutable(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  const file = (result.stdout || '').trim();
  if (result.status !== 0 || !file) throw new Error(name + ' is required for the native camera bridge');
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(5);
  try { fs.readSync(fd, header, 0, 5, 0); } finally { fs.closeSync(fd); }
  if (header.toString('hex') !== '7f454c4602') throw new Error(name + ' must be a 64-bit ELF executable');
  return file;
}

function watchCameras(onChange, log) {
  const nodes = new Map();
  let child = null, retry = null, closed = false, first = true;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  function start() {
    if (closed) return;
    let document = '', initial = true;
    child = spawn('pw-dump', ['--monitor', '--no-colors'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const current = child;
    const lines = readline.createInterface({ input: current.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (closed || child !== current) return;
      document += line + '\n';
      if (document.length > 8 * 1024 * 1024) { log('PipeWire monitor document is too large'); current.kill(); return; }
      if (line !== ']') return;
      try {
        const updates = JSON.parse(document);
        if (!Array.isArray(updates)) throw new Error('Invalid PipeWire monitor update');
        if (initial) { nodes.clear(); initial = false; }
        for (const update of updates) {
          const previous = nodes.get(update.id);
          if (update.info === null) { nodes.delete(update.id); continue; }
          const info = { ...(previous || {}).info, ...update.info,
            props: { ...((previous || {}).info || {}).props, ...(update.info || {}).props },
            params: { ...((previous || {}).info || {}).params, ...(update.info || {}).params } };
          if (info.props['media.class'] === 'Video/Source') nodes.set(update.id, { ...previous, ...update, info });
        }
        const cameras = [...nodes.values()].sort((a, b) =>
          Number(b.info.props['priority.session'] || 0) - Number(a.info.props['priority.session'] || 0));
        onChange(cameras);
        if (first) { first = false; resolveReady(); }
      } catch (error) { log(error.message); }
      document = '';
    });
    current.stderr.on('data', data => log(data.toString().trim().slice(0, 1000)));
    current.on('error', error => { log(error.message); if (first) { first = false; rejectReady(error); } });
    current.on('close', () => {
      lines.close();
      if (closed || child !== current) return;
      child = null;
      if (first) { first = false; rejectReady(new Error('PipeWire monitor exited before its initial snapshot')); }
      retry = setTimeout(start, 1000);
    });
  }
  start();
  return { ready, close() { closed = true; clearTimeout(retry); if (child) child.kill('SIGTERM'); } };
}

function nativeFormat(camera) {
  const alternatives = (value, valid) => {
    if (valid(value)) return [value];
    if (!value || typeof value !== 'object') return [];
    return Object.values(value).flatMap(item => alternatives(item, valid));
  };
  const modes = [];
  for (const format of (camera.info.params || {}).EnumFormat || []) {
    if (format.mediaType !== 'video' || !['raw', 'mjpg'].includes(format.mediaSubtype)) continue;
    const sizes = alternatives(format.size, size => size && Number.isInteger(size.width) &&
      Number.isInteger(size.height) && size.width > 0 && size.height > 0);
    const rates = alternatives(format.framerate, rate => rate && Number.isInteger(rate.num) &&
      Number.isInteger(rate.denom) && rate.num > 0 && rate.denom > 0);
    for (const size of sizes) for (const rate of rates) {
      const frameBytes = Math.ceil(size.width * 3 / 4) * 4 * size.height;
      const interval = Math.round(10000000 * rate.denom / rate.num);
      if (!Number.isSafeInteger(frameBytes) || frameBytes > 256 * 1024 * 1024 ||
          rate.num > 1000000 || rate.denom > 1000000 || interval < 1 || interval > 0x7fffffff) continue;
      const caps = format.mediaSubtype === 'mjpg' ? 'image/jpeg' : 'video/x-raw';
      // PipeWire supplies complete MJPG frames, so decode without a byte-stream parser.
      modes.push({ width: size.width, height: size.height, frameBytes, num: rate.num, den: rate.denom,
        decoder: format.mediaSubtype === 'mjpg' ? 'jpegdec' : 'identity',
        inputCaps: `${caps},width=${size.width},height=${size.height},framerate=${rate.num}/${rate.denom}` });
    }
  }
  if (!modes.length) throw new Error('PipeWire camera has no supported native video format');
  // Prefer a native call-sized mode; scaling a 4K-only camera still costs 4K decode.
  const bounded = modes.filter(mode => mode.width <= 1280 && mode.height <= 720);
  const candidates = bounded.length ? bounded : modes;
  candidates.sort((a, b) => {
    const rateScore = mode => mode.num / mode.den >= 15 && mode.num / mode.den <= 30 ? 1 : 0;
    return rateScore(b) - rateScore(a) ||
      (bounded.length ? -1 : 1) * (a.width * a.height - b.width * b.height) ||
      Math.abs(a.num / a.den - 30) - Math.abs(b.num / b.den - 30) ||
      (a.decoder === 'identity' ? -1 : 0) - (b.decoder === 'identity' ? -1 : 0);
  });
  const mode = candidates[0];
  const scale = Math.min(1, 1280 / mode.width, 720 / mode.height);
  const width = scale === 1 ? mode.width : Math.max(2, Math.floor(mode.width * scale / 2) * 2);
  const height = scale === 1 ? mode.height : Math.max(2, Math.floor(mode.height * scale / 2) * 2);
  const capped = mode.num / mode.den > 30;
  return { ...mode, width, height, frameBytes: Math.ceil(width * 3 / 4) * 4 * height,
    num: capped ? 30 : mode.num, den: capped ? 1 : mode.den,
    outputCaps: `video/x-raw,format=BGR,width=${width},height=${height},framerate=${capped ? '30/1' : `${mode.num}/${mode.den}`}` };
}

function startCameraBridge(options = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const devices = [];
  const indices = new Map();
  let nextIndex = 0x40000000, notification = null, initialized = false, fingerprint = null;
  let closed = false;
  const log = options.log || (message => console.error('[zcall-camera] ' + message));
  function createCapture(camera, format) {
    const clients = new Set();
    let source = null, pending = null, pendingBytes = 0, starting = false, retired = false;
    const stopSource = () => {
      if (source) source.kill('SIGTERM');
      source = null;
      pending = null;
      pendingBytes = 0;
    };
    async function startSource(software = options.softwareDecode === true) {
      if (source || starting || closed || retired) return;
      starting = true;
      try {
        const gst = nativeExecutable('gst-launch-1.0');
        if (!camera || !format) throw new Error('No native PipeWire camera format is available');
        if (closed || retired || !clients.size) return;
        const env = { ...process.env };
        delete env.LD_PRELOAD;
        let decoder = format.decoder;
        if (decoder === 'jpegdec' && !software) {
          // Factory registration depends on the driver; runtime failures retry jpegdec.
          decoder = ['vajpegdec', 'vaapijpegdec', 'nvjpegdec', 'qsvjpegdec', 'v4l2jpegdec'].find(name =>
            spawnSync('gst-inspect-1.0', ['--exists', name], { env, timeout: 3000, stdio: 'ignore' }).status === 0) || decoder;
        }
        const hardware = decoder !== 'jpegdec' && decoder !== 'identity';
        const args = ['-q', 'pipewiresrc', 'target-object=' + camera.info.props['node.name'], 'always-copy=true',
          '!', format.inputCaps, '!', 'queue', 'max-size-buffers=1', 'max-size-bytes=0',
          'max-size-time=0', 'leaky=downstream', '!', decoder,
          '!', 'videoconvertscale', '!', 'videorate', 'drop-only=true',
          '!', format.outputCaps,
          '!', 'videoflip', 'method=vertical-flip', '!', 'fdsink', 'fd=1', 'sync=false'];
        pending = Buffer.allocUnsafe(format.frameBytes);
        pendingBytes = 0;
        source = spawn(gst, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const child = source;
        log(`64-bit PipeWire capture: ${camera.info.props['node.description']} ${format.width}x${format.height} ${format.num}/${format.den} fps (${decoder})`);
        child.stdout.on('data', chunk => {
          if (source !== child) return;
          let offset = 0;
          while (offset < chunk.length) {
            const length = Math.min(format.frameBytes - pendingBytes, chunk.length - offset);
            chunk.copy(pending, pendingBytes, offset, offset + length);
            pendingBytes += length;
            offset += length;
            if (pendingBytes === format.frameBytes) {
              for (const client of clients) {
                if (!client.cameraWriting && !client.destroyed) {
                  client.cameraWriting = true;
                  client.write(pending, () => { client.cameraWriting = false; });
                }
              }
              // socket.write keeps this buffer until sent; never overwrite it.
              pending = Buffer.allocUnsafe(format.frameBytes);
              pendingBytes = 0;
            }
          }
        });
        child.stderr.on('data', chunk => log(chunk.toString().trim().slice(0, 1000)));
        child.on('error', error => { log(error.message); for (const client of clients) client.destroy(); });
        child.on('exit', (code, signal) => {
          if (source !== child) return;
          source = null; pending = null; pendingBytes = 0;
          log('capture stopped: ' + (signal || code));
          if (hardware && code !== 0 && !closed && clients.size) {
            log('hardware camera decode failed; retrying with jpegdec (CPU)');
            startSource(true);
            return;
          }
          for (const client of clients) client.destroy();
        });
      } catch (error) {
        log(error.message);
        for (const client of clients) client.destroy();
      } finally { starting = false; }
    }
    return { camera, format, clients, startSource, stopSource, close() {
      retired = true;
      for (const client of clients) client.destroy();
      stopSource();
    } };
  }
  const server = net.createServer(socket => {
    let capture = null;
    let handshake = Buffer.alloc(0), authenticated = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', data => {
      if (authenticated) return socket.destroy();
      if (handshake.length + data.length > 128) return socket.destroy();
      handshake = Buffer.concat([handshake, data]);
      const newline = handshake.indexOf(10);
      if (newline < 0) return;
      if (handshake.length !== newline + 1 || newline < token.length ||
          !crypto.timingSafeEqual(handshake.subarray(0, token.length), Buffer.from(token))) return socket.destroy();
      const suffix = handshake.subarray(token.length, newline).toString('utf8');
      if (suffix && !/^ [0-9]{1,10}$/.test(suffix)) return socket.destroy();
      capture = suffix ? devices.find(device => device.index === Number(suffix.slice(1))) : devices[0];
      if (!capture) return socket.destroy();
      authenticated = true;
      socket.setTimeout(0);
      const { format } = capture;
      const header = Buffer.alloc(24);
      header.write('ZCA2'); header.writeUInt32LE(format.width, 4); header.writeUInt32LE(format.height, 8);
      header.writeUInt32LE(format.frameBytes, 12);
      header.writeUInt32LE(format.num, 16); header.writeUInt32LE(format.den, 20);
      socket.write(header);
      capture.clients.add(socket);
      capture.startSource();
    });
    socket.on('close', () => {
      if (!capture) return;
      capture.clients.delete(socket);
      if (!capture.clients.size) capture.stopSource();
    });
  });
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, token }));
  });
  const snapshot = () => devices.map(device => ({ index: device.index,
    name: device.camera.info.props['node.description'] || device.camera.info.props['node.name'], format: device.format }));
  const monitor = watchCameras(cameras => {
    if (closed) return;
    const previous = new Map(devices.map(device => [device.camera.info.props['node.name'], device]));
    const updated = [];
    for (const camera of cameras) {
      const name = camera.info.props['node.name'];
      if (!name || updated.some(device => device.camera.info.props['node.name'] === name)) continue;
      const existing = previous.get(name);
      let format;
      try { format = nativeFormat(camera); }
      catch (error) { if (existing) format = existing.format; else { log(error.message); continue; } }
      if (existing && JSON.stringify(existing.format) === JSON.stringify(format)) {
        existing.camera = camera; updated.push(existing); previous.delete(name);
      } else {
        if (!indices.has(name)) indices.set(name, nextIndex++);
        updated.push({ ...createCapture(camera, format), index: indices.get(name) });
      }
    }
    for (const device of previous.values()) device.close();
    devices.splice(0, devices.length, ...updated);
    const current = JSON.stringify(snapshot());
    if (current !== fingerprint) {
      fingerprint = current;
      if (initialized && options.onChange) {
        clearTimeout(notification);
        notification = setTimeout(() => { if (!closed) options.onChange(snapshot()); }, 150);
      }
    }
  }, log);
  const ready = Promise.all([listening, monitor.ready.catch(error => log(error.message))])
    .then(([endpoint]) => { initialized = true; return { ...endpoint, format: devices[0] ? devices[0].format : null, cameras: snapshot() }; });
  return { ready, close() {
    closed = true; clearTimeout(notification); monitor.close();
    for (const device of devices) device.close();
    server.close();
  } };
}

module.exports = { startCameraBridge };
