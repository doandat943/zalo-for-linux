const { app, BrowserWindow, Menu, Tray, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

let tray = null;
let mainWindow = null;
let isAppQuitting = false;

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
    // Set mainWindow only once (first window created)
    if (!mainWindow) {
      mainWindow = win;

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
          {
            label: 'Toggle DevTools',
            click: () => {
              try {
                const focused = BrowserWindow.getFocusedWindow() || mainWindow;
                if (focused && focused.webContents) {
                  if (focused.webContents.isDevToolsOpened()) focused.webContents.closeDevTools();
                  else focused.webContents.openDevTools({ mode: 'detach' });
                }
              } catch (e) { console.error('Toggle DevTools failed', e); }
            }
          },
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

    // Handle close to tray for all windows
    win.on('close', (event) => {
      if (!isAppQuitting && tray) {
        event.preventDefault();
        win.hide();
      }
    });
  } catch (e) {
    console.log('Error in browser-window-created:', e);
  }
});

app.once('ready', () => {
  try { Menu.setApplicationMenu(null); } catch (_) {}

  // Create tray icon - handle different environments
  let iconPath = null;
  
  // Check if we're running in a packaged app (AppImage)
  const isPackaged = app.isPackaged;
  
  if (isPackaged) {
    // In packaged app, icon is relative to AppImage mount point (process.cwd() is already in app/)
    iconPath = path.join(process.cwd(), 'pc-dist', 'favicon-512x512.png');
  } else {
    // In development, use the original path
    iconPath = path.join(__dirname, 'app', 'pc-dist', 'favicon-512x512.png');
  }
  
  if (iconPath && fs.existsSync(iconPath)) {
    try {
      tray = new Tray(iconPath);
      tray.setToolTip('Zalo');
      
      // Make tray icon clickable to show window
      tray.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
      // Register global shortcut for toggling DevTools
      try {
        globalShortcut.register('CommandOrControl+Shift+I', () => {
          try {
            const focused = BrowserWindow.getFocusedWindow() || mainWindow;
            if (focused && focused.webContents) {
              if (focused.webContents.isDevToolsOpened()) focused.webContents.closeDevTools();
              else focused.webContents.openDevTools({ mode: 'detach' });
            }
          } catch (err) { console.error('globalShortcut toggle failed', err); }
        });
      } catch (e) { console.error('globalShortcut register failed', e); }
    } catch (error) {
      console.error('Failed to create tray icon:', error);
    }
  }

  // Check for updates and perform in-place replacement
  const runUpdateCheck = () => {
    if (isPackaged && typeof process.env.APPIMAGE === 'string') {
      try {
      const https = require('https');
      const fs = require('fs');
      
      const currentAppImagePath = process.env.APPIMAGE;
      
      // Early cleanup: If there's a .old file left from a previous update, delete it.
      const oldAppImagePath = currentAppImagePath + '.old';
      if (fs.existsSync(oldAppImagePath)) {
        try { fs.unlinkSync(oldAppImagePath); console.log('[Updater] Cleaned up old AppImage.'); }
        catch (e) { console.error('[Updater] Failed to delete old AppImage', e); }
      }

      const buildInfoPath = path.join(process.cwd(), 'pc-dist', 'build-info.json');
      if (fs.existsSync(buildInfoPath)) {
        const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
        console.log('[Updater] Local build info:', buildInfo);
        
        // Helper to download file with redirect support
        const downloadFile = (url, destPath) => {
          return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(destPath);
            const request = https.get(url, (response) => {
              // Handle redirects
              if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307) {
                file.close();
                return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
              }
              if (response.statusCode !== 200) {
                file.close();
                fs.unlink(destPath, () => {});
                return reject(new Error(`Failed to download, status code: ${response.statusCode}`));
              }
              response.pipe(file);
              file.on('finish', () => {
                file.close(() => resolve());
              });
            }).on('error', (err) => {
              file.close();
              fs.unlink(destPath, () => {});
              reject(err);
            });
            // Minimal timeout logic to avoid hanging indefinitely if dead connection
            request.on('timeout', () => {
              request.destroy();
              reject(new Error('Download timeout'));
            });
          });
        };

        // Fetch latest release from GitHub
        const options = {
          hostname: 'api.github.com',
          path: '/repos/doandat943/zalo-for-linux/releases/latest',
          method: 'GET',
          headers: {
            'User-Agent': 'Zalo-Linux-App'
          }
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              if (res.statusCode !== 200) return bootstrap();
              const release = JSON.parse(data);
              
              const isZaDark = !!buildInfo.zadarkVersion;
              const asset = release.assets.find(a => 
                a.name.endsWith('.AppImage') && 
                (isZaDark ? a.name.includes('+ZaDark') : !a.name.includes('+ZaDark'))
              );
              
              if (asset && asset.browser_download_url) {
                // Parse asset name to extract all version components
                // Formats:
                //   Zalo-26.3.20-d1a93ca.AppImage
                //   Zalo-26.3.20+ZaDark-26.1.1-d1a93ca.AppImage
                const nameNoExt = asset.name.replace('.AppImage', '');
                const zadarkMatch = nameNoExt.match(/^Zalo-(.+?)\+ZaDark-(.+?)-([a-f0-9]+)$/);
                const originalMatch = nameNoExt.match(/^Zalo-(.+?)-([a-f0-9]+)$/);
                
                let remoteZaloVersion, remoteZadarkVersion, remoteCommit;
                if (zadarkMatch) {
                  [, remoteZaloVersion, remoteZadarkVersion, remoteCommit] = zadarkMatch;
                } else if (originalMatch) {
                  [, remoteZaloVersion, remoteCommit] = originalMatch;
                }
                
                const needsUpdate = remoteCommit && (
                  remoteCommit !== buildInfo.commit ||
                  remoteZaloVersion !== buildInfo.version ||
                  // Only compare zadarkVersion when both sides have it (ZaDark variant only)
                  (buildInfo.zadarkVersion && remoteZadarkVersion &&
                    remoteZadarkVersion !== buildInfo.zadarkVersion)
                );
                
                if (needsUpdate) {
                  console.log(`[Updater] Update found! Local: Zalo ${buildInfo.version}${buildInfo.zadarkVersion ? '+ZaDark-'+buildInfo.zadarkVersion : ''} @${buildInfo.commit} → Remote: Zalo ${remoteZaloVersion}${remoteZadarkVersion ? '+ZaDark-'+remoteZadarkVersion : ''} @${remoteCommit}`);

                  
                  const newAppImagePath = currentAppImagePath + '.new';
                  
                  // Helper to do the final swap and relaunch
                  const doSwapAndRelaunch = (updateWin) => {
                    try {
                      isAppQuitting = true;
                      if (updateWin && !updateWin.isDestroyed()) {
                        updateWin.webContents.send('download-done');
                      }
                      fs.renameSync(currentAppImagePath, oldAppImagePath);
                      fs.renameSync(newAppImagePath, currentAppImagePath);
                      
                      console.log('[Updater] Swap complete. Relaunching...');
                      const { spawn } = require('child_process');
                      const env = { ...process.env };
                      delete env.APPIMAGE;
                      delete env.APPDIR;
                      delete env.OWD;
                      spawn(currentAppImagePath, process.argv.slice(1), {
                        detached: true,
                        stdio: 'ignore',
                        env: env
                      }).unref();
                      setTimeout(() => app.exit(0), 500);
                    } catch (swapErr) {
                      console.error('[Updater] Failed to apply update:', swapErr);
                      // Send error to UI
                      if (updateWin && !updateWin.isDestroyed()) {
                        updateWin.webContents.send('update-error', 'Không thể cài đè file mới. Có thể do thiếu quyền ghi trên thư mục hiện tại.');
                      }
                      if (!fs.existsSync(currentAppImagePath) && fs.existsSync(oldAppImagePath)) {
                        fs.renameSync(oldAppImagePath, currentAppImagePath);
                      }
                    }
                  };

                  // Helper to download with progress reporting
                  const downloadFileWithProgress = (url, destPath, onProgress) => {
                    return new Promise((resolve, reject) => {
                      const makeRequest = (reqUrl) => {
                        const file = fs.createWriteStream(destPath);
                        const req = https.get(reqUrl, (response) => {
                          if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307) {
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
                  };

                  // Show update window
                  const { ipcMain } = require('electron');
                  
                  const showUpdateWindow = () => {
                    // update-window.html is copied as extraFile to resources/ outside app.asar
                    // In dev mode fall back to project root (__dirname)
                    const updateWinPath = isPackaged
                      ? path.join(process.resourcesPath, 'update-window.html')
                      : path.join(__dirname, 'update-window.html');
                    
                    const updateWinOptions = {
                      width: 380,
                      height: 500,
                      resizable: false,
                      minimizable: false,
                      maximizable: false,
                      frame: true,
                      title: 'Zalo',
                      icon: path.join(process.cwd(), 'pc-dist', 'favicon-512x512.png'),
                      center: true,
                      alwaysOnTop: true,
                      webPreferences: {
                        nodeIntegration: true,
                        contextIsolation: false
                      }
                    };

                    const updateWin = new BrowserWindow(updateWinOptions);

                    updateWin.once('closed', bootstrap);

                    updateWin.loadFile(updateWinPath);
                    updateWin.setMenuBarVisibility(false);
                    if (updateWin.removeMenu) updateWin.removeMenu();

                    updateWin.webContents.once('did-finish-load', () => {
                      const logoPath = path.join(process.cwd(), 'pc-dist', 'assets', 'logo-new.146dfa01c78183631d33b77999a18288.svg');
                      updateWin.webContents.send('update-info', {
                        version: release.tag_name,
                        logoPath: fs.existsSync(logoPath) ? logoPath : null,
                        localVersion: buildInfo.version,
                        localZadark: buildInfo.zadarkVersion,
                        localCommit: buildInfo.commit,
                        remoteVersion: remoteZaloVersion,
                        remoteZadark: remoteZadarkVersion,
                        remoteCommit: remoteCommit
                      });
                    });

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
                          doSwapAndRelaunch(updateWin);
                        })
                        .catch(err => {
                          console.error('[Updater] Download error:', err);
                          if (!updateWin.isDestroyed()) {
                            updateWin.webContents.send('update-error', `Không thể tải file mới: ${err.message}`);
                          }
                        });
                    });
                  };

                  showUpdateWindow();
                } else {
                  console.log('[Updater] You are using the latest version.');
                  bootstrap();
                }
              }
            } catch (e) {
              console.error('[Updater] Error parsing github response', e);
              bootstrap();
            }
          });
        });
        
        req.on('error', (e) => {
          console.error('[Updater] Network error:', e);
          bootstrap();
        });
        req.setTimeout(5000, () => {
          console.error('[Updater] Timeout');
          req.destroy();
          bootstrap();
        });
        req.end();
        return; // Early return to wait for check to finish
      } else {
        console.warn('[Updater] build-info.json not found');
        bootstrap();
      }
    } catch (e) {
      console.error('[Updater] Initialization failed:', e);
      bootstrap();
    }
  } else {
    bootstrap();
  }
};

  runUpdateCheck();
});

// Skip normal Electron app setup and go straight to Zalo
function bootstrap() {
  // Check if extracted app exists
  // Try development path first, then production path
  const devPath = path.join(__dirname, 'app');
  const prodPath = path.join(path.dirname(process.execPath), 'app');
  
  let appPath = fs.existsSync(devPath) ? devPath : prodPath;
  const bootstrapPath = path.join(appPath, 'bootstrap.js');

  if (fs.existsSync(bootstrapPath)) {
    console.log('Loading Zalo bootstrap from:', bootstrapPath);
    
    // Set the working directory to the app directory for Zalo
    process.chdir(appPath);
    
    // Let Zalo take full control
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

