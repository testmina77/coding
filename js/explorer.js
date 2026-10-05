// explorer.js — file tree with context menu, inline rename, icons

import {
  project,
  buildTree,
  addFile,
  removeFile,
  renameFile as renameFileModel,
} from "./project.js";
import {
  openFile,
  closeTab,
  getActivePath,
  getOpenTabPaths,
} from "./editor.js";
import { showContextMenu } from "./contextmenu.js";
import { loadSetting, saveSetting } from "./persistence.js";

const root = document.getElementById("explorer-tree");
const openEditorsEl = document.getElementById("open-editors");

const ICONS = {
  c: { text: "C", color: "#519aba" },
  cpp: { text: "C+", color: "#519aba" },
  cc: { text: "C+", color: "#519aba" },
  cxx: { text: "C+", color: "#519aba" },
  h: { text: "H", color: "#a074c4" },
  hpp: { text: "H+", color: "#a074c4" },
  hxx: { text: "H+", color: "#a074c4" },
  js: { text: "JS", color: "#cbcb41" },
  json: { text: "{}", color: "#cbcb41" },
  md: { text: "M", color: "#519aba" },
  txt: { text: "T", color: "#cccccc" },
  wav: { text: "♪", color: "#9c6cd6" },
  png: { text: "▣", color: "#9c6cd6" },
  jpg: { text: "▣", color: "#9c6cd6" },
  obj: { text: "O", color: "#e37933" },
  exe: { text: "▸", color: "#73c991" },
  rc: { text: "R", color: "#e37933" },
  asm: { text: "A", color: "#cccccc" },
  s: { text: "A", color: "#cccccc" },
};

let selectedPath = null;
let focusedPath = null;
const collapsed = new Set(loadSetting("explorer.collapsed", []));

export function renderExplorer(onSelect) {
  renderOpenEditors(onSelect);
  renderTree(onSelect);
  updateWorkspaceTitle();
}

function renderOpenEditors(onSelect) {
  openEditorsEl.innerHTML = "";
  const open = getOpenTabPaths();
  if (open.length === 0) {
    openEditorsEl.innerHTML = '<div class="tree-empty">No open editors</div>';
    return;
  }
  for (const path of open) {
    const row = document.createElement("div");
    row.className = "tree-node";
    row.dataset.path = path;
    if (path === getActivePath()) row.classList.add("selected");

    const icon = document.createElement("span");
    icon.className = "file-icon";
    const ic = iconFor(path);
    icon.textContent = ic.text;
    icon.style.color = ic.color;
    row.appendChild(icon);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = path.split("/").pop();
    row.appendChild(label);

    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "✕";
    close.style.cssText =
      "opacity:0.6;padding:0 4px;font-size:10px;cursor:pointer;";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(path);
      renderExplorer(onSelect);
    });
    row.appendChild(close);

    row.addEventListener("click", () => {
      selectedPath = path;
      onSelect?.(path);
      renderExplorer(onSelect);
    });

    openEditorsEl.appendChild(row);
  }
}

function renderTree(onSelect) {
  root.innerHTML = "";
  const tree = buildTree();
  renderChildren(tree, 0, onSelect);
}

function renderChildren(node, depth, onSelect) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of children) {
    renderNode(child, depth, onSelect);
  }
}

function renderNode(node, depth, onSelect) {
  const row = document.createElement("div");
  row.className = "tree-node";
  row.dataset.path = node.path;
  row.style.paddingLeft = 4 + depth * 12 + "px";

  if (node.path === selectedPath) row.classList.add("selected");
  if (node.path === focusedPath) row.classList.add("focused");

  if (node.type === "folder") {
    const isCollapsed = collapsed.has(node.path);
    if (isCollapsed) row.classList.add("collapsed");
    const chev = document.createElement("span");
    chev.className = "chevron";
    chev.textContent = "▼";
    row.appendChild(chev);

    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = isCollapsed ? "📁" : "📂";
    icon.style.fontSize = "12px";
    row.appendChild(icon);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "chevron";
    row.appendChild(spacer);

    const icon = document.createElement("span");
    icon.className = "file-icon";
    const ic = iconFor(node.name);
    icon.textContent = ic.text;
    icon.style.color = ic.color;
    icon.style.fontSize = "10px";
    row.appendChild(icon);
  }

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = node.name;
  row.appendChild(label);

  const f = project.files.get(node.path);
  if (f && f.dirty) {
    const dot = document.createElement("span");
    dot.className = "dirty";
    row.appendChild(dot);
  }

  row.addEventListener("click", () => {
    selectedPath = node.path;
    focusedPath = node.path;
    if (node.type === "file") {
      onSelect?.(node.path);
    } else {
      toggleCollapse(node.path, onSelect);
    }
    renderExplorer(onSelect);
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectedPath = node.path;
    showNodeContextMenu(e.clientX, e.clientY, node, onSelect);
  });

  row.addEventListener("dblclick", () => {
    if (node.type === "file") startInlineRename(node, onSelect);
  });

  root.appendChild(row);

  if (node.type === "folder" && !collapsed.has(node.path)) {
    renderChildren(node, depth + 1, onSelect);
  }
}

