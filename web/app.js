const el = (id) => document.getElementById(id);

const statusDot = el("statusDot");
const statusText = el("statusText");
const authPill = el("authPill");
const queueList = el("queueList");
const queueCount = el("queueCount");
const currentTitle = el("currentTitle");
const currentArtist = el("currentArtist");
const currentMeta = el("currentMeta");
const currentArt = el("currentArt");
const promptLine = el("promptLine");
const requestState = el("requestState");
const lastUpdated = el("lastUpdated");
const loadingOverlay = el("loadingOverlay");
const loadingText = el("loadingText");
const loadingLog = el("loadingLog");
const debugPanel = el("debugPanel");
const debugPanelWrap = el("debugPanelWrap");
const sidePanels = el("sidePanels");
const dbPanel = el("dbPanel");
const dbTables = el("dbTables");
const dbStatus = el("dbStatus");
const progressInput = el("progressInput");
const progressElapsed = el("progressElapsed");
const progressDuration = el("progressDuration");
const progressWrap = el("progressWrap");

const promptForm = el("promptForm");
const promptInput = el("promptInput");
const seedInput = el("seedInput");
const moodInput = el("moodInput");
const langInput = el("langInput");
const avoidInput = el("avoidInput");
const maxInput = el("maxInput");
const ttlInput = el("ttlInput");
const mixInput = el("mixInput");
const vibeInput = el("vibeInput");

const prevBtn = el("prevBtn");
const pauseBtn = el("pauseBtn");
const nextBtn = el("nextBtn");
const stopBtn = el("stopBtn");
const likeBtn = el("likeBtn");
const dislikeBtn = el("dislikeBtn");
const refreshBtn = el("refreshBtn");
const clearBtn = el("clearBtn");
const recurateBtn = el("recurateBtn");
const queueRefreshBtn = el("queueRefreshBtn");
const learningWrap = el("learningWrap");
const learnScore = el("learnScore");
const learnScoreValue = el("learnScoreValue");
const learnEnergy = el("learnEnergy");
const learnTempo = el("learnTempo");
const learnSaveBtn = el("learnSaveBtn");
const learningStatus = el("learningStatus");

let currentTrack = null;
const API_TIMEOUT_MS = 10000;
const STATE_TIMEOUT_MS = 5000;
const PLAY_TIMEOUT_MS = 120000;
const QUEUE_WINDOW = 10;
const DB_PAGE_SIZE = 10;
const STATE_STORAGE_KEY = "ytplay:last_state";

let hasLoaded = false;
let hasAttempted = false;
let loadingCount = 0;
let lastState = null;
let loadingCycle = null;
let loadingHistory = [];
let loadingIndex = 0;
let isSeeking = false;
let lastSeekAt = 0;
let controlController = null;
let controlSeq = 0;
let lastLearningTrackId = null;
let learningDirty = false;
let progressPoll = null;
let progressLastId = 0;
let progressActive = false;
let debugUiEnabled = false;
let dbTablesLoaded = false;
let dbTablesLoading = false;

const dbCache = new Map();
const dbTableState = new Map();
const dbTableEls = new Map();
const dbTableSeq = new Map();
const dbColumnWidths = new Map();

const LOADING_MESSAGES = [
  "Warming up the curator...",
  "Scanning the stack...",
  "Picking the next track...",
  "Resolving stream URLs...",
  "Syncing the queue...",
  "Tuning the vibe...",
];

function renderLoadingLog() {
  if (!loadingLog) return;
  loadingLog.innerHTML = "";
  loadingHistory.forEach((msg, idx) => {
    const line = document.createElement("div");
    line.className = "loading-log-line";
    if (idx === 0) {
      line.classList.add("is-latest");
    }
    line.textContent = msg;
    loadingLog.appendChild(line);
  });
}

function pushLoadingMessage(text) {
  const msg = String(text || "").trim();
  if (!msg) return;
  if (loadingHistory[0] === msg) return;
  loadingHistory.unshift(msg);
  loadingHistory = loadingHistory.slice(0, 4);
  renderLoadingLog();
}

function setLoadingMessage(text) {
  if (loadingText) {
    loadingText.textContent = text;
  }
  pushLoadingMessage(text);
}

function startLoadingCycle() {
  if (loadingCycle) return;
  loadingCycle = setInterval(() => {
    const msg = LOADING_MESSAGES[loadingIndex % LOADING_MESSAGES.length];
    loadingIndex += 1;
    setLoadingMessage(msg);
  }, 1400);
}

