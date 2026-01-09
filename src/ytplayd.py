#!/usr/bin/env python3
import os, json, time, sqlite3, subprocess, threading, shutil, mimetypes, logging, re
from concurrent.futures import ThreadPoolExecutor, as_completed
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
    if not path:
        return
    path = expanduser(path)
    if not os.path.exists(path):
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
SEED_NEXT_MAX = int(os.getenv("YTP_SEED_NEXT_MAX", "10"))
SEED_NEXT_MAX = max(5, min(10, SEED_NEXT_MAX))
PREFETCH_EXTRA = int(os.getenv("YTP_PREFETCH_EXTRA", "5"))
PREFETCH_EXTRA = max(0, min(20, PREFETCH_EXTRA))
PREFETCH_WORKERS = int(os.getenv("YTP_PREFETCH_WORKERS", "4"))
PREFETCH_WORKERS = max(1, min(8, PREFETCH_WORKERS))
RECENT_HISTORY_LIMIT = int(os.getenv("YTP_RECENT_HISTORY_LIMIT", "50"))
RECENT_HISTORY_LIMIT = max(0, min(200, RECENT_HISTORY_LIMIT))
MIX_DEFAULT = os.getenv("YTP_MIX_DEFAULT", "50/50")
VIBE_DEFAULT = os.getenv("YTP_VIBE_DEFAULT", "normal")
VIBE_LLM_ENABLED = os.getenv("YTP_VIBE_LLM", "0") == "1"
VIBE_LLM_MODEL = os.getenv("YTP_VIBE_LLM_MODEL", MODEL)

LOG_LEVEL = os.getenv("YTP_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("ytplayd")

STATE_DIR = expanduser(os.getenv("YTP_STATE_DIR", "~/.ytplay"))
CACHE_DB = os.path.join(STATE_DIR, "cache.sqlite3")
MPV_SOCKET = os.path.join(STATE_DIR, "mpv.sock")
AUTH_ENV = "YTP_YTMUSIC_AUTH"
AUTH_STATE = os.path.join(STATE_DIR, "headers_auth.json")
AUTH_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "headers_auth.json"))
WEB_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))

def resolve_bin(env_key: str, name: str, fallback_paths: List[str]) -> Optional[str]:
    env = os.getenv(env_key)
    if env:
        return expanduser(env)
    found = shutil.which(name)
    if found:
        return found
    for path in fallback_paths:
        if os.path.exists(path):
            return path
    return None

