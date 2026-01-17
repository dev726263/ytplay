import { api } from "../../api/client.js";
import { STATE_TIMEOUT_MS } from "../../app/constants.js";
import { el } from "../common/dom.js";

const loadingOverlay = el("loadingOverlay");
const loadingText = el("loadingText");
const loadingLog = el("loadingLog");

const LOADING_MESSAGES = [
  "Warming up the curator...",
  "Scanning the stack...",
  "Picking the next track...",
  "Resolving stream URLs...",
  "Syncing the queue...",
  "Tuning the vibe...",
];

let loadingCount = 0;
let loadingCycle = null;
let loadingHistory = [];
let loadingIndex = 0;
let progressPoll = null;
let progressLastId = 0;
let progressActive = false;

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

export function setLoading(active, text) {
  if (active) {
    const wasIdle = loadingCount === 0;
    loadingCount += 1;
    if (text) {
      setLoadingMessage(text);
    }
    if (loadingOverlay) {
      loadingOverlay.classList.add("is-active");
    }
    if (wasIdle) {
      startLoadingCycle();
      startProgressPoll();
    }
  } else {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) {
      if (loadingOverlay) {
        loadingOverlay.classList.remove("is-active");
      }
      stopLoadingCycle();
      stopProgressPoll();
    }
  }
}
