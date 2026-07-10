// ==========================================
// --- LYRICS.JS ---
// Handles: Lyrics fetching, display, editing, syncing,
//          AI generation, retry UI, plain text sync
// Loaded BEFORE renderer.js in index.html
// ==========================================
// ==========================================
// --- LYRIC STATE VARIABLES ---
// ==========================================
// NOTE: lyrics, lyrIdx, lyricsEnabled, isEditing, isUserScrolling,
//       lyricScrollTimeout, songSyncOffset are declared in renderer.js
//       as shared globals. This file only USES them.

// AI Task state (shared with renderer via window scope)
// 🔥 NEW: Flawless Unique ID generator for lyrics sync & saving
function getLyricTrackId(s) {
    if (!s) return 'unknown';
    return s.ytId || s.id || (s.isOnline ? s.t + '::' + s.a : s.p);
}
let aiWorker = null;
let aiTaskQueue = [];
let isAIBusy = false;
let currentAITask = null;

// Retry UI state
let currentRetryData = [];
let selectedRetryIndex = null;

// ==========================================
// --- AI BUTTON HELPER ---
// ==========================================
function updateAIButtons(display, title, isSpinning = false) {
    const btn1 = document.getElementById('btn-ai-sync');
    const btn2 = document.getElementById('main-ai-btn');

    if (btn1) {
        btn1.style.display = display;
        btn1.title = title;
        btn1.innerText = isSpinning ? 'sync' : 'auto_awesome';
        btn1.style.animation = isSpinning ? 'simple-spin 1.5s linear infinite' : 'none';
    }
    if (btn2) {
        btn2.style.display = display;
        btn2.title = title;
        btn2.innerText = isSpinning ? 'sync' : 'auto_awesome';
        btn2.style.animation = isSpinning ? 'simple-spin 1.5s linear infinite' : 'none';
    }

    let indicator = document.getElementById('ai-task-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'ai-task-indicator';
        indicator.innerHTML = `<span class="material-icons-round ai-spinner">sync</span> <span id="ai-task-text">AI Generating...</span>`;
        document.body.appendChild(indicator);
    }

    if (isSpinning) {
        indicator.classList.add('show');
        document.getElementById('ai-task-text').innerText = title || "AI is working in background...";
    } else {
        indicator.classList.remove('show');
    }
}

// ==========================================
// --- TOGGLE LYRICS ON/OFF ---
// ==========================================
function toggleLyrics() {
    lyricsEnabled = !lyricsEnabled;
    localStorage.setItem('lyricsEnabled', lyricsEnabled);

    const btn = document.getElementById('btn-toggle-lyrics');
    if (btn) {
        btn.style.color = lyricsEnabled ? 'var(--accent)' : 'var(--dim)';
        btn.innerText = lyricsEnabled ? 'subtitles' : 'subtitles_off';
    }

    if (lyricsEnabled) {
        lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter:blur(0)">Waking up lyrics...</p>';
        if (typeof queue !== 'undefined' && queue.length > 0 && queue[curIdx]) {
            setTimeout(() => { getLyrics(queue[curIdx]); }, 50);
        } else {
            lContent.innerHTML = '<div style="padding:20px; text-align:center; color:var(--dim);">No song currently playing.</div>';
        }
    } else {
        lyrics = [];
        lContent.innerHTML = `<div style="padding: 20px; color: var(--dim); text-align: center; margin-top: 50%; transform: translateY(-50%); font-size: 0.95rem;">Lyrics are disabled to save power.<br><span style="font-size: 0.8rem; opacity: 0.7;">Click the <span class="material-icons-round" style="font-size: 16px; vertical-align: middle;">subtitles_off</span> button to enable.</span></div>`;
    }
}

// ==========================================
// --- TOGGLE NO LYRICS (BLOCK FOR TRACK) ---
// ==========================================
function toggleNoLyrics() {
    const s = queue[curIdx];
    if (!s) return;
    const uid = getLyricTrackId(s);
    let block = localStorage.getItem('noLyr_' + uid);
    if (block) {
        localStorage.removeItem('noLyr_' + uid);
// ... rest of function ...
    } else {
        localStorage.setItem('noLyr_' + uid, "true");
// ...
        lyrics = [];
        lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter:blur(0)">Lyrics permanently disabled for this track.</p>';
    }
    updateToolIcons();
}