MPV_BIN = resolve_bin("YTP_MPV_BIN", "mpv", ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"])
YTDLP_BIN = resolve_bin("YTP_YTDLP_BIN", "yt-dlp", ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"])
YTDLP_EXTRACTOR_ARGS_ENV = os.getenv("YTP_YTDLP_EXTRACTOR_ARGS")
YTDLP_EXTRACTOR_ARGS_FALLBACK = os.getenv("YTP_YTDLP_EXTRACTOR_ARGS_FALLBACK", "")
YTDLP_PO_TOKEN = os.getenv("YTP_YTDLP_PO_TOKEN")
YTDLP_JS_RUNTIME_ENV = os.getenv("YTP_YTDLP_JS_RUNTIME")

def resolve_js_runtime() -> Optional[str]:
    if YTDLP_JS_RUNTIME_ENV is not None:
        runtime = YTDLP_JS_RUNTIME_ENV.strip()
        return runtime or None
    for name in ("node", "deno", "bun"):
        path = shutil.which(name)
        if path:
            return f"{name}:{path}"
    return None

YTDLP_JS_RUNTIME = resolve_js_runtime()
if YTDLP_EXTRACTOR_ARGS_ENV is None:
    if YTDLP_PO_TOKEN:
        YTDLP_EXTRACTOR_ARGS = f"youtube:player_client=android,po_token={YTDLP_PO_TOKEN}"
    else:
        YTDLP_EXTRACTOR_ARGS = "youtube:player_client=android"
else:
    YTDLP_EXTRACTOR_ARGS = YTDLP_EXTRACTOR_ARGS_ENV
if not YTDLP_JS_RUNTIME:
    logger.warning("yt-dlp: no JS runtime found; set YTP_YTDLP_JS_RUNTIME to avoid warnings")

def require_bin(path: Optional[str], name: str, env_key: str) -> str:
    if not path:
        raise FileNotFoundError(f"{name} not found. Install it or set {env_key}.")
    if os.path.isabs(path):
        if os.path.exists(path):
            return path
        raise FileNotFoundError(f"{name} not found at {path}.")
    found = shutil.which(path)
    if found:
        return found
    raise FileNotFoundError(f"{name} not found on PATH. Install it or set {env_key}.")

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

def auth_candidates() -> List[str]:
    candidates: List[str] = []
    env_path = os.getenv(AUTH_ENV)
    if env_path:
        candidates.append(expanduser(env_path))
    candidates.append(AUTH_REPO)
    candidates.append(AUTH_STATE)
    return candidates

def find_auth_path() -> Optional[str]:
    for path in auth_candidates():
        if path and os.path.exists(path):
            return path
    return None

def load_ytmusic() -> tuple[YTMusic, Optional[str]]:
    auth_path = find_auth_path()
    return (YTMusic(auth_path) if auth_path else YTMusic(), auth_path)

def openai_client() -> OpenAI:
    # OPENAI_API_KEY must be in env (from ~/.ytplay/.env or environment)
    return OpenAI()

def get_votes(con: sqlite3.Connection) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for vid, vote in con.execute("SELECT videoId, vote FROM votes;").fetchall():
        out[vid] = int(vote)
    return out

def get_recent_likes(con: sqlite3.Connection, limit: int) -> List[Dict[str, str]]:
    if limit <= 0:
        return []
    rows = con.execute(
        "SELECT title, artist, videoId FROM votes WHERE vote=1 ORDER BY updated_at DESC LIMIT ?;",
        (limit,)
    ).fetchall()
    out: List[Dict[str, str]] = []
    for title, artist, vid in rows:
        out.append({
            "title": title or "Unknown",
            "artist": artist or "Unknown",
            "videoId": vid or "",
        })
    return out

def get_recent_history(con: sqlite3.Connection, limit: int) -> List[str]:
    if limit <= 0:
        return []
    rows = con.execute(
        "SELECT videoId FROM history ORDER BY played_at DESC LIMIT ?;",
        (limit,)
    ).fetchall()
    return [str(r[0]) for r in rows if r and r[0]]

def get_recent_history_since(con: sqlite3.Connection, since_ts: int) -> List[str]:
    rows = con.execute(
        "SELECT videoId FROM history WHERE played_at >= ?;",
        (since_ts,)
    ).fetchall()
    return [str(r[0]) for r in rows if r and r[0]]

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

def track_from_item(item: Dict[str, Any]) -> Optional[Dict[str, str]]:
    if not item:
        return None
    vid = item.get("videoId")
    if not vid:
        return None
    title = item.get("title") or item.get("name") or "Unknown"

    thumb_url = ""
    thumbs = item.get("thumbnails")
    if isinstance(thumbs, list) and thumbs:
        thumb_url = thumbs[-1].get("url") or thumbs[0].get("url") or ""
    elif isinstance(thumbs, dict):
        thumb_url = thumbs.get("url") or ""
    if not thumb_url:
        thumb = item.get("thumbnail")
        if isinstance(thumb, list) and thumb:
            thumb_url = thumb[-1].get("url") or thumb[0].get("url") or ""
        elif isinstance(thumb, dict):
            thumb_url = thumb.get("url") or ""
        elif isinstance(thumb, str):
            thumb_url = thumb

    artist = "Unknown"
    artists = item.get("artists")
    if isinstance(artists, list) and artists:
        artist = artists[0].get("name") or artists[0].get("text") or artist
    else:
        artist_obj = item.get("artist")
        if isinstance(artist_obj, dict):
            artist = artist_obj.get("name") or artist_obj.get("text") or artist
        elif isinstance(artist_obj, str) and artist_obj:
            artist = artist_obj

    album = ""
    album_obj = item.get("album")
    if isinstance(album_obj, dict):
        album = album_obj.get("name") or album_obj.get("title") or ""
    elif isinstance(album_obj, str):
        album = album_obj

    return {
        "title": str(title),
        "artist": str(artist),
        "videoId": str(vid),
        "album": str(album) if album else "",
        "thumbnail": str(thumb_url) if thumb_url else "",
    }

LANG_CODE_MAP = {
    "ta": "tamil",
    "te": "telugu",
    "hi": "hindi",
    "ml": "malayalam",
    "kn": "kannada",
    "mr": "marathi",
    "pa": "punjabi",
    "bn": "bengali",
    "en": "english",
    "es": "spanish",
    "fr": "french",
    "de": "german",
    "it": "italian",
    "ja": "japanese",
    "ko": "korean",
    "zh": "chinese",
    "ar": "arabic",
}

LANG_KEYWORDS = {
    "tamil": ["tamil", "tamizh"],
    "telugu": ["telugu"],
    "hindi": ["hindi"],
    "malayalam": ["malayalam"],
    "kannada": ["kannada"],
    "marathi": ["marathi"],
    "punjabi": ["punjabi"],
    "bengali": ["bengali"],
    "english": ["english"],
    "spanish": ["spanish"],
    "french": ["french"],
    "german": ["german"],
    "italian": ["italian"],
    "japanese": ["japanese"],
    "korean": ["korean"],
    "chinese": ["chinese", "mandarin", "cantonese"],
    "arabic": ["arabic"],
}

ENERGY_KEYWORDS = {
    "low": [
        "mellow", "calm", "chill", "soft", "ambient", "dreamy", "lofi",
        "acoustic", "soothing", "relax", "slow", "sleep", "lullaby",
    ],
    "med": ["midtempo", "groove", "indie", "folk", "steady", "warm"],
    "high": [
        "energetic", "upbeat", "dance", "party", "edm", "electro",
        "rock", "metal", "hard", "trap", "drill", "punk", "rave",
        "banger", "club",
    ],
}

TEMPO_KEYWORDS = {
    "slow": ["slow", "ballad", "lullaby", "downtempo"],
    "medium": ["midtempo", "moderate", "steady"],
    "fast": ["fast", "uptempo", "speed", "high tempo"],
}

INSTRUMENT_KEYWORDS = {
    "acoustic": ["acoustic", "unplugged", "folk", "singer songwriter"],
    "electronic": ["electronic", "synth", "edm", "electro", "techno", "house"],
    "orchestral": ["orchestra", "orchestral", "symphony", "cinematic"],
    "rock_guitars": ["rock", "guitar", "metal", "grunge"],
    "heavy_drums": ["drum", "drums", "percussion", "beat", "dnb", "drum and bass"],
}

AVOID_PATTERNS = ["remix", "live", "8d", "nightcore", "slowed", "reverb", "cover"]
HEAVY_KEYWORDS = ["metal", "hardstyle", "dubstep", "edm", "rave", "festival", "mosh", "hardcore"]

VIBE_THRESHOLDS = {"strict": 0.80, "normal": 0.70, "loose": 0.60}

def normalize_text(text: str) -> str:
    if not text:
        return ""
    text = text.lower()
    text = re.sub(r"[^a-z0-9\\s]", " ", text)
    text = re.sub(r"\\s+", " ", text).strip()
    return text

def has_keyword(text: str, keyword: str) -> bool:
    if not text or not keyword:
        return False
    if " " in keyword:
        return keyword in text
    return re.search(r"\\b" + re.escape(keyword) + r"\\b", text) is not None

def detect_languages(texts: List[str]) -> List[str]:
    found = set()
    merged = normalize_text(" ".join([t for t in texts if t]))
    if not merged:
        return []
    for lang, keys in LANG_KEYWORDS.items():
        for key in keys:
            if has_keyword(merged, key):
                found.add(lang)
                break
    return sorted(found)

def unknown_signal_score(vibe_mode: str) -> float:
    if vibe_mode == "strict":
        return 0.85
    if vibe_mode == "loose":
        return 0.95
    return 0.9

def infer_energy(text: str) -> Optional[str]:
    if not text:
        return None
    scores = {k: 0 for k in ENERGY_KEYWORDS}
    for level, keys in ENERGY_KEYWORDS.items():
        for key in keys:
            if has_keyword(text, key):
                scores[level] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else None

def infer_tempo(text: str) -> Optional[str]:
    if not text:
        return None
    scores = {k: 0 for k in TEMPO_KEYWORDS}
    for level, keys in TEMPO_KEYWORDS.items():
        for key in keys:
            if has_keyword(text, key):
                scores[level] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else None

def infer_instrumentation(text: str) -> List[str]:
    if not text:
        return []
    tags = set()
    for tag, keys in INSTRUMENT_KEYWORDS.items():
        for key in keys:
            if has_keyword(text, key):
                tags.add(tag)
                break
    return sorted(tags)

def allow_repeat(prompt: str) -> bool:
    text = normalize_text(prompt)
    return any(
        has_keyword(text, kw)
        for kw in ["repeat", "again", "same track", "same song"]
    )

def parse_mix(raw: Optional[str]) -> float:
    raw = (raw or MIX_DEFAULT).strip().lower()
    if "/" in raw:
        left, right = raw.split("/", 1)
        try:
            a = float(left)
            b = float(right)
            total = a + b
            if total > 0:
                return max(0.0, min(1.0, a / total))
        except ValueError:
            pass
    try:
        val = float(raw)
        if val > 1.0:
            val = val / 100.0
        return max(0.0, min(1.0, val))
    except ValueError:
        return 0.5

def parse_vibe(raw: Optional[str]) -> str:
    raw = (raw or VIBE_DEFAULT).strip().lower()
    if raw in VIBE_THRESHOLDS:
        return raw
    return "normal"

def build_vibe_profile(
    prompt: str,
    seed_info: Optional[Dict[str, str]],
    extras: Dict[str, Any],
    liked_tracks: List[Dict[str, str]],
    avoid_terms: List[str],
) -> Dict[str, Any]:
    prompt_text = prompt or ""
    seed_text = ""
    if seed_info:
        seed_text = f"{seed_info.get('title', '')} {seed_info.get('artist', '')}"

    liked_texts = [f"{t.get('title','')} {t.get('artist','')}" for t in liked_tracks]
    merged_texts = [prompt_text, seed_text] + liked_texts
    merged = normalize_text(" ".join(merged_texts))

    lang = extras.get("lang")
    languages = set()
    if lang:
        languages.add(LANG_CODE_MAP.get(lang.lower(), lang.lower()))
    else:
        languages.update(detect_languages([prompt_text, seed_text] + liked_texts))

    mood_texts = [extras.get("mood") or "", prompt_text, seed_text]
    mood_merged = normalize_text(" ".join(mood_texts))
    energy = infer_energy(mood_merged)
    tempo = infer_tempo(mood_merged)
    if not tempo and energy:
        tempo = "slow" if energy == "low" else "fast" if energy == "high" else "medium"

    instrumentation = set(infer_instrumentation(merged))

    avoid_set = set(AVOID_PATTERNS)
    for term in avoid_terms or []:
        avoid_set.add(term.strip().lower())

    allow_patterns = set()
    for pat in AVOID_PATTERNS:
        if has_keyword(merged, pat):
            allow_patterns.add(pat)
    avoid_set = {a for a in avoid_set if a and a not in allow_patterns}

    allow_heavy = any(has_keyword(merged, kw) for kw in HEAVY_KEYWORDS + ["rock", "edm", "metal"])

    return {
        "languages": sorted(languages),
        "energy": energy,
        "tempo": tempo,
        "instrumentation": sorted(instrumentation),
        "avoid": sorted(avoid_set),
        "allow_heavy": allow_heavy,
    }

def lang_score(track_text: str, profile: Dict[str, Any], vibe_mode: str) -> float:
    langs = profile.get("languages") or []
    if not langs:
        return 1.0
    track_langs = detect_languages([track_text])
    if not track_langs:
        return unknown_signal_score(vibe_mode)
    if set(track_langs) & set(langs):
        return 1.0
    return 0.4

def energy_score(track_energy: Optional[str], profile_energy: Optional[str], vibe_mode: str) -> float:
    if not profile_energy:
        return 1.0
    if not track_energy:
        return unknown_signal_score(vibe_mode)
    order = {"low": 0, "med": 1, "high": 2}
    d = abs(order.get(track_energy, 1) - order.get(profile_energy, 1))
    if d == 0:
        return 1.0
    if d == 1:
        return 0.5 if vibe_mode == "strict" else 0.7 if vibe_mode == "normal" else 0.85
    return 0.2

def tempo_score(track_tempo: Optional[str], profile_tempo: Optional[str], vibe_mode: str) -> float:
    if not profile_tempo:
        return 1.0
    if not track_tempo:
        return unknown_signal_score(vibe_mode)
    order = {"slow": 0, "medium": 1, "fast": 2}
    d = abs(order.get(track_tempo, 1) - order.get(profile_tempo, 1))
    if d == 0:
        return 1.0
    if d == 1:
        return 0.5 if vibe_mode == "strict" else 0.7 if vibe_mode == "normal" else 0.85
    return 0.2

def instrumentation_score(track_tags: List[str], profile_tags: List[str], vibe_mode: str) -> float:
    if not profile_tags:
        return 1.0
    if not track_tags:
        return unknown_signal_score(vibe_mode)
    overlap = set(track_tags) & set(profile_tags)
    if overlap:
        return 1.0
    return 0.6 if vibe_mode == "strict" else 0.7 if vibe_mode == "normal" else 0.8

def vibe_score(
    track: Dict[str, str],
    profile: Dict[str, Any],
    vibe_mode: str,
    threshold: float
) -> float:
    track_text = normalize_text(
        " ".join([track.get("title", ""), track.get("artist", ""), track.get("album", "")])
    )
    avoid = profile.get("avoid") or []
    for pat in avoid:
        if has_keyword(track_text, pat):
            return 0.0

    score = 1.0
    score *= lang_score(track_text, profile, vibe_mode)

    t_energy = infer_energy(track_text)
    score *= energy_score(t_energy, profile.get("energy"), vibe_mode)

    t_tempo = infer_tempo(track_text)
    score *= tempo_score(t_tempo, profile.get("tempo"), vibe_mode)

    t_instr = infer_instrumentation(track_text)
    score *= instrumentation_score(t_instr, profile.get("instrumentation") or [], vibe_mode)

    if profile.get("energy") == "low" and not profile.get("allow_heavy"):
        if any(has_keyword(track_text, kw) for kw in HEAVY_KEYWORDS):
            score = min(score, 0.2)

    return min(1.0, max(0.0, score)) if score >= 0 else 0.0

def parse_json_object(text: str) -> Dict[str, Any]:
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                return {}
        return {}

def vibe_score_llm(track: Dict[str, str], profile: Dict[str, Any]) -> Optional[float]:
    if not VIBE_LLM_ENABLED:
        return None
    client = openai_client()
    logger.info("openai: vibe score '%s' - '%s'", track.get("title"), track.get("artist"))
    started = time.time()
    system = (
        "You are a music vibe classifier. "
        "Return JSON only with a numeric vibe_score between 0 and 1."
    )
    user = {
        "track": {
            "title": track.get("title"),
            "artist": track.get("artist"),
            "album": track.get("album"),
        },
        "target_vibe": {
            "languages": profile.get("languages"),
            "energy": profile.get("energy"),
            "tempo": profile.get("tempo"),
            "instrumentation": profile.get("instrumentation"),
            "avoid": profile.get("avoid"),
        },
    }
    schema = {
        "type": "object",
        "properties": {"vibe_score": {"type": "number", "minimum": 0, "maximum": 1}},
        "required": ["vibe_score"],
        "additionalProperties": False,
    }
    try:
        resp = client.responses.create(
            model=VIBE_LLM_MODEL,
            input=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user)},
            ],
            text_format={"type": "json_schema", "name": "vibe_score", "schema": schema, "strict": True},
        )
    except TypeError:
        resp = client.responses.create(
            model=VIBE_LLM_MODEL,
            input=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user)},
            ],
        )
    payload = parse_json_object(response_text(resp))
    logger.info("openai: vibe score done in %.2fs", time.time() - started)
    try:
        score = float(payload.get("vibe_score"))
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, score))

