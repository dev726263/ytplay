#!/usr/bin/env python3
import sys, json, urllib.request, urllib.parse, socket

HOST = "127.0.0.1"
PORT = 17845

def daemon_up() -> bool:
    try:
        with socket.create_connection((HOST, PORT), timeout=0.2):
            return True
    except Exception:
        return False

def req(path: str, params: dict):
    q = urllib.parse.urlencode({k:v for k,v in params.items() if v is not None})
    url = f"http://{HOST}:{PORT}{path}?{q}"
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))

def main():
    if len(sys.argv) < 2:
        print("""Usage:
  ytplay "prompt..."
  ytplay --seed "Anbarey" "prompt..."
  ytplay --mood calm --lang ta "prompt..."
  ytplay --next | --pause | --stop | --health
Options:
  --n <count>       max tracks (default from daemon)
  --ttl <hours>     cache ttl hours
  --avoid "a,b,c"   comma-separated avoid terms
""")
        return 1

    args = sys.argv[1:]
    if args[0] == "--health":
        print(req("/health", {}))
        return 0

    if args[0] in ("--next", "--pause", "--stop"):
        path = { "--next": "/next", "--pause": "/pause", "--stop": "/stop" }[args[0]]
        print(req(path, {}))
        return 0

    # parse flags
    seed = mood = lang = n = ttl = avoid = None
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
        print("Daemon not reachable on 127.0.0.1:17845. Start it with ./scripts/start.sh (or launchd).")
        return 2

    res = req("/play", {"q": prompt, "seed": seed, "mood": mood, "lang": lang, "n": n, "ttl": ttl, "avoid": avoid})
    if res.get("ok"):
        print(f"Playing {res.get('count')} tracks.")
        for idx, t in enumerate(res.get("queue", []), 1):
            print(f"{idx:02d}. {t.get('title')} — {t.get('artist')} [{t.get('videoId')}]")
    else:
        print(res)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
