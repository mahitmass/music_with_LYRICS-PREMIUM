// ==========================================
// --- SMART HOME PAGE ENGINE (YOUTUBE PROFILER) ---
// Analyzes local history, calculates time-of-day vibes, 
// extracts genres, and fetches via official YouTube API.
// ==========================================

async function loadSmartHome() {
    const homeDiv = document.getElementById('dynamic-homepage');
    if (!homeDiv) return;

    // ---------------------------------------------------------
    // 🧠 MODULE 1: THE DATA EXTRACTOR & GENRE ANALYZER
    // ---------------------------------------------------------
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

    // ---------------------------------------------------------
    // 📦 MODULE 2: SHELF ARCHITECT
    // ---------------------------------------------------------
    let shelvesToBuild = [];
    shelvesToBuild.push({ title: `Your ${timeVibe}`, query: vibeQuery });

    if (topArtist) shelvesToBuild.push({ title: `Because you listen to ${topArtist}`, query: `${topArtist} greatest hits` });
    else shelvesToBuild.push({ title: `Trending Global Hits`, query: `Global Top 50 Songs` });

    if (topGenre === 'Electronic/EDM' || topGenre === 'Heavy/Bass') shelvesToBuild.push({ title: `Heavy Rotation: Festival & Club`, query: `Trending EDM Festival Mashups` });
    else if (topGenre === 'Instrumental/Beats') shelvesToBuild.push({ title: `Fresh Instrumentals`, query: `Best Instrumental Beats` });
    else if (runnerUpArtist) shelvesToBuild.push({ title: `More like ${runnerUpArtist}`, query: `${runnerUpArtist} mix` });
    else shelvesToBuild.push({ title: `Curated For You`, query: `Trending Viral Pop` });

    // ---------------------------------------------------------
    // 🚀 MODULE 3: BACKGROUND UI RENDERING
    // ---------------------------------------------------------
    // Draw the empty carousels IMMEDIATELY so the UI looks beautiful instantly
    let skeletonHtml = '';
    for (let i = 0; i < shelvesToBuild.length; i++) {
        skeletonHtml += `
        <div style="margin-top: 35px;">
            <h2 style="margin-bottom: 15px; font-size: 1.4rem;">${shelvesToBuild[i].title}</h2>
            <div id="smart-carousel-${i}" class="horizontal-carousel">
                <div style="padding: 20px; color: var(--dim); display: flex; align-items: center; gap: 10px;">
                    <span class="material-icons-round" style="animation: spin 1s linear infinite;">sync</span> Loading tracks...
                </div>
            </div>
        </div>`;
    }
    homeDiv.innerHTML = skeletonHtml;

    const emergencyQueries = ["Trending Pop Music", "Lofi Girl Radio", "Top Electronic Hits"];

    // Fetch and populate each carousel silently in the background
    for (let i = 0; i < shelvesToBuild.length; i++) {
        populateSmartCarousel(shelvesToBuild[i].query, `smart-carousel-${i}`, emergencyQueries);
    }
}

// ---------------------------------------------------------
// 🌐 MODULE 4: OFFICIAL YOUTUBE API FETCHER (BULLETPROOF)
// ---------------------------------------------------------
async function populateSmartCarousel(query, containerId, emergencyQueries) {
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        let songs = await fetchOfficialYTData(query);
        
        if (!songs || songs.length === 0) {
            console.warn(`[Smart Engine] Query '${query}' failed. Triggering fallback.`);
            let randomFallback = emergencyQueries[Math.floor(Math.random() * emergencyQueries.length)];
            songs = await fetchOfficialYTData(randomFallback);
        }

        if (!songs || songs.length === 0) throw new Error("API completely blocked");

        let html = "";
        songs.forEach(song => {
            let safeT = (song.t || 'Unknown').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            let safeA = (song.a || 'Unknown').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            let safeCover = song.cover || 'https://via.placeholder.com/150';
            let songObj = encodeURIComponent(JSON.stringify(song));

            // Native UI Song Card
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
        container.innerHTML = `<div style="color: var(--dim); padding: 15px;">Failed to load row.</div>`;
    }
}

async function fetchOfficialYTData(query) {
    // Uses your official API key from renderer.js
    const apiKey = typeof window !== 'undefined' && window.YOUTUBE_API_KEY ? window.YOUTUBE_API_KEY : "AIzaSyBdRzlUo8JQ_fsrlY3SokFfhwYYW1kKrv8";
    
    try {
        const enhancedQuery = query.toLowerCase().includes('song') || query.toLowerCase().includes('mix') ? query : query + ' song';
        let res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=${encodeURIComponent(enhancedQuery)}&key=${apiKey}`);
        
        if (!res.ok) return [];
        
        const data = await res.json();
        if (!data.items || data.items.length === 0) return [];

        return data.items.map(item => {
            let rawTitle = decodeURIComponent(item.snippet.title).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            let rawArtist = decodeURIComponent(item.snippet.channelTitle).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            
            let title = rawTitle.replace(/\(Official.*?\)/gi, '').replace(/\[Official.*?\]/gi, '').replace(/\(Audio\)/gi, '').replace(/- Topic/gi, '').trim();
            let artist = rawArtist.replace(/- Topic/gi, '').trim();

            if (title.toLowerCase().startsWith(artist.toLowerCase() + ' - ')) {
                title = title.substring(artist.length + 3).trim();
            }

            let cover = item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url || "";
            return { t: title, a: artist, ytId: item.id.videoId, cover: cover, isOnline: true, needsAudioStream: true, p: '' };
        });
    } catch(e) {
        console.error("YT API Error:", e);
        return [];
    }
}

// ---------------------------------------------------------
// ▶️ MODULE 5: INJECTION HANDLER
// ---------------------------------------------------------
window.playDirectlyFromHome = function(songStr) {
    let song = JSON.parse(decodeURIComponent(songStr));
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

// Initialize when the app opens
window.addEventListener('load', () => {
    setTimeout(loadSmartHome, 500);
});