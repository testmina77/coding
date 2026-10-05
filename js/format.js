// format.js — clang-format.wasm loader (optional) with fallback indent fixer

import { getMonaco, getActivePath } from "./editor.js";
import { getFile, setFileContent } from "./project.js";

let formatLoadAttempted = false;

async function loadFormatTool() {
  if (formatLoadAttempted) return null;
  formatLoadAttempted = true;
  try {
    const res = await fetch("bin/clang-format.wasm");
    if (!res.ok) return null;
    await res.arrayBuffer();
    return null; // placeholder: real runtime not wired yet
  } catch {
    return null;
  }
}

function fallbackFormat(code) {
  const lines = code.split("\n");
  let indent = 0;
  const out = [];
  for (const raw of lines) {
    let line = raw.trimEnd();
    const trimmed = line.trimStart();
    if (trimmed.startsWith("}") || trimmed.startsWith(")"))
      indent = Math.max(0, indent - 1);
    if (trimmed) {
      line = "    ".repeat(indent) + trimmed;
    } else {
      line = "";
    }
    out.push(line);
    const opens = (trimmed.match(/{/g) || []).length;
    const closes = (trimmed.match(/}/g) || []).length;
    indent += opens - closes;
    if (indent < 0) indent = 0;
  }
  return out.join("\n");
}

export async function formatActiveDocument() {
  const path = getActivePath();
  if (!path) throw new Error("No active document");

  const monacoEditor = getMonaco();
  if (!monacoEditor) throw new Error("Editor not ready");

  const source = monacoEditor.getValue();
  const formatted = fallbackFormat(source);

  if (formatted !== source) {
    monacoEditor.executeEdits("format", [
      {
        range: monacoEditor.getModel().getFullModelRange(),
        text: formatted,
      },
    ]);
  }
  return formatted;
}

export function isFormatAvailable() {
  return false;
}
