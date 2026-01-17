import { API_TIMEOUT_MS } from "../app/constants.js";

export async function api(path, params = {}, timeoutMs = API_TIMEOUT_MS, options = {}) {
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
