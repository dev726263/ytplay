#!/usr/bin/env python3
import os, json, time, sqlite3, subprocess, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from typing import List, Dict, Any, Optional

from openai import OpenAI
from ytmusicapi import YTMusic

HOST = "127.0.0.1"

def expanduser(p: str) -> str:
    return os.path.expanduser(p)

def load_env_file(path: str):
    """Minimal .env loader (KEY=VALUE lines)."""
    if not path or not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            # don't override already-set env vars
            os.environ.setdefault(k, v)

# Load env from ~/.ytplay/.env by default
DEFAULT_ENV = expanduser("~/.ytplay/.env")
load_env_file(os.getenv("YTP_ENV_FILE", DEFAULT_ENV))

PORT = int(os.getenv("YTP_PORT", "17845"))
MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini")
MAX_TRACKS_DEFAULT = int(os.getenv("YTP_MAX_TRACKS", "25"))
CACHE_TTL_HOURS = int(os.getenv("YTP_CACHE_TTL_HOURS", "72"))

STATE_DIR = expanduser(os.getenv("YTP_STATE_DIR", "~/.ytplay"))
CACHE_DB = os.path.join(STATE_DIR, "cache.sqlite3")
MPV_SOCKET = os.path.join(STATE_DIR, "mpv.sock")

def ensure_state_dir():
    os.makedirs(STATE_DIR, exist_ok=True)

def db() -> sqlite3.Connection:
    ensure_state_dir()
    con = sqlite3.connect(CACHE_DB)
    con.execute("PRAGMA journal_mode=WAL;")
    con.execute("""
        CREATE TABLE IF NOT EXISTS prompt_cache (
          prompt TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          uses INTEGER NOT NULL DEFAULT 1
        );
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS votes (
          videoId TEXT PRIMARY KEY,
          title TEXT,
          artist TEXT,
          vote INTEGER NOT NULL,  -- +1 or -1
          updated_at INTEGER NOT NULL
        );
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          videoId TEXT,
          title TEXT,
          artist TEXT,
          played_at INTEGER NOT NULL
        );
    """)
    con.commit()
    return con

def load_ytmusic() -> YTMusic:
    # If headers_auth.json exists in repo root (same dir as this file), use it.
    auth = os.path.join(os.path.dirname(__file__), "..", "headers_auth.json")
    auth = os.path.abspath(auth)
    return YTMusic(auth) if os.path.exists(auth) else YTMusic()

def openai_client() -> OpenAI:
    # OPENAI_API_KEY must be in env (from ~/.ytplay/.env or environment)
    return OpenAI()

def get_votes(con: sqlite3.Connection) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for vid, vote in con.execute("SELECT videoId, vote FROM votes;").fetchall():
        out[vid] = int(vote)
    return out

def cache_get(con: sqlite3.Connection, key: str, ttl_hours: int) -> Optional[Dict[str, Any]]:
    row = con.execute(
        "SELECT payload, created_at FROM prompt_cache WHERE prompt=?;",
        (key,)
    ).fetchone()
    if not row:
        return None
    payload, created_at = row
    age = int(time.time()) - int(created_at)
    if age > ttl_hours * 3600:
        return None
    con.execute(
        "UPDATE prompt_cache SET last_used_at=?, uses=uses+1 WHERE prompt=?;",
        (int(time.time()), key)
    )
    con.commit()
    return json.loads(payload)

def cache_put(con: sqlite3.Connection, key: str, payload: Dict[str, Any]):
    now = int(time.time())
    con.execute(
        "INSERT OR REPLACE INTO prompt_cache(prompt, payload, created_at, last_used_at, uses) "
        "VALUES(?,?,?,?,COALESCE((SELECT uses FROM prompt_cache WHERE prompt=?),0)+1);",
        (key, json.dumps(payload), now, now, key)
    )
    con.commit()