// ==========================================
// --- SYNC UI TOGGLE & HOLD CONTROLS ---
// ==========================================
function toggleSyncUI() {
    const ui = document.getElementById('sync-ui');
    ui.style.display = ui.style.display === 'flex' ? 'none' : 'flex';
    document.getElementById('btn-sync').classList.toggle('active');
}

let syncHoldInterval;

function startSync(val) {
    adjSync(val);
    syncHoldInterval = setInterval(() => { adjSync(val); }, 150);
}

function stopSync() {
    clearInterval(syncHoldInterval);
}

function manualSyncInput(val) {
    const s = queue[curIdx];
    if (!s) return;
    const uid = getLyricTrackId(s);
    
    let numericVal = parseFloat(val.replace(/[^\d.-]/g, ''));
    if (isNaN(numericVal)) {
        document.getElementById('sync-val').value = (songSyncOffset > 0 ? '+' : '') + songSyncOffset.toFixed(1) + 's';
        return;
    }
    songSyncOffset = numericVal;
    localStorage.setItem('sync_' + uid, songSyncOffset.toFixed(1));
    document.getElementById('sync-val').value = (songSyncOffset > 0 ? '+' : '') + songSyncOffset.toFixed(1) + 's';
    if (typeof showToast === 'function') showToast(`Sync offset saved: ${songSyncOffset.toFixed(1)}s`);
}

function adjSync(val) {
    const s = queue[curIdx];
    if (!s) return;
    const uid = getLyricTrackId(s);
    
    songSyncOffset += val;
    localStorage.setItem('sync_' + uid, songSyncOffset.toFixed(1));
    const input = document.getElementById('sync-val');
    if (input) {
        input.value = (songSyncOffset > 0 ? '+' : '') + songSyncOffset.toFixed(1) + 's';
    }
}

// ==========================================
// --- CLEAN TITLE HELPER ---
// ==========================================
function getCleanTitle(s) {
    return s.t.replace(/\(.*\)|\[.*\]|\{.*\}/g, '')
        .replace(/lyrical|audio|video|official/gi, '')
        .replace(/_/g, ' ')
        .trim();
}

