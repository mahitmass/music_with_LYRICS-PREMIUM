let ctxMenu = document.getElementById('custom-context-menu');
let ctxTargetSong = null;
let toastTimeout;
function showToast(msg) {
    const toast = document.getElementById('toast');
    if(!toast) return;
    toast.innerText = msg;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 4000);
}
// BRIDGE FIX: Catches old inline right-clicks and prevents ReferenceErrors
window.openSearchMenu = function(e) {
    e.preventDefault(); 
    // We leave this empty because the new Global Listener handles the actual menu!
};

function normalizeSaavnUrl(url) {
    if (!url) return '';
    return url.replace('aac.saavncdn.com', 'c.saavncdn.com');
}

function pickBestSaavnDownload(downloadUrlArray) {
    if (!Array.isArray(downloadUrlArray) || downloadUrlArray.length === 0) return '';
    const preferred =
        downloadUrlArray.find(u => u.quality === '160kbps') ||
        downloadUrlArray.find(u => u.quality === '320kbps') ||
        downloadUrlArray[downloadUrlArray.length - 1];
    return normalizeSaavnUrl(preferred?.url || '');
}

// Checks computer memory to see if you left lyrics ON or OFF last time
let lyricsEnabled = localStorage.getItem('lyricsEnabled') !== 'false';
const { webUtils, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let queue = [], curIdx = 0, lyrics = [], lyrIdx = -1;
let mainQueue = [], mainIdx = 0;
let plQueue = [], plIdx = 0;
let activeQMode = 'main';
let draggedIdx = null;

const PRIMARY_API = 'https://saavn.sumit.co/api';
const FALLBACK_API = 'https://jiosaavn-api-v3.vercel.app/api'; 
const delay = ms => new Promise(res => setTimeout(res, ms));
const INVALID_ARTISTS = new Set(['', 'unknown', 'unknown artist']);
const VARIANT_TERMS = ['sped up', 'spedup', 'slowed', 'reverb', 'remix', 'lofi', 'lo-fi', 'nightcore'];
const TIME_BUCKETS = ['Morning', 'Afternoon', 'Evening', 'Late Night'];

async function fetchWithFallback(endpoint) {
    try {
        let res = await fetch(`${PRIMARY_API}${endpoint}`);
        if (res.status === 429 || !res.ok) throw new Error("Primary API Failed or Rate Limited");
        return res;
    } catch (e) {
        console.warn(`Primary API Error: ${e.message}. Falling back to secondary...`);
        try {
            let fallbackRes = await fetch(`${FALLBACK_API}${endpoint}`);
            if (!fallbackRes.ok) throw new Error("Fallback also failed");
            return fallbackRes;
        } catch (fallbackError) {
            console.error("TOTAL NETWORK FAILURE:", fallbackError);
            throw fallbackError; 
        }
    }
}

function decodeHtmlText(value) {
    return (value || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

function sanitizeArtistName(artist) {
    const value = (artist || '').trim();
    return INVALID_ARTISTS.has(value.toLowerCase()) ? '' : value;
}

function isKnownArtist(artist) {
    return !!sanitizeArtistName(artist);
}

function normalizeMatchString(value) {
    return decodeHtmlText(value)
        .toLowerCase()
        .replace(/[()[\]{}]/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeMatchString(value) {
    return normalizeMatchString(value).split(' ').filter(Boolean);
}

function containsVariantTerm(value) {
    const text = normalizeMatchString(value);
    return VARIANT_TERMS.some(term => text.includes(term.replace(/[^a-z0-9\s]/g, ' ').trim()));
}

function tokenSimilarity(a, b) {
    const aTokens = new Set(tokenizeMatchString(a));
    const bTokens = new Set(tokenizeMatchString(b));
    if (aTokens.size === 0 || bTokens.size === 0) return 0;

    let overlap = 0;
    aTokens.forEach(token => {
        if (bTokens.has(token)) overlap++;
    });

    return overlap / Math.max(aTokens.size, bTokens.size);
}

function getSongArtist(song) {
    return decodeHtmlText(song?.artists?.primary?.[0]?.name || song?.artists?.[0]?.name || song?.primaryArtists || '');
}

function scoreApiSongMatch(apiSong, sourceTitle, sourceArtist = '') {
    const resultTitle = decodeHtmlText(apiSong?.name || apiSong?.title || '');
    const resultArtist = getSongArtist(apiSong);
    const titleSimilarity = tokenSimilarity(sourceTitle, resultTitle);
    const artistSimilarity = isKnownArtist(sourceArtist) ? tokenSimilarity(sourceArtist, resultArtist) : 0;
    const queryHasVariant = containsVariantTerm(sourceTitle);
    const resultHasVariant = containsVariantTerm(resultTitle);
    const sameTitleBias = normalizeMatchString(resultTitle).includes(normalizeMatchString(sourceTitle)) ? 15 : 0;
    const artistBias = artistSimilarity * 35;
    const titleBias = titleSimilarity * 100;
    const variantPenalty = resultHasVariant && !queryHasVariant ? 150 : 0;

    return titleBias + artistBias + sameTitleBias - variantPenalty;
}

function pickBestApiMatch(results, sourceTitle, sourceArtist = '') {
    if (!Array.isArray(results) || results.length === 0) return null;

    const ranked = results
        .filter(song => Array.isArray(song?.downloadUrl) && song.downloadUrl.length > 0)
        .map(song => ({ song, score: scoreApiSongMatch(song, sourceTitle, sourceArtist) }))
        .sort((a, b) => b.score - a.score);

    return ranked[0]?.song || null;
}

function buildTimeBucketMap() {
    return { Morning: 0, Afternoon: 0, Evening: 0, 'Late Night': 0 };
}

function getDefaultAiModel() {
    return { songs: {}, artists: {} };
}

function loadAiUserModel() {
    try {
        const parsed = JSON.parse(localStorage.getItem('ai_user_model') || '{}');
        return {
            songs: parsed.songs || {},
            artists: parsed.artists || {}
        };
    } catch (e) {
        return getDefaultAiModel();
    }
}

function saveAiUserModel() {
    localStorage.setItem('ai_user_model', JSON.stringify(aiUserModel));
}

function getSongModelKey(song) {
    if (!song) return '';
    return (song.ytId || song.id || song.p || `${sanitizeArtistName(song.a)}::${normalizeMatchString(song.t)}`).toString();
}

function getTimeBucket(date = new Date()) {
    const hour = date.getHours();
    if (hour >= 5 && hour < 12) return 'Morning';
    if (hour >= 12 && hour < 17) return 'Afternoon';
    if (hour >= 17 && hour < 22) return 'Evening';
    return 'Late Night';
}

function ensureSongStats(song) {
    const key = getSongModelKey(song);
    if (!key) return null;
    if (!aiUserModel.songs[key]) {
        aiUserModel.songs[key] = {
            title: decodeHtmlText(song.t),
            artist: sanitizeArtistName(song.a),
            play_count: 0,
            skip_rate: 0,
            time_of_day: buildTimeBucketMap()
        };
    }
    return aiUserModel.songs[key];
}

function ensureArtistStats(artist) {
    const cleanArtist = sanitizeArtistName(artist);
    if (!cleanArtist) return null;
    if (!aiUserModel.artists[cleanArtist]) {
        aiUserModel.artists[cleanArtist] = {
            play_count: 0,
            skip_rate: 0,
            artist_affinity: 0,
            time_of_day: buildTimeBucketMap()
        };
    }
    return aiUserModel.artists[cleanArtist];
}

let aiUserModel = loadAiUserModel();
let currentListenSession = null;
let currentSongId = ""; 
let songSyncOffset = 0; 
let isEditing = false;
let isUserScrolling = false;
let lyricScrollTimeout; 

const audio = document.getElementById('player');
const lContent = document.getElementById('l-content');
const lView = document.getElementById('l-view');
const volSlider = document.getElementById('vol');

ipcRenderer.on('open-external-file', (event, filePath) => {
    const baseName = path.basename(filePath, '.mp3');
    let artist = "Unknown Artist", title = baseName;
    const dashIndex = baseName.indexOf('-');
    if (dashIndex !== -1) { artist = baseName.substring(0, dashIndex).trim(); title = baseName.substring(dashIndex + 1).trim(); }
    queue.push({ t: title, a: artist, p: filePath });
    draw(); saveState(); play(queue.length - 1);
});

window.addEventListener('load', () => {
        const btn = document.getElementById('btn-toggle-lyrics');
    document.body.classList.add('home-mode');
    
    // Start clean with current lyric settings
    if (btn) {
        btn.style.color = lyricsEnabled ? 'var(--accent)' : 'var(--dim)';
        btn.innerText = lyricsEnabled ? 'subtitles' : 'subtitles_off';
    }
    
    // Restore volume
    volSlider.value = localStorage.getItem('playerVol') || 1;
    audio.volume = volSlider.value;

    // ==========================================
    // NEW: RECOVER DUAL-QUEUE MEMORY
    // ==========================================
    const savedMode = localStorage.getItem('activeQMode');
    if (savedMode) {
        activeQMode = savedMode;
        // Parse saved data or default to empty arrays/0 if not found
        mainQueue = JSON.parse(localStorage.getItem('mainQueue') || '[]');
        mainIdx = parseInt(localStorage.getItem('mainIdx')) || 0;
        plQueue = JSON.parse(localStorage.getItem('plQueue') || '[]');
        plIdx = parseInt(localStorage.getItem('plIdx')) || 0;
        
        // Restore UI Buttons so the correct one stays "lit"
        const btnMain = document.getElementById('btn-q-main');
        const btnPl = document.getElementById('btn-q-pl');
        if (btnMain) btnMain.classList.toggle('active', activeQMode === 'main');
        if (btnPl) btnPl.classList.toggle('active', activeQMode === 'playlist');
    }

    // Recover the active queue to display in the sidebar/immersive view
    const savedQueue = localStorage.getItem('playerQueue');
    if(savedQueue) {
        queue = JSON.parse(savedQueue);
        curIdx = parseInt(localStorage.getItem('playerIdx')) || 0;
        draw();
        
        if(queue.length > 0) {
            const s = queue[curIdx];
            document.getElementById('cur-t').innerText = s.t;
            document.getElementById('cur-a').innerText = s.a;
            
            // Set tracking ID for sync/lyrics
            currentSongId = s.ytId || (s.a + " - " + s.t);
            updateToolIcons();

            if(s.isOnline) {
                audio.src = s.p;
                if (s.cover) {
                    document.getElementById('album-cover').src = s.cover;
                    document.getElementById('album-cover').style.display = "block";
                    document.getElementById('bg-blur').style.backgroundImage = `url(${s.cover})`;
                } else {
                    fallbackArt(s.t || 'Unknown');
                }
            } else {
                audio.src = encodeURI(`file://${s.p.replace(/\\/g, '/')}`);
                extractAlbumArt(s);
            }
            getLyrics(s);
            scrollToCurrentSong();
        }
    }
    
    // Pre-sync your sidebar playlist names
    if (typeof preloadSidebarPlaylistNames === 'function') {
        preloadSidebarPlaylistNames();
    }
    
    // Initialize recommendation engine
    if (typeof loadHomepage === 'function') {
        loadHomepage();
    }

});

// --- GLOBAL KEYBOARD SHORTCUTS ---
document.addEventListener('keydown', (e) => {
    // THE FIX: Ignore inputs EXCEPT when the user presses Escape!
    if ((e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && e.key.toLowerCase() !== 'escape') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch(e.key.toLowerCase()) {
        case 'escape': 
    e.preventDefault();
    // Blur whatever is focused
    if (document.activeElement) document.activeElement.blur();
    
    // Clear AND hide sidebar search
    const sidebarInput = document.getElementById('sidebar-search');
    const sidebarResults = document.getElementById('sidebar-search-results');
    if (sidebarInput) sidebarInput.value = '';
    if (sidebarResults) { sidebarResults.style.display = 'none'; sidebarResults.innerHTML = ''; }
    
    // Clear AND hide immersive search
    const immInput = document.getElementById('imm-search');
    const immDrop = document.getElementById('imm-search-results');
    if (immInput) immInput.value = '';
    if (immDrop) { immDrop.style.display = 'none'; immDrop.innerHTML = ''; }
    
    // Restore the normal queue after clearing search
    draw();
    break;
            
        case ' ': // Spacebar - Play/Pause
            e.preventDefault(); 
            togglePlay();
            break;

        case 'arrowleft': // Seek backward 10 seconds
            e.preventDefault();
            if (audio.duration) {
                audio.currentTime = Math.max(0, audio.currentTime - 0);
            }
            break;

        case 'arrowright': // Seek forward 10 seconds
            e.preventDefault();
            if (audio.duration) {
                audio.currentTime = Math.min(audio.duration, audio.currentTime + 0);
            }
            break;

        case 'arrowup': // Volume Up (5% increments)
            e.preventDefault();
            audio.volume = Math.min(1, audio.volume + 0.05);
            showToast(`Volume: ${Math.round(audio.volume * 100)}%`);
            // Update the slider UI to match the new volume
            if (volSlider) volSlider.value = audio.volume; 
            break;

        case 'arrowdown': // Volume Down (5% increments)
            e.preventDefault();
            audio.volume = Math.max(0, audio.volume - 0.05);
            showToast(`Volume: ${Math.round(audio.volume * 100)}%`);
            // Update the slider UI to match the new volume
            if (volSlider) volSlider.value = audio.volume; 
            break;

        case 'm': // M - Switch between Home and Player safely
            e.preventDefault();
            const playerView = document.getElementById('view-player');
            if (playerView && playerView.classList.contains('active')) {
                switchToHomeView(); // <--- Changed from switchView('home')
            } else {
                if (queue.length > 0) switchToPlayerView(); // <--- Changed from switchView('player')
            }
            break;

        case 'r': // R - Retry / Search Lyrics
            e.preventDefault();
            triggerRetryUI();
            break;

        case 's': // S - Focus Search Bar
            e.preventDefault();
            const isImmersive = document.body.classList.contains('immersive');
            const targetSearch = document.getElementById(isImmersive ? 'imm-search' : 'sidebar-search'); 
            if (targetSearch) targetSearch.focus();
            break;

        case 'x': // X - Block Lyrics
            e.preventDefault();
            const blockBtn = document.getElementById('btn-nolyrics'); 
            if (blockBtn) blockBtn.click();
            break;

        case 't': // T - Toggle Lyrics (FIXED: Now properly triggers the CPU mode toggle)
            e.preventDefault();
            toggleLyrics();
            break;
            
        case 'z': // Z - Shuffle Remaining (NEW)
            e.preventDefault();
            shuffleRemaining();
            showToast("Queue Shuffled! 🔀");
            break;
    }
});

volSlider.oninput = () => { audio.volume = volSlider.value; localStorage.setItem('playerVol', volSlider.value); };

function saveState() {
    // 1. Save the current active queue and index
    localStorage.setItem('playerQueue', JSON.stringify(queue));
    localStorage.setItem('playerIdx', curIdx);
    
    // 2. NEW: Save the Dual-Queue architecture!
    if (typeof activeQMode !== 'undefined') {
        localStorage.setItem('activeQMode', activeQMode);
        localStorage.setItem('mainQueue', JSON.stringify(mainQueue));
        localStorage.setItem('mainIdx', mainIdx);
        localStorage.setItem('plQueue', JSON.stringify(plQueue));
        localStorage.setItem('plIdx', plIdx);
    }
}   

function toggleClearMenu() {
    const menu = document.getElementById('clear-menu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}

function toggleImmersive() { document.body.classList.toggle('immersive'); scrollToCurrentSong();}

function clearQueue(type) {
    if(queue.length === 0) return;
    if(type === 'all') { const curr = queue[curIdx]; queue = [curr]; curIdx = 0; } 
    else if(type === 'recents') { queue.splice(0, curIdx); curIdx = 0; }
    draw(); saveState();
}

// --- HYBRID SEARCH LOGIC (LOCAL + GLOBAL) ---
let searchTimeout;
function filterQueue(query, targetId, isImmersive = false) {
    const target = document.getElementById(targetId);
    if (!target) return;

    // THE FIX: If the search bar is empty, hide results and clear UI instantly
    if (!query || query.trim() === '') {
        target.style.display = 'none';
        target.innerHTML = '';
        // If you were filtering the main queue-list, restore the normal list
        if (targetId === 'queue-list') draw(); 
        return;
    }

    target.style.display = 'block'; 
    const q = query.toLowerCase();
    
    // 1. Build Local UI
    let html = `<div style="padding:10px 10px 5px; color:var(--accent); font-size:0.75rem; font-weight:bold; letter-spacing:1px; text-transform:uppercase;">Local Queue</div>`;
    let localFound = false;
    queue.forEach((s, i) => {
        if(s.t.toLowerCase().includes(q) || s.a.toLowerCase().includes(q)) {
            localFound = true;
            let icon = s.isOnline ? "cloud" : "audiotrack";
            let encodedSong = encodeURIComponent(JSON.stringify(s));
            
            // 🔥 THE FIX: Added data-type and data-song hooks
            html += `
            <div class="item" data-type="local-search-result" data-song="${encodedSong}" onclick="playNextSearch(${i}, '${targetId}')" style="cursor:pointer;">
                <div class="item-left" style="display:flex; align-items:center;"><span class="material-icons-round" style="font-size:16px; margin-right:6px;">${icon}</span> <span style="margin:0; padding:0;">${s.t} - <small>${s.a}</small></span></div>
            </div>`;
        }
    });
    if (!localFound) html += `<div style="padding:10px; color:var(--dim); text-align:center; font-size: 0.85rem;">No local match</div>`;
    
    // ==========================================
    // 1.5 Build History UI (Deduplicated Search)
    // ==========================================
    let history = JSON.parse(localStorage.getItem('playHistory') || '[]');
    let historyMatches = history.filter(s => s.t.toLowerCase().includes(q) || (s.a && s.a.toLowerCase().includes(q)));
    
    if (historyMatches.length > 0) {
        html += `<div style="padding:15px 10px 5px; color:#b57bff; font-size:0.75rem; font-weight:bold; letter-spacing:1px; text-transform:uppercase; border-top:1px solid #333; margin-top:5px;">From Your History</div>`;
        
        // Show top 4 history matches
        historyMatches.slice(0, 4).forEach((s) => {
            let safeT = s.t ? s.t.replace(/'/g, "\\'").replace(/"/g, '&quot;') : 'Unknown';
            let safeA = s.a ? s.a.replace(/'/g, "\\'").replace(/"/g, '&quot;') : 'Unknown';
            let coverHtml = s.cover ? `<img src="${s.cover}" style="width:30px; height:30px; border-radius:4px; margin-right:10px; object-fit:cover;">` : `<span class="material-icons-round" style="font-size:16px; color:var(--dim); margin-right:10px;">history</span>`;
            let encodedSong = encodeURIComponent(JSON.stringify(s));
            
            // 🔥 THE FIX: Added data-type and data-song hooks, locked margins
            html += `
            <div class="item" data-type="history-search-result" data-song="${encodedSong}" onclick="playFromHistorySearch('${encodedSong}', '${targetId}')" style="cursor:pointer; border-left: 3px solid #b57bff; align-items: center; padding: 8px 10px;">
                ${coverHtml}
                <div style="flex:1; display:flex; flex-direction:column; justify-content:center; overflow:hidden; pointer-events:none;">
                    <div style="color:white; font-size:0.9rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin:0; padding:0;">${safeT}</div>
                    <div style="color:var(--dim); font-size:0.75rem; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin:0; padding:0;">${safeA}</div>
                </div>
            </div>`;
        });
    }

    // 2. Build Online UI Placeholder
    html += `<div style="padding:15px 10px 5px; color:var(--accent); font-size:0.75rem; font-weight:bold; letter-spacing:1px; text-transform:uppercase; border-top:1px solid #333; margin-top:5px;">Global Online Search</div>`;
    html += `<div id="${targetId}-online" style="max-height: 250px; overflow-y: auto; padding-right: 5px;"><div style="padding:15px; color:var(--dim); text-align:center; font-size: 0.85rem; display:flex; justify-content:center; align-items:center; gap:8px;">                <span class="material-icons-round" style="animation: spin 1s linear infinite;">sync</span> Searching the world...
            </div></div>`;

    target.innerHTML = html;

    // 3. Trigger Global Fetch (Debounced to 800ms)
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => fetchOnlineSearch(query, `${targetId}-online`), 800);
}

// ==========================================
// --- GLOBAL ONLINE SEARCH (JIOSAAVN API) ---
// ==========================================
async function fetchOnlineSearch(query, containerId) {
    const container = document.getElementById(containerId);
    if(!container) return;

    try {
        let res = await fetchWithFallback(`/search/songs?query=${encodeURIComponent(query)}&limit=40`);
        if (!res.ok) throw new Error("API Blocked");
        
        let json = await res.json();
        let results = (json.data && json.data.results) ? json.data.results : [];
        results = results
            .map(song => ({ song, score: scoreApiSongMatch(song, query) }))
            .filter(entry => entry.score > -120)
            .sort((a, b) => b.score - a.score)
            .map(entry => entry.song);

        if (results.length > 0) {
            let html = "";
            results.forEach(song => {
                let title = (song.name || "Unknown").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                
                let artist = "Unknown";
                if (song.artists && song.artists.primary && song.artists.primary.length > 0) {
                    artist = song.artists.primary[0].name.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                }

                let cover = song.image?.length > 0 ? song.image[song.image.length - 1].url : "";
                
                // 🔥 NEW: Use the safe URL selector!
                let downloadLink = getWorkingUrl(song.downloadUrl);

                if (downloadLink) {
                    let safeT = title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    let safeA = artist.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    let safeC = cover ? cover.replace(/'/g, "\\'").replace(/"/g, '&quot;') : '';
                    let safeDL = downloadLink.replace(/'/g, "\\'").replace(/"/g, '&quot;');

                    html += `
                    <div class="item" data-type="search-result" data-title="${safeT}" data-artist="${safeA}" data-cover="${safeC}" data-url="${safeDL}" data-ytid="${song.videoId || ''}" onclick="addNextOnline('${safeT}', '${safeA}', '${safeC}', '${safeDL}')" style="cursor:pointer; border-left: 3px solid #4cc2ff; align-items: center; padding: 8px 10px;">
                    <img src="${cover}" style="width:40px; height:40px; border-radius:6px; margin-right:12px; object-fit:cover; box-shadow: 0 4px 8px rgba(0,0,0,0.5);">
                    <div style="flex:1; display:flex; flex-direction:column; justify-content:center; overflow:hidden; pointer-events:none;">
                        <div style="color:white; font-size:0.95rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        <span class="material-icons-round" style="font-size:14px; color:var(--dim); vertical-align:middle; margin-right:4px;">cloud_download</span>${title}
                        </div>
                        <div style="color:var(--dim); font-size:0.8rem; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${artist}
                        </div>
                    </div>
                    </div>`;
                }
            });
            container.innerHTML = html || `<div style="padding:10px; color:var(--dim); text-align:center; font-size: 0.85rem;">No playable streams found.</div>`;
        } else {
            container.innerHTML = `<div style="padding:10px; color:var(--dim); text-align:center; font-size: 0.85rem;">No global results found.</div>`;
        }
    } catch (e) {
        container.innerHTML = `<div style="padding:10px; color:#ff4c4c; text-align:center; font-size: 0.85rem;">Online Search Offline (${e.message}). Try again.</div>`;
    }
}

function addNextOnline(title, artist, cover, url) {
    const newSong = { t: title, a: artist, p: url, isOnline: true, cover: cover, needsAudioStream: false };
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, newSong);
    
    const sideSearch = document.getElementById('sidebar-search');
    const immSearch = document.getElementById('imm-search');
    const sideResults = document.getElementById('sidebar-search-results');
    const immResults = document.getElementById('imm-search-results');

    if (sideSearch) sideSearch.value = '';
    if (immSearch) immSearch.value = '';
    if (sideResults) sideResults.style.display = 'none';
    if (immResults) immResults.style.display = 'none';

    draw(); 
    saveState();
    
    if (typeof switchToPlayerView === 'function') switchToPlayerView();
    
    // Play instantly
    if (queue.length === 1) play(0);
    else play(insertPos);
}

function play(i) {
    if (i < 0 || i >= queue.length) return;
    const nextSong = queue[i];
    if (typeof currentListenSession !== 'undefined' && currentListenSession && currentListenSession.key !== getSongModelKey(nextSong)) {
        if (typeof finalizeListeningSession === 'function') finalizeListeningSession('switch');
    }

    curIdx = i;
    const s = queue[i];

    if (typeof addToHistory === 'function') addToHistory(s);

    document.getElementById('cur-t').innerText = s.t;
    document.getElementById('cur-a').innerText = s.a;

    // 🔥 THE FIX: Wake the visualizer instantly every time a new song starts!
    if (typeof initRealVisualizer === 'function') initRealVisualizer();
    isDrawingWaveform = false;

    currentSongId = s.id || s.p;
    if (typeof updateToolIcons === 'function') updateToolIcons();
    draw(); 
    saveState();

    if (typeof scrollToCurrentSong === 'function') scrollToCurrentSong();

    if (s.isOnline) {
        const coverEl = document.getElementById('album-cover');
        if (s.cover) {
            coverEl.src = s.cover;
            coverEl.style.display = "block";
            document.getElementById('bg-blur').style.backgroundImage = `url(${s.cover})`;
        } else {
            if (typeof fallbackArt === 'function') fallbackArt(s.t || 'Unknown');
        }

        // 🔥 THE FIX: If it's an imported YT song with no audio URL, STOP and search JioSaavn!
        if (s.needsAudioStream && !s.p) {
            showToast(`Finding stream for: ${s.t}...`);
            (async () => {
                try {
                    // Build a clean search query — title + first artist only
                    const cleanArtist = (s.a || '').split(',')[0].trim();
                    const cleanTitle = (s.t || '')
                        .replace(/\(.*?\)|\[.*?\]/g, '')  // strip brackets
                        .replace(/\b(official|video|audio|lyric|lyrics|hd|hq|4k)\b/gi, '')
                        .replace(/\s+/g, ' ').trim();

                    // Try 3 progressively broader queries
                    const queries = [
                        `${cleanTitle} ${cleanArtist} official`,
                        `${cleanTitle} ${cleanArtist}`,
                        `${cleanTitle} official`,
                        `${cleanTitle}`
                    ];

                    let best = null;

                    for (const q of queries) {
                        if (best) break;
                        try {
                            let res = await fetchWithFallback(`/search/songs?query=${encodeURIComponent(q)}&limit=10`);
                            let json = await res.json();
                            let results = json.data?.results || [];

                            // Filter out remixes/versions UNLESS the original title explicitly has them
                            const titleHasVariant = containsVariantTerm(s.t);
                            if (!titleHasVariant) {
                                results = results.filter(r => {
                                    const rTitle = decodeHtmlText(r?.name || '');
                                    return !containsVariantTerm(rTitle);
                                });
                            }

                            // Score remaining results — title + artist both matter
                            const scored = results
                                .filter(r => Array.isArray(r?.downloadUrl) && r.downloadUrl.length > 0)
                                .map(r => {
                                    const rTitle = decodeHtmlText(r?.name || '');
                                    const rArtist = getSongArtist(r);
                                    const titleScore = tokenSimilarity(cleanTitle, rTitle) * 100;
                                    const artistScore = cleanArtist ? tokenSimilarity(cleanArtist, rArtist) * 60 : 0;
                                    // Bonus if artist name appears anywhere in result artist string
                                    const artistBonus = cleanArtist && rArtist.toLowerCase().includes(cleanArtist.toLowerCase()) ? 20 : 0;
                                    // Penalty for remix/slowed/sped when original doesn't have it
                                    const variantPenalty = (!titleHasVariant && containsVariantTerm(rTitle)) ? 200 : 0;
                                    return { r, score: titleScore + artistScore + artistBonus - variantPenalty };
                                })
                                .sort((a, b) => {
                                    const scoreDiff = b.score - a.score;
                                    if (Math.abs(scoreDiff) > 15) return scoreDiff;
                                    if (audio.duration > 0) {
                                        const dA = Math.abs((a.r.duration || 0) - audio.duration);
                                        const dB = Math.abs((b.r.duration || 0) - audio.duration);
                                        return dA - dB;
                                    }
                                    return scoreDiff;
                                });

                            // Only accept if score is good enough — prevents random song matches
                            if (scored.length > 0 && scored[0].score >45 ) {
                                best = scored[0].r;
                            }
                        } catch(e) { /* try next query */ }
                    }

                    const url = getWorkingUrl(best?.downloadUrl);
                    if (url) {
                        s.p = url;
                        s.needsAudioStream = false;
                        // Also update cover if we found a better one from JioSaavn
                        if (!s.cover && best?.image?.length > 0) {
                            s.cover = best.image[best.image.length - 1].url;
                            const coverEl = document.getElementById('album-cover');
                            if (coverEl) { coverEl.src = s.cover; coverEl.style.display = 'block'; }
                            document.getElementById('bg-blur').style.backgroundImage = `url(${s.cover})`;
                        }
                        saveState();
                        safePlay(s.p);
                        if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: s.t, artist: s.a });
                        if (typeof getLyrics === 'function') getLyrics(s);
                        if (typeof startListeningSession === 'function') startListeningSession(s);
                    } else {
                        showToast(`❌ No stream found for: ${s.t} — skipping`);
                        setTimeout(() => { if (typeof playNext === 'function') playNext(); }, 2000);
                    }
                } catch(e) {
                    showToast(`❌ Stream error: ${s.t}`);
                    setTimeout(() => { if (typeof playNext === 'function') playNext(); }, 2000);
                }
            })();
            return;
        }else {
            tryPlayWithRetry(s, 0);
        }

    } else {
        safePlay(encodeURI(`file://${s.p.replace(/\\/g, '/')}`).replace(/#/g, '%23').replace(/\?/g, '%3F'));
        if (typeof extractAlbumArt === 'function') extractAlbumArt(s);
    }

    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: s.t, artist: s.a });
    if (typeof getLyrics === 'function') getLyrics(s);
    if (typeof startListeningSession === 'function') startListeningSession(s);
}

// Helper function to add the clicked YT Music song to your queue
function addOnlineSong(encodedSong) {
    const s = JSON.parse(decodeURIComponent(encodedSong));
    
    // 1. THE FIX: Insert right after the current song instead of at the bottom!
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, s);
    
    // 2. Close the search dropdowns
    const sideSearch = document.getElementById('sidebar-search-results');
    const immSearch = document.getElementById('imm-search-results');
    if (sideSearch) sideSearch.style.display = 'none';
    if (immSearch) immSearch.style.display = 'none';
    
    // 3. Clear input text
    if (document.getElementById('sidebar-search')) document.getElementById('sidebar-search').value = '';
    if (document.getElementById('imm-search')) document.getElementById('imm-search').value = '';
    
    // 4. Save and Play immediately
    draw();
    saveState();
    play(insertPos);
}



function playNextSearch(index, targetId) {
    // 1. UI Cleanup - Clear inputs and hide results
    const searchInputs = ['sidebar-search', 'imm-search'];
    searchInputs.forEach(id => { 
        const el = document.getElementById(id); 
        if(el) el.value = ''; 
    });
    
    const resultsDivs = ['sidebar-search-results', 'imm-search-results'];
    resultsDivs.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.style.display = 'none';
    });

    // 2. THE FIX: Move the song from its old position to curIdx + 1
    if (index === curIdx) return; // It's already playing

    const [selectedSong] = queue.splice(index, 1); // Remove from old spot
    if (index < curIdx) curIdx--; // Adjust current index if we removed a song from above it

    queue.splice(curIdx + 1, 0, selectedSong); // Insert right after current song

    // 3. Play the song we just moved
    play(curIdx + 1);

    draw();
    saveState();
}

// --- TRACKPAD SWIPE & KEYBOARD CONTROLS ---
let swipeCooldown = false;

window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    if (e.key === 'MediaTrackNext') playNext();
    if (e.key === 'MediaTrackPrevious') playPrev();
    if (e.key === 'MediaPlayPause') togglePlay();

    if (e.key === 'ArrowUp') {
    e.preventDefault(); 
    audio.volume = Math.min(1, audio.volume + 0.05);
    volSlider.value = audio.volume;
    localStorage.setItem('playerVol', audio.volume);
    }
    if (e.key === 'ArrowDown') {
    e.preventDefault(); 
    audio.volume = Math.max(0, audio.volume - 0.05);
    volSlider.value = audio.volume;
    localStorage.setItem('playerVol', audio.volume);
    }
    if (e.key === 'ArrowRight') {
    if(audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
    }
    if (e.key === 'ArrowLeft') {
    if(audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10);
    }
});

