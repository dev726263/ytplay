# ytplay - Agent Guide (Codex)

## Project summary
- Backend: Python daemon `ytplayd.py` controls mpv via JSON IPC over a Unix socket.
- Streaming URL: resolved via `yt-dlp -f bestaudio --get-url https://www.youtube.com/watch?v=<videoId>`.
- UI: plain JS web UI. Keep CLI UX and web UI stable.
- Preferences/state: remain LOCAL in SQLite only.

## Security / safety (non-negotiable)
- Never commit secrets.
- Env editor reads/writes `~/.ytplay/.env`; never log env contents.
- All preference data remains local in SQLite (no cloud sync, no external storage).

## macOS launchd constraints
- Use absolute paths for mpv/yt-dlp when running under macOS launchd.
  - Do not assume PATH exists in launchd context.

## Stability guarantees
- Keep CLI UX and web UI stable.
- Do not remove existing endpoints; extend conservatively.
- Avoid breaking changes to UI layout unless a task explicitly targets layout.

## Debug gating
- Debug/Database UI elements are gated by `YTPPLAY_DEBUG_UI` (default OFF).
  - If the frontend build tool requires a prefix (e.g., `VITE_`), apply it consistently,
    but preserve the semantic name `YTPPLAY_DEBUG_UI` across the stack.

## Testing policy
- Add test cases for any new features.
- Ensure new changes do not break existing tests.
- If tests do not exist for the area, add minimal targeted tests appropriate to the repo.

## Visualizer decisions (locked)
- Do NOT move playback to the browser.
- Playback remains in backend via mpv (unchanged).
- Visualization uses ffmpeg for PCM analysis ONLY while a track is actively playing.
- Visualizer decays smoothly to zero when paused OR when no audio frames arrive (no fake animation).
- Transport: WebSocket (2-way).
- UI renders at 60fps; backend may emit ~30fps; UI draws latest frame.
- Visuals V1: waveform + spectrum.
- Stereo: yes.
- Default view: Case 2 (combined waveform + L/R spectrum); toggle includes Case 1 and Case 2.
- Volume coupling: mpv volume only (for now).
- Volume control: slider inside Now Playing panel.
- Persist per-machine in SQLite: visualizer settings + mpv volume + layout (when implemented).

## Maintenance / documentation
- Update this AGENTS.md as the project grows (paths, architecture notes, conventions).
- Prefer minimal diffs per task; do not refactor unrelated areas.
