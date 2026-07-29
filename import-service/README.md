# Dania DJ — conversion service

Turns a video link into an MP3 so the app can hand you the file.

```
POST /import   { "url": "https://..." }
  200 → body is the MP3, header  X-Title: Track name
  4xx → { "error": "human readable reason" }
GET  /health   → { ok: true }
```

## Why this exists

A browser cannot fetch audio from YouTube. Not a bug in the app and not something
a different host fixes — the site does not serve its media cross-origin, so the
browser refuses. The conversion has to happen somewhere with a real network stack,
which is this service.

**It cannot run on Vercel.** It needs `yt-dlp` (Python) plus FFmpeg on disk and often
more than a minute per track — past Vercel's function bundle size and execution limits.
Use a container host.

## Run it locally

Needs `yt-dlp` and `ffmpeg` on PATH.

```bash
npm install && npm start
```

Then in Dania DJ → **Add Songs → From URL**, set the service URL to
`http://localhost:8080/import`.

## Deploy (Railway, Fly.io, Render, any VPS)

There is a Dockerfile, so most hosts need no configuration beyond pointing at this folder.

```bash
docker build -t dania-import . && docker run -p 8080:8080 dania-import
```

Set `ALLOWED_ORIGINS` to your Vercel URL so the service isn't open to the whole web:

```
ALLOWED_ORIGINS=https://your-app.vercel.app
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to call it. **Set this in production.** |
| `AUDIO_BITRATE` | `320` | MP3 bitrate (kbps) |
| `MAX_MINUTES` | `20` | Reject tracks longer than this |
| `TIMEOUT_MS` | `480000` | Give up on a conversion after this long |
| `MAX_BYTES` | `125829120` | Reject converted files larger than this |

## What it guards against

- Only `http`/`https` links.
- Refuses localhost, `10.x`, `192.168.x`, `172.16–31.x`, `169.254.x` and `.local`/`.internal`
  hosts, so the service can't be used to probe your private network.
- Length checked from metadata *before* downloading; hard timeout; response size cap.
- Temp directory always removed, including on failure.
- Errors are returned as readable sentences the app shows directly.

Keep `yt-dlp` updated (`wget` the latest release, or rebuild the image) — extraction
breaks whenever the source site changes.

## If YouTube says "Sign in to confirm you're not a bot"

That is YouTube refusing traffic from datacenter IP ranges. It is not a bug, and no
Python library gets around it — `yt-dlp`, `pytube` and the rest all leave from the same
address. What matters is where the request comes from, not what sends it.

Three ways out, honestly ranked:

1. **Run this service on a home machine.** A residential IP is not blocked, so nothing
   special is needed. Free, and by far the most reliable.
2. **Authenticate with cookies.** Export your YouTube cookies in Netscape format (a
   browser extension such as "Get cookies.txt" produces this) and set them as
   `YT_COOKIES` — here, or in the Vercel dashboard for `api/import.py`. Both read the
   same variable. Know the trade-off first: those cookies are a live session for your
   Google account, anyone who can read that variable can act as you on YouTube,
   automated traffic on an account is exactly what YouTube suspends people for, and
   they expire every few weeks and must be re-exported. Use a throwaway account, never
   your main one.
3. **A residential proxy.** Works, costs money every month.

There is no fourth option that makes a datacenter IP look residential for free.

## Before you deploy this

Downloading audio from YouTube is against YouTube's Terms of Service, and the recordings
themselves are copyrighted. Playing music at a wedding reception is a public performance,
which is normally covered by the venue's PRO licence (ASCAP/BMI/PRS/SOCAN or your local
equivalent) — worth confirming with the venue. Buying the tracks, or pulling them from a
service you already licence, avoids both issues entirely. Your call; the app works the
same either way, and the Upload audio tab accepts files from any source.
