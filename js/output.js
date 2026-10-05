// output.js — output panel with autoscroll, filter, copy

const state = {
  autoscroll: true,
  filterText: "",
  filterLevel: "all",
  lines: [],
};

const outputEl = document.querySelector('.panel-view[data-panel="output"]');
const problemsEl = document.querySelector('.panel-view[data-panel="problems"]');
const debugEl = document.querySelector('.panel-view[data-panel="debug"]');

export function initOutput() {
  document.getElementById("out-autoscroll")?.addEventListener("click", (e) => {
    state.autoscroll = !state.autoscroll;
    e.currentTarget.classList.toggle("active", state.autoscroll);
  });

  document.getElementById("out-copy")?.addEventListener("click", () => {
    const text = state.lines.map((l) => l.text).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  });

  document.getElementById("out-clear")?.addEventListener("click", clearOutput);

  document.getElementById("out-filter-text")?.addEventListener("input", (e) => {
    state.filterText = e.target.value.toLowerCase();
    rerender();
  });

  document
    .getElementById("out-filter-level")
    ?.addEventListener("change", (e) => {
      state.filterLevel = e.target.value;
      rerender();
    });
}

export function appendOutput(text, cls = "") {
  state.lines.push({ text, cls });
  if (state.lines.length > 5000) state.lines.shift();

  if (!passesFilter({ text, cls })) return;

  const el = document.createElement("div");
  el.className = "out-line" + (cls ? " out-" + cls : "");
  el.textContent = text;
  outputEl.appendChild(el);

  if (state.autoscroll) outputEl.scrollTop = outputEl.scrollHeight;

  updateBadge();
}

export function appendError(file, line, col, message) {
  const row = document.createElement("div");
  row.className = "out-line out-err";
  row.textContent = `${file}(${line},${col}): error: ${message}`;
  problemsEl.appendChild(row);
  problemsEl.scrollTop = problemsEl.scrollHeight;
}

export function appendDebug(text) {
  const el = document.createElement("div");
  el.className = "out-line";
  el.textContent = text;
  debugEl.appendChild(el);
  debugEl.scrollTop = debugEl.scrollHeight;
}

export function clearOutput() {
  state.lines = [];
  outputEl.innerHTML = "";
  problemsEl.innerHTML = "";
  updateBadge();
}

export function setStatus(text) {
  const el = document.getElementById("sb-status");
  if (el) el.textContent = text;
}

function passesFilter(line) {
  if (state.filterLevel !== "all") {
    const map = { info: "", warn: "warn", err: "err" };
    if (map[state.filterLevel] && line.cls !== map[state.filterLevel])
      return false;
  }
  if (state.filterText && !line.text.toLowerCase().includes(state.filterText))
    return false;
  return true;
}

function rerender() {
  outputEl.innerHTML = "";
  for (const line of state.lines) {
    if (!passesFilter(line)) continue;
    const el = document.createElement("div");
    el.className = "out-line" + (line.cls ? " out-" + line.cls : "");
    el.textContent = line.text;
    outputEl.appendChild(el);
  }
  if (state.autoscroll) outputEl.scrollTop = outputEl.scrollHeight;
}

function updateBadge() {
  const errs = state.lines.filter((l) => l.cls === "err").length;
  const warns = state.lines.filter((l) => l.cls === "warn").length;
  const eb = document.getElementById("sb-errors");
  const wb = document.getElementById("sb-warnings");
  if (eb) eb.textContent = "✗ " + errs;
  if (wb) wb.textContent = "⚠ " + warns;
}

export function getOutputText() {
  return state.lines.map((l) => l.text).join("\n");
}

export function reportCompilerLine(line) {
  const m = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)$/);
  if (m) {
    appendError(m[1], m[2], m[3], m[5]);
  }
}
