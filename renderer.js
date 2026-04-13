const ctxMenu = document.getElementById('custom-context-menu');
let ctxTarget = null;
let toastTimeout;
function showToast(msg) {
    const toast = document.getElementById('toast');
    if(!toast) return;
    toast.innerText = msg;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 4000);
}

// Checks computer memory to see if you left lyrics ON or OFF last time
let lyricsEnabled = localStorage.getItem('lyricsEnabled') !== 'false';
const { webUtils, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let queue = [], curIdx = 0, lyrics = [], lyrIdx = -1;
let draggedIdx = null;
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
            // We ensure the click function clears the UI
            html += `
            <div class="item" onclick="playNextSearch(${i}, '${targetId}')" style="cursor:pointer;">
                <div class="item-left"><span class="material-icons-round" style="font-size:16px;">${icon}</span> ${s.t} - <small>${s.a}</small></div>
            </div>`;
        }
    });
    if (!localFound) html += `<div style="padding:10px; color:var(--dim); text-align:center; font-size: 0.85rem;">No local match</div>`;
    
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
async function fetchOnlineSearch(query, targetId) {
    const container = document.getElementById(targetId);
    if (!container) return;
    
    try {
        // THE FIX: Direct fetch to JioSaavn API instead of YT Music
        let res = await fetch(`https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(query)}&limit=15`);
        let json = await res.json();
        let results = (json.data && json.data.results) ? json.data.results : [];
        
        if (results.length === 0) {
            container.innerHTML = `<div style="padding:15px; color:var(--dim); text-align:center;">No results found</div>`;
            return;
        }
        
        let html = '';
        results.forEach((song) => {
            let title = (song.name || "Unknown").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            let artist = song.artists?.primary?.[0]?.name.replace(/&quot;/g, '"').replace(/&amp;/g, '&') || "Unknown";
            let cover = song.image?.length > 0 ? song.image[song.image.length - 1].url : "";
            let dl = song.downloadUrl?.length > 0 ? song.downloadUrl[song.downloadUrl.length - 1].url : "";

            // Only add tracks that have a direct playable audio link
            if (dl) {
                // Build the perfect song object that skips the audio resolver
                let sObj = {
                    t: title,
                    a: artist,
                    cover: cover,
                    p: dl, // The direct audio link
                    isOnline: true,
                    needsAudioStream: false // THE MAGIC FLAG: Plays instantly!
                };
                
                // Encode the song so we can safely inject it into the HTML click event
                let safeSong = encodeURIComponent(JSON.stringify(sObj));
                let safeT = title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                let safeA = artist.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                
                html += `
                <div class="item" onclick="addOnlineSong('${safeSong}')" style="cursor:pointer; display:flex; align-items:center; padding:10px; border-bottom:1px solid #333;">
                    <img src="${cover}" style="width:40px; height:40px; border-radius:4px; margin-right:12px; object-fit:cover;">
                    <div class="item-left" style="overflow: hidden;">
                        <div style="font-weight:bold; font-size:0.9rem; color:white; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${safeT}</div>
                        <small style="color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block;">${safeA}</small>
                    </div>
                    <span class="material-icons-round" style="margin-left:auto; color:var(--accent); font-size:18px;">add_circle_outline</span>
                </div>`;
            }
        });
        
        if (html === '') {
             container.innerHTML = `<div style="padding:15px; color:var(--dim); text-align:center;">No playable results found</div>`;
        } else {
             container.innerHTML = html;
        }
    } catch (e) {
        container.innerHTML = `<div style="padding:15px; color:red; text-align:center;">Search failed</div>`;
    }
}

// Helper function to add the clicked YT Music song to your queue
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