// ==========================================
// --- FETCH LYRICS FROM LRCLIB ---
// ==========================================
async function getLyrics(s) {
    if (!lyricsEnabled) {
        lyrics = [];
        lContent.innerHTML = `<div style="padding: 20px; color: var(--dim); text-align: center; margin-top: 50%; transform: translateY(-50%); font-size: 0.95rem;">Lyrics are disabled to save power.</div>`;
        return;
    }

    try {
        const cSongId = getLyricTrackId(s);

        lyrics = [];
        lyrIdx = -1;

        if (localStorage.getItem('noLyr_' + cSongId)) {
            lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter:blur(0)">Lyrics disabled for this track.</p>';
            return;
        }

        let cleanTitle = getCleanTitle(s);
        let lDir, lPath;

        // 1. Local Read
        if (!s.isOnline) {
            lDir = path.join(path.dirname(s.p), 'Lyrics');
            lPath = path.join(lDir, s.a + ' - ' + cleanTitle + '.lrc');
            if (fs.existsSync(lPath)) {
                show(fs.readFileSync(lPath, 'utf8'));
                return;
            }
        } else {
            const savedCustom = localStorage.getItem('lyric_custom_' + cSongId);
            if (savedCustom) { show(savedCustom); return; }
        }

        if (s.isOnline && localStorage.getItem('apiEmpty_' + cSongId)) {
            lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter:blur(0)">No lyrics in database.</p>';
            return;
        }

        lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter: blur(0px);">Searching the database...</p>';

        const headers = { 'User-Agent': 'ProMediaPlayer/1.0.0 (https://github.com/mahitmass/music_with_LYRICS)' };

        const durationParam = audio.duration > 0 ? `&duration=${Math.round(audio.duration)}` : '';
        let res = await fetch(`https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(s.a || '')}${durationParam}`, { headers });

        if (res.status === 429 || res.status === 403) {
            lContent.innerHTML = '<p class="lyric-line" style="opacity:1; color:#ff4c4c;">API Cooldown. Waiting...</p>';
            return;
        }

        if (!res.ok) throw new Error(`API returned status ${res.status}`);

        let data = await res.json();
        if (!data || (!data[0]?.syncedLyrics && !data[0]?.plainLyrics)) {
            res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent((s.a || '') + ' ' + cleanTitle)}${durationParam}`, { headers });
            if (res.ok) data = await res.json();
        }

        // Smart duration sorting
        if (data && Array.isArray(data) && audio.duration > 0) {
            const targetDur = audio.duration;
            data.sort((a, b) => {
                const diffA = a.duration ? Math.abs(a.duration - targetDur) : 9999;
                const diffB = b.duration ? Math.abs(b.duration - targetDur) : 9999;
                return diffA - diffB;
            });
        }

        let finalLyrics = null;
        if (data && data[0]) {
            finalLyrics = data[0].syncedLyrics || data[0].plainLyrics || null;
        }

        if (finalLyrics) {
            const nativeScriptRegex = /[\u0400-\u04FF\u0370-\u03FF\u0900-\u0DFF\u0600-\u06FF\u3000-\u9FFF\uAC00-\uD7AF]/;
            if (nativeScriptRegex.test(finalLyrics)) {
                lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter: blur(0px);">Searching for Romanized version...</p>';
                let romRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + ' romanized')}`, { headers });
                if (romRes.ok) {
                    let romData = await romRes.json();
                    if (romData && romData[0]?.syncedLyrics && !nativeScriptRegex.test(romData[0].syncedLyrics)) {
                        finalLyrics = romData[0].syncedLyrics;
                    }
                }
            }
        }

        if (finalLyrics) {
            if (!s.isOnline) {
                if (!fs.existsSync(lDir)) fs.mkdirSync(lDir);
                fs.writeFileSync(lPath, finalLyrics);
            } else {
                localStorage.setItem('lyric_custom_' + cSongId, finalLyrics);
            }
            show(finalLyrics);
        } else {
            const isSongInAIQueue = currentAITask?.p === s.p || aiTaskQueue.some(t => t.song.p === s.p);
            if (isSongInAIQueue) {
                lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter: blur(0px);">AI is generating lyrics in background...</p>';
                updateAIButtons('block', 'AI is working...', true);
            } else {
                lContent.innerHTML = `<p class="lyric-line" style="opacity: 1; filter: blur(0px);">No lyrics found in database.</p>`;
                showToast("No lyrics found. Click ✨ to Generate with AI.");
                updateAIButtons('block', 'Generate Lyrics with AI', false);
                if (s.isOnline) localStorage.setItem('apiEmpty_' + cSongId, "true");
            }
        }

    } catch (e) {
        console.error("Lyric Fetch Error:", e);
        lContent.innerHTML = `<p class="lyric-line" style="opacity: 1; filter:blur(0); color:#ff4c4c;">App Error: ${e.message}</p>`;
    }
}

