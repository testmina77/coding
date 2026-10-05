// project.js — project model + persistence hooks

import { saveProject, loadProject } from "./persistence.js";

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

      optimization: debug ? "Disabled (/Od)" : "Maximize Speed (/O2)",

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

    buildEvents: {
      preBuildEvent: "",
      preLinkEvent: "",
      postBuildEvent: "",
    },
  };
}

function createDefaultConfigs() {
  return {
    Debug: {
      x64: defaultConfig("Debug"),
    },

    Release: {
      x64: defaultConfig("Release"),
    },
  };
}

function ensureConfigShape(cfg, name) {
  const defaults = defaultConfig(name);

  if (!cfg || typeof cfg !== "object") {
    return defaults;
  }

  for (const section of Object.keys(defaults)) {
    if (!cfg[section] || typeof cfg[section] !== "object") {
      cfg[section] = structuredClone(defaults[section]);
      continue;
    }

    for (const [key, value] of Object.entries(defaults[section])) {
      if (!(key in cfg[section])) {
        cfg[section][key] = structuredClone(value);
      }
    }
  }

  return cfg;
}

function ensureProjectConfigs() {
  if (!project.configs || typeof project.configs !== "object") {
    project.configs = createDefaultConfigs();
  }

  if (!project.configs.Debug) {
    project.configs.Debug = {
      x64: defaultConfig("Debug"),
    };
  }

  if (!project.configs.Release) {
    project.configs.Release = {
      x64: defaultConfig("Release"),
    };
  }

  if (!project.configs.Debug.x64) {
    project.configs.Debug.x64 = defaultConfig("Debug");
  }

  if (!project.configs.Release.x64) {
    project.configs.Release.x64 = defaultConfig("Release");
  }

  project.configs.Debug.x64 = ensureConfigShape(
    project.configs.Debug.x64,
    "Debug",
  );

  project.configs.Release.x64 = ensureConfigShape(
    project.configs.Release.x64,
    "Release",
  );
}

export const project = {
  name: "MyProject",
  root: "/work",

  files: new Map(),

  activeConfig: "Debug",
  activePlatform: "x64",

  configs: createDefaultConfigs(),

  _saveTimer: null,
};

// ─────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────

export function scheduleSave() {
  if (project._saveTimer) {
    clearTimeout(project._saveTimer);
  }

  project._saveTimer = setTimeout(() => {
    project._saveTimer = null;

    saveProject(project).catch((err) => {
      console.error("Failed to save project:", err);
    });
  }, 800);
}

// ─────────────────────────────────────────────────────────────
// Files
// ─────────────────────────────────────────────────────────────

export function addFile(path, content = "") {
  project.files.set(path, {
    path,
    content,
    dirty: false,
  });

  invalidateCompletion();
  scheduleSave();
}

export function removeFile(path) {
  project.files.delete(path);

  invalidateCompletion();
  scheduleSave();
}

export function getFile(path) {
  return project.files.get(path) || null;
}

export function setFileContent(path, content) {
  const file = project.files.get(path);

  if (!file) return;

  file.content = content;
  file.dirty = true;

  invalidateCompletion();
  scheduleSave();
}

export function renameFile(oldPath, newPath) {
  const file = project.files.get(oldPath);

  if (!file) return false;

  if (project.files.has(newPath)) {
    return false;
  }

  project.files.delete(oldPath);

  file.path = newPath;

  project.files.set(newPath, file);

  invalidateCompletion();
  scheduleSave();

  return true;
}

