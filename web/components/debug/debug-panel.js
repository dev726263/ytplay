import { el } from "../common/dom.js";
import { loadDbTables } from "../database/database-panel.js";

const debugPanel = el("debugPanel");
const debugPanelWrap = el("debugPanelWrap");
const sidePanels = el("sidePanels");
const dbPanel = el("dbPanel");

let debugUiEnabled = false;

export function setDebugUiEnabled(enabled) {
  const show = Boolean(enabled);
  debugUiEnabled = show;
  if (debugPanelWrap) {
    debugPanelWrap.style.display = show ? "" : "none";
  }
  if (sidePanels) {
    sidePanels.style.display = show ? "" : "none";
  }
  if (dbPanel) {
    dbPanel.style.display = show ? "" : "none";
  }
  if (show) {
    loadDbTables();
  }
}

export function isDebugUiEnabled() {
  return debugUiEnabled;
}

export function renderDebugPanel(debugData) {
  if (!debugPanel) return;
  if (debugData && Object.keys(debugData).length > 0) {
    debugPanel.textContent = JSON.stringify(debugData, null, 2);
  } else {
    debugPanel.textContent = "No debug info yet.";
  }
}
