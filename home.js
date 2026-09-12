// ==========================================
// --- SMART HOME PAGE ENGINE (YOUTUBE PROFILER) ---
// Analyzes local history, caches data to save quota,
// and uses hybrid rotating APIs to bypass 429/DNS blocks.
// ==========================================

async function loadSmartHome() {
    const homeDiv = document.getElementById('dynamic-homepage');
    if (!homeDiv) return;

    homeDiv.innerHTML = '<div style="padding: 20px; color: var(--dim); display: flex; align-items: center; gap: 10px;"><span class="material-icons-round" style="animation: spin 1s linear infinite;">sync</span> Fetching your YouTube Music homepage...</div>';

    try {
        if (window.isOnlineMode) {
            const authStatus = await require('electron').ipcRenderer.invoke('yt-auth-status');
            
            if (!authStatus || !authStatus.loggedIn) {
                homeDiv.innerHTML = `
                    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height: 60vh; text-align:center;">
                        <span class="material-icons-round" style="font-size: 80px; color: var(--dim); margin-bottom: 20px;">account_circle</span>
                        <h2 style="margin-bottom: 10px;">Sign in required</h2>
                        <p style="color: var(--dim); margin-bottom: 30px; max-width: 400px;">Online Mode connects directly to your YouTube Music account. Please sign in to view your home page and library.</p>
                        <button class="yt-btn-primary" onclick="if(typeof loginYTMusic === 'function') loginYTMusic()" style="font-size: 1.1rem; padding: 12px 30px; display:flex; align-items:center; gap: 8px;">
                            <span class="material-icons-round">login</span> Sign in to YT Music
                        </button>
                    </div>
                `;
                return; // STOP execution. No fallback.
            }

            if (authStatus && authStatus.loggedIn && !authStatus.sleeping) {
                const scrapeResult = await require('electron').ipcRenderer.invoke('scrape-yt-data');
                
                if (scrapeResult && scrapeResult.success && scrapeResult.data) {
                    // Render real authenticated homepage
                    if (scrapeResult.data.sections && scrapeResult.data.sections.length > 0) {
                        renderRealHome(scrapeResult.data.sections, homeDiv);
                    }
                    
                    // Update sidebar playlists with scraped ones
                    if (scrapeResult.data.playlists) {
                        localStorage.setItem('scrapedYTPlaylists', JSON.stringify(scrapeResult.data.playlists));
                        if (typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists();
                    }
                    
                    if (scrapeResult.data.sections && scrapeResult.data.sections.length > 0) return;
                }
            }
        }
    } catch (e) {
        console.warn("Could not scrape real home sections:", e);
    }

    if (window.isOnlineMode) {
        homeDiv.innerHTML = '<div style="padding: 20px; color: #ff4c4c; text-align:center;">Failed to load online data. Please check your connection or sign in again.</div>';
        return;
    }

    // Fallback to local history-based generation ONLY in normal mode
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

    let sortedArtists = Object.keys(artistCounts).sort((a, b) => artistCounts[b] - artistCounts[a]);
    let topArtist = sortedArtists[0] || null;
    let runnerUpArtist = sortedArtists[1] || null;
    let sortedGenres = Object.entries(genreScores).sort((a, b) => b[1] - a[1]);
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

function renderRealHome(sections, homeDiv) {
    const viewHome = document.getElementById('view-home');
    if (window.isOnlineMode && viewHome) {
        viewHome.classList.add('ytm-black-bg');
    }

    let html = `
    <div class="ytm-search-box-wrap">
        <span class="material-icons-round" style="color: var(--dim); margin-right: 10px;">search</span>
        <input type="text" placeholder="Search songs, albums, artists, podcasts" onkeydown="if(event.key==='Enter') { document.getElementById('sidebar-search').value = this.value; filterQueue(this.value, 'sidebar-search-results', false); }">
    </div>

    <div class="ytm-top-bar horizontal-carousel" style="padding-bottom: 10px;">
        <div class="ytm-chip">Podcasts</div>
        <div class="ytm-chip">Romance</div>
        <div class="ytm-chip">Feel good</div>
        <div class="ytm-chip">Relax</div>
        <div class="ytm-chip">Energize</div>
        <div class="ytm-chip">Party</div>
        <div class="ytm-chip">Workout</div>
        <div class="ytm-chip">Commute</div>
        <div class="ytm-chip">Sad</div>
        <div class="ytm-chip">Focus</div>
        <div class="ytm-chip">Sleep</div>
    </div>
    <div style="height: 20px;"></div>
    `;

    const avatarSrc = document.getElementById('yt-auth-avatar')?.src || 'https://ui-avatars.com/api/?name=Guest';
    const profileName = document.getElementById('yt-auth-status-text')?.innerText || 'YOUTUBE MUSIC USER';

    sections.forEach((section, i) => {
        html += `<div style="margin-bottom: 40px;">`;

        if (section.title.toLowerCase().includes('listen again')) {
            html += `
            <div class="ytm-section-header">
                <img src="${avatarSrc}" class="ytm-avatar">
                <div class="ytm-header-text">
                    <p>${profileName}</p>
                    <h2>${section.title}</h2>
                </div>
            </div>`;
        } else {
            html += `
            <div class="ytm-section-header">
                <div class="ytm-header-text">
                    <h2>${section.title}</h2>
                </div>
            </div>`;
        }

        html += `<div id="real-carousel-${i}" class="horizontal-carousel" style="display: flex; gap: 20px; overflow-x: auto; padding-bottom: 15px;">`;

        section.contents.forEach(item => {
            let safeT = (item.name || item.title || 'Unknown').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            let artistName = item.artists && item.artists[0] ? item.artists[0].name : (item.artist ? item.artist.name : '');
            let safeA = artistName.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            let safeCover = item.thumbnails && item.thumbnails.length > 0 ? item.thumbnails[item.thumbnails.length - 1].url : 'https://via.placeholder.com/150';

            let song = {
                t: item.name || item.title || 'Unknown',
                a: artistName || 'Unknown Artist',
                ytId: item.videoId || item.playlistId || item.browseId,
                cover: safeCover,
                isOnline: true,
                needsAudioStream: !!item.videoId
            };
            let songObj = encodeURIComponent(JSON.stringify(song));

            let typeText = 'Song';
            if (item.type === 'PLAYLIST' || (song.ytId && (song.ytId.startsWith('PL') || song.ytId.startsWith('VL')))) typeText = 'Playlist';
            else if (item.type === 'ALBUM' || (song.ytId && song.ytId.startsWith('MPRE'))) typeText = 'Album';
            else if (item.type === 'ARTIST' || (song.ytId && song.ytId.startsWith('UC'))) typeText = 'Artist';

            // Format subtitle exactly like YT Music
            let sub = typeText === 'Song' ? `E Song • ${safeA}` : `${typeText} • ${safeA}`;

            html += `
            <div class="ytm-card" data-song="${songObj}" onclick="playDirectlyFromHome('${songObj}')" oncontextmenu="openSearchMenu(event, '${songObj}')">
                <img src="${safeCover}">
                <div class="play-overlay"><span class="material-icons-round" style="color:white; font-size: 28px;">play_arrow</span></div>
                <div style="overflow:hidden; width:100%; position:relative;">
                    <div class="ytm-card-title q-title">${safeT}</div>
                    <div class="ytm-card-subtitle q-artist">${sub}</div>
                </div>
            </div>`;
        });

        html += `</div></div>`;
    });

    homeDiv.innerHTML = html;

    // Initialize marquee for new elements
    if (typeof syncMarqueeState === 'function') {
        homeDiv.querySelectorAll('.q-title, .q-artist').forEach(syncMarqueeState);
    }
}

window.renderDynamicHomepage = loadSmartHome; // export for auth.js to call

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
                <div style="overflow:hidden; width:100%; position:relative;">
                    <div class="title q-title">${safeT}</div>
                    <div class="artist q-artist">${safeA}</div>
                </div>
            </div>`;
        });
        container.innerHTML = html;

        // Initialize marquee for new elements
        if (typeof syncMarqueeState === 'function') {
            container.querySelectorAll('.q-title, .q-artist').forEach(syncMarqueeState);
        }

    } catch (e) {
        container.innerHTML = `<div style="color: var(--dim); padding: 15px;">Network blocked.</div>`;
    }
}



async function fetchHybridYTData(query) {
    const cacheKey = `shelf_${query.replace(/\s+/g, '')}`;
    const cachedData = sessionStorage.getItem(cacheKey);
    if (cachedData) return JSON.parse(cachedData);

    try {
        // 🔥 THE FIX: Route the search through the secure backend IPC!
        const results = await require('electron').ipcRenderer.invoke('search-yt-music', query);

        if (!results || results.length === 0) return [];

        let songs = results.slice(0, 10).map(song => ({
            t: song.name || 'Unknown',
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
        console.error("Backend YT API Failed:", e);
        return [];
    }
}

// ---------------------------------------------------------
// ▶️ MODULE 5: INJECTION HANDLER (WITH PLAYLIST INTERCEPTOR)
// ---------------------------------------------------------
window.playDirectlyFromHome = function (songStr) {
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

    // 🔥 ONLINE MODE INTERCEPTOR: Use silent search & start radio
    if (window.isOnlineMode && song.ytId && (!song.p || song.p === '')) {
        if (typeof showToast === 'function') showToast(`Starting Radio: ${song.t}...`);

        if (typeof clearQueue === 'function') clearQueue('all');

        // Wrap in async IIFE
        (async () => {
            try {
                const query = `${song.t} ${song.a}`;
                let res = await fetchWithFallback(`/search/songs?query=${encodeURIComponent(query)}&limit=1`);
                let json = await res.json();
                const results = json.data?.results || json.data?.songs?.results || [];
                if (results.length > 0) {
                    let bestMatch = results[0];
                    let title = bestMatch.name || bestMatch.title || song.t;
                    // basic decode hack since decodeHtmlText isn't in scope
                    title = title.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
                    let artist = song.a; // trust original scraper artist
                    let cover = bestMatch.image?.[2]?.url || bestMatch.image?.[bestMatch.image.length - 1]?.url || song.cover;

                    let downloadUrl = '';
                    if (bestMatch.downloadUrl) {
                        let obj = bestMatch.downloadUrl.find(x => x.quality === '320kbps' || x.quality === '160kbps');
                        if (obj) downloadUrl = obj.url || obj.link;
                    }

                    if (downloadUrl) {
                        song = { t: title, a: artist, cover: cover, isOnline: true, p: downloadUrl.replace('aac.saavncdn.com', 'c.saavncdn.com'), needsAudioStream: false, ytId: '' };
                    } else {
                        song.needsAudioStream = true;
                    }
                } else {
                    song.needsAudioStream = true;
                }
            } catch (e) {
                console.error("Silent search failed:", e);
                song.needsAudioStream = true;
            }

            queue = [song];
            curIdx = 0;

            if (typeof draw === 'function') draw();
            if (typeof saveState === 'function') saveState();
            if (typeof switchToPlayerView === 'function') switchToPlayerView();
            if (typeof play === 'function') play(0);

            // Start Radio Scraper
            require('electron').ipcRenderer.invoke('start-yt-radio', JSON.parse(decodeURIComponent(songStr)).ytId).then(res => {
                if (res && res.success && res.songs) {
                    res.songs.forEach(s => {
                        if (s.t.toLowerCase() !== song.t.toLowerCase()) {
                            queue.push(s);
                        }
                    });
                    if (typeof draw === 'function') draw();
                    if (typeof saveState === 'function') saveState();
                    if (typeof showToast === 'function') showToast(`Added ${res.songs.length} songs to Radio`);
                }
            });
        })();
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