/**
 * plugins/zalux/updater.js
 *
 * Core update-checking and download logic for the Zalux plugin.
 */

'use strict';

const fs    = require('fs');
const https = require('https');
const path  = require('path');

let _appDir        = null;
let _getMainWindow = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function init({ appDir, getMainWindow }) {
  _appDir        = appDir;
  _getMainWindow = getMainWindow;
}

/**
 * Check for updates and call `callback` with a result object.
 *
 * Result shape:
 * {
 *   isAppImage   : boolean,
 *   needsUpdate  : boolean,
 *   buildInfo    : object | null,    — local build-info.json
 *   remoteInfo   : object | null,    — parsed from asset filename
 *   release      : object | null,    — full GitHub release object
 *   asset        : object | null,    — the matching AppImage asset
 *   currentAppImagePath : string | null,
 *   error        : string | null,    — set on network / parse failures
 * }
 *
 * This function NEVER shows dialogs on its own — all UI is handled by index.js.
 *
 * @param {function} callback
 */
function checkUpdates(callback) {
  const { app } = require('electron');
  const isAppImage = app.isPackaged && typeof process.env.APPIMAGE === 'string';
  const currentAppImagePath = isAppImage ? process.env.APPIMAGE : null;

  // Always read local build info if available
  const buildInfoPath = path.join(_appDir, 'pc-dist', 'build-info.json');
  const buildInfo = fs.existsSync(buildInfoPath)
    ? JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
    : null;

  const done = (overrides = {}) => {
    callback({
      isAppImage,
      currentAppImagePath,
      buildInfo,
      needsUpdate: false,
      remoteInfo: null,
      release: null,
      asset: null,
      error: null,
      ...overrides
    });
  };

  // If not AppImage, we can still display version info but cannot update
  if (!isAppImage) return done();

  if (!buildInfo) return done({ error: 'build-info.json not found' });

  const req = https.get(
    'https://api.github.com/repos/doandat943/zalo-for-linux/releases/latest',
    { headers: { 'User-Agent': 'zalo-for-linux-updater' } },
    (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.warn('[Zalux] GitHub API status:', res.statusCode);
            return done({ error: `GitHub API trả về ${res.statusCode}` });
          }

          const release = JSON.parse(data);
          const isZaDark = !!buildInfo.zadarkVersion;
          const asset = release.assets.find(a =>
            a.name.endsWith('.AppImage') &&
            (isZaDark ? a.name.includes('+ZaDark') : !a.name.includes('+ZaDark'))
          );

          if (!asset || !asset.browser_download_url) return done({ release });

          const remoteInfo = _parseAssetName(asset.name);
          if (!remoteInfo || !remoteInfo.commit) return done({ release, asset });

          const needsUpdate =
            remoteInfo.commit !== buildInfo.commit ||
            remoteInfo.zaloVersion !== buildInfo.version ||
            (buildInfo.zadarkVersion && remoteInfo.zadarkVersion &&
              remoteInfo.zadarkVersion !== buildInfo.zadarkVersion);

          done({ needsUpdate, remoteInfo, release, asset });
        } catch (e) {
          console.error('[Zalux] Parse error:', e);
          done({ error: 'Lỗi phân tích phản hồi máy chủ' });
        }
      });
    }
  );

  req.on('error', (e) => {
    console.error('[Zalux] Network error:', e);
    done({ error: 'Lỗi kết nối mạng' });
  });
  
  req.setTimeout(8000, () => {
    console.error('[Zalux] Timeout');
    req.destroy();
    done({ error: 'Kết nối quá hạn' });
  });
  
  req.end();
}

/**
 * Download the new AppImage and swap it in-place, then relaunch.
 * Sends IPC progress events to `versionWin`.
 */
function downloadAndSwap(asset, currentAppImagePath, versionWin) {
  const { app } = require('electron');
  const dir = path.dirname(currentAppImagePath);
  const newAppImagePath = path.join(dir, asset.name);
  const fileStream = fs.createWriteStream(newAppImagePath);

  const downloadFile = (url) => {
    https.get(url, { headers: { 'User-Agent': 'zalo-for-linux-updater' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location);
      }

      if (res.statusCode !== 200) {
        fileStream.close();
        versionWin.webContents.send('download-error', `Lỗi tải về: HTTP ${res.statusCode}`);
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'], 10);
      let downloadedBytes = 0;
      let lastPercent = -1;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const percent = Math.round((downloadedBytes / totalBytes) * 1000) / 10;
        if (Math.round(percent) > lastPercent) {
          versionWin.webContents.send('download-progress', percent);
          lastPercent = Math.round(percent);
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        // Wait for the file to be fully closed before we chmod/spawn
        fileStream.close((closeErr) => {
          if (closeErr) console.error('[Zalux] Stream close error:', closeErr);

          versionWin.webContents.send('download-done');

          try {
            const { spawn } = require('child_process');

            fs.chmodSync(newAppImagePath, '755');

            // On Linux, unlinking a running file is safe:
            // the kernel keeps the inode alive until the process exits.
            // We can then rename the new file to take the original path.
            fs.unlinkSync(currentAppImagePath);
            fs.renameSync(newAppImagePath, currentAppImagePath);

            // Spawn the replaced file at the original path.
            // Clear AppImage env vars so the new process mounts fresh.
            const env = { ...process.env };
            delete env.APPIMAGE;
            delete env.APPDIR;
            delete env.OWD;

            spawn(currentAppImagePath, process.argv.slice(1), {
              detached: true,
              stdio: 'ignore',
              env
            }).unref();

            setTimeout(() => app.exit(0), 500);
          } catch (e) {
            console.error('[Zalux] Relaunch failed:', e);
            try { fs.unlinkSync(newAppImagePath); } catch (_) {}
            versionWin.webContents.send('download-error',
              `Lỗi khởi động: ${e.message || e}`
            );
          }
        });
      });
    }).on('error', (e) => {
      console.error('[Zalux] Download error:', e);
      fileStream.close();
      fs.unlink(newAppImagePath, () => {});
      versionWin.webContents.send('download-error', 'Mất kết nối mạng.');
    });
  };

  downloadFile(asset.browser_download_url);
}

// ---------------------------------------------------------------------------
// Badge helper (called from index.js after check)
// ---------------------------------------------------------------------------

function showBadge(visible) {
  const mainWindow = _getMainWindow ? _getMainWindow() : null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = visible ? 'block' : 'none';
  mainWindow.webContents
    .executeJavaScript(`const b = document.getElementById('zalu-badge'); if (b) b.style.display = '${display}';`)
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _parseAssetName(name) {
  const match = name.match(/Zalo-(.+?)(?:\+ZaDark-(.+?))?-(.+?)\.AppImage$/);
  if (!match) return null;
  return {
    zaloVersion:   match[1],
    zadarkVersion: match[2] || null,
    commit:        match[3]
  };
}

module.exports = {
  init,
  checkUpdates,
  downloadAndSwap,
  showBadge
};