def build_bucket_order(total: int, explore_ratio: float) -> List[str]:
    if total <= 0:
        return []
    explore_ratio = max(0.0, min(1.0, explore_ratio))
    explore_target = int(round(total * explore_ratio))
    exploit_target = total - explore_target
    order: List[str] = []
    explore_count = 0
    exploit_count = 0
    for _ in range(total):
        if explore_count >= explore_target:
            order.append("exploit")
            exploit_count += 1
            continue
        if exploit_count >= exploit_target:
            order.append("explore")
            explore_count += 1
            continue
        current_ratio = explore_count / max(1, (explore_count + exploit_count))
        if current_ratio < explore_ratio:
            order.append("explore")
            explore_count += 1
        else:
            order.append("exploit")
            exploit_count += 1
    return order

def preference_score(track: Dict[str, str], votes: Dict[str, int], liked_artists: set) -> float:
    vid = track.get("videoId")
    if vid and votes.get(vid, 0) > 0:
        return 1.0
    artist = (track.get("artist") or "").lower()
    if artist and artist in liked_artists:
        return 0.6
    return 0.0

def artist_count(window: List[str], artist: str) -> int:
    return sum(1 for a in window if a == artist)

def pick_next_candidate(
    candidates: List[Dict[str, Any]],
    start_idx: int,
    used_ids: set,
    artist_window: List[str],
    max_per_artist: int
) -> tuple[Optional[Dict[str, str]], int]:
    idx = start_idx
    while idx < len(candidates):
        track = candidates[idx]["track"]
        vid = track.get("videoId")
        artist = (track.get("artist") or "").lower()
        idx += 1
        if not vid or vid in used_ids:
            continue
        if artist and artist_count(artist_window, artist) >= max_per_artist:
            continue
        return track, idx
    return None, idx

