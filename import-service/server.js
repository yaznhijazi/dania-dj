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
  exposedHeaders: ['X-Title', 'X-Filename', 'X-Duration'],   // the browser can't read these otherwise
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

/* FFmpeg is OPTIONAL. With it, you get an MP3. Without it, you get the original
   audio stream (usually .m4a), which every browser decodes natively — and Dania DJ
   re-encodes to MP3 at export time regardless, so the final mix is unaffected.
   Managed/corporate machines often block ffmpeg, which is why this fallback exists. */
let FFMPEG = null;
async function hasFfmpeg(){
  if (FFMPEG !== null) return FFMPEG;
  try { await execFileP('ffmpeg', ['-version'], { timeout: 10_000 }); FFMPEG = true; }
  catch { FFMPEG = false; console.warn('[dania] ffmpeg unavailable — serving original audio streams instead of MP3'); }
  return FFMPEG;
}
const MIME = { mp3:'audio/mpeg', m4a:'audio/mp4', mp4:'audio/mp4', webm:'audio/webm',
               opus:'audio/ogg', ogg:'audio/ogg', wav:'audio/wav', aac:'audio/aac' };

app.get('/health', async (_req, res) => res.json({ ok: true, mp3: await hasFfmpeg() }));

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

    // 2. Download the audio, transcoding to MP3 only if ffmpeg is actually usable.
    const canTranscode = await hasFfmpeg();
    dir = await mkdtemp(path.join(tmpdir(), 'daniadj-'));
    const args = ['--no-playlist', '-f', 'bestaudio/best'];
    if (canTranscode) args.push('-x', '--audio-format', 'mp3', '--audio-quality', BITRATE + 'K');
    args.push('--no-progress', '--no-warnings', '-o', path.join(dir, 'audio.%(ext)s'), url);
    await execFileP('yt-dlp', args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });

    const files = await readdir(dir);
    const picked = files.find((f) => f.endsWith('.mp3')) || files.find((f) => /\.(m4a|webm|opus|ogg|aac|mp4|wav)$/i.test(f));
    if (!picked) throw new Error('Download produced no audio file.');

    const ext = picked.split('.').pop().toLowerCase();
    const buf = await readFile(path.join(dir, picked));
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'Converted file is too large.' });

    const filename = `${title.replace(/"/g, '')}.${ext}`;
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('X-Title', encodeURIComponent(title).replace(/%20/g, ' '));
    res.setHeader('X-Filename', encodeURIComponent(filename).replace(/%20/g, ' '));
    if (seconds) res.setHeader('X-Duration', String(Math.round(seconds)));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
