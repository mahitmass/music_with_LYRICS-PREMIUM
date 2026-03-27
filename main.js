const { app, BrowserWindow, powerSaveBlocker, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

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
        nodeIntegration: true, 
        contextIsolation: false, 
        webSecurity: false, backgroundThrottling: false
      }
    });

    // --- APP SECURITY POLICY ---
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self' file: https: blob: data:; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob: 'wasm-unsafe-eval'; " +
            "style-src 'self' 'unsafe-inline' https:; " + 
            "object-src 'none';"
          ]
        }
      });
    });

    win.loadFile('index.html');
    powerSaveBlocker.start('prevent-app-suspension'); 
    
    // --- GLOBAL MEDIA KEYS (Works in background!) ---
    globalShortcut.register('MediaPlayPause', () => {
      if(win) win.webContents.executeJavaScript('if(typeof togglePlay === "function") togglePlay();');
    });
    globalShortcut.register('MediaNextTrack', () => {
      if(win) win.webContents.executeJavaScript('if(typeof playNext === "function") playNext();');
    });
    globalShortcut.register('MediaPreviousTrack', () => {
      if(win) win.webContents.executeJavaScript('if(typeof playPrev === "function") playPrev();');
    });
    const filePath = process.argv.find(arg => arg.endsWith('.mp3'));
    if (filePath) win.webContents.once('did-finish-load', () => win.webContents.send('open-external-file', filePath));
  });
}
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });