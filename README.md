# TermWave

A terminal-inspired YouTube audio player with YouTube search, a playback queue, cover art, play/pause, seek, volume, shuffle, repeat modes, a Web Audio visualizer, light/dark themes, and customizable accent colors.

## Requirements

- Node.js 18 or newer
- Python 3 and `yt-dlp` installed and available on `PATH`
- A modern browser

Install yt-dlp using your preferred package manager, or `python -m pip install -U yt-dlp`. YouTube frequently changes its delivery mechanisms, so keep yt-dlp updated if playback stops working.

## Run locally

```bash
npm install
npm start
```

Open <http://localhost:3000>.

If yt-dlp is installed somewhere not on `PATH`, set `YTDLP_PATH` to its executable path before starting the server. Example on Linux:

```bash
YTDLP_PATH=/home/user/.local/bin/yt-dlp npm start
```

## Deploy / GitHub

Push this folder to a repository. The repository is a Node app, not a static-only site: GitHub Pages cannot run the Express API or yt-dlp. Deploy to a host that supports Node.js and allows yt-dlp subprocesses. Install dependencies with `npm install` and start with `npm start`.

## Notes

- Search and stream resolution run on the server through yt-dlp; the browser never executes yt-dlp itself.
- Direct YouTube media URLs expire, so the app resolves a fresh URL each time a track starts.
- The visualizer uses the Web Audio API. Some browsers or media CDN responses may restrict audio analysis through cross-origin rules; in that case the UI falls back to an animated idle visualization.
- This is an unofficial personal-use client, not affiliated with YouTube. Respect applicable terms, copyright, and local law.