function stopLoadingCycle(reset = true) {
  if (loadingCycle) {
    clearInterval(loadingCycle);
    loadingCycle = null;
  }
  loadingIndex = 0;
  if (reset) {
    loadingHistory = [];
    renderLoadingLog();
  }
}

function setLoading(active, text) {
  if (active) {
    const wasIdle = loadingCount === 0;
    loadingCount += 1;
    if (text) {
      setLoadingMessage(text);
    }
    loadingOverlay.classList.add("is-active");
    if (wasIdle) {
      startLoadingCycle();
      startProgressPoll();
    }
  } else {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) {
      loadingOverlay.classList.remove("is-active");
      stopLoadingCycle();
      stopProgressPoll();
    }
  }
}

function setStatus(ok, text) {
  statusText.textContent = text;
  statusDot.classList.toggle("ok", ok);
}

function setRequestState(text, isError = false) {
  requestState.textContent = text;
  requestState.classList.toggle("error", isError);
}

function beginControlRequest() {
  if (controlController) {
    controlController.abort();
  }
  controlController = new AbortController();
  controlSeq += 1;
  return { signal: controlController.signal, seq: controlSeq };
}

function isAbortError(err) {
  return err && err.message === "request aborted";
}

function applyProgressLines(lines) {
  if (!Array.isArray(lines)) return;
  const newLines = lines.filter(
    (line) => line && typeof line.id === "number" && line.id > progressLastId
  );
  if (!newLines.length) return;
  if (!progressActive) {
    progressActive = true;
    stopLoadingCycle(false);
  }
  newLines.forEach((line) => {
    if (line && line.msg) {
      pushLoadingMessage(line.msg);
    }
  });
  const latest = newLines[newLines.length - 1];
  if (latest && latest.msg && loadingText) {
    loadingText.textContent = latest.msg;
  }
  if (latest && typeof latest.id === "number") {
    progressLastId = Math.max(progressLastId, latest.id);
  }
}

async function refreshProgress(reset = false) {
  try {
    const data = await api("/progress", {}, STATE_TIMEOUT_MS);
    if (!data || !Array.isArray(data.lines)) return;
    if (reset) {
      if (typeof data.latest_id === "number") {
        progressLastId = data.latest_id;
      }
      return;
    }
    applyProgressLines(data.lines);
    if (typeof data.latest_id === "number" && data.latest_id > progressLastId) {
      progressLastId = data.latest_id;
    }
  } catch (err) {
    return;
  }
}

function startProgressPoll() {
  if (progressPoll) return;
  progressActive = false;
  refreshProgress(true);
  progressPoll = setInterval(() => refreshProgress(false), 1200);
}

function stopProgressPoll() {
  if (progressPoll) {
    clearInterval(progressPoll);
    progressPoll = null;
  }
  progressLastId = 0;
  progressActive = false;
}

function setLearningStatus(text, isError = false) {
  if (!learningStatus) return;
  learningStatus.textContent = text;
  learningStatus.classList.toggle("error", isError);
}

function setLearningEnabled(enabled) {
  if (learningWrap) {
    learningWrap.classList.toggle("is-disabled", !enabled);
  }
  if (learnScore) learnScore.disabled = !enabled;
  if (learnEnergy) learnEnergy.disabled = !enabled;
  if (learnTempo) learnTempo.disabled = !enabled;
  if (learnSaveBtn) learnSaveBtn.disabled = !enabled;
}

function markLearningDirty() {
  learningDirty = true;
  setLearningStatus("unsaved", false);
}

function renderLearning(track, learning) {
  if (!learnScore || !learnEnergy || !learnTempo) return;
  const trackId = track && track.videoId ? track.videoId : null;
  const hasTrack = Boolean(trackId);
  setLearningEnabled(hasTrack);
  if (!hasTrack) {
    lastLearningTrackId = null;
    learningDirty = false;
    learnScore.value = "50";
    if (learnScoreValue) {
      learnScoreValue.textContent = "50%";
    }
    learnEnergy.value = "";
    learnTempo.value = "";
    setLearningStatus("no track", false);
    return;
  }
  if (trackId === lastLearningTrackId && learningDirty) {
    return;
  }
  lastLearningTrackId = trackId;
  const scoreValue =
    learning && typeof learning.score === "number" ? Math.round(learning.score * 100) : 50;
  learnScore.value = String(scoreValue);
  if (learnScoreValue) {
    learnScoreValue.textContent = `${scoreValue}%`;
  }
  learnEnergy.value = (learning && learning.energy) || "";
  learnTempo.value = (learning && learning.tempo) || "";
  learningDirty = false;
  setLearningStatus(learning ? "saved" : "unsaved", false);
}

