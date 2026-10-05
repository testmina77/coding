// app.js — bootstrap + command dispatch

import {
  project,
  addFile,
  resetToDefault,
  bootstrapFromStorage,
  replaceProject,
  setActiveConfig,
  setActivePlatform,
} from "./project.js";
import {
  renderExplorer,
  selectFile,
  refresh as refreshExplorer,
} from "./explorer.js";
import {
  initMonaco,
  openFile,
  getActivePath,
  closeTab,
  toggleMinimap,
  toggleWordWrap,
  revealLine,
} from "./editor.js";
import { appendOutput, clearOutput, setStatus, initOutput } from "./output.js";
import { openPropDialog, closePropDialog } from "./propdialog.js";
import { initBuildWorker, build } from "./build.js";
import {
  openResourceCreator,
  closeResourceCreator,
  initResourceCreator,
} from "./resource-creator.js";
import {
  initLayout,
  toggleSidebar,
  togglePanel,
  toggleProperties,
  setActiveView,
  showPanel,
} from "./layout.js";
import { initShortcuts } from "./shortcuts.js";
import { openPalette, registerCommands } from "./command-palette.js";
import { initTerminal, focusTerminal } from "./terminal.js";
import { formatActiveDocument } from "./format.js";
import { exportProjectZip, importProjectZip } from "./persistence.js";

// ─── Menus ────────────────────────────────────────────────────────────────

function closeAllMenus() {
  document
    .querySelectorAll(".menu-item.open")
    .forEach((m) => m.classList.remove("open"));
}
document.querySelectorAll(".menu-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    if (e.target.closest(".dropdown")) return;
    const open = item.classList.contains("open");
    closeAllMenus();
    if (!open) item.classList.add("open");
    e.stopPropagation();
  });
});
document.addEventListener("click", closeAllMenus);

// ─── Command registry ─────────────────────────────────────────────────────

