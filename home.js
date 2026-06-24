// ==========================================
// --- SMART HOME PAGE ENGINE (YOUTUBE PROFILER) ---
// Analyzes local history, caches data to save quota,
// and uses hybrid rotating APIs to bypass 429/DNS blocks.
// ==========================================

async function loadSmartHome() {
    const homeDiv = document.getElementById('dynamic-homepage');
    if (!homeDiv) return;

    let history = JSON.parse(localStorage.getItem('playHistory') || '[]');
    let artistCounts = {};
    let genreScores = {
        'Electronic/EDM': 0, 'Instrumental/Beats': 0, 
        'Upbeat/Pop': 0, 'Chill/Lofi': 0, 'Heavy/Bass': 0
    };

    const genreKeywords = {
        'Electronic/EDM': ['remix', 'edm', 'mashup', 'house', 'techno', 'trance', 'mix', 'electro'],
        'Instrumental/Beats': ['instrumental', 'beat', 'type beat', 'fl studio', 'prod', 'synth'],
        'Upbeat/Pop': ['pop', 'dance', 'upbeat', 'party', 'club', 'viral'],
        'Chill/Lofi': ['lofi', 'chill', 'slowed', 'reverb', 'acoustic', 'relax', 'study'],
        'Heavy/Bass': ['bass', 'boosted', 'phonk', 'hardstyle', 'trap', 'drill']
    };

    history.forEach((s, index) => {
        let recencyMultiplier = 1 + (0.5 * (1 - (index / Math.max(history.length, 1))));
        if (s.a && s.a !== 'Unknown Artist') artistCounts[s.a] = (artistCounts[s.a] || 0) + (1 * recencyMultiplier);

        let searchString = `${s.t} ${s.a}`.toLowerCase();
        for (const [genre, keywords] of Object.entries(genreKeywords)) {
            keywords.forEach(kw => {
                if (searchString.includes(kw)) genreScores[genre] += (1 * recencyMultiplier);
            });
        }
    });

    let sortedArtists = Object.keys(artistCounts).sort((a,b) => artistCounts[b] - artistCounts[a]);
    let topArtist = sortedArtists[0] || null;
    let runnerUpArtist = sortedArtists[1] || null;
    let sortedGenres = Object.entries(genreScores).sort((a,b) => b[1] - a[1]);
    let topGenre = sortedGenres[0][1] > 0 ? sortedGenres[0][0] : null;

    const hour = new Date().getHours();
    let timeVibe, vibeQuery;
    if (hour < 5) { timeVibe = "Late Night"; vibeQuery = "late night dark ambient mix"; } 
    else if (hour < 12) { timeVibe = "Morning Focus"; vibeQuery = "morning upbeat electronic"; } 
    else if (hour < 17) { timeVibe = "Afternoon Drive"; vibeQuery = "afternoon high energy mix"; } 
    else { timeVibe = "Evening Energy"; vibeQuery = "evening party dance mix"; }

    let shelvesToBuild = [];
    shelvesToBuild.push({ title: `Your ${timeVibe}`, query: vibeQuery });

    if (topArtist) shelvesToBuild.push({ title: `Because you listen to ${topArtist}`, query: `${topArtist} greatest hits` });
    else shelvesToBuild.push({ title: `Trending Global Hits`, query: `Global Top 50 Songs` });

    if (topGenre === 'Electronic/EDM' || topGenre === 'Heavy/Bass') shelvesToBuild.push({ title: `Heavy Rotation: Festival & Club`, query: `Trending EDM Festival Mashups` });
    else if (topGenre === 'Instrumental/Beats') shelvesToBuild.push({ title: `Fresh Instrumentals`, query: `Best Instrumental Beats` });
    else if (runnerUpArtist) shelvesToBuild.push({ title: `More like ${runnerUpArtist}`, query: `${runnerUpArtist} mix` });
    else shelvesToBuild.push({ title: `Curated For You`, query: `Trending Viral Pop` });

    let skeletonHtml = '';
    for (let i = 0; i < shelvesToBuild.length; i++) {
        skeletonHtml += `
        <div style="margin-top: 35px;">
            <h2 style="margin-bottom: 15px; font-size: 1.4rem;">${shelvesToBuild[i].title}</h2>
            <div id="smart-carousel-${i}" class="horizontal-carousel">
                <div style="padding: 20px; color: var(--dim); display: flex; align-items: center; gap: 10px;">
                    <span class="material-icons-round" style="animation: spin 1s linear infinite;">sync</span> Fetching tracks...
                </div>
            </div>
        </div>`;
    }
    homeDiv.innerHTML = skeletonHtml;

    const emergencyQueries = ["Trending Pop Music", "Lofi Girl Radio", "Top Electronic Hits"];

    for (let i = 0; i < shelvesToBuild.length; i++) {
        populateSmartCarousel(shelvesToBuild[i].query, `smart-carousel-${i}`, emergencyQueries);
    }
}

