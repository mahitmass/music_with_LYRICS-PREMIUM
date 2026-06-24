// ==========================================
// --- PLAYLIST.JS ---
// Handles: YouTube playlists, JioSaavn playlists, homepage carousels,
//          listening history, dual queue system, sidebar playlists,
//          local favorites, AI taste profiler
// Loaded BEFORE renderer.js in index.html
// ==========================================

// ==========================================
// --- DUAL QUEUE STATE ---
// ==========================================
// NOTE: queue, curIdx, mainQueue, mainIdx, plQueue, plIdx, activeQMode
//       are declared in renderer.js as shared globals.

let currentLoadedPlaylist = [];

// ==========================================
// --- DUAL QUEUE SWITCHER ---
// ==========================================
function switchQueueMode(mode) {
    // Always sync arrays before switching — no early return
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
// --- YOUTUBE PLAYLIST IMPORT MODAL ---
// ==========================================
window.importYTPlaylist = function () {
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
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('yt-pl-ok').click(); });
    document.getElementById('yt-pl-cancel').onclick = () => modal.remove();
    document.getElementById('yt-pl-ok').onclick = () => {
        let raw = input.value.trim();
        let name = document.getElementById('yt-pl-name').value.trim() || 'YouTube Playlist';
        modal.remove();
        if (!raw) return;
        let playlistId = raw;
        const listMatch = raw.match(/[?&]list=([A-Za-z0-9_-]+)/);
        if (listMatch) playlistId = listMatch[1];
        let saved = JSON.parse(localStorage.getItem('customYTPlaylists') || '[]');
        if (!saved.some(p => p.id === playlistId)) {
            saved.push({ id: playlistId, title: name });
            localStorage.setItem('customYTPlaylists', JSON.stringify(saved));
            renderSidebarPlaylists();
        }
        fetchYTPlaylist(playlistId, name);
    };
};