function addNextOnline(title, artist, cover, url) {
    const newSong = { t: title, a: artist, p: url, isOnline: true, cover: cover };
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, newSong);
    
    const sideSearch = document.getElementById('sidebar-search');
    const immSearch = document.getElementById('imm-search');
    const immResults = document.getElementById('imm-search-results');
    if (sideSearch) sideSearch.value = '';
    if (immSearch) immSearch.value = '';
    if (immResults) immResults.style.display = 'none';

    draw(); saveState();
    
    if (queue.length === 1) play(0);

    setTimeout(() => {
    const qList = document.getElementById('queue-list');
    const hList = document.getElementById('hover-queue-list');
    if(qList && qList.children[insertPos]) qList.children[insertPos].scrollIntoView({ behavior: 'smooth', block: 'center' });
    if(hList && hList.children[insertPos]) hList.children[insertPos].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);

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

function draw() {
    const sideSearch = document.getElementById('sidebar-search');
    const searchTerm = sideSearch ? sideSearch.value : '';
    if(searchTerm) return; 
    
    const qList = document.getElementById('queue-list');
    const hList = document.getElementById('hover-queue-list');
    
    // 1. Save exactly where the user is currently scrolled!
    const qScroll = qList ? qList.scrollTop : 0;
    const hScroll = hList ? hList.scrollTop : 0;

    const html = queue.map((s, i) => {
    let icon = s.isOnline ? "cloud" : "drag_indicator";
    return `
    <div class="item ${i===curIdx?'active':''}" draggable="true" ondragstart="dragStart(event, ${i})" ondragend="dragEnd(event)" ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="drop(event, ${i})" onclick="play(${i})">
        <div class="item-left"><span class="material-icons-round drag-handle">${icon}</span> ${i+1}. ${s.t}</div>
        <div class="del-btn" onclick="event.stopPropagation(); queue.splice(${i}, 1); if(${i} < curIdx) curIdx--; else if(${i} === curIdx && queue.length > 0) play(curIdx >= queue.length ? 0 : curIdx); draw(); saveState();">✕</div>        </div>
    `}).join('');
    
    if(qList) qList.innerHTML = html;
    if(hList) hList.innerHTML = html;
    
    // 2. Instantly restore their scroll position so it never jumps!
    if(qList) qList.scrollTop = qScroll;
    if(hList) hList.scrollTop = hScroll;
}

// MUST have the word 'async' here!
let playSessionId = 0; // Prevents the "Glitchy Swipe" Race Condition

async function play(i) {
    if(i < 0 || i >= queue.length) return;
    
    playSessionId++; // Generate a new ticket for this specific song request
    lastPreloadedIdx = -1;
    const mySessionId = playSessionId; 

    switchToPlayerView();
    curIdx = i; const s = queue[i];
    isUserScrolling = false;
    document.getElementById('cur-t').innerText = s.t;
    document.getElementById('cur-a').innerText = s.a;
    
    currentSongId = s.ytId || (s.a + " - " + s.t);
    if (typeof updateToolIcons === 'function') updateToolIcons();
    draw(); saveState();
    
    if (typeof scrollToCurrentSong === 'function') scrollToCurrentSong();
    
    const audio = document.getElementById('player');

    if(s.isOnline) {
        if (s.cover) {
            document.getElementById('album-cover').src = s.cover;
            document.getElementById('album-cover').style.display = "block";
            document.getElementById('bg-blur').style.backgroundImage = `url(${s.cover})`;
        } else {
            if (typeof fallbackArt === 'function') fallbackArt(s.t || 'Unknown');
        }

        // Only fetch if we DON'T have a cached URL
        if (s.needsAudioStream || !s.p || s.p.trim() === "") {
            showToast(`Resolving audio for: ${s.t}...`);
            let foundStream = false;

            // 1. COBALT API (Fastest & Most Reliable)
            if (s.ytId && !foundStream) {
                try {
                    let res = await fetch("https://co.wuk.sh/api/json", {
                        method: "POST",
                        headers: { "Accept": "application/json", "Content-Type": "application/json" },
                        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${s.ytId}`, isAudioOnly: true }),
                        signal: AbortSignal.timeout(6000)
                    });
                    if (res.ok) {
                        let json = await res.json();
                        if (json && json.url) { s.p = json.url; foundStream = true; }
                    }
                } catch(e) {}
            }

            // 2. PIPED API FAILOVER (Mirrors)
            if (!foundStream && s.ytId) {
                const pipedServers = ["https://pipedapi.kavin.rocks", "https://pipedapi.smnz.de", "https://api.piped.projectsegfau.lt"];
                for (const server of pipedServers) {
                    try {
                        let res = await fetch(`${server}/streams/${s.ytId}`, { signal: AbortSignal.timeout(4000) });
                        if (res.ok) {
                            let json = await res.json();
                            let bestAudio = json.audioStreams?.find(st => st.mimeType?.includes("mp4") || st.mimeType?.includes("webm"));
                            if (bestAudio?.url) { s.p = bestAudio.url; foundStream = true; break; }
                        }
                    } catch (e) {}
                }
            }

            // 3. JIOSAAVN FALLBACK 
            if (!foundStream) {
                const saavnApis = [
                    `https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(s.a + " " + s.t)}&limit=1`,
                    `https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(s.t)}&limit=1` 
                ];
                for (const url of saavnApis) {
                    try {
                        let res = await fetch(url, { signal: AbortSignal.timeout(5000) });
                        let json = await res.json();
                        let results = json.data?.results || [];
                        if (results.length > 0 && results[0].downloadUrl?.length > 0) {
                            s.p = results[0].downloadUrl[results[0].downloadUrl.length - 1].url;
                            foundStream = true; break;
                        }
                    } catch (e) {}
                }
            }

            // RACE CONDITION CHECK: Did the user swipe to a new song while we were downloading?
            // If yes, abort this function entirely so it doesn't hijack the player!
            if (mySessionId !== playSessionId) return; 

            // 4. ANTI-CRASH CHECK
            if (!foundStream || !s.p || s.p.trim() === "" || s.p.includes("index.html")) {
                showToast(`Audio unavailable. Skipping...`);
                audio.removeAttribute('src'); 
                setTimeout(() => { if (typeof playNext === 'function') playNext(); }, 2000);
                return; 
            }
            
            // SAVE IT! So next time you click it, it loads instantly!
            s.needsAudioStream = false;
            saveState();
        }

        // RACE CONDITION CHECK 2: Just to be safe before hitting play
        if (mySessionId !== playSessionId) return;

        // 5. ACTUALLY PLAY THE SONG 
        audio.src = s.p;
        audio.load();
        audio.play().catch(e => {
            console.error("Playback error:", e);
            audio.removeAttribute('src');
            setTimeout(() => { if (typeof playNext === 'function') playNext(); }, 2000);
        });

    } else {
        if (s.p && s.p.trim() !== "") {
            audio.src = encodeURI(`file://${s.p.replace(/\\/g, '/')}`);
            audio.load();
            audio.play().catch(e => console.error(e));
            if (typeof extractAlbumArt === 'function') extractAlbumArt(s); 
        }
    }
    
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: s.t, artist: s.a });
    if (typeof getLyrics === 'function') getLyrics(s);
}  

function extractAlbumArt(song) {
    const coverImg = document.getElementById('album-cover');
    const bgBlur = document.getElementById('bg-blur');
    fetch(`file://${song.p.replace(/\\/g, '/')}`).then(res => res.blob()).then(blob => {
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

// Helper to update both AI buttons at once
function updateAIButtons(display, title, isSpinning = false) {
    const btn1 = document.getElementById('btn-ai-sync');
    const btn2 = document.getElementById('main-ai-btn');
    if (btn1) {
        btn1.style.display = display;
        btn1.title = title;
        btn1.innerText = isSpinning ? 'sync' : 'auto_awesome';
        btn1.style.animation = isSpinning ? 'spin 2s linear infinite' : 'none';
    }
    if (btn2) {
        btn2.style.display = display;
        btn2.title = title;
        btn2.innerText = isSpinning ? 'sync' : 'auto_awesome';
        btn2.style.animation = isSpinning ? 'spin 2s linear infinite' : 'none';
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
    if (!song || song.isOnline) return;

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
    return new Promise(async (resolve, reject) => {
        try {
            if (!aiWorker) aiWorker = new Worker('./ai-worker.js', { type: 'module' });

            // Use Electron's built-in Web Audio API to decode MP3 instantly (No FFMPEG needed!)
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const fileBuffer = fs.readFileSync(song.p);
            const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            
            const messageHandler = (event) => {
                const data = event.data;
                if (data.status === 'done' && data.songPath === song.p) {
                    aiWorker.removeEventListener('message', messageHandler);
                    resolve({ lrc: data.lrc, song: song });
                } else if (data.status === 'error' && data.songPath === song.p) {
                    aiWorker.removeEventListener('message', messageHandler);
                    reject(new Error(data.message));
                }
            };
            
            aiWorker.addEventListener('message', messageHandler);
            aiWorker.postMessage({ audioData: audioBuffer.getChannelData(0), songPath: song.p });
        } catch (error) { reject(error); }
    });
}

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
      } else if (!s.isOnline) {
          lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter: blur(0px);">No lyrics found in database.</p>';
          showToast("No lyrics found. Click ✨ to Generate Locally.");
          updateAIButtons('block', 'Generate Lyrics with AI', false);
      } else {
          localStorage.setItem('apiEmpty_' + cSongId, "true");
          lContent.innerHTML = '<p class="lyric-line" style="opacity: 1; filter:blur(0)">No synced lyrics found in database.</p>'; 
      }
    }

  } catch(e) { 
    console.error("Lyric Fetch Error:", e);
    lContent.innerHTML = `<p class="lyric-line" style="opacity: 1; filter:blur(0); color:#ff4c4c;">App Error: ${e.message}</p>`;
  }
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
    } else if (!isSynced && queue[curIdx] && !queue[curIdx].isOnline) {
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
audio.addEventListener('error', () => {
    console.error('Audio playback error', audio.error, audio.src);
    
    // 1. Stop the infinite index.html crash loop!
    if (!audio.src || audio.src.includes("index.html") || audio.src === window.location.href) {
        return; 
    }

    // 2. Auto-Heal Expired YouTube Links!
    const s = queue[curIdx];
    if (s && s.isOnline && s.ytId && s.p && !audio.src.includes("saavn")) {
        console.log("YouTube link likely expired. Re-fetching fresh audio...");
        s.p = ""; // Clear the dead URL
        s.needsAudioStream = true; // Force a fresh fetch
        saveState();
        play(curIdx); // Re-trigger play seamlessly
        return;
    }
    
    // 3. If it's truly broken, skip.
    showToast('Audio stream failed. Skipping...');
    if (queue.length > 1) playNext();
});

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

function playNext() { 
  if (curIdx + 1 < queue.length) {
    play(curIdx + 1);
  } else {
    audio.pause();
    audio.currentTime = 0;
    document.getElementById('p-icon').innerText = 'play_arrow';
  }
}
    
function playPrev() { 
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
audio.onended = playNext;


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
        lView.scrollTo({top: ps[lyrIdx].offsetTop - (lView.clientHeight/2) + 20, behavior:'smooth'});
    }
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
            lView.scrollTo({top: ps[act].offsetTop - (lView.clientHeight/2) + 20, behavior:'smooth'});
        }
        }
    }
    }
};
document.getElementById('pb').onclick = (e) => audio.currentTime = (e.offsetX / e.target.clientWidth) * audio.duration;

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
    
    let counts = {};
    queue.forEach(s => {
        if (s.a && s.a !== 'Unknown') {
            s.a.split(',').forEach(a => { let trimA = a.trim(); if(trimA) counts[trimA] = (counts[trimA] || 0) + 1; });
        }
    });
    let topArtists = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
    
    let shelves = [];
    if (topArtists.length > 0) shelves.push({ q: topArtists[0], title: `Because you love ${topArtists[0]}`, type: 'songs' });
    if (topArtists.length > 1) shelves.push({ q: topArtists[1], title: `More from ${topArtists[1]}`, type: 'songs' });
    if (topArtists.length > 2) shelves.push({ q: topArtists[2], title: `${topArtists[2]} Mixes & Playlists`, type: 'playlists' });
    
    const fallbacks = [
        { q: "Global Top 50", title: "Global Playlists", type: "playlists" },
        { q: "Viral Hits", title: "Internet Viral Songs", type: "songs" },
        { q: "Lo-Fi Chill", title: "Deep Focus & Chill", type: "playlists" },
        { q: "Party Anthems", title: "Weekend Party Playlists", type: "playlists" },
        { q: "Acoustic Pop", title: "Unplugged & Acoustic", type: "songs" }
    ];
    shelves = [...shelves, ...fallbacks];

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
        if (shelves[i].type === 'playlists') populatePlaylistCarousel(shelves[i].q, `carousel-${i}`);
        else populateCarousel(shelves[i].q, `carousel-${i}`);
    }
}

