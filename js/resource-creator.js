// resource-creator.js — binary → COFF + .h

import { project, addFile } from "./project.js";
import { renderExplorer } from "./explorer.js";
import { openFile } from "./editor.js";
import { appendOutput } from "./output.js";
import { binaryToCoff, generateHeader } from "./coffwriter.js";

export function openResourceCreator() {
  const dlg = document.getElementById("res-dialog");
  dlg.classList.remove("hidden");
  resetUI();
}

export function closeResourceCreator() {
  document.getElementById("res-dialog").classList.add("hidden");
  resetUI();
}

let selectedFile = null;

function resetUI() {
  selectedFile = null;
  document.getElementById("res-drop-hint").style.display = "";
  document.getElementById("res-file-info").style.display = "none";
  document.getElementById("res-file-info").textContent = "";
  document.getElementById("res-target-dir").value = "res";
  document.getElementById("res-symbol").value = "";
  document.getElementById("res-create").disabled = true;
}

export function initResourceCreator() {
  const drop = document.getElementById("res-drop");
  if (!drop) return;

  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("drag-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("drag-over");
    const f = e.dataTransfer.files[0];
    if (f) await loadFile(f);
  });
  drop.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener("change", async () => {
      if (input.files[0]) await loadFile(input.files[0]);
    });
    input.click();
  });

  document.getElementById("res-create").addEventListener("click", doCreate);
  document
    .getElementById("res-cancel")
    .addEventListener("click", closeResourceCreator);
  document
    .getElementById("res-close")
    .addEventListener("click", closeResourceCreator);
}

async function loadFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  selectedFile = { name: file.name, bytes };
  document.getElementById("res-drop-hint").style.display = "none";
  const info = document.getElementById("res-file-info");
  info.style.display = "";
  info.textContent = `${file.name}  —  ${bytes.length} B`;
  const sym = file.name.replace(/^.*[\\/]/, "").replace(/[^a-zA-Z0-9]/g, "_");
  document.getElementById("res-symbol").value = sym;
  document.getElementById("res-create").disabled = false;
}

function sanitizeSymbol(s) {
  let r = s.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(r)) r = "_" + r;
  return r;
}

async function doCreate() {
  if (!selectedFile) return;
  const targetDir = (
    document.getElementById("res-target-dir").value || "res"
  ).replace(/\/+$/, "");
  const symbolRaw =
    document.getElementById("res-symbol").value || selectedFile.name;
  const symbol = sanitizeSymbol(symbolRaw);
  const baseName = selectedFile.name.replace(/[^a-zA-Z0-9]/g, "_");

  try {
    const coff = binaryToCoff(symbol, selectedFile.bytes);
    const objPath = `${targetDir}/${baseName}.obj`;
    project.files.set(objPath, {
      path: objPath,
      content: "",
      dirty: false,
      binary: true,
      bytes: coff,
    });

    const headerPath = `${targetDir}/${baseName}.h`;
    const headerContent = generateHeader(
      symbol,
      selectedFile.name,
      selectedFile.bytes.length,
    );
    addFile(headerPath, headerContent);

    const rawPath = `${targetDir}/${selectedFile.name}`;
    project.files.set(rawPath, {
      path: rawPath,
      content: "",
      dirty: false,
      binary: true,
      bytes: selectedFile.bytes,
    });

    appendOutput(`✓ Added ${objPath} (${coff.length} B)`, "ok");
    appendOutput(`✓ Added ${headerPath}`, "ok");
    appendOutput(`  Symbol: ${symbol}`, "ok");

    renderExplorer(document.__handleFileSelect);
    closeResourceCreator();
    openFile(headerPath);
  } catch (e) {
    appendOutput("✗ Error: " + e.message, "err");
  }
}
