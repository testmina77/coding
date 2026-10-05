// worker.js — clang.wasm (multi-file) → .o → lld.wasm → .exe

import {
  WASI,
  File,
  OpenFile,
  Directory,
  PreopenDirectory,
  ConsoleStdout,
} from "https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/dist/index.js";
import { gunzipSync } from "https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js";
const PATH = {
  work: "/work",
  sysroot: "/sysroot",
  builtins: "/builtins",
};

const SYSROOT_LIBS = [
  "crt2.o",
  "crtbegin.o",
  "crtend.o",

  "libmingw32.a",
  "libmingwex.a",

  "libmsvcrt.a",
  "libmsvcrt-os.a",

  "libadvapi32.a",
  "libshell32.a",
  "libuser32.a",
  "libkernel32.a",

  "libunwind.a",
  "libmoldname.a",

  "libucrt.a",
  "libucrtbase.a",

  "libstdc++.a",
  "libstdc++.dll.a",

  "libc++.a",
  "libc++abi.a",

  "libwinpthread.a",
  "libssp.a",
  "libssp_nonshared.a",
  "libwinmm.a",
];

const CORE_HEADERS = [
  "include/stdio.h",
  "include/stdlib.h",
  "include/string.h",
  "include/stdint.h",
  "include/stddef.h",
  "include/stdbool.h",
  "include/limits.h",
  "include/math.h",
  "include/errno.h",
  "include/ctype.h",
  "include/time.h",
  "include/stdarg.h",
  "include/assert.h",
  "include/malloc.h",

  "clang-include/stddef.h",
  "clang-include/stdarg.h",
  "clang-include/stdint.h",
  "clang-include/limits.h",
  "clang-include/__stddef_max_align_t.h",
];

const BUILTINS_FILE = "libclang_rt.builtins-x86_64.a";

let clangBytes = null;
let lldBytes = null;

let sysrootLibMap = new Map();
let sysrootIncludeMap = new Map();
let sysrootClangMap = new Map();
let builtinsMap = new Map();

let cppAvailable = false;

// Persistent sysroot VFS.
let sysrootVfs = null;

// Negative cache for lazy sysroot fetches.
let sysrootMissed = new Set();
let packIndexes = {
  include: null,
  clangInclude: null,
  lib: null,
};

const packedFileCache = new Map();
const packedMissed = new Set();
function post(msg) {
  self.postMessage(msg);
}

// ─────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`fetch ${url}: ${res.status}`);
  }

  const total = Number(res.headers.get("Content-Length") || 0);

  if (!res.body || !onProgress || !total) {
    return new Uint8Array(await res.arrayBuffer());
  }

  const reader = res.body.getReader();

  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    chunks.push(value);
    loaded += value.length;

    onProgress(loaded, total);
  }

  const out = new Uint8Array(loaded);

  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

async function loadPackIndex(name) {
  try {
    const res = await fetch(`sysroot/${name}.index.json`);

    if (!res.ok) {
      return null;
    }

    const index = await res.json();

    if (
      !index ||
      index.version !== 1 ||
      index.compression !== "gzip" ||
      !index.files
    ) {
      throw new Error(`Invalid ${name}.index.json`);
    }

    return index;
  } catch (e) {
    post({
      type: "status",
      m: `Pack ${name}: unavailable, using normal files.`,
    });

    return null;
  }
}

async function loadPackIndexes() {
  packIndexes.include = await loadPackIndex("include");

  packIndexes.clangInclude = await loadPackIndex("clang-include");

  packIndexes.lib = await loadPackIndex("lib");

  let entries = 0;

  if (packIndexes.include) {
    entries += Object.keys(packIndexes.include.files).length;
  }

  if (packIndexes.clangInclude) {
    entries += Object.keys(packIndexes.clangInclude.files).length;
  }

  if (packIndexes.lib) {
    entries += Object.keys(packIndexes.lib.files).length;
  }

  post({
    type: "status",
    m: `Packs: ${entries} indexed files`,
  });
}

function getPackEntry(relPath) {
  if (relPath.startsWith("include/")) {
    return packIndexes.include?.files?.[relPath] || null;
  }

  if (relPath.startsWith("clang-include/")) {
    return packIndexes.clangInclude?.files?.[relPath] || null;
  }

  if (relPath.startsWith("lib/")) {
    return packIndexes.lib?.files?.[relPath] || null;
  }

  return null;
}

