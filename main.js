const { app, BrowserWindow, powerSaveBlocker } = require('electron');
const path = require('path');

// RAM & CPU Optimizations
app.commandLine.appendSwitch('js-flags', '--optimize_for_size --max_old_space_size=256');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-site-isolation-trials'); // Significantly lowers RAM usage

let win;
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit(); 
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      const filePath = commandLine.find(arg => arg.endsWith('.mp3'));
      if (filePath) win.webContents.send('open-external-file', filePath);
    }
  });

  app.whenReady().then(() => {
    win = new BrowserWindow({
      width: 1250, height: 850, autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true, contextIsolation: false, webSecurity: false, backgroundThrottling: false
      }
    });
    // --- AI WASM PERMISSION START ---
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob: 'wasm-unsafe-eval'; object-src 'none';"]
        }
      });
    });
    // --- AI WASM PERMISSION END ---
    win.loadFile('index.html');
    powerSaveBlocker.start('prevent-app-suspension'); 
    
    const filePath = process.argv.find(arg => arg.endsWith('.mp3'));
    if (filePath) win.webContents.once('did-finish-load', () => win.webContents.send('open-external-file', filePath));
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
