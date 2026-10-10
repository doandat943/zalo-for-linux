/**
 * plugins/zcall/index.js
 *
 * Zalo calls on the native Linux engine (zcall-native/).
 *
 * The patched main process (scripts/patches/patch-zcall-native.js) spawns
 * the engine when a call starts; this plugin
 *   - tells it where the engine is and how to run (environment, below);
 *   - opens the call window's socket (window.js) before the engine starts;
 *   - checks the system packages on the first call and says how to install
 *     what is missing (global.__zcallPrepare, awaited by the patch);
 *   - ends a call in progress when Zalo quits.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const callWindow = require('./window');

/** A file of zcall-native/: next to the executable when packaged, else in the checkout. */
function enginePath(...parts) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'zcall-native', ...parts),
    path.join(__dirname, '..', '..', 'zcall-native', ...parts)
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[1];
}

// Zalo's own main-dist/main.js: the engine reads the call transport key from it.
function zaloMainJs() {
  return [
    path.join(path.dirname(process.execPath), 'app', 'main-dist', 'main.js'),
    path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js')
  ].find((p) => fs.existsSync(p));
}

// Processes running this install's engine or its audio-io: an argument is
// exactly one of their scripts (not just a command line mentioning them).
function engineProcesses() {
  const scripts = [enginePath('native-engine', 'zcall-native.js'), enginePath('native-engine', 'audio-io.py')];
  const found = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number)) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (!argv.some((a) => scripts.includes(a))) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); // "pid (comm) state ppid ..."
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      found.push({ pid, ppid });
    } catch (_) { /* exited meanwhile */ }
  }
  return found;
}

// Reparented to init / the systemd user manager: its Zalo is gone.
function isOrphan(ppid) {
  if (ppid === 1) return true;
  try { return fs.readFileSync(`/proc/${ppid}/comm`, 'utf8').trim() === 'systemd'; } catch (_) { return true; }
}

function kill(pid, signal) {
  try { process.kill(pid, signal); } catch (_) { /* gone */ }
}

// --- system packages -------------------------------------------------------

// What the engine's audio side needs: python3, libopus, and parec / pacat
// (pactl for the device menu) or at least arecord / aplay.
const PACKAGES = {
  debian: { cmd: 'sudo apt install', python3: 'python3', opus: 'libopus0', audio: 'pulseaudio-utils' },
  fedora: { cmd: 'sudo dnf install', python3: 'python3', opus: 'opus', audio: 'pulseaudio-utils' },
  arch: { cmd: 'sudo pacman -S', python3: 'python', opus: 'opus', audio: 'libpulse' },
  suse: { cmd: 'sudo zypper install', python3: 'python3', opus: 'libopus0', audio: 'pulseaudio-utils' }
};

function distroFamily() {
  let ids = '';
  try {
    const rel = fs.readFileSync('/etc/os-release', 'utf8');
    ids = [/^ID=(.*)$/m, /^ID_LIKE=(.*)$/m].map((re) => (rel.match(re) || [])[1] || '').join(' ');
  } catch (_) { /* unknown: Debian names */ }
  ids = ids.replace(/"/g, '').toLowerCase();
  if (/\b(fedora|rhel|centos)\b/.test(ids)) return 'fedora';
  if (/\b(arch|manjaro)\b/.test(ids)) return 'arch';
  if (/\b(suse|opensuse)\b/.test(ids)) return 'suse';
  return 'debian';
}

/** The install command for these needs ('python3' / 'opus' / 'audio'). */
function installHint(needs) {
  const d = PACKAGES[distroFamily()];
  return d.cmd + ' ' + needs.map((n) => d[n]).join(' ');
}

let missingCache;

/** The install command for what is missing, or null. Checked once (one python3 run). */
function missingPackages() {
  if (missingCache !== undefined) return missingCache;
  const res = spawnSync('python3', ['-c', [
    'import ctypes, ctypes.util, shutil',
    'try: ctypes.CDLL(ctypes.util.find_library("opus") or "libopus.so.0"); need = []',
    'except OSError: need = ["opus"]',
    'if not (shutil.which("parec") or shutil.which("arecord")): need.append("audio")',
    'print(" ".join(need))'
  ].join('\n')], { encoding: 'utf8', timeout: 10000 });
  const needs = res.error || res.status !== 0
    ? ['python3', 'opus', 'audio']
    : res.stdout.trim().split(/\s+/).filter(Boolean);
  missingCache = needs.length ? installHint(needs) : null;
  return missingCache;
}

function notify(body) {
  const { Notification } = require('electron');
  if (Notification.isSupported()) new Notification({ title: 'Zalo', body }).show();
}

// Awaited by the patched main process right before it spawns the engine;
// a rejection cancels this start and Zalo tries again on the next call.
function prepare() {
  const missing = missingPackages();
  if (!missing) return Promise.resolve();
  notify(`Gọi điện cần thêm gói hệ thống. Cài bằng: ${missing}`);
  return Promise.reject(new Error('calls need system packages: ' + missing));
}

// --- lifecycle -------------------------------------------------------------

/**
 * Before 'ready', after Zalo's bootstrap: on Wayland, screen sharing needs
 * Chromium's PipeWire capture (through the desktop portal); X11 capture
 * only sees XWayland windows. Chromium keeps the last --enable-features, so
 * merge with Zalo's own (JXL).
 */
function configure(app) {
  if (process.env.XDG_SESSION_TYPE !== 'wayland') return;
  const features = app.commandLine.getSwitchValue('enable-features').split(',').filter(Boolean);
  if (!features.includes('WebRTCPipeWireCapturer')) features.push('WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('enable-features', features.join(','));
}

/** At 'ready', before Zalo can start a call. */
function start({ userDataDir }) {
  // Left over from an unclean exit (another running Zalo keeps its own).
  for (const p of engineProcesses()) if (isOrphan(p.ppid)) kill(p.pid, 'SIGKILL');
  callWindow.start();
  Object.assign(process.env, {
    ZCALL_ENGINE_JS: enginePath('native-engine', 'zcall-native.js'),
    ZCALL_MEDIA: 'zrtc',
    ZCALL_SEND_UDP: '1',
    ZCALL_LOG_DIR: userDataDir // the AppImage is read-only
  });
  const mainJs = process.env.ZALO_MAIN_JS || zaloMainJs();
  if (mainJs) process.env.ZALO_MAIN_JS = mainJs;
  global.__zcallPrepare = prepare;
}

/**
 * At 'will-quit'. SIGTERM to our engine: it hangs up a call in progress (the
 * phone learns at once) and exits ~300 ms later; its audio-io follows. The
 * next start SIGKILLs anything left.
 */
function stop() {
  for (const p of engineProcesses()) if (p.ppid === process.pid) kill(p.pid, 'SIGTERM');
  callWindow.stop();
}

module.exports = { configure, start, stop };
