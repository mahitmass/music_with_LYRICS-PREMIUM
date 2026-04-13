🎵 Mass Media Player Pro
A lightning-fast, high-fidelity desktop music player built with Electron and Node.js. Designed for uninterrupted listening, it bypasses heavy scraping where possible for instant playback and features a custom-built immersive lyrics engine.

✨ Core Features
⚡ Instant Audio Engine: Global search is routed directly through the JioSaavn API to fetch .mp4 and .m4a audio streams instantly, completely bypassing slow YouTube audio-resolution steps for single tracks.

♾️ Invincible Playlist Scraper: Paste any YouTube Music playlist link directly into the search bar. A custom recursive token-hunter scrapes the entire playlist and loads it into your queue.

🔀 Dual-Queue Architecture: Manage your music with two independent queues. Keep your everyday Main Queue safe while loading massive albums into the Playlist Queue, toggling between them seamlessly.

🎤 Immersive Lyrics Engine: * Automatically fetches and syncs .lrc files.

AI Auto-Stretch: Automatically interpolates and stretches plain-text lyrics to match a song's exact duration if timed lyrics aren't found.

Manual Override: Alternative lyrics menu to swap out bad database pulls, or block incorrect lyrics entirely.

🖱️ Pro Context Menu: A custom-built right-click menu natively injected into the DOM. Instantly Play Next, Add to Bottom, or save tracks to your Local Favorites without interrupting the music.

🎮 Interactive Live Tutorial: A 20-step, fully interactive onboarding engine that safely simulates app features (like dropping the volume to 5% and auto-searching) to show new users the ropes.

🛠️ Tech Stack
Framework: Electron.js

Backend/Logic: Node.js, custom Vanilla JavaScript engines

Audio Handling: HTML5 Audio API with custom buffering & failsafes

APIs: JioSaavn API (Primary Search/Stream), Piped/Cobalt (Failovers), LRCLIB (Lyrics)

🚀 Installation & Setup
Clone the repository:

Bash
git clone https://github.com/YOUR-USERNAME/mass-media-player.git
Navigate to the directory:

Bash
cd mass-media-player
Install dependencies:

Bash
npm install
Start the application:

Bash
npm start
⌨️ Global Shortcuts
The player is designed to be controlled without taking your hands off the keyboard:

Space - Play / Pause

Arrow Up / Down - Volume Control (5% increments)

Arrow Left / Right - Seek (10s jumps)

S - Focus Global Search

M - Toggle Immersive Lyrics View

Z - Shuffle Remaining Queue

T - Toggle Lyrics Engine (Saves CPU)

Esc - Clear search and close menus

🤝 Contributing
Pull requests are welcome! If you find a bug or want to suggest a new feature, feel free to open an issue.
