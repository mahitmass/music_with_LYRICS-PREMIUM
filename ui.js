// ==========================================
// --- UI.JS ---
// Handles: Queue drawing, marquee, context menu, visualizer,
//          immersive layout, kinetic animations, drag/drop visuals,
//          inactivity timer, view switching, track options
// Loaded BEFORE renderer.js in index.html
// ==========================================

// ==========================================
// --- TOAST NOTIFICATION ---
// ==========================================
let toastTimeout;
function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerText = msg;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 4000);
}

// ==========================================
// --- MARQUEE OBSERVER (EFFICIENT SCROLL TEXT) ---
// ==========================================
const marqueeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        const el = entry.target;
        if (entry.isIntersecting) {
            if (el.scrollWidth > el.clientWidth + 4) el.classList.add('marquee-active');
            else el.classList.remove('marquee-active');
        } else {
            el.classList.remove('marquee-active');
        }
    });
}, { root: null, rootMargin: '50px' });

function syncMarqueeState(el) {
    if (!el) return;
    marqueeObserver.observe(el);
}

document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.q-title, .q-artist, .display-title, .display-artist');
    if (!target) return;
    if (target.scrollWidth > target.clientWidth + 2) target.classList.add('marquee-active');
});

document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('.q-title, .q-artist, .display-title, .display-artist');
    if (target) target.classList.remove('marquee-active');
});

// ==========================================
// --- DRAW QUEUE ---
// ==========================================
function draw() {
    const sideSearch = document.getElementById('sidebar-search');
    const searchTerm = sideSearch ? sideSearch.value : '';
    if (searchTerm) return;

    const qList = document.getElementById('queue-list');
    const hList = document.getElementById('hover-queue-list');
    const qScroll = qList ? qList.scrollTop : 0;
    const hScroll = hList ? hList.scrollTop : 0;

    marqueeObserver.disconnect();

    const html = queue.map((s, i) => {
        let icon = s.isOnline ? "cloud" : "drag_indicator";
        return `
        <div class="item ${i === curIdx ? 'active' : ''}" data-type="queue-item" data-index="${i}" draggable="true"
             ondragstart="dragStart(event, ${i})" ondragend="dragEnd(event)"
             ondragover="dragOver(event)" ondragleave="dragLeave(event)"
             ondrop="drop(event, ${i})" onclick="play(${i})">
            <div class="item-left">
                <span class="material-icons-round drag-handle">${icon}</span>
                <div class="queue-text-wrap">
                    <div class="q-title">${i + 1}. ${s.t}</div>
                    <div class="q-artist">${s.a || 'Unknown Artist'}</div>
                </div>
            </div>
            <div class="del-btn" onclick="event.stopPropagation(); queue.splice(${i}, 1); if(${i} < curIdx) curIdx--; else if(${i} === curIdx && queue.length > 0) play(curIdx >= queue.length ? 0 : curIdx); draw(); saveState();">✕</div>
        </div>`;
    }).join('');

    if (qList) qList.innerHTML = html;
    if (hList) hList.innerHTML = html;
    if (qList) qList.scrollTop = qScroll;
    if (hList) hList.scrollTop = hScroll;

    document.querySelectorAll('.q-title, .q-artist').forEach(syncMarqueeState);
}

