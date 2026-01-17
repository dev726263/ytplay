import { api } from "../../api/client.js";
import { DB_PAGE_SIZE } from "../../app/constants.js";
import { el } from "../common/dom.js";

const dbPanel = el("dbPanel");
const dbTables = el("dbTables");
const dbStatus = el("dbStatus");

const dbCache = new Map();
const dbTableState = new Map();
const dbTableEls = new Map();
const dbTableSeq = new Map();
const dbColumnWidths = new Map();
let dbTablesLoaded = false;
let dbTablesLoading = false;

function setDbStatus(text, isError = false) {
  if (!dbStatus) return;
  dbStatus.textContent = text;
  dbStatus.classList.toggle("error", isError);
}

function formatDbValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.stringify(JSON.parse(trimmed));
      } catch (err) {
        return value;
      }
    }
    return value;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }
  return String(value);
}

function trimDbValue(text, maxLen = 140) {
  const value = String(text);
  if (value.length > maxLen) {
    return { text: `${value.slice(0, maxLen - 3)}...`, truncated: true };
  }
  return { text: value, truncated: false };
}

function dbCacheKey(table, offset, limit) {
  return `${table}:${offset}:${limit}`;
}

function getDbColumnWidth(table, column) {
  const tableMap = dbColumnWidths.get(table);
  if (!tableMap) return null;
  return tableMap.get(column) || null;
}

function setDbColumnWidth(table, column, width) {
  let tableMap = dbColumnWidths.get(table);
  if (!tableMap) {
    tableMap = new Map();
    dbColumnWidths.set(table, tableMap);
  }
  tableMap.set(column, width);
}

