// command-palette.js — Ctrl+Shift+P overlay

const palette = document.getElementById("command-palette");
const input = document.getElementById("cp-input");
const list = document.getElementById("cp-list");

let commands = [];
let filtered = [];
let selected = 0;

export function registerCommands(cmds) {
  commands = cmds;
}

export function openPalette(prefill = "") {
  if (!palette) return;
  palette.classList.add("visible");
  input.value = prefill;
  filterAndRender();
  setTimeout(() => input.focus(), 10);
}

export function closePalette() {
  palette?.classList.remove("visible");
}

export function isPaletteOpen() {
  return palette?.classList.contains("visible");
}

function filterAndRender() {
  const q = input.value.toLowerCase().trim();
  if (!q) {
    filtered = commands.slice();
  } else {
    filtered = commands
      .map((c) => ({ c, score: fuzzyScore(c.label.toLowerCase(), q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }
  selected = 0;
  render();
}

function render() {
  list.innerHTML = "";
  if (filtered.length === 0) {
    const el = document.createElement("div");
    el.className = "cp-empty";
    el.textContent = "No matching commands";
    list.appendChild(el);
    return;
  }
  filtered.slice(0, 100).forEach((cmd, i) => {
    const el = document.createElement("div");
    el.className = "cp-item" + (i === selected ? " selected" : "");
    const left = document.createElement("span");
    left.textContent = cmd.label;
    el.appendChild(left);
    if (cmd.shortcut) {
      const sc = document.createElement("span");
      sc.className = "cp-shortcut";
      sc.textContent = cmd.shortcut;
      el.appendChild(sc);
    }
    el.addEventListener("click", () => {
      closePalette();
      cmd.action();
    });
    el.addEventListener("mouseenter", () => {
      selected = i;
      render();
    });
    list.appendChild(el);
  });
}

input?.addEventListener("input", filterAndRender);

input?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    selected = Math.min(selected + 1, filtered.length - 1);
    render();
    scrollSelectedIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selected = Math.max(selected - 1, 0);
    render();
    scrollSelectedIntoView();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const cmd = filtered[selected];
    if (cmd) {
      closePalette();
      cmd.action();
    }
  }
});

palette?.addEventListener("click", (e) => {
  if (e.target === palette) closePalette();
});

function scrollSelectedIntoView() {
  const el = list.querySelectorAll(".cp-item")[selected];
  if (el) el.scrollIntoView({ block: "nearest" });
}

function fuzzyScore(text, query) {
  let ti = 0,
    qi = 0,
    score = 0,
    consecutive = 0;
  while (ti < text.length && qi < query.length) {
    if (text[ti] === query[qi]) {
      consecutive++;
      score += 1 + consecutive * 2;
      qi++;
    } else {
      consecutive = 0;
    }
    ti++;
  }
  if (qi < query.length) return 0;
  if (text.startsWith(query)) score += 50;
  return score;
}