// ==========================================
// --- FETCH + OPEN YOUTUBE PLAYLIST ---
// ==========================================
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
            let resolvedName = null;
            let playlistData = null;
            
            try { playlistData = await ipcRenderer.invoke('get-yt-playlist', playlistId); } catch(e) {}
            
            if (playlistData && (playlistData.name || playlistData.title)) {
                resolvedName = playlistData.name || playlistData.title;
            } else {
                // Fallback for older Standard YouTube playlists
                try {
                    let res = await fetch(`https://pipedapi.in.projectsegfau.lt/playlists/${playlistId}`);
                    if (res.ok) {
                        let data = await res.json();
                        resolvedName = data.name;
                    }
                } catch(e) {}
            }

            if (resolvedName) {
                const label = link.querySelector('.playlist-name');
                if (label) label.innerText = resolvedName;
            }
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

    let playlistData = null;

    // ATTEMPT 1: Try Native YT Music IPC Scraper
    try {
        playlistData = await ipcRenderer.invoke('get-yt-playlist', playlistId);
    } catch (e) {
        console.warn("IPC Playlist Fetch Error, preparing fallback...");
    }

    // ATTEMPT 2: yt-dlp via IPC — replaces unreliable proxies and official API limits
    if (!playlistData || !playlistData.songs || playlistData.songs.length === 0) {
        console.log("ytmusic-api failed. Falling back to native yt-dlp...");
        tracklistEl.innerHTML = `<div style="padding:40px;text-align:center;color:var(--dim);">
            <span class="material-icons-round" style="animation:spin 1s linear infinite;">sync</span>
            Fetching via yt-dlp fallback...
        </div>`;
        
        try {
            playlistData = await ipcRenderer.invoke('get-yt-playlist-ytdlp', playlistId);
        } catch (e) {
            console.warn('yt-dlp IPC fallback failed:', e);
        }
    }

    // FINAL CHECK: Did both methods fail?
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
            ytId: song.ytId,
            isYTPlaylist: true
        };
    });

    if (currentLoadedPlaylist.length > 0 && currentLoadedPlaylist[0].cover) {
        document.getElementById('pl-detail-img').src = currentLoadedPlaylist[0].cover;
    }

    let html = '';
    currentLoadedPlaylist.forEach((song, i) => {
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

function playFromPlaylist(index) {
    if (typeof switchQueueMode === 'function') switchQueueMode('playlist');
    queue = [...currentLoadedPlaylist];
    curIdx = index;
    if (typeof plQueue !== 'undefined') plQueue = [...queue];
    if (typeof plIdx !== 'undefined') plIdx = curIdx;
    saveState();
    draw();
    if (typeof switchView === 'function') switchView('player');
    play(index);
}

function playEntirePlaylist() { if (currentLoadedPlaylist.length === 0) return; playFromPlaylist(0); }

function shuffleEntirePlaylist() {
    if (currentLoadedPlaylist.length === 0) return;
    switchQueueMode('playlist');
    queue = [...currentLoadedPlaylist];
    for (let i = queue.length - 1; i > 0; i--) {
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
// --- JIOSAAVN PLAYLIST LOADER ---
// ==========================================
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

// ==========================================
// --- SIDEBAR PLAYLIST RENDERER ---
// ==========================================
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
// --- LOCAL FAVORITES PLAYLIST ---
// ==========================================
window.openLocalPlaylist = function () {
    let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
    if (localPl.length === 0) {
        if (typeof showToast === 'function') showToast("Your Local Playlist is empty! Right-click a song to add one.");
        return;
    }
    if (activeQMode === 'main') { mainQueue = [...queue]; mainIdx = curIdx; }
    activeQMode = 'playlist';
    plQueue = [...localPl];
    plIdx = 0;
    queue = [...localPl];
    curIdx = 0;
    const btnMain = document.getElementById('btn-q-main');
    const btnPl = document.getElementById('btn-q-pl');
    if (btnMain) btnMain.classList.toggle('active', false);
    if (btnPl) btnPl.classList.toggle('active', true);
    if (typeof draw === 'function') draw();
    if (typeof saveState === 'function') saveState();
    if (typeof play === 'function') play(0);
    if (typeof showToast === 'function') showToast("Loaded Local Favorites! ❤️");
    const playerView = document.getElementById('view-player');
    if (playerView) {
        document.body.classList.add('player-mode');
        document.body.classList.remove('home-mode');
        if (typeof switchView === 'function') switchView('player');
    }
};



// ==========================================
// --- SMART YOUTUBE TITLE CLEANER ---
// ==========================================
function smartCleanTitle(rawTitle, rawArtist) {
    let title = rawTitle;
    title = title.replace(/\[.*?\]|\(.*?\)/g, ' ');
    title = title.replace(/\b(official|video|audio|lyric|lyrics|remastered|4k|hd|hq|live|cover|remix|ft|feat|featuring|prod|music)\b/ig, ' ');
    title = title.replace(/[^\w\s\u0900-\u097F]/g, ' ');
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
    return title.replace(/\s+/g, ' ').trim();
}

function getTopArtistsFromQueue() {
    if (queue.length === 0) return [];
    let counts = {};
    queue.forEach(s => {
        if (!s.a || s.a === 'Unknown') return;
        let artists = s.a.split(',').map(a => a.trim());
        artists.forEach(a => counts[a] = (counts[a] || 0) + 1);
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
}

// ==========================================
// --- PLAYLIST UI HOVER LOCK ---
// ==========================================
let playlistLockTimer;

function lockPlaylistSection() {
    const plSection = document.getElementById('my-library-section');
    if (!plSection) return;
    plSection.classList.add('locked-open');
    clearTimeout(playlistLockTimer);
    playlistLockTimer = setTimeout(() => {
        plSection.classList.remove('locked-open');
    }, 10000);
}

// ==========================================
// --- SMART LISTENING HISTORY ENGINE ---
// ==========================================
function addToHistory(song) {
    if (!song) return;
    let history = JSON.parse(localStorage.getItem('playHistory') || '[]');
    
    // 🔥 NEW: Flawless Deduplicator
    // Matches YouTube by exact ID, Saavn by Title+Artist, and Local files by path
    const getUid = (s) => (s.ytId ? s.ytId : (s.isOnline ? s.t + "::" + s.a : s.p));
    const currentUid = getUid(song);
    
    // Remove any previous entries of this exact song
    history = history.filter(s => getUid(s) !== currentUid);
    
    // Add to the top of history
    history.unshift(song);
    
    if (history.length > 150) history.pop();
    localStorage.setItem('playHistory', JSON.stringify(history));
    
    if (document.getElementById('view-history') && document.getElementById('view-history').classList.contains('active')) {
        if (typeof renderHistoryView === 'function') renderHistoryView();
    }
}

function openHistoryView() {
    const histView = document.getElementById('view-history');
    if (histView && histView.classList.contains('active')) {
        switchToHomeView();
        return;
    }
    document.body.classList.add('home-mode');
    document.body.classList.remove('player-mode', 'immersive');
    switchView('history');
    renderHistoryView();
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
        // Unique ID for each image container so we can inject the art asynchronously
        let imgId = `hist-cover-${i}`;
        
        let coverHtml = '';
        if (s.isOnline && s.cover) {
            coverHtml = `<img src="${s.cover}" style="width: 45px !important; height: 45px !important; min-width: 45px !important; border-radius: 6px; object-fit: cover; flex-shrink: 0 !important; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">`;
        } else {
            // Placeholder template container that we will swap out via jsmediatags
            coverHtml = `<div id="${imgId}" style="width: 45px !important; height: 45px !important; min-width: 45px !important; border-radius: 6px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; flex-shrink: 0 !important;"><span class="material-icons-round" style="color:var(--dim);">music_note</span></div>`;
        }

        let safeTitle = s.t ? s.t.replace(/'/g, "\\'").replace(/"/g, '&quot;') : 'Unknown';
        let safeArtist = s.a ? s.a.replace(/'/g, "\\'").replace(/"/g, '&quot;') : 'Unknown Artist';
        let encodedSong = encodeURIComponent(JSON.stringify(s));
        
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
        
        // Asynchronously fetch local art so the screen renders instantly without freezing!
        if (!s.isOnline && s.p) {
            setTimeout(() => extractHistoryLocalArt(s.p, imgId), 10);
        }
    });
    container.innerHTML = html;
}

function extractHistoryLocalArt(filePath, targetElementId) {
    const targetEl = document.getElementById(targetElementId);
    if (!targetEl) return;

    fetch(encodeURI(`file://${filePath.replace(/\\/g, '/')}`).replace(/#/g, '%23').replace(/\?/g, '%3F'))
        .then(res => res.blob())
        .then(blob => {
            window.jsmediatags.read(blob, {
                onSuccess: function (tag) {
                    const picture = tag.tags.picture;
                    if (picture) {
                        let b64 = "";
                        const bytes = new Uint8Array(picture.data);
                        for (let i = 0; i < bytes.byteLength; i++) {
                            b64 += String.fromCharCode(bytes[i]);
                        }
                        const base64Url = "data:" + picture.format + ";base64," + window.btoa(b64);
                        
                        // Replace the folder placeholder with a beautiful image tag live!
                        if (targetEl) {
                            targetEl.outerHTML = `<img src="${base64Url}" style="width: 45px !important; height: 45px !important; min-width: 45px !important; border-radius: 6px; object-fit: cover; flex-shrink: 0 !important; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">`;
                        }
                    }
                },
                onError: function() { console.log("No embedded metadata art found for: " + filePath); }
            });
        }).catch(() => {});
}

function clearHistory() {
    if (confirm("Are you sure you want to delete your entire listening history?")) {
        localStorage.removeItem('playHistory');
        renderHistoryView();
        if (typeof showToast === 'function') showToast("History cleared! 🧹");
    }
}

function playFromHistory(index) {
    const history = JSON.parse(localStorage.getItem('playHistory') || '[]');
    const song = history[index];
    if (!song) return;
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, song);
    draw(); saveState(); switchToPlayerView(); play(insertPos);
}

function playFromHistorySearch(encodedSong, targetId) {
    const song = JSON.parse(decodeURIComponent(encodedSong));
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, song);
    const searchInputs = ['sidebar-search', 'imm-search'];
    searchInputs.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const resultsDivs = ['sidebar-search-results', 'imm-search-results'];
    resultsDivs.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    draw(); saveState(); switchToPlayerView(); play(insertPos);
}

// ==========================================
// --- AI USER MODEL (TASTE PROFILER) ---
// ==========================================
const INVALID_ARTISTS_PL = new Set(['', 'unknown', 'unknown artist']);

function buildTimeBucketMap() {
    return { Morning: 0, Afternoon: 0, Evening: 0, 'Late Night': 0 };
}

function getDefaultAiModel() {
    return { songs: {}, artists: {} };
}

function loadAiUserModel() {
    try {
        const parsed = JSON.parse(localStorage.getItem('ai_user_model') || '{}');
        return { songs: parsed.songs || {}, artists: parsed.artists || {} };
    } catch (e) { return getDefaultAiModel(); }
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

// ==========================================
// --- BACKGROUND PLAYLIST QUEUE INJECTOR ---
// ==========================================
window.addYTPlaylistToQueue = async function(playlistId, position) {
    // Hide the right-click menu instantly
    const menu = document.getElementById('custom-context-menu');
    if (menu) menu.style.display = 'none';
    
    if (typeof showToast === 'function') showToast("Scraping playlist tracks in background...");
    console.log(`[BG Scraper] Starting extraction for Playlist ID: ${playlistId}`);

    let playlistData = null;
    
    // ATTEMPT 1: Native YT Music IPC
    try { 
        playlistData = await ipcRenderer.invoke('get-yt-playlist', playlistId); 
        if (playlistData && playlistData.songs && playlistData.songs.length > 0) {
            console.log(`[BG Scraper] Success with ytmusic-api! Found ${playlistData.songs.length} songs.`);
        }
    } catch(e) {
        console.warn("[BG Scraper] ytmusic-api threw an error. Moving to fallback.");
    }

    // ATTEMPT 2: yt-dlp IPC Fallback
    if (!playlistData || !playlistData.songs || playlistData.songs.length === 0) {
        console.log("[BG Scraper] Playlist is standard/old format. Engaging yt-dlp fallback...");
        try { 
            playlistData = await ipcRenderer.invoke('get-yt-playlist-ytdlp', playlistId); 
            if (playlistData && playlistData.songs && playlistData.songs.length > 0) {
                console.log(`[BG Scraper] Success with yt-dlp fallback! Found ${playlistData.songs.length} songs.`);
            }
        } catch(e) {
            console.error("[BG Scraper] yt-dlp fallback also failed:", e);
        }
    }

    if (!playlistData || !playlistData.songs || playlistData.songs.length === 0) {
        console.error("[BG Scraper] ALL ATTEMPTS FAILED.");
        if (typeof showToast === 'function') showToast("❌ Failed to scrape playlist.");
        return;
    }

    // Format all scraped songs so the player understands them
    let formattedSongs = playlistData.songs.map(song => {
        let rawCover = song.thumbnails && song.thumbnails.length > 0 ? song.thumbnails[song.thumbnails.length - 1].url : '';
        let safeCover = rawCover.startsWith('http') ? rawCover : 'https://via.placeholder.com/230';
        let safeArtist = song.artists && song.artists.length > 0 ? song.artists.map(a => a.name).join(', ') : 'Unknown';
        return {
            t: song.name,
            rawTitle: song.name,
            a: safeArtist,
            p: '',
            cover: safeCover,
            isOnline: true,
            needsAudioStream: true,
            ytId: song.ytId,
            isYTPlaylist: true
        };
    });

    // Safely inject into the queue
    if (position === 'next') {
        queue.splice(curIdx + 1, 0, ...formattedSongs);
        if (typeof showToast === 'function') showToast(`✅ Added ${formattedSongs.length} tracks to play next!`);
    } else {
        queue.push(...formattedSongs);
        if (typeof showToast === 'function') showToast(`✅ Added ${formattedSongs.length} tracks to bottom of queue!`);
    }

    if (typeof draw === 'function') draw();
    if (typeof saveState === 'function') saveState();
};
//yo