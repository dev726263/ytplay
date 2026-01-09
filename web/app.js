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
const seedInfo = el("seedInfo");
const seedStatus = el("seedStatus");
const seedNextList = el("seedNextList");
const lastUpdated = el("lastUpdated");
const loadingOverlay = el("loadingOverlay");
const loadingText = el("loadingText");
const debugPanel = el("debugPanel");

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
const API_TIMEOUT_MS = 10000;
const STATE_TIMEOUT_MS = 5000;
const PLAY_TIMEOUT_MS = 120000;

let hasLoaded = false;
let hasAttempted = false;
let loadingCount = 0;
let lastState = null;

function setLoading(active, text) {
  if (active) {
    loadingCount += 1;
    if (text) {
      loadingText.textContent = text;
    }
    loadingOverlay.classList.add("is-active");
  } else {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) {
      loadingOverlay.classList.remove("is-active");
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

function formatTrack(track) {
  if (!track) return "-";
  const title = track.title || "Unknown";
  const artist = track.artist || "Unknown";
  return `${title} - ${artist}`;
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

function renderQueue(queue, currentIndex) {
  queueList.innerHTML = "";
  if (!queue || queue.length === 0) {
    queueCount.textContent = "0 tracks";
    return;
  }
  queueCount.textContent = `${queue.length} tracks`;
  queue.forEach((track, idx) => {
    const li = document.createElement("li");
    li.dataset.index = String(idx);
    li.setAttribute("role", "button");
    li.tabIndex = 0;
    if (idx === currentIndex) {
      li.classList.add("is-current");
    }
    const index = document.createElement("div");
    index.className = "queue-index";
    index.textContent = String(idx + 1).padStart(2, "0");
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
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = track.title || "Unknown";
    const artist = document.createElement("div");
    artist.className = "queue-artist";
    artist.textContent = track.artist || "Unknown";
    content.appendChild(title);
    content.appendChild(artist);
    li.appendChild(index);
    li.appendChild(art);
    li.appendChild(content);
    queueList.appendChild(li);
  });
}

function renderSeed(seed, seedNext) {
  if (!seed || !seed.title) {
    seedInfo.textContent = "No seed resolved yet.";
    seedStatus.textContent = "none";
  } else {
    seedInfo.textContent = `Seeded from: ${formatTrack(seed)}`;
    seedStatus.textContent = "active";
  }

  seedNextList.innerHTML = "";
  if (!seedNext || seedNext.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No seed followups yet.";
    seedNextList.appendChild(li);
    return;
  }
  seedNext.forEach((track) => {
    const li = document.createElement("li");
    li.textContent = formatTrack(track);
    seedNextList.appendChild(li);
  });
}

async function api(path, params = {}, timeoutMs = API_TIMEOUT_MS) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      url.searchParams.set(key, value);
    }
  });
  const controller = new AbortController();
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
      throw new Error("request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function refreshState() {
  const showLoading = !hasAttempted;
  try {
    if (showLoading) {
      setLoading(true, "Connecting...");
    }
    const data = await api("/state", {}, STATE_TIMEOUT_MS);
    lastState = data;
    setStatus(true, "daemon online");
    authPill.textContent = data.auth ? "auth: on" : "auth: off";
    pauseBtn.textContent = data.paused ? "resume" : "pause";
    renderQueue(data.queue, data.current_index);
    renderNowPlaying(data.current, data.paused, data.current_index || 0);
    renderPromptLine(data.prompt, data.seed);
    renderSeed(data.seed, data.seed_next);
    if (debugPanel) {
      if (data.debug && Object.keys(data.debug).length > 0) {
        debugPanel.textContent = JSON.stringify(data.debug, null, 2);
      } else {
        debugPanel.textContent = "No debug info yet.";
      }
    }
    lastUpdated.textContent = `last updated: ${new Date().toLocaleTimeString()}`;
    hasLoaded = true;
  } catch (err) {
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
    renderQueue(data.queue, 0);
    renderPromptLine(data.prompt, data.seed);
    renderSeed(data.seed, data.seed_next);
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

async function sendControl(path, label) {
  setRequestState(label, false);
  try {
    await api(path);
    await refreshState();
    setRequestState("idle", false);
  } catch (err) {
    setRequestState(err.message || "request failed", true);
  }
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
  setRequestState(`playing #${index + 1}`, false);
  try {
    await api("/play_index", { i: index });
    await refreshState();
    setRequestState("idle", false);
  } catch (err) {
    setRequestState(err.message || "request failed", true);
  }
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

function addStagger() {
  const panels = document.querySelectorAll("[data-stagger]");
  panels.forEach((panel, idx) => {
    panel.style.setProperty("--delay", `${idx * 0.08}s`);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  addStagger();
  document.body.classList.add("is-ready");
  promptForm.addEventListener("submit", submitPlay);
  pauseBtn.addEventListener("click", () => sendControl("/pause", "toggling pause"));
  nextBtn.addEventListener("click", () => sendControl("/next", "skipping"));
  stopBtn.addEventListener("click", () => sendControl("/stop", "stopping"));
  likeBtn.addEventListener("click", () => voteCurrent(1));
  dislikeBtn.addEventListener("click", () => voteCurrent(-1));
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
