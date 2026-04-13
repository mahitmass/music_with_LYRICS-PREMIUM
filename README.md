# 🎵 Pro Media Player

> A premium, lightweight desktop music player designed for high-quality local listening with **AI-Powered Synced Lyrics** and **Immersive Visuals**.

## 🌟 Overview

Most modern players are either too heavy, hide synced lyrics behind a subscription, or completely fail when a song isn't in their database. This player focuses on:

* **Privacy & Speed:** It plays your local `.mp3` files without tracking your data.
* **Smart Syncing:** Fetches perfect lyrics from the LRCLIB database, and uses Local AI to automatically sync plain text when timed lyrics don't exist.
* **Immersive Vibe:** A dedicated full-screen mode that blurs your album art for a cinematic background, complete with auto-fading UI for a distraction-free experience.

---

## 🚀 How to Run

### Option 1: Standalone Installer (Recommended)
If you just want to listen to music:
1. Navigate to the **`dist/`** (or GitHub Releases) folder.
2. Download **`music-player Setup 1.1.0.exe`**.
3. Run the installer to add the player to your Start Menu and Desktop.

### Option 2: Run from Source (For Developers)
To modify the code or run via terminal:

**1. Clone the repository:**
```bash
git clone [https://github.com/mahitmass/music_with_LYRICS.git](https://github.com/mahitmass/music_with_LYRICS.git)
cd music_with_LYRICS
```
**2. Install Dependencies:**
```bash
npm install
```
**3. Launch the App:**
```bash
npm start
```
##✨ AI & Smart Sync Features
Background AI Queue: Queue up multiple plain-text songs for AI synchronization. The app processes them sequentially in the background without freezing your music.

"Rubber Band" Interpolation: Custom AI logic that anchors known words and mathematically stretches the timestamps in between, making it impossible for fast songs (like rap or remixes) to drift out of sync.

Smart Duration Sorting: When searching for alternative lyrics, the app automatically compares the length of your local audio file to the database and pushes the most accurate match to the absolute top.

Fallback Generator: If the database is completely empty, you can force the AI to transcribe and time the lyrics entirely from scratch directly from the Retry menu.

##🎧 Key Player Features
Cinematic Idle Fade: If the app is left running in the background for 10 minutes, the player controls gracefully fade out to provide a gorgeous, distraction-free "Screenshot Mode."

Precision Auto-Scroller: The queue automatically and silently snaps the currently playing song to the dead center of your screen, whether you are in the sidebar or Immersive mode.

Advanced Manual Sync: Dial in your lyric timing perfectly. Hold down the + / - buttons to scroll the time, or click the number to manually type an exact offset (e.g., -2.5s).

Smart Drag & Drop: Drag files from Windows Explorer directly into the queue to insert them at specific positions.

Interactive Lyrics: Click any line in the lyrics view to jump the song instantly to that timestamp.

Persistent Memory: Remembers your queue, your last played track, and your custom sync offsets for every individual song, even after closing the app.

##🛠 Technical Stack
Framework: Electron.js (Node.js & Chromium)

Frontend: Vanilla JavaScript, HTML5, CSS3

Audio: HTML5 Audio API & Web Audio API (for AI buffer decoding)

Metadata: music-metadata (Extracts embedded Album Art & Tags)

Lyrics API: LRCLIB (Open-source lyrics database)