const COMMANDS = {
  "new-project": { label: "File: New Project", run: () => resetProject() },
  "open-project": {
    label: "File: Open Project…",
    run: () => document.getElementById("import-zip-input").click(),
  },
  save: { label: "File: Save", shortcut: "Ctrl+S", run: () => doSave() },
  "save-all": {
    label: "File: Save All",
    shortcut: "Ctrl+Shift+S",
    run: () => doSaveAll(),
  },
  "export-zip": {
    label: "File: Export Project as ZIP",
    run: () => exportProjectZip(project),
  },
  "import-zip": {
    label: "File: Import Project from ZIP",
    run: () => document.getElementById("import-zip-input").click(),
  },
  "reset-project": { label: "File: Reset Project", run: () => resetProject() },
  "add-file": {
    label: "Project: Add New File…",
    run: () => openNewFileDialog(),
  },
  "add-folder": { label: "Project: Add Folder…", run: () => promptAddFolder() },
  "add-binary-resource": {
    label: "Project: Add Binary Resource…",
    run: () => openResourceCreator(),
  },
  "project-properties": {
    label: "Project: Properties",
    shortcut: "Alt+Enter",
    run: () => openPropDialog(),
  },
  build: {
    label: "Build: Build Solution",
    shortcut: "Ctrl+Shift+B",
    run: () => build(),
  },
  rebuild: { label: "Build: Rebuild Solution", run: () => build() },
  "compile-file": { label: "Build: Compile Current File", run: () => build() },
  clean: {
    label: "Build: Clean Solution",
    run: () => {
      clearOutput();
      appendOutput("Output cleared.", "ok");
    },
  },
  run: { label: "Debug: Run", shortcut: "F5", run: () => build() },
  "cmd-palette": {
    label: "View: Command Palette",
    shortcut: "Ctrl+Shift+P",
    run: () => openPalette(),
  },
  "quick-open": {
    label: "View: Quick Open File",
    shortcut: "Ctrl+P",
    run: () => quickOpen(),
  },
  "show-shortcuts": {
    label: "Help: Keyboard Shortcuts",
    run: () => showShortcutsHelp(),
  },
  about: {
    label: "Help: About ForgeIDE",
    run: () =>
      appendOutput(
        "ForgeIDE 0.2.0 — C++ IDE in the browser, autor: RggD9",
        "ok",
      ),
  },
  "toggle-sidebar": {
    label: "View: Toggle Sidebar",
    shortcut: "Ctrl+B",
    run: () => toggleSidebar(),
  },
  "toggle-panel": {
    label: "View: Toggle Panel",
    shortcut: "Ctrl+J",
    run: () => togglePanel(),
  },
  "toggle-properties": {
    label: "View: Toggle Properties",
    run: () => toggleProperties(),
  },
  "toggle-minimap": {
    label: "View: Toggle Minimap",
    run: () => toggleMinimap(),
  },
  "toggle-wordwrap": {
    label: "View: Toggle Word Wrap",
    shortcut: "Alt+Z",
    run: () => toggleWordWrap(),
  },
  "view-explorer": {
    label: "View: Show Explorer",
    shortcut: "Ctrl+Shift+E",
    run: () => {
      setActiveView("explorer");
      ensureSidebarVisible();
    },
  },
  "view-search": {
    label: "View: Show Search",
    shortcut: "Ctrl+Shift+F",
    run: () => {
      setActiveView("search");
      ensureSidebarVisible();
    },
  },
  "view-source": {
    label: "View: Show Source Control",
    shortcut: "Ctrl+Shift+G",
    run: () => {
      setActiveView("source");
      ensureSidebarVisible();
    },
  },
  "view-extensions": {
    label: "View: Show Extensions",
    shortcut: "Ctrl+Shift+X",
    run: () => {
      setActiveView("extensions");
      ensureSidebarVisible();
    },
  },
  terminal: {
    label: "Terminal: New Terminal",
    shortcut: "Ctrl+`",
    run: () => {
      showPanel("terminal");
      initTerminal();
      setTimeout(focusTerminal, 50);
    },
  },
  "clear-output": { label: "Output: Clear", run: () => clearOutput() },
  find: {
    label: "Edit: Find",
    shortcut: "Ctrl+F",
    run: () =>
      import("./editor.js").then((m) =>
        m.getMonaco()?.getAction("actions.find")?.run(),
      ),
  },
  replace: {
    label: "Edit: Replace",
    shortcut: "Ctrl+H",
    run: () =>
      import("./editor.js").then((m) =>
        m.getMonaco()?.getAction("editor.action.startFindReplaceAction")?.run(),
      ),
  },
  "format-document": {
    label: "Edit: Format Document",
    shortcut: "Shift+Alt+F",
    run: () =>
      formatActiveDocument().catch((e) =>
        appendOutput("Format: " + e.message, "err"),
      ),
  },
  undo: {
    label: "Edit: Undo",
    run: () =>
      import("./editor.js").then((m) =>
        m.getMonaco()?.trigger("app", "undo", null),
      ),
  },
  redo: {
    label: "Edit: Redo",
    run: () =>
      import("./editor.js").then((m) =>
        m.getMonaco()?.trigger("app", "redo", null),
      ),
  },
  cut: { label: "Edit: Cut", run: () => document.execCommand("cut") },
  copy: { label: "Edit: Copy", run: () => document.execCommand("copy") },
  paste: {
    label: "Edit: Paste",
    run: () =>
      navigator.clipboard
        .readText()
        .then((t) =>
          import("./editor.js").then((m) =>
            m.getMonaco()?.trigger("app", "type", { text: t }),
          ),
        )
        .catch(() => {}),
  },
};

function ensureSidebarVisible() {
  const sb = document.getElementById("sidebar");
  if (sb.style.display === "none") toggleSidebar();
}