function fetchPackedFileSync(relPath, entry) {
  const cacheKey = `${entry.pack}:${entry.offset}:${entry.compressedSize}`;

  const cached = packedFileCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const start = entry.offset;
  const end = entry.offset + entry.compressedSize - 1;

  const url = `sysroot/${entry.pack}`;

  const xhr = new XMLHttpRequest();

  xhr.open("GET", url, false);

  xhr.setRequestHeader("Range", `bytes=${start}-${end}`);

  xhr.responseType = "arraybuffer";

  xhr.send();

  if (xhr.status !== 206 && xhr.status !== 200) {
    throw new Error(`Range request failed for ${relPath}: ${xhr.status}`);
  }

  const compressed = new Uint8Array(xhr.response);

  // 200 means the server ignored Range.
  // Don't silently download a huge pack.
  if (xhr.status === 200 && compressed.length !== entry.compressedSize) {
    throw new Error(`Server ignored Range for ${relPath}`);
  }

  const bytes = gunzipSync(compressed);

  if (bytes.length !== entry.size) {
    throw new Error(
      `Size mismatch for ${relPath}: ` + `${bytes.length} != ${entry.size}`,
    );
  }

  packedFileCache.set(cacheKey, bytes);

  return bytes;
}
function tryLoadPackedSysrootFile(lazy, fetchPath) {
  const entry = getPackEntry(fetchPath);

  if (!entry) {
    return null;
  }

  if (packedMissed.has(fetchPath)) {
    return null;
  }

  try {
    const bytes = fetchPackedFileSync(fetchPath, entry);

    injectIntoVfs(lazy.root, fetchPath, bytes);

    post({
      type: "status",
      m:
        `+ pack ${fetchPath} ` +
        `(${bytes.length} B, ` +
        `Range ${entry.compressedSize} B)`,
    });

    return bytes;
  } catch (e) {
    packedMissed.add(fetchPath);

    post({
      type: "status",
      m: `Pack miss ${fetchPath}: ${e.message}`,
    });

    return null;
  }
}
// ─────────────────────────────────────────────────────────────
// VFS helpers
// ─────────────────────────────────────────────────────────────

function ensureDirTree(rootMap, parts) {
  let cur = rootMap;

  for (const part of parts) {
    let dir = cur.get(part);

    if (!(dir instanceof Directory)) {
      dir = new Directory(new Map());
      cur.set(part, dir);
    }

    cur = dir.contents;
  }

  return cur;
}

function addToTree(rootMap, parts, leafName, fileObj) {
  const dir = ensureDirTree(rootMap, parts);

  dir.set(leafName, fileObj);
}

function fsLookup(dir, pathParts) {
  let cur = dir;

  for (let i = 0; i < pathParts.length; i++) {
    const isLeaf = i === pathParts.length - 1;

    const value = cur.get(pathParts[i]);

    if (isLeaf) {
      return value || null;
    }

    if (!(value instanceof Directory)) {
      return null;
    }

    cur = value.contents;
  }

  return null;
}

function injectIntoVfs(rootMap, relPath, bytes) {
  const parts = relPath.split("/").filter(Boolean);

  const leaf = parts.pop();

  if (!leaf) {
    return;
  }

  const dir = ensureDirTree(rootMap, parts);

  dir.set(leaf, new File(bytes));
}

// ─────────────────────────────────────────────────────────────
// Assets
// ─────────────────────────────────────────────────────────────

