import { el } from "../common/dom.js";
import { formatTrack } from "../common/format.js";

const promptLine = el("promptLine");
const promptInput = el("promptInput");
const seedInput = el("seedInput");
const moodInput = el("moodInput");
const langInput = el("langInput");
const avoidInput = el("avoidInput");
const maxInput = el("maxInput");
const ttlInput = el("ttlInput");
const mixInput = el("mixInput");
const vibeInput = el("vibeInput");

export function renderPromptLine(prompt, seed) {
  if (!promptLine) return;
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

export function clearForm() {
  if (promptInput) promptInput.value = "";
  if (seedInput) seedInput.value = "";
  if (moodInput) moodInput.value = "";
  if (langInput) langInput.value = "";
  if (avoidInput) avoidInput.value = "";
  if (maxInput) maxInput.value = "";
  if (ttlInput) ttlInput.value = "";
  if (mixInput) mixInput.value = "";
  if (vibeInput) vibeInput.value = "normal";
}

export function buildPlayParams({ useFallback, fallback, fallbackPrompt, setRequestState }) {
  const prompt = promptInput ? promptInput.value.trim() : "";
  const fallbackPromptValue = useFallback ? fallbackPrompt || "" : "";
  const finalPrompt = prompt || fallbackPromptValue;
  if (!finalPrompt) {
    if (setRequestState) {
      setRequestState("missing prompt", true);
    }
    return null;
  }
  const safeFallback = fallback || {};
  return {
    q: finalPrompt,
    seed: seedInput ? seedInput.value.trim() || (useFallback ? safeFallback.seed || "" : "") : "",
    mood: moodInput ? moodInput.value.trim() || (useFallback ? safeFallback.mood || "" : "") : "",
    lang: langInput ? langInput.value.trim() || (useFallback ? safeFallback.lang || "" : "") : "",
    avoid: avoidInput
      ? avoidInput.value.trim() || (useFallback ? (safeFallback.avoid || []).join(",") : "")
      : "",
    mix: mixInput ? mixInput.value.trim() || (useFallback ? safeFallback.mix || "" : "") : "",
    vibe: vibeInput ? vibeInput.value.trim() || (useFallback ? safeFallback.vibe || "" : "") : "",
    n: maxInput ? maxInput.value.trim() || (useFallback ? safeFallback.max_tracks || "" : "") : "",
    ttl: ttlInput ? ttlInput.value.trim() || (useFallback ? safeFallback.ttl_hours || "" : "") : "",
  };
}