if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
}

function dragStart(e, i) { 
    e.dataTransfer.setData('text/plain', i); 
    // Ghost effect
    setTimeout(() => e.target.style.opacity = '0.01', 0); 
}

function dragEnd(e) { 
    e.target.style.opacity = '1'; 
    draw(); 
}

function dragOver(e) { 
    e.preventDefault(); 
    
    // 1. YOUR ORIGINAL FEATURE: Auto-scroll the list if you drag near the edges
    const container = e.currentTarget.closest('.list-container');
    if(container) {
    const cRect = container.getBoundingClientRect();
    const y = e.clientY - cRect.top;
    if(y < 60) container.scrollTop -= (60 - y) * 0.4; 
    else if(y > cRect.height - 60) container.scrollTop += (y - (cRect.height - 60)) * 0.4; 
    }

    // 2. NEW FEATURE: Perfect blue line placement using box-shadow
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientY > rect.top + rect.height / 2) {
    e.currentTarget.style.boxShadow = '0 2px 0 var(--accent)';
    } else {
    e.currentTarget.style.boxShadow = '0 -2px 0 var(--accent)';
    }
}

function dragLeave(e) { 
    e.currentTarget.style.boxShadow = ''; 
}

function drop(e, i) {
    e.preventDefault(); 
    e.stopPropagation();
    e.currentTarget.style.boxShadow = '';
    
    const fromText = e.dataTransfer.getData('text/plain');
    
    // 3. YOUR ORIGINAL FEATURE: If it's a file from your desktop, insert it!
    if (!fromText && e.dataTransfer.files.length > 0) {
    insertFilesAt(e.dataTransfer.files, i);
    return;
    }

    // 4. NEW FEATURE: Perfect Reordering Math
    const from = parseInt(fromText);
    if (from === i || isNaN(from)) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    let insertAt = i;
    
    if (e.clientY > rect.top + rect.height / 2) insertAt++;
    if (from < insertAt) insertAt--;
    if (from === insertAt) return; 

    const [moved] = queue.splice(from, 1);
    queue.splice(insertAt, 0, moved);
    
    if (curIdx === from) curIdx = insertAt; 
    else if (from < curIdx && insertAt >= curIdx) curIdx--; 
    else if (from > curIdx && insertAt <= curIdx) curIdx++;
    
    draw(); saveState();
}