async function loadAssets() {
  post({
    type: "status",
    m: "Loading clang.wasm…",
  });

  clangBytes = await fetchBytes("bin/clang.wasm", (loaded, total) =>
    post({
      type: "progress",
      what: "clang",
      loaded,
      total,
    }),
  );

  post({
    type: "status",
    m: "Loading lld.wasm…",
  });

  lldBytes = await fetchBytes("bin/lld.wasm", (loaded, total) =>
    post({
      type: "progress",
      what: "lld",
      loaded,
      total,
    }),
  );
  await loadPackIndexes();

  // ── Libraries ─────────────────────────────────────────────

  post({
    type: "status",
    m: "Loading libraries…",
  });

  sysrootLibMap = new Map();
  cppAvailable = false;

  const missingLibs = [];

  if (!packIndexes.lib) {
    for (const name of SYSROOT_LIBS) {
      try {
        const bytes = await fetchBytes(`sysroot/lib/${name}`);

        sysrootLibMap.set(name, bytes);

        if (name.startsWith("libstdc++") || name.startsWith("libc++")) {
          cppAvailable = true;
        }
      } catch {
        missingLibs.push(name);
      }
    }
  } else {
    cppAvailable = Object.keys(packIndexes.lib.files).some(
      (p) =>
        p === "lib/libc++.a" ||
        p === "lib/libc++abi.a" ||
        p.startsWith("lib/libstdc++"),
    );

    post({
      type: "status",
      m: "Libraries: packed sysroot mode.",
    });
  }

  post({
    type: "status",
    m:
      `Libs: ${sysrootLibMap.size}/${SYSROOT_LIBS.length}` +
      (missingLibs.length ? ` (missing: ${missingLibs.join(", ")})` : ""),
  });

  // ── Builtins ──────────────────────────────────────────────

  post({
    type: "status",
    m: "Loading compiler-rt builtins…",
  });

  builtinsMap = new Map([
    [BUILTINS_FILE, await fetchBytes(`builtins/${BUILTINS_FILE}`)],
  ]);

  // ── Persistent sysroot ───────────────────────────────────

  sysrootVfs = new Map([
    ["lib", new Directory(new Map())],
    ["include", new Directory(new Map())],
    ["clang-include", new Directory(new Map())],
  ]);
  function addPackDirsToVfs(index) {
    if (!index?.files) {
      return;
    }

    for (const relPath of Object.keys(index.files)) {
      const parts = relPath.split("/").filter(Boolean);

      parts.pop();

      if (parts.length) {
        ensureDirTree(sysrootVfs, parts);
      }
    }
  }

  addPackDirsToVfs(packIndexes.include);
  addPackDirsToVfs(packIndexes.clangInclude);
  addPackDirsToVfs(packIndexes.lib);

  ensureDirTree(sysrootVfs, ["include", "c++", "v1"]);

  // ── Preload core headers only when packed sysroot is unavailable ──

  let preloaded = 0;

  if (!packIndexes.include) {
    post({
      type: "status",
      m: `Preloading ${CORE_HEADERS.length} core headers…`,
    });

    for (const rel of CORE_HEADERS) {
      if (manifestSet && !manifestSet.has(rel)) {
        continue;
      }

      try {
        const bytes = await fetchBytes(`sysroot/${rel}`);

        const parts = rel.split("/").filter(Boolean);

        const name = parts.pop();

        const dir = ensureDirTree(sysrootVfs, parts);

        dir.set(name, new File(bytes));

        preloaded++;
      } catch {}
    }
  }
  post({
    type: "status",
    m:
      `Toolchain ready (${preloaded} preloaded` +
      `${cppAvailable ? ", C++ OK" : ""}).`,
  });
}

// ─────────────────────────────────────────────────────────────
// WASI
// ─────────────────────────────────────────────────────────────

function makeWasi(argv, preopens) {
  const fds = [
    new OpenFile(new File([])),

    ConsoleStdout.lineBuffered((m) =>
      post({
        type: "stdout",
        m,
      }),
    ),

    ConsoleStdout.lineBuffered((m) =>
      post({
        type: "stderr",
        m,
      }),
    ),
  ];

  for (const [name, dir] of preopens) {
    fds.push(new PreopenDirectory(name, dir));
  }

  return new WASI(argv, [], fds);
}

// ─────────────────────────────────────────────────────────────
// WASI lazy sysroot
// ─────────────────────────────────────────────────────────────