def ensure_seed_first(
    tracks: List[Dict[str, str]],
    seed_info: Optional[Dict[str, str]],
    max_len: int
) -> List[Dict[str, str]]:
    if not seed_info or not tracks:
        return tracks[:max_len] if max_len > 0 else tracks
    seed_vid = seed_info.get("videoId")
    if not seed_vid:
        return tracks[:max_len] if max_len > 0 else tracks

    existing_idx = None
    for idx, track in enumerate(tracks):
        if track.get("videoId") == seed_vid:
            existing_idx = idx
            break

    if existing_idx is None:
        reordered = [seed_info] + tracks
    elif existing_idx == 0:
        reordered = tracks
    else:
        reordered = [tracks[existing_idx]] + tracks[:existing_idx] + tracks[existing_idx + 1 :]

    if max_len > 0 and len(reordered) > max_len:
        return reordered[:max_len]
    return reordered

def resolve_seed(
    yt: YTMusic,
    seed_query: Optional[str],
    votes: Dict[str, int]
) -> Optional[Dict[str, str]]:
    if not seed_query:
        return None

    logger.info("seed: resolving '%s'", seed_query)
    try:
        results = yt.search(seed_query, filter="songs")
    except Exception:
        results = yt.search(seed_query)

    seed_info: Optional[Dict[str, str]] = None
    for r in results[:12]:
        track = track_from_item(r)
        if not track:
            continue
        vid = track["videoId"]
        if votes.get(vid, 0) < 0:
            continue
        seed_info = track
        break

    if seed_info:
        logger.info("seed: resolved '%s' by %s", seed_info.get("title"), seed_info.get("artist"))
    else:
        logger.warning("seed: no match found for '%s'", seed_query)
    return seed_info

