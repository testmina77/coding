// worker.js — ForgeIDE
// clang.wasm + lld.wasm

import {
  WASI,
  File,
  OpenFile,
  Directory,
  PreopenDirectory,
  ConsoleStdout,
} from "https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/dist/index.js";

import {
  gunzipSync,
  zipSync,
} from "https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js";

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
let builtinsMap = new Map();
let cppAvailable = false;
let sysrootVfs = null;
let externalManifest = null;

const externalPackageCache = new Map();

let packIndexes = { include: null, clangInclude: null, lib: null };
const packedFileCache = new Map();

function post(msg) {
  self.postMessage(msg);
}

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
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
async function fetchSplit(baseName, what, onProgress) {
  const chunks = [];
  let loaded = 0;
  let expectedTotal = 0;

  for (let i = 0; ; i++) {
    const url = `bin/${baseName}.part-${String(i).padStart(2, "0")}`;
    let bytes;
    try {
      bytes = await fetchBytes(url, (l, t) => {
        if (t) expectedTotal = loaded + t;
        if (onProgress) onProgress(loaded + l, expectedTotal);
      });
    } catch (e) {
      if (i === 0) {
        throw new Error(`missing first part: ${url} (${e.message})`);
      }
      break;
    }
    chunks.push(bytes);
    loaded += bytes.length;
    post({ type: "status", m: `${what}: part ${i} (${bytes.length} B)` });
  }

  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  post({
    type: "status",
    m: `${what}: ${chunks.length} parts → ${out.length} B`,
  });
  return out;
}
async function loadPackIndex(name) {
  try {
    const res = await fetch(`sysroot/${name}.index.json`);
    if (!res.ok) return null;
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
  if (packIndexes.include)
    entries += Object.keys(packIndexes.include.files).length;
  if (packIndexes.clangInclude)
    entries += Object.keys(packIndexes.clangInclude.files).length;
  if (packIndexes.lib) entries += Object.keys(packIndexes.lib.files).length;
  post({ type: "status", m: `Packs: ${entries} indexed files` });
}

async function loadExternalManifest() {
  try {
    const res = await fetch("externallibs/manifest.json");
    if (!res.ok) {
      post({ type: "status", m: "External libraries: no manifest." });
      return;
    }
    const manifest = await res.json();
    if (!manifest || manifest.version !== 1 || !manifest.libraries) {
      throw new Error("Invalid externallibs/manifest.json");
    }
    externalManifest = manifest;
    const count = Object.keys(manifest.libraries).length;
    post({ type: "status", m: `External libraries: ${count} packages.` });
  } catch (e) {
    externalManifest = null;
    post({ type: "status", m: `External libraries unavailable: ${e.message}` });
  }
}

async function loadExternalPackage(packageId) {
  if (externalPackageCache.has(packageId)) {
    return externalPackageCache.get(packageId);
  }
  if (!externalManifest) return null;
  const packageManifest = externalManifest.libraries?.[packageId];
  if (!packageManifest) return null;
  const packs = packageManifest.packs || {};
  let includeIndex = null;
  let libIndex = null;
  let binIndex = null;
  const includeIndexName = packs.include || "include.index.json";
  const libIndexName = packs.lib || "lib.index.json";
  const binIndexName = packs.bin || "bin.index.json";

  try {
    const res = await fetch(`externallibs/${packageId}/${includeIndexName}`);
    if (res.ok) includeIndex = await res.json();
  } catch {}
  try {
    const res = await fetch(`externallibs/${packageId}/${libIndexName}`);
    if (res.ok) libIndex = await res.json();
  } catch {}
  try {
    const res = await fetch(`externallibs/${packageId}/${binIndexName}`);
    if (res.ok) binIndex = await res.json();
  } catch {}

  if (
    includeIndex &&
    (includeIndex.version !== 1 ||
      includeIndex.compression !== "gzip" ||
      !includeIndex.files)
  ) {
    throw new Error(`Invalid include index for ${packageId}`);
  }
  if (
    libIndex &&
    (libIndex.version !== 1 ||
      libIndex.compression !== "gzip" ||
      !libIndex.files)
  ) {
    throw new Error(`Invalid lib index for ${packageId}`);
  }
  if (
    binIndex &&
    (binIndex.version !== 1 ||
      binIndex.compression !== "gzip" ||
      !binIndex.files)
  ) {
    throw new Error(`Invalid bin index for ${packageId}`);
  }

  const state = {
    id: packageId,
    manifest: packageManifest,
    includeIndex,
    libIndex,
    binIndex,
  };
  externalPackageCache.set(packageId, state);
  return state;
}

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
    if (isLeaf) return value || null;
    if (!(value instanceof Directory)) return null;
    cur = value.contents;
  }
  return null;
}

