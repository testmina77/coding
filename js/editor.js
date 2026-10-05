// editor.js — Monaco + tabs + breadcrumbs + toggles + hover/peek

import { project, getFile, setFileContent } from "./project.js";
import {
  registerCompletion,
  registerHover,
  invalidateCompletionCache,
} from "./completion.js";
import { loadSetting, saveSetting } from "./persistence.js";

let monacoEditor = null;
let monacoReady = false;

const tabsEl = document.getElementById("editor-tabs");
const welcomeEl = document.getElementById("welcome");
const monacoEl = document.getElementById("monaco");
const breadcrumbsEl = document.getElementById("breadcrumbs");

const openTabs = new Map();
let activePath = null;

const editorSettings = {
  minimap: loadSetting("editor.minimap", true),
  wordWrap: loadSetting("editor.wordWrap", false),
};

export function initMonaco() {
  return new Promise((resolve) => {
    require.config({
      paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" },
    });
    require(["vs/editor/editor.main"], () => {
      monaco.editor.defineTheme("forge-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#1e1e1e",
          "editor.foreground": "#d4d4d4",
          "editorLineNumber.foreground": "#858585",
          "editorLineNumber.activeForeground": "#c6c6c6",
          "editor.selectionBackground": "#264f78",
          "editor.inactiveSelectionBackground": "#3a3d41",
          "editor.lineHighlightBackground": "#ffffff0a",
          "editorCursor.foreground": "#aeafad",
          "editorWhitespace.foreground": "#3b3b3b",
          "editorIndentGuide.background": "#404040",
          "editorIndentGuide.activeBackground": "#707070",
          "editorWidget.background": "#252526",
          "editorWidget.border": "#454545",
          "editorSuggestWidget.background": "#252526",
          "editorSuggestWidget.border": "#454545",
          "editorSuggestWidget.selectedBackground": "#04395e",
          "editorHoverWidget.background": "#252526",
          "editorHoverWidget.border": "#454545",
          "editorGutter.background": "#1e1e1e",
          "editorGroup.border": "#444444",
        },
      });

      monacoEditor = monaco.editor.create(monacoEl, {
        value: "",
        language: "cpp",
        theme: "forge-dark",
        automaticLayout: true,
        fontSize: 14,
        fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
        minimap: { enabled: editorSettings.minimap },
        wordWrap: editorSettings.wordWrap ? "on" : "off",
        scrollBeyondLastLine: false,
        tabSize: 4,
        insertSpaces: true,
        renderWhitespace: "selection",
        bracketPairColorization: { enabled: true },
        suggest: {
          showMethods: true,
          showFunctions: true,
          showVariables: true,
        },
        hover: { enabled: true, delay: 200 },
        definitionLinkOpensInPeek: true,
        breadcrumbs: { enabled: false },
        occurrencesHighlight: "singleFile",
        selectionHighlight: true,
        renderLineHighlight: "all",
        smoothScrolling: true,
        cursorBlinking: "smooth",
        fontLigatures: true,
      });

      monacoEditor.onDidChangeCursorPosition((e) => {
        const pos = e.position;
        const el = document.getElementById("sb-lncol");
        if (el) el.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
      });

      monacoEditor.onDidChangeModelContent(() => {
        if (activePath) {
          setFileContent(activePath, monacoEditor.getValue());
          markTabDirty(activePath);
        }
        invalidateCompletionCache();
      });

      monacoEditor.addAction({
        id: "forge.compile-file",
        label: "Compile File",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 0.5,
        run: () => import("./app.js").then((m) => m.runCommand("compile-file")),
      });
      monacoEditor.addAction({
        id: "forge.format-document",
        label: "Format Document",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 0.6,
        keybindings: [
          monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
        ],
        run: () => import("./format.js").then((m) => m.formatActiveDocument()),
      });
      monacoEditor.addAction({
        id: "forge.show-in-explorer",
        label: "Reveal in Explorer",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 0.7,
        run: () => {
          const p = getActivePath();
          if (p && document.__handleFileSelect) document.__handleFileSelect(p);
        },
      });

      registerCompletion(monaco);
      registerHover(monaco);

      monacoReady = true;
      updateToggleUI();
      resolve();
    });
  });
}

function markTabDirty(path) {
  const tab = tabsEl.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (tab && !tab.querySelector(".dirty")) {
    const dot = document.createElement("span");
    dot.className = "dirty";
    tab.querySelector(".close")?.before(dot);
  }
}

