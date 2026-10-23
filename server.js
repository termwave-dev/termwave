
const express = require('express');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

// Optional: configure this as a private Render environment variable.
// Never commit your cookies file to GitHub.
const COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || '';

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

function ytDlpArgs(args) {
  const result = [];

  if (COOKIES_FILE) {
    result.push('--cookies', COOKIES_FILE);
  }

  return [...result, ...args];
}

function runYtDlp(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, ytDlpArgs(args), {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error) reject(error);
      else resolve(result);
    };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('yt-dlp timed out.'));
      }, timeout);

      child.stdout.on('data', data => {
        stdout += data.toString();
      });

      child.stderr.on('data', data => {
        stderr += data.toString();
      });

      child.on('error', error => {
        finish(new Error(`Could not start yt-dlp: ${error.message}`));
      });

      child.on('close', code => {
        if (code !== 0) {
          const message = stderr.trim().split('\n').slice(-3).join(' ');
          finish(new Error(message || `yt-dlp exited with code ${code}`));
        } else {
          finish(null, stdout.trim());
        }
      });
  });
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    return (
      ['youtube.com', 'www.youtube.com', 'm.youtube.com',
      'music.youtube.com', 'youtu.be'].includes(host) &&
      (url.protocol === 'https:' || url.protocol === 'http:')
    );
  } catch {
    return false;
  }
}

function getFriendlyError(error) {
  const message = String(error?.message || error);

  if (/sign in to confirm|not a bot|confirm you're not a bot/i.test(message)) {
    return 'YouTube is blocking requests from this server as automated traffic. Alternate player clients may not fix this. Configure a valid cookies file or a supported PO Token provider, if appropriate.';
  }

  if (/timed out/i.test(message)) {
    return 'The YouTube request timed out. Try again in a moment.';
  }

  return message.slice(-1200);
}

// Search YouTube.
app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'Enter a search query.' });
  }

  if (query.length > 180) {
    return res.status(400).json({ error: 'Search query is too long.' });
  }

  try {
    const raw = await runYtDlp([
      '--dump-json',
      '--flat-playlist',
      '--no-warnings',
      '--playlist-end', '12',
      `ytsearch12:${query}`
    ], 60000);

    const results = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map(video => ({
      id: video.id,
      title: video.title || 'Untitled',
      channel: video.channel || video.uploader || 'Unknown channel',
      duration: video.duration || 0,
      url: video.webpage_url ||
      `https://www.youtube.com/watch?v=${video.id}`,
      thumbnail: video.thumbnail ||
      `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`
    }))
    .filter(video => video.id && video.url);

    return res.json({ results });
  } catch (error) {
    console.error('Search failed:', error.message);
    return res.status(502).json({
      error: getFriendlyError(error)
    });
  }
});

// Return the same-origin audio proxy URL.
app.get('/api/stream', (req, res) => {
  const url = String(req.query.url || '');

  if (!isYouTubeUrl(url)) {
    return res.status(400).json({
      error: 'Only valid YouTube URLs are supported.'
    });
  }

  return res.json({
    url: `/api/audio?url=${encodeURIComponent(url)}`
  });
});

// Extract an audio URL, then proxy its bytes to the browser.
app.get('/api/audio', async (req, res) => {
  const url = String(req.query.url || '');

  if (!isYouTubeUrl(url)) {
    return res.status(400).send('Only valid YouTube URLs are supported.');
  }

  // Start with yt-dlp's default clients. If extraction fails, try an
  // additional client combination. These are fallbacks, not guarantees.
  const extractionAttempts = [
    [],
    [
      '--extractor-args',
      'youtube:player_client=default,web_safari'
    ]
  ];

  let direct;
  let lastError;

  for (const extraArgs of extractionAttempts) {
    try {
      direct = await runYtDlp([
        '--no-warnings',
        '--no-playlist',
        '-f', 'bestaudio/best',
        '-g',
        ...extraArgs,
        url
      ], 45000);

      if (direct) break;
      lastError = new Error('yt-dlp returned an empty media URL.');
    } catch (error) {
      lastError = error;

      // Don't keep retrying once the client disconnects.
      if (res.destroyed || res.writableEnded) return;
    }
  }

  if (!direct) {
    console.error('Audio extraction failed:', lastError?.message);

    return res.status(502).send(
      `Audio proxy failed: ${getFriendlyError(lastError)}`
    );
  }

  const streamUrl = direct.split('\n')[0].trim();

  let mediaUrl;
  try {
    mediaUrl = new URL(streamUrl);
  } catch {
    return res.status(502).send(
      'Audio proxy failed: yt-dlp returned an invalid media URL.'
    );
  }

  if (mediaUrl.protocol !== 'https:') {
    return res.status(502).send(
      'Audio proxy failed: the media URL is not HTTPS.'
    );
  }

  try {
    const headers = {};

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(mediaUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });

    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(502).send(
        `YouTube media server returned HTTP ${upstream.status}.`
      );
    }

    if (!upstream.body) {
      return res.status(502).send('Empty media response.');
    }

    res.status(upstream.status);

    for (const header of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges'
    ]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    res.setHeader('Cache-Control', 'no-store');

    const body = Readable.fromWeb(upstream.body);

    req.on('aborted', () => body.destroy());
    res.on('close', () => {
      if (!res.writableEnded) body.destroy();
    });

      body.on('error', error => {
        console.error('Audio stream failed:', error.message);

        if (!res.headersSent) {
          res.status(502).end('Audio stream failed.');
        } else {
          res.destroy(error);
        }
      });

      body.pipe(res);
  } catch (error) {
    console.error('Audio proxy failed:', error.message);

    if (!res.headersSent) {
      res.status(502).send(
        `Audio proxy failed: ${getFriendlyError(error)}`
      );
    } else if (!res.writableEnded) {
      res.destroy(error);
    }
  }
});

// Basic service health check.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ytDlp: YTDLP,
    cookiesConfigured: Boolean(COOKIES_FILE),
           cookiesFileExists: COOKIES_FILE
           ? fs.existsSync(COOKIES_FILE)
           : false
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TermWave listening on port ${PORT}`);
});
