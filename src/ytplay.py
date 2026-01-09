#!/usr/bin/env python3
import os, sys, json, urllib.request, urllib.parse, urllib.error, socket

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

HOST = "127.0.0.1"
PORT = int(os.getenv("YTP_PORT", "17845"))
HTTP_TIMEOUT = float(os.getenv("YTP_HTTP_TIMEOUT", "60"))
STATE_DIR = expanduser(os.getenv("YTP_STATE_DIR", "~/.ytplay"))
AUTH_ENV = "YTP_YTMUSIC_AUTH"
AUTH_STATE = os.path.join(STATE_DIR, "headers_auth.json")
AUTH_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "headers_auth.json"))

def auth_path() -> str:
    env_path = os.getenv(AUTH_ENV)
    if env_path:
        return expanduser(env_path)
    if os.path.exists(AUTH_REPO):
        return AUTH_REPO
    return AUTH_STATE

def daemon_up() -> bool:
    try:
        with socket.create_connection((HOST, PORT), timeout=0.2):
            return True
    except Exception:
        return False

def req(path: str, params: dict):
    q = urllib.parse.urlencode({k:v for k,v in params.items() if v is not None})
    url = f"http://{HOST}:{PORT}{path}?{q}"
    try:
        with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8")
        except Exception:
            body = ""
        if body:
            try:
                return json.loads(body)
            except Exception:
                pass
        return {"ok": False, "error": f"HTTP {e.code}: {e.reason}"}
    except (socket.timeout, TimeoutError):
        return {"ok": False, "error": f"Request timed out after {HTTP_TIMEOUT:.0f}s"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": str(e)}

def run_auth() -> int:
    try:
        from ytmusicapi import setup as ytmusic_setup
    except Exception as e:
        print(f"ytmusicapi not available: {e}")
        return 1

    dest = auth_path()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest):
        print(f"{dest} already exists. Delete it to re-auth.")
        return 0

    print("Open https://music.youtube.com, then open DevTools -> Network.")
    print("Click a request like /browse, copy request headers, then paste here.")
    try:
        ytmusic_setup(dest)
    except Exception as e:
        print(f"Auth setup failed: {e}")
        return 1

    print(f"Wrote {dest}")
    print("Auth will be used on the next play request.")
    return 0

def main():
    if len(sys.argv) < 2:
        print("""Usage:
  ytplay "prompt..."
  ytplay --seed "Anbarey" "prompt..."
  ytplay --mood calm --lang ta "prompt..."
  ytplay --play "prompt..."
  ytplay --auth
  ytplay --next | --pause | --stop | --health
Options:
  --mix <exp/expl>  explore/exploit mix (default 50/50)
  --vibe <mode>     strict|normal|loose (default normal)
  --n <count>       max tracks (default from daemon)
  --ttl <hours>     cache ttl hours
  --avoid "a,b,c"   comma-separated avoid terms
""")
        return 1

    args = sys.argv[1:]
    if args[0] == "--auth":
        return run_auth()

    if args[0] == "--health":
        print(req("/health", {}))
        return 0

    if args[0] in ("--next", "--pause", "--stop"):
        path = { "--next": "/next", "--pause": "/pause", "--stop": "/stop" }[args[0]]
        print(req(path, {}))
        return 0
    if args[0] == "--play":
        args = args[1:]
        if not args:
            print("Missing prompt.")
            return 1

    # parse flags
    seed = mood = lang = n = ttl = avoid = mix = vibe = None
    i = 0
    rest = []
    while i < len(args):
        a = args[i]
        if a == "--seed":
            seed = args[i+1]; i += 2; continue
        if a == "--mood":
            mood = args[i+1]; i += 2; continue
        if a == "--lang":
            lang = args[i+1]; i += 2; continue
        if a == "--mix":
            mix = args[i+1]; i += 2; continue
        if a == "--vibe":
            vibe = args[i+1]; i += 2; continue
        if a == "--n":
            n = args[i+1]; i += 2; continue
        if a == "--ttl":
            ttl = args[i+1]; i += 2; continue
        if a == "--avoid":
            avoid = args[i+1]; i += 2; continue
        rest.append(a); i += 1

    prompt = " ".join(rest).strip()
    if not prompt:
        print("Missing prompt.")
        return 1

    if not daemon_up():
        print(f"Daemon not reachable on {HOST}:{PORT}. Start it with ./scripts/start.sh (or launchd).")
        return 2

    res = req(
        "/play",
        {
            "q": prompt,
            "seed": seed,
            "mood": mood,
            "lang": lang,
            "mix": mix,
            "vibe": vibe,
            "n": n,
            "ttl": ttl,
            "avoid": avoid,
        },
    )
    if res.get("ok"):
        prompt_text = res.get("prompt")
        seed_info = res.get("seed") or {}
        if prompt_text:
            if seed_info:
                seed_title = seed_info.get("title", "Unknown")
                seed_artist = seed_info.get("artist", "Unknown")
                print(f"Prompt: {prompt_text} (seed: {seed_title} — {seed_artist})")
            else:
                print(f"Prompt: {prompt_text}")
        if seed_info:
            print(f"Seed: {seed_info.get('title')} — {seed_info.get('artist')} [{seed_info.get('videoId')}]")
            seed_next = res.get("seed_next") or []
            if seed_next:
                print("Seed next:")
                for idx, t in enumerate(seed_next, 1):
                    print(f"  {idx:02d}. {t.get('title')} — {t.get('artist')} [{t.get('videoId')}]")
        print(f"Playing {res.get('count')} tracks.")
        for idx, t in enumerate(res.get("queue", []), 1):
            print(f"{idx:02d}. {t.get('title')} — {t.get('artist')} [{t.get('videoId')}]")
    else:
        print(res)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
