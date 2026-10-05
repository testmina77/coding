// terminal.js — line-based shell with real commands

import { project, addFile, removeFile } from "./project.js";
import { appendOutput } from "./output.js";
import { build } from "./build.js";
import { formatActiveDocument } from "./format.js";

const terminalEl = document.querySelector('.panel-view[data-panel="terminal"]');

const state = {
  cwd: "/work",
  prompt: "~/work $ ",
  history: [],
  histIdx: -1,
  buffer: "",
  initialized: false,
};

export function initTerminal() {
  if (state.initialized) return;
  state.initialized = true;
  terminalEl.innerHTML = "";
  terminalEl.tabIndex = 0;
  terminalEl.style.outline = "none";
  writeLine("ForgeIDE Terminal — type `help` for available commands.", "dim");
  writeLine("");
  renderPrompt();
}

export function focusTerminal() {
  if (!state.initialized) initTerminal();
  const input = terminalEl.querySelector(".term-input");
  if (input) input.focus();
}

export function writeLine(text, cls = "") {
  const el = document.createElement("div");
  el.className = "out-line" + (cls ? " out-" + cls : "");
  el.textContent = text;
  terminalEl.appendChild(el);
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

function renderPrompt() {
  const line = document.createElement("div");
  line.className = "out-line term-line";
  const promptSpan = document.createElement("span");
  promptSpan.className = "out-ok";
  promptSpan.textContent = state.prompt;
  const input = document.createElement("input");
  input.className = "term-input";
  input.type = "text";
  input.value = state.buffer;
  input.style.cssText =
    "background:transparent;border:none;outline:none;color:inherit;font:inherit;flex:1;width:100%;padding:0;margin-left:4px;";

  input.addEventListener("input", () => {
    state.buffer = input.value;
  });
  input.addEventListener("keydown", onKeyDown);

  line.appendChild(promptSpan);
  line.appendChild(input);
  terminalEl.appendChild(line);
  terminalEl.scrollTop = terminalEl.scrollHeight;
  setTimeout(() => input.focus(), 0);
}

function onKeyDown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    const cmd = state.buffer.trim();
    const lines = terminalEl.querySelectorAll(".term-line");
    const last = lines[lines.length - 1];
    if (last) last.remove();
    writeLine(state.prompt + cmd, "cmd");
    if (cmd) {
      state.history.push(cmd);
      state.histIdx = state.history.length;
      runCommand(cmd);
    }
    state.buffer = "";
    renderPrompt();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (state.histIdx > 0) {
      state.histIdx--;
      updateInput(state.history[state.histIdx]);
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (state.histIdx < state.history.length - 1) {
      state.histIdx++;
      updateInput(state.history[state.histIdx]);
    } else {
      state.histIdx = state.history.length;
      updateInput("");
    }
  } else if (e.key === "l" && e.ctrlKey) {
    e.preventDefault();
    clearTerminal();
  } else if (e.key === "c" && e.ctrlKey) {
    e.preventDefault();
    writeLine(state.prompt + state.buffer + "^C");
    state.buffer = "";
    renderPrompt();
  }
}

function updateInput(val) {
  const input = terminalEl.querySelector(".term-input");
  if (input) {
    input.value = val;
    state.buffer = val;
  }
}

function clearTerminal() {
  terminalEl.innerHTML = "";
  renderPrompt();
}

function runCommand(line) {
  const parts = line.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const cmd = parts[0];
  const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ""));

  switch (cmd) {
    case "help":
      return cmdHelp();
    case "clear":
      return clearTerminal();
    case "echo":
      return writeLine(args.join(" "));
    case "pwd":
      return writeLine(state.cwd);
    case "ls":
      return cmdLs(args);
    case "cat":
      return cmdCat(args);
    case "cd":
      return cmdCd(args);
    case "tree":
      return cmdTree();
    case "mkdir":
      return cmdMkdir(args);
    case "touch":
      return cmdTouch(args);
    case "rm":
      return cmdRm(args);
    case "build":
      return cmdBuild();
    case "clean":
      return cmdClean();
    case "format":
      return cmdFormat();
    case "run":
      return cmdRun();
    case "version":
      return writeLine("ForgeIDE 0.2.0 — clang.wasm · lld.wasm");
    case "":
      return;
    default:
      writeLine(`${cmd}: command not found. Type \`help\`.`, "err");
  }
}

function cmdHelp() {
  writeLine("Available commands:", "ok");
  const cmds = [
    ["help", "show this help"],
    ["ls [path]", "list files"],
    ["cat <file>", "print file"],
    ["cd <path>", "change directory"],
    ["pwd", "print working directory"],
    ["tree", "print project tree"],
    ["mkdir <path>", "create folder"],
    ["touch <file>", "create empty file"],
    ["rm <file>", "delete file"],
    ["echo <text>", "print text"],
    ["clear", "clear terminal"],
    ["build", "build solution"],
    ["clean", "clear output"],
    ["format", "format active document"],
    ["run", "build and run"],
    ["version", "print version"],
  ];
  for (const [c, d] of cmds) writeLine("  " + c.padEnd(14) + d);
}

