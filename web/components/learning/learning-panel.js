import { el } from "../common/dom.js";

const learningWrap = el("learningWrap");
const learnScore = el("learnScore");
const learnScoreValue = el("learnScoreValue");
const learnEnergy = el("learnEnergy");
const learnTempo = el("learnTempo");
const learnSaveBtn = el("learnSaveBtn");
const learningStatus = el("learningStatus");

let lastLearningTrackId = null;
let learningDirty = false;

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

export function setLearningStatus(text, isError = false) {
  if (!learningStatus) return;
  learningStatus.textContent = text;
  learningStatus.classList.toggle("error", isError);
}

export function markLearningSaved() {
  learningDirty = false;
  setLearningStatus("saved", false);
}

export function getLearningPayload() {
  const scoreValue = learnScore ? Number(learnScore.value) : NaN;
  return {
    score: Number.isNaN(scoreValue) ? "" : scoreValue,
    energy: learnEnergy ? learnEnergy.value : "",
    tempo: learnTempo ? learnTempo.value : "",
  };
}

export function renderLearning(track, learning) {
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

export function initLearningControls(onSave) {
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
  if (learnSaveBtn && onSave) {
    learnSaveBtn.addEventListener("click", () => onSave());
  }
}
