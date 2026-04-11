const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Set AppUserModelId for better Linux/Windows taskbar integration
const APP_ID = 'com.zalo.linux';
if (app.setAppUserModelId) {
  app.setAppUserModelId(APP_ID);
}

// Get global icon path for consistent use
// In packaged app, icon is in extraResources (outside asar), accessible via process.resourcesPath
// In development, use __dirname
const getIconPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', 'icons', 'zalo.png');
  }
  return path.join(__dirname, 'assets', 'icons', 'zalo.png');
};

let tray = null;
let mainWindow = null;
let isAppQuitting = false;

const isPackaged = app.isPackaged;

// Resolve app directory path once (dev: __dirname/app, prod: next to executable)
const appDir = fs.existsSync(path.join(__dirname, 'app'))
  ? path.join(__dirname, 'app')
  : path.join(path.dirname(process.execPath), 'app');

// Shared helper: toggle DevTools on focused or main window
function toggleDevTools() {
  try {
    const focused = BrowserWindow.getFocusedWindow() || mainWindow;
    if (focused && focused.webContents) {
      if (focused.webContents.isDevToolsOpened()) focused.webContents.closeDevTools();
      else focused.webContents.openDevTools({ mode: 'detach' });
    }
  } catch (e) { console.error('Toggle DevTools failed', e); }
}

app.on('before-quit', () => {
  isAppQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  try { globalShortcut.unregisterAll(); } catch (_) {}
});

// Hide native menu bar but keep title bar
app.on('browser-window-created', (_evt, win) => {
  try {
    // Set mainWindow only once (first window created by Zalo, not updateWin)
    if (!mainWindow) {
      mainWindow = win;

      // Ensure window has the correct icon
      // Use a separate try-catch so any icon failure never prevents
      // the close handler (hide-to-tray) from being registered below.
      try {
        const iconPath = getIconPath();
        if (fs.existsSync(iconPath)) {
          win.setIcon(iconPath);
        }
      } catch (iconErr) {
        console.error('Failed to set window icon:', iconErr);
      }

      // Set up tray context menu
      if (tray) {
        const contextMenu = Menu.buildFromTemplate([
          {
            label: 'Show',
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
                mainWindow.focus();
              }
            }
          },
          {
            label: 'Hide',
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.hide();
              }
            }
          },
          { label: 'Toggle DevTools', click: toggleDevTools },
          {
            label: 'Quit',
            click: () => {
              isAppQuitting = true;
              if (tray) {
                tray.destroy();
                tray = null;
              }
              app.quit();
            }
          }
        ]);
        tray.setContextMenu(contextMenu);
      }
    }

    // Hide menu bar (Edit/View/Window) but keep title bar with min/max/close buttons
    win.setMenuBarVisibility(false);
    if (win.removeMenu) win.removeMenu();
    win.autoHideMenuBar = true;

    console.log('Window created - menu bar hidden, title bar should be visible');

    // Handle close to tray for Zalo windows only
    if (!win.isUpdater) {
      win.on('close', (event) => {
        if (!isAppQuitting && tray) {
          event.preventDefault();
          win.hide();
        }
      });
    }
  } catch (e) {
    console.log('Error in browser-window-created:', e);
  }
});

// --- Updater helpers ---

function isRedirect(code) {
  return code === 301 || code === 302 || code === 303 || code === 307;
}

function downloadFileWithProgress(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const makeRequest = (reqUrl) => {
      const file = fs.createWriteStream(destPath);
      const req = https.get(reqUrl, (response) => {
        if (isRedirect(response.statusCode)) {
          file.close();
          return makeRequest(response.headers.location);
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        const total = parseInt(response.headers['content-length'] || '0', 10);
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0 && onProgress) onProgress((received / total) * 100);
        });
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', (err) => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
      req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    };
    makeRequest(url);
  });
}