function updateToolIcons() {
    const isBlocked = localStorage.getItem('noLyr_' + currentSongId);
    document.getElementById('btn-nolyrics').classList.toggle('active', !!isBlocked);
    document.getElementById('btn-nolyrics').style.color = isBlocked ? '#ff4c4c' : '';
    
    songSyncOffset = parseFloat(localStorage.getItem('sync_' + currentSongId)) || 0;
    document.getElementById('sync-val').value = (songSyncOffset > 0 ? '+' : '') + songSyncOffset.toFixed(1) + 's';
}

function toggleNoLyrics() {
    let block = localStorage.getItem('noLyr_' + currentSongId);
    if(block) {
    localStorage.removeItem('noLyr_' + currentSongId);
    getLyrics(queue[curIdx]); 
    } else {
    localStorage.setItem('noLyr_' + currentSongId, "true");
    lyrics = [];
    lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter:blur(0)">Lyrics permanently disabled for this track.</p>';
    }
    updateToolIcons();
}

function toggleSyncUI() {
    const ui = document.getElementById('sync-ui');
    ui.style.display = ui.style.display === 'flex' ? 'none' : 'flex';
    document.getElementById('btn-sync').classList.toggle('active');
}

// --- HOLD TO SYNC LOGIC ---
let syncHoldInterval;

function startSync(val) {
    adjSync(val); // Fire once immediately on click
    
    // If they keep holding it down, fire it repeatedly every 150 milliseconds
    syncHoldInterval = setInterval(() => {
        adjSync(val);
    }, 150); 
}

function stopSync() {
    clearInterval(syncHoldInterval); // Stop firing when they let go or drag the mouse away
}

function manualSyncInput(val) {
// Strip out the "s" and other text
let numericVal = parseFloat(val.replace(/[^\d.-]/g, ''));

if (isNaN(numericVal)) {
    // Reset UI to current state if input is invalid
    document.getElementById('sync-val').value = (songSyncOffset > 0 ? '+' : '') + songSyncOffset.toFixed(1) + 's';
    return;
}

// Update global variable and save to storage
songSyncOffset = numericVal;
localStorage.setItem('sync_' + currentSongId, songSyncOffset.toFixed(1));

// Refresh UI to show the clean formatted string
document.getElementById('sync-val').value = (songSyncOffset > 0 ? '+' : '') + songSyncOffset.toFixed(1) + 's';
showToast(`Sync offset saved: ${songSyncOffset.toFixed(1)}s`);
}

function adjSync(val) {
// 1. Update the math
songSyncOffset += val;

// 2. Save the preference for this specific song
localStorage.setItem('sync_' + currentSongId, songSyncOffset.toFixed(1));

// 3. Update the INPUT field value (using .value instead of .innerText)
const input = document.getElementById('sync-val');
if (input) {
    // We keep your logic for showing the '+' sign for positive numbers
    input.value = (songSyncOffset > 0 ? '+' : '') + songSyncOffset.toFixed(1) + 's';
}
}

function getCleanTitle(s) {
    // The new .replace(/_/g, ' ') translates underscores into spaces behind the scenes!
    return s.t.replace(/\(.*\)|\[.*\]|\{.*\}/g, '')
            .replace(/lyrical|audio|video|official/gi, '')
            .replace(/_/g, ' ') 
            .trim();
}

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
        // Include duration here as well to filter the retry list correctly
        const dur = audio.duration > 0 ? `&duration=${Math.round(audio.duration)}` : '';
        let res = await fetch(`https://lrclib.net/api/search?q=${q}${dur}`, { headers });
        if (!res.ok) throw new Error("Database offline");
        
        let data = await res.json();
        if (!data) data = [];
        
        // THE FIX: Adjust slicing to guarantee spots for plain text lyrics
        let timed = data.filter(d => d.syncedLyrics);
        let plain = data.filter(d => !d.syncedLyrics && d.plainLyrics);
        
        // Show up to 4 timed and at least 2 plain text if they exist
        currentRetryData = [...timed.slice(0, 4), ...plain.slice(0, 2)];

        if(currentRetryData.length === 0) {
            container.innerHTML = `
                <p style="padding:30px; color:var(--dim); text-align:center">No alternative lyrics found in database.</p>
                ${aiRetryButtonHTML}
            `;
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
            const durText = result.duration ? `${Math.floor(result.duration/60)}:${Math.floor(result.duration%60).toString().padStart(2,'0')}` : '?:??';

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

    } catch(e) {
        container.innerHTML = `<p style="padding:50px; color:#ff4c4c; text-align:center">App Error: ${e.message}</p>`;
    }
}

function selectRetryLyrics() {
    if(selectedRetryIndex === null || !currentRetryData[selectedRetryIndex]) return;

    const result = currentRetryData[selectedRetryIndex];
    // FIX: Accept plain text if synced is not available
    const finalLyrics = result.syncedLyrics || result.plainLyrics;
    const s = queue[curIdx];

    if(!finalLyrics) {
        alert("This version has no text at all. Cannot select.");
        return;
    }

    if (!s.isOnline) {
        const lDir = path.join(path.dirname(s.p), 'Lyrics');
        const lPath = path.join(lDir, s.a + ' - ' + getCleanTitle(s) + '.lrc');
        if(!fs.existsSync(lDir)) fs.mkdirSync(lDir);
        fs.writeFileSync(lPath, finalLyrics);
    } else {
        localStorage.setItem('lyric_custom_' + (s.id || s.p), finalLyrics);
    }
    
    show(finalLyrics);
    localStorage.removeItem('apiEmpty_' + (s.id || s.p)); 
    closeRetryPreview();
    exitRetryUI();
}

function exitRetryUI() {
    document.body.classList.remove('retry-mode');
    if(audio.duration && lyricsEnabled) document.body.classList.add('immersive'); 
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

function toggleEditMode() {
    const btn = document.getElementById('btn-edit');
    
    if (!isEditing) {
    if(lyrics.length === 0) return; 
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
    
    // Save logic isolated for Local vs Online
    if (!s.isOnline) {
        const lDir = path.join(path.dirname(s.p), 'Lyrics');
        if(!fs.existsSync(lDir)) fs.mkdirSync(lDir);
        const lPath = path.join(lDir, s.a + ' - ' + getCleanTitle(s) + '.lrc');
        fs.writeFileSync(lPath, newLrc);
    } else {
        // Store edits for online tracks in local app memory instead of hard drive folders
        localStorage.setItem('lyric_custom_' + currentSongId, newLrc);
    }
    
    localStorage.removeItem('noLyr_' + currentSongId); 
    updateToolIcons();
    
    btn.innerText = 'edit';
    btn.classList.remove('active');
    btn.style.color = '';
    btn.style.textShadow = 'none';
    
    show(newLrc); 
    }
}

function insertFilesAt(files, index) {
    const news = Array.from(files).filter(f => f.name.endsWith('.mp3')).map(f => {
    const fullPath = webUtils.getPathForFile(f); 
    const baseName = f.name.replace('.mp3', '');
    let artist = "Unknown Artist", title = baseName;
    const dashIndex = baseName.indexOf('-');
    if (dashIndex !== -1) { artist = baseName.substring(0, dashIndex).trim(); title = baseName.substring(dashIndex + 1).trim(); }
    return { t: title, a: artist, p: fullPath };
    });

    if(news.length > 0) {
    const wasEmpty = queue.length === 0;
    queue.splice(index, 0, ...news); 
    if (!wasEmpty && index <= curIdx) curIdx += news.length; 
    draw(); saveState();
    if(wasEmpty) play(0);
    
    setTimeout(() => {
        const qList = document.getElementById('queue-list');
        const hList = document.getElementById('hover-queue-list');
        if(qList && qList.children[index]) qList.children[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
        if(hList && hList.children[index]) hList.children[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    }
}

document.getElementById('fld').onchange = (e) => { insertFilesAt(e.target.files, queue.length); e.target.value = ''; };
document.getElementById('fls').onchange = (e) => { insertFilesAt(e.target.files, queue.length); e.target.value = ''; };
document.getElementById('fls-next').onchange = (e) => { 
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    insertFilesAt(e.target.files, insertPos); 
    e.target.value = ''; 
};

const sidebarEl = document.querySelector('.yt-sidebar');
if (sidebarEl) {
    sidebarEl.addEventListener('dragover', e => e.preventDefault());
    sidebarEl.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        if (draggedIdx === null && e.dataTransfer.files.length > 0) insertFilesAt(e.dataTransfer.files, queue.length);
    });
}

// --- AUTO-SCROLL QUEUE (HYBRID MATH FIX) ---
function scrollToCurrentSong() {
    if(queue.length === 0) return;
    
    setTimeout(() => {
        const qList = document.getElementById('queue-list');
        const hList = document.getElementById('hover-queue-list');
        
        // 1. Let the browser handle the main queue naturally
        if (qList && qList.children[curIdx]) {
            qList.children[curIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        
        // 2. Use pure math for the side queue so the browser doesn't slide it on-screen!
        if (hList && hList.children[curIdx]) {
            const item = hList.children[curIdx];
            hList.scrollTo({
                top: item.offsetTop - (hList.clientHeight / 2) + (item.clientHeight / 2),
                behavior: 'smooth'
            });
        }
    }, 150);
}

// ==========================================
// --- SMART MARQUEE STATE (HIGH EFFICIENCY) ---
// ==========================================
// Define the observer globally ONCE so it never crashes on startup
const marqueeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        const el = entry.target;
        if (entry.isIntersecting) {
            // ONLY measure pixels if the song is physically visible on screen
            if (el.scrollWidth > el.clientWidth + 4) el.classList.add('marquee-active');
            else el.classList.remove('marquee-active');
        } else {
            // Stop animations for songs off-screen to save CPU and RAM
            el.classList.remove('marquee-active'); 
        }
    });
}, { root: null, rootMargin: '50px' });

function syncMarqueeState(el) {
    if (!el) return;
    marqueeObserver.observe(el);
}

// High-Efficiency Hover Marquee Checker (Zero Lag!)
document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.q-title, .q-artist, .display-title, .display-artist');
    if (!target) return;

    // Only apply animation if the text physically overflows its box
    if (target.scrollWidth > target.clientWidth + 2) {
        target.classList.add('marquee-active');
    }
});

document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('.q-title, .q-artist, .display-title, .display-artist');
    if (target) target.classList.remove('marquee-active');
});


// Update draw() to disconnect and reconnect efficiently
function draw() {
    const sideSearch = document.getElementById('sidebar-search');
    const searchTerm = sideSearch ? sideSearch.value : '';
    if(searchTerm) return; 
    
    const qList = document.getElementById('queue-list');
    const hList = document.getElementById('hover-queue-list');
    const qScroll = qList ? qList.scrollTop : 0;
    const hScroll = hList ? hList.scrollTop : 0;

    // Disconnect the observer before wiping the HTML to prevent memory leaks
    marqueeObserver.disconnect();

    const html = queue.map((s, i) => {
    let icon = s.isOnline ? "cloud" : "drag_indicator";
    return `
        <div class="item ${i===curIdx?'active':''}" data-type="queue-item" data-index="${i}" draggable="true" ondragstart="dragStart(event, ${i})" ondragend="dragEnd(event)" ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="drop(event, ${i})" onclick="play(${i})">
            <div class="item-left">
                <span class="material-icons-round drag-handle">${icon}</span>
                <div class="queue-text-wrap">
                    <div class="q-title">${i+1}. ${s.t}</div>
                    <div class="q-artist">${s.a || 'Unknown Artist'}</div>
                </div>
            </div>
            <div class="del-btn" onclick="event.stopPropagation(); queue.splice(${i}, 1); if(${i} < curIdx) curIdx--; else if(${i} === curIdx && queue.length > 0) play(curIdx >= queue.length ? 0 : curIdx); draw(); saveState();">✕</div>
        </div>
    `}).join('');
    
    if(qList) qList.innerHTML = html;
    if(hList) hList.innerHTML = html;
    
    if(qList) qList.scrollTop = qScroll;
    if(hList) hList.scrollTop = hScroll;

    // Pass only the newly created queue text to the observer
    document.querySelectorAll('.q-title, .q-artist').forEach(syncMarqueeState);
}

function getWorkingUrl(downloadUrlArr) {
    if (!downloadUrlArr || !Array.isArray(downloadUrlArr)) return "";

    // Try best → worst (No forced proxy bypasses)
    const order = ['320kbps', '160kbps', '96kbps', '48kbps'];

    for (let q of order) {
        const found = downloadUrlArr.find(x => x.quality === q);
        if (found && found.url) return found.url;
    }

    // Fallback
    return downloadUrlArr[0]?.url || "";
}

function safePlay(url) {
    const audio = document.getElementById('player');
    audio.pause();
    audio.removeAttribute('src'); 
    
    if (!url || url.trim() === '') return false;

    // Notice: No setTimeout! It plays instantly.
    audio.src = url;
    audio.load();
    let playPromise = audio.play();
    if (playPromise !== undefined) {
        playPromise.catch(e => {
            console.warn("Playback interrupted (safe to ignore if rapidly skipping)");
        });
    }
    return true;
}

let isCircuitBreakerActive = false;

function tryPlayWithRetry(song, attempt) {
    if (isCircuitBreakerActive) return; // Stop cascading failures
    const audio = document.getElementById('player');

    if (attempt > 1) {
        console.error("All retries failed");
        showToast("❌ Network Error. Pausing playback to prevent spam.");
        isCircuitBreakerActive = true; 
        setTimeout(() => { isCircuitBreakerActive = false; }, 5000); // Cool down for 5 seconds
        return;
    }

    const playAttempt = safePlay(song.p);
    
    // If safePlay rejected the URL because it was empty, immediately trigger the error logic
    if (!playAttempt) {
        audio.dispatchEvent(new Event('error'));
        return;
    }

    audio.onerror = async () => {
        if (isCircuitBreakerActive) return;
        console.log("Stream failed, Retrying... Attempt:", attempt + 1);
        try {
            let res = await fetchWithFallback(`/search/songs?query=${encodeURIComponent(song.t + " " + song.a)}&limit=1`);
            let json = await res.json();
            const results = json.data?.results || json.data?.songs?.results || [];
            let newSong = pickBestApiMatch(results, song.t, song.a);
            let newUrl = getWorkingUrl(newSong?.downloadUrl);

            if (newUrl) {
                song.p = newUrl;
                saveState(); 
                tryPlayWithRetry(song, attempt + 1);
            } else {
                throw new Error("No URL found in fallback");
            }
        } catch (e) {
            console.error("Retry completely failed:", e);
            showToast("❌ Track unavailable right now.");
            isCircuitBreakerActive = true;
            setTimeout(() => { 
                isCircuitBreakerActive = false; 
                if (typeof playNext === 'function') playNext(); 
            }, 3000); // Wait 3 full seconds before skipping to save CPU
        }
    };
}

// MUST have the word 'async' here!