// ==========================================
// --- SHOW / RENDER LYRICS ---
// ==========================================
function show(lrc) {
    lContent.innerHTML = '';
    lyrics = [];
    lyrIdx = -1;

    const reg = /\[(\d{2}):(\d{2}\.\d+)\]/;
    const isSynced = reg.test(lrc);

    const isSongInAIQueue = currentAITask?.p === queue[curIdx]?.p || aiTaskQueue.some(t => t.song.p === queue[curIdx]?.p);

    if (isSongInAIQueue) {
        updateAIButtons('block', 'AI is working...', true);
    } else if (!isSynced && queue[curIdx]) {
        showToast("Only plain text found. Click ✨ to Auto-Sync.");
        updateAIButtons('block', 'AI Auto-Sync Plain Text', false);
    } else {
        updateAIButtons('none', '', false);
    }

    lrc.split('\n').forEach(line => {
        if (isSynced) {
            const m = reg.exec(line);
            if (m) {
                const time = (parseInt(m[1]) * 60) + parseFloat(m[2]);
                const text = line.replace(reg, '').trim();
                if (text) {
                    lyrics.push({ time, text });
                    const p = document.createElement('p');
                    p.className = 'lyric-line';
                    p.innerText = text;
                    p.onclick = (e) => {
                        if (isEditing || window.isGrabbing) { e.stopPropagation(); return; }
                        audio.currentTime = Math.max(0, time - songSyncOffset);
                        if (audio.paused) audio.play();
                    };
                    lContent.appendChild(p);
                }
            }
        } else {
            const text = line.trim();
            if (text) {
                const p = document.createElement('p');
                p.className = 'lyric-line';
                p.style.cursor = 'default';
                p.style.opacity = '0.7';
                p.innerText = text;
                lContent.appendChild(p);
            }
        }
    });
}

// ==========================================
// --- EDIT MODE ---
// ==========================================
function toggleEditMode() {
    const btn = document.getElementById('btn-edit');

    if (!isEditing) {
        if (lyrics.length === 0) return;
        isEditing = true;
        if (!audio.paused) audio.pause();

        const lines = document.getElementsByClassName('lyric-line');
        Array.from(lines).forEach(line => {
            line.contentEditable = "true";
            line.style.borderBottom = "1px dashed rgba(255,255,255,0.3)";
            line.style.cursor = "text";
        });

        if (lyrIdx >= 0 && lines[lyrIdx]) lines[lyrIdx].focus();
        else if (lines.length > 0) lines[0].focus();

        btn.innerText = 'check_circle';
        btn.classList.add('active');
        btn.style.color = '#4cc2ff';
        btn.style.textShadow = '0 0 15px #4cc2ff';
    } else {
        isEditing = false;
        const lines = document.getElementsByClassName('lyric-line');
        let newLrc = "";

        Array.from(lines).forEach((line, i) => {
            line.contentEditable = "false";
            line.style.borderBottom = "none";
            line.style.cursor = "pointer";
            if (lyrics[i]) {
                let time = lyrics[i].time;
                let m = Math.floor(time / 60).toString().padStart(2, '0');
                let s = (time % 60).toFixed(2).padStart(5, '0');
                let text = line.innerText.replace(/\n/g, ' ').trim();
                newLrc += `[${m}:${s}] ${text}\n`;
            }
        });

        const s = queue[curIdx];

        if (!s.isOnline) {
            const lDir = path.join(path.dirname(s.p), 'Lyrics');
            if (!fs.existsSync(lDir)) fs.mkdirSync(lDir);
            const lPath = path.join(lDir, s.a + ' - ' + getCleanTitle(s) + '.lrc');
            fs.writeFileSync(lPath, newLrc);
        } else {
            localStorage.setItem('lyric_custom_' + getLyricTrackId(s), newLrc);
        }

        localStorage.removeItem('noLyr_' + getLyricTrackId(s));
        updateToolIcons();

        btn.innerText = 'edit';
        btn.classList.remove('active');
        btn.style.color = '';
        btn.style.textShadow = 'none';

        show(newLrc);
    }
}