async function populateCarousel(query, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    try {
        let res = await fetch(`https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(query)}&limit=15`);
        let json = await res.json();
        let results = (json.data && json.data.results) ? json.data.results : [];

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
     onclick="playDirectlyFromHome('${safeT}', '${safeA}', '${safeC}', '${safeDL}')">
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
        let res = await fetch(`https://saavn.sumit.co/api/search/playlists?query=${encodeURIComponent(query)}&limit=10`);
        let json = await res.json();
        let results = (json.data && json.data.results) ? json.data.results : [];

        if (results.length > 0) {
            let html = "";
            results.forEach(pl => {
                let title = (pl.title || pl.name || "Unknown").replace(/'/g, "\\'").replace(/"/g, '&quot;');
                let cover = pl.image?.length > 0 ? pl.image[pl.image.length - 1].url : "";
                
                html += `
                <div class="song-card" style="border-radius: 20px; background: rgba(0,0,0,0.4);" onclick="loadSaavnPlaylist('${pl.id}', '${title}')">
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
        let res = await fetch(`https://saavn.sumit.co/api/playlists?id=${id}`);
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
                switchQueueMode('playlist'); 
                queue = mappedSongs; 
                curIdx = 0;
                draw(); saveState(); switchToPlayerView(); play(0);
                showToast(`Playing ${titleName}!`);
            } else showToast("No playable tracks in this playlist.");
        }
    } catch (e) { showToast("Failed to load playlist."); }
}

function playDirectlyFromHome(title, artist, cover, url) {
    const newSong = { t: title, a: artist, p: url, isOnline: true, cover: cover };
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, newSong);
    saveState(); play(insertPos); switchToPlayerView();
    const sideSearch = document.getElementById('sidebar-search-results');
    const immSearch = document.getElementById('imm-search-results');
    if (sideSearch) sideSearch.style.display = 'none';
    if (immSearch) immSearch.style.display = 'none';
}