function extractAlbumArt(song) {
    const coverImg = document.getElementById('album-cover');
    const bgBlur = document.getElementById('bg-blur');
        fetch(encodeURI(`file://${song.p.replace(/\\/g, '/')}`).replace(/#/g, '%23').replace(/\?/g, '%3F')).then(res => res.blob()).then(blob => {
        window.jsmediatags.read(blob, {
        onSuccess: function(tag) {
            const picture = tag.tags.picture;
            if (picture) {
            let b64 = ""; const bytes = new Uint8Array(picture.data);
            for (let i = 0; i < bytes.byteLength; i++) b64 += String.fromCharCode(bytes[i]);
            const b = "data:" + picture.format + ";base64," + window.btoa(b64);
            coverImg.src = b; coverImg.style.display = "block"; bgBlur.style.backgroundImage = `url(${b})`;
            } else fallbackArt(song.t);
        },
        onError: () => fallbackArt(song.t)
        });
    }).catch(() => fallbackArt(song.t));
}

function fallbackArt(title) {
    let hash = 0;
    for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
    const c1 = `hsl(${hash % 360}, 70%, 50%)`, c2 = `hsl(${(hash + 40) % 360}, 80%, 30%)`;
    const cover = document.getElementById('album-cover');
    cover.style.display = "none";
    cover.removeAttribute('src');
    document.getElementById('bg-blur').style.backgroundImage = `linear-gradient(45deg, ${c1}, ${c2})`;
}

// --- TOGGLE LYRICS ---
function toggleLyrics() {
    lyricsEnabled = !lyricsEnabled;
    localStorage.setItem('lyricsEnabled', lyricsEnabled);
    
    const btn = document.getElementById('btn-toggle-lyrics');
    if (btn) {
    btn.style.color = lyricsEnabled ? 'var(--accent)' : 'var(--dim)';
    btn.innerText = lyricsEnabled ? 'subtitles' : 'subtitles_off';
    }

    if (lyricsEnabled) {
    // FIX: Inject into lContent, NOT l-view, so we don't destroy the lyrics container!
    lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter:blur(0)">Waking up lyrics...</p>';
    
    if (typeof queue !== 'undefined' && queue.length > 0 && queue[curIdx]) {
        setTimeout(() => {
        getLyrics(queue[curIdx]);
        }, 50);
    } else {
        lContent.innerHTML = '<div style="padding:20px; text-align:center; color:var(--dim);">No song currently playing.</div>';
    }
    } else {
    lyrics = [];
    lContent.innerHTML = `<div style="padding: 20px; color: var(--dim); text-align: center; margin-top: 50%; transform: translateY(-50%); font-size: 0.95rem;">Lyrics are disabled to save power.<br><span style="font-size: 0.8rem; opacity: 0.7;">Click the <span class="material-icons-round" style="font-size: 16px; vertical-align: middle;">subtitles_off</span> button to enable.</span></div>`;
    }
}

// --- 10 MINUTE INACTIVITY FADE ---
let inactivityTimer;

function resetInactivityTimer() {
    const pBar = document.querySelector('.player-bar');
    if (!pBar) return;

    // Wake up the UI instantly
    if (pBar.classList.contains('idle')) {
        pBar.classList.remove('idle');
    }
    
    clearTimeout(inactivityTimer);
    
    // 600,000 milliseconds = exactly 10 minutes
    inactivityTimer = setTimeout(() => {
        pBar.classList.add('idle');
    }, 300000); 
}

// Any human interaction resets the clock
window.addEventListener('mousemove', resetInactivityTimer);
window.addEventListener('mousedown', resetInactivityTimer);
window.addEventListener('keydown', resetInactivityTimer);
window.addEventListener('focus', resetInactivityTimer); // Triggers when you Alt-Tab back to the app

// Start the clock when the app opens
resetInactivityTimer();

// --- TRUE BACKGROUND AI CONTROLS & QUEUE ---
let aiWorker = null;
let aiTaskQueue = [];
let isAIBusy = false;
let currentAITask = null;