def get_attr(obj: Any, name: str, default: Any = None):
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)

def response_text(resp: Any) -> str:
    text = get_attr(resp, "output_text", "")
    if text:
        return text
    output = get_attr(resp, "output")
    if output:
        for item in output:
            item_type = get_attr(item, "type")
            if item_type and item_type != "message":
                continue
            content = get_attr(item, "content")
            if not content:
                continue
            for c in content:
                c_type = get_attr(c, "type")
                if c_type and c_type not in ("output_text", "text"):
                    continue
                t = get_attr(c, "text")
                if t:
                    return t
    choices = get_attr(resp, "choices")
    if choices:
        first = choices[0]
        message = get_attr(first, "message")
        if message:
            content = get_attr(message, "content")
            if content:
                return content
        text = get_attr(first, "text")
        if text:
            return text
    return ""

def parse_curation_response(text: str, max_queries: int) -> Dict[str, Any]:
    if not text:
        raise ValueError("Empty response from model.")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                payload = json.loads(text[start:end + 1])
            except json.JSONDecodeError as e:
                raise ValueError("LLM response was not valid JSON.") from e
        else:
            raise ValueError("LLM response was not valid JSON.")

    if not isinstance(payload, dict):
        raise ValueError("LLM response JSON was not an object.")

    search_queries = payload.get("search_queries") or []
    if isinstance(search_queries, str):
        search_queries = [search_queries]
    elif not isinstance(search_queries, list):
        search_queries = [str(search_queries)]
    search_queries = [str(q).strip() for q in search_queries if str(q).strip()]
    if max_queries and len(search_queries) > max_queries:
        search_queries = search_queries[:max_queries]

    avoid_terms = payload.get("avoid_terms") or []
    if isinstance(avoid_terms, str):
        avoid_terms = [avoid_terms]
    elif not isinstance(avoid_terms, list):
        avoid_terms = [str(avoid_terms)]
    avoid_terms = [str(a).strip() for a in avoid_terms if str(a).strip()]

    notes = payload.get("notes") or ""
    if not isinstance(notes, str):
        notes = str(notes)

    return {"search_queries": search_queries, "avoid_terms": avoid_terms, "notes": notes}

def fallback_queries(prompt: str, extras: Dict[str, Any], max_queries: int) -> List[str]:
    seed = (extras.get("seed") or "").strip()
    mood = (extras.get("mood") or "").strip()
    lang = (extras.get("lang") or "").strip()
    lang_name = LANG_CODE_MAP.get(lang.lower(), lang.lower()) if lang else ""
    base = (prompt or "").strip()

    out: List[str] = []
    seen = set()

    def add(query: str):
        q = " ".join(query.split())
        if not q:
            return
        key = q.lower()
        if key in seen:
            return
        seen.add(key)
        out.append(q)

    if seed and base:
        add(f"{seed} {base}")
    if base:
        add(base)
    if seed:
        add(seed)
    if mood and base:
        add(f"{base} {mood}")
    if lang_name and base:
        add(f"{base} {lang_name}")
    if seed and mood:
        add(f"{seed} {mood}")
    if seed and lang_name:
        add(f"{seed} {lang_name}")
    if seed and mood and lang_name:
        add(f"{seed} {mood} {lang_name}")
    if mood and not base:
        add(mood)
    if lang_name and not base:
        add(lang_name)

    if max_queries and len(out) > max_queries:
        return out[:max_queries]
    return out

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

    system = (
        "You are a music curator for YouTube Music. "
        "Output JSON only. Produce tight, non-noisy search queries. "
        "Prefer official audio and studio versions. Avoid remix spam unless requested."
    )

    user = {
        "prompt": prompt,
        "preferences": {"lang": lang, "mood": mood, "seed": seed, "avoid_terms": avoid},
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

    response_kwargs = {
        "model": MODEL,
        "input": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user)}
        ],
    }
    text_format = {"type": "json_schema", "name": "curation", "schema": schema, "strict": True}

    logger.info("openai: curate start (seed=%s, mood=%s, lang=%s)", seed, mood, lang)
    started = time.time()
    source = "llm"
    error = None
    try:
        try:
            resp = client.responses.create(**response_kwargs, text_format=text_format)
        except TypeError as e:
            if "text_format" not in str(e):
                raise
            resp = client.responses.create(**response_kwargs)
        curated = parse_curation_response(response_text(resp), max_queries)
    except Exception as e:
        error = str(e)
        curated = {
            "search_queries": fallback_queries(prompt, extras, max_queries),
            "avoid_terms": [],
            "notes": "fallback: curation failed",
        }
        source = "fallback"
        logger.warning("openai: curate failed, using fallback queries (%s)", error)

    if not curated.get("search_queries"):
        curated["search_queries"] = fallback_queries(prompt, extras, max_queries)
        source = "fallback"
    elapsed = time.time() - started
    logger.info(
        "openai: curate done in %.2fs (%d queries)",
        elapsed,
        len(curated.get("search_queries") or []),
    )
    curated["source"] = source
    if error:
        curated["error"] = error
    return curated

