const { app, BrowserWindow, Menu, Tray, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

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

  // Create tray icon
  const iconPath = getIconPath();
  
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

bootstrap();
