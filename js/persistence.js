// persistence.js — IndexedDB (files) + localStorage (settings) + ZIP export/import

const DB_NAME = "forgeide";
const DB_VERSION = 1;
const STORE_PROJECT = "project";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECT)) {
        db.createObjectStore(STORE_PROJECT);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveProject(project) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_PROJECT, "readwrite");
    const store = tx.objectStore(STORE_PROJECT);

    const files = [];
    for (const [path, f] of project.files) {
      const entry = { path, dirty: f.dirty || false };
      if (f.binary && f.bytes) {
        entry.binary = true;
        entry.bytes = new Uint8Array(f.bytes);
      } else {
        entry.content = f.content || "";
      }
      files.push(entry);
    }

    const payload = {
      name: project.name,
      activeConfig: project.activeConfig,
      activePlatform: project.activePlatform,
      configs: project.configs,
      files,
      savedAt: Date.now(),
    };
    store.put(payload, "current");
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return true;
  } catch (e) {
    console.error("saveProject failed:", e);
    return false;
  }
}

export async function loadProject() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_PROJECT, "readonly");
    const store = tx.objectStore(STORE_PROJECT);
    const req = store.get("current");
    const data = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    if (!data) return null;

    const files = new Map();
    for (const entry of data.files || []) {
      const f = { path: entry.path, dirty: false };
      if (entry.binary) {
        f.binary = true;
        f.content = "";
        f.bytes =
          entry.bytes instanceof Uint8Array
            ? entry.bytes
            : new Uint8Array(entry.bytes);
      } else {
        f.content = entry.content || "";
      }
      files.set(entry.path, f);
    }

    return {
      name: data.name,
      activeConfig: data.activeConfig,
      activePlatform: data.activePlatform,
      configs: data.configs,
      files,
      savedAt: data.savedAt,
    };
  } catch (e) {
    console.error("loadProject failed:", e);
    return null;
  }
}

export async function clearProjectDB() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_PROJECT, "readwrite");
    tx.objectStore(STORE_PROJECT).delete("current");
    await new Promise((res) => (tx.oncomplete = res));
  } catch {}
}

export function saveSetting(key, value) {
  try {
    localStorage.setItem("forgeide." + key, JSON.stringify(value));
  } catch {}
}

export function loadSetting(key, defaultValue) {
  try {
    const raw = localStorage.getItem("forgeide." + key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

// ZIP export/import — requires JSZip loaded from CDN via dynamic import
export async function exportProjectZip(project) {
  const mod = await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm");
  const JSZip = mod.default || mod;
  const zip = new JSZip();

  const meta = {
    name: project.name,
    activeConfig: project.activeConfig,
    activePlatform: project.activePlatform,
    configs: project.configs,
    version: "0.2.0",
    exportedAt: new Date().toISOString(),
  };
  zip.file(".forgeide.json", JSON.stringify(meta, null, 2));

  for (const [path, f] of project.files) {
    if (f.binary && f.bytes) {
      zip.file(path, f.bytes);
    } else {
      zip.file(path, f.content || "");
    }
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (project.name || "project") + ".forge.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importProjectZip(file) {
  const mod = await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm");
  const JSZip = mod.default || mod;
  const zip = await JSZip.loadAsync(file);

  let meta = {
    name: "ImportedProject",
    activeConfig: "Debug",
    activePlatform: "x64",
    configs: null,
  };

  const metaFile = zip.file(".forgeide.json");
  if (metaFile) {
    try {
      const text = await metaFile.async("string");
      meta = Object.assign(meta, JSON.parse(text));
    } catch {}
  }

  const files = new Map();
  const entries = [];
  zip.forEach((relPath, entry) => {
    if (entry.dir) return;
    if (relPath === ".forgeide.json") return;
    entries.push(entry);
  });

  for (const entry of entries) {
    const path = entry.name;
    const ext = path.split(".").pop().toLowerCase();
    const textExts = [
      "c",
      "cpp",
      "cc",
      "cxx",
      "h",
      "hpp",
      "hxx",
      "inc",
      "txt",
      "md",
      "json",
      "xml",
      "rc",
      "js",
      "ts",
      "html",
      "css",
      "py",
      "sh",
    ];
    if (textExts.includes(ext)) {
      const content = await entry.async("string");
      files.set(path, { path, content, dirty: false });
    } else {
      const bytes = await entry.async("uint8array");
      files.set(path, { path, content: "", dirty: false, binary: true, bytes });
    }
  }

  return { meta, files };
}
