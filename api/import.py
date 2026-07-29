"""
Dania DJ — conversion endpoint, running as a Vercel Python serverless function.

POST /api/import   { "url": "https://..." }
  200 -> audio bytes, headers X-Title / X-Filename / X-Duration
  4xx -> { "error": "readable reason" }

Same origin as the app, so there is no CORS step and nothing for the user to
configure. Two Vercel limits shape the design:

  * No ffmpeg on the runtime, so we never transcode. We hand back the original
    audio stream (.m4a / .webm); browsers decode both natively and Dania DJ
    re-encodes to MP3 at export time, so the final mix is unaffected.
  * A serverless response body is capped (~4.5 MB), so we pick the best audio
    format that fits under that ceiling rather than blindly taking bestaudio.
"""

from http.server import BaseHTTPRequestHandler
import json
import os
import glob
import tempfile
from urllib.parse import urlparse, quote

MAX_BYTES = int(os.environ.get("MAX_BYTES", 4_200_000))   # stay under Vercel's response cap
MAX_MINUTES = int(os.environ.get("MAX_MINUTES", 20))

MIME = {
    "m4a": "audio/mp4", "mp4": "audio/mp4", "webm": "audio/webm",
    "opus": "audio/ogg", "ogg": "audio/ogg", "mp3": "audio/mpeg",
    "aac": "audio/aac", "wav": "audio/wav",
}

BLOCKED_HOST_PREFIXES = ("127.", "10.", "192.168.", "169.254.", "0.")


def check_url(raw):
    if not raw:
        raise ValueError("No link was provided.")
    u = urlparse(raw)
    if u.scheme not in ("http", "https"):
        raise ValueError("Only http and https links are supported.")
    host = (u.hostname or "").lower()
    if (not host or host in ("localhost", "::1")
            or host.endswith(".local") or host.endswith(".internal")
            or host.startswith(BLOCKED_HOST_PREFIXES)):
        raise ValueError("That host is not allowed.")
    return raw


def safe_name(s):
    out = "".join("_" if c in '\\/:*?"<>|\r\n' else c for c in (s or "")).strip()
    return (out[:120] or "Imported track")


def friendly(err):
    m = str(err)
    low = m.lower()
    if "sign in to confirm" in low or "not a bot" in low:
        return ("YouTube is blocking this server as a bot. That is YouTube refusing "
                "datacenter traffic, not a fault in the app — run import-service/ on a "
                "home machine instead, or convert the track manually and upload it.")
    if "private video" in low or "age" in low:
        return "That video is private or age-restricted."
    if "unavailable" in low or "removed" in low:
        return "That video is unavailable."
    if "timed out" in low or "timeout" in low:
        return "The download timed out. Try a shorter track."
    return "Could not fetch that link. Check it is correct and public."


# YouTube's bot detection mainly targets its "web" player client. The mobile and
# TV clients are sometimes still served to datacenter IPs, so try them in turn
# before giving up. Free, and it costs one extra request per failed client.
PLAYER_CLIENTS = ["tv", "ios", "android", "mweb", "web"]


def _client_opts(client):
    return {"extractor_args": {"youtube": {"player_client": [client]}}} if client else {}


def fetch(url):
    import yt_dlp

    with tempfile.TemporaryDirectory() as tmp:
        # Read metadata first so we can reject a very long track cheaply.
        # Whichever client succeeds here is the one we download with.
        info = None
        working_client = None
        last_err = None
        for client in PLAYER_CLIENTS:
            probe_opts = {"quiet": True, "no_warnings": True, "noplaylist": True,
                          "skip_download": True, "socket_timeout": 15}
            probe_opts.update(_client_opts(client))
            try:
                with yt_dlp.YoutubeDL(probe_opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                working_client = client
                break
            except Exception as e:      # noqa: BLE001 - try the next client
                last_err = e
        if info is None:
            raise last_err or ValueError("Could not read that link.")

        title = safe_name(info.get("title"))
        duration = int(info.get("duration") or 0)
        if duration and duration > MAX_MINUTES * 60:
            raise ValueError(
                f"That track is {round(duration / 60)} min; this endpoint is capped at {MAX_MINUTES} min."
            )

        # Best audio that still fits inside the serverless response limit.
        fmt = (
            f"bestaudio[filesize<{MAX_BYTES}]"
            f"/bestaudio[filesize_approx<{MAX_BYTES}]"
            f"/worstaudio/bestaudio"
        )
        opts = {
            "quiet": True, "no_warnings": True, "noplaylist": True,
            "format": fmt,
            "outtmpl": os.path.join(tmp, "audio.%(ext)s"),
            "socket_timeout": 20,
            "retries": 3,
        }
        opts.update(_client_opts(working_client))
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])

        files = [f for f in glob.glob(os.path.join(tmp, "audio.*"))]
        if not files:
            raise ValueError("The download produced no audio file.")
        path = files[0]
        ext = os.path.splitext(path)[1].lstrip(".").lower()
        with open(path, "rb") as fh:
            data = fh.read()

    if len(data) > MAX_BYTES:
        mb = round(len(data) / 1_000_000, 1)
        raise ValueError(
            f"That track came to {mb} MB, over the {round(MAX_BYTES / 1_000_000, 1)} MB "
            "limit for a serverless response. Deploy import-service/ (no size limit) "
            "or convert it manually and upload the file."
        )
    return data, title, ext, duration


class handler(BaseHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json(200, {"ok": True, "mp3": False, "note": "POST {url} here to convert"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 8192:
                raise ValueError("Bad request body.")
            payload = json.loads(self.rfile.read(length) or b"{}")
            url = check_url(str(payload.get("url", "")).strip())
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception:
            return self._json(400, {"error": "Bad request body."})

        try:
            data, title, ext, duration = fetch(url)
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            return self._json(400, {"error": friendly(e)})

        filename = f"{title}.{ext}"
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Title", quote(title))
        self.send_header("X-Filename", quote(filename))
        if duration:
            self.send_header("X-Duration", str(duration))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)