function startDbColumnResize(event, table, column, colEl) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startWidth = colEl.getBoundingClientRect().width;
  const minWidth = 80;
  document.body.classList.add("db-resizing");

  function onMove(moveEvent) {
    const delta = moveEvent.clientX - startX;
    const nextWidth = Math.max(minWidth, Math.round(startWidth + delta));
    colEl.style.width = `${nextWidth}px`;
    setDbColumnWidth(table, column, nextWidth);
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.classList.remove("db-resizing");
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function setDbContentMessage(content, message, className) {
  content.innerHTML = "";
  const el = document.createElement("div");
  el.className = className;
  el.textContent = message;
  content.appendChild(el);
}

function renderDbError(content, message, onRetry) {
  content.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "db-error";
  const text = document.createElement("div");
  text.textContent = message;
  const retry = document.createElement("button");
  retry.className = "btn ghost tiny";
  retry.type = "button";
  retry.textContent = "retry";
  retry.addEventListener("click", onRetry);
  wrap.appendChild(text);
  wrap.appendChild(retry);
  content.appendChild(wrap);
}

function updateDbControls(table, rows, total, offset, limit, loading) {
  const elements = dbTableEls.get(table);
  if (!elements) return;
  const page = Math.floor(offset / limit) + 1;
  let status = loading ? "loading..." : `showing ${rows.length} rows | page ${page}`;
  if (typeof total === "number") {
    const pages = Math.max(1, Math.ceil(total / limit));
    status = `${status} of ${pages}`;
  }
  elements.status.textContent = status;
  elements.refreshBtn.disabled = loading;
  elements.prevBtn.disabled = loading || offset <= 0;
  elements.nextBtn.disabled = loading || (typeof total === "number" && offset + limit >= total);
}

function renderDbGrid(content, table, columns, rows) {
  content.innerHTML = "";
  const grid = document.createElement("table");
  grid.className = "db-grid";
  const colgroup = document.createElement("colgroup");
  const colEls = [];
  columns.forEach((col) => {
    const colEl = document.createElement("col");
    const width = getDbColumnWidth(table, col);
    if (width) {
      colEl.style.width = `${width}px`;
    }
    colgroup.appendChild(colEl);
    colEls.push(colEl);
  });
  grid.appendChild(colgroup);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((col, index) => {
    const th = document.createElement("th");
    th.textContent = col;
    const resizer = document.createElement("span");
    resizer.className = "db-resizer";
    resizer.addEventListener("mousedown", (event) =>
      startDbColumnResize(event, table, col, colEls[index])
    );
    th.appendChild(resizer);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    columns.forEach((col) => {
      const td = document.createElement("td");
      const raw = row ? row[col] : "";
      const formatted = formatDbValue(raw);
      const trimmed = trimDbValue(formatted);
      td.textContent = trimmed.text;
      if (trimmed.truncated) {
        td.title = formatted;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  grid.appendChild(thead);
  grid.appendChild(tbody);
  content.appendChild(grid);
}

async function loadDbRows(table, options = {}) {
  const elements = dbTableEls.get(table);
  if (!elements) return;
  const limit = DB_PAGE_SIZE;
  const offset = Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;
  const refresh = Boolean(options.refresh);
  const cacheKey = dbCacheKey(table, offset, limit);
  const currentState = dbTableState.get(table);

  if (!refresh && dbCache.has(cacheKey)) {
    const cached = dbCache.get(cacheKey);
    const rows = Array.isArray(cached.rows) ? cached.rows : [];
    const columns = Array.isArray(cached.columns) ? cached.columns : [];
    dbTableState.set(table, { offset, limit, total: cached.total });
    if (!rows.length) {
      setDbContentMessage(elements.content, "No records found.", "db-empty");
    } else {
      renderDbGrid(elements.content, table, columns, rows);
    }
    updateDbControls(table, rows, cached.total, offset, limit, false);
    return;
  }

  const seq = (dbTableSeq.get(table) || 0) + 1;
  dbTableSeq.set(table, seq);
  setDbContentMessage(elements.content, "Loading...", "db-loading");
  updateDbControls(table, [], currentState ? currentState.total : undefined, offset, limit, true);
  try {
    const data = await api(`/api/db/table/${encodeURIComponent(table)}/rows`, {
      limit,
      offset,
    });
    if (dbTableSeq.get(table) !== seq) return;
    dbCache.set(cacheKey, data);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const columns = Array.isArray(data.columns) ? data.columns : [];
    dbTableState.set(table, { offset, limit, total: data.total });
    if (!rows.length) {
      setDbContentMessage(elements.content, "No records found.", "db-empty");
    } else {
      renderDbGrid(elements.content, table, columns, rows);
    }
    updateDbControls(table, rows, data.total, offset, limit, false);
  } catch (err) {
    if (dbTableSeq.get(table) !== seq) return;
    renderDbError(elements.content, err.message || "Failed to load rows.", () =>
      loadDbRows(table, { offset, refresh: true })
    );
    updateDbControls(table, [], currentState ? currentState.total : undefined, offset, limit, false);
  }
}

function createDbTableItem(table) {
  const details = document.createElement("details");
  details.className = "db-table";
  details.dataset.table = table;

  const summary = document.createElement("summary");
  summary.className = "db-summary";

  const left = document.createElement("div");
  left.className = "db-summary-left";

  const caret = document.createElement("span");
  caret.className = "db-caret";
  caret.textContent = ">";

  const title = document.createElement("span");
  title.className = "db-title";
  title.textContent = table;

  left.appendChild(caret);
  left.appendChild(title);

  const hint = document.createElement("span");
  hint.className = "db-hint";
  hint.textContent = `latest ${DB_PAGE_SIZE}`;

  summary.appendChild(left);
  summary.appendChild(hint);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "db-body";

  const controls = document.createElement("div");
  controls.className = "db-controls";

  const status = document.createElement("div");
  status.className = "db-status";
  status.textContent = "not loaded";

  const buttons = document.createElement("div");
  buttons.className = "db-buttons";

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn ghost tiny";
  refreshBtn.type = "button";
  refreshBtn.textContent = "refresh";

  const prevBtn = document.createElement("button");
  prevBtn.className = "btn ghost tiny";
  prevBtn.type = "button";
  prevBtn.textContent = "newer";

  const nextBtn = document.createElement("button");
  nextBtn.className = "btn ghost tiny";
  nextBtn.type = "button";
  nextBtn.textContent = "older";

  buttons.appendChild(refreshBtn);
  buttons.appendChild(prevBtn);
  buttons.appendChild(nextBtn);
  controls.appendChild(status);
  controls.appendChild(buttons);

  const content = document.createElement("div");
  content.className = "db-content";

  body.appendChild(controls);
  body.appendChild(content);
  details.appendChild(body);

  details.addEventListener("toggle", () => {
    if (!details.open) return;
    const state = dbTableState.get(table) || { offset: 0, limit: DB_PAGE_SIZE };
    loadDbRows(table, { offset: state.offset, refresh: false });
  });

  refreshBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const state = dbTableState.get(table) || { offset: 0, limit: DB_PAGE_SIZE };
    loadDbRows(table, { offset: state.offset, refresh: true });
  });

  prevBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const state = dbTableState.get(table) || { offset: 0, limit: DB_PAGE_SIZE };
    const nextOffset = Math.max(0, state.offset - state.limit);
    loadDbRows(table, { offset: nextOffset, refresh: false });
  });

  nextBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const state = dbTableState.get(table) || { offset: 0, limit: DB_PAGE_SIZE };
    const nextOffset = state.offset + state.limit;
    if (typeof state.total === "number" && nextOffset >= state.total) {
      return;
    }
    loadDbRows(table, { offset: nextOffset, refresh: false });
  });

  dbTableEls.set(table, {
    details,
    status,
    content,
    refreshBtn,
    prevBtn,
    nextBtn,
  });
  return details;
}

function renderDbTables(tables) {
  if (!dbTables) return;
  dbTables.innerHTML = "";
  tables.forEach((table) => {
    const item = createDbTableItem(table);
    dbTables.appendChild(item);
  });
}

export async function loadDbTables() {
  if (!dbPanel || !dbTables) return;
  if (dbTablesLoaded || dbTablesLoading) return;
  dbTablesLoading = true;
  setDbStatus("loading...");
  dbTables.innerHTML = "";
  try {
    const data = await api("/api/db/tables");
    const tables = Array.isArray(data.tables) ? data.tables : [];
    if (!tables.length) {
      setDbStatus("empty");
      setDbContentMessage(dbTables, "No tables found.", "db-empty");
      dbTablesLoaded = true;
      return;
    }
    setDbStatus("ready");
    renderDbTables(tables);
    dbTablesLoaded = true;
  } catch (err) {
    setDbStatus("error", true);
    dbTables.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "db-error";
    const text = document.createElement("div");
    text.textContent = err.message || "Failed to load tables.";
    const retry = document.createElement("button");
    retry.className = "btn ghost tiny";
    retry.type = "button";
    retry.textContent = "retry";
    retry.addEventListener("click", () => loadDbTables());
    wrap.appendChild(text);
    wrap.appendChild(retry);
    dbTables.appendChild(wrap);
  } finally {
    dbTablesLoading = false;
  }
}