// Helper to update both AI buttons at once AND control the global floating spinner
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

    // --- NEW: Floating Global Background Spinner Logic ---
    let indicator = document.getElementById('ai-task-indicator');
    if (!indicator) {
        // Dynamically create the UI element if it doesn't exist yet
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

// --- THE TIMESTAMP HIJACKER (ANCHORED INTERPOLATION) ---
function smartSyncPlainLyrics(aiLrc, plainText, audioDuration) {
    if (!plainText || plainText.trim().length === 0) return aiLrc; 
    
    const timeRegex = /\[(\d{2}:\d{2}\.\d{2,3})\](.*)/;
    let aiLines = aiLrc.split('\n').map(l => {
        let m = l.match(timeRegex);
        if(!m) return null;
        let timeSec = parseInt(m[1].split(':')[0]) * 60 + parseFloat(m[1].split(':')[1]);
        return { timeStr: m[1], timeSec: timeSec, clean: m[2].toLowerCase().replace(/[^\w\s]/g, ' ') };
    }).filter(Boolean);

    if(aiLines.length === 0) return aiLrc;

    let plainLines = plainText.split('\n').map(l => l.trim()).filter(l => l && !l.includes("Waking up") && !l.includes("Searching") && !l.includes("Only plain text") && !l.includes("No lyrics found") && !l.includes("AI is generating"));
    if (plainLines.length === 0) return aiLrc;

    let mapped = [];
    let aiIndex = 0;
    let lastTimeSec = -1;
    const stopWords = ['a', 'the', 'and', 'but', 'or', 'for', 'in', 'is', 'it', 'you', 'i', 'my', 'me', 'yeah', 'oh', 'ooh', 'ah', 'to', 'of', 'on'];

    // PASS 1: Anchor the obvious matches
    for (let i = 0; i < plainLines.length; i++) {
        let pLine = plainLines[i];
        let pClean = pLine.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
        if(!pClean) {
            mapped.push({ text: pLine, timeSec: null });
            continue;
        }

        let bestMatchIdx = -1;
        let bestScore = 0;

        let pWords = pClean.split(/\s+/).filter(w => w.length > 1 && !stopWords.includes(w));
        if (pWords.length === 0) pWords = pClean.split(/\s+/).filter(w => w.length > 0); 

        for (let j = aiIndex; j < Math.min(aiIndex + 6, aiLines.length); j++) {
            let aClean = aiLines[j].clean;
            let matchCount = pWords.reduce((acc, w) => aClean.includes(w) ? acc + 1 : acc, 0);
            let score = matchCount / pWords.length;
            let timeDiff = aiLines[j].timeSec - lastTimeSec;

            // Must match, must move forward, max jump 20s
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
            mapped.push({ text: pLine, timeSec: null }); // Leave missing lines blank for Pass 2
        }
    }

    // PASS 2: The Rubber Band (Interpolate the missing gaps)
    let result = [];
    let finalAudioDur = audioDuration || (aiLines[aiLines.length-1].timeSec + 10);

    for (let i = 0; i < mapped.length; i++) {
        if (mapped[i].timeSec === null) {
            // Find the last known time before this
            let prevTime = 0;
            for (let j = i - 1; j >= 0; j--) {
                if (mapped[j].timeSec !== null) { prevTime = mapped[j].timeSec; break; }
            }

            // Find the next known time ahead of this
            let nextTime = finalAudioDur;
            let nextIdx = mapped.length;
            for (let j = i + 1; j < mapped.length; j++) {
                if (mapped[j].timeSec !== null) { nextTime = mapped[j].timeSec; nextIdx = j; break; }
            }

            // Evenly divide the time between the gap
            let gapCount = (nextIdx - i) + 1; 
            let timeGap = (nextTime - prevTime) / gapCount;

            // Speed limit safeguard (don't stretch too far if it's the end of the song)
            if (timeGap > 4) timeGap = 2.5;

            mapped[i].timeSec = prevTime + timeGap;
        }

        // Format and push to final result
        let t = mapped[i].timeSec;
        let m = Math.floor(t / 60).toString().padStart(2, '0');
        let s = (t % 60).toFixed(2).padStart(5, '0');
        result.push(`[${m}:${s}] ${mapped[i].text}`);
    }

    return result.join('\n');
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
        if(!fs.existsSync(lDir)) fs.mkdirSync(lDir);
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

function triggerManualAIGeneration() {
    const song = queue[curIdx];
    if (!song) return;

    // Prevent double-clicking or adding a song that's already waiting!
    if (currentAITask?.p === song.p || aiTaskQueue.some(t => t.song.p === song.p)) {
        showToast("Already in AI queue!");
        return;
    }

    // THE SCRAPE: Grab the perfect plain text right off the UI before the AI starts!
    const plainTextElements = document.querySelectorAll('#l-content .lyric-line');
    const originalPlainText = Array.from(plainTextElements).map(p => p.innerText).join('\n');

    // Add to Queue
    aiTaskQueue.push({ song: song, plainText: originalPlainText, duration: audio.duration });

    updateAIButtons('block', 'AI is queued...', true);
    
    if (!isAIBusy) {
        showToast("✨ AI started! You can safely switch songs.");
        processNextAITask();
    } else {
        showToast(`Added to AI Queue (Position: ${aiTaskQueue.length})`);
    }
}



async function generateAILyrics(song) {
    try {
        updateAIButtons('block', 'AI Engine is running...', true);
        
        // Tells the Node/C++ backend to handle all the heavy lifting!
        const result = await ipcRenderer.invoke('transcribe-audio', song.p);
        
        if (result.status === 'success') {
            return { lrc: result.lrc, song: song };
        } else {
            // Extracts the exact crash reason from main.js if FFmpeg or main.exe fails
            throw new Error(result.message || result.details || "Transcription failed");
        }
    } catch (error) {
        console.error("Renderer AI Error:", error);
        throw error;
    }
}

// IPC handler for status updates from main process
ipcRenderer.on('ai-transcription-status', (event, { status, message, songPath }) => {
  // Only update UI if the message is for the currently playing song
  if (queue[curIdx] && (queue[curIdx].p === songPath || queue[curIdx].id === songPath || queue[curIdx].ytId === songPath)) {
    if (status === 'loading' || status === 'transcribing') {
      updateAIButtons('block', message, true);
      lContent.innerHTML = `<p class="lyric-line" style="opacity: 1; filter: blur(0px);">${message}</p>`;
    } else if (status === 'error') {
      showToast(`AI Error for "${currentAITask?.t || 'song'}": ${message}`);
      updateAIButtons('block', 'Retry AI Generation', false);
      lContent.innerHTML = `<p class="lyric-line" style="opacity: 1; filter:blur(0); color:#ff4c4c;">AI Error: ${message}</p>`;
    } else if (status === 'done') {
      // This case is handled by the `generateAILyrics` promise resolution
      // No need to update buttons here as it will be reset by the `processNextAITask` cleanup
    }
  }
});

// --- FETCH LYRICS ---
async function getLyrics(s) {
  if (!lyricsEnabled) {
    lyrics = [];
    lContent.innerHTML = `<div style="padding: 20px; color: var(--dim); text-align: center; margin-top: 50%; transform: translateY(-50%); font-size: 0.95rem;">Lyrics are disabled to save power.</div>`;
    return;
  }

  try {
    const cSongId = s.id || s.p; 
    
    lyrics = []; 
    lyrIdx = -1;
    
    if(localStorage.getItem('noLyr_' + cSongId)) {
      lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter:blur(0)">Lyrics disabled for this track.</p>';
      return;
    }
    
    let cleanTitle = getCleanTitle(s);
    let lDir, lPath;
    
    // 1. Local Read
    if (!s.isOnline) {
      lDir = path.join(path.dirname(s.p), 'Lyrics');
      lPath = path.join(lDir, s.a + ' - ' + cleanTitle + '.lrc');
      if(fs.existsSync(lPath)) { 
          show(fs.readFileSync(lPath, 'utf8')); 
          return;
      }
    } else {
      const savedCustom = localStorage.getItem('lyric_custom_' + cSongId);
      if (savedCustom) { show(savedCustom); return; }
    }

    if(s.isOnline && localStorage.getItem('apiEmpty_' + cSongId)) {
       lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter:blur(0)">No lyrics in database.</p>';
       return;
    }

    lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter: blur(0px);">Searching the database...</p>';
    
    const headers = { 'User-Agent': 'ProMediaPlayer/1.0.0 (https://github.com/mahitmass/music_with_LYRICS)' };
    
    // THE FIX: Include duration in the search query to handle extended/radio edits correctly
    const durationParam = audio.duration > 0 ? `&duration=${Math.round(audio.duration)}` : '';
    let res = await fetch(`https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(s.a || '')}${durationParam}`, { headers });
    
    if (res.status === 429 || res.status === 403) {
      lContent.innerHTML = '<p class="lyric-line" style="opacity:1; color:#ff4c4c;">API Cooldown. Waiting...</p>'; return;
    }
    
    if (!res.ok) throw new Error(`API returned status ${res.status}`);

    let data = await res.json();
    if(!data || (!data[0]?.syncedLyrics && !data[0]?.plainLyrics)) {
        res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent((s.a || '') + ' ' + cleanTitle)}${durationParam}`, { headers });
        if(res.ok) data = await res.json();
    }
    
    // --- SMART DURATION SORTING ---
    // Double-check sorting locally to ensure the best match is #1
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
    
    if(finalLyrics) {
      if (!s.isOnline) {
        if(!fs.existsSync(lDir)) fs.mkdirSync(lDir);
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
          // Task 1: Always offer AI generation for cloud or local songs if database is empty
          lContent.innerHTML = `<p class="lyric-line" style="opacity: 1; filter: blur(0px);">No lyrics found in database.</p>`;
          showToast("No lyrics found. Click ✨ to Generate with AI.");
          updateAIButtons('block', 'Generate Lyrics with AI', false);
          if (s.isOnline) localStorage.setItem('apiEmpty_' + cSongId, "true");
      }
    }

  } catch(e) { 
    console.error("Lyric Fetch Error:", e);
    lContent.innerHTML = `<p class="lyric-line" style="opacity: 1; filter:blur(0); color:#ff4c4c;">App Error: ${e.message}</p>`;
  }
}

function startListeningSession(song) {
    if (!song) return;
    currentListenSession = {
        key: getSongModelKey(song),
        song: { t: song.t, a: song.a, p: song.p, ytId: song.ytId, id: song.id },
        bucket: getTimeBucket(),
        startTime: audio.currentTime || 0
    };
}

function finalizeListeningSession(reason = 'switch') {
    if (!currentListenSession) return;

    const listenedMs = Math.max(0, ((audio.currentTime || 0) - currentListenSession.startTime) * 1000);
    const songStats = ensureSongStats(currentListenSession.song);
    const artistStats = ensureArtistStats(currentListenSession.song.a);
    const shouldCountBucket = listenedMs >= 5000 || reason === 'completed' || reason === 'skipped';

    if (artistStats) {
        artistStats.artist_affinity += listenedMs;
        if (shouldCountBucket) artistStats.time_of_day[currentListenSession.bucket] += 1;
        if (reason === 'completed') artistStats.play_count += 1;
        if (reason === 'skipped') artistStats.skip_rate += 1;
    }

    if (songStats) {
        if (shouldCountBucket) songStats.time_of_day[currentListenSession.bucket] += 1;
        if (reason === 'completed') songStats.play_count += 1;
        if (reason === 'skipped') songStats.skip_rate += 1;
    }

    saveAiUserModel();
    currentListenSession = null;
}

function show(lrc) {
    lContent.innerHTML = '';
    lyrics = [];
    lyrIdx = -1; // <--- THE BUG FIX FOR PLAIN TEXT SCROLLING
    
    const reg = /\[(\d{2}):(\d{2}\.\d+)\]/;
    const isSynced = reg.test(lrc);
    
    // Check if this song is currently in the AI oven
    const isSongInAIQueue = currentAITask?.p === queue[curIdx].p || aiTaskQueue.some(t => t.song.p === queue[curIdx].p);

    if (isSongInAIQueue) {
        updateAIButtons('block', 'AI is working...', true);
    } else if (!isSynced && queue[curIdx]) {
        // Task 1: Offer AI Auto-Sync for plain text even on cloud songs
        showToast("Only plain text found. Click ✨ to Auto-Sync.");
        updateAIButtons('block', 'AI Auto-Sync Plain Text', false);
    } else {
        updateAIButtons('none', '', false);
    }

    lrc.split('\n').forEach(line => {
        if (isSynced) {
            const m = reg.exec(line);
            if(m) {
                const time = (parseInt(m[1])*60) + parseFloat(m[2]);
                const text = line.replace(reg,'').trim();
                
                if(text) {
                    lyrics.push({ time, text });
                    const p = document.createElement('p'); p.className='lyric-line'; p.innerText=text;
                    p.onclick = (e) => { 
                        if(isEditing || window.isGrabbing) { e.stopPropagation(); return; }
                        audio.currentTime = Math.max(0, time - songSyncOffset); 
                        if(audio.paused) audio.play(); 
                    };
                    
                    lContent.appendChild(p);
                }
            }
        } else {
            // It's Plain Text: Render it as a static lyric block without click-to-seek
            const text = line.trim();
            if(text) {
                const p = document.createElement('p'); p.className='lyric-line'; 
                p.style.cursor = 'default'; p.style.opacity = '0.7'; p.innerText=text;
                lContent.appendChild(p);
            }
        }
    });
}

audio.addEventListener('play', () => document.getElementById('p-icon').innerText = 'pause');
audio.addEventListener('pause', () => document.getElementById('p-icon').innerText = 'play_arrow');


let hasAutoSwitchedToImmersive = false;

function togglePlay() { 
  if (!audio.src) return; // Do nothing if no song is loaded
  
  if (audio.paused) {
    audio.play();
    
    // --- FIX: Switch to the ACTUAL player view, not just the CSS class ---
    if (!hasAutoSwitchedToImmersive) {
      hasAutoSwitchedToImmersive = true;
      switchToPlayerView(); 
    }
  } else {
    audio.pause();
  }
}

function advanceQueueToNext() {
  if (curIdx + 1 < queue.length) {
    play(curIdx + 1);
  } else {
    audio.pause();
    audio.currentTime = 0;
    document.getElementById('p-icon').innerText = 'play_arrow';
  }
}

function playNext() { 
  finalizeListeningSession(audio.currentTime > 0 && audio.currentTime < 30 ? 'skipped' : 'switch');
  advanceQueueToNext();
}
    
function playPrev() { 
    finalizeListeningSession('switch');
    // If the song has been playing for 3 seconds, previous just restarts the track
    if (audio.currentTime > 3) { 
    audio.currentTime = 0; 
    return; 
    }
    // Otherwise, go back a song (or stop if it's the very first song)
    if (curIdx > 0) play(curIdx - 1); 
    else audio.currentTime = 0;
}
    
function shuffleRemaining() {
    if(queue.length <= curIdx + 1) return;
    const remaining = queue.slice(curIdx + 1);
    for(let i = remaining.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [remaining[i], remaining[j]] = [remaining[j], remaining[i]]; }
    queue = [...queue.slice(0, curIdx + 1), ...remaining]; draw(); saveState();
    showToast("Queue shuffled");
}
audio.onended = () => {
    finalizeListeningSession('completed');
    advanceQueueToNext();
};


// --- SCROLL HANDLING ---


function handleManualScroll(e) {
    if (typeof isEditing !== 'undefined' && isEditing) return;
    // Ignore tiny accidental trackpad bumps right after clicking
    if (e && e.type === 'wheel' && Math.abs(e.deltaY) < 10) return; 
    
    isUserScrolling = true;
    clearTimeout(lyricScrollTimeout);
    
    lyricScrollTimeout = setTimeout(() => {
    isUserScrolling = false;
    
    // FIX: If the song is paused, do NOT auto-snap back! Let the user read.
    if (audio.paused) return; 

    const ps = document.getElementsByClassName('lyric-line');
    const lView = document.getElementById('l-view');
    if (lView && typeof lyrIdx !== 'undefined' && lyrIdx >= 0 && ps[lyrIdx]) {
    lView.scrollTo({top: ps[lyrIdx].offsetTop - (lView.clientHeight / 3.5), behavior:'smooth'});    }
    }, 2000);
}


lView.addEventListener('wheel', handleManualScroll);
lView.addEventListener('touchmove', handleManualScroll);
lView.addEventListener('mousedown', handleManualScroll);

audio.ontimeupdate = () => {
    if(!audio.duration) return;
    document.getElementById('fill').style.width = (audio.currentTime/audio.duration)*100 + '%';
    const fmt = s => `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
    document.getElementById('c-time').innerText = fmt(audio.currentTime);
    document.getElementById('t-time').innerText = fmt(audio.duration);

    if (audio.duration - audio.currentTime <= 15) {
        preloadNextSong();
    }
    // Only do the heavy math and scrolling if lyrics are actually enabled!
    if (lyricsEnabled && lyrics.length > 0) {
    let act = -1;
    const adjustedTime = audio.currentTime + songSyncOffset;
    for(let i=0; i<lyrics.length; i++) { if(adjustedTime >= lyrics[i].time) act = i; else break; }
    
    if(act !== -1 && act !== lyrIdx) {
        lyrIdx = act;
        const ps = document.getElementsByClassName('lyric-line');
        for(let p of ps) p.classList.remove('highlight');
        if(ps[act]) {
        ps[act].classList.add('highlight');
        if (!isEditing && !isUserScrolling) {
            lView.scrollTo({top: ps[act].offsetTop - (lView.clientHeight / 3.5), behavior:'smooth'});
        }
        }
    }
    }
};
document.getElementById('pb').onclick = (e) => {
    if (audio.duration && isFinite(audio.duration)) {
        audio.currentTime = (e.offsetX / e.target.clientWidth) * audio.duration;
    }
};

// Double click background to toggle immersive view
// --- CLICK AND HOLD (GRAB) TO TOGGLE ---
window.isGrabbing = false;
let grabTimer;
const lViewEl = document.getElementById('l-view');

lViewEl.addEventListener('mousedown', (e) => {
    if (isEditing) return;
    // Prevent this from triggering if you are just clicking the scrollbar!
    if (e.offsetX >= lViewEl.clientWidth - 15) return; 

    window.isGrabbing = false; // Reset on a new click
    
    // If you hold the mouse down for 400ms, it counts as a "Grab"
    grabTimer = setTimeout(() => {
    window.isGrabbing = true; // Activate the shield!
    toggleImmersive();
    }, 400); 
});

// If you lift your finger early or move away, cancel the grab timer
lViewEl.addEventListener('mouseup', () => clearTimeout(grabTimer));
lViewEl.addEventListener('mouseleave', () => clearTimeout(grabTimer));

// --- SMART SEARCH BAR HIDE/SHOW LOGIC (FIXED) ---
const sideSearch = document.getElementById('sidebar-search');
const immSearch = document.getElementById('imm-search');
const immResults = document.getElementById('imm-search-results');
const queueList = document.getElementById('queue-list');

document.addEventListener('click', (e) => {
    // 1. SIDEBAR SEARCH CLICK-AWAY
    if (sideSearch && queueList) {
        if (e.target !== sideSearch && !queueList.contains(e.target)) {
            // We clicked outside the sidebar search AND outside its results
            if (sideSearch.value.trim().length > 0) {
                // Secretly restore the queue without deleting the user's typed text!
                const savedText = sideSearch.value;
                sideSearch.value = ''; 
                draw(); // Restores the normal queue
                sideSearch.value = savedText; // Puts the typed text back instantly
            }
        }
    }
    
    // 2. IMMERSIVE SEARCH CLICK-AWAY
    if (immSearch && immResults) {
        if (e.target !== immSearch && !immResults.contains(e.target)) {
            immResults.style.display = 'none'; // Safely hide the dropdown
        }
    }
});

// 3. RESTORE SIDEBAR RESULTS ON FOCUS
if (sideSearch) {
    sideSearch.addEventListener('focus', () => {
        if (sideSearch.value.trim().length > 0) {
            // Re-run the filter to bring the search results back
            filterQueue(sideSearch.value, 'queue-list');
        }
    });
}

// 4. RESTORE IMMERSIVE RESULTS ON FOCUS
if (immSearch) {
    immSearch.addEventListener('focus', () => {
        if (immSearch.value.trim().length > 0) {
            immResults.style.display = 'block'; // Bring the dropdown back
        }
    });
}

// ==========================================
// --- DISCOVERY HOMEPAGE & LIVE LINKS ---
// ==========================================

// 1. Switch between Home and Player views
// --- STRICT VIEW SWITCHING ---
function switchToPlayerView() {
    document.body.classList.remove('home-mode'); 
    document.body.classList.add('immersive'); // <--- THIS BRINGS YOUR BUTTONS BACK
    document.body.classList.add('player-mode');
    switchView('player');
    
    // Fix album art bug by forcing a reflow
    const cover = document.getElementById('album-cover');
    if (cover && cover.src) cover.style.display = 'block';
    
    // Force lyrics scroll to recalculate after layout change
    setTimeout(() => { if (typeof scrollToCurrentSong === 'function') scrollToCurrentSong(); }, 150);
}

function switchToHomeView() {
    document.body.classList.add('home-mode'); // Hides the queue
    switchView('home');
    document.body.classList.remove('player-mode');
    document.body.classList.remove('immersive'); 
}

// 2. Fetch Data for the Carousels (Our "Shadow Algorithm")
// ==========================================
// --- AI TASTE PROFILER & HOMEPAGE ENGINE ---
// ==========================================

function getTopArtistsFromQueue() {
    if (queue.length === 0) return [];
    let counts = {};
    queue.forEach(s => {
        if (!s.a || s.a === 'Unknown') return;
        // Split multiple artists (e.g. "CamelPhat, Elderbrook")
        let artists = s.a.split(',').map(a => a.trim());
        artists.forEach(a => counts[a] = (counts[a] || 0) + 1);
    });
    // Sort by most played/added, grab top 5
    return Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
}

// ==========================================
// --- 1. AI TASTE PROFILER & HOMEPAGE ENGINE ---
// ==========================================

async function loadHomepage() {
    const container = document.getElementById('dynamic-homepage');
    if (!container) return;
    container.innerHTML = `<div style="padding: 20px; color: var(--dim);"><span class="material-icons-round" style="animation: spin 1s linear infinite; vertical-align: middle;">sync</span> AI is scanning your history...</div>`;

    const currentBucket = getTimeBucket();
    const bucketLabel = currentBucket === 'Late Night' ? 'Late Night' : currentBucket;
    const queueArtists = [...new Set(queue.map(song => sanitizeArtistName(song.a)).filter(Boolean))];
    const artistEntries = Object.entries(aiUserModel.artists)
        .filter(([artist]) => isKnownArtist(artist))
        .map(([artist, stats]) => {
            const timeBonus = stats.time_of_day?.[currentBucket] || 0;
            return {
                artist,
                score: (stats.play_count * 1.5) - (stats.skip_rate * 2) + timeBonus,
                affinity: stats.artist_affinity || 0,
                skip_rate: stats.skip_rate || 0
            };
        })
        .sort((a, b) => (b.score - a.score) || (b.affinity - a.affinity));

    const topArtist = artistEntries[0]?.artist || queueArtists[0] || '';
    const bucketArtist = [...artistEntries]
        .sort((a, b) => ((b.affinity + ((aiUserModel.artists[b.artist]?.time_of_day?.[currentBucket] || 0) * 1000)) - (a.affinity + ((aiUserModel.artists[a.artist]?.time_of_day?.[currentBucket] || 0) * 1000))))
        .find(entry => (aiUserModel.artists[entry.artist]?.time_of_day?.[currentBucket] || 0) > 0)?.artist;
    const skippedArtist = [...artistEntries].sort((a, b) => b.skip_rate - a.skip_rate)[0]?.artist;
    const recoveryArtist = artistEntries.find(entry => entry.artist !== skippedArtist)?.artist || queueArtists.find(artist => artist !== skippedArtist);

    let shelves = [];
    if (bucketArtist) shelves.push({ q: bucketArtist, title: `Your ${bucketLabel} Vibes`, type: 'songs' });
    if (topArtist) shelves.push({ q: topArtist, title: `Heavy Rotation: ${topArtist}`, type: 'songs' });
    if (topArtist) shelves.push({ q: topArtist, title: `${topArtist} Mixes & Playlists`, type: 'playlists' });
    if (skippedArtist && recoveryArtist) {
        shelves.push({ q: recoveryArtist, title: `Because you skipped ${skippedArtist}, try ${recoveryArtist}`, type: 'songs' });
    }

    if (topArtist && Math.random() < 0.10) {
        shelves.push({ q: `${topArtist} similar artists`, title: `Discovery Entropy: Beyond ${topArtist}`, type: 'songs' });
    }

    if (shelves.length === 0) {
        const fallbackArtists = queueArtists.slice(0, 3);
        fallbackArtists.forEach((artist, index) => {
            shelves.push({
                q: artist,
                title: index === 0 ? `Heavy Rotation: ${artist}` : `More from ${artist}`,
                type: index === 2 ? 'playlists' : 'songs'
            });
        });
    }

    if (shelves.length === 0) {
        shelves = [
            { q: "Global Top 50", title: "Global Playlists", type: "playlists" },
            { q: "Viral Hits", title: "Internet Viral Songs", type: "songs" }
        ];
    }

    let html = '';
    shelves.forEach((item, i) => {
        html += `
        <div style="margin-top: 35px;">
            <h2 style="margin-bottom: 15px; font-size: 1.4rem;">${item.title}</h2>
            <div id="carousel-${i}" class="horizontal-carousel"></div>
        </div>`;
    });
    container.innerHTML = html;

    for (let i = 0; i < shelves.length; i++) {
        await delay(600); // Stagger loop to prevent rate limiting
        if (shelves[i].type === 'playlists') populatePlaylistCarousel(shelves[i].q, `carousel-${i}`);
        else populateCarousel(shelves[i].q, `carousel-${i}`);
    }
}

async function populateCarousel(query, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    try {
        let res = await fetchWithFallback(`/search/songs?query=${encodeURIComponent(query)}&limit=15`);
        let json = await res.json();
        let results = (json.data && json.data.results) ? json.data.results : [];
        results = results.filter(song => isKnownArtist(getSongArtist(song)));

        if (results.length > 0) {
            let html = "";
            results.forEach(song => {
                let title = (song.name || "Unknown").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                let artist = song.artists?.primary?.[0]?.name.replace(/&quot;/g, '"').replace(/&amp;/g, '&') || "Unknown";
                let cover = song.image?.length > 0 ? song.image[song.image.length - 1].url : "";
                let dl = song.downloadUrl?.length > 0 ? song.downloadUrl[song.downloadUrl.length - 1].url : "";

                if (dl) {
                    let safeT = title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    let safeA = artist.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    let safeC = cover ? cover.replace(/'/g, "\\'").replace(/"/g, '&quot;') : '';
                    let safeDL = dl.replace(/'/g, "\\'").replace(/"/g, '&quot;');

                    html += `
<div class="song-card" data-type="song" 
     data-title="${safeT}" 
     data-artist="${safeA}" 
     data-cover="${safeC}" 
     data-url="${safeDL}" 
     data-ytid="${song.videoId || ''}"
     onclick="playDirectlyFromHome('${safeT}', '${safeA}', '${safeC}', '${safeDL}')"
     oncontextmenu="openSearchMenu(event, '${encodeURIComponent(JSON.stringify(song))}')">
    <img src="${cover}">
    <div class="title">${title}</div>
    <div class="artist">${artist}</div>
</div>`;
                }
            });
            container.innerHTML = html;
        } else { container.innerHTML = `<div style="color: var(--dim);">No results found.</div>`; }
    } catch (e) { container.innerHTML = `<div style="color: var(--dim);">Failed to load row.</div>`; }
}

async function populatePlaylistCarousel(query, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    try {
        let res = await fetchWithFallback(`/search/playlists?query=${encodeURIComponent(query)}&limit=10`);
        let json = await res.json();
        let results = (json.data && json.data.results) ? json.data.results : [];

        if (results.length > 0) {
            let html = "";
            results.forEach(pl => {
                let title = (pl.title || pl.name || "Unknown").replace(/'/g, "\\'").replace(/"/g, '&quot;');
                let cover = pl.image?.length > 0 ? pl.image[pl.image.length - 1].url : "";
                
                // Inside populatePlaylistCarousel(), change the HTML generation to this:
html += `
<div class="song-card" data-type="playlist" data-id="${pl.id}" data-title="${title}" style="border-radius: 20px; background: rgba(0,0,0,0.4);" onclick="loadSaavnPlaylist('${pl.id}', '${title}')">
    <img src="${cover}" style="border-radius: 12px; box-shadow: 0 5px 15px rgba(0,0,0,0.6);">
    <div class="title" style="text-align: center;">${title}</div>
    <div class="artist" style="text-align: center;">${pl.songCount || 'Mix'} Tracks</div>
</div>`;
            });
            container.innerHTML = html;
        }
    } catch (e) { container.innerHTML = `<div style="color: var(--dim);">Failed to load playlists.</div>`; }
}

async function loadSaavnPlaylist(id, titleName) {
    showToast("Fetching Playlist Tracks...");
    try {
        let res = await fetchWithFallback(`/playlists?id=${id}`);
        let json = await res.json();
        if (json.data && json.data.songs) {
            let mappedSongs = json.data.songs.map(song => {
                let title = (song.name || "Unknown").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                let artist = song.artists?.primary?.[0]?.name.replace(/&quot;/g, '"').replace(/&amp;/g, '&') || "Unknown";
                let cover = song.image?.length > 0 ? song.image[song.image.length - 1].url : "";
                let dl = song.downloadUrl?.length > 0 ? song.downloadUrl[song.downloadUrl.length - 1].url : "";
                return { t: title, a: artist, cover: cover, p: dl, isOnline: true, needsAudioStream: false };
            }).filter(s => s.p);

            if (mappedSongs.length > 0) {
                if (activeQMode === 'main') { mainQueue = [...queue]; mainIdx = curIdx; }
                    activeQMode = 'playlist';
                    plQueue = [...mappedSongs];
                    plIdx = 0;
                    queue = [...mappedSongs];
                    curIdx = 0;
                    const btnMain = document.getElementById('btn-q-main');
                    const btnPl = document.getElementById('btn-q-pl');
                    if (btnMain) btnMain.classList.toggle('active', false);
                    if (btnPl) btnPl.classList.toggle('active', true);
                    draw(); saveState(); switchToPlayerView(); play(0);
                    showToast(`Playing ${titleName}!`);
            } else showToast("No playable tracks in this playlist.");
        }
    } catch (e) { showToast("Failed to load playlist."); }
}

function playDirectlyFromHome(title, artist, cover, url) {
    const newSong = { 
        t: title, 
        a: artist, 
        p: normalizeSaavnUrl(url), 
        isOnline: true, 
        cover: cover 
    };
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, newSong);
    
    saveState(); 
    switchToPlayerView();
    play(insertPos); 
    
    const sideSearch = document.getElementById('sidebar-search-results');
    const immSearch = document.getElementById('imm-search-results');
    if (sideSearch) sideSearch.style.display = 'none';
    if (immSearch) immSearch.style.display = 'none';
}

// ==========================================
// --- 2. DUAL QUEUE SYSTEM ---
// ==========================================

function switchQueueMode(mode) {
    // REMOVED the early return — always sync the arrays before switching
    if (activeQMode === 'main') { mainQueue = [...queue]; mainIdx = curIdx; } 
    else { plQueue = [...queue]; plIdx = curIdx; }

    activeQMode = mode;

    if (activeQMode === 'main') { queue = [...mainQueue]; curIdx = mainIdx; } 
    else { queue = [...plQueue]; curIdx = plIdx; }

    const btnMain = document.getElementById('btn-q-main');
    const btnPl = document.getElementById('btn-q-pl');
    if (btnMain) btnMain.classList.toggle('active', mode === 'main');
    if (btnPl) btnPl.classList.toggle('active', mode === 'playlist');
    
    draw(); saveState(); showToast(`Switched to ${mode === 'main' ? 'Main Queue' : 'Playlist Queue'}`);
}

// ==========================================
// --- 3. TRACK OPTIONS (THREE DOTS) ---
// ==========================================
function toggleMenu() {
    const menu = document.getElementById('track-options-dropdown');
    menu.style.display = (menu.style.display === 'block') ? 'none' : 'block';
}

document.addEventListener('click', (e) => {
    const clearMenu = document.getElementById('clear-menu');
    if (clearMenu && !e.target.closest('.clear-dropdown-wrap')) clearMenu.style.display = 'none';
    const dots = document.getElementById('options-trigger');
    const menu = document.getElementById('track-options-dropdown');
    if (menu && e.target !== dots && !menu.contains(e.target)) menu.style.display = 'none';
});

function shareTrack() {
    const song = queue[curIdx];
    if (!song) return;
    navigator.clipboard.writeText(`Listening to ${song.t} by ${song.a} on Pro Media Player!`);
    showToast("Share text copied to clipboard!");
    toggleMenu(); 
}

function downloadTrack() {
    const s = queue[curIdx];
    if(!s) return;
    showToast(`Preparing download for: ${s.t}...`);
    require('electron').shell.openExternal(s.p);
    toggleMenu();
}

// 🔥 THE FIX: Smart Add/Remove Toggle for Local Playlists
function saveToPlaylist() { 
    const song = queue[curIdx];
    if (!song) return;
    let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
    
    // Check if song is exactly in the playlist already
    const existingIdx = localPl.findIndex(s => s.t === song.t && s.a === song.a);
    
    if (existingIdx !== -1) {
        // It exists! Remove it.
        localPl.splice(existingIdx, 1); 
        if (typeof showToast === 'function') showToast("🗑️ Removed from Local Playlist!");
    } else {
        // It doesn't exist! Add it.
        localPl.push(song); 
        if (typeof showToast === 'function') showToast("❤️ Saved to Local Playlist!");
    }
    
    localStorage.setItem('myLocalPlaylist', JSON.stringify(localPl));
    if (typeof toggleMenu === 'function') toggleMenu(); 
}

function goToArtist() {
    const song = queue[curIdx];
    if (!song) return;
    switchToHomeView();
    const immSearch = document.getElementById('imm-search');
    immSearch.value = song.a;
    immSearch.focus();
    filterQueue(song.a, 'imm-search-results', true);
    toggleMenu();
}

// ==========================================
// --- 4. YOUTUBE MUSIC ARCHITECTURE & ROUTING ---
// ==========================================
let currentLoadedPlaylist = [];

function switchView(viewName) {
    const ctxMenu = document.getElementById('custom-context-menu');
    if (ctxMenu) ctxMenu.style.display = 'none';
    const panels = ['home', 'playlist', 'player' , 'history'];
    panels.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        if (el) {
            if (v === viewName) { el.style.display = 'flex'; el.classList.add('active'); } 
            else { el.style.display = 'none'; el.classList.remove('active'); }
        }
    });
    if (viewName === 'player') document.body.classList.add('immersive');
    else document.body.classList.remove('immersive');

    document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
    if (viewName === 'home') document.querySelectorAll('.menu-item')[0].classList.add('active');
    if (viewName === 'player') document.querySelectorAll('.menu-item')[1].classList.add('active');
}


