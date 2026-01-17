const envEditor = document.getElementById("envEditor");
const envPath = document.getElementById("envPath");
const envStatus = document.getElementById("envStatus");
const reloadBtn = document.getElementById("reloadBtn");
const saveBtn = document.getElementById("saveBtn");

let dirty = false;
let busy = false;

function setStatus(text, isError = false) {
  if (!envStatus) return;
  envStatus.textContent = text;
  envStatus.classList.toggle("error", isError);
}

function setBusy(value) {
  busy = value;
  if (envEditor) envEditor.disabled = value;
  if (reloadBtn) reloadBtn.disabled = value;
  if (saveBtn) saveBtn.disabled = value;
}

function markDirty() {
  if (!dirty) {
    dirty = true;
    setStatus("unsaved");
  }
}

async function loadEnv() {
  setBusy(true);
  setStatus("loading...");
  try {
    const res = await fetch("/env");
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || "failed to load");
    }
    if (envPath && data.path) {
      envPath.textContent = data.path;
    }
    if (envEditor) {
      envEditor.value = data.content || "";
    }
    dirty = false;
    setStatus(data.exists ? "loaded" : "new file");
  } catch (err) {
    setStatus(err.message || "load failed", true);
  } finally {
    setBusy(false);
  }
}

async function waitForRestart() {
  let attempts = 0;
  const maxAttempts = 20;
  const delayMs = 800;
  const poll = async () => {
    attempts += 1;
    try {
      const res = await fetch("/health");
      if (res.ok) {
        setStatus("restarted");
        setTimeout(() => {
          window.location.href = "/ui/";
        }, 500);
        return;
      }
    } catch (err) {
      // ignore
    }
    if (attempts < maxAttempts) {
      setTimeout(poll, delayMs);
    } else {
      setStatus("restart pending; refresh", true);
      setBusy(false);
    }
  };
  setTimeout(poll, delayMs);
}

async function saveEnv() {
  if (busy) return;
  if (!dirty) {
    setStatus("no changes");
    return;
  }
  setBusy(true);
  setStatus("saving...");
  try {
    const res = await fetch("/env", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: envEditor.value }),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || "save failed");
    }
    dirty = false;
    setStatus("saved, restarting...");
    await waitForRestart();
  } catch (err) {
    setStatus(err.message || "save failed", true);
    setBusy(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add("is-ready");
  if (envEditor) {
    envEditor.addEventListener("input", () => markDirty());
  }
  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => loadEnv());
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", () => saveEnv());
  }
  loadEnv();
});
