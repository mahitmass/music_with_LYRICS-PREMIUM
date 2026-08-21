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

function fastDownload(urlStr, destPath, isAudio, event) {
    return new Promise((resolve, reject) => {
        let totalBytes = 0;
        let downloaded = 0;
        const numConnections = 8;
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

        const getStreamInfo = (dUrl) => {
            const lib = dUrl.startsWith('https') ? https : http;
            const req = lib.get(dUrl, { headers }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.destroy();
                    return getStreamInfo(new URL(res.headers.location, dUrl).href);
                }
                if (res.statusCode >= 400) {
                    res.destroy();
                    return reject(new Error('HTTP ' + res.statusCode));
                }
                
                const length = parseInt(res.headers['content-length'], 10) || 0;
                const acceptRanges = res.headers['accept-ranges'] === 'bytes';
                
                if (length < 1024 * 1024 || !acceptRanges) {
                    totalBytes = length;
                    const file = fs.createWriteStream(destPath);
                    res.on('data', c => {
                        downloaded += c.length;
                        if (totalBytes && isAudio && event) event.sender.send('download-progress', Math.round((downloaded / totalBytes) * 100));
                    });
                    res.pipe(file);
                    file.on('finish', () => file.close(resolve));
                } else {
                    res.destroy();
                    totalBytes = length;
                    const chunkSize = Math.ceil(length / numConnections);

                    const fd = fs.openSync(destPath, 'w');
                    fs.writeSync(fd, Buffer.alloc(1), 0, 1, length - 1);
                    fs.closeSync(fd);

                    const downloadChunk = (index) => {
                        return new Promise((resChunk, rejChunk) => {
                            const start = index * chunkSize;
                            const end = index === numConnections - 1 ? length - 1 : (start + chunkSize - 1);
                            const chunkHeaders = { ...headers, 'Range': `bytes=${start}-${end}` };
                            
                            lib.get(dUrl, { headers: chunkHeaders }, (resRange) => {
                                if (resRange.statusCode >= 400) return rejChunk(new Error('Chunk HTTP ' + resRange.statusCode));
                                
                                const fileStream = fs.createWriteStream(destPath, { flags: 'r+', start: start });
                                resRange.on('data', c => {
                                    downloaded += c.length;
                                    if (isAudio && event) event.sender.send('download-progress', Math.round((downloaded / totalBytes) * 100));
                                });
                                resRange.pipe(fileStream);
                                fileStream.on('finish', () => fileStream.close(resChunk));
                            }).on('error', rejChunk);
                        });
                    };

                    const promises = [];
                    for (let i = 0; i < numConnections; i++) {
                        promises.push(downloadChunk(i));
                    }

                    Promise.all(promises).then(resolve).catch(reject);
                }
            }).on('error', reject);
        };

        getStreamInfo(urlStr);
    });
}

