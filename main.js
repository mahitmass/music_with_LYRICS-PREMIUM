const { app, BrowserWindow, powerSaveBlocker, globalShortcut, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { fork } = require('child_process');
const http = require('http');
const youtubeDl = require('youtube-dl-exec');

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
// --- YT-DLP BULLETPROOF STREAM SERVER ---
// ==========================================
let ytStreamPort = 0;

function startYTStreamServer() {
    const server = http.createServer(async (req, res) => {
        const ytId = decodeURIComponent(req.url.slice(1));
        if (!ytId) { res.writeHead(400); res.end(); return; }

        try {
            // yt-dlp resolves the real CDN URL — much more reliable
            const rawUrl = await youtubeDl(`https://www.youtube.com/watch?v=${ytId}`, {
                format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
                getUrl: true,
                noWarnings: true,
                noCheckCertificates: true,
            });

            const audioUrl = (rawUrl || '').trim().split('\n')[0];
            if (!audioUrl || !audioUrl.startsWith('http')) throw new Error('No URL returned');

            const urlObj = new URL(audioUrl);
            const lib = urlObj.protocol === 'https:' ? https : http;

            // Forward range header so seeking works
            const reqHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.youtube.com/',
                'Origin': 'https://www.youtube.com',
            };
            if (req.headers['range']) reqHeaders['Range'] = req.headers['range'];

            lib.get({
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                headers: reqHeaders
            }, (proxyRes) => {
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

    // ==========================================
    // --- INVINCIBLE INFINITE SCRAPER ---
    // ==========================================
    ipcMain.handle('get-yt-playlist', async (event, playlistId) => {
      try { 
        console.log("Scraping standard YouTube for playlist:", playlistId);
        
        const baseHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' };
        const res = await fetch(`https://www.youtube.com/playlist?list=${playlistId}`, { headers: baseHeaders });
        const html = await res.text();

        let title = "Custom Playlist";
        const titleMatch = html.match(/<title>(.*?) - YouTube<\/title>/);
        if (titleMatch) title = titleMatch[1];

        // ROBUST JSON EXTRACTOR - finds the full object regardless of newlines!
        let startIdx = html.indexOf('var ytInitialData = ') !== -1 
            ? html.indexOf('var ytInitialData = ') + 'var ytInitialData = '.length
            : html.indexOf('window["ytInitialData"] = ') + 'window["ytInitialData"] = '.length;
        
        let data = null;
        if (startIdx > 30) {
            let depth = 0, inStr = false, escape = false, endIdx = startIdx;
            for (let c = startIdx; c < html.length; c++) {
                const ch = html[c];
                if (escape) { escape = false; continue; }
                if (ch === '\\' && inStr) { escape = true; continue; }
                if (ch === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { endIdx = c + 1; break; } }
            }
            try { data = JSON.parse(html.slice(startIdx, endIdx)); } catch(e) { data = null; }
        }

        // PLAN B: If blocked or parsing fails, try Piped API Mirrors
        if (!data) {
            console.log("Engaging Plan B (Piped Mirrors)...");
            const pipedServers = ["https://pipedapi.tokhmi.xyz", "https://api.piped.projectsegfau.lt", "https://piped-api.lunar.icu", "https://watchapi.whatever.social"];
            let pipedData = null;
            
            for (const server of pipedServers) {
                try {
                    const pipedRes = await fetch(`${server}/playlists/${playlistId}`);
                    if (pipedRes.ok) { 
                        pipedData = await pipedRes.json(); 
                        break; 
                    }
                } catch(e) { console.log(`Server ${server} failed, trying next...`); }
            }
            
            if (!pipedData) throw new Error("All Piped API servers are offline");
            
            let songs = pipedData.relatedStreams.map(s => {
                let videoId = s.url ? s.url.split('v=')[1] : null; 
                return {
                    name: s.title,
                    artists: [{ name: s.uploaderName }],
                    thumbnails: [{ url: s.thumbnail }],
                    ytId: videoId
                };
            });
            return { title: pipedData.name || title, songs };
        }

        let songs = [];

        function extractSongs(items) {
            if (!items) return;
            items.forEach(item => {
                let vid = item.playlistVideoRenderer;
                if (vid && vid.title) {
                    let artist = vid.shortBylineText ? vid.shortBylineText.runs.map(r => r.text).join('') : "Unknown Artist";
                    let vId = vid.videoId; 
                    songs.push({
                        name: vid.title.runs[0].text,
                        artists: [{ name: artist }],
                        thumbnails: vid.thumbnail.thumbnails,
                        ytId: vId 
                    });
                }
            });
        }

        const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs;
        let listRenderer = tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer;
        
        if (listRenderer && listRenderer.contents) extractSongs(listRenderer.contents);

        let apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"(.*?)"/);
        let clientVerMatch = html.match(/"clientVersion":"(.*?)"/);
        let apiKey = apiKeyMatch ? apiKeyMatch[1] : null;
        let clientVer = clientVerMatch ? clientVerMatch[1] : "2.20240410.01.00"; 

        function findToken(obj) {
            if (!obj || typeof obj !== 'object') return null;
            if (obj.continuationCommand?.token) return obj.continuationCommand.token;
            if (obj.continuationEndpoint?.continuationCommand?.token) return obj.continuationEndpoint.continuationCommand.token;
            for (let key in obj) {
                if (typeof obj[key] === 'object') {
                    let t = findToken(obj[key]);
                    if (t) return t;
                }
            }
            return null;
        }

        let token = findToken(listRenderer) || findToken(data);
        let pagesFetched = 0;

        while (token && apiKey && pagesFetched < 30) {
            pagesFetched++;
            console.log(`Fetching playlist page ${pagesFetched + 1}...`);
            
            const nextRes = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
                method: 'POST',
                headers: { 
                    ...baseHeaders,
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.youtube.com',
                    'Referer': `https://www.youtube.com/playlist?list=${playlistId}`,
                    'X-YouTube-Client-Name': '1', 
                    'X-YouTube-Client-Version': clientVer
                },
                body: JSON.stringify({
                    context: { client: { clientName: "WEB", clientVersion: clientVer, hl: "en", gl: "US" } },
                    continuation: token
                })
            });
            
            const nextData = await nextRes.json();
            const nextActions = nextData.onResponseReceivedActions;
            if (!nextActions) break;
            
            const appendItems = nextActions[0]?.appendContinuationItemsAction?.continuationItems;
            if (!appendItems) break;

            extractSongs(appendItems);
            token = findToken(nextActions);
        }

        console.log(`Successfully scraped ${songs.length} total songs!`);
        return { title, songs };
      } catch (error) { 
        console.error("Scraper Error:", error.message);
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
        try { ffmpegPath = require('ffmpeg-static').replace(/\\\\/g, '/'); } catch(e) {}
        
        const whisperFolder = path.join(__dirname, 'node_modules', 'whisper-node', 'lib', 'whisper.cpp');
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
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// For macOS file opening
app.on('open-file', (event, filePath) => {
  if (win) {
    win.webContents.send('open-external-file', filePath);
  }
});