function invalidateCompletion() {
  import("./completion.js")
    .then((m) => {
      if (typeof m.invalidateCompletionCache === "function") {
        m.invalidateCompletionCache();
      }
    })
    .catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// Project tree
// ─────────────────────────────────────────────────────────────

export function buildTree() {
  const root = {
    name: project.name,
    type: "project",
    children: new Map(),
  };

  for (const [path] of project.files) {
    const parts = path.split("/").filter(Boolean);

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

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

export function getConfig() {
  ensureProjectConfigs();

  if (!project.configs[project.activeConfig]) {
    project.activeConfig = "Debug";
  }

  if (!project.configs[project.activeConfig][project.activePlatform]) {
    project.activePlatform = "x64";
  }

  return project.configs[project.activeConfig][project.activePlatform];
}

export function getActiveConfigName() {
  return project.activeConfig;
}

export function getActivePlatformName() {
  return project.activePlatform;
}

export function setActiveConfig(name) {
  ensureProjectConfigs();

  if (!project.configs[name]) {
    console.warn(`Unknown configuration: ${name}`);
    return false;
  }

  if (!project.configs[name][project.activePlatform]) {
    project.configs[name].x64 = defaultConfig(name);
  }

  project.activeConfig = name;

  scheduleSave();

  return true;
}

export function setActivePlatform(platform) {
  ensureProjectConfigs();

  if (!["x64"].includes(platform)) {
    console.warn(`Unknown platform: ${platform}`);
    return false;
  }

  for (const configName of Object.keys(project.configs)) {
    if (!project.configs[configName][platform]) {
      project.configs[configName][platform] = defaultConfig(configName);
    }
  }

  project.activePlatform = platform;

  scheduleSave();

  return true;
}

export function setConfigValue(section, key, value) {
  const cfg = getConfig();

  if (!cfg[section]) {
    cfg[section] = {};
  }

  cfg[section][key] = value;

  scheduleSave();
}

export function getConfigValue(section, key, fallback = undefined) {
  const cfg = getConfig();

  return cfg?.[section]?.[key] ?? fallback;
}

export function resetActiveConfig() {
  ensureProjectConfigs();

  project.configs[project.activeConfig][project.activePlatform] = defaultConfig(
    project.activeConfig,
  );

  scheduleSave();
}

export function resetAllConfigs() {
  project.configs = createDefaultConfigs();

  project.activeConfig = "Debug";
  project.activePlatform = "x64";

  scheduleSave();
}

// ─────────────────────────────────────────────────────────────
// Storage bootstrap
// ─────────────────────────────────────────────────────────────

export async function bootstrapFromStorage() {
  const saved = await loadProject();

  if (!saved) {
    return false;
  }

  if (saved.name) {
    project.name = saved.name;
  }

  if (saved.activeConfig) {
    project.activeConfig = saved.activeConfig;
  }

  if (saved.activePlatform) {
    project.activePlatform = saved.activePlatform;
  }

  if (saved.configs) {
    project.configs = saved.configs;
  } else {
    project.configs = createDefaultConfigs();
  }

  if (saved.files instanceof Map) {
    project.files = saved.files;
  } else if (Array.isArray(saved.files)) {
    project.files = new Map(saved.files);
  } else {
    project.files = new Map();
  }

  ensureProjectConfigs();

  // Fallback if saved project contains an invalid config/platform.
  if (!project.configs[project.activeConfig]) {
    project.activeConfig = "Debug";
  }

  if (!project.configs[project.activeConfig][project.activePlatform]) {
    project.activePlatform = "x64";
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Reset project
// ─────────────────────────────────────────────────────────────

export function resetToDefault() {
  project.files.clear();

  project.name = "MyProject";
  project.root = "/work";

  project.activeConfig = "Debug";
  project.activePlatform = "x64";

  project.configs = createDefaultConfigs();

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

// ─────────────────────────────────────────────────────────────
// Replace project
// ─────────────────────────────────────────────────────────────

export function replaceProject(
  name,
  files,
  configs,
  activeConfig,
  activePlatform,
) {
  project.files.clear();

  project.name = name || "MyProject";
  project.root = "/work";

  project.activeConfig = activeConfig || "Debug";

  project.activePlatform = activePlatform || "x64";

  project.configs = configs || createDefaultConfigs();

  if (files instanceof Map) {
    for (const [path, file] of files) {
      project.files.set(path, file);
    }
  } else if (Array.isArray(files)) {
    for (const [path, file] of files) {
      project.files.set(path, file);
    }
  }

  ensureProjectConfigs();

  if (!project.configs[project.activeConfig]) {
    project.activeConfig = "Debug";
  }

  if (!project.configs[project.activeConfig][project.activePlatform]) {
    project.activePlatform = "x64";
  }

  scheduleSave();
}

// ─────────────────────────────────────────────────────────────
// Debug helper
// ─────────────────────────────────────────────────────────────

export function logActiveConfig() {
  const cfg = getConfig();

  console.log(
    `[ForgeIDE] Active configuration: ${project.activeConfig}|${project.activePlatform}`,
  );

  console.log("[ForgeIDE] Configuration:", structuredClone(cfg));
}
export function getConfigFor(
  configName,
  platformName = project.activePlatform,
) {
  ensureProjectConfigs();

  return project.configs?.[configName]?.[platformName] || null;
}

export function setConfigValueFor(
  configName,
  platformName,
  section,
  key,
  value,
) {
  const cfg = getConfigFor(configName, platformName);

  if (!cfg) return false;

  if (!cfg[section]) {
    cfg[section] = {};
  }

  cfg[section][key] = value;

  scheduleSave();

  return true;
}