def llm_curate(prompt: str, extras: Dict[str, Any]) -> Dict[str, Any]:
    """
    Returns:
      - search_queries: list[str]
      - avoid_terms: list[str]
      - notes: str
    """
    client = openai_client()

    lang = extras.get("lang")
    mood = extras.get("mood")
    seed = extras.get("seed")
    avoid = extras.get("avoid", [])
    max_queries = int(extras.get("max_queries", 10))

    # crude taste memory: avoid disliked, bias to liked
    con = db()
    votes = get_votes(con)
    disliked = [vid for vid, v in votes.items() if v < 0][:25]
    liked = [vid for vid, v in votes.items() if v > 0][:25]

    system = (
        "You are a music curator for YouTube Music. "
        "Output JSON only. Produce tight, non-noisy search queries. "
        "Prefer official audio and studio versions. Avoid remix spam unless requested."
    )

    user = {
        "prompt": prompt,
        "preferences": {"lang": lang, "mood": mood, "seed": seed, "avoid_terms": avoid},
        "signals": {"disliked_videoIds": disliked, "liked_videoIds": liked},
        "instruction": f"Return encourages coherence. Provide {max_queries} search queries.",
    }

    schema = {
        "type": "object",
        "properties": {
            "search_queries": {"type": "array", "items": {"type": "string"}},
            "avoid_terms": {"type": "array", "items": {"type": "string"}},
            "notes": {"type": "string"},
        },
        "required": ["search_queries", "avoid_terms", "notes"],
        "additionalProperties": False,
    }

    resp = client.responses.create(
        model=MODEL,
        input=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user)}
        ],
        text_format={"type": "json_schema", "name": "curation", "schema": schema, "strict": True},
    )
    return json.loads(resp.output_text)

def pick_tracks(yt: YTMusic, queries: List[str], max_tracks: int, extras: Dict[str, Any]) -> List[Dict[str, str]]:
    con = db()
    votes = get_votes(con)
    seen = set()
    out: List[Dict[str, str]] = []

    seed = extras.get("seed")
    if seed:
        try:
            seed_results = yt.search(seed, filter="songs")
        except Exception:
            seed_results = yt.search(seed)
        for r in seed_results[:5]:
            vid = r.get("videoId")
            if vid and vid not in seen and votes.get(vid, 0) >= 0:
                out.append({
                    "title": r.get("title", "Unknown"),
                    "artist": (r.get("artists") or [{"name": "Unknown"}])[0]["name"],
                    "videoId": vid
                })
                seen.add(vid)
                break

    for q in queries:
        try:
            results = yt.search(q, filter="songs")
        except Exception:
            results = yt.search(q)
        for r in results[:8]:
            vid = r.get("videoId")
            if not vid or vid in seen:
                continue
            if votes.get(vid, 0) < 0:
                continue
            out.append({
                "title": r.get("title", "Unknown"),
                "artist": (r.get("artists") or [{"name": "Unknown"}])[0]["name"],
                "videoId": vid
            })
            seen.add(vid)
            if len(out) >= max_tracks:
                return out
    return out[:max_tracks]

def resolve_stream_url(videoId: str) -> Optional[str]:
    yurl = f"https://www.youtube.com/watch?v={videoId}"
    try:
        direct = subprocess.check_output(
            ["yt-dlp", "-f", "bestaudio", "--get-url", yurl],
            text=True
        ).strip()
        return direct or None
    except subprocess.CalledProcessError:
        return None

class MPVController:
    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self.lock = threading.Lock()

    def start(self):
        ensure_state_dir()
        if os.path.exists(MPV_SOCKET):
            try:
                os.remove(MPV_SOCKET)
            except Exception:
                pass
        cmd = [
            "/usr/local/bin/mpv",
            "--no-video",
            "--idle=yes",
            f"--input-ipc-server={MPV_SOCKET}",
            "--force-window=no",
            "--terminal=no"
        ]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _ipc(self, payload: Dict[str, Any]):
        import socket
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.connect(MPV_SOCKET)
            s.sendall((json.dumps(payload) + "\n").encode("utf-8"))
            try:
                s.settimeout(0.2)
                s.recv(4096)
            except Exception:
                pass

    def load_and_play(self, urls: List[str]):
        with self.lock:
            if not urls:
                return
            self._ipc({"command": ["loadfile", urls[0], "replace"]})
            for u in urls[1:]:
                self._ipc({"command": ["loadfile", u, "append-play"]})

    def pause_toggle(self):
        with self.lock:
            self._ipc({"command": ["cycle", "pause"]})

    def next(self):
        with self.lock:
            self._ipc({"command": ["playlist-next", "force"]})

    def stop(self):
        with self.lock:
            self._ipc({"command": ["stop"]})