function toggleCollapse(path, onSelect) {
  if (collapsed.has(path)) collapsed.delete(path);
  else collapsed.add(path);
  saveSetting("explorer.collapsed", [...collapsed]);
  renderTree(onSelect);
}

function showNodeContextMenu(x, y, node, onSelect) {
  const items = [];
  if (node.type === "file") {
    items.push(
      { label: "Open", action: () => onSelect?.(node.path) },
      { separator: true },
      {
        label: "Rename…",
        shortcut: "F2",
        action: () => startInlineRename(node, onSelect),
      },
      {
        label: "Delete",
        shortcut: "Del",
        action: () => deleteNode(node, onSelect),
      },
      { label: "Duplicate", action: () => duplicateNode(node, onSelect) },
      { separator: true },
      {
        label: "Copy Path",
        action: () => navigator.clipboard.writeText(node.path),
      },
    );
  } else if (node.type === "folder") {
    items.push(
      {
        label: "New File…",
        action: () => promptNewFile(node.path + "/", onSelect),
      },
      {
        label: "New Folder…",
        action: () => promptNewFolder(node.path + "/", onSelect),
      },
      { separator: true },
      { label: "Rename…", action: () => startInlineRename(node, onSelect) },
      {
        label: "Delete Folder",
        action: () => deleteFolder(node.path, onSelect),
      },
      { separator: true },
      {
        label: "Copy Path",
        action: () => navigator.clipboard.writeText(node.path),
      },
    );
  }
  showContextMenu(x, y, items);
}

function startInlineRename(node, onSelect) {
  const row = root.querySelector(`[data-path="${CSS.escape(node.path)}"]`);
  if (!row) return;
  const labelEl = row.querySelector(".label");
  if (!labelEl) return;

  const original = node.name;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.type = "text";
  input.value = original;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  const finish = (commit) => {
    const val = input.value.trim();
    if (commit && val && val !== original) {
      const dir = node.path.includes("/")
        ? node.path.slice(0, node.path.lastIndexOf("/"))
        : "";
      const newPath = dir ? dir + "/" + val : val;
      renameFileModel(node.path, newPath);
    }
    renderExplorer(onSelect);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function deleteNode(node, onSelect) {
  if (!confirm(`Delete ${node.path}?`)) return;
  removeFile(node.path);
  if (getActivePath() === node.path) closeTab(node.path);
  renderExplorer(onSelect);
}

function deleteFolder(prefix, onSelect) {
  if (!confirm(`Delete folder ${prefix} and all contents?`)) return;
  const toDelete = [];
  for (const [p] of project.files) {
    if (p === prefix || p.startsWith(prefix + "/")) toDelete.push(p);
  }
  for (const p of toDelete) {
    removeFile(p);
    if (getActivePath() === p) closeTab(p);
  }
  renderExplorer(onSelect);
}

function duplicateNode(node, onSelect) {
  const f = project.files.get(node.path);
  if (!f) return;
  const dotIdx = node.path.lastIndexOf(".");
  const newPath =
    dotIdx > 0
      ? node.path.slice(0, dotIdx) + ".copy" + node.path.slice(dotIdx)
      : node.path + ".copy";
  const copy = { ...f, path: newPath, dirty: true };
  project.files.set(newPath, copy);
  renderExplorer(onSelect);
}

function promptNewFile(prefix, onSelect) {
  const name = prompt("New file path:", prefix);
  if (!name) return;
  addFile(name, "");
  renderExplorer(onSelect);
  openFile(name);
  onSelect?.(name);
}

function promptNewFolder(prefix, onSelect) {
  const name = prompt("New folder name:", prefix);
  if (!name) return;
  addFile(name.replace(/\/+$/, "") + "/.keep", "");
  renderExplorer(onSelect);
}

function iconFor(name) {
  const ext = name.split(".").pop().toLowerCase();
  return ICONS[ext] || { text: "▪", color: "#858585" };
}

function updateWorkspaceTitle() {
  const el = document.getElementById("workspace-title");
  if (el) el.textContent = project.name.toUpperCase();
}

export function selectFile(path) {
  selectedPath = path;
  focusedPath = path;
}

export function refresh() {
  renderExplorer(document.__handleFileSelect);
}

document.addEventListener("click", (e) => {
  if (
    !e.target.closest("#explorer-tree") &&
    !e.target.closest("#open-editors")
  ) {
    focusedPath = null;
  }
});

document.addEventListener("keydown", (e) => {
  if (!selectedPath) return;
  if (document.activeElement?.tagName === "INPUT") return;
  if (e.key === "F2") {
    e.preventDefault();
    const node = {
      path: selectedPath,
      name: selectedPath.split("/").pop(),
      type: project.files.has(selectedPath) ? "file" : "folder",
    };
    startInlineRename(node, document.__handleFileSelect);
  } else if (e.key === "Delete") {
    e.preventDefault();
    if (project.files.has(selectedPath)) {
      const node = {
        path: selectedPath,
        name: selectedPath.split("/").pop(),
        type: "file",
      };
      deleteNode(node, document.__handleFileSelect);
    }
  }
});