function formatTrack(track) {
  if (!track) return "-";
  const title = track.title || "Unknown";
  const artist = track.artist || "Unknown";
  return `${title} - ${artist}`;
}

function formatTime(totalSeconds) {
  if (typeof totalSeconds !== "number" || Number.isNaN(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }
  const seconds = Math.floor(totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function renderProgress(position, duration) {
  if (!progressInput || !progressElapsed || !progressDuration) return;
  const hasDuration = typeof duration === "number" && duration > 0 && Number.isFinite(duration);
  const safePos = typeof position === "number" && position >= 0 && Number.isFinite(position) ? position : 0;
  if (!hasDuration) {
    progressInput.disabled = true;
    progressInput.max = "0";
    progressInput.value = "0";
    progressInput.style.setProperty("--progress", "0%");
    progressElapsed.textContent = "0:00";
    progressDuration.textContent = "0:00";
    return;
  }
  const max = Math.floor(duration);
  const value = Math.min(Math.floor(safePos), max);
  progressInput.disabled = false;
  progressInput.max = String(max);
  if (!isSeeking) {
    progressInput.value = String(value);
  }
  const percent = max > 0 ? (value / max) * 100 : 0;
  progressInput.style.setProperty("--progress", `${percent}%`);
  progressElapsed.textContent = formatTime(isSeeking ? Number(progressInput.value) : value);
  progressDuration.textContent = formatTime(max);
}

function setArt(imgEl, url) {
  if (!imgEl) return;
  const wrapper = imgEl.parentElement;
  if (url) {
    imgEl.src = url;
    imgEl.alt = "cover art";
    if (wrapper) wrapper.classList.remove("is-empty");
  } else {
    imgEl.removeAttribute("src");
    imgEl.alt = "";
    if (wrapper) wrapper.classList.add("is-empty");
  }
}

function renderNowPlaying(current, paused, index) {
  currentTrack = current;
  if (!current) {
    currentTitle.textContent = "-";
    currentArtist.textContent = "-";
    currentMeta.textContent = paused ? "paused" : "playlist idle";
    setArt(currentArt, "");
    return;
  }
  currentTitle.textContent = current.title || "Unknown";
  currentArtist.textContent = current.artist || "Unknown";
  const status = paused ? "paused" : "playing";
  currentMeta.textContent = `track ${index + 1} - ${status}`;
  setArt(currentArt, current.thumbnail || "");
}

function renderPromptLine(prompt, seed) {
  if (!prompt) {
    promptLine.textContent = "Prompt: -";
    return;
  }
  if (seed && seed.title) {
    promptLine.textContent = `Prompt: ${prompt} (seed: ${formatTrack(seed)})`;
  } else {
    promptLine.textContent = `Prompt: ${prompt}`;
  }
}

function storeState(data) {
  try {
    const payload = { saved_at: Date.now(), data };
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    return;
  }
}

function loadStoredState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function applyState(data, options = {}) {
  const previous = lastState;
  lastState = data;
  if (!options.cached) {
    setDebugUiEnabled(Boolean(data && data.debug_ui));
  }
  const currentIndex = typeof data.current_index === "number" ? data.current_index : 0;
  const source =
    data &&
    data.debug &&
    data.debug.curation_source &&
    String(data.debug.curation_source).toLowerCase() === "llm"
      ? "openai"
      : "fallback";
  renderQueue(data.queue, currentIndex, previous && previous.queue, source);
  renderNowPlaying(data.current, data.paused, currentIndex);
  renderLearning(data.current, data.learning);
  renderProgress(data.position, data.duration);
  renderPromptLine(data.prompt, data.seed);
  if (debugPanel) {
    if (data.debug && Object.keys(data.debug).length > 0) {
      debugPanel.textContent = JSON.stringify(data.debug, null, 2);
    } else {
      debugPanel.textContent = "No debug info yet.";
    }
  }
  if (pauseBtn) {
    pauseBtn.classList.toggle("is-paused", Boolean(data.paused));
    const label = pauseBtn.querySelector(".btn-label");
    if (label) {
      //label.textContent = data.paused ? "resume" : "pause";
    }
  }
  if (authPill) {
    authPill.textContent = data.auth ? "auth: on" : "auth: off";
  }
  if (lastUpdated) {
    const stamp = options.savedAt ? new Date(options.savedAt) : new Date();
    const label = options.cached ? "restored" : "last updated";
    lastUpdated.textContent = `${label}: ${stamp.toLocaleTimeString()}`;
  }
}

function normalizeSource(source) {
  return source === "openai" ? "openai" : "fallback";
}

function setDebugUiEnabled(enabled) {
  const show = Boolean(enabled);
  debugUiEnabled = show;
  if (debugPanelWrap) {
    debugPanelWrap.style.display = show ? "" : "none";
  }
  if (sidePanels) {
    sidePanels.style.display = show ? "" : "none";
  }
  if (dbPanel) {
    dbPanel.style.display = show ? "" : "none";
  }
  if (show && !dbTablesLoaded) {
    loadDbTables();
  }
}

function setDbStatus(text, isError = false) {
  if (!dbStatus) return;
  dbStatus.textContent = text;
  dbStatus.classList.toggle("error", isError);
}

function formatDbValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.stringify(JSON.parse(trimmed));
      } catch (err) {
        return value;
      }
    }
    return value;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }
  return String(value);
}

