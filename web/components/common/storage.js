import { STATE_STORAGE_KEY } from "../../app/constants.js";

export function storeState(data) {
  try {
    const payload = { saved_at: Date.now(), data };
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    return;
  }
}

export function loadStoredState() {
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