// ==========================================
// --- RETRY UI (ALTERNATIVE LYRICS PICKER) ---
// ==========================================
async function triggerRetryUI() {
    if (!queue[curIdx]) return;
    document.body.classList.add('retry-mode');
    document.body.classList.remove('immersive');

    const container = document.getElementById('retry-results-container');
    container.innerHTML = `<div style="padding:50px; color:var(--accent); text-align:center; display:flex; gap:15px; align-items:center; justify-content:center"><span class="material-icons-round" style="animation: spin 1s linear infinite; font-size:32px">sync</span>Searching alternative synced lyrics...</div>`;

    const s = queue[curIdx];
    const q = `${encodeURIComponent((s.a || '') + ' ' + getCleanTitle(s))}`;
    const headers = { 'User-Agent': 'music-player-mass/1.0.0 (https://github.com/mahitmass/music_with_LYRICS)' };

    const aiRetryButtonHTML = `
        <div class="retry-item" onclick="exitRetryUI(); triggerManualAIGeneration();" style="text-align:center; border: 1px dashed rgba(76,194,255,0.4); background: rgba(76,194,255,0.05); margin-top: 10px;">
            <div style="color:var(--accent); font-size:1.1rem; font-weight:700; display:flex; align-items:center; justify-content:center; gap:10px;">
                <span class="material-icons-round">auto_awesome</span> Force AI Re-Generation
            </div>
            <div style="color:rgba(255,255,255,0.5); font-size:0.85rem; margin-top:5px">Ignore database and use local AI transcription</div>
        </div>
    `;

    try {
        const dur = audio.duration > 0 ? `&duration=${Math.round(audio.duration)}` : '';
        let res = await fetch(`https://lrclib.net/api/search?q=${q}${dur}`, { headers });
        if (!res.ok) throw new Error("Database offline");

        let data = await res.json();
        if (!data) data = [];

        let timed = data.filter(d => d.syncedLyrics);
        let plain = data.filter(d => !d.syncedLyrics && d.plainLyrics);
        currentRetryData = [...timed.slice(0, 4), ...plain.slice(0, 2)];

        if (currentRetryData.length === 0) {
            container.innerHTML = `<p style="padding:30px; color:var(--dim); text-align:center">No alternative lyrics found in database.</p>${aiRetryButtonHTML}`;
            return;
        }

        let html = "";
        currentRetryData.forEach((result, index) => {
            const isSynced = !!result.syncedLyrics;
            const label = isSynced ? "TIMED" : "TEXT ONLY";
            const labelColor = isSynced ? "var(--accent)" : "#888";
            const fullLrc = result.syncedLyrics || result.plainLyrics || "No text available.";
            let lines = fullLrc.split('\n');
            let plainLines = lines.map(l => l.replace(/\[\d{2}:\d{2}\.\d+\]/g, '').trim()).filter(l => l.length > 0);
            let previewText = plainLines.slice(0, 2).join('<br>') || "Instrumental or plain text.";
            const durText = result.duration ? `${Math.floor(result.duration / 60)}:${Math.floor(result.duration % 60).toString().padStart(2, '0')}` : '?:??';

            html += `
            <div class="retry-item" onclick="openRetryPreview(${index})">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; padding-right:40px;">
                   <div style="padding-right: 10px;">
                      <div style="color:white; font-size:1.1rem; font-weight:700;">${result.trackName}</div>
                      <div style="color:var(--dim); font-size:0.9rem; margin-bottom:5px">${result.artistName}</div>
                   </div>
                   <div style="display:flex; gap:8px; align-items:center; margin-top:3px;">
                      <div style="font-size: 0.7rem; font-weight: 700; color: #aaa; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; white-space: nowrap;">⏱ ${durText}</div>
                      <div style="font-size: 0.7rem; font-weight: 900; color: ${labelColor}; border: 1px solid ${labelColor}; padding: 2px 6px; border-radius: 4px; letter-spacing: 1px; white-space: nowrap;">${label}</div>
                   </div>
                </div>
                <div style="color:rgba(255,255,255,0.4); font-family:monospace; font-size:0.9rem; border-top:1px solid #222; padding-top:8px">${previewText}</div>
                <span class="material-icons-round retry-tick"
                      onclick="event.stopPropagation(); selectedRetryIndex=${index}; selectRetryLyrics();"
                      style="opacity:1; pointer-events:auto; cursor:pointer;"
                      title="Select this version">check_circle</span>
            </div>`;
        });

        container.innerHTML = html + aiRetryButtonHTML;

    } catch (e) {
        container.innerHTML = `<p style="padding:50px; color:#ff4c4c; text-align:center">App Error: ${e.message}</p>`;
    }
}