function trimDbValue(text, maxLen = 140) {
  const value = String(text);
  if (value.length > maxLen) {
    return { text: `${value.slice(0, maxLen - 3)}...`, truncated: true };
  }
  return { text: value, truncated: false };
}

function dbCacheKey(table, offset, limit) {
  return `${table}:${offset}:${limit}`;
}

function getDbColumnWidth(table, column) {
  const tableMap = dbColumnWidths.get(table);
  if (!tableMap) return null;
  return tableMap.get(column) || null;
}

function setDbColumnWidth(table, column, width) {
  let tableMap = dbColumnWidths.get(table);
  if (!tableMap) {
    tableMap = new Map();
    dbColumnWidths.set(table, tableMap);
  }
  tableMap.set(column, width);
}

function startDbColumnResize(event, table, column, colEl) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startWidth = colEl.getBoundingClientRect().width;
  const minWidth = 80;
  document.body.classList.add("db-resizing");

  function onMove(moveEvent) {
    const delta = moveEvent.clientX - startX;
    const nextWidth = Math.max(minWidth, Math.round(startWidth + delta));
    colEl.style.width = `${nextWidth}px`;
    setDbColumnWidth(table, column, nextWidth);
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.classList.remove("db-resizing");
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function setDbContentMessage(content, message, className) {
  content.innerHTML = "";
  const el = document.createElement("div");
  el.className = className;
  el.textContent = message;
  content.appendChild(el);
}

function renderDbError(content, message, onRetry) {
  content.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "db-error";
  const text = document.createElement("div");
  text.textContent = message;
  const retry = document.createElement("button");
  retry.className = "btn ghost tiny";
  retry.type = "button";
  retry.textContent = "retry";
  retry.addEventListener("click", onRetry);
  wrap.appendChild(text);
  wrap.appendChild(retry);
  content.appendChild(wrap);
}

function updateDbControls(table, rows, total, offset, limit, loading) {
  const elements = dbTableEls.get(table);
  if (!elements) return;
  const page = Math.floor(offset / limit) + 1;
  let status = loading ? "loading..." : `showing ${rows.length} rows | page ${page}`;
  if (typeof total === "number") {
    const pages = Math.max(1, Math.ceil(total / limit));
    status = `${status} of ${pages}`;
  }
  elements.status.textContent = status;
  elements.refreshBtn.disabled = loading;
  elements.prevBtn.disabled = loading || offset <= 0;
  elements.nextBtn.disabled =
    loading || (typeof total === "number" && offset + limit >= total);
}

function renderDbGrid(content, table, columns, rows) {
  content.innerHTML = "";
  const grid = document.createElement("table");
  grid.className = "db-grid";
  const colgroup = document.createElement("colgroup");
  const colEls = [];
  columns.forEach((col) => {
    const colEl = document.createElement("col");
    const width = getDbColumnWidth(table, col);
    if (width) {
      colEl.style.width = `${width}px`;
    }
    colgroup.appendChild(colEl);
    colEls.push(colEl);
  });
  grid.appendChild(colgroup);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((col, index) => {
    const th = document.createElement("th");
    th.textContent = col;
    const resizer = document.createElement("span");
    resizer.className = "db-resizer";
    resizer.addEventListener("mousedown", (event) =>
      startDbColumnResize(event, table, col, colEls[index])
    );
    th.appendChild(resizer);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    columns.forEach((col) => {
      const td = document.createElement("td");
      const raw = row ? row[col] : "";
      const formatted = formatDbValue(raw);
      const trimmed = trimDbValue(formatted);
      td.textContent = trimmed.text;
      if (trimmed.truncated) {
        td.title = formatted;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  grid.appendChild(thead);
  grid.appendChild(tbody);
  content.appendChild(grid);
}

async function loadDbRows(table, options = {}) {
  const elements = dbTableEls.get(table);
  if (!elements) return;
  const limit = DB_PAGE_SIZE;
  const offset = Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;
  const refresh = Boolean(options.refresh);
  const cacheKey = dbCacheKey(table, offset, limit);
  const currentState = dbTableState.get(table);

  if (!refresh && dbCache.has(cacheKey)) {
    const cached = dbCache.get(cacheKey);
    const rows = Array.isArray(cached.rows) ? cached.rows : [];
    const columns = Array.isArray(cached.columns) ? cached.columns : [];
    dbTableState.set(table, { offset, limit, total: cached.total });
    if (!rows.length) {
      setDbContentMessage(elements.content, "No records found.", "db-empty");
    } else {
      renderDbGrid(elements.content, table, columns, rows);
    }
    updateDbControls(table, rows, cached.total, offset, limit, false);
    return;
  }

  const seq = (dbTableSeq.get(table) || 0) + 1;
  dbTableSeq.set(table, seq);
  setDbContentMessage(elements.content, "Loading...", "db-loading");
  updateDbControls(
    table,
    [],
    currentState ? currentState.total : undefined,
    offset,
    limit,
    true
  );
  try {
    const data = await api(`/api/db/table/${encodeURIComponent(table)}/rows`, {
      limit,
      offset,
    });
    if (dbTableSeq.get(table) !== seq) return;
    dbCache.set(cacheKey, data);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const columns = Array.isArray(data.columns) ? data.columns : [];
    dbTableState.set(table, { offset, limit, total: data.total });
    if (!rows.length) {
      setDbContentMessage(elements.content, "No records found.", "db-empty");
    } else {
      renderDbGrid(elements.content, table, columns, rows);
    }
    updateDbControls(table, rows, data.total, offset, limit, false);
  } catch (err) {
    if (dbTableSeq.get(table) !== seq) return;
    renderDbError(elements.content, err.message || "Failed to load rows.", () =>
      loadDbRows(table, { offset, refresh: true })
    );
    updateDbControls(
      table,
      [],
      currentState ? currentState.total : undefined,
      offset,
      limit,
      false
    );
  }
}

function createDbTableItem(table) {
  const details = document.createElement("details");
  details.className = "db-table";
  details.dataset.table = table;

  const summary = document.createElement("summary");
  summary.className = "db-summary";

  const left = document.createElement("div");
  left.className = "db-summary-left";

  const caret = document.createElement("span");
  caret.className = "db-caret";
  caret.textContent = ">";

  const title = document.createElement("span");
  title.className = "db-title";
  title.textContent = table;

  left.appendChild(caret);
  left.appendChild(title);

  const hint = document.createElement("span");
  hint.className = "db-hint";
  hint.textContent = `latest ${DB_PAGE_SIZE}`;

  summary.appendChild(left);
  summary.appendChild(hint);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "db-body";

  const controls = document.createElement("div");
  controls.className = "db-controls";

  const status = document.createElement("div");
  status.className = "db-status";
  status.textContent = "not loaded";

  const buttons = document.createElement("div");
  buttons.className = "db-buttons";

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn ghost tiny";
  refreshBtn.type = "button";
  refreshBtn.textContent = "refresh";

  const prevBtn = document.createElement("button");
  prevBtn.className = "btn ghost tiny";
  prevBtn.type = "button";
  prevBtn.textContent = "newer";

  const nextBtn = document.createElement("button");
  nextBtn.className = "btn ghost tiny";
  nextBtn.type = "button";
  nextBtn.textContent = "older";

  buttons.appendChild(refreshBtn);
  buttons.appendChild(prevBtn);
  buttons.appendChild(nextBtn);
  controls.appendChild(status);
  controls.appendChild(buttons);

  const content = document.createElement("div");
  content.className = "db-content";

  body.appendChild(controls);
  body.appendChild(content);
  details.appendChild(body);

  details.addEventListener("toggle", () => {
    if (!details.open) return;
    const state = dbTableState.get(table) || { offset: 0, limit: DB_PAGE_SIZE };
    loadDbRows(table, { offset: state.offset, refresh: false });
  });

  refreshBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const state = dbTableState.get(table) || { offset: 0, limit: DB_PAGE_SIZE };
    loadDbRows(table, { offset: state.offset, refresh: true });
  });

  prevBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const state = dbTableState.get(table) || { offset: 0, limit: DB_PAGE_SIZE };
    const nextOffset = Math.max(0, state.offset - state.limit);
    loadDbRows(table, { offset: nextOffset, refresh: false });
  });

  nextBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const state = dbTableState.get(table) || { offset: 0, limit: DB_PAGE_SIZE };
    const nextOffset = state.offset + state.limit;
    if (typeof state.total === "number" && nextOffset >= state.total) {
      return;
    }
    loadDbRows(table, { offset: nextOffset, refresh: false });
  });

  dbTableEls.set(table, {
    details,
    status,
    content,
    refreshBtn,
    prevBtn,
    nextBtn,
  });
  return details;
}