function injectIntoVfs(rootMap, relPath, bytes) {
  const parts = relPath.split("/").filter(Boolean);
  const leaf = parts.pop();
  if (!leaf) return;
  const dir = ensureDirTree(rootMap, parts);
  dir.set(leaf, new File(bytes));
}

function addPackDirsToVfs(rootMap, index, prefix) {
  if (!index?.files) return;
  for (const key of Object.keys(index.files)) {
    if (prefix && !key.startsWith(prefix)) continue;
    const stripped = prefix ? key.slice(prefix.length) : key;
    const parts = stripped.split("/").filter(Boolean);
    parts.pop();
    if (parts.length) ensureDirTree(rootMap, parts);
  }
}

function getSysrootPackEntry(relPath) {
  if (relPath.startsWith("include/"))
    return packIndexes.include?.files?.[relPath] || null;
  if (relPath.startsWith("clang-include/"))
    return packIndexes.clangInclude?.files?.[relPath] || null;
  if (relPath.startsWith("lib/"))
    return packIndexes.lib?.files?.[relPath] || null;
  if (relPath.startsWith("externallibs/")) {
    const rest = relPath.slice("externallibs/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const pkgId = rest.slice(0, slash);
    const sub = rest.slice(slash + 1);
    const state = externalPackageCache.get(pkgId);
    if (!state) return null;
    if (sub.startsWith("include/"))
      return state.includeIndex?.files?.[sub] || null;
    if (sub.startsWith("lib/")) return state.libIndex?.files?.[sub] || null;
  }
  return null;
}

function getExternalPackEntry(lazy, fetchPath) {
  const state = externalPackageCache.get(lazy.pkgId);
  if (!state) return null;
  const key = `${lazy.sub}/${fetchPath}`;
  if (lazy.sub === "include") return state.includeIndex?.files?.[key] || null;
  if (lazy.sub === "lib") return state.libIndex?.files?.[key] || null;
  return null;
}

function fetchPackedFileSync(urlBase, relPath, entry) {
  const cacheKey = `${urlBase}|${entry.pack}:${entry.offset}:${entry.compressedSize}`;
  const cached = packedFileCache.get(cacheKey);
  if (cached) return cached;
  const start = entry.offset;
  const end = entry.offset + entry.compressedSize - 1;
  const url = `${urlBase}${entry.pack}`;
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.setRequestHeader("Range", `bytes=${start}-${end}`);
  xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status !== 206 && xhr.status !== 200) {
    throw new Error(`Range request failed for ${relPath}: ${xhr.status}`);
  }
  const compressed = new Uint8Array(xhr.response);
  if (xhr.status === 200 && compressed.length !== entry.compressedSize) {
    throw new Error(`Server ignored Range for ${relPath}`);
  }
  const bytes = gunzipSync(compressed);
  if (bytes.length !== entry.size) {
    throw new Error(
      `Size mismatch for ${relPath}: ${bytes.length} != ${entry.size}`,
    );
  }
  packedFileCache.set(cacheKey, bytes);
  return bytes;
}

function makeSysrootLazy() {
  return {
    id: "sysroot",
    kind: "sysroot",
    root: sysrootVfs,
    urlBase: "sysroot/",
    missed: new Set(),
  };
}

function makeExternalLazy(pkgId, sub, rootMap) {
  return {
    id: `external:${sub}:${pkgId}`,
    kind: "external",
    pkgId,
    sub,
    root: rootMap,
    urlBase: `externallibs/${pkgId}/`,
    missed: new Set(),
  };
}

function lookupPackEntry(lazy, fetchPath) {
  if (lazy.kind === "sysroot") return getSysrootPackEntry(fetchPath);
  if (lazy.kind === "external") return getExternalPackEntry(lazy, fetchPath);
  return null;
}