async function fetchYTPlaylist(playlistId, titleName = "YouTube Playlist") {
    showToast("Syncing with YouTube Music...");
    await openPlaylist(playlistId, titleName);
}

async function preloadSidebarPlaylistNames() {
    const links = Array.from(document.querySelectorAll('.playlist-link[data-playlist-id]'));
    for (const link of links) {
        const playlistId = link.getAttribute('data-playlist-id');
        if (!playlistId) continue;
        try {
            const playlistData = await ipcRenderer.invoke('get-yt-playlist', playlistId);
            if (!playlistData) continue;
            const resolvedName = playlistData.name || playlistData.title;
            if (!resolvedName) continue;
            const label = link.querySelector('.playlist-name');
            if (label) label.innerText = resolvedName;
        } catch (e) { console.error('Failed to preload playlist name:', playlistId, e); }
    }
}

async function openPlaylist(playlistId, titleName) {
    lockPlaylistSection();
    document.body.classList.remove('player-mode');
    switchView('playlist');
    document.getElementById('pl-detail-title').innerText = titleName;
    const tracklistEl = document.getElementById('playlist-tracklist');
    tracklistEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--dim);"><span class="material-icons-round" style="animation: spin 1s linear infinite;">sync</span> Scraping tracks from YouTube...</div>`;

    // Uses our new custom scraper in main.js!
    const playlistData = await ipcRenderer.invoke('get-yt-playlist', playlistId);
    if (!playlistData || !playlistData.songs || playlistData.songs.length === 0) { 
        if (typeof showToast === 'function') showToast("❌ YouTube blocked the request or playlist is private.");
        tracklistEl.innerHTML = `<div style="color: #ff4c4c; padding: 20px; text-align: center; font-weight: bold;">Failed to load. Is the playlist private, or did YouTube block access?</div>`; 
        return; 
    }

    const resolvedName = playlistData.name || playlistData.title || titleName || "YouTube Playlist";
    const titleEl = document.getElementById('pl-detail-title');
    if (titleEl) titleEl.innerText = resolvedName;

    document.getElementById('pl-track-count').innerText = playlistData.songs.length;
    
    currentLoadedPlaylist = playlistData.songs.map(song => {
        let rawCover = song.thumbnails && song.thumbnails.length > 0 ? song.thumbnails[song.thumbnails.length - 1].url : '';
        let safeCover = rawCover.startsWith('http') ? rawCover : 'https://via.placeholder.com/230';
        let safeArtist = song.artists ? song.artists.map(a => a.name).join(', ') : 'Unknown';
        
        let cleanTitle = typeof smartCleanTitle === 'function' ? smartCleanTitle(song.name, safeArtist) : song.name;

        return {
            t: cleanTitle, 
            rawTitle: song.name, 
            a: safeArtist, 
            p: '',
            cover: safeCover,
            isOnline: true, 
            needsAudioStream: true,
            ytId: song.ytId // <--- THIS TELLS THE PLAYER IT'S A YOUTUBE SONG
        };
    });

    if (currentLoadedPlaylist.length > 0 && currentLoadedPlaylist[0].cover) {
        document.getElementById('pl-detail-img').src = currentLoadedPlaylist[0].cover;
    }

    let html = '';
    currentLoadedPlaylist.forEach((song, i) => {
        // 🔥 THE FIX: Added oncontextmenu for Right-Click!
        const encodedSong = encodeURIComponent(JSON.stringify(song));
        html += `
        <div class="track-row" 
             data-type="history-item" 
             data-song="${encodedSong}"
             onclick="playFromPlaylist(${i})" 
             oncontextmenu="event.preventDefault()">
            <div class="track-num">${i + 1}</div>
            <div style="display:flex; flex-direction:column; overflow:hidden;">
                <span style="color:white; font-weight:bold; white-space:nowrap; text-overflow:ellipsis;">${song.t}</span>
                <span style="color:var(--dim); font-size:0.85rem; white-space:nowrap; text-overflow:ellipsis;">${song.a}</span>
            </div>
            <span class="material-icons-round" style="color:var(--dim); font-size:18px;" onclick="event.stopPropagation(); toggleMenu()">more_horiz</span>
        </div>`;
    });
    tracklistEl.innerHTML = html;
}

// 🔥 THE FIX: Force Playlist Mode so it doesn't leak into the main queue
function playFromPlaylist(index) {
    if (typeof switchQueueMode === 'function') switchQueueMode('playlist'); 
    queue = [...currentLoadedPlaylist];
    curIdx = index;
    
    // Explicitly sync the background playlist queue arrays!
    if (typeof plQueue !== 'undefined') plQueue = [...queue];
    if (typeof plIdx !== 'undefined') plIdx = curIdx;
    
    saveState(); 
    draw(); 
    if (typeof switchView === 'function') switchView('player'); 
    play(index);
}   

function playEntirePlaylist() { if(currentLoadedPlaylist.length === 0) return; playFromPlaylist(0); }

function shuffleEntirePlaylist() {
    if(currentLoadedPlaylist.length === 0) return;
    switchQueueMode('playlist');
    queue = [...currentLoadedPlaylist];
    for(let i = queue.length - 1; i > 0; i--) { 
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]]; 
    }
    curIdx = 0; saveState(); draw(); switchView('player'); play(0);
}


function playSupermixSong(title, artist, cover) {
    const newSong = { t: title, a: artist, p: '', cover: cover, isOnline: true, needsAudioStream: true };
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, newSong);
    saveState(); draw(); switchView('player'); play(insertPos);
}



function renderSidebarPlaylists() {
    const container = document.getElementById('sidebar-playlists');
    if (!container) return;

    let html = `
        <div class="menu-item playlist-link" 
             data-type="local-playlist-card"
             onclick="openLocalPlaylist()" 
             oncontextmenu="event.preventDefault(); showLocalPlaylistCtx(event)">
            <span class="material-icons-round" style="color:#4cc2ff">favorite</span>
            <span class="playlist-name" style="font-weight:bold;color:white;">Local Favorites</span>
        </div>
    `;

    let saved = JSON.parse(localStorage.getItem('customYTPlaylists') || '[]');
    saved.forEach(pl => {
        let safeTitle = pl.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        let safeId = pl.id;
        html += `
        <div style="display:flex;justify-content:space-between;align-items:center;padding-right:10px;" 
             class="menu-item playlist-link"
             data-type="sidebar-yt-playlist"
             data-id="${safeId}"
             data-title="${safeTitle}"
             oncontextmenu="event.preventDefault(); showSidebarPlaylistCtx(event, '${safeId}', '${safeTitle}')">
            <a onclick="fetchYTPlaylist('${safeId}', '${safeTitle}')" 
               style="flex:1;cursor:pointer;display:flex;align-items:center;gap:10px;overflow:hidden;">
                <span class="material-icons-round" style="color:#ff0000">play_circle</span>
                <span class="playlist-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${pl.title}</span>
            </a>
            <span class="material-icons-round" style="color:var(--dim);cursor:pointer;font-size:14px;" 
                  onclick="event.stopPropagation();removePlaylist('${pl.id}')" title="Remove">close</span>
        </div>`;
    });

    container.innerHTML = html;
}

function showSidebarPlaylistCtx(e, id, title) {
    const menu = document.getElementById('custom-context-menu');
    if (!menu) return;
    menu.innerHTML = `
        <div class="context-item" onclick="fetchYTPlaylist('${id}', '${title}')"><span class="material-icons-round">play_circle</span> Open Playlist</div>
        <div class="context-item" onclick="removePlaylist('${id}'); document.getElementById('custom-context-menu').style.display='none';"><span class="material-icons-round">delete_outline</span> Remove from Sidebar</div>
    `;
    const menuHeight = 100;
    let yPos = e.pageY;
    if (yPos + menuHeight > window.innerHeight) yPos = window.innerHeight - menuHeight;
    menu.style.left = `${e.pageX}px`;
    menu.style.top = `${yPos}px`;
    menu.style.display = 'block';
}

function showLocalPlaylistCtx(e) {
    const menu = document.getElementById('custom-context-menu');
    if (!menu) return;
    let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
    menu.innerHTML = `
        <div class="context-item" onclick="openLocalPlaylist()"><span class="material-icons-round">play_arrow</span> Play All (${localPl.length} tracks)</div>
        <div class="context-item" onclick="localStorage.removeItem('myLocalPlaylist'); showToast('Local Favorites cleared'); document.getElementById('custom-context-menu').style.display='none';"><span class="material-icons-round">delete_sweep</span> Clear All Favorites</div>
    `;
    const menuHeight = 100;
    let yPos = e.pageY;
    if (yPos + menuHeight > window.innerHeight) yPos = window.innerHeight - menuHeight;
    menu.style.left = `${e.pageX}px`;
    menu.style.top = `${yPos}px`;
    menu.style.display = 'block';
}

function removePlaylist(id) {
    let saved = JSON.parse(localStorage.getItem('customYTPlaylists') || '[]');
    saved = saved.filter(p => p.id !== id);
    localStorage.setItem('customYTPlaylists', JSON.stringify(saved));
    renderSidebarPlaylists();
}

// ==========================================
// --- SAFE AUTO-START & STATE RECOVERY ---
// ==========================================
setTimeout(() => { 
    // 1. Recover Queue safely
    try {
        if (queue.length === 0) {
            const savedQ = localStorage.getItem('queue') || localStorage.getItem('savedQueue');
            if (savedQ) {
                queue = JSON.parse(savedQ);
                if (typeof mainQueue !== 'undefined') mainQueue = [...queue]; 
                if (typeof draw === 'function') draw(); 
            }
        }
    } catch(e) { console.error("Queue recovery failed"); }

    // 2. Start the AI Recommendation Engine (This fills your homepage!)
    if (typeof loadHomepage === 'function') loadHomepage(); 

    // 3. Load user's pasted playlists into the sidebar
    renderSidebarPlaylists();
}, 500);

// --- SMART YOUTUBE METADATA EXTRACTOR ---
function smartCleanTitle(rawTitle, rawArtist) {
    let title = rawTitle;

    // 1. Nuke everything inside brackets/parentheses (Usually "Official Video" or "Lyric Video")
    title = title.replace(/\[.*?\]|\(.*?\)/g, ' ');

    // 2. Kill all common music junk words
    title = title.replace(/\b(official|video|audio|lyric|lyrics|remastered|4k|hd|hq|live|cover|remix|ft|feat|featuring|prod|music)\b/ig, ' ');

    // 3. 🔥 THE FIX: Keep ONLY letters, numbers, spaces, AND Hindi/Regional Unicode! 
    title = title.replace(/[^\w\s\u0900-\u097F]/g, ' ');

    // 4. Scrub the artist's name OUT of the title to prevent duplicate queries!
    let mainArtist = rawArtist.split(',')[0].trim();
    if (mainArtist && mainArtist.toLowerCase() !== "unknown artist") {
        let artistParts = mainArtist.split(' ');
        artistParts.forEach(part => {
            if (part.length > 2) { 
                let partRegex = new RegExp(`\\b${part}\\b`, 'ig');
                title = title.replace(partRegex, ' ');
            }
        });
    }

    // 5. Collapse all empty spaces and return
    return title.replace(/\s+/g, ' ').trim();
}

