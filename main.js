const { app, BrowserWindow, powerSaveBlocker, globalShortcut, ipcMain, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { fork } = require('child_process');
const http = require('http');
const ytdlRaw = require('youtube-dl-exec');

// 🔥 ASAR PATH FIX: Redirect Electron to the real unpacked binary folder on the hard drive
let ytBinPath = ytdlRaw.constants.YOUTUBE_DL_PATH;
if (ytBinPath && ytBinPath.includes('app.asar')) {
    ytBinPath = ytBinPath.replace('app.asar', 'app.asar.unpacked');
}
const youtubeDl = ytdlRaw.create(ytBinPath);

app.commandLine.appendSwitch('js-flags', '--optimize_for_size --max_old_space_size=256');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

let win;
const gotTheLock = app.requestSingleInstanceLock();

function downloadAudioToTemp(audioPath) {
  return new Promise((resolve, reject) => {
    const tempFilePath = path.join(app.getPath('temp'), 'lyrics-generation-target.mp4');

    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch (e) {}

    const file = fs.createWriteStream(tempFilePath);
    https.get(audioPath, (response) => {
      if (response.statusCode !== 200) {
        file.close(() => reject(new Error(`Failed to download: ${response.statusCode}`)));
        return;
      }

      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(tempFilePath)));
    }).on('error', (err) => {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
      reject(err);
    });
  });
}

// ==========================================
// --- YT-DLP CACHED STREAM SERVER (CORS SAFE) --
// ==========================================
let ytStreamPort = 0;

function startYTStreamServer() {
    const urlCache = new Map(); // ytId → { url, expiresAt }
    const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
    let activeYtdlpCalls = 0;
    const MAX_CONCURRENT_YTDLP = 2; // Prevents the death spiral

    const server = http.createServer(async (req, res) => {
        const ytId = decodeURIComponent(req.url.slice(1));
        if (!ytId) { res.writeHead(400); res.end(); return; }

        try {
            let audioUrl = null;
            const cached = urlCache.get(ytId);

            // ── 1. CHECK CACHE FIRST ──
            if (cached && cached.expiresAt > Date.now()) {
                audioUrl = cached.url;
            } else {
                // ── 2. CONCURRENCY GUARD ──
                if (activeYtdlpCalls >= MAX_CONCURRENT_YTDLP) {
                    console.warn(`[YT Stream] Too busy, rejecting ${ytId}`);
                    if (!res.headersSent) res.writeHead(503);
                    res.end();
                    return;
                }

                activeYtdlpCalls++;
                try {
                    const rawUrl = await youtubeDl(`https://www.youtube.com/watch?v=${ytId}`, {
                        format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
                        getUrl: true,
                        noWarnings: true,
                        noCheckCertificates: true,
                    });
                    audioUrl = (rawUrl || '').trim().split('\n')[0];
                    if (audioUrl) {
                        urlCache.set(ytId, { url: audioUrl, expiresAt: Date.now() + CACHE_TTL });
                        console.log(`[YT Stream OK] ${ytId} — cached for 4hrs`);
                    }
                } finally {
                    activeYtdlpCalls--;
                }
            }

            if (!audioUrl || !audioUrl.startsWith('http')) throw new Error('No URL returned');

            // ── 3. PROXY THE STREAM (Fixes the CORS Visualizer Bug!) ──
            const urlObj = new URL(audioUrl);
            const lib = urlObj.protocol === 'https:' ? https : http;
            
            const reqHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.youtube.com/',
                'Origin': 'https://www.youtube.com'
            };
            if (req.headers['range']) reqHeaders['Range'] = req.headers['range']; // Allows skipping/seeking

            lib.get({
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                headers: reqHeaders
            }, (proxyRes) => {
                // Attach CORS headers so Web Audio API (Visualizer) doesn't output zeroes
                const resHeaders = {
                    'Content-Type': proxyRes.headers['content-type'] || 'audio/webm',
                    'Access-Control-Allow-Origin': '*', 
                    'Accept-Ranges': 'bytes',
                };
                if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length'];
                if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range'];

                res.writeHead(proxyRes.statusCode, resHeaders);
                proxyRes.pipe(res);
                req.on('close', () => proxyRes.destroy());
            }).on('error', (e) => {
                console.error('[YT Proxy error]', e.message);
                if (!res.headersSent) res.writeHead(500);
                res.end();
            });

        } catch (e) {
            console.error('[YT Stream failed]', e.message);
            if (!res.headersSent) res.writeHead(500);
            res.end();
        }
    });

    server.listen(0, '127.0.0.1', () => {
        ytStreamPort = server.address().port;
        console.log(`[YT Stream Server] port ${ytStreamPort}`);
    });
}