function tryLoadPackedFile(lazy, fetchPath) {
  if (lazy.missed.has(fetchPath)) return null;
  const entry = lookupPackEntry(lazy, fetchPath);
  if (!entry) {
    lazy.missed.add(fetchPath);
    return null;
  }
  try {
    const bytes = fetchPackedFileSync(lazy.urlBase, fetchPath, entry);
    injectIntoVfs(lazy.root, fetchPath, bytes);
    post({
      type: "status",
      m: `+ pack ${lazy.id}/${fetchPath} (${bytes.length} B)`,
    });
    return bytes;
  } catch (e) {
    lazy.missed.add(fetchPath);
    post({
      type: "status",
      m: `Pack miss ${lazy.id}/${fetchPath}: ${e.message}`,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Runtime DLL collection (for ZIP bundling)
// ─────────────────────────────────────────────────────────────

function collectRuntimeDlls(packageIds) {
  const dlls = new Map();
  for (const pkgId of packageIds) {
    const st = externalPackageCache.get(pkgId);
    if (!st?.binIndex?.files) continue;
    for (const [key, entry] of Object.entries(st.binIndex.files)) {
      if (!key.toLowerCase().endsWith(".dll")) continue;
      const filename = key.split("/").pop();
      if (!filename) continue;
      if (!dlls.has(filename)) {
        dlls.set(filename, { pkgId, key, entry });
      }
    }
  }
  return dlls;
}

function fetchDllSync(pkgId, entry) {
  const start = entry.offset;
  const end = entry.offset + entry.compressedSize - 1;
  const url = `externallibs/${pkgId}/${entry.pack}`;
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.setRequestHeader("Range", `bytes=${start}-${end}`);
  xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status !== 206 && xhr.status !== 200) {
    throw new Error(`Range request failed for ${url}: ${xhr.status}`);
  }
  const compressed = new Uint8Array(xhr.response);
  const bytes = gunzipSync(compressed);
  if (bytes.length !== entry.size) {
    throw new Error(
      `Size mismatch for ${url}: ${bytes.length} != ${entry.size}`,
    );
  }
  return bytes;
}

async function loadAssets() {
  post({ type: "status", m: "Loading clang.wasm (split)…" });
  clangBytes = await fetchSplit("clang.wasm", "clang", (loaded, total) =>
    post({ type: "progress", what: "clang", loaded, total }),
  );
  post({ type: "status", m: "Loading lld.wasm (split)…" });
  lldBytes = await fetchSplit("lld.wasm", "lld", (loaded, total) =>
    post({ type: "progress", what: "lld", loaded, total }),
  );
  await loadPackIndexes();
  await loadExternalManifest();

  post({ type: "status", m: "Loading libraries…" });
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
    post({ type: "status", m: "Libraries: packed sysroot mode." });
  }
  post({
    type: "status",
    m:
      `Libs: ${sysrootLibMap.size}/${SYSROOT_LIBS.length}` +
      (missingLibs.length ? ` (missing: ${missingLibs.join(", ")})` : ""),
  });

  post({ type: "status", m: "Loading compiler-rt builtins…" });
  builtinsMap = new Map([
    [BUILTINS_FILE, await fetchBytes(`builtins/${BUILTINS_FILE}`)],
  ]);

  sysrootVfs = new Map([
    ["lib", new Directory(new Map())],
    ["include", new Directory(new Map())],
    ["clang-include", new Directory(new Map())],
    ["externallibs", new Directory(new Map())],
  ]);

  addPackDirsToVfs(sysrootVfs, packIndexes.include, null);
  addPackDirsToVfs(sysrootVfs, packIndexes.clangInclude, null);
  addPackDirsToVfs(sysrootVfs, packIndexes.lib, null);
  ensureDirTree(sysrootVfs, ["include", "c++", "v1"]);

  let preloaded = 0;
  if (!packIndexes.include && !packIndexes.clangInclude) {
    post({
      type: "status",
      m: `Preloading ${CORE_HEADERS.length} core headers…`,
    });
    for (const rel of CORE_HEADERS) {
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
    m: `Toolchain ready (${preloaded} preloaded${cppAvailable ? ", C++ OK" : ""}).`,
  });
}

function makeWasi(argv, preopens, fdOut = null) {
  const fds = [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((m) => post({ type: "stdout", m })),
    ConsoleStdout.lineBuffered((m) => post({ type: "stderr", m })),
  ];
  if (fdOut) fdOut.clear();
  for (const [name, dir] of preopens) {
    const fd = fds.length;
    if (fdOut) fdOut.set(name, fd);
    fds.push(new PreopenDirectory(name, dir));
  }
  return new WASI(argv, [], fds);
}

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
            if (f & 0x4) {
              f &= ~0x4;
              if (f & 0x1) f |= 0x8;
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
            if (result !== 44) return result;
            const lazy = lazyDirs.get(fd);
            if (!lazy) return result;
            const fetchPath = relPath.replace(/^\/+/, "");
            if (!fetchPath) return result;
            const bytes = tryLoadPackedFile(lazy, fetchPath);
            if (!bytes) {
              const url = lazy.urlBase + fetchPath;
              try {
                const xhr = new XMLHttpRequest();
                xhr.open("GET", url, false);
                xhr.responseType = "arraybuffer";
                xhr.send();
                if (xhr.status !== 200) {
                  lazy.missed.add(fetchPath);
                  return result;
                }
                const raw = new Uint8Array(xhr.response);
                injectIntoVfs(lazy.root, fetchPath, raw);
                post({ type: "status", m: `+ ${fetchPath} (${raw.length} B)` });
              } catch {
                lazy.missed.add(fetchPath);
                return result;
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
        if (
          name === "path_filestat_get" &&
          typeof real.path_filestat_get === "function"
        ) {
          return (fd, flags, ptr, len, bufPtr) => {
            const result = real.path_filestat_get(fd, flags, ptr, len, bufPtr);
            if (result !== 44) return result;
            const lazy = lazyDirs.get(fd);
            if (!lazy) return result;
            const relPath = readStr(ptr, len);
            if (!relPath) return result;
            const fetchPath = relPath.replace(/^\/+/, "");
            if (!fetchPath) return result;
            const bytes = tryLoadPackedFile(lazy, fetchPath);
            if (!bytes) return result;
            return real.path_filestat_get(fd, flags, ptr, len, bufPtr);
          };
        }
        const value = real[prop];
        if (typeof value !== "function") return value;
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

const INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]*[<"]([^">]+)[">]/gm;

function scanIncludes(files) {
  const includes = new Set();
  for (const file of files) {
    if (file.binary) continue;
    const content = String(file.content || "");
    INCLUDE_RE.lastIndex = 0;
    let match;
    while ((match = INCLUDE_RE.exec(content))) {
      const include = String(match[1]).replace(/\\/g, "/").replace(/^\/+/, "");
      if (include) includes.add(include);
    }
  }
  return [...includes];
}

function includeMatchesPrefix(include, prefix) {
  if (typeof prefix !== "string") return false;
  if (prefix.endsWith("/")) return include.startsWith(prefix);
  return include === prefix;
}

function getManifestLibrary(id) {
  return externalManifest?.libraries?.[id] || null;
}

function matchExternalInclude(include) {
  if (!externalManifest) return [];
  const matches = [];
  for (const [packageId, pkg] of Object.entries(externalManifest.libraries)) {
    for (const prefix of pkg.includePrefixes || []) {
      if (includeMatchesPrefix(include, prefix)) {
        matches.push({
          packageId,
          libraries: pkg.libraries || [],
          dependencies: pkg.dependencies || [],
          systemLibraries: pkg.systemLibraries || [],
        });
        break;
      }
    }
    for (const rule of pkg.includeRules || []) {
      if (includeMatchesPrefix(include, rule.prefix)) {
        matches.push({
          packageId,
          libraries: rule.libraries || [],
          dependencies: rule.dependencies || [],
          systemLibraries: rule.systemLibraries || [],
        });
      }
    }
  }
  return matches;
}

async function resolveExternalLibraries(files) {
  const result = {
    packageIds: [],
    libraries: [],
    systemLibraries: [],
    includeDirs: [],
    libraryDirs: [],
  };
  if (!externalManifest) return result;
  const includes = scanIncludes(files);
  if (includes.length === 0) return result;
  const packageQueue = [];
  const packageSeen = new Set();
  const libraries = [];
  const systemLibraries = [];

  function addPackage(packageId) {
    if (typeof packageId !== "string") return;
    if (!getManifestLibrary(packageId)) {
      post({
        type: "status",
        m: `External dependency "${packageId}" not found in manifest.`,
      });
      return;
    }
    if (packageSeen.has(packageId)) return;
    packageSeen.add(packageId);
    packageQueue.push(packageId);
  }

  for (const include of includes) {
    const matches = matchExternalInclude(include);
    for (const match of matches) {
      addPackage(match.packageId);
      for (const lib of match.libraries || []) libraries.push(lib);
      for (const dep of match.dependencies || []) addPackage(dep);
      for (const lib of match.systemLibraries || []) systemLibraries.push(lib);
    }
  }

  for (let i = 0; i < packageQueue.length; i++) {
    const packageId = packageQueue[i];
    const pkg = getManifestLibrary(packageId);
    if (!pkg) continue;
    for (const dep of pkg.dependencies || []) addPackage(dep);
    for (const lib of pkg.libraries || []) libraries.push(lib);
    for (const lib of pkg.systemLibraries || []) systemLibraries.push(lib);
  }

  const packageIds = [...packageSeen];

  for (const packageId of packageIds) {
    await loadExternalPackage(packageId);
  }

  for (const packageId of packageIds) {
    result.includeDirs.push(
      `${PATH.sysroot}/externallibs/${packageId}/include`,
    );
    result.libraryDirs.push(`${PATH.sysroot}/externallibs/${packageId}/lib`);
  }

  result.packageIds = packageIds;
  result.libraries = [...new Set(libraries.filter(Boolean))];
  result.systemLibraries = [...new Set(systemLibraries.filter(Boolean))];

  post({
    type: "status",
    m: packageIds.length
      ? `External: ${packageIds.join(", ")}`
      : "External: none",
  });
  if (result.libraries.length) {
    post({
      type: "status",
      m: `External libs: ${result.libraries.map((x) => `-l${x}`).join(" ")}`,
    });
  }
  return result;
}

function prepareExternalVfs(packageIds) {
  for (const packageId of packageIds) {
    const state = externalPackageCache.get(packageId);
    if (!state) continue;
    if (state.includeIndex) {
      const incMap = ensureDirTree(sysrootVfs, [
        "externallibs",
        packageId,
        "include",
      ]);
      addPackDirsToVfs(incMap, state.includeIndex, "include/");
    } else {
      ensureDirTree(sysrootVfs, ["externallibs", packageId, "include"]);
    }
    if (state.libIndex) {
      const libMap = ensureDirTree(sysrootVfs, [
        "externallibs",
        packageId,
        "lib",
      ]);
      addPackDirsToVfs(libMap, state.libIndex, "lib/");
    } else {
      ensureDirTree(sysrootVfs, ["externallibs", packageId, "lib"]);
    }
  }
}

function buildPreopenSet(work, sysroot, builtins, packageIds) {
  const preopens = [
    [PATH.work, work],
    [PATH.sysroot, sysroot],
    [PATH.builtins, builtins],
  ];
  const externalInfos = [];
  for (const pkgId of packageIds) {
    const state = externalPackageCache.get(pkgId);
    if (!state) continue;
    if (state.includeIndex) {
      const incMap = ensureDirTree(sysroot, ["externallibs", pkgId, "include"]);
      const incName = `${PATH.sysroot}/externallibs/${pkgId}/include`;
      preopens.push([incName, incMap]);
      externalInfos.push({ name: incName, sub: "include", pkgId });
    }
    if (state.libIndex) {
      const libMap = ensureDirTree(sysroot, ["externallibs", pkgId, "lib"]);
      const libName = `${PATH.sysroot}/externallibs/${pkgId}/lib`;
      preopens.push([libName, libMap]);
      externalInfos.push({ name: libName, sub: "lib", pkgId });
    }
  }
  return { preopens, externalInfos };
}

function buildLazyDirs(sysroot, fdMap, externalInfos) {
  const lazyDirs = new Map();
  const sysrootFd = fdMap.get(PATH.sysroot);
  if (sysrootFd !== undefined) lazyDirs.set(sysrootFd, makeSysrootLazy());
  for (const { name, sub, pkgId } of externalInfos) {
    const fd = fdMap.get(name);
    if (fd === undefined) continue;
    const state = externalPackageCache.get(pkgId);
    if (!state) continue;
    const rootMap = ensureDirTree(sysroot, [
      "externallibs",
      pkgId,
      sub === "include" ? "include" : "lib",
    ]);
    lazyDirs.set(fd, makeExternalLazy(pkgId, sub, rootMap));
  }
  return lazyDirs;
}

function classify(path) {
  const ext = path.split(".").pop().toLowerCase();
  if (ext === "c") return "c";
  if (["cpp", "cc", "cxx"].includes(ext)) return "cpp";
  if (["h", "hpp", "hxx", "inc"].includes(ext)) return "header";
  if (["s", "asm"].includes(ext)) return "asm";
  if (ext === "rc") return "rc";
  return "other";
}

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
  const libDir = sysrootVfs.get("lib");
  for (const [name, bytes] of sysrootLibMap) {
    libDir.contents.set(name, new File(bytes));
  }
  const builtins = new Map();
  for (const [path, bytes] of builtinsMap) {
    builtins.set(path.split("/").pop(), new File(bytes));
  }
  return { work, sysroot: sysrootVfs, builtins };
}

function getOptimizationFlag(config) {
  const value = String(config?.ccpp?.optimization || "");
  if (value.includes("/O1") || value.includes("Minimize Size")) return "-Os";
  if (
    value.includes("/O2") ||
    value.includes("Maximize Speed") ||
    value.includes("Maximum")
  )
    return "-O2";
  if (value.includes("/Ox") || value.includes("Full")) return "-O3";
  return "-O0";
}

function getWarningFlags(config) {
  const value = String(config?.ccpp?.warnings || "");
  if (value.includes("/W0") || value.includes("Turn Off")) return ["-w"];
  if (value.includes("/Wall") || value.includes("EnableAll"))
    return ["-Weverything"];
  if (value.includes("/W4") || value.includes("Level4"))
    return ["-Wall", "-Wextra", "-Wpedantic"];
  if (value.includes("/W3") || value.includes("Level3"))
    return ["-Wall", "-Wextra"];
  if (value.includes("/W2") || value.includes("Level2")) return ["-Wall"];
  if (value.includes("/W1") || value.includes("Level1")) return ["-Wall"];
  return [];
}

function getCharacterSetFlags(config) {
  const value = String(config?.general?.characterSet || "");
  if (value.includes("Unicode")) return ["-DUNICODE", "-D_UNICODE"];
  if (value.includes("Multi-Byte")) return ["-D_MBCS"];
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
  if (value.includes("References") || value.includes("/OPT:REF"))
    return ["--gc-sections"];
  return [];
}

function getSubsystem(config) {
  const value = String(config?.linker?.subsystem || "");
  if (value.includes("Windows")) return "windows";
  if (value.includes("Native")) return "native";
  return "console";
}

function getEntryPoint(config) {
  const explicit = String(config?.linker?.entryPoint || "").trim();
  if (explicit) return explicit;
  return getSubsystem(config) === "windows"
    ? "WinMainCRTStartup"
    : "mainCRTStartup";
}

async function build(files, config) {
  const external = await resolveExternalLibraries(files);
  prepareExternalVfs(external.packageIds);
  const { work, sysroot, builtins } = buildVirtualFs(files);

  const sources = [];
  let usesCpp = false;
  for (const f of files) {
    const kind = classify(f.path);
    if (kind === "c") sources.push({ path: f.path, kind: "c" });
    else if (kind === "cpp") {
      sources.push({ path: f.path, kind: "cpp" });
      usesCpp = true;
    } else if (kind === "asm") {
      sources.push({ path: f.path, kind: "asm" });
    }
  }
  if (sources.length === 0) throw new Error("No source files (.c/.cpp/.S)");

  const prebuiltObjects = [];
  for (const f of files) {
    const lower = f.path.toLowerCase();
    if (f.binary && (lower.endsWith(".obj") || lower.endsWith(".o"))) {
      prebuiltObjects.push("/work/" + f.path);
    }
  }

  const includeDirs = (config?.ccpp?.additionalIncludeDirectories || []).map(
    (dir) => {
      const normalized = String(dir).replace(/\\/g, "/");
      return normalized.startsWith("/")
        ? `-I${normalized}`
        : `-I/work/${normalized}`;
    },
  );
  includeDirs.push("-I/work/include", "-I/work/res", "-I/work/");
  for (const dir of external.includeDirs) includeDirs.push("-isystem", dir);

  const defines = (config?.ccpp?.preprocessorDefinitions || [])
    .filter(Boolean)
    .map((d) => `-D${d}`);
  const resourceDefines = (config?.resources?.preprocessorDefinitions || [])
    .filter(Boolean)
    .map((d) => `-D${d}`);
  defines.push(...resourceDefines);

  const langStd =
    config?.ccpp?.languageStandard ||
    config?.general?.cppLanguageStandard ||
    "stdcpp17";
  let stdFlag = "-std=c++17";
  if (langStd === "stdcpp14") stdFlag = "-std=c++14";
  else if (langStd === "stdcpp20") stdFlag = "-std=c++20";
  else if (langStd === "stdcpp23") stdFlag = "-std=c++23";

  const optimizationFlag = getOptimizationFlag(config);
  const warningFlags = getWarningFlags(config);
  const warningsAsErrors =
    config?.ccpp?.treatWarningsAsErrors === true ? ["-Werror"] : [];
  const debugInfo = shouldGenerateDebugInfo(config);
  const characterSetFlags = getCharacterSetFlags(config);

  const intermediateDirectory = String(
    config?.general?.intermediateDirectory || "",
  )
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const intermediateParts = intermediateDirectory.split("/").filter(Boolean);
  if (intermediateParts.length) ensureDirTree(work, intermediateParts);

  const { preopens, externalInfos } = buildPreopenSet(
    work,
    sysroot,
    builtins,
    external.packageIds,
  );

  const objects = [];
  for (const src of sources) {
    const sourceFileName = src.path.split("/").pop();
    const objectName = sourceFileName.replace(/\.(c|cpp|cc|cxx|s|asm)$/i, ".o");
    const obj = intermediateDirectory
      ? `${intermediateDirectory}/${objectName}`
      : objectName;
    post({ type: "status", m: `clang: ${src.path} → ${obj}` });
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

    const clangFdMap = new Map();
    const wasi = makeWasi(args, preopens, clangFdMap);
    const clangLazyDirs = buildLazyDirs(sysroot, clangFdMap, externalInfos);
    const code = await runWasm(clangBytes, wasi, { lazyDirs: clangLazyDirs });

    const objParts = obj.split("/");
    const objFile = fsLookup(work, objParts);
    const objOk =
      objFile instanceof File && objFile.data && objFile.data.length > 0;
    if (code !== 0)
      throw new Error(`clang failed on ${src.path} (exit ${code})`);
    if (!objOk)
      throw new Error(`clang did not produce ${obj} — check errors above`);

    post({ type: "status", m: `  → ${obj} (${objFile.data.length} B)` });
    objects.push("/work/" + obj);
  }

  const outputDirectory = String(config?.general?.outputDirectory || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const outputParts = outputDirectory.split("/").filter(Boolean);
  if (outputParts.length) ensureDirTree(work, outputParts);

  const targetName =
    String(config?.general?.targetName || "main")
      .replace("$(ProjectName)", "main")
      .trim() || "main";
  const outPath =
    "/work/" +
    (outputDirectory ? `${outputDirectory}/` : "") +
    `${targetName}.exe`;

  const cppLibs = [];
  if (usesCpp && cppAvailable) {
    const hasLib = (name) =>
      sysrootLibMap.has(name) || !!getSysrootPackEntry(`lib/${name}`);
    if (hasLib("libc++.a")) cppLibs.push("-lc++");
    if (hasLib("libc++abi.a")) cppLibs.push("-lc++abi");
  }

  const extraLibs = [];
  for (const dep of config?.linker?.additionalDependencies || []) {
    const n = String(dep)
      .trim()
      .replace(/\.(a|lib)$/i, "")
      .replace(/^lib/i, "");
    if (!n) continue;
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
    )
      continue;
    extraLibs.push("-l" + n);
  }
  const uniqueExtraLibs = [...new Set(extraLibs)];

  const externalLibFlags = external.libraries.map((name) => "-l" + name);
  const externalSystemFlags = external.systemLibraries.map(
    (name) => "-l" + name,
  );
  const allExternalAndManual = [
    ...externalLibFlags,
    ...uniqueExtraLibs,
    ...externalSystemFlags,
  ];
  const uniqueAllExternalAndManual = [...new Set(allExternalAndManual)];

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
  for (const dir of external.libraryDirs) libraryDirs.push(`-L${dir}`);

  const linkerOptimizationFlags = getLinkerOptimizationFlags(config);
  const entryPoint = getEntryPoint(config);

  const externalLibsStatic = [];
  const externalLibsDynamic = [];
  for (const name of external.libraries) {
    let hasStatic = false;
    for (const pkgId of external.packageIds) {
      const st = externalPackageCache.get(pkgId);
      if (!st?.libIndex?.files) continue;
      if (st.libIndex.files[`lib/lib${name}.a`]) {
        hasStatic = true;
        break;
      }
    }
    if (hasStatic) {
      externalLibsStatic.push("-l" + name);
    } else {
      externalLibsDynamic.push("-l" + name);
      post({
        type: "status",
        m: `External: ${name} → dynamic (no static in clang64)`,
      });
    }
  }

  const lldArgs = [
    "ld.lld",
    "-m",
    "i386pep",
    "-Bstatic",
    "-lpthread",
    "--allow-multiple-definition",
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
    ...externalLibsStatic,
    ...uniqueExtraLibs,
    "-Bdynamic",
    ...externalLibsDynamic,
    ...externalSystemFlags,
    "/sysroot/lib/crtend.o",
  ];

  post({
    type: "status",
    m: `Linking ${targetName}.exe (${config?.general?.configurationType || "Application (.exe)"})…`,
  });
  post({
    type: "status",
    m: external.packageIds.length
      ? `Packages: ${external.packageIds.join(", ")}`
      : "Packages: none",
  });

  const lldFdMap = new Map();
  const lldWasi = makeWasi(lldArgs, preopens, lldFdMap);
  const lldLazyDirs = buildLazyDirs(sysroot, lldFdMap, externalInfos);
  const code = await runWasm(lldBytes, lldWasi, { lazyDirs: lldLazyDirs });
  if (code !== 0) throw new Error(`lld failed (exit ${code})`);

  const outParts = outPath
    .replace(/^\/work\//, "")
    .split("/")
    .filter(Boolean);
  const exe = fsLookup(work, outParts);
  if (!(exe instanceof File) || !exe.data || exe.data.length === 0) {
    throw new Error(`lld produced no output: ${outPath}`);
  }

  const exeName = outPath.split("/").pop();

  // ── If any external lib was linked dynamically, bundle DLLs ──

  if (externalLibsDynamic.length > 0) {
    post({
      type: "status",
      m: `Detected ${externalLibsDynamic.length} dynamic lib(s) — collecting DLLs…`,
    });

    const dllMap = collectRuntimeDlls(external.packageIds);

    if (dllMap.size === 0) {
      post({
        type: "status",
        m: "Warning: dynamic libraries used but no .dll found in bin index. Returning .exe only.",
      });
      post({ type: "result", name: exeName, bytes: exe.data });
      return;
    }

    const zipEntries = {};
    zipEntries[exeName] = exe.data;

    for (const [filename, info] of dllMap) {
      try {
        const bytes = fetchDllSync(info.pkgId, info.entry);
        zipEntries[filename] = bytes;
        post({ type: "status", m: `+ dll ${filename} (${bytes.length} B)` });
      } catch (e) {
        post({
          type: "status",
          m: `DLL fetch failed: ${filename} — ${e.message}`,
        });
      }
    }

    const zipBytes = zipSync(zipEntries, { level: 6 });
    const zipName = `${targetName}.zip`;

    post({
      type: "status",
      m: `OK — ${exeName} + ${dllMap.size} DLL(s) → ${zipName} (${zipBytes.length} B)`,
    });
    post({ type: "result", name: zipName, bytes: zipBytes });
    return;
  }

  post({ type: "status", m: `OK — ${outPath} (${exe.data.length} B)` });
  post({ type: "result", name: exeName, bytes: exe.data });
}

self.onmessage = async (ev) => {
  const { type } = ev.data || {};
  try {
    if (type === "init") {
      await loadAssets();
      post({ type: "ready" });
      return;
    }
    if (type === "build") {
      await build(ev.data.files, ev.data.config);
      return;
    }
  } catch (e) {
    post({ type: "error", m: String((e && e.stack) || e) });
  }
};