def pick_tracks(
    yt: YTMusic,
    prompt: str,
    queries: List[str],
    max_tracks: int,
    extras: Dict[str, Any],
    debug_meta: Optional[Dict[str, Any]] = None
) -> tuple[List[Dict[str, str]], Optional[Dict[str, str]], List[Dict[str, str]]]:
    con = db()
    votes = get_votes(con)
    liked_tracks = get_recent_likes(con, 20)
    liked_artists = {t.get("artist", "").lower() for t in liked_tracks if t.get("artist")}
    recent_24h = set(get_recent_history_since(con, int(time.time()) - 86400))
    allow_repeat_flag = allow_repeat(prompt)

    seed = extras.get("seed")
    seed_info: Optional[Dict[str, str]] = None
    if seed:
        seed_info = resolve_seed(yt, seed, votes)

    avoid_terms = (extras.get("avoid") or []) + (extras.get("avoid_terms") or [])
    vibe_mode = parse_vibe(extras.get("vibe"))
    vibe_threshold = VIBE_THRESHOLDS[vibe_mode]
    mix_ratio = parse_mix(extras.get("mix"))

    debug: Dict[str, Any] = {
        "vibe_mode": vibe_mode,
        "vibe_threshold": vibe_threshold,
        "mix_ratio": mix_ratio,
        "query_count": len(queries),
        "queries": queries,
        "results_total": 0,
        "candidates_total": 0,
        "selected_total": 0,
        "seed_included": bool(seed_info),
        "seed_next_count": 0,
        "skips": {
            "no_track": 0,
            "duplicate": 0,
            "disliked": 0,
            "repeat_24h": 0,
            "vibe": 0,
        },
        "query_stats": [],
    }
    if debug_meta:
        debug.update(debug_meta)

    profile = build_vibe_profile(prompt, seed_info, extras, liked_tracks, avoid_terms)
    logger.info(
        "vibe: mode=%s threshold=%.2f energy=%s tempo=%s langs=%s tags=%s",
        vibe_mode,
        vibe_threshold,
        profile.get("energy"),
        profile.get("tempo"),
        ",".join(profile.get("languages") or []) or "-",
        ",".join(profile.get("instrumentation") or []) or "-",
    )

    candidates: List[Dict[str, Any]] = []
    seen = set()
    if seed_info and seed_info.get("videoId"):
        seen.add(seed_info["videoId"])

    for qi, q in enumerate(queries, 1):
        logger.info("ytmusic: search %d/%d '%s'", qi, len(queries), q)
        query_stat = {"query": q, "results": 0, "candidates": 0, "fallback": False}
        try:
            results = yt.search(q, filter="songs")
        except Exception:
            results = []
        if not results:
            try:
                results = yt.search(q)
                query_stat["fallback"] = True
            except Exception:
                results = []
        query_stat["results"] = len(results)
        debug["results_total"] += len(results)
        for r in results[:12]:
            track = track_from_item(r)
            if not track:
                debug["skips"]["no_track"] += 1
                continue
            vid = track["videoId"]
            if vid in seen:
                debug["skips"]["duplicate"] += 1
                continue
            if votes.get(vid, 0) < 0:
                debug["skips"]["disliked"] += 1
                continue
            if (vid in recent_24h) and not allow_repeat_flag:
                debug["skips"]["repeat_24h"] += 1
                logger.debug("skip 24h repeat %s", vid)
                continue

            base_score = vibe_score(track, profile, vibe_mode, vibe_threshold)
            if base_score < vibe_threshold and VIBE_LLM_ENABLED:
                if base_score >= vibe_threshold - 0.08:
                    llm_score = vibe_score_llm(track, profile)
                    if llm_score is not None:
                        base_score = llm_score
            if base_score < vibe_threshold:
                debug["skips"]["vibe"] += 1
                continue

            pref = preference_score(track, votes, liked_artists)
            candidates.append({"track": track, "vibe": base_score, "pref": pref})
            seen.add(vid)
            query_stat["candidates"] += 1
            logger.debug("candidate %s vibe=%.2f pref=%.2f", vid, base_score, pref)
        debug["query_stats"].append(query_stat)

    exploit = sorted(
        [c for c in candidates if c["pref"] > 0],
        key=lambda c: (c["pref"], c["vibe"]),
        reverse=True,
    )
    explore = sorted(
        [c for c in candidates if c["pref"] == 0],
        key=lambda c: c["vibe"],
        reverse=True,
    )

    selected: List[Dict[str, str]] = []
    artist_window: List[str] = []
    used_ids = set()
    if seed_info:
        selected.append(seed_info)
        used_ids.add(seed_info.get("videoId"))
        artist = (seed_info.get("artist") or "").lower()
        if artist:
            artist_window.append(artist)

    remaining = max_tracks - len(selected)
    order = build_bucket_order(remaining, mix_ratio)
    explore_idx = 0
    exploit_idx = 0

    for bucket in order:
        if bucket == "explore":
            track, explore_idx = pick_next_candidate(explore, explore_idx, used_ids, artist_window, 2)
            if not track:
                track, exploit_idx = pick_next_candidate(exploit, exploit_idx, used_ids, artist_window, 2)
        else:
            track, exploit_idx = pick_next_candidate(exploit, exploit_idx, used_ids, artist_window, 2)
            if not track:
                track, explore_idx = pick_next_candidate(explore, explore_idx, used_ids, artist_window, 2)
        if not track:
            break
        selected.append(track)
        used_ids.add(track.get("videoId"))
        artist = (track.get("artist") or "").lower()
        if artist:
            artist_window.append(artist)
            if len(artist_window) > 10:
                artist_window.pop(0)

    while len(selected) < max_tracks:
        track, explore_idx = pick_next_candidate(explore, explore_idx, used_ids, artist_window, 2)
        if not track:
            track, exploit_idx = pick_next_candidate(exploit, exploit_idx, used_ids, artist_window, 2)
        if not track:
            break
        selected.append(track)
        used_ids.add(track.get("videoId"))
        artist = (track.get("artist") or "").lower()
        if artist:
            artist_window.append(artist)
            if len(artist_window) > 10:
                artist_window.pop(0)

    seed_next: List[Dict[str, str]] = []
    if seed_info:
        seed_next = selected[1:1 + SEED_NEXT_MAX]
        logger.info("seed: next curated %d tracks", len(seed_next))

    debug["candidates_total"] = len(candidates)
    debug["selected_total"] = len(selected)
    debug["seed_next_count"] = len(seed_next)
    global last_debug
    last_debug = debug

    logger.info(
        "pick: selected=%d exploit=%d explore=%d",
        len(selected),
        len([t for t in selected if preference_score(t, votes, liked_artists) > 0]),
        len([t for t in selected if preference_score(t, votes, liked_artists) == 0]),
    )

    return selected[:max_tracks], seed_info, seed_next