function resolvePath(p) {
  if (!p) return state.cwd;
  if (p.startsWith("/")) return p;
  if (p === "..") {
    const idx = state.cwd.lastIndexOf("/");
    return idx <= 0 ? "/" : state.cwd.slice(0, idx);
  }
  if (p === ".") return state.cwd;
  return state.cwd === "/" ? "/" + p : state.cwd + "/" + p;
}

function toProjectPath(absPath) {
  if (absPath.startsWith("/work/")) return absPath.slice(6);
  if (absPath === "/work") return "";
  return absPath.replace(/^\//, "");
}

function cmdLs(args) {
  const target = args[0] ? resolvePath(args[0]) : state.cwd;
  const prefix = toProjectPath(target);
  const entries = new Set();
  for (const [path] of project.files) {
    if (prefix) {
      if (path === prefix) continue;
      if (!path.startsWith(prefix + "/")) continue;
      const rest = path.slice(prefix.length + 1);
      const first = rest.split("/")[0];
      const isDir = rest.includes("/");
      entries.add(isDir ? first + "/" : first);
    } else {
      const first = path.split("/")[0];
      const isDir = path.includes("/");
      entries.add(isDir ? first + "/" : first);
    }
  }
  if (entries.size === 0) {
    writeLine("(empty)", "dim");
    return;
  }
  for (const e of [...entries].sort()) {
    writeLine("  " + e, e.endsWith("/") ? "info" : "");
  }
}

function cmdCat(args) {
  if (!args[0]) return writeLine("cat: missing argument", "err");
  const path = toProjectPath(resolvePath(args[0]));
  const f = project.files.get(path);
  if (!f) return writeLine(`cat: ${args[0]}: no such file`, "err");
  if (f.binary)
    return writeLine(
      `cat: ${args[0]}: binary (${f.bytes?.length || 0} B)`,
      "warn",
    );
  for (const line of (f.content || "").split("\n")) writeLine(line);
}

function cmdCd(args) {
  const target = resolvePath(args[0] || "/work");
  if (target === "/work") {
    state.cwd = "/work";
    state.prompt = "~/work $ ";
    return;
  }
  const prefix = toProjectPath(target);
  let exists = false;
  for (const [path] of project.files) {
    if (path.startsWith(prefix + "/")) {
      exists = true;
      break;
    }
  }
  if (!exists) return writeLine(`cd: ${args[0]}: no such directory`, "err");
  state.cwd = target;
  state.prompt = "~/" + prefix + " $ ";
}

function cmdTree() {
  writeLine(project.name + "/", "ok");
  const paths = [...project.files.keys()].sort();
  const seen = new Set();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join("/");
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      const isLeaf = i === parts.length - 1;
      writeLine(
        "  ".repeat(i) +
          (isLeaf ? "├─ " : "▸ ") +
          parts[i] +
          (isLeaf ? "" : "/"),
      );
    }
  }
}

function cmdMkdir(args) {
  if (!args[0]) return writeLine("mkdir: missing argument", "err");
  const path = toProjectPath(resolvePath(args[0]));
  addFile(path + "/.keep", "");
  writeLine("created " + path, "ok");
}

function cmdTouch(args) {
  if (!args[0]) return writeLine("touch: missing argument", "err");
  const path = toProjectPath(resolvePath(args[0]));
  if (project.files.has(path)) return;
  addFile(path, "");
  writeLine("created " + path, "ok");
}

function cmdRm(args) {
  if (!args[0]) return writeLine("rm: missing argument", "err");
  const path = toProjectPath(resolvePath(args[0]));
  if (!project.files.has(path))
    return writeLine(`rm: ${args[0]}: no such file`, "err");
  removeFile(path);
  writeLine("removed " + path, "ok");
}

async function cmdBuild() {
  writeLine("building…", "warn");
  try {
    await build();
  } catch (e) {
    writeLine("build error: " + e.message, "err");
  }
}

function cmdClean() {
  import("./output.js").then((m) => m.clearOutput());
  writeLine("output cleared", "ok");
}

async function cmdFormat() {
  const { getActivePath } = await import("./editor.js");
  const p = getActivePath();
  if (!p) return writeLine("format: no active document", "warn");
  try {
    await formatActiveDocument();
    writeLine("formatted " + p, "ok");
  } catch (e) {
    writeLine("format: " + e.message, "err");
  }
}

async function cmdRun() {
  await cmdBuild();
  writeLine("run: execution not supported — download the .exe", "warn");
}

export function runTerminalCommand(cmd) {
  writeLine(state.prompt + cmd, "cmd");
  runCommand(cmd);
  state.buffer = "";
  renderPrompt();
}
