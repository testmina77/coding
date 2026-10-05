// project.js — project model + persistence hooks

import { saveProject, loadProject } from "./persistence.js";

export const project = {
  name: "MyProject",
  root: "/work",
  files: new Map(),
  activeConfig: "Debug",
  activePlatform: "x64",
  configs: {
    Debug: { x64: defaultConfig("Debug") },
    Release: { x64: defaultConfig("Release") },
  },
  _saveTimer: null,
};

function defaultConfig(name) {
  const debug = name === "Debug";
  return {
    general: {
      outputDirectory: `bin\\${name}\\`,
      intermediateDirectory: `obj\\${name}\\`,
      targetName: "$(ProjectName)",
      configurationType: "Application (.exe)",
      platformToolset: "Clang (WASM) x64",
      cppLanguageStandard: debug ? "stdcpp17" : "stdcpp20",
      characterSet: "Use Unicode Character Set",
    },
    ccpp: {
      additionalIncludeDirectories: ["include"],
      preprocessorDefinitions: debug
        ? ["_DEBUG", "WIN32", "_CONSOLE"]
        : ["NDEBUG", "WIN32", "_CONSOLE"],
      optimization: debug ? "Disabled (/Od)" : "Maximum (/O2)",
      runtimeLibrary: debug ? "MultiThreadedDebugDLL" : "MultiThreadedDLL",
      warnings: "Level3 (/W3)",
      treatWarningsAsErrors: false,
      debugInformationFormat: debug ? "Program Database (/Zi)" : "None",
      languageStandard: debug ? "stdcpp17" : "stdcpp20",
    },
    linker: {
      additionalLibraryDirectories: [],
      additionalDependencies: [
        "libucrt.a",
        "libmingw32.a",
        "libmingwex.a",
        "libkernel32.a",
        //"libmsvcrt-os.a",
      ],
      subsystem: "Console (/SUBSYSTEM:CONSOLE)",
      entryPoint: "mainCRTStartup",
      generateDebugInfo: debug,
      optimization: debug ? "Off" : "References (/OPT:REF)",
    },
    resources: {
      preprocessorDefinitions: [],
      culture: "",
      additionalIncludeDirectories: ["res"],
    },
    buildEvents: { preBuildEvent: "", preLinkEvent: "", postBuildEvent: "" },
  };
}

export function scheduleSave() {
  if (project._saveTimer) clearTimeout(project._saveTimer);
  project._saveTimer = setTimeout(() => {
    saveProject(project).catch(() => {});
  }, 800);
}

export function addFile(path, content = "") {
  project.files.set(path, { path, content, dirty: false });
  invalidateCompletion();
  scheduleSave();
}

export function removeFile(path) {
  project.files.delete(path);
  invalidateCompletion();
  scheduleSave();
}

export function getFile(path) {
  return project.files.get(path);
}

export function setFileContent(path, content) {
  const f = project.files.get(path);
  if (f) {
    f.content = content;
    f.dirty = true;
    invalidateCompletion();
    scheduleSave();
  }
}

export function renameFile(oldPath, newPath) {
  const f = project.files.get(oldPath);
  if (!f) return;
  project.files.delete(oldPath);
  f.path = newPath;
  project.files.set(newPath, f);
  invalidateCompletion();
  scheduleSave();
}

function invalidateCompletion() {
  import("./completion.js")
    .then((m) => m.invalidateCompletionCache())
    .catch(() => {});
}

export function buildTree() {
  const root = { name: project.name, type: "project", children: new Map() };
  for (const [path] of project.files) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          type: isLeaf ? "file" : "folder",
          path: isLeaf ? path : parts.slice(0, i + 1).join("/"),
          children: isLeaf ? null : new Map(),
        });
      }
      node = node.children.get(part);
    }
  }
  return root;
}

export function getConfig() {
  return project.configs[project.activeConfig][project.activePlatform];
}

export function setConfigValue(section, key, value) {
  const cfg = getConfig();
  if (cfg[section]) cfg[section][key] = value;
  scheduleSave();
}

export async function bootstrapFromStorage() {
  const saved = await loadProject();
  if (saved && saved.files && saved.files.size > 0) {
    project.name = saved.name;
    project.activeConfig = saved.activeConfig;
    project.activePlatform = saved.activePlatform;
    if (saved.configs) project.configs = saved.configs;
    project.files = saved.files;
    return true;
  }
  return false;
}

export function resetToDefault() {
  project.files.clear();
  project.name = "MyProject";
  project.activeConfig = "Debug";
  project.activePlatform = "x64";
  project.configs = {
    Debug: { x64: defaultConfig("Debug") },
    Release: { x64: defaultConfig("Release") },
  };
  addFile(
    "src/main.cpp",
    `#include <stdio.h>

int main(int argc, char** argv) {
    printf("Hello from ForgeIDE!\\n");
    return 0;
}
`,
  );
  addFile(
    "include/version.h",
    `#pragma once
#define FORGEIDE_VERSION "0.2.0"
`,
  );
  scheduleSave();
}

export function replaceProject(
  name,
  files,
  configs,
  activeConfig,
  activePlatform,
) {
  project.files.clear();
  project.name = name;
  project.activeConfig = activeConfig || "Debug";
  project.activePlatform = activePlatform || "x64";
  if (configs) project.configs = configs;
  for (const [path, f] of files) {
    project.files.set(path, f);
  }
  scheduleSave();
}