def resolve_stream_url(videoId: str) -> Optional[str]:
    ytdlp_bin = require_bin(YTDLP_BIN, "yt-dlp", "YTP_YTDLP_BIN")
    yurl = f"https://www.youtube.com/watch?v={videoId}"
    base = [ytdlp_bin, "-f", "bestaudio", "--get-url"]
    if YTDLP_JS_RUNTIME:
        base += ["--js-runtimes", YTDLP_JS_RUNTIME]

    def try_resolve(extractor_args: Optional[str]) -> Optional[str]:
        cmd = list(base)
        if extractor_args is not None:
            extractor_args = extractor_args.strip()
            if extractor_args and extractor_args != "__none__":
                cmd += ["--extractor-args", extractor_args]
        try:
            direct = subprocess.check_output(cmd + [yurl], text=True).strip()
            return direct or None
        except subprocess.CalledProcessError:
            return None

    url = try_resolve(YTDLP_EXTRACTOR_ARGS)
    if url:
        return url
    if YTDLP_EXTRACTOR_ARGS_FALLBACK is not None:
        url = try_resolve(YTDLP_EXTRACTOR_ARGS_FALLBACK)
        if url:
            logger.info("stream: fallback extractor args succeeded after primary failed")
            return url
    return None

def watch_url(videoId: str) -> str:
    return f"https://www.youtube.com/watch?v={videoId}"

