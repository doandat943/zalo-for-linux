'use strict';

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const { spawn, execFile, spawnSync } = require('child_process');

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

function listCameras() {
  return new Promise((resolve, reject) => {
    execFile('pw-dump', [], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const cameras = JSON.parse(stdout).filter(node => node.type === 'PipeWire:Interface:Node' &&
          node.info && node.info.props && node.info.props['media.class'] === 'Video/Source');
        cameras.sort((a, b) => Number(b.info.props['priority.session'] || 0) - Number(a.info.props['priority.session'] || 0));
        resolve(cameras);
      } catch (e) { reject(e); }
    });
  });
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
  modes.sort((a, b) => b.width * b.height - a.width * a.height || b.num / b.den - a.num / a.den);
  if (!modes.length) throw new Error('PipeWire camera has no supported native video format');
  return modes[0];
}

function startCameraBridge(options = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const clients = new Set();
  let camera = null, format = null;
  let source = null, pending = null, pendingBytes = 0, starting = false, closed = false;
  const log = options.log || (message => console.error('[zcall-camera] ' + message));
  const stopSource = () => {
    if (source) source.kill('SIGTERM');
    source = null;
    pending = null;
    pendingBytes = 0;
  };
  async function startSource() {
    if (source || starting || closed) return;
    starting = true;
    try {
      const gst = nativeExecutable('gst-launch-1.0');
      if (!camera || !format) throw new Error('No native PipeWire camera format is available');
      if (closed || !clients.size) return;
      // ponytail: one shared default camera; add a selector when multiple cameras are needed.
      const args = ['-q', 'pipewiresrc', 'target-object=' + camera.info.props['node.name'], 'always-copy=true',
        '!', format.inputCaps, '!', format.decoder, '!', 'videoconvert',
        '!', 'video/x-raw,format=BGR',
        '!', 'videoflip', 'method=vertical-flip', '!', 'fdsink', 'fd=1', 'sync=false'];
      const env = { ...process.env };
      delete env.LD_PRELOAD;
      pending = Buffer.allocUnsafe(format.frameBytes);
      pendingBytes = 0;
      source = spawn(gst, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const child = source;
      log(`64-bit PipeWire capture: ${camera.info.props['node.description']} ${format.width}x${format.height} ${format.num}/${format.den} fps`);
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
              if (client.writableLength < format.frameBytes * 2) client.write(pending);
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
        for (const client of clients) client.destroy();
      });
    } catch (error) {
      log(error.message);
      for (const client of clients) client.destroy();
    } finally { starting = false; }
  }
  const server = net.createServer(socket => {
    let handshake = Buffer.alloc(0), authenticated = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', data => {
      if (authenticated) return socket.destroy();
      if (handshake.length + data.length > 128) return socket.destroy();
      handshake = Buffer.concat([handshake, data]);
      const newline = handshake.indexOf(10);
      if (newline < 0) return;
      if (newline !== token.length || handshake.length !== newline + 1 ||
          !crypto.timingSafeEqual(handshake.subarray(0, newline), Buffer.from(token))) return socket.destroy();
      authenticated = true;
      socket.setTimeout(0);
      if (!format) return socket.destroy();
      const header = Buffer.alloc(24);
      header.write('ZCA2'); header.writeUInt32LE(format.width, 4); header.writeUInt32LE(format.height, 8);
      header.writeUInt32LE(format.frameBytes, 12);
      header.writeUInt32LE(format.num, 16); header.writeUInt32LE(format.den, 20);
      socket.write(header);
      clients.add(socket);
      startSource();
    });
    socket.on('close', () => { clients.delete(socket); if (!clients.size) stopSource(); });
  });
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, token }));
  });
  const ready = Promise.all([listening, listCameras().then(cameras => {
    if (!cameras.length) throw new Error('No PipeWire camera is available');
    camera = cameras[0];
    format = nativeFormat(camera);
  }).catch(error => log(error.message))]).then(([endpoint]) => ({ ...endpoint, format }));
  return { ready, close() { closed = true; for (const client of clients) client.destroy(); stopSource(); server.close(); } };
}

module.exports = { startCameraBridge };