// ---------------------------------------------------------
// 🌐 MODULE 4: HYBRID CACHING API FETCHER
// ---------------------------------------------------------
async function populateSmartCarousel(query, containerId, emergencyQueries) {
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        let songs = await fetchHybridYTData(query);
        
        // Single fallback attempt if the main query fails
        if (!songs || songs.length === 0) {
            console.warn(`[Smart Engine] Query '${query}' failed. Trying one fallback.`);
            let randomFallback = emergencyQueries[Math.floor(Math.random() * emergencyQueries.length)];
            songs = await fetchHybridYTData(randomFallback);
        }

        if (!songs || songs.length === 0) {
            container.innerHTML = `<div style="color: var(--dim); padding: 15px;">API Limit Reached. Play a local track!</div>`;
            return;
        }

        let html = "";
        songs.forEach(song => {
            let safeT = (song.t || 'Unknown').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            let safeA = (song.a || 'Unknown').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            let safeCover = song.cover || 'https://via.placeholder.com/150';
            let songObj = encodeURIComponent(JSON.stringify(song));

            html += `
            <div class="song-card" data-type="song" data-song="${songObj}" 
                 onclick="playDirectlyFromHome('${songObj}')" 
                 oncontextmenu="openSearchMenu(event, '${songObj}')">
                <img src="${safeCover}">
                <div class="title">${safeT}</div>
                <div class="artist">${safeA}</div>
            </div>`;
        });
        
        container.innerHTML = html;

    } catch (e) {
        container.innerHTML = `<div style="color: var(--dim); padding: 15px;">Network blocked.</div>`;
    }
}

// Native Node.js YouTube Music Scraper (Zero API Limits)
const YTMusic = require('ytmusic-api');
const ytHomeApi = new YTMusic();
let isHomeApiReady = false;

async function fetchHybridYTData(query) {
    const cacheKey = `shelf_${query.replace(/\s+/g, '')}`;
    const cachedData = sessionStorage.getItem(cacheKey);
    if (cachedData) return JSON.parse(cachedData);

    try {
        if (!isHomeApiReady) {
            await ytHomeApi.initialize();
            isHomeApiReady = true;
        }
        
        // Native scrape! No API keys, no 429 errors!
        const results = await ytHomeApi.searchSongs(query);
        
        if (!results || results.length === 0) return [];

        let songs = results.slice(0, 10).map(song => ({
            t: song.name,
            a: song.artist?.name || "Unknown Artist",
            ytId: song.videoId,
            cover: song.thumbnails && song.thumbnails.length > 0 ? song.thumbnails[song.thumbnails.length - 1].url : "https://via.placeholder.com/150",
            isOnline: true,
            needsAudioStream: true,
            p: ''
        }));

        sessionStorage.setItem(cacheKey, JSON.stringify(songs));
        return songs;
    } catch (e) {
        console.error("Native YT API Failed:", e);
        return [];
    }
}

// ---------------------------------------------------------
// ▶️ MODULE 5: INJECTION HANDLER (WITH PLAYLIST INTERCEPTOR)
// ---------------------------------------------------------
window.playDirectlyFromHome = function(songStr) {
    let song = JSON.parse(decodeURIComponent(songStr));
    
    // 🔥 THE INTERCEPTOR: If a playlist sneaks onto the home page, catch it!
    // Playlist IDs from YouTube always start with 'PL', 'VLPL', or 'RD'
    if (song.ytId && (song.ytId.startsWith('PL') || song.ytId.startsWith('VLPL') || song.ytId.startsWith('RD'))) {
        if (typeof showToast === 'function') showToast("Routing to Playlist View...");
        if (typeof openPlaylist === 'function') {
            // Open it cleanly in your Playlist Viewer instead of breaking the player!
            openPlaylist(song.ytId, song.t);
        }
        return;
    }

    // Normal Song Logic continues...
    const insertPos = typeof queue !== 'undefined' && queue.length === 0 ? 0 : curIdx + 1;
    queue.splice(insertPos, 0, song);
    
    if (typeof draw === 'function') draw();
    if (typeof saveState === 'function') saveState();
    if (typeof switchToPlayerView === 'function') switchToPlayerView();
    if (typeof play === 'function') play(insertPos);
    
    const sideSearch = document.getElementById('sidebar-search-results');
    const immSearch = document.getElementById('imm-search-results');
    if (sideSearch) sideSearch.style.display = 'none';
    if (immSearch) immSearch.style.display = 'none';
};

window.addEventListener('load', () => { setTimeout(loadSmartHome, 500); });