def resolve_urls_parallel(
    tracks: List[Dict[str, str]],
    max_tracks: int,
    workers: int
) -> tuple[List[Optional[str]], int]:
    if not tracks or max_tracks <= 0:
        return [], 0

    tracks = tracks[:max_tracks]
    workers = min(workers, len(tracks))
    results: List[Optional[str]] = [None] * len(tracks)
    started = time.time()
    logger.info("stream: resolving %d tracks with %d workers", len(tracks), workers)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {}
        for idx, track in enumerate(tracks):
            futures[pool.submit(resolve_stream_url, track["videoId"])] = idx
        for future in as_completed(futures):
            idx = futures[future]
            try:
                url = future.result()
            except Exception as e:
                logger.warning("stream: resolve failed idx=%d err=%s", idx + 1, e)
                url = None
            results[idx] = url
            if url:
                logger.debug("stream: resolved idx=%d %s", idx + 1, tracks[idx].get("title"))

    elapsed = time.time() - started
    resolved = sum(1 for url in results if url)
    logger.info("stream: resolved %d playable in %.2fs", resolved, elapsed)
    return results, resolved

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
        mpv_bin = require_bin(MPV_BIN, "mpv", "YTP_MPV_BIN")
        cmd = [
            mpv_bin,
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

    def _ipc_request(self, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        import socket
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                s.connect(MPV_SOCKET)
                s.sendall((json.dumps(payload) + "\n").encode("utf-8"))
                buf = b""
                while b"\n" not in buf:
                    chunk = s.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                line = buf.split(b"\n", 1)[0].strip()
                if not line:
                    return None
                return json.loads(line.decode("utf-8"))
        except Exception:
            return None

    def get_property(self, name: str) -> Optional[Any]:
        resp = self._ipc_request({"command": ["get_property", name]})
        if not resp or resp.get("error") != "success":
            return None
        return resp.get("data")

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

    def play_index(self, index: int):
        with self.lock:
            self._ipc({"command": ["playlist-play-index", index]})

    def stop(self):
        with self.lock:
            self._ipc({"command": ["stop"]})

mpv = MPVController()
yt, yt_auth_path = load_ytmusic()

last_prompt: Optional[str] = None
last_extras: Dict[str, Any] = {}
last_queue: List[Dict[str, str]] = []
last_seed: Optional[Dict[str, str]] = None
last_seed_next: List[Dict[str, str]] = []
last_played_at: Optional[int] = None
last_debug: Dict[str, Any] = {}

def maybe_reload_ytmusic():
    global yt, yt_auth_path
    auth_path = find_auth_path()
    if auth_path != yt_auth_path:
        yt = YTMusic(auth_path) if auth_path else YTMusic()
        yt_auth_path = auth_path

def handle_play(prompt: str, extras: Dict[str, Any]) -> Dict[str, Any]:
    maybe_reload_ytmusic()
    con = db()
    ttl_hours = int(extras.get("ttl_hours", CACHE_TTL_HOURS))
    requested_max = int(extras.get("max_tracks", MAX_TRACKS_DEFAULT))
    target_max = requested_max + PREFETCH_EXTRA
    extras = {**extras, "prefetch_extra": PREFETCH_EXTRA}
    logger.info("play: start prompt_len=%d requested=%d prefetch=%d", len(prompt), requested_max, PREFETCH_EXTRA)
    logger.info("play: mix=%s vibe=%s", extras.get("mix"), extras.get("vibe"))

    key = prompt + "\n" + json.dumps(extras, sort_keys=True)
    cached = cache_get(con, key, ttl_hours)
    if cached:
        curated = cached.get("curated", {})
        queries = curated.get("search_queries") or []
        avoid_terms = curated.get("avoid_terms") or []
        logger.info("play: cache hit (%d queries)", len(queries))
    else:
        logger.info("play: cache miss")
        curated = llm_curate(prompt, extras)
        queries = curated.get("search_queries") or []
        avoid_terms = curated.get("avoid_terms") or []
        cached = {"curated": curated}
        cache_put(con, key, cached)

    if not queries:
        fallback = fallback_queries(prompt, extras, int(extras.get("max_queries", 10)))
        if fallback:
            logger.warning("play: empty queries, using fallback (%d)", len(fallback))
            queries = fallback

    extras = {**extras, "avoid_terms": avoid_terms}
    debug_meta = {
        "curation_source": curated.get("source") if isinstance(curated, dict) else None,
        "curation_error": curated.get("error") if isinstance(curated, dict) else None,
    }
    tracks, seed_info, seed_next = pick_tracks(
        yt,
        prompt,
        queries,
        max_tracks=target_max,
        extras=extras,
        debug_meta=debug_meta,
    )

    resolved_urls, resolved_count = resolve_urls_parallel(tracks, target_max, PREFETCH_WORKERS)
    tracks_for_play = tracks[:len(resolved_urls)]
    urls: List[str] = []
    playable: List[Dict[str, str]] = []
    if resolved_count == 0 and tracks_for_play:
        urls = [watch_url(t["videoId"]) for t in tracks_for_play]
        playable = list(tracks_for_play)
        logger.warning("play: no stream URLs resolved; falling back to watch URLs")
    else:
        for track, url in zip(tracks_for_play, resolved_urls):
            if url:
                urls.append(url)
                playable.append(track)
    if isinstance(last_debug, dict):
        last_debug["stream_total"] = len(tracks_for_play)
        last_debug["stream_resolved"] = resolved_count
        last_debug["stream_fallback"] = resolved_count == 0 and len(tracks_for_play) > 0
    mpv.load_and_play(urls)
    logger.info("play: loaded %d tracks", len(playable))

    now = int(time.time())
    for t in playable:
        con.execute(
            "INSERT INTO history(videoId, title, artist, played_at) VALUES(?,?,?,?);",
            (t["videoId"], t.get("title"), t.get("artist"), now)
        )
    con.commit()

    global last_prompt, last_extras, last_queue, last_seed, last_seed_next, last_played_at
    last_prompt = prompt
    last_extras = extras
    last_queue = playable
    last_seed = seed_info
    last_seed_next = seed_next
    last_played_at = now

    return {
        "ok": True,
        "count": len(playable),
        "queue": playable,
        "prompt": prompt,
        "seed": seed_info,
        "seed_next": seed_next,
        "extras": extras,
    }

def vote(videoId: str, title: str, artist: str, v: int) -> Dict[str, Any]:
    con = db()
    con.execute(
        "INSERT OR REPLACE INTO votes(videoId, title, artist, vote, updated_at) VALUES(?,?,?,?,?);",
        (videoId, title, artist, int(v), int(time.time()))
    )
    con.commit()
    return {"ok": True}

def state_snapshot() -> Dict[str, Any]:
    paused = mpv.get_property("pause")
    pos = mpv.get_property("playlist-pos")
    current = None
    if isinstance(pos, int) and 0 <= pos < len(last_queue):
        current = last_queue[pos]
    auth_path = find_auth_path()
    return {
        "ok": True,
        "prompt": last_prompt,
        "extras": last_extras,
        "queue": last_queue,
        "current_index": pos,
        "current": current,
        "paused": paused,
        "seed": last_seed,
        "seed_next": last_seed_next,
        "last_played_at": last_played_at,
        "debug": last_debug,
        "auth": bool(auth_path),
    }

class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: Dict[str, Any]):
        b = json.dumps(obj).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        except (BrokenPipeError, ConnectionResetError):
            logger.debug("client disconnected while sending json response")

    def _redirect(self, location: str):
        try:
            self.send_response(302)
            self.send_header("Location", location)
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            logger.debug("client disconnected while sending redirect")

    def _serve_file(self, rel_path: str):
        rel_path = rel_path.lstrip("/")
        path = os.path.abspath(os.path.join(WEB_ROOT, rel_path))
        if not path.startswith(WEB_ROOT) or not os.path.isfile(path):
            return self._json(404, {"ok": False, "error": "not found"})
        with open(path, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            logger.debug("client disconnected while sending file response")

    def do_GET(self):
        p = urlparse(self.path)
        qs = parse_qs(p.query)

        try:
            if p.path == "/":
                return self._redirect("/ui/")

            if p.path in ("/ui", "/ui/"):
                return self._serve_file("index.html")

            if p.path == "/health":
                return self._json(200, {"ok": True})

            if p.path == "/state":
                return self._json(200, state_snapshot())

            if p.path == "/play":
                prompt = (qs.get("q") or [""])[0].strip()
                if not prompt:
                    return self._json(400, {"ok": False, "error": "missing q"})
                extras = {
                    "lang": (qs.get("lang") or [None])[0],
                    "mood": (qs.get("mood") or [None])[0],
                    "seed": (qs.get("seed") or [None])[0],
                    "mix": (qs.get("mix") or [MIX_DEFAULT])[0],
                    "vibe": (qs.get("vibe") or [VIBE_DEFAULT])[0],
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

            if p.path == "/play_index":
                idx_raw = (qs.get("i") or ["-1"])[0]
                try:
                    idx = int(idx_raw)
                except ValueError:
                    return self._json(400, {"ok": False, "error": "invalid index"})
                if idx < 0 or idx >= len(last_queue):
                    return self._json(400, {"ok": False, "error": "index out of range"})
                mpv.play_index(idx)
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

            if p.path.startswith("/ui/"):
                rel = p.path[len("/ui/"):]
                if not rel:
                    rel = "index.html"
                return self._serve_file(rel)

            return self._json(404, {"ok": False, "error": "not found"})
        except (BrokenPipeError, ConnectionResetError):
            return
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