export function runCommand(cmd) {
  closeAllMenus();
  const c = COMMANDS[cmd];
  if (c) {
    try {
      c.run();
    } catch (e) {
      appendOutput(`Command "${cmd}" failed: ${e.message}`, "err");
    }
    return;
  }
  switch (cmd) {
    case "propdlg-close":
    case "propdlg-cancel":
      closePropDialog();
      break;
    case "propdlg-ok":
    case "propdlg-apply":
      appendOutput("Project properties saved.", "ok");
      if (cmd === "propdlg-ok") closePropDialog();
      break;
    case "newfile-close":
    case "newfile-cancel":
      document.getElementById("newfile-dialog").classList.add("hidden");
      break;
    case "newfile-ok":
      handleNewFile();
      break;
    case "res-close":
    case "res-cancel":
      closeResourceCreator();
      break;
    default:
      if (cmd) appendOutput(`Unknown command: ${cmd}`, "err");
  }
}

document.body.addEventListener("click", (e) => {
  const el = e.target.closest("[data-cmd]");
  if (el) {
    e.preventDefault();
    runCommand(el.dataset.cmd);
  }
});

// ─── Save / Project actions ───────────────────────────────────────────────

async function doSave() {
  const { saveProject } = await import("./persistence.js");
  await saveProject(project);
  for (const [, f] of project.files) f.dirty = false;
  refreshExplorer();
  appendOutput("Saved.", "ok");
  setStatus("Saved");
}

async function doSaveAll() {
  await doSave();
  appendOutput("All files saved.", "ok");
}

function resetProject() {
  if (!confirm("Reset project to default? Unsaved work will be lost.")) return;
  resetToDefault();
  syncConfigUI();

  refreshExplorer();
  openFile("src/main.cpp");
  appendOutput("Project reset.", "ok");
}

function openNewFileDialog() {
  document.getElementById("newfile-dialog").classList.remove("hidden");
  document.getElementById("newfile-path").focus();
}

function promptAddFolder() {
  const name = prompt("Folder name:");
  if (!name) return;
  addFile(name.replace(/\/+$/, "") + "/.keep", "");
  refreshExplorer();
}

async function quickOpen() {
  const files = [...project.files.keys()].sort();
  const items = files.map((f) => ({
    label: f,
    action: () => {
      openFile(f);
      selectFile(f);
      refreshExplorer();
      updatePropertiesForFile(f);
    },
  }));
  registerCommands(items.map((i) => ({ label: i.label, action: i.action })));
  openPalette("");
  document.getElementById("cp-input").placeholder = "Go to file…";
}

function showShortcutsHelp() {
  const shortcuts = [
    ["Ctrl+S", "Save"],
    ["Ctrl+Shift+S", "Save All"],
    ["Ctrl+Shift+B", "Build Solution"],
    ["Ctrl+B", "Toggle Sidebar"],
    ["Ctrl+J", "Toggle Panel"],
    ["Ctrl+`", "Toggle Terminal"],
    ["Ctrl+F", "Find"],
    ["Ctrl+H", "Replace"],
    ["Ctrl+Shift+P", "Command Palette"],
    ["Ctrl+P", "Quick Open"],
    ["Ctrl+Shift+E", "Explorer"],
    ["Ctrl+Shift+F", "Search"],
    ["Ctrl+Shift+G", "Source Control"],
    ["Ctrl+Shift+X", "Extensions"],
    ["Alt+Z", "Word Wrap"],
    ["Shift+Alt+F", "Format Document"],
    ["F5", "Run"],
    ["F2", "Rename (in tree)"],
    ["Del", "Delete (in tree)"],
    ["Alt+Enter", "Project Properties"],
  ];
  appendOutput("=== Keyboard Shortcuts ===", "ok");
  for (const [k, d] of shortcuts) appendOutput("  " + k.padEnd(18) + d);
  showPanel("output");
}

// ─── New File dialog ──────────────────────────────────────────────────────

