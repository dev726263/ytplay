import { api } from "./api/client.js";
import {
  API_TIMEOUT_MS,
  PLAY_TIMEOUT_MS,
  STATE_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
} from "./app/constants.js";
import { el } from "./components/common/dom.js";
import { loadStoredState, storeState } from "./components/common/storage.js";
import { setLoading } from "./components/loading/loading-overlay.js";
import { renderQueue } from "./components/queue/queue-panel.js";
import {
  initProgressControls,
  renderNowPlaying,
  renderProgress,
} from "./components/now-playing/now-playing-panel.js";
import {
  getLearningPayload,
  initLearningControls,
  markLearningSaved,
  renderLearning,
  setLearningStatus,
} from "./components/learning/learning-panel.js";
import {
  buildPlayParams,
  clearForm,
  renderPromptLine,
} from "./components/search/search-panel.js";
import { renderDebugPanel, setDebugUiEnabled } from "./components/debug/debug-panel.js";

const statusDot = el("statusDot");
const statusText = el("statusText");
const authPill = el("authPill");
const queueList = el("queueList");
const currentMeta = el("currentMeta");
const promptForm = el("promptForm");
const requestState = el("requestState");
const lastUpdated = el("lastUpdated");
const debugPanel = el("debugPanel");

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

let currentTrack = null;
let hasAttempted = false;
let lastState = null;
let controlController = null;
let controlSeq = 0;
let lastStatus = null;
let lastQueueSource = "fallback";
let lastCurrentIndex = 0;

function setStatus(ok, text) {
  if (statusText) {
    statusText.textContent = text;
  }
  if (statusDot) {
    statusDot.classList.toggle("ok", ok);
  }
}

function setRequestState(text, isError = false) {
  if (!requestState) return;
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
  lastQueueSource = source;
  lastCurrentIndex = currentIndex;
  renderQueue(data.queue, currentIndex, previous && previous.queue, source, lastStatus);
  currentTrack = data.current || null;
  renderNowPlaying(currentTrack, data.paused, currentIndex);
  renderLearning(currentTrack, data.learning);
  renderProgress(data.position, data.duration);
  renderPromptLine(data.prompt, data.seed);
  renderDebugPanel(data.debug);
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

function applyStatus(data) {
  lastStatus = data;
  if (lastState && lastState.queue) {
    renderQueue(lastState.queue, lastCurrentIndex, lastState.queue, lastQueueSource, lastStatus);
  }
}

async function refreshStatus(options = {}) {
  try {
    const data = await api(
      "/api/status",
      {},
      STATUS_TIMEOUT_MS,
      options.signal ? { signal: options.signal } : {}
    );
    applyStatus(data);
  } catch (err) {
    if (options.silent) {
      return;
    }
  }
}

async function refreshState(options = {}) {
  const showLoading = !hasAttempted;
  try {
    if (showLoading) {
      setLoading(true, "Connecting...");
    }
    const data = await api(
      "/state",
      {},
      STATE_TIMEOUT_MS,
      options.signal ? { signal: options.signal } : {}
    );
    if (options.guardSeq && options.guardSeq !== controlSeq) {
      return;
    }
    setStatus(true, "daemon online");
    applyState(data);
    storeState(data);
    await refreshStatus({ silent: true });
  } catch (err) {
    if (isAbortError(err)) {
      return;
    }
    setStatus(false, "daemon offline");
    if (currentMeta) {
      currentMeta.textContent = "daemon not reachable";
    }
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

async function playWithParams(params, label) {
  if (!params) return;
  setRequestState(label, false);
  try {
    setLoading(true, "Curating...");
    const data = await api("/play", params, PLAY_TIMEOUT_MS);
    setRequestState(`playing ${data.count} tracks`, false);
    renderQueue(data.queue, 0, null, "fallback", lastStatus);
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
  const params = buildPlayParams({
    useFallback: false,
    fallback: (lastState && lastState.extras) || {},
    fallbackPrompt: lastState && lastState.prompt,
    setRequestState,
  });
  await playWithParams(params, "curating...");
}

async function recuratePlay() {
  const params = buildPlayParams({
    useFallback: true,
    fallback: (lastState && lastState.extras) || {},
    fallbackPrompt: lastState && lastState.prompt,
    setRequestState,
  });
  await playWithParams(params, "re-curating...");
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
  const payload = getLearningPayload();
  setLearningStatus("saving...", false);
  try {
    await api("/learn", {
      id: currentTrack.videoId,
      title: currentTrack.title || "",
      artist: currentTrack.artist || "",
      ...payload,
    });
    markLearningSaved();
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

document.addEventListener("DOMContentLoaded", () => {
  addStagger();
  initProgressControls({
    api,
    onError: (message) => setRequestState(message, true),
  });
  initLearningControls(saveLearning);
  setDebugUiEnabled(false);
  document.body.classList.add("is-ready");
  const cached = loadStoredState();
  if (cached && cached.data) {
    applyState(cached.data, { cached: true, savedAt: cached.saved_at });
    setStatus(false, "restored");
    hasAttempted = true;
  }
  if (promptForm) {
    promptForm.addEventListener("submit", submitPlay);
  }
  if (prevBtn) {
    prevBtn.addEventListener("click", () => sendControl("/prev", "previous track"));
  }
  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => sendControl("/pause", "toggling pause"));
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => sendControl("/next", "skipping"));
  }
  if (stopBtn) {
    stopBtn.addEventListener("click", () => sendControl("/stop", "stopping"));
  }
  if (likeBtn) {
    likeBtn.addEventListener("click", () => voteCurrent(1));
  }
  if (dislikeBtn) {
    dislikeBtn.addEventListener("click", () => voteCurrent(-1));
  }
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => refreshState());
  }
  if (queueRefreshBtn) {
    queueRefreshBtn.addEventListener("click", () => refreshState());
  }
  if (recurateBtn) {
    recurateBtn.addEventListener("click", () => recuratePlay());
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", () => clearForm());
  }
  if (queueList) {
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
  }
  refreshState();
  setInterval(refreshState, 5000);
});