// ==========================================
// --- 2. DUAL QUEUE SYSTEM ---
// ==========================================
let mainQueue = [], mainIdx = 0;
let plQueue = [], plIdx = 0;
let activeQMode = 'main';

function switchQueueMode(mode) {
    if (activeQMode === mode) return;

    if (activeQMode === 'main') { mainQueue = [...queue]; mainIdx = curIdx; } 
    else { plQueue = [...queue]; plIdx = curIdx; }

    activeQMode = mode;

    if (activeQMode === 'main') { queue = [...mainQueue]; curIdx = mainIdx; } 
    else { queue = [...plQueue]; curIdx = plIdx; }

    document.getElementById('btn-q-main').classList.toggle('active', mode === 'main');
    document.getElementById('btn-q-pl').classList.toggle('active', mode === 'playlist');
    
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

function saveToPlaylist() { showToast("Saved to Local Playlist!"); toggleMenu(); }

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
    const panels = ['home', 'playlist', 'player'];
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
        tracklistEl.innerHTML = `<div style="color: red; padding: 20px;">Failed to load. Is the playlist public?</div>`; 
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
        html += `
        <div class="track-row" onclick="playFromPlaylist(${i})">
            <div class="track-num">${i + 1}</div>
            <div style="display:flex; flex-direction:column; overflow:hidden;">
                <span style="color:white; font-weight:bold; white-space:nowrap; text-overflow:ellipsis;">${song.t}</span>
                <span style="color:var(--dim); font-size:0.85rem; white-space:nowrap; text-overflow:ellipsis;">${song.a}</span>
            </div>
            <span class="material-icons-round" style="color:var(--dim); font-size:18px;">more_horiz</span>
        </div>`;
    });
    tracklistEl.innerHTML = html;
}