function selectRetryLyrics() {
    if (selectedRetryIndex === null || !currentRetryData[selectedRetryIndex]) return;
    const result = currentRetryData[selectedRetryIndex];
    const finalLyrics = result.syncedLyrics || result.plainLyrics;
    const s = queue[curIdx];

    if (!finalLyrics) { alert("This version has no text at all. Cannot select."); return; }

    if (!s.isOnline) {
        const lDir = path.join(path.dirname(s.p), 'Lyrics');
        const lPath = path.join(lDir, s.a + ' - ' + getCleanTitle(s) + '.lrc');
        if (!fs.existsSync(lDir)) fs.mkdirSync(lDir);
        fs.writeFileSync(lPath, finalLyrics);
    } else {
        localStorage.setItem('lyric_custom_' + getLyricTrackId(s), finalLyrics);
    }

    show(finalLyrics);
    localStorage.removeItem('apiEmpty_' + getLyricTrackId(s));
    closeRetryPreview();
    exitRetryUI();
}

function exitRetryUI() {
    document.body.classList.remove('retry-mode');
    if (audio.duration && lyricsEnabled) document.body.classList.add('immersive');
}

function openRetryPreview(index) {
    selectedRetryIndex = index;
    const result = currentRetryData[index];
    const previewModal = document.getElementById('retry-preview-modal');
    const lyricContainer = document.getElementById('preview-full-lyrics');
    const fullLrc = result.syncedLyrics || result.plainLyrics || "No lyrics available.";
    lyricContainer.innerText = fullLrc;
    previewModal.classList.add('active');
}

function closeRetryPreview() {
    document.getElementById('retry-preview-modal').classList.remove('active');
}

// ==========================================
// --- AI LYRICS GENERATION PIPELINE ---
// ==========================================
function triggerManualAIGeneration() {
    const song = queue[curIdx];
    if (!song) return;

    if (currentAITask?.p === song.p || aiTaskQueue.some(t => t.song.p === song.p)) {
        showToast("Already in AI queue!");
        return;
    }

    const plainTextElements = document.querySelectorAll('#l-content .lyric-line');
    const originalPlainText = Array.from(plainTextElements).map(p => p.innerText).join('\n');

    aiTaskQueue.push({ song: song, plainText: originalPlainText, duration: audio.duration });
    updateAIButtons('block', 'AI is queued...', true);

    if (!isAIBusy) {
        showToast("✨ AI started! You can safely switch songs.");
        processNextAITask();
    } else {
        showToast(`Added to AI Queue (Position: ${aiTaskQueue.length})`);
    }
}

function processNextAITask() {
    if (aiTaskQueue.length === 0) {
        isAIBusy = false;
        currentAITask = null;
        return;
    }

    isAIBusy = true;
    const task = aiTaskQueue.shift();
    currentAITask = task.song;

    generateAILyrics(task.song).then((result) => {
        const s = result.song;
        let lrcText = result.lrc;

        if (task.plainText && task.plainText.length > 20) {
            lrcText = smartSyncPlainLyrics(lrcText, task.plainText, task.duration);
        }

        const lDir = path.join(path.dirname(s.p), 'Lyrics');
        const lPath = path.join(lDir, s.a + ' - ' + getCleanTitle(s) + '.lrc');
        if (!fs.existsSync(lDir)) fs.mkdirSync(lDir);
        fs.writeFileSync(lPath, lrcText);
        localStorage.removeItem('apiEmpty_' + (s.id || s.p));

        if (queue[curIdx] && queue[curIdx].p === s.p) {
            show(lrcText);
            updateAIButtons('none', '', false);
        } else {
            showToast(`Lyrics for "${s.t}" finished generating!`);
        }
        processNextAITask();
    }).catch(e => {
        showToast(`AI Failed for "${task.song.t}": ` + e.message);
        if (queue[curIdx] && queue[curIdx].p === task.song.p) {
            updateAIButtons('block', 'Retry AI Generation', false);
        }
        processNextAITask();
    });
}

async function generateAILyrics(song) {
    try {
        updateAIButtons('block', 'AI Engine is running...', true);
        
        // 🔥 THE FIX: Ask for the ipcRenderer directly inline here so it doesn't cause global conflicts!
        const result = await require('electron').ipcRenderer.invoke('transcribe-audio', song.p);
        
        if (result.status === 'success') {
            return { lrc: result.lrc, song: song };
        } else {
            throw new Error(result.message || result.details || "Transcription failed");
        }
    } catch (error) {
        console.error("Renderer AI Error:", error);
        throw error;
    }
}