async function runWasm(wasmBytes, wasi, opts = {}) {
  const { lazyDirs = new Map() } = opts;

  const mod = await WebAssembly.compile(wasmBytes);

  const real = wasi.wasiImport;

  let memory = null;

  const readStr = (ptr, len) => {
    if (!memory) return "";

    return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
  };

  const proxied = new Proxy(
    {},
    {
      get(_, prop) {
        const name = String(prop);

        if (name === "path_open") {
          return (fd, dflags, ptr, len, oflags, rB, rI, fdflags, outPtr) => {
            const relPath = readStr(ptr, len);

            let f = oflags;

            // Avoid CREATE when retrying
            // a lazy-open that originally
            // came from a lookup.
            if (f & 0x4) {
              f &= ~0x4;

              if (f & 0x1) {
                f |= 0x8;
              }
            }

            const result = real.path_open(
              fd,
              dflags,
              ptr,
              len,
              f,
              rB,
              rI,
              fdflags,
              outPtr,
            );

            if (result === 0 || result !== 44) {
              return result;
            }

            const lazy = lazyDirs.get(fd);

            if (!lazy) {
              return result;
            }

            const fetchPath = relPath.replace(/^\//, "");

            if (!fetchPath) {
              return result;
            }

            if (sysrootMissed.has(fetchPath)) {
              return result;
            }

            let bytes = tryLoadPackedSysrootFile(lazy, fetchPath);

            if (!bytes) {
              if (sysrootMissed.has(fetchPath)) {
                return result;
              }

              const url = lazy.urlBase + fetchPath;

              try {
                const xhr = new XMLHttpRequest();

                xhr.open("GET", url, false);

                xhr.responseType = "arraybuffer";

                xhr.send();

                if (xhr.status !== 200) {
                  sysrootMissed.add(fetchPath);

                  return result;
                }

                bytes = new Uint8Array(xhr.response);

                injectIntoVfs(lazy.root, fetchPath, bytes);

                post({
                  type: "status",
                  m: `+ ${fetchPath} (${bytes.length} B)`,
                });
              } catch {
                sysrootMissed.add(fetchPath);

                return result;
                a;
              }
            }

            return real.path_open(
              fd,
              dflags,
              ptr,
              len,
              f,
              rB,
              rI,
              fdflags,
              outPtr,
            );
          };
        }
        if (name === "path_filestat_get") {
          return (fd, flags, ptr, len, bufPtr) => {
            const result = real.path_filestat_get(fd, flags, ptr, len, bufPtr);

            // 44 = ENOENT
            if (result !== 44) {
              return result;
            }

            const lazy = lazyDirs.get(fd);

            if (!lazy) {
              return result;
            }

            const relPath = readStr(ptr, len);

            if (!relPath) {
              return result;
            }

            const fetchPath = relPath.replace(/^\/+/, "");

            if (!fetchPath) {
              return result;
            }

            if (sysrootMissed.has(fetchPath)) {
              return result;
            }

            const bytes = tryLoadPackedSysrootFile(lazy, fetchPath);

            if (!bytes) {
              return result;
            }

            // Plik został dodany do VFS — sprawdź ponownie.
            return real.path_filestat_get(fd, flags, ptr, len, bufPtr);
          };
        }
        const value = real[prop];

        if (typeof value !== "function") {
          return value;
        }

        return function (...args) {
          return value.apply(real, args);
        };
      },
    },
  );

  const inst = await WebAssembly.instantiate(mod, {
    wasi_snapshot_preview1: proxied,
  });

  memory = inst.exports.memory;

  let code = 0;

  try {
    wasi.start(inst);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e) {
      code = e.code;
    } else {
      throw e;
    }
  }

  return code;
}

// ─────────────────────────────────────────────────────────────
// Library resolver for LLD
// ─────────────────────────────────────────────────────────────

function libraryNamesFromArg(arg) {
  if (typeof arg !== "string" || !arg.startsWith("-l")) {
    return [];
  }

  const name = arg.slice(2).trim();

  if (!name) {
    return [];
  }

  return [name];
}

function libraryCandidates(name) {
  const clean = name.replace(/^lib/i, "").replace(/\.(a|lib)$/i, "");

  return [`lib${clean}.a`, `lib${clean}.dll.a`, `${clean}.a`, `${clean}.dll.a`];
}

function hasLibraryInDir(dir, candidates) {
  if (!(dir instanceof Directory)) {
    return false;
  }

  for (const name of candidates) {
    if (dir.contents.has(name)) {
      return true;
    }
  }

  return false;
}

function searchLibraryInWork(work, candidates, dirs) {
  for (const dirPath of dirs) {
    const parts = dirPath.replace(/^\/+/, "").split("/").filter(Boolean);

    const dir = fsLookup(work, parts);

    if (hasLibraryInDir(dir, candidates)) {
      return true;
    }
  }

  return false;
}

