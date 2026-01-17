# CODEx Work Queue - ytplay

## How Codex must operate (non-negotiable)
1) Implement ONLY the FIRST unchecked task in "Task Queue".
2) Keep changes minimal and localized to the task.
3) Run the app/tests/lint (whatever exists) and fix issues introduced by the task.
4) Update this file:
   - mark the task [x]
   - add "Implementation notes" under that task: key files changed + important decisions
5) Make ONE git commit after completing each task using the specified commit message.
6) Do NOT start the next task.

## Do-not-do list
- Do not do large refactors unless the current task is specifically a refactor task.
- Do not change UI layout globally unless the task is about layout.
- Do not remove existing endpoints; extend instead.
- Do not move playback to browser.

---

## Visualizer Decisions (locked)
- Transport: WebSocket (2-way)
- UI draw: 60fps rendering ok while ingesting ~30fps frames (draw latest frame)
- Visuals V1: BOTH waveform + spectrum
- Default view: Case 2 (combined waveform + L/R spectrum)
- Toggle includes both Case 1 and Case 2
- Stereo: yes (L/R)
- Pause: triggers smooth decay to zero
- Buffering / missing frames: decay if no audio frames arrive (no fake animation)
- ffmpeg analysis: ONLY while track actively playing
- Volume coupling: mpv volume only (for now)
- Volume control: slider inside Now Playing panel
- Persist per-machine: layout + visualizer settings + mpv volume

---

## Task Queue (execute top to bottom)

### [x] T1 Fix loading prompt bug (sometimes appears at bottom)
Commit: `fix(ui): anchor loading prompt overlay`
Definition of done:
- Loading prompt/overlay is rendered in a global overlay root (portal), position: fixed, correct z-index.
- Never appears at bottom due to layout flow / overflow clipping.
- No layout shift.

Implementation notes:
- `web/index.html`, `web/env.html`: moved app content into `.page-shell` and placed `#overlayRoot` outside the shell.
- `web/app.css`: shifted load-in transitions off `body`, added viewport-fixed noise fade.
- `README.md`: noted that the loading overlay stays fixed to the viewport.

---

### [ ] T2 Persist + restore last session state on startup (queue/search/now-playing)
Commit: `feat(state): restore last session on startup`
Definition of done:
- On restart + first UI load, app restores:
  - last search terms/params
  - queue list + order
  - now playing track (at least identity)
- Stored in DB (single snapshot row is acceptable).
- UI hydrates from backend state (no default overwrite race).

Implementation notes:
- (Codex fills)

---

### [ ] T3 Add debug env var to toggle debug UI features
Commit: `chore(ui): gate debug features by env var`
Definition of done:
- New env var hides debug panel entirely when disabled.
- Default OFF unless enabled.
- Uses correct prefix for your build tool (Codex must detect and apply).

Implementation notes:
- (Codex fills)

---

### [ ] T4 Queue placeholders when background loading + show in-flight AI query details
Commit: `feat(queue): show loading placeholder with ai query`
Definition of done:
- If queue.length < 10 AND backend is generating -> render placeholder queue item(s).
- Placeholder shows AI query params being sent (compact JSON or key/value).
- Placeholder disappears when generation ends or queue >= 10.
- Backend exposes `is_generating` + `current_query` in a status endpoint or within /state.

Implementation notes:
- (Codex fills)

---

### [ ] T5 Queue reorder (drag/drop or buttons) + persist order
Commit: `feat(queue): enable reorder and persist`
Definition of done:
- User can reorder queue items in UI.
- Backend updates queue order as source of truth.
- Order persists across refresh + restart (ties into T2 snapshot).
- “Now Playing” handling is consistent (Codex must choose and document).

Implementation notes:
- (Codex fills)

---

### [ ] T6 Database tables panel in right column (accordion + latest 10 + paging)
Commit: `feat(db): add tables panel with paging`
Definition of done:
- Right column has Database panel listing DB tables.
- Accordion expands table to show latest 10 rows in grid.
- Refresh/Next/Back works (server-driven paging).
- Safe table name validation.

Implementation notes:
- (Codex fills)

---

### [ ] T7 WebSocket infrastructure (backend + UI client) for real-time streams
Commit: `feat(ws): add realtime channel for ui`
Definition of done:
- Backend hosts a WebSocket endpoint.
- UI connects and handles reconnect.
- No breaking changes to existing REST polling.

Implementation notes:
- (Codex fills)

---

### [ ] T8 Visualizer backend: ffmpeg PCM analysis while playing + stream viz frames over WS
Commit: `feat(viz): stream fft+waveform frames from backend`
Definition of done:
- When a track is actively playing, backend starts ffmpeg analysis process for current track only.
- Computes: L/R spectrum bins + combined waveform + levels (rms/peak).
- Streams frames over WebSocket at stable rate.
- When paused or no frames -> backend stops analysis and/or emits “no-frame” (UI will decay).

Implementation notes:
- (Codex fills)

---

### [ ] T9 Visualizer UI panel: render spectrum + waveform + decay behavior + stereo toggle
Commit: `feat(viz-ui): add visualizer panel with stereo toggle`
Definition of done:
- Dedicated Visualizer panel always visible.
- Default view Case 2 (combined waveform + L/R spectrum).
- Toggle to Case 1 supported.
- Smooth decay to zero on pause or missing frames.
- Debug mode shows configurable options (bars count, etc.).

Implementation notes:
- (Codex fills)

---

### [ ] T10 Now Playing panel: add mpv volume slider (persist per-machine)
Commit: `feat(player): add mpv volume slider and persist`
Definition of done:
- Volume slider in Now Playing.
- Slider controls mpv volume via IPC.
- Volume reflected in state and persisted (restored on startup).
- Visualizer scales with mpv volume.

Implementation notes:
- (Codex fills)

---

### [ ] T11 Persist per-machine UI layout + panel rearrange (fluid UI)
Commit: `feat(layout): rearrange panels and persist layout`
Definition of done:
- UI panels can be rearranged (drag/drop).
- Layout saved in DB (per-machine) and restored on startup.
- Visualizer panel participates in layout.
- Keep implementation simple; avoid heavy refactor unless needed.

Implementation notes:
- (Codex fills)

---

### [ ] T12 Modularize frontend + backend into maintainable components/services
Commit: `refactor: modularize ui and backend services`
Definition of done:
- Frontend: extract panels/components into separate files (queue list/item, search, debug, db, viz, now playing).
- Backend: split routes/services/state management cleanly.
- No behavior regressions.

Implementation notes:
- (Codex fills)