// IPC status updates from main process
// 🔥 THE FIX: Call require('electron') directly inline for the listener too!
require('electron').ipcRenderer.on('ai-transcription-status', (event, { status, message, songPath }) => {
    if (typeof queue !== 'undefined' && queue[curIdx] && (queue[curIdx].p === songPath || queue[curIdx].id === songPath || queue[curIdx].ytId === songPath)) {
        if (status === 'loading' || status === 'transcribing') {
            updateAIButtons('block', message, true);
            const lContent = document.getElementById('l-content');
            if (lContent) lContent.innerHTML = `<p class="lyric-line" style="opacity: 1; filter: blur(0px);">${message}</p>`;
        } else if (status === 'error') {
            if (typeof showToast === 'function') showToast(`AI Error for "${currentAITask?.t || 'song'}": ${message}`);
            updateAIButtons('block', 'Retry AI Generation', false);
            const lContent = document.getElementById('l-content');
            if (lContent) lContent.innerHTML = `<p class="lyric-line" style="opacity: 1; filter:blur(0); color:#ff4c4c;">AI Error: ${message}</p>`;
        }
    }
});

// ==========================================
// --- SMART PLAIN TEXT SYNC (TIMESTAMP HIJACKER) ---
// ==========================================
function smartSyncPlainLyrics(aiLrc, plainText, audioDuration) {
    if (!plainText || plainText.trim().length === 0) return aiLrc;

    const timeRegex = /\[(\d{2}:\d{2}\.\d{2,3})\](.*)/;
    let aiLines = aiLrc.split('\n').map(l => {
        let m = l.match(timeRegex);
        if (!m) return null;
        let timeSec = parseInt(m[1].split(':')[0]) * 60 + parseFloat(m[1].split(':')[1]);
        return { timeStr: m[1], timeSec: timeSec, clean: m[2].toLowerCase().replace(/[^\w\s]/g, ' ') };
    }).filter(Boolean);

    if (aiLines.length === 0) return aiLrc;

    let plainLines = plainText.split('\n').map(l => l.trim()).filter(l => l &&
        !l.includes("Waking up") && !l.includes("Searching") &&
        !l.includes("Only plain text") && !l.includes("No lyrics found") &&
        !l.includes("AI is generating"));
    if (plainLines.length === 0) return aiLrc;

    let mapped = [];
    let aiIndex = 0;
    let lastTimeSec = -1;
    const stopWords = ['a', 'the', 'and', 'but', 'or', 'for', 'in', 'is', 'it', 'you', 'i', 'my', 'me', 'yeah', 'oh', 'ooh', 'ah', 'to', 'of', 'on'];

    // PASS 1: Anchor obvious matches
    for (let i = 0; i < plainLines.length; i++) {
        let pLine = plainLines[i];
        let pClean = pLine.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
        if (!pClean) { mapped.push({ text: pLine, timeSec: null }); continue; }

        let bestMatchIdx = -1;
        let bestScore = 0;
        let pWords = pClean.split(/\s+/).filter(w => w.length > 1 && !stopWords.includes(w));
        if (pWords.length === 0) pWords = pClean.split(/\s+/).filter(w => w.length > 0);

        for (let j = aiIndex; j < Math.min(aiIndex + 6, aiLines.length); j++) {
            let aClean = aiLines[j].clean;
            let matchCount = pWords.reduce((acc, w) => aClean.includes(w) ? acc + 1 : acc, 0);
            let score = matchCount / pWords.length;
            let timeDiff = aiLines[j].timeSec - lastTimeSec;
            if (score > bestScore && timeDiff >= 0.5 && timeDiff < 20) {
                bestScore = score;
                bestMatchIdx = j;
            }
        }

        if (bestMatchIdx !== -1 && bestScore >= 0.3) {
            lastTimeSec = aiLines[bestMatchIdx].timeSec;
            mapped.push({ text: pLine, timeSec: lastTimeSec });
            aiIndex = bestMatchIdx + 1;
        } else {
            mapped.push({ text: pLine, timeSec: null });
        }
    }

    // PASS 2: Rubber band interpolation for gaps
    let result = [];
    let finalAudioDur = audioDuration || (aiLines[aiLines.length - 1].timeSec + 10);

    for (let i = 0; i < mapped.length; i++) {
        if (mapped[i].timeSec === null) {
            let prevTime = 0;
            for (let j = i - 1; j >= 0; j--) {
                if (mapped[j].timeSec !== null) { prevTime = mapped[j].timeSec; break; }
            }
            let nextTime = finalAudioDur;
            let nextIdx = mapped.length;
            for (let j = i + 1; j < mapped.length; j++) {
                if (mapped[j].timeSec !== null) { nextTime = mapped[j].timeSec; nextIdx = j; break; }
            }
            let gapCount = (nextIdx - i) + 1;
            let timeGap = (nextTime - prevTime) / gapCount;
            if (timeGap > 4) timeGap = 2.5;
            mapped[i].timeSec = prevTime + timeGap;
        }
        let t = mapped[i].timeSec;
        let m = Math.floor(t / 60).toString().padStart(2, '0');
        let s = (t % 60).toFixed(2).padStart(5, '0');
        result.push(`[${m}:${s}] ${mapped[i].text}`);
    }

    return result.join('\n');
}