// ==========================================
// --- PLAYLIST UI HOVER LOCK ---
// ==========================================
let playlistLockTimer;

function lockPlaylistSection() {
    const plSection = document.getElementById('my-library-section');
    if (!plSection) return;

    // Force it open
    plSection.classList.add('locked-open');

    // Clear any existing timer
    clearTimeout(playlistLockTimer);

    // Remove the lock after 10 seconds
    playlistLockTimer = setTimeout(() => {
        plSection.classList.remove('locked-open');
    }, 10000);
}

// ==========================================
// --- LYRICS AUTO-SYNC FAILSAFE ---
// ==========================================
let lastLyricFetchTrack = -1;

// This forces the app to fetch lyrics ONLY after the audio physically starts playing.
// This guarantees that the JioSaavn stream has fully resolved!
document.getElementById('player').addEventListener('playing', () => {
    if (lastLyricFetchTrack !== curIdx) {
        lastLyricFetchTrack = curIdx;
        
        // Trigger whatever your default lyrics fetch function is named
        if (typeof getLyrics === 'function' && queue[curIdx]) {
            getLyrics(queue[curIdx]);
        }
    }
});

// ==========================================
// --- BACKGROUND AUDIO PRELOADER ---
// ==========================================
let lastPreloadedIdx = -1;
async function preloadNextSong() {
    const nextIdx = curIdx + 1;
    if (nextIdx >= queue.length) return;
    
    // 1. If we already tried preloading this exact song, DO NOT try again.
    if (lastPreloadedIdx === nextIdx) return; 

    const nextSong = queue[nextIdx];
    if (!nextSong.isOnline || (!nextSong.needsAudioStream && nextSong.p)) return; 

    // 2. LOCK IT IMMEDIATELY so the audio timer doesn't fire 60 times a second!
    lastPreloadedIdx = nextIdx;
    console.log(`[Preloader] Silently fetching audio for next track: ${nextSong.t}...`);

    let foundStream = false;
    const saavnEndpoints = [
        `/search/songs?query=${encodeURIComponent(nextSong.a + " " + nextSong.t)}&limit=1`,
        `/search/songs?query=${encodeURIComponent(nextSong.t)}&limit=1`
    ];

    for (const endpoint of saavnEndpoints) {
        try {
            let res = await fetchWithFallback(endpoint);
            if (!res.ok) continue;
            let json = await res.json();
            let results = json.data?.results || json.data?.songs?.results || [];
            const bestMatch = pickBestApiMatch(results, nextSong.t, nextSong.a);
            
            if (bestMatch && bestMatch.downloadUrl?.length > 0) {
                let dlArray = bestMatch.downloadUrl;
                let dlObj = dlArray.find(u => u.quality === '160kbps') || dlArray[dlArray.length > 1 ? dlArray.length - 2 : 0];
                
                if (dlObj && dlObj.url) {
                    nextSong.p = dlObj.url.replace('aac.saavncdn.com', 'c.saavncdn.com');
                    foundStream = true; 
                    break;
                }
            }
        } catch (e) {
            console.warn("[Preloader] Endpoint failed, trying next...");
        }
    }

    if (foundStream && nextSong.p) {
        nextSong.needsAudioStream = false;
        saveState();
        console.log(`[Preloader] Success! Next song is locked and loaded.`);
    } 
    // 3. THE FIX: Notice we do NOT reset lastPreloadedIdx to -1 here anymore! 
    // If it fails, it stays locked so it doesn't spam the API.
}


// Call this inside your existing window.onload
const originalOnload = window.onload;
window.onload = () => {
    if(originalOnload) originalOnload();
};

// ==========================================
// --- UNIFIED RIGHT-CLICK CONTEXT MENU ---
// ==========================================

// 1. Global Target Memory
window.ctxTargetSong = null;

// 2. The ONLY Right-Click Listener You Will Ever Need
document.addEventListener('contextmenu', (e) => {

    window.ctxMouseX = e.clientX;
    window.ctxMouseY = e.clientY;
    // Find what we clicked on
    const card = e.target.closest('.song-card[data-type="song"]');
    const searchItem = e.target.closest('.item[data-type="search-result"]');
    const playlistCard = e.target.closest('.song-card[data-type="playlist"]');
    const queueItem = e.target.closest('.item[data-type="queue-item"]');
    
    // 🔥 THE FIX: Catch all History and Search Item variations!
    const globalHistoryItem = e.target.closest('[data-type="history-item"], [data-type="history-search-result"], [data-type="local-search-result"]');
    
    const menu = document.getElementById('custom-context-menu');
    if (!menu) return;

    let menuHtml = '';

    // Case A: A Song Card (Homepage) OR Search Result (Sidebar)
    if (card || searchItem) {
        e.preventDefault(); 
        const el = card || searchItem;
        
        window.ctxTargetSong = {
            t: el.getAttribute('data-title'), 
            a: el.getAttribute('data-artist'),
            cover: el.getAttribute('data-cover'), 
            p: el.getAttribute('data-url'),
            ytId: el.getAttribute('data-ytid') || '', 
            isOnline: true, 
            needsAudioStream: !el.getAttribute('data-url')
        };

        menuHtml = `
            <div class="context-item" onclick="playNextDirect(window.ctxTargetSong)"><span class="material-icons-round">queue_play_next</span> Play Next</div>
            <div class="context-item" onclick="addToQueueDirect(window.ctxTargetSong)"><span class="material-icons-round">playlist_add</span> Add to Bottom</div>
            <div class="context-item" onclick="openPlaylistPicker(window.ctxTargetSong)"><span class="material-icons-round">favorite</span> Save to Local Favorites</div>
        `;
    } 
    // Case B: A Playlist Card
    else if (playlistCard) {
        e.preventDefault();
        const plId = playlistCard.getAttribute('data-id');
        const plTitle = playlistCard.getAttribute('data-title');
        menuHtml = `
            <div class="context-item" onclick="loadSaavnPlaylist('${plId}', '${plTitle}')"><span class="material-icons-round">play_circle</span> Load Entire Playlist</div>
        `;
    }
    // Case C: A Queue Item
    else if (queueItem) {
        e.preventDefault();
        const qIdx = parseInt(queueItem.getAttribute('data-index'));
        const song = queue[qIdx];
        if (!song) return;

        window.ctxTargetSong = song;

        menuHtml = `
            <div class="context-item" onclick="play(${qIdx}); document.getElementById('custom-context-menu').style.display='none';"><span class="material-icons-round">play_arrow</span> Play Now</div>
            <div class="context-item" onclick="removeFromQueue(${qIdx})"><span class="material-icons-round">remove_circle_outline</span> Remove from Queue</div>
            <div class="context-item" onclick="openPlaylistPicker(window.ctxTargetSong)"><span class="material-icons-round">favorite</span> Save to Local Favorites</div>
            <div class="context-item" onclick="shareTrackDirect(window.ctxTargetSong)"><span class="material-icons-round">share</span> Share Link</div>
        `;
    } 
    // 🔥 NEW Case D: A History Item or Hybrid Search Item!
    else if (globalHistoryItem) {
        e.preventDefault();
        const songData = globalHistoryItem.getAttribute('data-song');
        if (!songData) return;
        
        // Decodes the exact song file object from memory
        window.ctxTargetSong = JSON.parse(decodeURIComponent(songData));
        
        menuHtml = `
            <div class="context-item" onclick="playNextDirect(window.ctxTargetSong)"><span class="material-icons-round">queue_play_next</span> Play Next</div>
            <div class="context-item" onclick="addToQueueDirect(window.ctxTargetSong)"><span class="material-icons-round">playlist_add</span> Add to Bottom</div>
            <div class="context-item" onclick="openPlaylistPicker(window.ctxTargetSong)"><span class="material-icons-round">favorite</span> Save to Local Favorites</div>
            <div class="context-item" onclick="shareTrackDirect(window.ctxTargetSong)"><span class="material-icons-round">share</span> Share Link</div>
        `;
    }
    else {
        return; // We didn't click anything important, do normal browser right-click
    }

    // Apply HTML and show menu
    menu.innerHTML = menuHtml;
    
    const menuHeight = 180; 
    let yPos = e.pageY;
    if (yPos + menuHeight > window.innerHeight) yPos = window.innerHeight - menuHeight;

    menu.style.left = `${e.pageX}px`; 
    menu.style.top = `${yPos}px`;
    menu.style.display = 'block'; 
});

// 3. Safe Click Listener (Hide Menu)
document.addEventListener('click', (e) => { 
    const menu = document.getElementById('custom-context-menu');
    if (menu && !e.target.closest('#custom-context-menu')) {
        menu.style.display = 'none'; 
    }
});

// ==========================================
// --- KINETIC ANIMATIONS & ACTION HELPERS ---
// ==========================================

function animateWhoosh(song, startX, startY, type) {
    // 1. Create the Ghost Card
    const ghost = document.createElement('div');
    ghost.className = 'flying-card';
    const safeT = song.t.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const coverHtml = song.cover ? `<img src="${song.cover}" style="width:36px; height:36px; border-radius:4px; object-fit:cover;">` : `<div style="width:36px; height:36px; background:#333; border-radius:4px; display:flex; align-items:center; justify-content:center;"><span class="material-icons-round" style="font-size:20px;">music_note</span></div>`;
    
    ghost.innerHTML = `
        ${coverHtml}
        <div style="font-size:0.9rem; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;">${safeT}</div>
    `;
    document.body.appendChild(ghost);

    // 2. Set Starting Position (Right at the mouse cursor)
    ghost.style.left = startX + 'px';
    ghost.style.top = startY + 'px';
    ghost.style.transform = 'scale(1)';

    // Force browser reflow so the transition takes effect
    void ghost.offsetWidth;

    // 3. Set Destination (The Sidebar Queue)
    const sidebar = document.querySelector('.yt-sidebar');
    let targetX = 130; // Roughly the center of the sidebar
    let targetY = window.innerHeight / 2; // Default to middle of sidebar

    if (sidebar) {
        const rect = sidebar.getBoundingClientRect();
        targetX = rect.left + (rect.width / 2) - 50;
        // If Play Next, fly toward the top of the queue. If Add to Bottom, fly toward the bottom.
        targetY = type === 'next' ? rect.top + 150 : rect.bottom - 100;
    }

    // 4. Trigger the Flight! (Shrink, fade, and fly to target)
    ghost.style.transform = `translate(${targetX - startX}px, ${targetY - startY}px) scale(0.15) rotate(-15deg)`;
    ghost.style.opacity = '0';

    // 5. Cleanup the DOM after flight finishes
    setTimeout(() => ghost.remove(), 600);
}

function playNextDirect(song) {
    animateWhoosh(song, window.ctxMouseX, window.ctxMouseY, 'next'); // Trigger Whoosh!
    queue.splice(curIdx + 1, 0, song);
    if (typeof draw === 'function') draw(); 
    if (typeof saveState === 'function') saveState();
    if (typeof showToast === 'function') showToast(`"${song.t}" will play next!`);
    document.getElementById('custom-context-menu').style.display = 'none';
}

function addToQueueDirect(song) {
    animateWhoosh(song, window.ctxMouseX, window.ctxMouseY, 'bottom'); // Trigger Whoosh!
    queue.push(song);
    if (typeof draw === 'function') draw(); 
    if (typeof saveState === 'function') saveState();
    if (typeof showToast === 'function') showToast(`"${song.t}" added to bottom of queue`);
    document.getElementById('custom-context-menu').style.display = 'none';
}

function openPlaylistPicker(song) {
    let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
    if (!localPl.some(s => s.t === song.t)) {
        localPl.push(song);
        localStorage.setItem('myLocalPlaylist', JSON.stringify(localPl));
        if (typeof showToast === 'function') showToast("Added to Local Favorites! ❤️");
    } else {
        if (typeof showToast === 'function') showToast("Already in favorites!");
    }
    document.getElementById('custom-context-menu').style.display = 'none';
}

function removeFromQueue(index) {
    queue.splice(index, 1);
    if (index < curIdx) curIdx--;
    else if (index === curIdx && queue.length > 0) play(curIdx >= queue.length ? 0 : curIdx);
    if (typeof draw === 'function') draw(); 
    if (typeof saveState === 'function') saveState();
    document.getElementById('custom-context-menu').style.display = 'none';
}

function shareTrackDirect(song) {
    navigator.clipboard.writeText(`Listening to ${song.t} by ${song.a} on Pro Media Player!`);
    if (typeof showToast === 'function') showToast("Share text copied!");
    document.getElementById('custom-context-menu').style.display = 'none';
}

openHistoryView = function() {
    // Find the history icon and force a clean CSS spin
    const histBtnIcon = document.querySelector('.top-nav-bar button .material-icons-round');
    if (histBtnIcon && histBtnIcon.innerText === 'history') {
        histBtnIcon.style.animation = 'none';
        void histBtnIcon.offsetWidth; // Trigger reflow
        histBtnIcon.style.animation = 'spin-once 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
    }
    originalOpenHistoryView();
};

// ==========================================
// --- SMART LISTENING HISTORY ENGINE ---
// ==========================================
function addToHistory(song) {
    if (!song) return;
    let history = JSON.parse(localStorage.getItem('playHistory') || '[]');
    
    // Generate a unique fingerprint for the song (Prioritize Local Path, then Online URL, then Title+Artist fallback)
    const uniqueId = song.p || song.ytId || (song.t + song.a);
    
    // 1. Remove the song if it already exists (Deduplication)
    history = history.filter(s => (s.p || s.ytId || (s.t + s.a)) !== uniqueId);
    
    // 2. Prepend it to the absolute top of the list
    history.unshift(song);
    
    // 3. Keep memory clean (Max 150 items)
    if (history.length > 150) history.pop();
    
    localStorage.setItem('playHistory', JSON.stringify(history));
    
    // Auto-refresh the view if the user is actively looking at it
    if (document.getElementById('view-history') && document.getElementById('view-history').classList.contains('active')) {
        renderHistoryView();
    }
}

function openHistoryView() {
    const histView = document.getElementById('view-history');
    
    // 🔥 THE TOGGLE FIX: If it's already active, go back home!
    if (histView && histView.classList.contains('active')) {
        switchToHomeView();
        return;
    }

    document.body.classList.add('home-mode');
    document.body.classList.remove('player-mode', 'immersive');
    switchView('history');
    renderHistoryView();

    // Spin animation
    const histBtnIcon = document.querySelector('.top-nav-bar button .material-icons-round');
    if (histBtnIcon && histBtnIcon.innerText === 'history') {
        histBtnIcon.style.animation = 'none';
        void histBtnIcon.offsetWidth; 
        histBtnIcon.style.animation = 'spin-once 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
    }
}

function renderHistoryView() {
    const container = document.getElementById('history-list');
    if (!container) return;
    
    const history = JSON.parse(localStorage.getItem('playHistory') || '[]');
    if (history.length === 0) {
        container.innerHTML = `<div style="color:var(--dim); padding: 50px; text-align: center; font-size: 1.2rem;">No history yet. Start playing some tracks!</div>`;
        return;
    }
    
    let html = '';
    history.forEach((s, i) => {
        // 🔥 THE FIX: Added flex-shrink: 0 so the album art never squishes or shifts
        let coverHtml = s.cover ? `<img src="${s.cover}" style="width: 45px !important; height: 45px !important; min-width: 45px !important; border-radius: 6px; object-fit: cover; flex-shrink: 0 !important; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">` : `<div style="width: 45px !important; height: 45px !important; min-width: 45px !important; border-radius: 6px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; flex-shrink: 0 !important;"><span class="material-icons-round" style="color:var(--dim);">audiotrack</span></div>`;
        
        let safeTitle = s.t ? s.t.replace(/'/g, "\\'").replace(/"/g, '&quot;') : 'Unknown';
        let safeArtist = s.a ? s.a.replace(/'/g, "\\'").replace(/"/g, '&quot;') : 'Unknown Artist';
        let encodedSong = encodeURIComponent(JSON.stringify(s));
        
        // 🔥 THE FIX: Switched from Grid to Flexbox and locked all margins with !important
        html += `
        <div class="track-row" data-type="history-item" data-song="${encodedSong}" onclick="playFromHistory(${i})" style="display: flex !important; flex-direction: row !important; align-items: center !important; padding: 10px 15px !important; border-radius: 8px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.05);">
            
            <div style="width: 30px !important; min-width: 30px !important; text-align: left !important; color: var(--dim) !important; font-size: 0.9rem !important; flex-shrink: 0 !important; margin: 0 !important; padding: 0 !important;">${i + 1}</div>
            
            ${coverHtml}
            
            <div style="display: flex !important; flex-direction: column !important; overflow: hidden !important; flex-grow: 1 !important; margin-left: 15px !important; margin-right: 15px !important; padding: 0 !important;">
                <div style="color: white !important; font-size: 1rem !important; font-weight: bold !important; white-space: nowrap !important; text-overflow: ellipsis !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important;">${safeTitle}</div>
                <div style="color: var(--dim) !important; font-size: 0.85rem !important; white-space: nowrap !important; text-overflow: ellipsis !important; overflow: hidden !important; margin: 2px 0 0 0 !important; padding: 0 !important;">${safeArtist}</div>
            </div>
            
            <div style="margin: 0 !important; padding: 0 !important; flex-shrink: 0 !important;">
                <span class="material-icons-round" style="color:var(--dim) !important; font-size:20px !important; margin: 0 !important; padding: 0 !important;" title="${s.isOnline ? 'Online Stream' : 'Local File'}">${s.isOnline ? 'cloud' : 'folder'}</span>
            </div>
            
        </div>`;
    });
    container.innerHTML = html;
}

