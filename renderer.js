// ==========================================
// --- RENDERER.JS ---
// Core: Globals, playback engine, search, drag/drop,
//       file handling, keyboard shortcuts, state save/restore
//
// LOAD ORDER in index.html (before this file):
//   <script src="lyrics.js"></script>
//   <script src="playlist.js"></script>
//   <script src="ui.js"></script>
//   <script src="renderer.js"></script>
// ==========================================

// ==========================================
// --- BRIDGE FIX ---
// ==========================================
window.openSearchMenu = function (e) { e.preventDefault(); };

// ==========================================
// --- GLOBAL STATE ---
// ==========================================
let lyricsEnabled = localStorage.getItem('lyricsEnabled') !== 'false';
const { webUtils, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let queue = [], curIdx = 0, lyrics = [], lyrIdx = -1;
let mainQueue = [], mainIdx = 0;
let plQueue = [], plIdx = 0;
let activeQMode = 'main';
let draggedIdx = null;
let currentListenSession = null;
let currentSongId = "";
let songSyncOffset = 0;
let isEditing = false;
let isUserScrolling = false;
let lyricScrollTimeout;
let hasAutoSwitchedToImmersive = false;
let isCircuitBreakerActive = false;
let lastPreloadedIdx = -1;
let swipeCooldown = false;

// ==========================================
// --- API CONFIG ---
// ==========================================
const PRIMARY_API = 'https://saavn.sumit.co/api';
const FALLBACK_API = 'https://jiosaavn-api-v3.vercel.app/api';
const INVALID_ARTISTS = new Set(['', 'unknown', 'unknown artist']);
const VARIANT_TERMS = ['sped up', 'spedup', 'slowed', 'reverb', 'remix', 'lofi', 'lo-fi', 'nightcore'];
const TIME_BUCKETS = ['Morning', 'Afternoon', 'Evening', 'Late Night'];

// ==========================================
// --- AI USER MODEL (shared with playlist.js) ---
// ==========================================
let aiUserModel = loadAiUserModel();

// ==========================================
// --- DOM REFS ---
// ==========================================
const audio = document.getElementById('player');
const lContent = document.getElementById('l-content');
const lView = document.getElementById('l-view');
const volSlider = document.getElementById('vol');

// ==========================================
// --- UTILITY FUNCTIONS ---
// ==========================================
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

function isKnownArtist(artist) { return !!sanitizeArtistName(artist); }

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
    aTokens.forEach(token => { if (bTokens.has(token)) overlap++; });
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

function getWorkingUrl(downloadUrlArr) {
    if (!downloadUrlArr || !Array.isArray(downloadUrlArr)) return "";
    const order = ['320kbps', '160kbps', '96kbps', '48kbps'];
    for (let q of order) {
        const found = downloadUrlArr.find(x => x.quality === q);
        if (found && found.url) return found.url;
    }
    return downloadUrlArr[0]?.url || "";
}

// ==========================================
// --- SAVE / RESTORE STATE ---
// ==========================================
function saveState() {
    localStorage.setItem('playerQueue', JSON.stringify(queue));
    localStorage.setItem('playerIdx', curIdx);
    if (typeof activeQMode !== 'undefined') {
        localStorage.setItem('activeQMode', activeQMode);
        localStorage.setItem('mainQueue', JSON.stringify(mainQueue));
        localStorage.setItem('mainIdx', mainIdx);
        localStorage.setItem('plQueue', JSON.stringify(plQueue));
        localStorage.setItem('plIdx', plIdx);
    }
}

function updateToolIcons() {
    const isBlocked = localStorage.getItem('noLyr_' + currentSongId);
    document.getElementById('btn-nolyrics').classList.toggle('active', !!isBlocked);
    document.getElementById('btn-nolyrics').style.color = isBlocked ? '#ff4c4c' : '';
    songSyncOffset = parseFloat(localStorage.getItem('sync_' + currentSongId)) || 0;
    document.getElementById('sync-val').value = (songSyncOffset > 0 ? '+' : '') + songSyncOffset.toFixed(1) + 's';
}

// ==========================================
// --- APP STARTUP ---
// ==========================================
window.addEventListener('load', () => {
    const btn = document.getElementById('btn-toggle-lyrics');
    document.body.classList.add('home-mode');

    if (btn) {
        btn.style.color = lyricsEnabled ? 'var(--accent)' : 'var(--dim)';
        btn.innerText = lyricsEnabled ? 'subtitles' : 'subtitles_off';
    }

    volSlider.value = localStorage.getItem('playerVol') || 1;
    audio.volume = volSlider.value;

    // Restore dual queue
    const savedMode = localStorage.getItem('activeQMode');
    if (savedMode) {
        activeQMode = savedMode;
        mainQueue = JSON.parse(localStorage.getItem('mainQueue') || '[]');
        mainIdx = parseInt(localStorage.getItem('mainIdx')) || 0;
        plQueue = JSON.parse(localStorage.getItem('plQueue') || '[]');
        plIdx = parseInt(localStorage.getItem('plIdx')) || 0;
        const btnMain = document.getElementById('btn-q-main');
        const btnPl = document.getElementById('btn-q-pl');
        if (btnMain) btnMain.classList.toggle('active', activeQMode === 'main');
        if (btnPl) btnPl.classList.toggle('active', activeQMode === 'playlist');
    }

    // Restore queue
    const savedQueue = localStorage.getItem('playerQueue');
    if (savedQueue) {
        queue = JSON.parse(savedQueue);
        curIdx = parseInt(localStorage.getItem('playerIdx')) || 0;
        draw();
        if (queue.length > 0) {
            const s = queue[curIdx];
            document.getElementById('cur-t').innerText = s.t;
            document.getElementById('cur-a').innerText = s.a;
            currentSongId = s.ytId || (s.a + " - " + s.t);
            updateToolIcons();
            if (s.isOnline) {
                audio.src = s.p;
                if (s.cover) {
                    document.getElementById('album-cover').src = s.cover;
                    document.getElementById('album-cover').style.display = "block";
                    document.getElementById('bg-blur').style.backgroundImage = `url(${s.cover})`;
                } else { fallbackArt(s.t || 'Unknown'); }
            } else {
                audio.src = encodeURI(`file://${s.p.replace(/\\/g, '/')}`);
                extractAlbumArt(s);
            }
            getLyrics(s);
            scrollToCurrentSong();
        }
    }

    if (typeof preloadSidebarPlaylistNames === 'function') preloadSidebarPlaylistNames();
    if (typeof loadHomepage === 'function') loadHomepage();
});

// ==========================================
// --- DELAYED STARTUP (500ms) ---
// ==========================================
setTimeout(() => {
    try {
        if (queue.length === 0) {
            const savedQ = localStorage.getItem('queue') || localStorage.getItem('savedQueue');
            if (savedQ) {
                queue = JSON.parse(savedQ);
                if (typeof mainQueue !== 'undefined') mainQueue = [...queue];
                if (typeof draw === 'function') draw();
            }
        }
    } catch (e) { console.error("Queue recovery failed"); }
    if (typeof loadHomepage === 'function') loadHomepage();
    if (typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists();
}, 500);

// ==========================================
// --- EXTERNAL FILE HANDLER ---
// ==========================================
ipcRenderer.on('open-external-file', (event, filePath) => {
    const baseName = path.basename(filePath, '.mp3');
    let artist = "Unknown Artist", title = baseName;
    const dashIndex = baseName.indexOf('-');
    if (dashIndex !== -1) { artist = baseName.substring(0, dashIndex).trim(); title = baseName.substring(dashIndex + 1).trim(); }
    queue.push({ t: title, a: artist, p: filePath });
    draw(); saveState(); play(queue.length - 1);
});

// ==========================================
// --- VOLUME CONTROL ---
// ==========================================
volSlider.oninput = () => { audio.volume = volSlider.value; localStorage.setItem('playerVol', volSlider.value); };

// ==========================================
// --- QUEUE MANAGEMENT ---
// ==========================================
function clearQueue(type) {
    if (queue.length === 0) return;
    if (type === 'all') { const curr = queue[curIdx]; queue = [curr]; curIdx = 0; }
    else if (type === 'recents') { queue.splice(0, curIdx); curIdx = 0; }
    draw(); saveState();
}

function shuffleRemaining() {
    if (queue.length <= curIdx + 1) return;
    const remaining = queue.slice(curIdx + 1);
    for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    queue = [...queue.slice(0, curIdx + 1), ...remaining];
    draw(); saveState();
    showToast("Queue shuffled");
}

// ==========================================
// --- CORE PLAYBACK ENGINE ---
// ==========================================
function safePlay(url) {
    const audio = document.getElementById('player');
    audio.pause();
    audio.removeAttribute('src');
    if (!url || url.trim() === '') return false;
    audio.src = url;
    audio.load();
    let playPromise = audio.play();
    if (playPromise !== undefined) {
        playPromise.catch(e => { console.warn("Playback interrupted (safe to ignore if rapidly skipping)"); });
    }
    return true;
}

function tryPlayWithRetry(song, attempt) {
    if (isCircuitBreakerActive) return;
    const audio = document.getElementById('player');
    if (attempt > 1) {
        console.error("All retries failed");
        showToast("❌ Network Error. Pausing playback to prevent spam.");
        isCircuitBreakerActive = true;
        setTimeout(() => { isCircuitBreakerActive = false; }, 5000);
        return;
    }
    const playAttempt = safePlay(song.p);
    if (!playAttempt) { audio.dispatchEvent(new Event('error')); return; }
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
                song.p = newUrl; saveState();
                tryPlayWithRetry(song, attempt + 1);
            } else { throw new Error("No URL found in fallback"); }
        } catch (e) {
            console.error("Retry completely failed:", e);
            showToast("❌ Track unavailable right now.");
            isCircuitBreakerActive = true;
            setTimeout(() => {
                isCircuitBreakerActive = false;
                if (typeof playNext === 'function') playNext();
            }, 3000);
        }
    };
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

    // Wake visualizer on every new song
    isDrawingWaveform = false;
    if (typeof initRealVisualizer === 'function') initRealVisualizer();

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

        // YT song with no audio URL — search JioSaavn directly
        if (s.needsAudioStream && !s.p) {
            showToast(`Finding stream for: ${s.t}...`);
            (async () => {
                try {
                    const cleanArtist = (s.a || '').split(',')[0].trim();
                    const cleanTitle = (s.t || '')
                        .replace(/\(.*?\)|\[.*?\]/g, '')
                        .replace(/\b(official|video|audio|lyric|lyrics|hd|hq|4k)\b/gi, '')
                        .replace(/\s+/g, ' ').trim();

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

                            const titleHasVariant = containsVariantTerm(s.t);
                            if (!titleHasVariant) {
                                results = results.filter(r => {
                                    const rTitle = decodeHtmlText(r?.name || '');
                                    return !containsVariantTerm(rTitle);
                                });
                            }

                            const scored = results
                                .filter(r => Array.isArray(r?.downloadUrl) && r.downloadUrl.length > 0)
                                .map(r => {
                                    const rTitle = decodeHtmlText(r?.name || '');
                                    const rArtist = getSongArtist(r);
                                    const titleScore = tokenSimilarity(cleanTitle, rTitle) * 100;
                                    const artistScore = cleanArtist ? tokenSimilarity(cleanArtist, rArtist) * 60 : 0;
                                    const artistBonus = cleanArtist && rArtist.toLowerCase().includes(cleanArtist.toLowerCase()) ? 20 : 0;
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

                            if (scored.length > 0 && scored[0].score > 45) {
                                best = scored[0].r;
                            }
                        } catch (e) { /* try next query */ }
                    }

                    const url = getWorkingUrl(best?.downloadUrl);
                    if (url) {
                        s.p = url;
                        s.needsAudioStream = false;
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
                } catch (e) {
                    showToast(`❌ Stream error: ${s.t}`);
                    setTimeout(() => { if (typeof playNext === 'function') playNext(); }, 2000);
                }
            })();
            return;
        } else {
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

function togglePlay() {
    if (!audio.src) return;
    if (audio.paused) {
        audio.play();
        if (!hasAutoSwitchedToImmersive) {
            hasAutoSwitchedToImmersive = true;
            switchToPlayerView();
        }
    } else { audio.pause(); }
}

function advanceQueueToNext() {
    if (curIdx + 1 < queue.length) { play(curIdx + 1); }
    else {
        audio.pause(); audio.currentTime = 0;
        document.getElementById('p-icon').innerText = 'play_arrow';
    }
}

function playNext() {
    finalizeListeningSession(audio.currentTime > 0 && audio.currentTime < 30 ? 'skipped' : 'switch');
    advanceQueueToNext();
}

function playPrev() {
    finalizeListeningSession('switch');
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (curIdx > 0) play(curIdx - 1);
    else audio.currentTime = 0;
}

// ==========================================
// --- AUDIO EVENT LISTENERS ---
// ==========================================
audio.addEventListener('play', () => document.getElementById('p-icon').innerText = 'pause');
audio.addEventListener('pause', () => document.getElementById('p-icon').innerText = 'play_arrow');
audio.onended = () => { finalizeListeningSession('completed'); advanceQueueToNext(); };

audio.ontimeupdate = () => {
    if (!audio.duration) return;
    document.getElementById('fill').style.width = (audio.currentTime / audio.duration) * 100 + '%';
    const fmt = s => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
    document.getElementById('c-time').innerText = fmt(audio.currentTime);
    document.getElementById('t-time').innerText = fmt(audio.duration);
    if (audio.duration - audio.currentTime <= 15) preloadNextSong();
    if (lyricsEnabled && lyrics.length > 0) {
        let act = -1;
        const adjustedTime = audio.currentTime + songSyncOffset;
        for (let i = 0; i < lyrics.length; i++) { if (adjustedTime >= lyrics[i].time) act = i; else break; }
        if (act !== -1 && act !== lyrIdx) {
            lyrIdx = act;
            const ps = document.getElementsByClassName('lyric-line');
            for (let p of ps) p.classList.remove('highlight');
            if (ps[act]) {
                ps[act].classList.add('highlight');
                if (!isEditing && !isUserScrolling) {
                    lView.scrollTo({ top: ps[act].offsetTop - (lView.clientHeight / 3.5), behavior: 'smooth' });
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

// ==========================================
// --- MEDIA SESSION (OS INTEGRATION) ---
// ==========================================
if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
}

// ==========================================
// --- BACKGROUND AUDIO PRELOADER ---
// ==========================================
async function preloadNextSong() {
    const nextIdx = curIdx + 1;
    if (nextIdx >= queue.length) return;
    if (lastPreloadedIdx === nextIdx) return;
    const nextSong = queue[nextIdx];
    if (!nextSong.isOnline || (!nextSong.needsAudioStream && nextSong.p)) return;
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
                    foundStream = true; break;
                }
            }
        } catch (e) { console.warn("[Preloader] Endpoint failed, trying next..."); }
    }
    if (foundStream && nextSong.p) { nextSong.needsAudioStream = false; saveState(); }
}

// ==========================================
// --- SEARCH (HYBRID LOCAL + ONLINE) ---
// ==========================================
let searchTimeout;

function filterQueue(query, targetId, isImmersive = false) {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!query || query.trim() === '') {
        target.style.display = 'none'; target.innerHTML = '';
        if (targetId === 'queue-list') draw();
        return;
    }
    target.style.display = 'block';
    const q = query.toLowerCase();

    let html = `<div style="padding:10px 10px 5px; color:var(--accent); font-size:0.75rem; font-weight:bold; letter-spacing:1px; text-transform:uppercase;">Local Queue</div>`;
    let localFound = false;
    queue.forEach((s, i) => {
        if (s.t.toLowerCase().includes(q) || s.a.toLowerCase().includes(q)) {
            localFound = true;
            let icon = s.isOnline ? "cloud" : "audiotrack";
            let encodedSong = encodeURIComponent(JSON.stringify(s));
            html += `
            <div class="item" data-type="local-search-result" data-song="${encodedSong}" onclick="playNextSearch(${i}, '${targetId}')" style="cursor:pointer;">
                <div class="item-left" style="display:flex; align-items:center;"><span class="material-icons-round" style="font-size:16px; margin-right:6px;">${icon}</span> <span style="margin:0; padding:0;">${s.t} - <small>${s.a}</small></span></div>
            </div>`;
        }
    });
    if (!localFound) html += `<div style="padding:10px; color:var(--dim); text-align:center; font-size: 0.85rem;">No local match</div>`;

    let history = JSON.parse(localStorage.getItem('playHistory') || '[]');
    let historyMatches = history.filter(s => s.t.toLowerCase().includes(q) || (s.a && s.a.toLowerCase().includes(q)));
    if (historyMatches.length > 0) {
        html += `<div style="padding:15px 10px 5px; color:#b57bff; font-size:0.75rem; font-weight:bold; letter-spacing:1px; text-transform:uppercase; border-top:1px solid #333; margin-top:5px;">From Your History</div>`;
        historyMatches.slice(0, 4).forEach((s) => {
            let safeT = s.t ? s.t.replace(/'/g, "\\'").replace(/"/g, '&quot;') : 'Unknown';
            let safeA = s.a ? s.a.replace(/'/g, "\\'").replace(/"/g, '&quot;') : 'Unknown';
            let coverHtml = s.cover
                ? `<img src="${s.cover}" style="width:30px; height:30px; border-radius:4px; margin-right:10px; object-fit:cover;">`
                : `<span class="material-icons-round" style="font-size:16px; color:var(--dim); margin-right:10px;">history</span>`;
            let encodedSong = encodeURIComponent(JSON.stringify(s));
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

    html += `<div style="padding:15px 10px 5px; color:var(--accent); font-size:0.75rem; font-weight:bold; letter-spacing:1px; text-transform:uppercase; border-top:1px solid #333; margin-top:5px;">Global Online Search</div>`;
    html += `<div id="${targetId}-online" style="max-height: 250px; overflow-y: auto; padding-right: 5px;"><div style="padding:15px; color:var(--dim); text-align:center; font-size: 0.85rem; display:flex; justify-content:center; align-items:center; gap:8px;"><span class="material-icons-round" style="animation: spin 1s linear infinite;">sync</span> Searching the world...</div></div>`;

    target.innerHTML = html;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => fetchOnlineSearch(query, `${targetId}-online`), 800);
}

async function fetchOnlineSearch(query, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
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
                        <div style="color:var(--dim); font-size:0.8rem; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${artist}</div>
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
    draw(); saveState();
    if (typeof switchToPlayerView === 'function') switchToPlayerView();
    if (queue.length === 1) play(0);
    else play(insertPos);
}

function addOnlineSong(encodedSong) {
    const s = JSON.parse(decodeURIComponent(encodedSong));
    const insertPos = queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, s);
    const sideSearch = document.getElementById('sidebar-search-results');
    const immSearch = document.getElementById('imm-search-results');
    if (sideSearch) sideSearch.style.display = 'none';
    if (immSearch) immSearch.style.display = 'none';
    if (document.getElementById('sidebar-search')) document.getElementById('sidebar-search').value = '';
    if (document.getElementById('imm-search')) document.getElementById('imm-search').value = '';
    draw(); saveState(); play(insertPos);
}

function playNextSearch(index, targetId) {
    const searchInputs = ['sidebar-search', 'imm-search'];
    searchInputs.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const resultsDivs = ['sidebar-search-results', 'imm-search-results'];
    resultsDivs.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    if (index === curIdx) return;
    const [selectedSong] = queue.splice(index, 1);
    if (index < curIdx) curIdx--;
    queue.splice(curIdx + 1, 0, selectedSong);
    play(curIdx + 1);
    draw(); saveState();
}

// ==========================================
// --- SEARCH BAR HIDE/SHOW LOGIC ---
// ==========================================
const sideSearch = document.getElementById('sidebar-search');
const immSearch = document.getElementById('imm-search');
const immResults = document.getElementById('imm-search-results');
const queueList = document.getElementById('queue-list');

document.addEventListener('click', (e) => {
    if (sideSearch && queueList) {
        if (e.target !== sideSearch && !queueList.contains(e.target)) {
            if (sideSearch.value.trim().length > 0) {
                const savedText = sideSearch.value;
                sideSearch.value = '';
                draw();
                sideSearch.value = savedText;
            }
        }
    }
    if (immSearch && immResults) {
        if (e.target !== immSearch && !immResults.contains(e.target)) {
            immResults.style.display = 'none';
        }
    }
});

if (sideSearch) {
    sideSearch.addEventListener('focus', () => {
        if (sideSearch.value.trim().length > 0) filterQueue(sideSearch.value, 'queue-list');
    });
}

if (immSearch) {
    immSearch.addEventListener('focus', () => {
        if (immSearch.value.trim().length > 0) immResults.style.display = 'block';
    });
}

// ==========================================
// --- DRAG AND DROP ---
// ==========================================
function dragStart(e, i) {
    e.dataTransfer.setData('text/plain', i);
    setTimeout(() => e.target.style.opacity = '0.01', 0);
}

function dragEnd(e) { e.target.style.opacity = '1'; draw(); }

function dragOver(e) {
    e.preventDefault();
    const container = e.currentTarget.closest('.list-container');
    if (container) {
        const cRect = container.getBoundingClientRect();
        const y = e.clientY - cRect.top;
        if (y < 60) container.scrollTop -= (60 - y) * 0.4;
        else if (y > cRect.height - 60) container.scrollTop += (y - (cRect.height - 60)) * 0.4;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.boxShadow = e.clientY > rect.top + rect.height / 2
        ? '0 2px 0 var(--accent)' : '0 -2px 0 var(--accent)';
}

function dragLeave(e) { e.currentTarget.style.boxShadow = ''; }

function drop(e, i) {
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.style.boxShadow = '';
    const fromText = e.dataTransfer.getData('text/plain');
    if (!fromText && e.dataTransfer.files.length > 0) { insertFilesAt(e.dataTransfer.files, i); return; }
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

// ==========================================
// --- FILE HANDLING ---
// ==========================================
function insertFilesAt(files, index) {
    const news = Array.from(files).filter(f => f.name.endsWith('.mp3')).map(f => {
        const fullPath = webUtils.getPathForFile(f);
        const baseName = f.name.replace('.mp3', '');
        let artist = "Unknown Artist", title = baseName;
        const dashIndex = baseName.indexOf('-');
        if (dashIndex !== -1) { artist = baseName.substring(0, dashIndex).trim(); title = baseName.substring(dashIndex + 1).trim(); }
        return { t: title, a: artist, p: fullPath };
    });
    if (news.length > 0) {
        const wasEmpty = queue.length === 0;
        queue.splice(index, 0, ...news);
        if (!wasEmpty && index <= curIdx) curIdx += news.length;
        draw(); saveState();
        if (wasEmpty) play(0);
        setTimeout(() => {
            const qList = document.getElementById('queue-list');
            const hList = document.getElementById('hover-queue-list');
            if (qList && qList.children[index]) qList.children[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (hList && hList.children[index]) hList.children[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
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

// ==========================================
// --- KEYBOARD SHORTCUTS ---
// ==========================================
document.addEventListener('keydown', (e) => {
    if ((e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && e.key.toLowerCase() !== 'escape') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key.toLowerCase()) {
        case 'escape':
            e.preventDefault();
            if (document.activeElement) document.activeElement.blur();
            const sidebarInput = document.getElementById('sidebar-search');
            const sidebarResults = document.getElementById('sidebar-search-results');
            if (sidebarInput) sidebarInput.value = '';
            if (sidebarResults) { sidebarResults.style.display = 'none'; sidebarResults.innerHTML = ''; }
            const immInput = document.getElementById('imm-search');
            const immDrop = document.getElementById('imm-search-results');
            if (immInput) immInput.value = '';
            if (immDrop) { immDrop.style.display = 'none'; immDrop.innerHTML = ''; }
            draw();
            break;
        case ' ':
            e.preventDefault(); togglePlay(); break;
        case 'arrowleft':
            e.preventDefault();
            if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 0);
            break;
        case 'arrowright':
            e.preventDefault();
            if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 0);
            break;
        case 'arrowup':
            e.preventDefault();
            audio.volume = Math.min(1, audio.volume + 0.05);
            showToast(`Volume: ${Math.round(audio.volume * 100)}%`);
            if (volSlider) volSlider.value = audio.volume;
            break;
        case 'arrowdown':
            e.preventDefault();
            audio.volume = Math.max(0, audio.volume - 0.05);
            showToast(`Volume: ${Math.round(audio.volume * 100)}%`);
            if (volSlider) volSlider.value = audio.volume;
            break;
        case 'm':
            e.preventDefault();
            const playerView = document.getElementById('view-player');
            if (playerView && playerView.classList.contains('active')) switchToHomeView();
            else if (queue.length > 0) switchToPlayerView();
            break;
        case 'r': e.preventDefault(); triggerRetryUI(); break;
        case 's':
            e.preventDefault();
            const isImmersive = document.body.classList.contains('immersive');
            const targetSearch = document.getElementById(isImmersive ? 'imm-search' : 'sidebar-search');
            if (targetSearch) targetSearch.focus();
            break;
        case 'x':
            e.preventDefault();
            const blockBtn = document.getElementById('btn-nolyrics');
            if (blockBtn) blockBtn.click();
            break;
        case 't': e.preventDefault(); toggleLyrics(); break;
        case 'z':
            e.preventDefault();
            shuffleRemaining();
            showToast("Queue Shuffled! 🔀");
            break;
    }
});

window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === 'MediaTrackNext') playNext();
    if (e.key === 'MediaTrackPrevious') playPrev();
    if (e.key === 'MediaPlayPause') togglePlay();
    if (e.key === 'ArrowUp') { e.preventDefault(); audio.volume = Math.min(1, audio.volume + 0.05); volSlider.value = audio.volume; localStorage.setItem('playerVol', audio.volume); }
    if (e.key === 'ArrowDown') { e.preventDefault(); audio.volume = Math.max(0, audio.volume - 0.05); volSlider.value = audio.volume; localStorage.setItem('playerVol', audio.volume); }
    if (e.key === 'ArrowRight') { if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10); }
    if (e.key === 'ArrowLeft') { if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10); }
});

// ==========================================
// --- MISC WINDOW HANDLERS ---
// ==========================================
window.act = function (songDataStr) {
    try {
        let song = JSON.parse(decodeURIComponent(songDataStr));
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

// Override openHistoryView to prevent double-definition conflict
window.openHistoryView = function () {
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

// Safe scroll override
window.scrollToCurrentSong = function () {
    try {
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
    } catch (e) { console.warn("Scroll bypassed safely."); }
};

//yo