// ==========================================
// --- SCROLL HANDLING FOR LYRICS VIEW ---
// ==========================================
function handleManualScroll(e) {
    if (typeof isEditing !== 'undefined' && isEditing) return;
    if (e && e.type === 'wheel' && Math.abs(e.deltaY) < 10) return;

    isUserScrolling = true;
    clearTimeout(lyricScrollTimeout);

    lyricScrollTimeout = setTimeout(() => {
        isUserScrolling = false;
        if (audio.paused) return;
        const ps = document.getElementsByClassName('lyric-line');
        const lView = document.getElementById('l-view');
        if (lView && typeof lyrIdx !== 'undefined' && lyrIdx >= 0 && ps[lyrIdx]) {
            lView.scrollTo({ top: ps[lyrIdx].offsetTop - (lView.clientHeight / 3.5), behavior: 'smooth' });
        }
    }, 2000);
}

// Attach scroll listeners once DOM is ready
window.addEventListener('load', () => {
    const lViewEl = document.getElementById('l-view');
    if (lViewEl) {
        lViewEl.addEventListener('wheel', handleManualScroll);
        lViewEl.addEventListener('touchmove', handleManualScroll);
        lViewEl.addEventListener('mousedown', handleManualScroll);
    }

    // Lyrics auto-sync failsafe — only fetch after audio physically starts
    let lastLyricFetchTrack = -1;
    const playerEl = document.getElementById('player');
    if (playerEl) {
        playerEl.addEventListener('playing', () => {
            if (lastLyricFetchTrack !== curIdx) {
                lastLyricFetchTrack = curIdx;
                if (typeof getLyrics === 'function' && queue[curIdx]) {
                    getLyrics(queue[curIdx]);
                }
            }
        });
    }
});

// ==========================================
// --- UPDATE TOOL ICONS (SYNC + BLOCK) ---
// ==========================================
// ==========================================
// --- UPDATE TOOL ICONS (SYNC + BLOCK) ---
// ==========================================
function updateToolIcons() {
    const s = typeof queue !== 'undefined' ? queue[curIdx] : null;
    if (!s) return;
    const uid = getLyricTrackId(s);
    
    const isBlocked = localStorage.getItem('noLyr_' + uid);
    document.getElementById('btn-nolyrics').classList.toggle('active', !!isBlocked);
    document.getElementById('btn-nolyrics').style.color = isBlocked ? '#ff4c4c' : '';

    songSyncOffset = parseFloat(localStorage.getItem('sync_' + uid)) || 0;
    document.getElementById('sync-val').value = (songSyncOffset > 0 ? '+' : '') + songSyncOffset.toFixed(1) + 's';
}

//yo