function parseAssetName(name) {
  const nameNoExt = name.replace('.AppImage', '');
  const zadarkMatch = nameNoExt.match(/^Zalo-(.+?)\+ZaDark-(.+?)-([a-f0-9]+)$/);
  if (zadarkMatch) {
    return { zaloVersion: zadarkMatch[1], zadarkVersion: zadarkMatch[2], commit: zadarkMatch[3] };
  }
  const originalMatch = nameNoExt.match(/^Zalo-(.+?)-([a-f0-9]+)$/);
  if (originalMatch) {
    return { zaloVersion: originalMatch[1], zadarkVersion: null, commit: originalMatch[2] };
  }
  return null;
}

function doSwapAndRelaunch(updateWin, currentPath, oldPath, newPath) {
  try {
    isAppQuitting = true;
    if (updateWin && !updateWin.isDestroyed()) {
      updateWin.webContents.send('download-done');
    }
    fs.renameSync(currentPath, oldPath);
    fs.renameSync(newPath, currentPath);

    console.log('[Updater] Swap complete. Relaunching...');
    const { spawn } = require('child_process');
    const env = { ...process.env };
    delete env.APPIMAGE;
    delete env.APPDIR;
    delete env.OWD;
    spawn(currentPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      env
    }).unref();
    setTimeout(() => app.exit(0), 500);
  } catch (swapErr) {
    console.error('[Updater] Failed to apply update:', swapErr);
    if (updateWin && !updateWin.isDestroyed()) {
      updateWin.webContents.send('update-error', 'Không thể cài đè file mới. Có thể do thiếu quyền ghi trên thư mục hiện tại.');
    }
    if (!fs.existsSync(currentPath) && fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, currentPath);
    }
  }
}

function showUpdateWindow(release, asset, remoteInfo, buildInfo, currentAppImagePath) {
  const updateWinPath = isPackaged
    ? path.join(process.resourcesPath, 'update-window.html')
    : path.join(__dirname, 'update-window.html');

  const updateWin = new BrowserWindow({
    width: 380,
    height: 500,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: true,
    title: 'Zalo',
    icon: path.join(appDir, 'pc-dist', 'favicon-512x512.png'),
    center: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  updateWin.loadFile(updateWinPath);
  updateWin.setMenuBarVisibility(false);
  if (updateWin.removeMenu) updateWin.removeMenu();

  updateWin.webContents.once('did-finish-load', () => {
    const logoPath = path.join(appDir, 'pc-dist', 'assets', 'logo-new.146dfa01c78183631d33b77999a18288.svg');
    updateWin.webContents.send('update-info', {
      version: release.tag_name,
      logoPath: fs.existsSync(logoPath) ? logoPath : null,
      localVersion: buildInfo.version,
      localZadark: buildInfo.zadarkVersion,
      localCommit: buildInfo.commit,
      remoteVersion: remoteInfo.zaloVersion,
      remoteZadark: remoteInfo.zadarkVersion,
      remoteCommit: remoteInfo.commit
    });
  });

  const newAppImagePath = currentAppImagePath + '.new';
  const oldAppImagePath = currentAppImagePath + '.old';

  ipcMain.removeAllListeners('updater-download-clicked');
  ipcMain.on('updater-download-clicked', () => {
    updateWin.removeAllListeners('closed');
    console.log(`[Updater] User clicked download. Fetching ${asset.browser_download_url}...`);
    downloadFileWithProgress(
      asset.browser_download_url,
      newAppImagePath,
      (percent) => {
        if (!updateWin.isDestroyed()) {
          updateWin.webContents.send('download-progress', percent);
        }
      }
    )
      .then(() => {
        console.log('[Updater] Download finished. Applying permissions...');
        fs.chmodSync(newAppImagePath, 0o755);
        doSwapAndRelaunch(updateWin, currentAppImagePath, oldAppImagePath, newAppImagePath);
      })
      .catch(err => {
        console.error('[Updater] Download error:', err);
        if (!updateWin.isDestroyed()) {
          updateWin.webContents.send('update-error', `Không thể tải file mới: ${err.message}`);
        }
      });
  });
}

// --- Main startup ---

app.once('ready', () => {
  try { Menu.setApplicationMenu(null); } catch (_) {}

  // Create tray icon
  const iconPath = getIconPath();
  
  if (iconPath && fs.existsSync(iconPath)) {
    try {
      tray = new Tray(iconPath);
      tray.setToolTip('Zalo');

      tray.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      });

      try {
        globalShortcut.register('CommandOrControl+Shift+I', toggleDevTools);
      } catch (e) { console.error('globalShortcut register failed', e); }
    } catch (error) {
      console.error('Failed to create tray icon:', error);
    }
  }

  // Check for updates after Zalo starts
  checkForUpdates();
});