function renderDbTables(tables) {
  if (!dbTables) return;
  dbTables.innerHTML = "";
  tables.forEach((table) => {
    const item = createDbTableItem(table);
    dbTables.appendChild(item);
  });
}

async function loadDbTables() {
  if (!dbPanel || !dbTables) return;
  if (!debugUiEnabled) return;
  if (dbTablesLoading) return;
  dbTablesLoading = true;
  setDbStatus("loading...");
  dbTables.innerHTML = "";
  try {
    const data = await api("/api/db/tables");
    const tables = Array.isArray(data.tables) ? data.tables : [];
    if (!tables.length) {
      setDbStatus("empty");
      setDbContentMessage(dbTables, "No tables found.", "db-empty");
      dbTablesLoaded = true;
      return;
    }
    setDbStatus("ready");
    renderDbTables(tables);
    dbTablesLoaded = true;
  } catch (err) {
    setDbStatus("error", true);
    dbTables.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "db-error";
    const text = document.createElement("div");
    text.textContent = err.message || "Failed to load tables.";
    const retry = document.createElement("button");
    retry.className = "btn ghost tiny";
    retry.type = "button";
    retry.textContent = "retry";
    retry.addEventListener("click", () => loadDbTables());
    wrap.appendChild(text);
    wrap.appendChild(retry);
    dbTables.appendChild(wrap);
  } finally {
    dbTablesLoading = false;
  }
}