// ==========================================
// --- SCROLL TO CURRENT SONG ---
// ==========================================
function scrollToCurrentSong() {
    if (queue.length === 0) return;
    setTimeout(() => {
        const qList = document.getElementById('queue-list');
        const hList = document.getElementById('hover-queue-list');
        if (qList && qList.children[curIdx]) {
            qList.children[curIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
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
// --- VIEW SWITCHING ---
// ==========================================
function switchView(viewName) {
    const ctxMenu = document.getElementById('custom-context-menu');
    if (ctxMenu) ctxMenu.style.display = 'none';
    const panels = ['home', 'playlist', 'player', 'history'];
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

function switchToPlayerView() {
    document.body.classList.remove('home-mode');
    document.body.classList.add('immersive');
    document.body.classList.add('player-mode');
    switchView('player');
    const cover = document.getElementById('album-cover');
    if (cover && cover.src) cover.style.display = 'block';
    setTimeout(() => { if (typeof scrollToCurrentSong === 'function') scrollToCurrentSong(); }, 150);
}

function switchToHomeView() {
    document.body.classList.add('home-mode');
    switchView('home');
    document.body.classList.remove('player-mode');
    document.body.classList.remove('immersive');
}

function toggleImmersive() { document.body.classList.toggle('immersive'); scrollToCurrentSong(); }

// ==========================================
// --- TRACK OPTIONS DROPDOWN ---
// ==========================================
function toggleMenu() {
    const menu = document.getElementById('track-options-dropdown');
    menu.style.display = (menu.style.display === 'block') ? 'none' : 'block';
}

function toggleClearMenu() {
    const menu = document.getElementById('clear-menu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}

function shareTrack() {
    const song = queue[curIdx];
    if (!song) return;
    navigator.clipboard.writeText(`Listening to ${song.t} by ${song.a} on Pro Media Player!`);
    showToast("Share text copied to clipboard!");
    toggleMenu();
}

function downloadTrack() {
    const s = queue[curIdx];
    if (!s) return;
    showToast(`Preparing download for: ${s.t}...`);
    require('electron').shell.openExternal(s.p);
    toggleMenu();
}

function saveToPlaylist() {
    const song = queue[curIdx];
    if (!song) return;
    let localPl = JSON.parse(localStorage.getItem('myLocalPlaylist') || '[]');
    const existingIdx = localPl.findIndex(s => s.t === song.t && s.a === song.a);
    if (existingIdx !== -1) {
        localPl.splice(existingIdx, 1);
        if (typeof showToast === 'function') showToast("🗑️ Removed from Local Playlist!");
    } else {
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
// --- ALBUM ART ---
// ==========================================
function fallbackArt(title) {
    let hash = 0;
    for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
    const c1 = `hsl(${hash % 360}, 70%, 50%)`, c2 = `hsl(${(hash + 40) % 360}, 80%, 30%)`;
    const cover = document.getElementById('album-cover');
    cover.style.display = "none";
    cover.removeAttribute('src');
    document.getElementById('bg-blur').style.backgroundImage = `linear-gradient(45deg, ${c1}, ${c2})`;
}

function extractAlbumArt(song) {
    const coverImg = document.getElementById('album-cover');
    const bgBlur = document.getElementById('bg-blur');
    fetch(encodeURI(`file://${song.p.replace(/\\/g, '/')}`).replace(/#/g, '%23').replace(/\?/g, '%3F'))
        .then(res => res.blob()).then(blob => {
            window.jsmediatags.read(blob, {
                onSuccess: function (tag) {
                    const picture = tag.tags.picture;
                    if (picture) {
                        let b64 = "";
                        const bytes = new Uint8Array(picture.data);
                        for (let i = 0; i < bytes.byteLength; i++) b64 += String.fromCharCode(bytes[i]);
                        const b = "data:" + picture.format + ";base64," + window.btoa(b64);
                        coverImg.src = b; coverImg.style.display = "block";
                        bgBlur.style.backgroundImage = `url(${b})`;
                    } else fallbackArt(song.t);
                },
                onError: () => fallbackArt(song.t)
            });
        }).catch(() => fallbackArt(song.t));
}

// ==========================================
// --- INACTIVITY TIMER ---
// ==========================================
let inactivityTimer;

function resetInactivityTimer() {
    const pBar = document.querySelector('.player-bar');
    if (!pBar) return;
    if (pBar.classList.contains('idle')) pBar.classList.remove('idle');
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => { pBar.classList.add('idle'); }, 300000);
}

window.addEventListener('mousemove', resetInactivityTimer);
window.addEventListener('mousedown', resetInactivityTimer);
window.addEventListener('keydown', resetInactivityTimer);
window.addEventListener('focus', resetInactivityTimer);

// ==========================================
// --- UNIFIED RIGHT-CLICK CONTEXT MENU ---
// ==========================================
window.ctxTargetSong = null;

document.addEventListener('contextmenu', (e) => {
    window.ctxMouseX = e.clientX;
    window.ctxMouseY = e.clientY;

    const card = e.target.closest('.song-card[data-type="song"]');
    const searchItem = e.target.closest('.item[data-type="search-result"]');
    const playlistCard = e.target.closest('.song-card[data-type="playlist"]');
    const queueItem = e.target.closest('.item[data-type="queue-item"]');
    const globalHistoryItem = e.target.closest('[data-type="history-item"], [data-type="history-search-result"], [data-type="local-search-result"]');

    const menu = document.getElementById('custom-context-menu');
    if (!menu) return;

    let menuHtml = '';

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
    } else if (playlistCard) {
        e.preventDefault();
        const plId = playlistCard.getAttribute('data-id');
        const plTitle = playlistCard.getAttribute('data-title');
        menuHtml = `
            <div class="context-item" onclick="loadSaavnPlaylist('${plId}', '${plTitle}')"><span class="material-icons-round">play_circle</span> Load Entire Playlist</div>
        `;
    } else if (queueItem) {
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
    } else if (globalHistoryItem) {
        e.preventDefault();
        const songData = globalHistoryItem.getAttribute('data-song');
        if (!songData) return;
        window.ctxTargetSong = JSON.parse(decodeURIComponent(songData));
        menuHtml = `
            <div class="context-item" onclick="playNextDirect(window.ctxTargetSong)"><span class="material-icons-round">queue_play_next</span> Play Next</div>
            <div class="context-item" onclick="addToQueueDirect(window.ctxTargetSong)"><span class="material-icons-round">playlist_add</span> Add to Bottom</div>
            <div class="context-item" onclick="openPlaylistPicker(window.ctxTargetSong)"><span class="material-icons-round">favorite</span> Save to Local Favorites</div>
            <div class="context-item" onclick="shareTrackDirect(window.ctxTargetSong)"><span class="material-icons-round">share</span> Share Link</div>
        `;
    } else {
        return;
    }

    menu.innerHTML = menuHtml;
    const menuHeight = 180;
    let yPos = e.pageY;
    if (yPos + menuHeight > window.innerHeight) yPos = window.innerHeight - menuHeight;
    menu.style.left = `${e.pageX}px`;
    menu.style.top = `${yPos}px`;
    menu.style.display = 'block';
});

document.addEventListener('click', (e) => {
    const menu = document.getElementById('custom-context-menu');
    if (menu && !e.target.closest('#custom-context-menu')) menu.style.display = 'none';
});

document.addEventListener('click', (e) => {
    const clearMenu = document.getElementById('clear-menu');
    if (clearMenu && !e.target.closest('.clear-dropdown-wrap')) clearMenu.style.display = 'none';
    const dots = document.getElementById('options-trigger');
    const menu = document.getElementById('track-options-dropdown');
    if (menu && e.target !== dots && !menu.contains(e.target)) menu.style.display = 'none';
});

// ==========================================
// --- KINETIC ANIMATION (WHOOSH) ---
// ==========================================
function animateWhoosh(song, startX, startY, type) {
    const ghost = document.createElement('div');
    ghost.className = 'flying-card';
    const safeT = song.t.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const coverHtml = song.cover
        ? `<img src="${song.cover}" style="width:36px; height:36px; border-radius:4px; object-fit:cover;">`
        : `<div style="width:36px; height:36px; background:#333; border-radius:4px; display:flex; align-items:center; justify-content:center;"><span class="material-icons-round" style="font-size:20px;">music_note</span></div>`;
    ghost.innerHTML = `${coverHtml}<div style="font-size:0.9rem; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;">${safeT}</div>`;
    document.body.appendChild(ghost);
    ghost.style.left = startX + 'px';
    ghost.style.top = startY + 'px';
    ghost.style.transform = 'scale(1)';
    void ghost.offsetWidth;
    const sidebar = document.querySelector('.yt-sidebar');
    let targetX = 130, targetY = window.innerHeight / 2;
    if (sidebar) {
        const rect = sidebar.getBoundingClientRect();
        targetX = rect.left + (rect.width / 2) - 50;
        targetY = type === 'next' ? rect.top + 150 : rect.bottom - 100;
    }
    ghost.style.transform = `translate(${targetX - startX}px, ${targetY - startY}px) scale(0.15) rotate(-15deg)`;
    ghost.style.opacity = '0';
    setTimeout(() => ghost.remove(), 600);
}

// ==========================================
// --- CONTEXT MENU ACTION HELPERS ---
// ==========================================
function playNextDirect(song) {
    animateWhoosh(song, window.ctxMouseX, window.ctxMouseY, 'next');
    queue.splice(curIdx + 1, 0, song);
    if (typeof draw === 'function') draw();
    if (typeof saveState === 'function') saveState();
    if (typeof showToast === 'function') showToast(`"${song.t}" will play next!`);
    document.getElementById('custom-context-menu').style.display = 'none';
}

function addToQueueDirect(song) {
    animateWhoosh(song, window.ctxMouseX, window.ctxMouseY, 'bottom');
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

// ==========================================
// --- IMMERSIVE LAYOUT ENGINE ---
// ==========================================
let currentImmMode = 0;

window.addEventListener('load', () => {
    const albumCoverEl = document.getElementById('album-cover');
    if (albumCoverEl) {
        albumCoverEl.style.cursor = 'pointer';
        albumCoverEl.title = 'Click to change layout mode';
        albumCoverEl.addEventListener('click', (e) => {
            if (!document.body.classList.contains('immersive')) return;
            e.stopPropagation();
            currentImmMode = (currentImmMode + 1) % 3;
            document.body.classList.remove('imm-layout-1', 'imm-layout-2');
            if (currentImmMode === 1) {
                document.body.classList.add('imm-layout-1');
                showToast("🟢 Mode: Cyberpunk Studio");
                isDrawingWaveform = false;
                initRealVisualizer();
            } else if (currentImmMode === 2) {
                document.body.classList.add('imm-layout-2');
                showToast("🎨 Mode: Zen Artistic Canvas");
            } else {
                showToast("📺 Mode: Classic UI");
            }
            setTimeout(() => { if (typeof scrollToCurrentSong === 'function') scrollToCurrentSong(); }, 500);
        });
    }

    // Double-click to cycle modes
    const playerView = document.getElementById('view-player');
    if (playerView) {
        playerView.removeAttribute('title');
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
                initRealVisualizer();
            } else if (currentImmMode === 2) {
                document.body.classList.add('imm-layout-2');
                if (typeof showToast === 'function') showToast("🎨 Mode: Zen Artistic Canvas");
            } else {
                if (typeof showToast === 'function') showToast("📺 Mode: Classic UI");
                if (typeof resetInactivityTimer === 'function') resetInactivityTimer();
            }
            setTimeout(() => { if (typeof scrollToCurrentSong === 'function') scrollToCurrentSong(); }, 500);
        });
    }

    // Click-and-hold to toggle immersive
    const lViewEl = document.getElementById('l-view');
    if (lViewEl) {
        let grabTimer;
        window.isGrabbing = false;
        lViewEl.addEventListener('mousedown', (e) => {
            if (isEditing) return;
            if (e.offsetX >= lViewEl.clientWidth - 15) return;
            window.isGrabbing = false;
            grabTimer = setTimeout(() => {
                window.isGrabbing = true;
                toggleImmersive();
            }, 400);
        });
        lViewEl.addEventListener('mouseup', () => clearTimeout(grabTimer));
        lViewEl.addEventListener('mouseleave', () => clearTimeout(grabTimer));
    }

    // Pause/play body class for visualizer
    const globalAudioEl = document.querySelector('audio') || window.audio;
    if (globalAudioEl) {
        globalAudioEl.addEventListener('pause', () => document.body.classList.add('is-paused'));
        globalAudioEl.addEventListener('play', () => document.body.classList.remove('is-paused'));
    }

    // Start inactivity timer
    resetInactivityTimer();
});

// ==========================================
// --- REAL-TIME CANVAS VISUALIZER ---
// ==========================================
let audioCtx, analyser, mediaSource;
let visDataArray;
let canvasLeft, ctxLeft, canvasRight, ctxRight;
let isDrawingWaveform = false;
let activeVisColor = 'rgba(255, 255, 255,';

// Extract dominant color from album art
window.addEventListener('load', () => {
    const albumImgEl = document.getElementById('album-cover');
    if (albumImgEl) {
        albumImgEl.addEventListener('load', function () {
            try {
                let c = document.createElement('canvas');
                c.width = 1; c.height = 1;
                let ctx = c.getContext('2d');
                ctx.drawImage(this, 0, 0, 1, 1);
                let [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
                r = Math.min(255, r + 50); g = Math.min(255, g + 50); b = Math.min(255, b + 50);
                activeVisColor = `rgba(${r}, ${g}, ${b},`;
            } catch (e) { activeVisColor = 'rgba(255, 255, 255,'; }
        });
    }
});

function initRealVisualizer() {
    const audioEl = document.querySelector('audio') || window.audio;
    if (!audioEl) return;

    if (!audioEl.visConnected) {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 128;
            analyser.smoothingTimeConstant = 0.7;
            mediaSource = audioCtx.createMediaElementSource(audioEl);
            mediaSource.connect(analyser);
            analyser.connect(audioCtx.destination);
            audioEl.visConnected = true;
            visDataArray = new Uint8Array(analyser.frequencyBinCount);
            canvasLeft = document.getElementById('vis-canvas-left');
            canvasRight = document.getElementById('vis-canvas-right');
            if (canvasLeft && canvasRight) {
                ctxLeft = canvasLeft.getContext('2d');
                ctxRight = canvasRight.getContext('2d');
            }
        } catch (e) { console.error("Audio Context Error:", e); }
    }

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
    let pointsLeft = [], pointsRight = [];

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
            let p0 = points[i], p1 = points[i + 1];
            let midX = (p0.x + p1.x) / 2, midY = (p0.y + p1.y) / 2;
            ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
        }
        let lastP = points[points.length - 1]; ctx.lineTo(lastP.x, lastP.y);
        if (isLeft) { ctx.lineTo(canvasLeft.width, lastP.y); ctx.lineTo(canvasLeft.width, points[0].y); }
        else { ctx.lineTo(0, lastP.y); ctx.lineTo(0, points[0].y); }
        ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
        for (let i = 0; i < points.length - 1; i++) {
            let p0 = points[i], p1 = points[i + 1];
            let midX = (p0.x + p1.x) / 2, midY = (p0.y + p1.y) / 2;
            ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
        }
        ctx.lineTo(lastP.x, lastP.y); ctx.stroke();
    }

    drawSmoothCurve(ctxLeft, pointsLeft, true);
    drawSmoothCurve(ctxRight, pointsRight, false);
}

// Auto-restart visualizer when audio plays if in cyberpunk mode
document.addEventListener('DOMContentLoaded', () => {
    const playerEl = document.getElementById('player');
    if (playerEl) {
        playerEl.addEventListener('playing', () => {
            if (document.body.classList.contains('imm-layout-1')) {
                isDrawingWaveform = false;
                initRealVisualizer();
            }
        });
    }
});

//yo