function playFromPlaylist(index) {
    switchQueueMode('playlist'); 
    queue = [...currentLoadedPlaylist];
    curIdx = index;
    saveState(); draw(); switchView('player'); play(index);
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

// ==========================================
// --- 5. CUSTOM RIGHT CLICK & LOCAL PLAYLIST ---
// ==========================================

document.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.song-card');
    if (card && card.getAttribute('data-type') === 'song') {
        e.preventDefault();
        ctxTargetSong = {
            t: card.getAttribute('data-title'), a: card.getAttribute('data-artist'),
            cover: card.getAttribute('data-cover'), p: card.getAttribute('data-url'),
            isOnline: true, needsAudioStream: false
        };
        ctxMenu.style.left = `${e.pageX}px`; ctxMenu.style.top = `${e.pageY}px`;
        ctxMenu.classList.add('active');
    }
});

// Safe Click Listener (Fixes Line 1955 Crash)
document.addEventListener('click', (e) => { 
    if (ctxMenu && !e.target.closest('#custom-context-menu')) {
        ctxMenu.classList.remove('active'); 
    }
});

// ==========================================
// --- CRASH-PROOF MENU ACTIONS ---
// ==========================================

// We use 'if (element)' so the app NEVER crashes, even if HTML is missing!
const btnPlayNext = document.getElementById('ctx-play-next');
if (btnPlayNext) {
    btnPlayNext.onclick = () => {
        if (!ctxTargetSong) return;
        queue.splice(queue.length === 0 ? 0 : curIdx + 1, 0, ctxTargetSong);
        if (typeof draw === 'function') draw(); 
        if (typeof saveState === 'function') saveState(); 
        showToast(`Added "${ctxTargetSong.t}" to play next!`);
        ctxMenu.classList.remove('active');
    };
}

const btnAddBottom = document.getElementById('ctx-add-bottom');
if (btnAddBottom) {
    btnAddBottom.onclick = () => {
        if (!ctxTargetSong) return;
        queue.push(ctxTargetSong);
        if (typeof draw === 'function') draw(); 
        if (typeof saveState === 'function') saveState(); 
        showToast(`Added "${ctxTargetSong.t}" to bottom!`);
        ctxMenu.classList.remove('active');
    };
}

const btnSaveLocal = document.getElementById('ctx-save-local');
if (btnSaveLocal) {
    btnSaveLocal.onclick = () => {
        if (!ctxTargetSong) return;
        let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
        if (!localPl.some(s => s.t === ctxTargetSong.t)) {
            localPl.push(ctxTargetSong);
            localStorage.setItem('myLocalPlaylist', JSON.stringify(localPl));
            showToast("Saved to Local Favorites! ❤️");
        } else showToast("Already in your favorites!");
        ctxMenu.classList.remove('active');
    };
}

