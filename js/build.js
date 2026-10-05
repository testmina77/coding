// build.js — worker bridge, streaming output

import { project, getConfig } from "./project.js";
import {
  appendOutput,
  clearOutput,
  setStatus,
  reportCompilerLine,
} from "./output.js";
import { showPanel } from "./layout.js";

let worker = null;
let ready = false;
let buildResolve = null;

export function initBuildWorker() {
  worker = new Worker("./worker.js?v=" + Date.now(), { type: "module" });

  worker.onmessage = (ev) => {
    const m = ev.data;
    switch (m.type) {
      case "ready":
        ready = true;
        appendOutput("Toolchain ready.", "ok");
        setStatus("Ready");
        break;
      case "status":
        appendOutput("» " + m.m, "dim");
        setStatus(m.m);
        break;
      case "stdout":
        appendOutput(m.m, "");
        break;
      case "stderr": {
        const line = m.m;
        if (line.startsWith(">>> ")) break;
        appendOutput(line, "warn");
        reportCompilerLine(line);
        break;
      }
      case "error":
        appendOutput("✗ " + m.m, "err");
        setStatus("Build failed");
        if (buildResolve) {
          buildResolve(false);
          buildResolve = null;
        }
        break;
      case "progress":
        if (m.total) {
          setStatus(
            `Loading ${m.what}: ${((100 * m.loaded) / m.total).toFixed(0)}%`,
          );
        }
        break;
      case "result":
        handleResult(m.name, m.bytes);
        if (buildResolve) {
          buildResolve(true);
          buildResolve = null;
        }
        break;
    }
  };

  worker.onerror = (e) => {
    appendOutput("Worker error: " + (e.message || e), "err");
    if (buildResolve) {
      buildResolve(false);
      buildResolve = null;
    }
  };

  worker.postMessage({ type: "init" });
}

function handleResult(name, bytes) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  appendOutput(`✓ ${name} (${bytes.byteLength} B) — downloaded.`, "ok");
  setStatus(`Build OK — ${name}`);
}

export async function build() {
  if (!worker || !ready) {
    appendOutput("Worker not ready yet.", "err");
    showPanel("output");
    return false;
  }
  clearOutput();
  showPanel("output");
  appendOutput("=== Build started ===", "ok");

  const files = [];
  for (const [path, f] of project.files) {
    if (f.binary && f.bytes) {
      files.push({
        path,
        content: "",
        binary: true,
        bytes: Array.from(f.bytes),
      });
    } else {
      files.push({ path, content: f.content || "" });
    }
  }

  const cfg = structuredClone(getConfig());

  return new Promise((resolve) => {
    buildResolve = resolve;
    worker.postMessage({ type: "build", files, config: cfg });
  });
}

export function isWorkerReady() {
  return ready;
}