function playFromHistory(index) {
    const history = JSON.parse(localStorage.getItem('playHistory') || '[]');
    const song = history[index];
    if (!song) return;

    // Inject the song immediately after the currently playing song
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, song);
    
    draw();
    saveState();
    switchToPlayerView();
    play(insertPos);
}

function playFromHistorySearch(encodedSong, targetId) {
    const song = JSON.parse(decodeURIComponent(encodedSong));
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, song);
    
    // Close all search panels cleanly
    const searchInputs = ['sidebar-search', 'imm-search'];
    searchInputs.forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
    const resultsDivs = ['sidebar-search-results', 'imm-search-results'];
    resultsDivs.forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });

    draw(); 
    saveState();
    switchToPlayerView();
    play(insertPos);
}

// ==========================================
// --- IMMERSIVE LAYOUT ENGINE ---
// ==========================================
let currentImmMode = 0;
const albumCoverEl = document.getElementById('album-cover');

if (albumCoverEl) {
    albumCoverEl.style.cursor = 'pointer';
    albumCoverEl.title = 'Click to change layout mode';
    
    albumCoverEl.addEventListener('click', (e) => {
        // Only allow clicking if we are actually in the fullscreen immersive view
        if (!document.body.classList.contains('immersive')) return;
        
        e.stopPropagation(); 
        currentImmMode = (currentImmMode + 1) % 3;
        
        // Wipe old layout classes
        document.body.classList.remove('imm-layout-1', 'imm-layout-2');
        
        if (currentImmMode === 1) {
            document.body.classList.add('imm-layout-1');
            showToast("🟢 Mode: Cyberpunk Studio");
        } 
        else if (currentImmMode === 2) {
            document.body.classList.add('imm-layout-2');
            showToast("🎨 Mode: Zen Artistic Canvas");
        } 
        else {
            showToast("📺 Mode: Classic UI");
        }
        
        // Give the browser time to animate, then recalculate the lyric scrolling math!
        setTimeout(() => { 
            if (typeof scrollToCurrentSong === 'function') scrollToCurrentSong(); 
        }, 500);
    });
}

// ==========================================
// --- REAL-TIME CANVAS VISUALIZER ENGINE ---
// ==========================================
let audioCtx, analyser, mediaSource;
let visDataArray;
let canvasLeft, ctxLeft, canvasRight, ctxRight;
let isDrawingWaveform = false; 
let activeVisColor = 'rgba(255, 255, 255,'; 

// Extract color from Album Art
const albumImgEl = document.getElementById('album-cover');
if (albumImgEl) {
    albumImgEl.addEventListener('load', function() {
        try {
            let c = document.createElement('canvas');
            c.width = 1; c.height = 1;
            let ctx = c.getContext('2d');
            ctx.drawImage(this, 0, 0, 1, 1);
            let [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            r = Math.min(255, r + 50); g = Math.min(255, g + 50); b = Math.min(255, b + 50);
            activeVisColor = `rgba(${r}, ${g}, ${b},`;
        } catch(e) { activeVisColor = 'rgba(255, 255, 255,'; }
    });
}

function initRealVisualizer() {
    const audioEl = document.querySelector('audio') || window.audio;
    if (!audioEl) return;

    if (!audioEl.visConnected) {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.7; 
            mediaSource = audioCtx.createMediaElementSource(audioEl);
            mediaSource.connect(analyser); analyser.connect(audioCtx.destination);
            audioEl.visConnected = true; 
            visDataArray = new Uint8Array(analyser.frequencyBinCount);
            canvasLeft = document.getElementById('vis-canvas-left');
            canvasRight = document.getElementById('vis-canvas-right');
            if (canvasLeft && canvasRight) { ctxLeft = canvasLeft.getContext('2d'); ctxRight = canvasRight.getContext('2d'); }
        } catch (e) { console.error("Audio Context Error:", e); }
    }
    
    // Start drawing loop IMMEDIATELY
    if (!isDrawingWaveform) {
        isDrawingWaveform = true;
        drawRealWaveform();
    }
}

function drawRealWaveform() {
    requestAnimationFrame(drawRealWaveform);

    if (!document.body.classList.contains('imm-layout-1')) {
        if (ctxLeft && ctxRight) {
            ctxLeft.clearRect(0, 0, canvasLeft.width, canvasLeft.height);
            ctxRight.clearRect(0, 0, canvasRight.width, canvasRight.height);
        }
        return; 
    }

    if (!visDataArray) return;
    analyser.getByteFrequencyData(visDataArray);

    ctxLeft.clearRect(0, 0, canvasLeft.width, canvasLeft.height);
    ctxRight.clearRect(0, 0, canvasRight.width, canvasRight.height);

    let gradLeft = ctxLeft.createLinearGradient(canvasLeft.width, 0, 0, 0);
    gradLeft.addColorStop(0, activeVisColor + ' 0.8)');
    gradLeft.addColorStop(1, activeVisColor + ' 0.0)');

    let gradRight = ctxRight.createLinearGradient(0, 0, canvasRight.width, 0);
    gradRight.addColorStop(0, activeVisColor + ' 0.8)');
    gradRight.addColorStop(1, activeVisColor + ' 0.0)');

    ctxLeft.fillStyle = gradLeft; ctxRight.fillStyle = gradRight;
    ctxLeft.lineWidth = 3; ctxLeft.strokeStyle = activeVisColor + ' 1)';
    ctxRight.lineWidth = 3; ctxRight.strokeStyle = activeVisColor + ' 1)';

    const usefulData = visDataArray.slice(2, 45); 
    const sliceHeight = canvasLeft.height / (usefulData.length - 1);
    let pointsLeft = []; let pointsRight = [];

    for (let i = 0; i < usefulData.length; i++) {
        let rawVal = usefulData[i];
        if (rawVal < 20) rawVal = 0; 
        let v = Math.pow(rawVal / 255, 1.5);
        let spikeWidth = v * canvasLeft.width;
        let y = i * sliceHeight;
        pointsLeft.push({ x: canvasLeft.width - spikeWidth, y: y });
        pointsRight.push({ x: spikeWidth, y: y });
    }

    function drawSmoothCurve(ctx, points, isLeft) {
        ctx.beginPath();
        if (isLeft) { ctx.moveTo(canvasLeft.width, points[0].y); ctx.lineTo(points[0].x, points[0].y); } 
        else { ctx.moveTo(0, points[0].y); ctx.lineTo(points[0].x, points[0].y); }

        for (let i = 0; i < points.length - 1; i++) {
            let p0 = points[i]; let p1 = points[i + 1];
            let midX = (p0.x + p1.x) / 2; let midY = (p0.y + p1.y) / 2;
            ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
        }
        let lastP = points[points.length - 1]; ctx.lineTo(lastP.x, lastP.y);

        if (isLeft) { ctx.lineTo(canvasLeft.width, lastP.y); ctx.lineTo(canvasLeft.width, points[0].y); } 
        else { ctx.lineTo(0, lastP.y); ctx.lineTo(0, points[0].y); }
        ctx.closePath(); ctx.fill();
        
        ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
        for (let i = 0; i < points.length - 1; i++) {
            let p0 = points[i]; let p1 = points[i + 1];
            let midX = (p0.x + p1.x) / 2; let midY = (p0.y + p1.y) / 2;
            ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
        }
        ctx.lineTo(lastP.x, lastP.y); ctx.stroke();
    }

    drawSmoothCurve(ctxLeft, pointsLeft, true); drawSmoothCurve(ctxRight, pointsRight, false);
}

// Pause listeners
const globalAudioEl = document.querySelector('audio') || window.audio;
if (globalAudioEl) {
    globalAudioEl.addEventListener('pause', () => document.body.classList.add('is-paused'));
    globalAudioEl.addEventListener('play', () => document.body.classList.remove('is-paused'));
}

// Smart Double Tap
const playerView = document.getElementById('view-player');
if (playerView) {
    playerView.removeAttribute('title'); // Removes the annoying ghost tooltip!
    playerView.addEventListener('mousedown', (e) => { if (e.detail > 1) e.preventDefault(); });

    playerView.addEventListener('dblclick', (e) => {
        if (!document.body.classList.contains('immersive')) return;
        if (e.target.closest('.lyric-line') || e.target.closest('.lyric-tools') || e.target.closest('.yt-player-bar')) return; 
        
        window.getSelection().removeAllRanges();
        currentImmMode = (currentImmMode + 1) % 3;
        document.body.classList.remove('imm-layout-1', 'imm-layout-2');
        
        const pBar = document.querySelector('.yt-player-bar');
        if (pBar) { pBar.style.transform = ''; pBar.style.opacity = ''; pBar.style.pointerEvents = ''; }

        if (currentImmMode === 1) {
            document.body.classList.add('imm-layout-1');
            if (typeof showToast === 'function') showToast("🟢 Mode: Cyberpunk Studio");
            isDrawingWaveform = false;
            initRealVisualizer(); // Starts it instantly!
        } 
        else if (currentImmMode === 2) {
            document.body.classList.add('imm-layout-2');
            if (typeof showToast === 'function') showToast("🎨 Mode: Zen Artistic Canvas");
        } 
        else {
            if (typeof showToast === 'function') showToast("📺 Mode: Classic UI");
            if (typeof resetInactivityTimer === 'function') resetInactivityTimer(); 
        }
        setTimeout(() => { if (typeof scrollToCurrentSong === 'function') window.scrollToCurrentSong(); }, 500);
    });
}

// ==========================================
// --- MISSING PLAYLIST & BUTTON HANDLERS ---
// ==========================================

// 1. Fixes: "openLocalPlaylist is not defined"
window.openLocalPlaylist = function() {
    let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
    if (localPl.length === 0) {
        if (typeof showToast === 'function') showToast("Your Local Playlist is empty! Right-click a song to add one.");
        return;
    }
    
    // Instantly load your local favorites into the queue and play them!
    queue = [...localPl];
    curIdx = 0;
    if (typeof draw === 'function') draw();
    if (typeof play === 'function') play(curIdx);
    if (typeof showToast === 'function') showToast("Loaded Local Favorites! ❤️");
    
    // Switch to player view to see the music playing
    const playerView = document.getElementById('view-player');
    if (playerView) {
        document.body.classList.add('player-mode');
        document.body.classList.remove('home-mode');
        if (typeof switchView === 'function') switchView('player');
    }
};

// 2. Fixes: "prompt() is not supported in Electron"
window.importYTPlaylist = function() {
    let modal = document.createElement('div');
    modal.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.8);z-index:30000;display:flex;justify-content:center;align-items:center;backdrop-filter:blur(10px);";
    modal.innerHTML = `
        <div style="background:#1b1b1b;padding:30px;border-radius:12px;width:450px;border:1px solid #333;box-shadow:0 20px 50px rgba(0,0,0,0.8);">
            <h2 style="margin-top:0;color:white;font-size:1.2rem;">Import YouTube Playlist</h2>
            <p style="color:var(--dim);font-size:0.85rem;">Paste a YouTube playlist URL or just the playlist ID (e.g. PLxxxxx)</p>
            <input type="text" id="yt-pl-input" placeholder="https://youtube.com/playlist?list=PLxxxxx" style="width:100%;box-sizing:border-box;padding:10px;margin:10px 0;background:rgba(0,0,0,0.5);border:1px solid #444;color:white;border-radius:6px;outline:none;font-size:0.95rem;">
            <input type="text" id="yt-pl-name" placeholder="Playlist name (optional)" style="width:100%;box-sizing:border-box;padding:10px;margin:5px 0 15px;background:rgba(0,0,0,0.5);border:1px solid #444;color:white;border-radius:6px;outline:none;font-size:0.9rem;">
            <div style="display:flex;justify-content:flex-end;gap:10px;">
                <button id="yt-pl-cancel" style="padding:8px 15px;background:transparent;border:none;color:#aaa;cursor:pointer;font-size:0.95rem;">Cancel</button>
                <button id="yt-pl-ok" style="padding:8px 20px;background:var(--accent,#4cc2ff);border:none;color:black;font-weight:bold;border-radius:6px;cursor:pointer;font-size:0.95rem;">Import</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const input = document.getElementById('yt-pl-input');
    input.focus();

    // Allow pressing Enter to submit
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('yt-pl-ok').click(); });

    document.getElementById('yt-pl-cancel').onclick = () => modal.remove();
    document.getElementById('yt-pl-ok').onclick = () => {
        let raw = input.value.trim();
        let name = document.getElementById('yt-pl-name').value.trim() || 'YouTube Playlist';
        modal.remove();
        if (!raw) return;

        // Extract just the playlist ID whether they pasted a full URL or the raw ID
        let playlistId = raw;
        const listMatch = raw.match(/[?&]list=([A-Za-z0-9_-]+)/);
        if (listMatch) playlistId = listMatch[1];

        // Save to sidebar
        let saved = JSON.parse(localStorage.getItem('customYTPlaylists') || '[]');
        if (!saved.some(p => p.id === playlistId)) {
            saved.push({ id: playlistId, title: name });
            localStorage.setItem('customYTPlaylists', JSON.stringify(saved));
            renderSidebarPlaylists();
        }

        // Open it immediately using the CORRECT IPC handler from main.js
        fetchYTPlaylist(playlistId, name);
    };
};

// 3. Fixes: "Not Supported Error" (Forces JioSaavn/Stream Search for YT Strings)
window.act = function(songDataStr) {
    try {
        let song = JSON.parse(decodeURIComponent(songDataStr));
        
        // 🔥 THE FIX: Explicitly flag this as an online track requiring backend fetching!
        if (!song.p && !song.url) song.needsAudioStream = true; 

        let insertPos = queue.length === 0 ? 0 : (typeof curIdx !== 'undefined' ? curIdx + 1 : queue.length);
        queue.splice(insertPos, 0, song);
        
        if (typeof draw === 'function') draw();
        if (typeof play === 'function') play(insertPos);
        
        if (typeof showToast === 'function') showToast(`Playing: ${song.t}`);
        document.body.classList.add('player-mode');
        document.body.classList.remove('home-mode');
        if (typeof switchView === 'function') switchView('player');
    } catch (e) { console.error("Failed to parse clicked song data:", e); }
};

// ==========================================
// --- BUG FIX OVERRIDES ---
// ==========================================

// Fixes: "originalOpenHistoryView is not defined"
window.openHistoryView = function() {
    const histView = document.getElementById('view-history');
    if (histView && histView.classList.contains('active')) {
        if (typeof switchToHomeView === 'function') switchToHomeView();
        return;
    }
    document.body.classList.add('home-mode');
    document.body.classList.remove('player-mode', 'immersive');
    if (typeof switchView === 'function') switchView('history');
    if (typeof renderHistoryView === 'function') renderHistoryView();

    const histBtnIcon = document.querySelector('.top-nav-bar button .material-icons-round');
    if (histBtnIcon && histBtnIcon.innerText === 'history') {
        histBtnIcon.style.animation = 'none';
        void histBtnIcon.offsetWidth; 
        histBtnIcon.style.animation = 'spin-once 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
    }
};

// Fixes: "Cannot read properties of undefined (reading 'offsetTop')"
const originalScrollToSong = window.scrollToCurrentSong;
window.scrollToCurrentSong = function() {
    try {
        const activeItem = document.querySelector('.item.active, .track-row.active');
        // 🔥 THE FIX: Only attempt to scroll if the element actually exists and has a parent!
        if (activeItem && activeItem.parentElement) {
            activeItem.parentElement.scrollTo({
                top: activeItem.offsetTop - activeItem.parentElement.offsetTop - 50,
                behavior: 'smooth'
            });
        }
    } catch (e) {
        console.warn("Scroll bypassed safely.");
    }
};
document.getElementById('player').addEventListener('playing', () => {
    if (document.body.classList.contains('imm-layout-1')) {
        isDrawingWaveform = false;
        initRealVisualizer();
    }
});
//yo