const btnShare = document.getElementById('ctx-share');
if (btnShare) {
    btnShare.onclick = () => {
        if (!ctxTargetSong) return;
        navigator.clipboard.writeText(`I'm listening to ${ctxTargetSong.t} by ${ctxTargetSong.a}!`);
        showToast("Share text copied!");
        ctxMenu.classList.remove('active');
    };
}

function openLocalPlaylist() {
    let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
    document.body.classList.remove('player-mode'); switchView('playlist');
    document.getElementById('pl-detail-title').innerText = "Local Favorites ❤️";
    document.getElementById('pl-track-count').innerText = localPl.length;
    document.getElementById('pl-detail-img').src = localPl.length > 0 ? localPl[0].cover : 'https://via.placeholder.com/230';
    
    const tracklistEl = document.getElementById('playlist-tracklist');
    if (localPl.length === 0) {
        tracklistEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--dim);">Your favorites list is empty.<br>Right-click songs on the Explore page to add them!</div>`;
        return;
    }
    currentLoadedPlaylist = localPl; 
    let html = '';
    localPl.forEach((song, i) => {
        html += `<div class="track-row" onclick="playFromPlaylist(${i})">
            <div class="track-num">${i + 1}</div>
            <div style="display:flex; flex-direction:column; overflow:hidden;">
                <span style="color:white; font-weight:bold; white-space:nowrap; text-overflow:ellipsis;">${song.t}</span>
                <span style="color:var(--dim); font-size:0.85rem; white-space:nowrap; text-overflow:ellipsis;">${song.a}</span>
            </div>
            <span class="material-icons-round" style="color:#4cc2ff; font-size:18px;">favorite</span>
        </div>`;
    });
    tracklistEl.innerHTML = html;
}

// ==========================================
// --- NEW: MANUAL PLAYLIST IMPORTER ---
// ==========================================