function checkForUpdates() {
  if (!isPackaged || typeof process.env.APPIMAGE !== 'string') return;

  try {
    const currentAppImagePath = process.env.APPIMAGE;

    // Early cleanup: remove leftover .old file from a previous update
    const oldAppImagePath = currentAppImagePath + '.old';
    if (fs.existsSync(oldAppImagePath)) {
      try { fs.unlinkSync(oldAppImagePath); console.log('[Updater] Cleaned up old AppImage.'); }
      catch (e) { console.error('[Updater] Failed to delete old AppImage', e); }
    }

    const buildInfoPath = path.join(appDir, 'pc-dist', 'build-info.json');
    if (!fs.existsSync(buildInfoPath)) {
      console.warn('[Updater] build-info.json not found');
      return;
    }

    const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    console.log('[Updater] Local build info:', buildInfo);

    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/doandat943/zalo-for-linux/releases/latest',
      method: 'GET',
      headers: { 'User-Agent': 'Zalo-Linux-App' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return;
          const release = JSON.parse(data);

          const isZaDark = !!buildInfo.zadarkVersion;
          const asset = release.assets.find(a =>
            a.name.endsWith('.AppImage') &&
            (isZaDark ? a.name.includes('+ZaDark') : !a.name.includes('+ZaDark'))
          );

          if (!asset || !asset.browser_download_url) return;

          const remoteInfo = parseAssetName(asset.name);
          if (!remoteInfo || !remoteInfo.commit) return;

          const needsUpdate =
            remoteInfo.commit !== buildInfo.commit ||
            remoteInfo.zaloVersion !== buildInfo.version ||
            (buildInfo.zadarkVersion && remoteInfo.zadarkVersion &&
              remoteInfo.zadarkVersion !== buildInfo.zadarkVersion);

          if (needsUpdate) {
            console.log(`[Updater] Update found! Local: Zalo ${buildInfo.version}${buildInfo.zadarkVersion ? '+ZaDark-' + buildInfo.zadarkVersion : ''} @${buildInfo.commit} → Remote: Zalo ${remoteInfo.zaloVersion}${remoteInfo.zadarkVersion ? '+ZaDark-' + remoteInfo.zadarkVersion : ''} @${remoteInfo.commit}`);
            showUpdateWindow(release, asset, remoteInfo, buildInfo, currentAppImagePath);
          } else {
            console.log('[Updater] You are using the latest version.');
          }
        } catch (e) {
          console.error('[Updater] Error parsing github response', e);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Updater] Network error:', e);
    });
    req.setTimeout(5000, () => {
      console.error('[Updater] Timeout');
      req.destroy();
    });
    req.end();
  } catch (e) {
    console.error('[Updater] Initialization failed:', e);
  }
}

// Load Zalo's bootstrap.js to hand off control
// IMPORTANT: Must be called synchronously at module level (before 'ready' event fires)
// so Zalo can register its own 'ready' handler in time
function bootstrap() {
  const bootstrapPath = path.join(appDir, 'bootstrap.js');

  if (fs.existsSync(bootstrapPath)) {
    console.log('Loading Zalo bootstrap from:', bootstrapPath);
    process.chdir(appDir);

    try {
      require(bootstrapPath);
      console.log('Zalo bootstrap loaded - Zalo should handle everything from here');
    } catch (error) {
      console.error('Error loading Zalo:', error);
    }
  } else {
    console.error('Zalo bootstrap.js not found at:', bootstrapPath);
  }
}

// Must run synchronously before 'ready' fires
bootstrap();