// 🔥 Start it ONLY ONCE
startYTStreamServer();
ipcMain.handle('get-yt-stream-port', () => ytStreamPort);
ipcMain.handle('yt-stream-ready', () => ytStreamPort > 0);


if (!gotTheLock) {
  app.quit(); 
} else {
  app.whenReady().then(async () => {
    // Forces the app to use Cloudflare & Google DNS, ignoring the local Wi-Fi entirely.
    app.configureHostResolver({
      secureDnsMode: 'secure',
      secureDnsServers: [
        'https://dns.google/dns-query'
      ]
    });
    
    // Destroy poisoned cookies for clean anonymous scraping
    const cookiePath = path.join(app.getPath('userData'), 'yt-cookies.json');
    if (fs.existsSync(cookiePath)) {
        try { fs.unlinkSync(cookiePath); } catch(e) {}
    }

    // ── 1. The YT Music Scraper (Moved to backend to stop red header errors) ──
ipcMain.handle('get-yt-playlist', async (event, playlistId) => {
    try {
        const YTMusic = require('ytmusic-api');
        const ytmusic = new YTMusic();
        await ytmusic.initialize();
        return await ytmusic.getPlaylist(playlistId);
    } catch (e) {
        console.warn('ytmusic-api playlist fetch failed:', e.message);
        return null;
    }
});

// ── 2. The Bulletproof yt-dlp Fallback (No API Limits) ──
ipcMain.handle('get-yt-playlist-ytdlp', async (event, playlistId) => {
    try {
        // youtubeDl is declared at top of file with ASAR fix already applied
        const result = await youtubeDl(
            `https://www.youtube.com/playlist?list=${playlistId}`,
            {
                flatPlaylist: true,
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificate: true,
            }
        );

        if (!result || !result.entries) return null;

        return {
            title: result.title,
            name:  result.title,
            songs: result.entries.map(entry => ({
                name:       entry.title,
                artists:    [{ name: entry.uploader || entry.channel || 'Unknown Artist' }],
                thumbnails: [{ url: entry.thumbnail || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg` }],
                ytId: entry.id
            }))
        };
    } catch (e) {
        console.error('yt-dlp playlist fetch failed:', e.message);
        return null;
    }
});

    // ==========================================
    // --- TASK 2: NATIVE C++ AI TRANSCRIPTION ---
    // ==========================================
    ipcMain.handle('transcribe-audio', async (event, audioPath) => {
      let tempFilePath = null;
      let tempWavPath = path.join(app.getPath('temp'), 'ai-audio-' + Date.now() + '.wav');

      try {
        let transcribePath = audioPath;

        if (audioPath.startsWith('http')) {
          console.log("Downloading online stream for AI transcription...");
          tempFilePath = await downloadAudioToTemp(audioPath);
          transcribePath = tempFilePath;
        }

        console.log("Starting DIRECT ASYNC C++ Whisper transcription for:", transcribePath);

        const cp = require('child_process');
        const util = require('util');
        const execAsync = util.promisify(cp.exec);
        
        let ffmpegPath = 'ffmpeg';
        try { 
            let rawFfmpeg = require('ffmpeg-static'); 
            if (rawFfmpeg.includes('app.asar')) {
                rawFfmpeg = rawFfmpeg.replace('app.asar', 'app.asar.unpacked');
            }
            ffmpegPath = rawFfmpeg.replace(/\\/g, '/');
        } catch(e) {}
        
        let whisperFolder = path.join(__dirname, 'node_modules', 'whisper-node', 'lib', 'whisper.cpp');
        if (whisperFolder.includes('app.asar')) {
            whisperFolder = whisperFolder.replace('app.asar', 'app.asar.unpacked');
        }
        let mainExe = path.join(whisperFolder, 'whisper-cli.exe');
        
        if (!fs.existsSync(mainExe)) {
            mainExe = path.join(whisperFolder, 'main.exe');
        }
        
        

        const modelPath = path.join(whisperFolder, 'models', 'ggml-tiny.en.bin');

        if (!fs.existsSync(mainExe)) {
            throw new Error("whisper-cli.exe not found! Make sure you pasted the files into the whisper.cpp folder.");
        }

        console.log("Converting audio to 16kHz WAV format (Async)...");
        await execAsync(`"${ffmpegPath}" -y -i "${transcribePath}" -ar 16000 -ac 1 -c:a pcm_s16le "${tempWavPath}"`);

        console.log("Running AI Engine (Async)...");
        let output;
        
        try {
            const { stdout } = await execAsync(`"${mainExe}" -m "${modelPath}" -f "${tempWavPath}"`, { 
                maxBuffer: 1024 * 1024 * 10 
            });
            output = stdout.toString();
        } catch (execErr) {
            let errMessage = execErr.message;
            if (execErr.stdout) errMessage += "\nSTDOUT: " + execErr.stdout.toString();
            if (execErr.stderr) errMessage += "\nSTDERR: " + execErr.stderr.toString();
            throw new Error("AI Execution Failed: " + errMessage);
        }

        let lrcText = "";
        const lines = output.split('\n');
        lines.forEach(line => {
            let match = line.match(/\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->.*?\](.*)/);
            if (match) {
                let h = parseInt(match[1]);
                let m = parseInt(match[2]);
                let s = parseFloat(match[3] + '.' + match[4]);
                
                let totalMin = (h * 60) + m;
                let mStr = totalMin.toString().padStart(2, '0');
                let sStr = s.toFixed(2).padStart(5, '0');
                let text = match[5].trim();
                
                if (text && !text.includes('[BLANK_AUDIO]')) {
                    lrcText += `[${mStr}:${sStr}] ${text}\n`;
                }
            }
        });

        if (!lrcText.trim()) throw new Error("AI completed but no speech was detected.");

        return { status: 'success', lrc: lrcText };

      } catch (error) {
        console.error("AI Transcription Error:", error);
        return { status: 'error', success: false, error: "AI Engine failed", details: error.message };
      } finally {
        if (fs.existsSync(tempWavPath)) {
            try { fs.unlinkSync(tempWavPath); } catch(e) {}
        }
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch(e) {}
        }
      }
    });

    // ==========================================
    // --- CLEANUP WEIRD YTDL CACHE FILES ---
    // ==========================================
    fs.readdirSync(__dirname).forEach(file => {
        if (file.endsWith('-player-script.js')) {
            try { fs.unlinkSync(path.join(__dirname, file)); } catch(e) {}
        }
    });

    win = new BrowserWindow({
      width: 1250, height: 850, autoHideMenuBar: true, title: "Pro Media Player", icon: __dirname + '/icon.ico',
      webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false }
    });

    // AUTO UPDATER
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('update-available', () => {
        win.webContents.send('update-status', 'Downloading new update...');
    });

    autoUpdater.on('update-downloaded', () => {
        win.webContents.send('update-status', 'Update ready! Restarting in 5 seconds...');
        setTimeout(() => {
            autoUpdater.quitAndInstall();
        }, 5000);
    });

    // LOAD THE UI
    win.loadFile('index.html');
    powerSaveBlocker.start('prevent-app-suspension'); 

    // Handle second instance (restore window and handle file args)
    app.on('second-instance', (event, commandLine) => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
        
        const filePath = commandLine.pop();
        if (filePath && filePath.endsWith('.mp3')) {
          win.webContents.send('open-external-file', filePath);
        }
      }
    });
    
    // RESTORED KEYBOARD SHORTCUTS
    globalShortcut.register('MediaPlayPause', () => { if(win) win.webContents.executeJavaScript('if(typeof togglePlay === "function") togglePlay();'); });
    globalShortcut.register('MediaNextTrack', () => { if(win) win.webContents.executeJavaScript('if(typeof playNext === "function") playNext();'); });
    globalShortcut.register('MediaPreviousTrack', () => { if(win) win.webContents.executeJavaScript('if(typeof playPrev === "function") playPrev();'); });
    
  }); // <-- THIS is where app.whenReady() actually closes!
} // <-- THIS is where the else block closes!

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// For macOS file opening
app.on('open-file', (event, filePath) => {
  if (win) {
    win.webContents.send('open-external-file', filePath);
  }
});