function renderQueue(queue, currentIndex, previousQueue, defaultSource) {
  queueList.innerHTML = "";
  if (!queue || queue.length === 0) {
    queueCount.textContent = "0 tracks";
    const empty = document.createElement("li");
    empty.className = "queue-empty";
    empty.textContent = "queue empty";
    queueList.appendChild(empty);
    return;
  }
  const startIndex = typeof currentIndex === "number" && currentIndex >= 0 ? currentIndex : 0;
  const visible = queue.slice(startIndex, startIndex + QUEUE_WINDOW);
  const prevIds = new Set((previousQueue || []).map((track) => track.videoId));
  queueCount.textContent = `${visible.length} of ${queue.length}`;
  visible.forEach((track, offset) => {
    const globalIndex = startIndex + offset;
    const li = document.createElement("li");
    li.dataset.index = String(globalIndex);
    li.setAttribute("role", "button");
    li.tabIndex = 0;
    if (globalIndex === currentIndex) {
      li.classList.add("is-current");
    }
    if (!prevIds.has(track.videoId)) {
      li.classList.add("is-new");
    }
    const index = document.createElement("div");
    index.className = "queue-index";
    index.textContent = String(globalIndex + 1).padStart(2, "0");
    const art = document.createElement("div");
    art.className = "queue-art";
    if (!track.thumbnail) {
      art.classList.add("is-empty");
    }
    const img = document.createElement("img");
    if (track.thumbnail) {
      img.src = track.thumbnail;
      img.alt = track.title || "cover art";
    }
    art.appendChild(img);
    const content = document.createElement("div");
    content.className = "queue-content";
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = track.title || "Unknown";
    const artist = document.createElement("div");
    artist.className = "queue-artist";
    artist.textContent = track.artist || "Unknown";
    const tags = document.createElement("div");
    tags.className = "queue-tags";
    const status = document.createElement("span");
    status.className = "queue-tag status";
    status.textContent = globalIndex === currentIndex ? "now" : "next";
    const source = normalizeSource(track.curation || defaultSource);
    const sourceTag = document.createElement("span");
    sourceTag.className = `queue-tag source is-${source}`;
    sourceTag.textContent = source === "openai" ? "ai" : "fallback";
    tags.appendChild(status);
    tags.appendChild(sourceTag);
    content.appendChild(title);
    content.appendChild(artist);
    content.appendChild(tags);
    li.appendChild(index);
    li.appendChild(art);
    li.appendChild(content);
    queueList.appendChild(li);
  });
}


