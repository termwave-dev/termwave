const express = require('express');
const { spawn } = require('node:child_process');
const path = require('node:path');
const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
app.use(express.static(path.join(__dirname, 'public')));

function runYtDlp(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('yt-dlp timed out.')); }, timeout);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => { clearTimeout(timer); reject(new Error(`Could not start yt-dlp: ${err.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim().split('\n').slice(-2).join(' ') || `yt-dlp exited with code ${code}`));
      else resolve(stdout.trim());
    });
  });
}

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Enter a search query.' });
  if (q.length > 180) return res.status(400).json({ error: 'Search query is too long.' });
  try {
    const raw = await runYtDlp(['--dump-json','--flat-playlist','--no-warnings','--playlist-end','12',`ytsearch12:${q}`], 45000);
    const results = raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
      .map(v => ({ id: v.id, title: v.title || 'Untitled', channel: v.channel || v.uploader || 'Unknown channel', duration: v.duration || 0, url: v.webpage_url || `https://www.youtube.com/watch?v=${v.id}`, thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` }))
      .filter(v => v.id && v.url);
    res.json({ results });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Resolve a fresh YouTube URL, then proxy the media through this server.
// This avoids handing an expiring googlevideo URL to the browser and keeps
// playback same-origin, which also lets the Web Audio visualizer analyze it.
function isYouTubeUrl(value) {
  try {
    const u = new URL(value);
    return ['youtube.com','www.youtube.com','m.youtube.com','youtu.be','music.youtube.com'].includes(u.hostname);
  } catch { return false; }
}

app.get('/api/stream', async (req, res) => {
  const url = String(req.query.url || '');
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only valid YouTube URLs are supported.' });
  res.json({ url: `/api/audio?url=${encodeURIComponent(url)}` });
});

app.get('/api/audio', async (req, res) => {
  const url = String(req.query.url || '');
  if (!isYouTubeUrl(url)) return res.status(400).send('Only valid YouTube URLs are supported.');
  try {
    const direct = await runYtDlp(['--no-warnings','--no-playlist','-f','bestaudio/best','-g',url], 30000);
    const streamUrl = direct.split('\n')[0].trim();
    if (!streamUrl.startsWith('https://')) throw new Error('yt-dlp did not return a secure audio URL.');
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(streamUrl, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).send(`YouTube media server returned HTTP ${upstream.status}.`);
    }
    res.status(upstream.status);
    for (const h of ['content-type','content-length','content-range','accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!upstream.body) return res.status(502).end('Empty media response.');
    const { Readable } = require('node:stream');
    const body = Readable.fromWeb(upstream.body);
    req.on('close', () => { if (!res.writableEnded) body.destroy(); });
    body.on('error', err => { if (!res.headersSent) res.status(502); res.end(); console.error('Audio proxy:', err.message); });
    body.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).send(`Audio proxy failed: ${e.message}`);
    else res.end();
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ytDlp: YTDLP }));
app.listen(PORT, '0.0.0.0', () => console.log(`TermWave running at http://localhost:${PORT}`));