export function openFile(path) {
  if (!monacoReady) return;
  const file = getFile(path);
  if (!file) return;

  if (!openTabs.has(path)) {
    const language = langFromPath(path);
    const model = monaco.editor.createModel(
      file.content || "",
      language,
      monaco.Uri.file(path),
    );
    openTabs.set(path, { model });
  }

  activePath = path;
  monacoEditor.setModel(openTabs.get(path).model);
  welcomeEl.classList.remove("visible");
  renderTabs();
  updateBreadcrumbs();
  updateLanguageStatus(path);
  import("./explorer.js").then((m) => m.refresh()).catch(() => {}); // ← DODAJ
}

export function closeTab(path) {
  const entry = openTabs.get(path);
  if (!entry) return;
  entry.model.dispose();
  openTabs.delete(path);
  if (activePath === path) {
    activePath = null;
    const next = openTabs.keys().next().value;
    if (next) openFile(next);
    else {
      monacoEditor.setModel(null);
      welcomeEl.classList.add("visible");
      updateBreadcrumbs();
    }
  }
  renderTabs();
  import("./explorer.js").then((m) => m.refresh()).catch(() => {}); // ← DODAJ
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const [path] of openTabs) {
    const tab = document.createElement("div");
    tab.className = "tab" + (path === activePath ? " active" : "");
    tab.dataset.path = path;

    const name = path.split("/").pop();
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = name;
    label.title = path;
    tab.appendChild(label);

    const f = project.files.get(path);
    if (f && f.dirty) {
      const dot = document.createElement("span");
      dot.className = "dirty";
      tab.appendChild(dot);
    }

    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "✕";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(path);
    });
    tab.appendChild(close);

    tab.addEventListener("click", () => openFile(path));
    tabsEl.appendChild(tab);
  }
}

function updateBreadcrumbs() {
  if (!activePath) {
    breadcrumbsEl.innerHTML = "";
    return;
  }
  const parts = activePath.split("/");
  breadcrumbsEl.innerHTML = "";
  parts.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      breadcrumbsEl.appendChild(sep);
    }
    const crumb = document.createElement("span");
    crumb.className = "crumb";
    crumb.textContent = p;
    breadcrumbsEl.appendChild(crumb);
  });
}

function updateLanguageStatus(path) {
  const el = document.getElementById("sb-language");
  if (!el) return;
  const lang = langFromPath(path);
  const map = {
    cpp: "C++",
    c: "C",
    json: "JSON",
    xml: "XML",
    asm: "Assembly",
    plaintext: "Plain Text",
  };
  el.textContent = map[lang] || lang;
}

function langFromPath(path) {
  if (/\.(c|h)$/i.test(path)) return "c";
  if (/\.(cpp|cc|cxx|hpp|hxx)$/i.test(path)) return "cpp";
  if (/\.(rc)$/i.test(path)) return "plaintext";
  if (/\.(asm|s)$/i.test(path)) return "asm";
  if (/\.(json)$/i.test(path)) return "json";
  if (/\.(xml|resx)$/i.test(path)) return "xml";
  return "plaintext";
}

export function getActivePath() {
  return activePath;
}
export function getMonaco() {
  return monacoEditor;
}
export function getMonacoReady() {
  return monacoReady;
}
export function getOpenTabPaths() {
  return [...openTabs.keys()];
}

export function toggleMinimap() {
  editorSettings.minimap = !editorSettings.minimap;
  saveSetting("editor.minimap", editorSettings.minimap);
  monacoEditor?.updateOptions({ minimap: { enabled: editorSettings.minimap } });
  updateToggleUI();
}

export function toggleWordWrap() {
  editorSettings.wordWrap = !editorSettings.wordWrap;
  saveSetting("editor.wordWrap", editorSettings.wordWrap);
  monacoEditor?.updateOptions({
    wordWrap: editorSettings.wordWrap ? "on" : "off",
  });
  updateToggleUI();
}

function updateToggleUI() {
  document
    .getElementById("sb-minimap")
    ?.classList.toggle("active", editorSettings.minimap);
  document
    .getElementById("sb-wordwrap")
    ?.classList.toggle("active", editorSettings.wordWrap);
}

export function revealLine(line, col = 1) {
  if (!monacoEditor) return;
  monacoEditor.revealLineInCenter(line);
  monacoEditor.setPosition({ lineNumber: line, column: col });
  monacoEditor.focus();
}

export function setActiveContent(content) {
  if (!monacoEditor) return;
  monacoEditor.setValue(content);
}