async function api(path, params = {}, timeoutMs = API_TIMEOUT_MS, options = {}) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      url.searchParams.set(key, value);
    }
  });
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || "request failed");
    }
    return data;
  } catch (err) {
    if (err && err.name === "AbortError") {
      if (options.signal && options.signal.aborted) {
        throw new Error("request aborted");
      }
      throw new Error("request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function refreshState(options = {}) {
  const showLoading = !hasAttempted;
  try {
    if (showLoading) {
      setLoading(true, "Connecting...");
    }
    const data = await api("/state", {}, STATE_TIMEOUT_MS, options.signal ? { signal: options.signal } : {});
    if (options.guardSeq && options.guardSeq !== controlSeq) {
      return;
    }
    setStatus(true, "daemon online");
    applyState(data);
    storeState(data);
    hasLoaded = true;
  } catch (err) {
    if (isAbortError(err)) {
      return;
    }
    setStatus(false, "daemon offline");
    currentMeta.textContent = "daemon not reachable";
    if (debugPanel) {
      debugPanel.textContent = "daemon offline";
    }
  } finally {
    if (showLoading) {
      setLoading(false);
    }
    hasAttempted = true;
  }
}

function buildPlayParams(useFallback) {
  const fallback = (lastState && lastState.extras) || {};
  const prompt = promptInput.value.trim() || (useFallback ? (lastState && lastState.prompt) : "");
  if (!prompt) {
    setRequestState("missing prompt", true);
    return null;
  }
  return {
    q: prompt,
    seed: seedInput.value.trim() || (useFallback ? (fallback.seed || "") : ""),
    mood: moodInput.value.trim() || (useFallback ? (fallback.mood || "") : ""),
    lang: langInput.value.trim() || (useFallback ? (fallback.lang || "") : ""),
    avoid: avoidInput.value.trim() || (useFallback ? (fallback.avoid || []).join(",") : ""),
    mix: mixInput.value.trim() || (useFallback ? (fallback.mix || "") : ""),
    vibe: vibeInput.value.trim() || (useFallback ? (fallback.vibe || "") : ""),
    n: maxInput.value.trim() || (useFallback ? (fallback.max_tracks || "") : ""),
    ttl: ttlInput.value.trim() || (useFallback ? (fallback.ttl_hours || "") : ""),
  };
}

async function playWithParams(params, label) {
  if (!params) return;
  setRequestState(label, false);
  try {
    setLoading(true, "Curating...");
    const data = await api("/play", params, PLAY_TIMEOUT_MS);
    setRequestState(`playing ${data.count} tracks`, false);
    renderQueue(data.queue, 0, null, "fallback");
    renderPromptLine(data.prompt, data.seed);
    await refreshState();
  } catch (err) {
    setRequestState(err.message || "request failed", true);
  } finally {
    setLoading(false);
  }
}

async function submitPlay(event) {
  event.preventDefault();
  await playWithParams(buildPlayParams(false), "curating...");
}

async function recuratePlay() {
  await playWithParams(buildPlayParams(true), "re-curating...");
}

async function runControl(path, params, label) {
  const request = beginControlRequest();
  setRequestState(label, false);
  try {
    await api(path, params, API_TIMEOUT_MS, { signal: request.signal });
    if (request.seq !== controlSeq) {
      return;
    }
    await refreshState({ signal: request.signal, guardSeq: request.seq });
    if (request.seq !== controlSeq) {
      return;
    }
    setRequestState("idle", false);
  } catch (err) {
    if (isAbortError(err) || request.seq !== controlSeq) {
      return;
    }
    setRequestState(err.message || "request failed", true);
  }
}

async function sendControl(path, label) {
  await runControl(path, {}, label);
}

function clearForm() {
  promptInput.value = "";
  seedInput.value = "";
  moodInput.value = "";
  langInput.value = "";
  avoidInput.value = "";
  maxInput.value = "";
  ttlInput.value = "";
  mixInput.value = "";
  vibeInput.value = "normal";
}

async function playIndex(index) {
  await runControl("/play_index", { i: index }, `playing #${index + 1}`);
}

async function voteCurrent(voteValue) {
  if (!currentTrack || !currentTrack.videoId) {
    setRequestState("no track to vote", true);
    return;
  }
  setRequestState(voteValue > 0 ? "liked" : "disliked", false);
  try {
    await api("/vote", {
      id: currentTrack.videoId,
      v: voteValue,
      title: currentTrack.title || "",
      artist: currentTrack.artist || "",
    });
  } catch (err) {
    setRequestState(err.message || "vote failed", true);
  }
}

async function saveLearning() {
  if (!currentTrack || !currentTrack.videoId) {
    setLearningStatus("no track", true);
    return;
  }
  const scoreValue = learnScore ? Number(learnScore.value) : NaN;
  const payload = {
    id: currentTrack.videoId,
    title: currentTrack.title || "",
    artist: currentTrack.artist || "",
    score: Number.isNaN(scoreValue) ? "" : scoreValue,
    energy: learnEnergy ? learnEnergy.value : "",
    tempo: learnTempo ? learnTempo.value : "",
  };
  setLearningStatus("saving...", false);
  try {
    await api("/learn", payload);
    learningDirty = false;
    setLearningStatus("saved", false);
  } catch (err) {
    if (isAbortError(err)) {
      return;
    }
    setLearningStatus(err.message || "save failed", true);
  }
}

function addStagger() {
  const panels = document.querySelectorAll("[data-stagger]");
  panels.forEach((panel, idx) => {
    panel.style.setProperty("--delay", `${idx * 0.08}s`);
  });
}

function initProgressControls() {
  if (!progressInput || !progressWrap) return;
  progressInput.addEventListener("input", () => {
    isSeeking = true;
    const max = Number(progressInput.max);
    const value = Number(progressInput.value);
    const percent = max > 0 ? (value / max) * 100 : 0;
    progressInput.style.setProperty("--progress", `${percent}%`);
    if (progressElapsed) {
      progressElapsed.textContent = formatTime(value);
    }
  });
  progressInput.addEventListener("change", async () => {
    const value = Number(progressInput.value);
    isSeeking = false;
    if (!Number.isNaN(value)) {
      try {
        await api("/seek", { pos: value });
      } catch (err) {
        setRequestState(err.message || "seek failed", true);
      }
    }
  });
  progressWrap.addEventListener(
    "wheel",
    async (event) => {
      if (!progressInput || progressInput.disabled) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastSeekAt < 200) return;
      lastSeekAt = now;
      const delta = event.deltaY > 0 ? 5 : -5;
      try {
        await api("/seek", { delta });
      } catch (err) {
        setRequestState(err.message || "seek failed", true);
      }
    },
    { passive: false }
  );
}

document.addEventListener("DOMContentLoaded", () => {
  addStagger();
  initProgressControls();
  setDebugUiEnabled(false);
  document.body.classList.add("is-ready");
  const cached = loadStoredState();
  if (cached && cached.data) {
    applyState(cached.data, { cached: true, savedAt: cached.saved_at });
    setStatus(false, "restored");
    hasLoaded = true;
    hasAttempted = true;
  }
  promptForm.addEventListener("submit", submitPlay);
  if (prevBtn) {
    prevBtn.addEventListener("click", () => sendControl("/prev", "previous track"));
  }
  pauseBtn.addEventListener("click", () => sendControl("/pause", "toggling pause"));
  nextBtn.addEventListener("click", () => sendControl("/next", "skipping"));
  stopBtn.addEventListener("click", () => sendControl("/stop", "stopping"));
  likeBtn.addEventListener("click", () => voteCurrent(1));
  dislikeBtn.addEventListener("click", () => voteCurrent(-1));
  if (learnScore) {
    learnScore.addEventListener("input", () => {
      if (learnScoreValue) {
        learnScoreValue.textContent = `${learnScore.value}%`;
      }
      markLearningDirty();
    });
  }
  if (learnEnergy) {
    learnEnergy.addEventListener("change", () => markLearningDirty());
  }
  if (learnTempo) {
    learnTempo.addEventListener("change", () => markLearningDirty());
  }
  if (learnSaveBtn) {
    learnSaveBtn.addEventListener("click", () => saveLearning());
  }
  refreshBtn.addEventListener("click", () => refreshState());
  if (queueRefreshBtn) {
    queueRefreshBtn.addEventListener("click", () => refreshState());
  }
  if (recurateBtn) {
    recurateBtn.addEventListener("click", () => recuratePlay());
  }
  clearBtn.addEventListener("click", () => clearForm());
  queueList.addEventListener("click", (event) => {
    const target = event.target.closest("li[data-index]");
    if (!target) return;
    const index = Number(target.dataset.index);
    if (!Number.isNaN(index)) {
      playIndex(index);
    }
  });
  queueList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest("li[data-index]");
    if (!target) return;
    event.preventDefault();
    const index = Number(target.dataset.index);
    if (!Number.isNaN(index)) {
      playIndex(index);
    }
  });
  refreshState();
  setInterval(refreshState, 5000);
});
