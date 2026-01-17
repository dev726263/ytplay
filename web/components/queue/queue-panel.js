import { QUEUE_WINDOW } from "../../app/constants.js";
import { el } from "../common/dom.js";

const queueList = el("queueList");
const queueCount = el("queueCount");

function normalizeSource(source) {
  return source === "openai" ? "openai" : "fallback";
}

function trimQueryPayload(value, depth = 0) {
  const maxDepth = 3;
  const maxString = 160;
  const maxArray = 12;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > maxString) {
      return `${value.slice(0, maxString - 3)}...`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const trimmed = value.slice(0, maxArray).map((item) => trimQueryPayload(item, depth + 1));
    if (value.length > maxArray) {
      trimmed.push(`... (${value.length - maxArray} more)`);
    }
    return trimmed;
  }
  if (typeof value === "object") {
    if (depth >= maxDepth) {
      return "[nested]";
    }
    const out = {};
    Object.keys(value).forEach((key) => {
      out[key] = trimQueryPayload(value[key], depth + 1);
    });
    return out;
  }
  return value;
}

function formatQueryPayload(payload) {
  if (!payload) return "AI Query: unavailable";
  const trimmed = trimQueryPayload(payload);
  try {
    return JSON.stringify(trimmed, null, 2);
  } catch (err) {
    return "AI Query: unavailable";
  }
}

function renderQueuePlaceholder(status, withDetails) {
  const li = document.createElement("li");
  li.className = "queue-placeholder";
  const index = document.createElement("div");
  index.className = "queue-index skeleton";
  const art = document.createElement("div");
  art.className = "queue-art skeleton";
  const content = document.createElement("div");
  content.className = "queue-content";
  const title = document.createElement("div");
  title.className = "queue-title skeleton";
  const artist = document.createElement("div");
  artist.className = "queue-artist skeleton";
  const meta = document.createElement("div");
  meta.className = "queue-placeholder-meta";
  meta.textContent = "Loading...";
  content.appendChild(title);
  content.appendChild(artist);
  content.appendChild(meta);
  if (withDetails) {
    const details = document.createElement("details");
    details.className = "queue-query";
    const summary = document.createElement("summary");
    summary.textContent = "AI query";
    const body = document.createElement("pre");
    body.className = "queue-query-body";
    body.textContent = formatQueryPayload(status ? status.current_query : null);
    details.appendChild(summary);
    details.appendChild(body);
    content.appendChild(details);
  }
  li.appendChild(index);
  li.appendChild(art);
  li.appendChild(content);
  return li;
}

export function renderQueue(queue, currentIndex, previousQueue, defaultSource, status) {
  if (!queueList || !queueCount) return;
  queueList.innerHTML = "";
  const safeQueue = Array.isArray(queue) ? queue : [];
  const isGenerating = Boolean(status && status.is_generating);
  const target =
    status && typeof status.queue_target === "number"
      ? Math.min(QUEUE_WINDOW, status.queue_target)
      : QUEUE_WINDOW;
  if (safeQueue.length === 0 && !isGenerating) {
    queueCount.textContent = "0 tracks";
    const empty = document.createElement("li");
    empty.className = "queue-empty";
    empty.textContent = "queue empty";
    queueList.appendChild(empty);
    return;
  }
  const startIndex = typeof currentIndex === "number" && currentIndex >= 0 ? currentIndex : 0;
  const visible = safeQueue.slice(startIndex, startIndex + QUEUE_WINDOW);
  const prevIds = new Set((previousQueue || []).map((track) => track.videoId));
  queueCount.textContent = `${visible.length} of ${safeQueue.length}`;
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
    const statusTag = document.createElement("span");
    statusTag.className = "queue-tag status";
    statusTag.textContent = globalIndex === currentIndex ? "now" : "next";
    const source = normalizeSource(track.curation || defaultSource);
    const sourceTag = document.createElement("span");
    sourceTag.className = `queue-tag source is-${source}`;
    sourceTag.textContent = source === "openai" ? "ai" : "fallback";
    tags.appendChild(statusTag);
    tags.appendChild(sourceTag);
    content.appendChild(title);
    content.appendChild(artist);
    content.appendChild(tags);
    li.appendChild(index);
    li.appendChild(art);
    li.appendChild(content);
    queueList.appendChild(li);
  });

  if (isGenerating && safeQueue.length < target) {
    const remaining = Math.max(0, target - safeQueue.length);
    const visibleRoom = Math.max(0, QUEUE_WINDOW - visible.length);
    const placeholderCount = Math.min(remaining, visibleRoom);
    for (let i = 0; i < placeholderCount; i += 1) {
      queueList.appendChild(renderQueuePlaceholder(status, i === 0));
    }
  }
}