const NEWFILE_TEMPLATES = {
  empty: "",
  "cpp-main": `#include <stdio.h>\n\nint main(int argc, char** argv) {\n    printf("Hello from ForgeIDE!\\n");\n    return 0;\n}\n`,
  "c-main": `#include <stdio.h>\n\nint main(void) {\n    printf("Hello, world!\\n");\n    return 0;\n}\n`,
  header: `#pragma once\n\n`,
  rc: `// Resources\n`,
};

function handleNewFile() {
  const path = document.getElementById("newfile-path").value.trim();
  const tpl = document.getElementById("newfile-template").value;
  if (!path) return;
  addFile(path, NEWFILE_TEMPLATES[tpl] || "");
  refreshExplorer();
  document.getElementById("newfile-path").value = "";
  document.getElementById("newfile-dialog").classList.add("hidden");
  openFile(path);
  selectFile(path);
  updatePropertiesForFile(path);
}
// ─── Config dropdowns ────────────────────────────────────────────────────

const cfgConfig = document.getElementById("cfg-config");
const cfgPlatform = document.getElementById("cfg-platform");

cfgConfig.addEventListener("change", (e) => {
  if (!setActiveConfig(e.target.value)) {
    syncConfigUI();
    return;
  }

  syncConfigUI();
});

cfgPlatform.addEventListener("change", (e) => {
  if (!setActivePlatform(e.target.value)) {
    syncConfigUI();
    return;
  }

  syncConfigUI();
});

export function syncConfigUI() {
  cfgConfig.value = project.activeConfig;
  cfgPlatform.value = project.activePlatform;

  const propCfg = document.getElementById("propdlg-cfg");
  const propPlat = document.getElementById("propdlg-plat");

  if (propCfg) {
    propCfg.value = project.activeConfig;
  }

  if (propPlat) {
    propPlat.value = project.activePlatform;
  }

  const sb = document.getElementById("sb-config");

  if (sb) {
    sb.textContent = `${project.activeConfig} | ${project.activePlatform}`;
  }
}

// ─── File select handler ──────────────────────────────────────────────────

function handleFileSelect(path) {
  openFile(path);
  selectFile(path);
  updatePropertiesForFile(path);
}

function updatePropertiesForFile(path) {
  const panel = document.getElementById("prop-panel");
  const file = project.files.get(path);
  if (!file) {
    panel.innerHTML = '<div class="prop-empty">Select an item.</div>';
    return;
  }
  const ext = path.split(".").pop();
  const size = file.binary
    ? file.bytes?.length || 0
    : file.content?.length || 0;
  panel.innerHTML = `
    <div class="prop-cat">File</div>
    <div class="prop-row"><span class="k">Path</span><span class="v">${path}</span></div>
    <div class="prop-row"><span class="k">Name</span><span class="v">${path.split("/").pop()}</span></div>
    <div class="prop-row"><span class="k">Type</span><span class="v">.${ext}</span></div>
    <div class="prop-row"><span class="k">Size</span><span class="v">${size} B</span></div>
    <div class="prop-row"><span class="k">Dirty</span><span class="v">${file.dirty ? "yes" : "no"}</span></div>
  `;
}

// ─── Search panel ─────────────────────────────────────────────────────────

function wireSearchPanel() {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");
  if (!input) return;

  let debounceTimer;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(input.value, results), 200);
  });
}

