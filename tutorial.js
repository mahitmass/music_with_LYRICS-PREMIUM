/**
 * ============================================================================
 * MASS MEDIA PLAYER - PRO TUTORIAL ENGINE (WITH LIVE SIMULATION)
 * ============================================================================
 */

const config = {
    overlayColor: 'transparent', // No blur, crystal clear background!
    accentColor: '#4cc2ff',
    textColor: '#ffffff',
    dimColor: '#aaaaaa',
    animationSpeed: '0.4s'
};

const tutorialSteps = [
    {
        id: 'intro',
        title: "Welcome to Mass Media Player",
        text: "Let's take a live, interactive tour. We're going to load a real track so you can see exactly how the Pro features and Lyrics Engine work in real-time.",
        target: null,
        placement: 'center',
        actionRequired: null,
        icon: 'rocket_launch'
    },
    {
        id: 'dual-queue',
        title: "The Dual Queue System",
        text: "You have TWO separate queues. Your <b>Main Queue</b> keeps your everyday songs safe, while the <b>Playlist Queue</b> handles massive albums. Toggle them here.",
        target: '.queue-toggle-wrapper',
        placement: 'right',
        actionRequired: null,
        icon: 'queue_music'
    },
    {
        id: 'library-view',
        title: "Your Personal Library",
        text: "<b>Hover over the left sidebar</b> to reveal your menu! <br><br>Everything you save goes here. Your local favorites, custom playlists, and downloaded albums.",
        target: '.playlist-link', 
        placement: 'right',
        actionRequired: null,
        icon: 'library_music'
    },
    {
        id: 'playlist-import',
        title: "Instant Playlist Import",
        text: "Got a massive playlist on YouTube Music? <br><br>Just <b>paste the YouTube playlist link</b> directly into the box below 'My Library' and click Add!",
        target: '#new-pl-input', 
        placement: 'right',
        actionRequired: null,
        icon: 'link'
    },
    {
        id: 'search-s',
        title: "Universal Global Search",
        text: "Let's find a track to test the player with! <br><br><b>Press 'S'</b> right now to see the search bar activate.",
        target: '.sidebar-search-wrap',
        placement: 'right',
        actionRequired: 's',
        icon: 'search',
        onExit: () => {
            // THE LIVE TEST INJECTION: Lowers volume to 5% and triggers a real search
            if (typeof audio !== 'undefined') audio.volume = 0.05;
            const volSlider = document.getElementById('vol');
            if (volSlider) volSlider.value = 0.05;
            
            const searchBar = document.getElementById('sidebar-search');
            if (searchBar) {
                searchBar.value = 'Imagine Dragons';
                // Trigger natural DOM event so the app searches automatically
                searchBar.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    },
    {
        id: 'select-song',
        title: "Start the Music!",
        text: "We just ran a live search for you! <br><br><b>Click any song</b> from the dropdown results. It will play safely at 5% volume and automatically open the Lyrics View. Then click Next.",
        target: '#sidebar-search-results',
        placement: 'right',
        actionRequired: null,
        icon: 'touch_app'
    },
    {
        id: 'immersive-intro',
        title: "The Immersive View",
        text: "Welcome to the Lyrics View! Notice the high-fidelity album art and the live scrolling lyrics. You have full control from this screen.",
        target: null,
        placement: 'center',
        actionRequired: null,
        icon: 'visibility'
    },
    {
        id: 'lyrics-t',
        title: "Toggle Lyrics Engine",
        text: "If you are doing heavy work in the background, you can disable the lyrics engine to save CPU power.<br><br><b>Press 'T'</b> to toggle it off/on.",
        target: '#btn-toggle-lyrics',
        placement: 'top',
        actionRequired: 't',
        icon: 'subtitles'
    },
    {
        id: 'lyrics-r',
        title: "Alternative Lyrics",
        text: "Database pulled the wrong version? Let's open the Alternative Lyrics menu.<br><br><b>Press 'R'</b> to open the menu.",
        target: '#btn-retry',
        placement: 'top',
        actionRequired: 'r',
        icon: 'sync'
    },
    {
        id: 'retry-logic',
        title: "Timed vs. Text Only",
        text: "In the Retry menu, look for these tags:<br><br>• <b style='color:var(--accent)'>TIMED:</b> Perfectly synced.<br>• <b style='color:#888'>TEXT ONLY:</b> Standard text.<br><br><b>AI Logic:</b> If you pick Text Only, the app automatically stretches lines to match the song's duration!",
        target: '.retry-item', 
        placement: 'bottom',  
        actionRequired: null,
        icon: 'analytics',
        onExit: () => {
            document.body.classList.remove('retry-mode');
        }
    },
    {
        id: 'lyrics-x',
        title: "Block Bad Lyrics",
        text: "If a song's lyrics are completely wrong and you want to hide them permanently for that track...<br><br><b>Press 'X'</b> to block them.",
        target: '#btn-nolyrics',
        placement: 'top',
        actionRequired: 'x',
        icon: 'block'
    },
    {
        id: 'playback-space',
        title: "Play & Pause",
        text: "You can quickly halt or resume the music from anywhere.<br><br><b>Press 'Spacebar'</b> to toggle the play button below.",
        target: '.play-btn',
        placement: 'top',
        actionRequired: ' ',
        icon: 'play_arrow'
    },
    {
        id: 'volume-arrows',
        title: "Volume Control",
        text: "Adjust the volume quickly without using the mouse.<br><br><b>Press the 'Up Arrow' or 'Down Arrow'</b> to move the volume slider.",
        target: '.volume-controls',
        placement: 'top',
        actionRequired: ['arrowup', 'arrowdown'],
        icon: 'volume_up'
    },
    {
        id: 'seek-arrows',
        title: "Time Travel",
        text: "Skip long intros or replay your favorite verse.<br><br><b>Press the 'Left Arrow' or 'Right Arrow'</b> to jump 10 seconds through the track.",
        target: '.progress-container',
        placement: 'top',
        actionRequired: ['arrowleft', 'arrowright'],
        icon: 'fast_forward'
    },
    {
        id: 'shuffle-z',
        title: "Magic Shuffle",
        text: "You can shuffle all the <i>remaining</i> songs in your queue without interrupting the currently playing song.<br><br><b>Press 'Z'</b> to trigger a shuffle.",
        target: '.main-controls span[title="Shuffle Remaining"]',
        placement: 'top',
        actionRequired: 'z',
        icon: 'shuffle'
    },
    {
        id: 'escape-key',
        title: "Clear the Clutter",
        text: "To instantly close any dropdown menus and clear typed search text...<br><br><b>Press 'Escape'</b>.",
        target: '.sidebar-search-wrap',
        placement: 'right',
        actionRequired: 'escape',
        icon: 'close'
    },
    {
        id: 'view-m',
        title: "Seamless Toggling",
        text: "You can instantly jump between your Home screen and the Lyrics View without stopping the music.<br><br><b>Press 'M'</b> to switch views right now.",
        target: null,
        placement: 'center',
        actionRequired: 'm',
        icon: 'flip_to_front',
        onExit: () => {
            // Force the switch just in case the key simulator didn't fire natively
            if (typeof switchToHomeView === 'function') switchToHomeView();
        }
    },
    {
        id: 'context-menu',
        title: "The Pro Context Menu",
        text: "Almost everything in Mass Media Player can be right-clicked! <br><br><b>Right-Click</b> any song card here on the Home screen to see options like <i>Play Next</i> or <i>Save to Favorites</i>.",
        target: '.song-card', 
        placement: 'right',
        actionRequired: null,
        icon: 'mouse'
    },
    {
        id: 'mini-player',
        title: "Background Listening",
        text: "While you browse the Explore page or manage your library, your currently playing track stays tucked away safely at the bottom of the screen.",
        target: '.bottom-bar',
        placement: 'top',
        actionRequired: null,
        icon: 'speaker'
    },
    {
        id: 'outro',
        title: "You're All Set!",
        text: "You have mastered Mass Media Player. Enjoy your high-fidelity, perfectly synced music experience.",
        target: null,
        placement: 'center',
        actionRequired: null,
        icon: 'check_circle'
    }
];

let currentTutStep = 0;
let resizeObserver = null;
let keyListenerBound = false;
let isTutorialActive = false;

function injectTutorialStyles() {
    if (document.getElementById('mass-media-tut-styles')) return;
    const style = document.createElement('style');
    style.id = 'mass-media-tut-styles';
    style.innerHTML = `
        #tut-overlay-master { opacity: 0; transition: opacity 0.5s ease; }
        #tut-overlay-master.visible { opacity: 1; }
        .tut-dialog { position: absolute; width: 380px; background: #151515; border: 1px solid ${config.accentColor}; border-radius: 16px; padding: 30px; color: ${config.textColor}; pointer-events: auto; box-shadow: 0 25px 50px rgba(0,0,0,0.9); transition: all ${config.animationSpeed} cubic-bezier(0.25, 1, 0.5, 1); opacity: 0; transform: translateY(30px) scale(0.95); font-family: sans-serif; z-index: 100000; }
        .tut-dialog.visible { opacity: 1; transform: translateY(0) scale(1); }
        #tut-hole, .tut-arrow { transition: all ${config.animationSpeed} cubic-bezier(0.25, 1, 0.5, 1); }
        .tut-arrow { position: absolute; width: 0; height: 0; border-style: solid; }
        .tut-btn-primary { background: ${config.accentColor}; color: #000; border: none; border-radius: 8px; padding: 10px 20px; font-weight: 900; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 15px rgba(76,194,255,0.3); }
        .tut-btn-primary:disabled { background: #333; color: #666; cursor: not-allowed; box-shadow: none; }
        @keyframes tutPulse { 0% { opacity: 0.6; } 50% { opacity: 1; text-shadow: 0 0 10px ${config.accentColor}; } 100% { opacity: 0.6; } }
        .tut-key-hint { color: ${config.accentColor}; animation: tutPulse 2s infinite; display: inline-block; margin-top: 15px; font-size: 0.85rem; background: rgba(76,194,255,0.1); padding: 8px 12px; border-radius: 6px; border: 1px dashed rgba(76,194,255,0.3); font-weight: bold; }
    `;
    document.head.appendChild(style);
}

function initMassMediaTutorial() {
if (localStorage.getItem('tutorialDone') === 'true') return;
    injectTutorialStyles();
    isTutorialActive = true;

    const overlay = document.createElement('div');
    overlay.id = 'tut-overlay-master';
    overlay.style.cssText = `position:fixed; top:0; left:0; width:100vw; height:100vh; z-index:99999; pointer-events:none;`;
    
    // SVG Mask (NO BLUR applied to background)
    overlay.innerHTML = `
        <svg width="100%" height="100%" style="position:absolute; top:0; left:0;">
            <mask id="tut-mask">
                <rect width="100%" height="100%" fill="white"/>
                <rect id="tut-hole" x="0" y="0" width="0" height="0" rx="8" fill="black" />
            </mask>
            <rect width="100%" height="100%" fill="${config.overlayColor}" mask="url(#tut-mask)"/>
        </svg>
        <div id="tut-dialog" class="tut-dialog">
            <div id="tut-arrow" class="tut-arrow"></div>
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:15px;">
                <span id="tut-icon" class="material-icons-round" style="color:${config.accentColor}; font-size:28px;"></span>
                <h2 id="tut-title" style="margin:0; font-size:1.3rem; font-weight:800;"></h2>
            </div>
            <p id="tut-desc" style="margin:0 0 25px 0; font-size:0.95rem; line-height:1.6; color:${config.dimColor};"></p>
            <div id="tut-key-hint-container" style="display:none; text-align:center; margin-bottom: 20px;">
                <span id="tut-key-hint" class="tut-key-hint"></span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid rgba(255,255,255,0.1); padding-top:20px;">
                <span id="tut-counter" style="color:${config.textColor}; font-size:0.9rem; font-weight:bold;"></span>
                <div style="display:flex; gap:15px; align-items:center;">
                    <button onclick="exitMassMediaTutorial()" style="background:none; border:none; color:${config.dimColor}; cursor:pointer; font-weight:bold;">Skip</button>
                    <button id="tut-next-btn" class="tut-btn-primary" onclick="advanceMassMediaTutorial()">Next</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    resizeObserver = new window.ResizeObserver(() => { if (isTutorialActive) renderTutorialStep(); });
    resizeObserver.observe(document.body);

    if (!keyListenerBound) {
        window.addEventListener('keydown', handleTutorialKeystroke, true); // Catch keys before the app does
        keyListenerBound = true;
    }

    renderTutorialStep();
    requestAnimationFrame(() => document.getElementById('tut-overlay-master').classList.add('visible'));
}

function renderTutorialStep() {
    if (currentTutStep >= tutorialSteps.length) return exitMassMediaTutorial();
    
    const step = tutorialSteps[currentTutStep];
    const hole = document.getElementById('tut-hole');
    const dialog = document.getElementById('tut-dialog');
    const arrow = document.getElementById('tut-arrow');
    const nextBtn = document.getElementById('tut-next-btn');
    const hintContainer = document.getElementById('tut-key-hint-container');
    const hintText = document.getElementById('tut-key-hint');
    
    document.getElementById('tut-icon').innerText = step.icon;
    document.getElementById('tut-title').innerText = step.title;
    document.getElementById('tut-desc').innerHTML = step.text;
    document.getElementById('tut-counter').innerText = `${currentTutStep + 1} / ${tutorialSteps.length}`;
    
    if (step.actionRequired) {
        nextBtn.disabled = true;
        nextBtn.innerText = "Waiting...";
        hintContainer.style.display = 'block';
        hintText.innerText = `Awaiting key: [ ${Array.isArray(step.actionRequired) ? step.actionRequired.join(' or ').toUpperCase() : step.actionRequired.toUpperCase()} ]`;
    } else {
        nextBtn.disabled = false;
        nextBtn.innerText = (currentTutStep === tutorialSteps.length - 1) ? "Finish Tour" : "Next Step";
        hintContainer.style.display = 'none';
    }

    const targetEl = step.target ? document.querySelector(step.target) : null;

    if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
            if (!isTutorialActive) return;
            const rect = targetEl.getBoundingClientRect();
            
            hole.setAttribute('x', rect.left - 10);
            hole.setAttribute('y', rect.top - 10);
            hole.setAttribute('width', rect.width + 20);
            hole.setAttribute('height', rect.height + 20);

            dialog.style.left = 'auto'; dialog.style.top = 'auto'; dialog.style.bottom = 'auto'; dialog.style.right = 'auto';
            arrow.style.borderWidth = '0'; 

            if (step.placement === 'right') {
                dialog.style.left = `${rect.right + 35}px`;
                dialog.style.top = `${rect.top + (rect.height/2) - (dialog.offsetHeight/2)}px`;
                arrow.style.borderWidth = '12px 18px 12px 0';
                arrow.style.borderColor = `transparent ${config.accentColor} transparent transparent`;
                arrow.style.left = '-18px'; arrow.style.top = 'calc(50% - 12px)'; arrow.style.bottom = 'auto';
            } else if (step.placement === 'top') {
                dialog.style.left = `${rect.left + (rect.width/2) - (dialog.offsetWidth/2)}px`;
                dialog.style.top = `${rect.top - dialog.offsetHeight - 35}px`;
                arrow.style.borderWidth = '18px 12px 0 12px';
                arrow.style.borderColor = `${config.accentColor} transparent transparent transparent`;
                arrow.style.left = 'calc(50% - 12px)'; arrow.style.bottom = '-18px'; arrow.style.top = 'auto';
            }
            else if (step.placement === 'bottom') {
                dialog.style.left = `${rect.left + (rect.width/2) - (dialog.offsetWidth/2)}px`;
                dialog.style.top = `${rect.bottom + 25}px`;
                arrow.style.borderWidth = '0 12px 18px 12px';
                arrow.style.borderColor = `transparent transparent ${config.accentColor} transparent`;
                arrow.style.left = 'calc(50% - 12px)'; arrow.style.top = '-18px'; arrow.style.bottom = 'auto';
            }

            const dRect = dialog.getBoundingClientRect();
            if (dRect.bottom > window.innerHeight) dialog.style.top = `${window.innerHeight - dRect.height - 20}px`;
            if (dRect.top < 0) dialog.style.top = `20px`;
            if (dRect.left < 0) dialog.style.left = `20px`;
            if (dRect.right > window.innerWidth) dialog.style.left = `${window.innerWidth - dRect.width - 20}px`;

            dialog.classList.add('visible');
        }, 350); 
    } else {
        hole.setAttribute('width', '0'); hole.setAttribute('height', '0');
        dialog.style.left = `calc(50% - 190px)`; 
        dialog.style.top = `calc(50% - ${dialog.offsetHeight/2}px)`;
        arrow.style.borderWidth = '0';
        setTimeout(() => dialog.classList.add('visible'), 50);
    }
}

// ---------------------------------------------------------
// THE VISUAL SIMULATOR (Fakes the UI interactions safely)
// ---------------------------------------------------------
function handleTutorialKeystroke(e) {
    if (!isTutorialActive) return;
    const step = tutorialSteps[currentTutStep];
    const key = e.key.toLowerCase();
    const massMediaKeys = ['escape', ' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', 'r', 's', 'x', 't', 'z'];

    if (massMediaKeys.includes(key)) {
        let isMatch = Array.isArray(step.actionRequired) ? step.actionRequired.includes(key) : step.actionRequired === key;

        if (isMatch) {
            e.stopPropagation(); e.preventDefault(); // Stop real app logic

            // 1. VISUALLY SIMULATE THE ACTION SO THE USER CAN SEE IT WORK!
            if (key === 's') {
                const sBar = document.getElementById('sidebar-search');
                if (sBar) { sBar.focus(); sBar.value = "Imagine Dragons..."; }
            }
            if (key === 'escape') {
                const sBar = document.getElementById('sidebar-search');
                if (sBar) sBar.value = '';
            }
            if (key === ' ') {
                const pIcon = document.getElementById('p-icon');
                if (pIcon) pIcon.innerText = pIcon.innerText === 'play_arrow' ? 'pause' : 'play_arrow';
            }
            if (key === 'arrowup' || key === 'arrowdown') {
                if (typeof showToast === 'function') showToast("Volume Adjusted");
                const vol = document.getElementById('vol');
                if (vol) vol.value = key === 'arrowup' ? 0.8 : 0.4;
            }
            if (key === 'arrowleft' || key === 'arrowright') {
                const fill = document.getElementById('fill');
                if (fill) fill.style.width = key === 'arrowright' ? '60%' : '20%';
            }
            if (key === 'm') {
                // ACTUALLY switch views so the rest of the tutorial works!
                if (typeof switchToPlayerView === 'function') switchToPlayerView();
            }
            if (key === 'z') {
                if (typeof showToast === 'function') showToast("Queue Shuffled! 🔀");
            }
            if (key === 't') {
                const tbtn = document.getElementById('btn-toggle-lyrics');
                if (tbtn) {
                    tbtn.style.color = tbtn.style.color ? '' : 'var(--accent)';
                    tbtn.innerText = tbtn.innerText === 'subtitles' ? 'subtitles_off' : 'subtitles';
                }
            }
            if (key === 'r') {
                // Safely open a fake retry menu for the next step to explain
                document.body.classList.add('retry-mode');
                const cont = document.getElementById('retry-results-container');
                if(cont) cont.innerHTML = `
                    <div class="retry-item" style="border: 1px solid var(--accent); margin-bottom:10px;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="font-weight:bold; color:white;">Demo Track (Extended Mix)</span>
                            <span style="color:var(--accent); font-weight:bold; font-size:0.7rem; border:1px solid var(--accent); padding:2px 6px; border-radius:4px;">TIMED</span>
                        </div>
                        <div style="color:#aaa; font-family:monospace; margin-top:8px; font-size:0.85rem;">[00:15.20] Perfect word-by-word sync...</div>
                    </div>
                    <div class="retry-item">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="font-weight:bold; color:white;">Demo Track (Original)</span>
                            <span style="color:#888; font-weight:bold; font-size:0.7rem; border:1px solid #888; padding:2px 6px; border-radius:4px;">TEXT ONLY</span>
                        </div>
                        <div style="color:#aaa; font-family:monospace; margin-top:8px; font-size:0.85rem;">Standard plain text paragraph...</div>
                    </div>`;
            }
            if (key === 'x') {
                const xbtn = document.getElementById('btn-nolyrics');
                if (xbtn) xbtn.style.color = '#ff4c4c';
            }

            // 2. SHOW SUCCESS AND ADVANCE
            const nextBtn = document.getElementById('tut-next-btn');
            if (nextBtn) {
                nextBtn.innerText = "Success! ✓";
                nextBtn.style.background = "#4caf50"; 
                nextBtn.style.color = "white";
            }
            setTimeout(advanceMassMediaTutorial, 600);
        } else if (step.actionRequired) {
            e.stopPropagation(); e.preventDefault();
            const hint = document.getElementById('tut-key-hint');
            if (hint) {
                hint.innerText = "Wrong key! Press the requested key.";
                hint.style.color = "#ff4c4c"; 
                setTimeout(() => {
                    hint.style.color = config.accentColor;
                    hint.innerText = `Awaiting key: [ ${Array.isArray(step.actionRequired) ? step.actionRequired.join(' or ').toUpperCase() : step.actionRequired.toUpperCase()} ]`;
                }, 1500);
            }
        }
    }
}

function advanceMassMediaTutorial() {
    const dialog = document.getElementById('tut-dialog');
    if (dialog) dialog.classList.remove('visible');
    
    // Execute the cleanup logic if the step had one (like closing the retry menu)
    if (tutorialSteps[currentTutStep].onExit) {
        tutorialSteps[currentTutStep].onExit();
    }
    
    currentTutStep++;
    setTimeout(renderTutorialStep, 300);
}

function exitMassMediaTutorial() {
    isTutorialActive = false;
    localStorage.setItem('tutorialDone', 'true');
    if (resizeObserver) resizeObserver.disconnect();
    
    const overlay = document.getElementById('tut-overlay-master');
    if (overlay) {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 600); 
    }
    // Clean up any remaining tutorial visuals
    document.body.classList.remove('retry-mode');
}

setTimeout(initMassMediaTutorial, 2000);