async function importYTPlaylist() {
    const input = document.getElementById('new-pl-input');
    const url = input.value.trim();
    if(!url) return;

    // Extract the Playlist ID from the URL
    let match = url.match(/[?&]list=([^&#]+)/) || url.match(/^([a-zA-Z0-9_-]+)$/);
    if(!match) {
        showToast("Invalid YouTube Playlist URL!");
        return;
    }
    const plId = match[1];

    showToast("Scraping Playlist Data...");
    const btn = document.querySelector('button[onclick="importYTPlaylist()"]');
    if (btn) btn.innerText = "Syncing...";

    try {
        // Fetch public metadata (No login required!)
        const data = await ipcRenderer.invoke('get-yt-playlist', plId);
        
        if(!data || !data.songs) {
            showToast("Failed to fetch. Is the playlist public?");
            if (btn) btn.innerText = "+ Add Playlist";
            return;
        }

        let saved = JSON.parse(localStorage.getItem('customYTPlaylists') || '[]');
        if(saved.some(p => p.id === plId)) {
            showToast("Playlist already added!");
            input.value = '';
            if (btn) btn.innerText = "+ Add Playlist";
            return;
        }

        saved.push({ id: plId, title: data.name || data.title || "Custom Playlist" });
        localStorage.setItem('customYTPlaylists', JSON.stringify(saved));
        
        input.value = '';
        showToast(`Saved "${data.name || data.title || 'Playlist'}"!`);
        renderSidebarPlaylists(); 
    } catch (e) {
        showToast("Scraping Error.");
    }
    if (btn) btn.innerText = "+ Add Playlist";
}

function renderSidebarPlaylists() {
    const container = document.getElementById('sidebar-playlists');
    if (!container) return;

    // 1. Always render the Local Favorites first
    let html = `
        <a class="menu-item playlist-link" onclick="openLocalPlaylist()">
            <span class="material-icons-round" style="color:#4cc2ff">favorite</span> 
            <span class="playlist-name" style="font-weight:bold; color:white;">Local Favorites</span>
        </a>
    `;

    // 2. Render all manually added YouTube Playlists
    let saved = JSON.parse(localStorage.getItem('customYTPlaylists') || '[]');
    saved.forEach(pl => {
        let safeTitle = pl.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        html += `
        <div style="display:flex; justify-content:space-between; align-items:center; padding-right:10px;" class="menu-item playlist-link">
            <a onclick="fetchYTPlaylist('${pl.id}', '${safeTitle}')" style="flex:1; cursor:pointer; display:flex; align-items:center; gap:10px; overflow:hidden;">
                <span class="material-icons-round" style="color:#ff0000">play_circle</span>
                <span class="playlist-name" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${pl.title}</span>
            </a>
            <span class="material-icons-round" style="color:var(--dim); cursor:pointer; font-size:14px;" onclick="removePlaylist('${pl.id}')" title="Remove">close</span>
        </div>`;
    });

    container.innerHTML = html;
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

    // 3. Nuke ALL symbols. Keep ONLY letters, numbers, and spaces.
    title = title.replace(/[^a-zA-Z0-9\s]/g, ' ');

    // 4. The Smart Logic: Scrub the artist's name OUT of the title to prevent duplicate queries!
    let mainArtist = rawArtist.split(',')[0].trim();
    if (mainArtist && mainArtist.toLowerCase() !== "unknown artist") {
        // Break the artist name into parts (e.g., "Mark", "Ronson") and scrub them from the title
        let artistParts = mainArtist.split(' ');
        artistParts.forEach(part => {
            if (part.length > 2) { // Don't scrub tiny 1-2 letter words accidentally
                let partRegex = new RegExp(`\\b${part}\\b`, 'ig');
                title = title.replace(partRegex, ' ');
            }
        });
    }

    // 5. Collapse all the empty spaces left behind into a clean string
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
        // (This assumes your function is called fetchLyrics or loadLyrics)
        if (typeof fetchLyrics === 'function') {
            fetchLyrics();
        } else if (typeof loadLyrics === 'function') {
            loadLyrics();
        }
    }
});

// ==========================================
// --- BACKGROUND AUDIO PRELOADER ---
// ==========================================
let lastPreloadedIdx = -1;

async function preloadNextSong() {
    const nextIdx = curIdx + 1;
    if (nextIdx >= queue.length) return; // Stop if we are at the end of the playlist
    
    // Prevent spamming the API if we already preloaded this song
    if (lastPreloadedIdx === nextIdx) return; 

    const nextSong = queue[nextIdx];
    
    // If it's a local file, or if we already have the URL saved, do nothing!
    if (!nextSong.isOnline || (!nextSong.needsAudioStream && nextSong.p)) return; 

    lastPreloadedIdx = nextIdx; // Lock it so it only runs once
    console.log(`[Preloader] Silently fetching audio for next track: ${nextSong.t}...`);

    let foundStream = false;

    // 1. COBALT
    if (nextSong.ytId && !foundStream) {
        try {
            let res = await fetch("https://co.wuk.sh/api/json", {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${nextSong.ytId}`, isAudioOnly: true }),
                signal: AbortSignal.timeout(6000)
            });
            if (res.ok) {
                let json = await res.json();
                if (json && json.url) { nextSong.p = json.url; foundStream = true; }
            }
        } catch(e) {}
    }

    // 2. PIPED
    if (!foundStream && nextSong.ytId) {
        const pipedServers = ["https://pipedapi.kavin.rocks", "https://pipedapi.smnz.de", "https://api.piped.projectsegfau.lt"];
        for (const server of pipedServers) {
            try {
                let res = await fetch(`${server}/streams/${nextSong.ytId}`, { signal: AbortSignal.timeout(4000) });
                if (res.ok) {
                    let json = await res.json();
                    let bestAudio = json.audioStreams?.find(st => st.mimeType?.includes("mp4") || st.mimeType?.includes("webm"));
                    if (bestAudio?.url) { nextSong.p = bestAudio.url; foundStream = true; break; }
                }
            } catch (e) {}
        }
    }

    // 3. SAAVN
    if (!foundStream) {
        const saavnApis = [
            `https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(nextSong.a + " " + nextSong.t)}&limit=1`,
            `https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(nextSong.t)}&limit=1`
        ];
        for (const url of saavnApis) {
            try {
                let res = await fetch(url, { signal: AbortSignal.timeout(5000) });
                let json = await res.json();
                let results = json.data?.results || [];
                if (results.length > 0 && results[0].downloadUrl?.length > 0) {
                    nextSong.p = results[0].downloadUrl[results[0].downloadUrl.length - 1].url;
                    foundStream = true; break;
                }
            } catch (e) {}
        }
    }

    if (foundStream && nextSong.p) {
        nextSong.needsAudioStream = false; // Mark it as ready!
        saveState();
        console.log(`[Preloader] Success! Next song is locked and loaded.`);
    } else {
        lastPreloadedIdx = -1; // If it fails, reset it so play() can try again normally
    }
}


// Call this inside your existing window.onload
const originalOnload = window.onload;
window.onload = () => {
    if(originalOnload) originalOnload();
};
// ==========================================
// --- PRO CONTEXT MENU ENGINE ---
// ==========================================

// 1. Force base styling directly through JS so it NEVER fails to show
if (ctxMenu) {
    ctxMenu.style.position = 'fixed';
    ctxMenu.style.zIndex = '999999';
    ctxMenu.style.background = '#1a1a1a';
    ctxMenu.style.border = '1px solid var(--accent)';
    ctxMenu.style.borderRadius = '8px';
    ctxMenu.style.padding = '8px 0';
    ctxMenu.style.boxShadow = '0 10px 30px rgba(0,0,0,0.8)';
    ctxMenu.style.display = 'none'; // Hidden by default
    ctxMenu.style.minWidth = '180px';
}

// ==========================================
// --- 5. CUSTOM RIGHT CLICK & LOCAL PLAYLIST ---
// ==========================================


// 1. Right-Click Listener
document.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.song-card');
    
    if (card && card.getAttribute('data-type') === 'song') {
        e.preventDefault();
        
        // Grab all the data needed to actually play the song
        ctxTargetSong = {
            t: card.getAttribute('data-title'), 
            a: card.getAttribute('data-artist'),
            cover: card.getAttribute('data-cover'), 
            p: card.getAttribute('data-url'),
            ytId: card.getAttribute('data-ytid'), // MUST HAVE THIS for YouTube
            isOnline: true, 
            needsAudioStream: !card.getAttribute('data-url')
        };

        // Inject the buttons so they know exactly which song to pass to the helpers!
        ctxMenu.innerHTML = `
            <div class="context-item" onclick="playNextDirect(ctxTargetSong)"><span class="material-icons-round">queue_play_next</span> Play Next</div>
            <div class="context-item" onclick="addToQueueDirect(ctxTargetSong)"><span class="material-icons-round">playlist_add</span> Add to Bottom</div>
            <div class="context-item" onclick="openPlaylistPicker(ctxTargetSong)"><span class="material-icons-round">favorite</span> Save to Local Favorites</div>
        `;

        // Position it and force it to be visible using 'block'
        ctxMenu.style.left = `${e.pageX}px`; 
        ctxMenu.style.top = `${e.pageY}px`;
        ctxMenu.style.display = 'block'; 
    }
});

// 2. Safe Click Listener (Hide Menu)
document.addEventListener('click', (e) => { 
    if (ctxMenu && !e.target.closest('#custom-context-menu')) {
        ctxMenu.style.display = 'none'; // Replaced classList.remove with display = 'none'
    }
});

// 3. Context Menu Action Helpers
function playNextDirect(song) {
    queue.splice(curIdx + 1, 0, song);
    draw(); saveState();
    showToast(`"${song.t}" will play next!`);
    ctxMenu.style.display = 'none';
}

function addToQueueDirect(song) {
    queue.push(song);
    draw(); saveState();
    showToast(`"${song.t}" added to bottom of queue`);
    ctxMenu.style.display = 'none';
}

function openPlaylistPicker(song) {
    let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
    // Check if song already exists in the playlist
    if (!localPl.some(s => s.t === song.t)) {
        localPl.push(song);
        localStorage.setItem('myLocalPlaylist', JSON.stringify(localPl));
        showToast("Added to Local Favorites! ❤️");
    } else {
        showToast("Already in favorites!");
    }
    ctxMenu.style.display = 'none';
}

function openLocalPlaylist() {
    let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
    document.body.classList.remove('player-mode'); switchView('playlist');
    document.getElementById('pl-detail-title').innerText = "Local Favorites ❤️";
    document.getElementById('pl-track-count').innerText = localPl.length;
    document.getElementById('pl-detail-img').src = localPl.length > 0 ? localPl[0].cover : 'https://via.placeholder.com/230';
    
    const tracklistEl = document.getElementById('playlist-tracklist');
    if (localPl.length === 0) {
        tracklistEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--dim);">Your favorites list is empty.<br>Right-click songs to add them!</div>`;
        return;
    }
    currentLoadedPlaylist = localPl; 
    let html = '';
    localPl.forEach((song, i) => {
        html += `<div class="track-row" onclick="playFromPlaylist(${i})">
            <div class="track-num">${i + 1}</div>
            <div style="display:flex; flex-direction:column; overflow:hidden;">
                <span style="color:white; font-weight:bold; white-space:nowrap; text-overflow:ellipsis;">${song.t}</span>
                <span style="color:var(--dim); font-size:0.85rem; white-space:nowrap; text-overflow:ellipsis;">${song.a}</span>
            </div>
            <span class="material-icons-round" style="color:#4cc2ff; font-size:18px;">favorite</span>
        </div>`;
    });
    tracklistEl.innerHTML = html;
}
//yo