function runSearch(query, resultsEl) {
  resultsEl.innerHTML = "";
  if (!query || query.length < 2) return;

  const lower = query.toLowerCase();
  const hits = [];
  for (const [path, f] of project.files) {
    if (f.binary) continue;
    const text = f.content || "";
    const lines = text.split("\n");
    const fileHits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lower)) {
        fileHits.push({ line: i + 1, text: lines[i] });
      }
    }
    if (fileHits.length > 0) hits.push({ path, hits: fileHits });
  }

  if (hits.length === 0) {
    resultsEl.innerHTML = '<div class="tree-empty">No results.</div>';
    return;
  }

  for (const h of hits) {
    const fileEl = document.createElement("div");
    fileEl.className = "search-file";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = h.path;
    const countSpan = document.createElement("span");
    countSpan.className = "count";
    countSpan.textContent = h.hits.length;
    fileEl.appendChild(nameSpan);
    fileEl.appendChild(countSpan);
    fileEl.addEventListener("click", () => {
      openFile(h.path);
      selectFile(h.path);
    });
    resultsEl.appendChild(fileEl);

    for (const hit of h.hits.slice(0, 20)) {
      const hitEl = document.createElement("div");
      hitEl.className = "search-hit";
      const ln = document.createElement("span");
      ln.className = "ln";
      ln.textContent = hit.line;
      const txt = document.createElement("span");
      txt.className = "text";
      txt.textContent = hit.text;
      hitEl.appendChild(ln);
      hitEl.appendChild(txt);
      hitEl.addEventListener("click", () => {
        openFile(h.path);
        selectFile(h.path);
        revealLine(hit.line, 1);
      });
      resultsEl.appendChild(hitEl);
    }
    if (h.hits.length > 20) {
      const more = document.createElement("div");
      more.className = "search-hit";
      more.style.color = "#8a8a8a";
      more.textContent = `… ${h.hits.length - 20} more`;
      resultsEl.appendChild(more);
    }
  }
}

// ─── ZIP import ───────────────────────────────────────────────────────────

function wireImportZip() {
  const input = document.getElementById("import-zip-input");
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    input.value = "";
    try {
      appendOutput("Importing project…", "dim");
      const { meta, files } = await importProjectZip(file);
      replaceProject(
        meta.name || "ImportedProject",
        files,
        meta.configs || null,
        meta.activeConfig,
        meta.activePlatform,
      );

      syncConfigUI();
      refreshExplorer();
      appendOutput(`Imported ${files.size} files from ${file.name}.`, "ok");
      const firstPath = [...files.keys()].find((p) => !p.endsWith(".obj"));
      if (firstPath) {
        openFile(firstPath);
        selectFile(firstPath);
      }
    } catch (e) {
      appendOutput("Import failed: " + e.message, "err");
    }
  });
}

// ─── Palette commands registration ────────────────────────────────────────

function refreshPaletteCommands() {
  registerCommands(
    Object.entries(COMMANDS).map(([, c]) => ({
      label: c.label,
      shortcut: c.shortcut,
      action: () => c.run(),
    })),
  );
}

// ─── Boot ─────────────────────────────────────────────────────────────────

async function boot() {
  initLayout();
  initOutput();
  initResourceCreator();
  wireSearchPanel();
  wireImportZip();

  appendOutput("ForgeIDE 0.2.0 — booting…", "ok");
  appendOutput("clang.wasm · lld.wasm · llvm-rc.wasm", "dim");
  appendOutput("");

  const restored = await bootstrapFromStorage();
  if (restored) {
    appendOutput(
      `Restored project "${project.name}" (${project.files.size} files).`,
      "ok",
    );
  } else {
    appendOutput("No saved project. Creating default…", "warn");
    resetToDefault();
  }

  await initMonaco();
  renderExplorer(handleFileSelect);
  document.__handleFileSelect = handleFileSelect;
  selectFile(getActivePath());

  initShortcuts(runCommand);
  refreshPaletteCommands();

  const first = [...project.files.keys()].find(
    (p) => !p.endsWith(".obj") && !p.endsWith(".keep"),
  );
  if (first) {
    openFile(first);
    selectFile(first);
    updatePropertiesForFile(first);
  }

  syncConfigUI();
  setStatus("Booting toolchain…");
  initBuildWorker();
  initTerminal();

  window.addEventListener("beforeunload", () => {
    import("./persistence.js").then((m) => m.saveProject(project));
  });

  setStatus("Ready");
}

boot();
