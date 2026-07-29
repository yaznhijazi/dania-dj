/**
 * Dania DJ — conversion service
 *
 * POST /import  { "url": "https://..." }  ->  200, body = MP3, header X-Title
 *
 * The browser is not allowed to fetch audio from video sites directly, so this
 * tiny service does the fetch + transcode and hands back a plain MP3 file.
 * It is the only server-side piece of Dania DJ; everything else is static.
 *
 * Requires `yt-dlp` and `ffmpeg` on PATH (the Dockerfile installs both).
 */
import express from 'express';
import cors from 'cors';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);
const app = express();

const PORT          = process.env.PORT || 8080;
const BITRATE       = process.env.AUDIO_BITRATE || '320';
const MAX_MINUTES   = Number(process.env.MAX_MINUTES || 20);
const TIMEOUT_MS    = Number(process.env.TIMEOUT_MS || 8 * 60 * 1000);
const MAX_BYTES     = Number(process.env.MAX_BYTES || 120 * 1024 * 1024);
// Comma-separated list of origins allowed to call this service.
// Set ALLOWED_ORIGINS to your Vercel URL in production. Default is permissive
// for local testing only.
const ALLOWED = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());

app.use(express.json({ limit: '8kb' }));
app.use(cors({
  origin: ALLOWED.includes('*') ? true : ALLOWED,
  exposedHeaders: ['X-Title', 'X-Duration'],   // the browser can't read these otherwise
}));

/* Only http(s), and never an address inside our own network. */
function assertSafeUrl(raw){
  let u;
  try { u = new URL(raw); } catch { throw new Error('That does not look like a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https links are supported.');
  const h = u.hostname.toLowerCase();
  const blocked =
    h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal') ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h);
  if (blocked) throw new Error('That host is not allowed.');
  return u.toString();
}

const safeName = (s) => (s || 'Imported track').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 120) || 'Imported track';

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/import', async (req, res) => {
  let dir;
  try {
    const url = assertSafeUrl(String(req.body?.url || ''));

    // 1. Metadata first, so we can reject something absurdly long before downloading it.
    let meta;
    try {
      const { stdout } = await execFileP('yt-dlp', ['--no-playlist', '--dump-single-json', url],
        { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
      meta = JSON.parse(stdout);
    } catch (e){
      const msg = String(e.stderr || e.message);
      if (/Private video|Sign in|age|confirm your age/i.test(msg)) throw new Error('That video is private or age-restricted.');
      if (/Video unavailable|not available/i.test(msg)) throw new Error('That video is unavailable.');
      throw new Error('Could not read that link. Check the URL is correct and public.');
    }

    const title = safeName(meta.title);
    const seconds = Number(meta.duration || 0);
    if (seconds && seconds > MAX_MINUTES * 60){
      return res.status(413).json({ error: `That track is ${Math.round(seconds / 60)} min; this service is capped at ${MAX_MINUTES} min.` });
    }

    // 2. Download bestaudio and transcode to MP3.
    dir = await mkdtemp(path.join(tmpdir(), 'daniadj-'));
    await execFileP('yt-dlp', [
      '--no-playlist',
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3',
      '--audio-quality', BITRATE + 'K',
      '--no-progress', '--no-warnings',
      '-o', path.join(dir, 'audio.%(ext)s'),
      url,
    ], { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });

    const files = await readdir(dir);
    const mp3 = files.find((f) => f.endsWith('.mp3'));
    if (!mp3) throw new Error('Conversion produced no audio file.');

    const buf = await readFile(path.join(dir, mp3));
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'Converted file is too large.' });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('X-Title', encodeURIComponent(title).replace(/%20/g, ' '));
    if (seconds) res.setHeader('X-Duration', String(Math.round(seconds)));
    res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/"/g, '')}.mp3"`);
    res.end(buf);
  } catch (err){
    const msg = err?.killed || /timeout/i.test(String(err?.message))
      ? 'Conversion timed out — the track may be too long.'
      : (err?.message || 'Conversion failed.');
    res.status(400).json({ error: msg });
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`Dania DJ conversion service listening on :${PORT}`));