function downloadAudioToTemp(audioPath) {
  return new Promise((resolve, reject) => {
    const tempFilePath = path.join(app.getPath('temp'), 'lyrics-generation-target.mp4');

    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch (e) {}

    fastDownload(audioPath, tempFilePath, false, null)
      .then(() => resolve(tempFilePath))
      .catch(reject);
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
                        impersonate: 'chrome',
                        rmCacheDir: true,
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
                // If YouTube rejected the cached URL (expired/blocked), purge it so next request gets a fresh one
                if (proxyRes.statusCode === 403 || proxyRes.statusCode === 410) {
                    urlCache.delete(ytId);
                    console.warn(`[YT Stream] Cached URL for ${ytId} returned ${proxyRes.statusCode}, purged from cache`);
                }

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

    // 🔥 GLOBALIZE YT MUSIC: Initialize once to prevent rate-limit crashes
    const YTMusic = require('ytmusic-api');
    const globalYtMusic = new YTMusic();
    let isGlobalYtReady = false;

    // ── 1. The YT Music Scraper (Moved to backend to stop red header errors) ──
    ipcMain.handle('get-yt-playlist', async (event, rawId) => {
        try {
            // 🔥 THE BYPASS: Clean the ID. Strip 'VL' prefix that breaks APIs
            let playlistId = rawId;
            if (playlistId.startsWith('VL')) playlistId = playlistId.substring(2);

            if (!isGlobalYtReady) {
                await globalYtMusic.initialize();
                isGlobalYtReady = true;
            }
            return await globalYtMusic.getPlaylist(playlistId);
        } catch (e) {
            console.warn('ytmusic-api playlist fetch failed:', e.message);
            return null;
        }
    });

    // ── 2. The Bulletproof yt-dlp Fallback (No API Limits) ──
    ipcMain.handle('get-yt-playlist-ytdlp', async (event, rawId) => {
        try {
            // 🔥 THE BYPASS: Clean the ID here too
            let playlistId = rawId;
            if (playlistId.startsWith('VL')) playlistId = playlistId.substring(2);

            // youtubeDl is declared at top of file with ASAR fix already applied
            const result = await youtubeDl(
                `https://www.youtube.com/playlist?list=${playlistId}`,
                {
                    flatPlaylist: true,
                    dumpSingleJson: true,
                    noWarnings: true,
                    noCheckCertificate: true,
                    ignoreErrors: true,
                    noCacheDir: true,
                    impersonate: 'chrome',
                }
            );

            if (!result || !result.entries) return null;

            return {
                title: result.title,
                name:  result.title,
                // Filter out any null entries caused by deleted videos
                songs: result.entries.filter(entry => entry && entry.title).map(entry => ({
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

    // ── 3. YT Music Global Search (Moved to backend to fix RED header errors) ──
    ipcMain.handle('search-yt-music', async (event, query) => {
        try {
            if (!isGlobalYtReady) {
                await globalYtMusic.initialize();
                isGlobalYtReady = true;
            }
            const results = await globalYtMusic.searchSongs(query);
            
            // 🔥 THE FIX: Block YouTube Shorts and snippets! 
            // ytmusic-api returns duration in seconds. We filter out anything under 50s.
            return results.filter(song => {
                if (!song.duration) return true; // Pass it through if duration is hidden
                return song.duration >= 50; 
            });
            
        } catch (e) {
            console.error('ytmusic-api search failed:', e.message);
            return [];
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

    ipcMain.handle('download-song-with-metadata', async (event, songInfo) => {
        const { dialog } = require('electron');
        const defaultPath = path.join(app.getPath('downloads'), `${songInfo.title} - ${songInfo.artist}.mp3`.replace(/[\\/:*?"<>|]/g, ''));
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: 'Save Song',
            defaultPath: defaultPath,
            filters: [{ name: 'Audio', extensions: ['mp3', 'm4a'] }]
        });
        
        if (canceled || !filePath) return { success: false, error: 'Cancelled' };

        try {
            const tempAudioPath = path.join(app.getPath('temp'), 'dl-audio-' + Date.now() + '.m4a');
            
            const downloadWithRedirect = (urlStr, destPath, isAudio) => {
                return fastDownload(urlStr, destPath, isAudio, event);
            };

            await downloadWithRedirect(songInfo.url, tempAudioPath, true);
            
            let ffmpegPath = 'ffmpeg';
            try { 
                let rawFfmpeg = require('ffmpeg-static'); 
                if (rawFfmpeg.includes('app.asar')) {
                    rawFfmpeg = rawFfmpeg.replace('app.asar', 'app.asar.unpacked');
                }
                ffmpegPath = rawFfmpeg.replace(/\\/g, '/');
            } catch(e) {}

            const cp = require('child_process');
            const util = require('util');
            const execAsync = util.promisify(cp.exec);

            let tempThumbPath = null;
            if (songInfo.cover) {
                tempThumbPath = path.join(app.getPath('temp'), 'temp-cover-' + Date.now() + '.jpg');
                await downloadWithRedirect(songInfo.cover, tempThumbPath, false);
            }

            const isMp3 = filePath.toLowerCase().endsWith('.mp3');
            
            let cmd = `"${ffmpegPath}" -y -i "${tempAudioPath}"`;
            if (tempThumbPath) {
                cmd += ` -i "${tempThumbPath}" -map 0:a -map 1:v`;
            } else {
                cmd += ` -map 0:a`;
            }
            
            if (isMp3) {
                // If saved as mp3, we must transcode audio (since source is likely AAC/M4A) and use ID3v2.3 for Windows Explorer
                cmd += ` -c:a libmp3lame -b:a 320k`;
                if (tempThumbPath) {
                    cmd += ` -c:v mjpeg -id3v2_version 3 -metadata:s:v title="Album cover" -metadata:s:v comment="Cover (front)"`;
                } else {
                    cmd += ` -id3v2_version 3`;
                }
            } else {
                // For M4A, we copy audio but MUST use mjpeg for the video stream so Windows Explorer sees the cover
                cmd += ` -c:a copy`;
                if (tempThumbPath) {
                    cmd += ` -c:v mjpeg -disposition:v:0 attached_pic`;
                }
            }
            
            const safeTitle = (songInfo.title || 'Unknown').replace(/"/g, '\\"');
            const safeArtist = (songInfo.artist || 'Unknown Artist').replace(/"/g, '\\"');
            cmd += ` -metadata title="${safeTitle}" -metadata artist="${safeArtist}" -metadata album="${safeTitle}" "${filePath}"`;

            await execAsync(cmd);

            try { fs.unlinkSync(tempAudioPath); } catch(e) {}
            if (tempThumbPath) {
                try { fs.unlinkSync(tempThumbPath); } catch(e) {}
            }

            return { success: true };
        } catch (error) {
            console.error("Download Error:", error);
            return { success: false, error: error.message };
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

    win.webContents.on('did-finish-load', () => {
        const filePath = process.argv.find(arg => arg.toLowerCase().endsWith('.mp3'));
        if (filePath && fs.existsSync(filePath)) {
            win.webContents.send('open-external-file', filePath);
        }
    }); 

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
