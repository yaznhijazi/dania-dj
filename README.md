# Dania DJ

Wedding playlist builder. Upload audio, trim it, arrange it, and export **one continuous
MP3/WAV** with real crossfades between every track.

Everything runs in the browser — decoding, EQ, normalisation, fades, the mixdown and the
MP3 encode. There is no backend and no database.

## Deploy to Vercel

The whole app is one static file (`public/index.html`). No build step.

```bash
npx vercel deploy --prod
```

Or from the dashboard: **New Project → import the repo → Framework Preset: `Other` →
Output Directory: `public`** → Deploy.

To preview locally:

```bash
npm run dev
```

## Where the data lives

No database. Two browser-local stores, both survive refresh, closing the tab, and
coming back days later on the same browser + same domain:

| What | Where | Notes |
| --- | --- | --- |
| Playlists, trims, cuts, fades, EQ, crossfades, export format, last screen | `localStorage` key `dania-dj.v1` | Small JSON. Also records which playlist/screen you were on, so a refresh puts you back. |
| Uploaded audio files (original encoded bytes) | IndexedDB `dania-dj` → store `audio` | One record per file, keyed by `srcId` on the song. |

On first load the app calls `navigator.storage.persist()` so the browser is asked not to
evict the audio under storage pressure. Current usage is shown on the dashboard.

Caveats worth knowing, since this is deliberately serverless:

- Data is **per browser and per domain**. Your laptop's Chrome and your phone won't share
  playlists, and `localhost` won't share with the Vercel domain.
- Private/incognito windows are cleared on close.
- "Clear browsing data" wipes it. There is no cloud copy to restore from.
- Deleting a playlist also deletes its audio from IndexedDB.

## Features

- **Import** — drag & drop or browse for MP3/WAV/M4A/FLAC/OGG. Waveform peaks are computed
  from the real decoded audio.
- **Trim** — drag the two handles on the waveform.
- **Cut a middle section** — drag across the waveform to select, then *Remove selection*.
  Joins are butt-spliced with a 6 ms fade so there is no click.
- **Split** — *Split here* breaks a track in two at the selection point; both halves are
  ordinary playlist items you can reorder independently.
- **Arrange** — drag rows to reorder, duplicate, remove.
- **Per-track audio** — volume, fade in, fade out, normalise (peak-matched to ~0.89), and
  EQ presets (Warm / Bright / Bass Boost / Vocal Lift) applied with real biquad filters.
- **Crossfades** — 0–10 s per junction, with Linear / Smooth (equal-power) / Sharp curves.
  A crossfade is automatically capped at 90% of the shorter neighbour.
- **Preview** — single track, a single transition, or the entire mix played live with the
  real crossfades scheduled on the Web Audio API (decodes ahead of the playhead).
- **Export** — MP3 320 / MP3 192 / WAV 16-bit 44.1 kHz. Rendered in 20-second windows and
  streamed into the encoder, so a 40-minute mix does not blow up memory.

### The demo playlists

Two example playlists ship with the app. Their tracks are **synthesised tones**, not real
recordings — they exist so every feature (preview, crossfade, export) is exercisable before
you upload anything. They are marked `demo tone` in the song list. Delete them whenever.

## The one feature that needs a server

YouTube import cannot work from the browser: cross-origin rules block it and there is no
client-side extraction path. The *From URL* tab therefore takes an **import endpoint** you
host yourself:

```
POST <your endpoint>
Content-Type: application/json
{ "url": "https://..." }

→ 200, body = an audio file (any format the browser can decode)
→ optional response header  X-Title: Track name
```

Give it a URL and the rest of the app treats the result exactly like an uploaded file.
Note that whatever you point it at is your responsibility with respect to the source
site's terms of service and the rights in the audio.

## Browser support

Needs Web Audio + IndexedDB: current Chrome, Edge, Firefox, Safari. Safari is stricter
about audio contexts — the first click anywhere unlocks playback. The MP3 encoder
(`lamejs`) is fetched from a CDN the first time you export MP3; WAV export needs no
network at all.
