
const express = require('express');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || '';
const AUDIO_TIMEOUT = Number(process.env.YTDLP_AUDIO_TIMEOUT) || 60000;

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
    let child;

    try {
      child = spawn(YTDLP, ytDlpArgs(args), {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(new Error(`Could not start yt-dlp: ${error.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`yt-dlp timed out after ${timeout} ms.`));
    }, timeout);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error) reject(error);
      else resolve(result);
    }

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
        console.error('yt-dlp failed with exit code:', code);
        console.error('yt-dlp stderr:', stderr.slice(-12000));

        const message = stderr.trim().split('\n').slice(-5).join(' ');
        finish(new Error(message || `yt-dlp exited with code ${code}`));
        return;
      }

      const providerLines = stderr
      .split('\n')
      .filter(line =>
      /PO Token Providers|Generating a .*PO Token|bgutil|pot provider|plugin directories/i.test(line)
      );

      if (providerLines.length) {
        console.log(
          'yt-dlp provider diagnostics:',
          providerLines.join('\n')
        );
      }

      finish(null, stdout.trim());
    });
  });
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    return (
      [
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtu.be'
      ].includes(host) &&
      ['https:', 'http:'].includes(url.protocol)
    );
  } catch {
    return false;
  }
}

function getFriendlyError(error) {
  const message = String(error?.message || error);

  if (
    /sign in to confirm|not a bot|confirm you're not a bot|automated queries|LOGIN_REQUIRED/i.test(
      message
    )
  ) {
    return 'YouTube is blocking requests from this server as automated traffic. Check the server logs for PO Token diagnostics. A valid cookies file may also be required.';
  }

  if (/timed out/i.test(message)) {
    return 'The YouTube request timed out. Try again in a moment.';
  }

  return message.slice(-1200);
}

function getYouTubeUrl(req) {
  const url = String(req.query.url || '');
  return isYouTubeUrl(url) ? url : null;
}

// Search YouTube.
app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({
      error: 'Enter a search query.'
    });
  }

  if (query.length > 180) {
    return res.status(400).json({
      error: 'Search query is too long.'
    });
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
  const url = getYouTubeUrl(req);

  if (!url) {
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
  const url = getYouTubeUrl(req);

  if (!url) {
    return res.status(400).send(
      'Only valid YouTube URLs are supported.'
    );
  }

  let direct;

  try {
    direct = await runYtDlp([
      '--verbose',

      // Explicitly enable the Node.js JavaScript runtime.
      '--js-runtimes', 'node',

      // Try player clients that may avoid the failing default path.
      '--extractor-args',
      'youtube:player-client=mweb,tv,web_safari',

      '--no-playlist',
      '-f', 'bestaudio/best',
      '-g',
      url
    ], AUDIO_TIMEOUT);
  } catch (error) {
    console.error('Audio extraction failed:', error.message);

    if (!res.headersSent && !res.destroyed) {
      return res.status(502).send(
        `Audio proxy failed: ${getFriendlyError(error)}`
      );
    }

    return;
  }

  if (!direct) {
    console.error('yt-dlp returned an empty media URL.');

    return res.status(502).send(
      'Audio proxy failed: yt-dlp returned an empty media URL.'
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

    // Forward browser seeking/range requests to the media server.
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(mediaUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(45000)
    });

    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.body?.cancel().catch(() => {});

      console.error(
        'Upstream media server returned HTTP',
        upstream.status
      );

      return res.status(502).send(
        `YouTube media server returned HTTP ${upstream.status}.`
      );
    }

    res.status(upstream.status);

    for (const header of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges'
    ]) {
      const value = upstream.headers.get(header);

      if (value) {
        res.setHeader(header, value);
      }
    }

    res.setHeader('Cache-Control', 'no-store');

    if (upstream.status === 416 || !upstream.body) {
      await upstream.body?.cancel().catch(() => {});
      return res.end();
    }

    const body = Readable.fromWeb(upstream.body);

    req.on('aborted', () => body.destroy());

    res.on('close', () => {
      if (!res.writableEnded) {
        body.destroy();
      }
    });

    body.on('error', error => {
      console.error('Audio stream failed:', error.message);

      if (!res.headersSent) {
        res.status(502).end('Audio stream failed.');
      } else if (!res.destroyed) {
        res.destroy(error);
      }
    });

    body.pipe(res);
  } catch (error) {
    console.error('Audio proxy failed:', error.message);

    if (!res.headersSent && !res.destroyed) {
      return res.status(502).send(
        `Audio proxy failed: ${getFriendlyError(error)}`
      );
    }

    if (!res.writableEnded && !res.destroyed) {
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
  console.log(`yt-dlp executable: ${YTDLP}`);
  console.log(`Cookies configured: ${Boolean(COOKIES_FILE)}`);
});
