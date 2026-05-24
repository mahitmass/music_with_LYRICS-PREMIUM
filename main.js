const { app, BrowserWindow, powerSaveBlocker, globalShortcut, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { fork } = require('child_process');

// We have removed YTMod and ytdl to stop the 403 Forbidden crashes


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

        // PLAN B: If blocked or parsing fails, try Piped API
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
                        break; // Stop looking once we find a working server!
                    }
                } catch(e) { console.log(`Server ${server} failed, trying next...`); }
            }
            
            if (!pipedData) throw new Error("All Piped API servers are offline");
            
            let songs = pipedData.relatedStreams.map(s => {
    // Piped usually stores the video ID in the 'url' string like "/watch?v=XXXXXX"
    let videoId = s.url ? s.url.split('v=')[1] : null; 
    
    return {
        name: s.title,
        artists: [{ name: s.uploaderName }],
        thumbnails: [{ url: s.thumbnail }],
        ytId: videoId // MUST include this so the renderer knows what to play!
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
                    // NEW: We can extract the videoId here if you want to use it for streaming later!
                    let vId = vid.videoId; 
                    songs.push({
                        name: vid.title.runs[0].text,
                        artists: [{ name: artist }],
                        thumbnails: vid.thumbnail.thumbnails,
                        ytId: vId // Saving the ID for the audio fetcher
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

        // ==========================================
        // NEW: RECURSIVE TOKEN HUNTER
        // ==========================================
        // This function searches every nested object until it finds the token
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

        // Hunt for the initial token
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
            
            // Hunt for the next token in the newly fetched data
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
    // --- TASK 2: ISOLATED AI TRANSCRIPTION HANDLER ---
    // ==========================================
    ipcMain.handle('transcribe-audio', async (event, audioPath) => {
      let tempFilePath = null;
      try {
        let transcribePath = audioPath;

        // If it's a URL, download it to a temporary file
        if (audioPath.startsWith('http')) {
          console.log("Downloading online stream for AI transcription...");
          tempFilePath = await downloadAudioToTemp(audioPath);
          transcribePath = tempFilePath;
        }

        console.log("Starting isolated Whisper transcription for:", transcribePath);
        
        // Task 2: Isolate ShellJS and Whisper-Node in a completely detached child process
        // This prevents the Electron main thread from crashing due to native compilation issues
        return await new Promise((resolve) => {
          // Path to a temporary runner script we'll create to isolate whisper
          const runnerPath = path.join(app.getPath('temp'), 'whisper-runner.js');
          
          // Write the runner script
          const runnerCode = `
            try {
              const shell = require('shelljs');
              shell.config.execPath = process.execPath;
              const whisper = require('whisper-node');
              
              whisper("${transcribePath.replace(/\\/g, '\\\\')}", {
                modelName: "tiny.en",
                whisperOptions: { language: 'en', gen_file_lrc: false, gen_file_txt: false }
              }).then(transcript => {
                let lrcText = "";
                if (Array.isArray(transcript)) {
                  transcript.forEach(line => {
                    const ms = parseFloat(line.start);
                    const m = Math.floor(ms / 60).toString().padStart(2, '0');
                    const s = (ms % 60).toFixed(2).padStart(5, '0');
                    lrcText += \`[$\{m}:\${s}] \${line.text.trim()}\\n\`;
                  });
                }
                process.send({ status: 'success', lrc: lrcText });
              }).catch(err => {
                process.send({ status: 'error', message: err.message });
              });
            } catch (err) {
              process.send({ status: 'error', message: "Compilation/Load error: " + err.message });
            }
          `;
          
          fs.writeFileSync(runnerPath, runnerCode);
          
          // Fork the process so it runs completely detached from the main Electron thread
          const child = fork(runnerPath, [], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
          });
          
          child.on('message', (msg) => {
            resolve(msg);
            try { fs.unlinkSync(runnerPath); } catch(e) {}
            child.kill();
          });
          
          child.on('error', (err) => {
            resolve({ 
              status: 'error', 
              success: false, 
              error: "Child process failed to start. Local AI engine compilation failed.",
              details: err.message 
            });
            try { fs.unlinkSync(runnerPath); } catch(e) {}
          });
          
          child.on('exit', (code) => {
            if (code !== 0) {
              resolve({ 
                status: 'error', 
                success: false, 
                error: "AI engine crashed unexpectedly. Please install build-essential tools."
              });
            }
          });
        });

      } catch (error) {
        console.error("AI Transcription Error:", error);
        return { 
          status: 'error', 
          success: false, 
          error: "Failed to download or process audio stream.",
          details: error.message 
        };
      } finally {
        // Task 2: Clean up temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try { fs.unlinkSync(tempFilePath); } catch(e) { console.error("Temp file cleanup failed:", e); }
        }
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
///yo
