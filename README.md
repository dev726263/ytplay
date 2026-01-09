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
- `YTP_SEED_NEXT_MAX=10`
- `YTP_PREFETCH_EXTRA=5` (default; set to 0 to disable prefetch)
- `YTP_PREFETCH_WORKERS=4`
- `YTP_RECENT_HISTORY_LIMIT=50`
- `YTP_LOG_LEVEL=INFO`
- `YTP_MIX_DEFAULT=50/50`
- `YTP_VIBE_DEFAULT=normal`
- `YTP_VIBE_LLM=0`
- `YTP_VIBE_LLM_MODEL=gpt-5-mini`
- `YTP_ENV_FILE=~/.ytplay/.env` (override env path; `~` is supported)
- `YTP_MPV_BIN=/opt/homebrew/bin/mpv`
- `YTP_YTDLP_BIN=/opt/homebrew/bin/yt-dlp`
- `YTP_YTDLP_EXTRACTOR_ARGS=youtube:player_client=android` (override YouTube client)
- `YTP_YTDLP_EXTRACTOR_ARGS_FALLBACK=` (fallback extractor args; empty = yt-dlp defaults)
- `YTP_YTDLP_PO_TOKEN=` (PO token for android client; see notes)
- `YTP_YTMUSIC_AUTH=~/.ytplay/headers_auth.json`
- `YTP_HTTP_TIMEOUT=60`

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
You can also use `--play` as an explicit alias.
When a seed is provided, the daemon resolves it to a specific track, inserts it first in the queue, and shows a curated "seed next" list (no YouTube radio followups).

Mix + vibe controls:
```bash
./bin/ytplay --mix 50/50 --vibe normal "mellow tamil indie vibe"
```

Controls:
```bash
./bin/ytplay --pause
./bin/ytplay --next
./bin/ytplay --stop
```

## Tests

Lightweight smoke tests (mocked, no network/mpv needed):

```bash
python -m unittest tests/test_smoke.py
```

### 6) Web UI
Open:
```bash
http://127.0.0.1:17845/ui/
```
Use it to submit prompts, pause/play, skip, stop, view the current queue, and like/dislike tracks. Queue items are clickable to jump playback, and artwork is shown when available. The UI also supports re-curate (retry) and a queue refresh button.
The Debug panel shows the last curation stats (query counts, skips, and selection totals).

> Tip: after install, you can add `bin/` to your PATH or symlink `ytplay` into `~/bin`.

---

## Optional: improve search quality with YouTube Music auth

Public search works without logging in, but auth usually yields cleaner results.

```bash
./bin/ytplay --auth
```

Follow the prompt:
- open https://music.youtube.com
- open DevTools -> Network, click a request like `/browse`
- copy request headers and paste them into the terminal, then press Ctrl-D

By default the auth file is saved to `~/.ytplay/headers_auth.json` (or to `headers_auth.json` in the repo if it already exists). You can override the location with `YTP_YTMUSIC_AUTH`. If you keep it in the repo root, it is ignored by `.gitignore`.

---

## Repo layout

- `src/ytplayd.py` — daemon: HTTP API + caching (SQLite) + mpv IPC
- `src/ytplay.py`  — CLI client
- `scripts/`       — install + launchd helpers
- `web/`           — web UI (served by the daemon)
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
Recent play history is also used to avoid repeats.

Voting is available in the web UI (like/dislike), or via the API endpoint:

```bash
curl "http://127.0.0.1:17845/vote?id=VIDEOID&v=1&title=TITLE&artist=ARTIST"
curl "http://127.0.0.1:17845/vote?id=VIDEOID&v=-1&title=TITLE&artist=ARTIST"
```

Planned enhancement: `ytplay --like` / `ytplay --dislike` (reads current mpv track and votes automatically).

Preference data remains local in SQLite; it is not sent to OpenAI.

---

## Vibe lock + exploration

- Exploration stays in the same vibe (no genre whiplash).
- VibeProfile is derived from prompt + seed + last 20 liked tracks + flags (`--lang`, `--mood`, `--avoid`).
- Default explore/exploit mix is 50/50; adjust with `--mix 60/40` (explore/exploit).
- Vibe lock thresholds: `strict` (0.80), `normal` (0.70), `loose` (0.60).
- If a track lacks clear metadata signals, it is scored as neutral (not an automatic fail); stricter modes still filter more.
- Diversity rules: max 2 tracks per artist in a 10-track window; no repeats within 24h unless the prompt explicitly asks.

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
- If direct stream URL resolution fails, ytplayd falls back to loading `https://www.youtube.com/watch?v=VIDEOID` in mpv (mpv still relies on `yt-dlp` for that flow).
- If `ytplay` prints an error dict like `{'ok': False, 'error': '...'}`, check `/tmp/ytplayd.err`.
- If launchd can't find `mpv` or `yt-dlp`, set `YTP_MPV_BIN` or `YTP_YTDLP_BIN` in `~/.ytplay/.env`.
- If requests time out, raise `YTP_HTTP_TIMEOUT` (seconds) or check `/tmp/ytplayd.err` for slow/failed calls.
- For OpenAI progress logs, check `/tmp/ytplayd.out` or raise `YTP_LOG_LEVEL=DEBUG`.
- To pre-curate extra tracks and reduce later delays, increase `YTP_PREFETCH_EXTRA`.
- To enable optional LLM vibe scoring for borderline candidates, set `YTP_VIBE_LLM=1`.
- To quiet yt-dlp SABR/JS warnings, set `YTP_YTDLP_EXTRACTOR_ARGS` (default uses `youtube:player_client=android`) and configure `YTP_YTDLP_JS_RUNTIME` (e.g. `node:/opt/homebrew/bin/node`).
- If yt-dlp logs PO token warnings and playback fails, set `YTP_YTDLP_PO_TOKEN` (see yt-dlp PO Token guide) or set `YTP_YTDLP_EXTRACTOR_ARGS_FALLBACK=` to let yt-dlp fall back to its default client.
- If the curator returns no queries, ytplay falls back to prompt/seed-based searches.
- `mpv` runs headless with an IPC socket in `~/.ytplay/mpv.sock`
- Logs:
  - `/tmp/ytplayd.out`
  - `/tmp/ytplayd.err`

---

## License
MIT
