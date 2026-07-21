'use strict';

const { execFile } = require('child_process');

const DBUS_OBJECT_PATH = '/com/canonical/Unity/LauncherEntry';
const DBUS_SIGNAL = 'com.canonical.Unity.LauncherEntry.Update';

let _app = null;
let _lastCount = 0;
let _gdbusAvailable = null;
let _desktopFiles = null;

function register({ app, ipcMain }) {
  _app = app;

  if (process.platform !== 'linux') return;

  _desktopFiles = getDesktopFiles(app);

  try {
    if (app.setDesktopName) {
      app.setDesktopName('zalo.desktop');
    }
  } catch (_) {}

  ipcMain.on('zalo-notification-badge-count', (_event, rawCount) => {
    setCount(rawCount);
  });

  app.on('browser-window-created', (_event, win) => {
    win.on('page-title-updated', (_event, title) => {
      const count = parseTitleCount(title);
      if (count !== null) setCount(count);
    });
  });

  app.on('before-quit', () => {
    setCount(0);
  });
}

function setCount(rawCount) {
  const count = normalizeCount(rawCount);
  if (count === _lastCount) return;

  _lastCount = count;

  try {
    if (_app && _app.setBadgeCount) {
      _app.setBadgeCount(count);
    }
  } catch (_) {}

  publishUnityBadge(count);
}

function publishUnityBadge(count) {
  if (process.platform !== 'linux') return;
  if (_gdbusAvailable === false) return;

  const visible = count > 0;
  const payload = `{ 'count': <int64 ${count}>, 'count-visible': <${visible ? 'true' : 'false'}> }`;

  getDesktopFiles(_app).forEach((desktopFile) => {
    execFile('gdbus', [
      'emit',
      '--session',
      '--object-path',
      DBUS_OBJECT_PATH,
      '--signal',
      DBUS_SIGNAL,
      `application://${desktopFile}`,
      payload
    ], { timeout: 1000 }, (error) => {
      if (!error) {
        _gdbusAvailable = true;
        return;
      }

      if (error.code === 'ENOENT') {
        _gdbusAvailable = false;
      }
    });
  });
}

function normalizeCount(rawCount) {
  const count = Number.parseInt(rawCount, 10);
  if (!Number.isFinite(count) || count < 1) return 0;
  return Math.min(count, 9999);
}

function getDesktopFiles(app) {
  if (_desktopFiles) return _desktopFiles;

  const names = [
    process.env.ZALO_DESKTOP_FILE,
    process.env.GTK_DESKTOP_FILE,
    process.env.XDG_CURRENT_DESKTOP_FILE,
    getAppImageDesktopFile(),
    app && app.isPackaged ? 'zalo.desktop' : 'electron.desktop',
    'com.zalo.linux.desktop',
    'zalo-for-linux.desktop',
    'Zalo.desktop',
    'zalo.desktop'
  ];

  _desktopFiles = unique(names.map(normalizeDesktopFile).filter(Boolean));
  return _desktopFiles;
}

function getAppImageDesktopFile() {
  if (!process.env.APPIMAGE) return null;

  const appImageName = process.env.APPIMAGE.split('/').pop();
  if (!appImageName) return null;

  return appImageName
    .replace(/\.AppImage$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') + '.desktop';
}

function normalizeDesktopFile(name) {
  if (!name || typeof name !== 'string') return null;

  const trimmed = name.trim();
  if (!trimmed) return null;

  const withoutPrefix = trimmed.replace(/^application:\/\//, '').split('/').pop();
  return withoutPrefix.endsWith('.desktop') ? withoutPrefix : `${withoutPrefix}.desktop`;
}

function unique(values) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function parseTitleCount(title) {
  if (typeof title !== 'string') return null;

  const match = title.match(/^\s*\((\d+)\)/) || title.match(/\b(\d+)\s+(?:tin nhan|message|messages)\b/i);
  if (!match) return null;

  return normalizeCount(match[1]);
}

module.exports = {
  register,
  _private: {
    getDesktopFiles,
    normalizeDesktopFile,
    normalizeCount,
    parseTitleCount
  }
};
