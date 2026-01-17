import { el } from "../common/dom.js";
import { formatTime } from "../common/format.js";

const currentTitle = el("currentTitle");
const currentArtist = el("currentArtist");
const currentMeta = el("currentMeta");
const currentArt = el("currentArt");
const progressInput = el("progressInput");
const progressElapsed = el("progressElapsed");
const progressDuration = el("progressDuration");
const progressWrap = el("progressWrap");

let isSeeking = false;
let lastSeekAt = 0;

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

export function renderNowPlaying(current, paused, index) {
  if (!currentTitle || !currentArtist || !currentMeta) return;
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

export function renderProgress(position, duration) {
  if (!progressInput || !progressElapsed || !progressDuration) return;
  const hasDuration = typeof duration === "number" && duration > 0 && Number.isFinite(duration);
  const safePos =
    typeof position === "number" && position >= 0 && Number.isFinite(position) ? position : 0;
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

export function initProgressControls({ api, onError }) {
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
        if (onError) {
          onError(err.message || "seek failed");
        }
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
        if (onError) {
          onError(err.message || "seek failed");
        }
      }
    },
    { passive: false }
  );
}
