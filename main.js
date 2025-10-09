const { app, BrowserWindow, Menu, Tray } = require('electron');
const path = require('path');
const fs = require('fs');

let tray = null;
let mainWindow = null;

// Hide native menu bar but keep title bar
app.on('browser-window-created', (_evt, win) => {
  try {
    // Set mainWindow only once (first window created)
    if (!mainWindow) {
      mainWindow = win;

      // Set up tray context menu
      if (tray) {
        const contextMenu = Menu.buildFromTemplate([
          { label: 'Show', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); mainWindow.focus(); } },
          { label: 'Hide', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); } },
          { label: 'Quit', click: () => app.quit() }
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
      if (tray) {
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
  const iconPath = path.join(__dirname, 'app', 'pc-dist', 'favicon-512x512.png');
  if (fs.existsSync(iconPath)) {
    tray = new Tray(iconPath);
    tray.setToolTip('Zalo');
    
    // Make tray icon clickable to show window
    tray.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
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