mpv = MPVController()
yt = load_ytmusic()

def handle_play(prompt: str, extras: Dict[str, Any]) -> Dict[str, Any]:
    con = db()
    ttl_hours = int(extras.get("ttl_hours", CACHE_TTL_HOURS))
    max_tracks = int(extras.get("max_tracks", MAX_TRACKS_DEFAULT))

    key = prompt + "\n" + json.dumps(extras, sort_keys=True)
    cached = cache_get(con, key, ttl_hours)
    if cached:
        tracks = cached["tracks"]
    else:
        curated = llm_curate(prompt, extras)
        queries = curated["search_queries"]
        tracks = pick_tracks(yt, queries, max_tracks=max_tracks, extras=extras)
        cached = {"curated": curated, "tracks": tracks}
        cache_put(con, key, cached)

    urls: List[str] = []
    playable: List[Dict[str, str]] = []
    for t in tracks:
        u = resolve_stream_url(t["videoId"])
        if u:
            urls.append(u)
            playable.append(t)
        if len(urls) >= max_tracks:
            break

    mpv.load_and_play(urls)

    now = int(time.time())
    for t in playable[:1]:
        con.execute(
            "INSERT INTO history(videoId, title, artist, played_at) VALUES(?,?,?,?);",
            (t["videoId"], t.get("title"), t.get("artist"), now)
        )
    con.commit()

    return {"ok": True, "count": len(playable), "queue": playable[:20]}

def vote(videoId: str, title: str, artist: str, v: int) -> Dict[str, Any]:
    con = db()
    con.execute(
        "INSERT OR REPLACE INTO votes(videoId, title, artist, vote, updated_at) VALUES(?,?,?,?,?);",
        (videoId, title, artist, int(v), int(time.time()))
    )
    con.commit()
    return {"ok": True}

class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: Dict[str, Any]):
        b = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = urlparse(self.path)
        qs = parse_qs(p.query)

        try:
            if p.path == "/health":
                return self._json(200, {"ok": True})

            if p.path == "/play":
                prompt = (qs.get("q") or [""])[0].strip()
                if not prompt:
                    return self._json(400, {"ok": False, "error": "missing q"})
                extras = {
                    "lang": (qs.get("lang") or [None])[0],
                    "mood": (qs.get("mood") or [None])[0],
                    "seed": (qs.get("seed") or [None])[0],
                    "max_tracks": int((qs.get("n") or [MAX_TRACKS_DEFAULT])[0]),
                    "ttl_hours": int((qs.get("ttl") or [CACHE_TTL_HOURS])[0]),
                    "avoid": (qs.get("avoid") or [""])[0].split(",") if qs.get("avoid") else [],
                }
                res = handle_play(prompt, extras)
                return self._json(200, res)

            if p.path == "/pause":
                mpv.pause_toggle()
                return self._json(200, {"ok": True})

            if p.path == "/next":
                mpv.next()
                return self._json(200, {"ok": True})

            if p.path == "/stop":
                mpv.stop()
                return self._json(200, {"ok": True})

            if p.path == "/vote":
                vid = (qs.get("id") or [""])[0]
                v = int((qs.get("v") or ["0"])[0])
                title = (qs.get("title") or [""])[0]
                artist = (qs.get("artist") or [""])[0]
                if not vid or v not in (-1, 1):
                    return self._json(400, {"ok": False, "error": "need id and v=1|-1"})
                return self._json(200, vote(vid, title, artist, v))

            return self._json(404, {"ok": False, "error": "not found"})
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)})

def main():
    ensure_state_dir()
    mpv.start()
    server = HTTPServer((HOST, PORT), Handler)
    print(f"ytplayd listening on http://{HOST}:{PORT}")
    server.serve_forever()

if __name__ == "__main__":
    main()