async function ensureRequestedLibraries(
  lldArgs,
  sysroot,
  work,
  additionalLibraryDirs = [],
) {
  const libDir = sysroot.get("lib");

  if (!(libDir instanceof Directory)) {
    throw new Error("sysroot/lib is missing");
  }

  const requested = new Set();

  for (const arg of lldArgs) {
    for (const name of libraryNamesFromArg(arg)) {
      requested.add(name);
    }
  }

  if (requested.size === 0) {
    return;
  }

  const workSearchDirs = ["/work/lib", "/work"];

  for (const dir of additionalLibraryDirs) {
    const normalized = dir.replace(/\\/g, "/").replace(/\/+$/, "");

    if (normalized) {
      workSearchDirs.push(
        normalized.startsWith("/") ? normalized : `/work/${normalized}`,
      );
    }
  }

  for (const name of requested) {
    const candidates = libraryCandidates(name);

    if (hasLibraryInDir(libDir, candidates)) {
      continue;
    }

    const packedCandidate = candidates.find(
      (fileName) => !!getPackEntry(`lib/${fileName}`),
    );

    if (packedCandidate) {
      continue;
    }

    if (searchLibraryInWork(work, candidates, workSearchDirs)) {
      continue;
    }

    let loaded = false;

    for (const fileName of candidates) {
      try {
        const bytes = await fetchBytes(`sysroot/lib/${fileName}`);

        libDir.contents.set(fileName, new File(bytes));

        sysrootLibMap.set(fileName, bytes);

        post({
          type: "status",
          m: `+ lib/${fileName} (${bytes.length} B)`,
        });

        loaded = true;
        break;
      } catch {}
    }

    if (!loaded) {
      throw new Error(
        `Missing sysroot library for -l${name}` +
          ` (tried ${candidates.join(", ")})`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
// File classification
// ─────────────────────────────────────────────────────────────

function classify(path) {
  const ext = path.split(".").pop().toLowerCase();

  if (ext === "c") {
    return "c";
  }

  if (["cpp", "cc", "cxx"].includes(ext)) {
    return "cpp";
  }

  if (["h", "hpp", "hxx", "inc"].includes(ext)) {
    return "header";
  }

  if (["s", "asm"].includes(ext)) {
    return "asm";
  }

  if (ext === "rc") {
    return "rc";
  }

  return "other";
}

// ─────────────────────────────────────────────────────────────
// Virtual FS
// ─────────────────────────────────────────────────────────────

function buildVirtualFs(files) {
  const work = new Map();

  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);

    const name = parts.pop();

    if (!name) continue;

    const bytes =
      f.binary && f.bytes
        ? new Uint8Array(f.bytes)
        : new TextEncoder().encode(f.content || "");

    addToTree(work, parts, name, new File(bytes));
  }

  // Refill persistent sysroot libraries.
  const libDir = sysrootVfs.get("lib");

  for (const [name, bytes] of sysrootLibMap) {
    libDir.contents.set(name, new File(bytes));
  }

  const builtins = new Map();

  for (const [path, bytes] of builtinsMap) {
    builtins.set(path.split("/").pop(), new File(bytes));
  }

  return {
    work,
    sysroot: sysrootVfs,
    builtins,
  };
}

// ─────────────────────────────────────────────────────────────
// Config mapping
// ─────────────────────────────────────────────────────────────

function getOptimizationFlag(config) {
  const value = String(config?.ccpp?.optimization || "");

  if (value.includes("/O1") || value.includes("Minimize Size")) {
    return "-Os";
  }

  if (
    value.includes("/O2") ||
    value.includes("Maximize Speed") ||
    value.includes("Maximum")
  ) {
    return "-O2";
  }

  if (value.includes("/Ox") || value.includes("Full")) {
    return "-O3";
  }

  return "-O0";
}

function getWarningFlags(config) {
  const value = String(config?.ccpp?.warnings || "");

  if (value.includes("/W0") || value.includes("Turn Off")) {
    return ["-w"];
  }

  if (value.includes("/Wall") || value.includes("EnableAll")) {
    return ["-Weverything"];
  }

  if (value.includes("/W4") || value.includes("Level4")) {
    return ["-Wall", "-Wextra", "-Wpedantic"];
  }

  if (value.includes("/W3") || value.includes("Level3")) {
    return ["-Wall", "-Wextra"];
  }

  if (value.includes("/W2") || value.includes("Level2")) {
    return ["-Wall"];
  }

  if (value.includes("/W1") || value.includes("Level1")) {
    return ["-Wall"];
  }

  return [];
}

function getCharacterSetFlags(config) {
  const value = String(config?.general?.characterSet || "");

  if (value.includes("Unicode")) {
    return ["-DUNICODE", "-D_UNICODE"];
  }

  if (value.includes("Multi-Byte")) {
    return ["-D_MBCS"];
  }

  return [];
}

function shouldGenerateDebugInfo(config) {
  return (
    config?.linker?.generateDebugInfo === true ||
    (config?.ccpp?.debugInformationFormat &&
      config.ccpp.debugInformationFormat !== "None")
  );
}

function getLinkerOptimizationFlags(config) {
  const value = String(config?.linker?.optimization || "");

  if (value.includes("References and ICF") || value.includes("/OPT:REF,ICF")) {
    return ["--gc-sections", "--icf=all"];
  }

  if (value.includes("References") || value.includes("/OPT:REF")) {
    return ["--gc-sections"];
  }

  return [];
}

function getSubsystem(config) {
  const value = String(config?.linker?.subsystem || "");

  if (value.includes("Windows")) {
    return "windows";
  }

  if (value.includes("Native")) {
    return "native";
  }

  return "console";
}

function getEntryPoint(config) {
  const explicit = String(config?.linker?.entryPoint || "").trim();

  if (explicit) {
    return explicit;
  }

  return getSubsystem(config) === "windows"
    ? "WinMainCRTStartup"
    : "mainCRTStartup";
}

// ─────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────

async function build(files, config) {
  const { work, sysroot, builtins } = buildVirtualFs(files);

  const sources = [];
  let usesCpp = false;

  for (const f of files) {
    const kind = classify(f.path);

    if (kind === "c") {
      sources.push({
        path: f.path,
        kind: "c",
      });
    } else if (kind === "cpp") {
      sources.push({
        path: f.path,
        kind: "cpp",
      });

      usesCpp = true;
    } else if (kind === "asm") {
      sources.push({
        path: f.path,
        kind: "asm",
      });
    }
  }

  if (sources.length === 0) {
    throw new Error("No source files (.c/.cpp/.S)");
  }

  // ───────────────────────────────────────────────────────────
  // Prebuilt .obj / .o
  // ───────────────────────────────────────────────────────────

  const prebuiltObjects = [];

  for (const f of files) {
    const lower = f.path.toLowerCase();

    if (f.binary && (lower.endsWith(".obj") || lower.endsWith(".o"))) {
      prebuiltObjects.push("/work/" + f.path);
    }
  }

  // ───────────────────────────────────────────────────────────
  // Include directories
  // ───────────────────────────────────────────────────────────

  const includeDirs = (config?.ccpp?.additionalIncludeDirectories || []).map(
    (dir) => {
      const normalized = String(dir).replace(/\\/g, "/");

      return normalized.startsWith("/")
        ? `-I${normalized}`
        : `-I/work/${normalized}`;
    },
  );

  includeDirs.push("-I/work/include", "-I/work/res", "-I/work/");

  // ───────────────────────────────────────────────────────────
  // Defines
  // ───────────────────────────────────────────────────────────

  const defines = (config?.ccpp?.preprocessorDefinitions || [])
    .filter(Boolean)
    .map((d) => `-D${d}`);

  const resourceDefines = (config?.resources?.preprocessorDefinitions || [])
    .filter(Boolean)
    .map((d) => `-D${d}`);

  defines.push(...resourceDefines);

  // ───────────────────────────────────────────────────────────
  // Language standard
  // ───────────────────────────────────────────────────────────

  const langStd =
    config?.ccpp?.languageStandard ||
    config?.general?.cppLanguageStandard ||
    "stdcpp17";

  let stdFlag = "-std=c++17";

  if (langStd === "stdcpp14") {
    stdFlag = "-std=c++14";
  } else if (langStd === "stdcpp20") {
    stdFlag = "-std=c++20";
  } else if (langStd === "stdcpp23") {
    stdFlag = "-std=c++23";
  }

  // ───────────────────────────────────────────────────────────
  // Build configuration
  // ───────────────────────────────────────────────────────────

  const optimizationFlag = getOptimizationFlag(config);

  const warningFlags = getWarningFlags(config);

  const warningsAsErrors =
    config?.ccpp?.treatWarningsAsErrors === true ? ["-Werror"] : [];

  const debugInfo = shouldGenerateDebugInfo(config);

  const characterSetFlags = getCharacterSetFlags(config);

  // ───────────────────────────────────────────────────────────
  // Intermediate directory
  // ───────────────────────────────────────────────────────────

  const intermediateDirectory = String(
    config?.general?.intermediateDirectory || "",
  )
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  const intermediateParts = intermediateDirectory.split("/").filter(Boolean);

  if (intermediateParts.length) {
    ensureDirTree(work, intermediateParts);
  }

  // ───────────────────────────────────────────────────────────
  // Compile
  // ───────────────────────────────────────────────────────────

  const objects = [];

  const lazySysroot = {
    root: sysroot,
    urlBase: "sysroot/",
  };

  for (const src of sources) {
    const sourceFileName = src.path.split("/").pop();

    const objectName = sourceFileName.replace(/\.(c|cpp|cc|cxx|s|asm)$/i, ".o");

    const obj = intermediateDirectory
      ? `${intermediateDirectory}/${objectName}`
      : objectName;

    post({
      type: "status",
      m: `clang: ${src.path} → ${obj}`,
    });

    const isCpp = src.kind === "cpp";

    const args = [
      "clang",

      "--target=x86_64-w64-windows-gnu",

      "--sysroot=/sysroot",

      optimizationFlag,

      ...warningFlags,
      ...warningsAsErrors,
      ...characterSetFlags,

      ...(debugInfo ? ["-g"] : []),

      ...(isCpp
        ? [
            stdFlag,

            "-isystem",
            "/sysroot/include/c++/v1",

            "-isystem",
            "/sysroot/clang-include",

            "-isystem",
            "/sysroot/include",

            "-D_LIBCPP_HAS_NO_THREADS",
            "-D_LIBCPP_HAS_NO_MONOTONIC_CLOCK",
          ]
        : [
            "-isystem",
            "/sysroot/clang-include",

            "-isystem",
            "/sysroot/include",
          ]),

      ...includeDirs,
      ...defines,

      "-c",

      "/work/" + src.path,

      "-o",

      "/work/" + obj,
    ];

    const wasi = makeWasi(args, [
      [PATH.work, work],
      [PATH.sysroot, sysroot],
    ]);

    const code = await runWasm(clangBytes, wasi, {
      // fd 4 = /sysroot
      lazyDirs: new Map([[4, lazySysroot]]),
    });

    const objParts = obj.split("/");

    const objFile = fsLookup(work, objParts);

    const objOk =
      objFile instanceof File && objFile.data && objFile.data.length > 0;

    if (code !== 0) {
      throw new Error(`clang failed on ${src.path} (exit ${code})`);
    }

    if (!objOk) {
      throw new Error(`clang did not produce ${obj} — check errors above`);
    }

    post({
      type: "status",
      m: `  → ${obj} (${objFile.data.length} B)`,
    });

    objects.push("/work/" + obj);
  }

  // ───────────────────────────────────────────────────────────
  // Output directory
  // ───────────────────────────────────────────────────────────

  const outputDirectory = String(config?.general?.outputDirectory || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  const outputParts = outputDirectory.split("/").filter(Boolean);

  if (outputParts.length) {
    ensureDirTree(work, outputParts);
  }

  const targetName =
    String(config?.general?.targetName || "main")
      .replace("$(ProjectName)", "main")
      .trim() || "main";

  const outPath =
    "/work/" +
    (outputDirectory ? `${outputDirectory}/` : "") +
    `${targetName}.exe`;

  // ───────────────────────────────────────────────────────────
  // C++ runtime
  // ───────────────────────────────────────────────────────────

  const cppLibs = [];

  if (usesCpp && cppAvailable) {
    if (sysrootLibMap.has("libc++.a")) {
      cppLibs.push("-lc++");
    }

    if (sysrootLibMap.has("libc++abi.a")) {
      cppLibs.push("-lc++abi");
    }
  }

  // ───────────────────────────────────────────────────────────
  // Additional dependencies
  // ───────────────────────────────────────────────────────────

  const extraLibs = [];

  for (const dep of config?.linker?.additionalDependencies || []) {
    let n = String(dep)
      .trim()
      .replace(/\.(a|lib)$/i, "")
      .replace(/^lib/i, "");

    if (!n) {
      continue;
    }

    // Core/runtime libs are linked explicitly below.
    if (
      [
        "msvcrt",
        "ucrt",
        "ucrtbase",
        "mingw32",
        "mingwex",
        "kernel32",
        "user32",
        "advapi32",
        "shell32",
      ].includes(n.toLowerCase())
    ) {
      continue;
    }

    extraLibs.push("-l" + n);
  }

  // Remove duplicates while preserving order.
  const uniqueExtraLibs = [...new Set(extraLibs)];

  // ───────────────────────────────────────────────────────────
  // Library search paths
  // ───────────────────────────────────────────────────────────

  const libraryDirs = (config?.linker?.additionalLibraryDirectories || []).map(
    (dir) => {
      const normalized = String(dir)
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");

      return normalized.startsWith("/")
        ? `-L${normalized}`
        : `-L/work/${normalized}`;
    },
  );

  // ───────────────────────────────────────────────────────────
  // Linker options
  // ───────────────────────────────────────────────────────────

  const linkerOptimizationFlags = getLinkerOptimizationFlags(config);

  const subsystem = getSubsystem(config);

  const entryPoint = getEntryPoint(config);

  // ───────────────────────────────────────────────────────────
  // LLD
  // ───────────────────────────────────────────────────────────

  const lldArgs = [
    "ld.lld",

    "-m",
    "i386pep",

    "-Bdynamic",

    "-o",
    outPath,

    "-e",
    entryPoint,

    ...linkerOptimizationFlags,

    ...libraryDirs,

    "/sysroot/lib/crt2.o",
    "/sysroot/lib/crtbegin.o",

    "-L/sysroot/lib",
    "-L/builtins",
    "-L/work/lib",
    "-L/work",

    ...objects,
    ...prebuiltObjects,

    ...cppLibs,

    "-lmingw32",

    "/builtins/libclang_rt.builtins-x86_64.a",

    "-lunwind",
    "-lmoldname",
    "-lmingwex",
    "-lmsvcrt",

    "-ladvapi32",
    "-lshell32",
    "-luser32",
    "-lkernel32",

    ...uniqueExtraLibs,

    "/sysroot/lib/crtend.o",
  ];

  // Note:
  // ld.lld will resolve the PE subsystem itself from the entry
  // point/toolchain setup. Keep explicit entry point above.
  void subsystem;

  post({
    type: "status",
    m: `Linking ${targetName}.exe (${config?.general?.configurationType || "Application (.exe)"})…`,
  });

  // ───────────────────────────────────────────────────────────
  // AUTO-LOAD ALL REQUESTED -l LIBRARIES
  // ───────────────────────────────────────────────────────────

  await ensureRequestedLibraries(
    lldArgs,
    sysroot,
    work,
    config?.linker?.additionalLibraryDirectories || [],
  );

  const lldWasi = makeWasi(lldArgs, [
    [PATH.work, work],
    [PATH.sysroot, sysroot],
    [PATH.builtins, builtins],
  ]);

  const code = await runWasm(lldBytes, lldWasi, {
    lazyDirs: new Map([[4, lazySysroot]]),
  });

  if (code !== 0) {
    throw new Error(`lld failed (exit ${code})`);
  }

  // ───────────────────────────────────────────────────────────
  // Find exact output
  // ───────────────────────────────────────────────────────────

  const outParts = outPath
    .replace(/^\/work\//, "")
    .split("/")
    .filter(Boolean);

  const exe = fsLookup(work, outParts);

  if (!(exe instanceof File) || !exe.data || exe.data.length === 0) {
    throw new Error(`lld produced no output: ${outPath}`);
  }

  const exeName = outPath.split("/").pop();

  post({
    type: "status",
    m: `OK — ${outPath} (${exe.data.length} B)`,
  });

  post({
    type: "result",
    name: exeName,
    bytes: exe.data,
  });
}

// ─────────────────────────────────────────────────────────────
// Worker entry
// ─────────────────────────────────────────────────────────────

self.onmessage = async (ev) => {
  const { type } = ev.data || {};

  try {
    if (type === "init") {
      await loadAssets();

      post({
        type: "ready",
      });

      return;
    }

    if (type === "build") {
      await build(ev.data.files, ev.data.config);

      return;
    }
  } catch (e) {
    post({
      type: "error",
      m: String((e && e.stack) || e),
    });
  }
};
