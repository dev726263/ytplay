# ytplay — prompt → curated YouTube Music queue → daemon playback (macOS)

`ytplay` lets you type a natural-language prompt in your terminal, uses the OpenAI API to **curate** a queue from **YouTube Music**, then streams audio via `yt-dlp` into a background **mpv daemon** you can control with `ytplay --pause/--next/--stop`.

> **Why this repo exists**
> - No GUI required.
> - Prompt-driven “radio station” building.
> - Caching + taste training (likes/dislikes) so it gets better and cheaper over time.
> - Shareable code: **secrets and local paths are not committed**.

---

## Quick start (macOS)

### 1) Prereqs
- macOS
- Homebrew installed
- An OpenAI API key

### 2) Install everything
From repo root:

```bash
./scripts/bootstrap_macos.sh
```

This will:
- install `mpv` + `yt-dlp` (via brew)
- create Python venv in `.venv/`
- install Python deps
- create your local config folder `~/.ytplay/`
- copy `.env.example` → `~/.ytplay/.env` (you edit secrets there)

### 3) Add your secrets (DO THIS)
Edit:

```bash
nano ~/.ytplay/.env
```

Set at minimum:
- `OPENAI_API_KEY=...`

Optional:
- `OPENAI_MODEL=gpt-5-mini`
- `YTP_PORT=17845`
- `YTP_MAX_TRACKS=25`
- `YTP_CACHE_TTL_HOURS=72`

### 4) Start the daemon
```bash
./scripts/install_launchd.sh
./scripts/start.sh
```

Check health:
```bash
./scripts/status.sh
```

### 5) Play music
```bash
./bin/ytplay --seed "Anbarey Santhosh Narayanan" --mood calm --lang ta   "mellow tamil indie-romance, introspective, minimal percussion"
```

Controls:
```bash
./bin/ytplay --pause
./bin/ytplay --next
./bin/ytplay --stop
```

> Tip: after install, you can add `bin/` to your PATH or symlink `ytplay` into `~/bin`.

---

## Optional: improve search quality with YouTube Music auth

Public search works without logging in, but auth usually yields cleaner results.

```bash
source .venv/bin/activate
ytmusicapi browser
```

Follow the instructions to create `headers_auth.json` in the repo root.

**Do not commit it.** It’s ignored by `.gitignore`.

---

## Repo layout

- `src/ytplayd.py` — daemon: HTTP API + caching (SQLite) + mpv IPC
- `src/ytplay.py`  — CLI client
- `scripts/`       — install + launchd helpers
- `config/.env.example` — template config (no secrets)
- `bin/ytplay`     — convenience wrapper

---

## How caching works

- We cache: prompt + flags → curated queries + selected `videoId`s in SQLite
- We do **not** cache stream URLs (they expire)
- TTL is configurable (`YTP_CACHE_TTL_HOURS`, default 72h)

---

## Taste training (likes/dislikes)

The daemon stores simple votes:
- liked tracks are preferred
- disliked tracks are skipped in future queues

For now, voting is via API endpoint (wired, but not in CLI yet):

```bash
curl "http://127.0.0.1:17845/vote?id=VIDEOID&v=1&title=TITLE&artist=ARTIST"
curl "http://127.0.0.1:17845/vote?id=VIDEOID&v=-1&title=TITLE&artist=ARTIST"
```

Planned enhancement: `ytplay --like` / `ytplay --dislike` (reads current mpv track and votes automatically).

---

## Uninstall
```bash
./scripts/stop.sh
./scripts/uninstall_launchd.sh
```

---

## Notes / gotchas

- YouTube changes things; if playback breaks:
  ```bash
  source .venv/bin/activate
  pip install -U yt-dlp
  ```
- `mpv` runs headless with an IPC socket in `~/.ytplay/mpv.sock`
- Logs:
  - `/tmp/ytplayd.out`
  - `/tmp/ytplayd.err`

---

## License
MIT
