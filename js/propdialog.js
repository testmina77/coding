// propdialog.js — MSBuild-style Project Properties dialog

import { project, setConfigValueFor } from "./project.js";

const SCHEMA = [
  {
    id: "general",
    label: "General",
    group: "Configuration Properties",
    fields: [
      { key: "outputDirectory", label: "Output Directory", type: "text" },
      {
        key: "intermediateDirectory",
        label: "Intermediate Directory",
        type: "text",
      },
      { key: "targetName", label: "Target Name", type: "text" },
      {
        key: "configurationType",
        label: "Configuration Type",
        type: "select",
        options: [
          "Application (.exe)",
          "Dynamic Library (.dll)",
          "Static Library (.lib)",
        ],
      },
      {
        key: "platformToolset",
        label: "Platform Toolset",
        type: "select",
        options: ["Clang (WASM) x64"],
      },
      {
        key: "cppLanguageStandard",
        label: "C++ Language Standard",
        type: "select",
        options: ["stdcpp14", "stdcpp17", "stdcpp20", "stdcpp23"],
      },
      {
        key: "characterSet",
        label: "Character Set",
        type: "select",
        options: [
          "Use Unicode Character Set",
          "Use Multi-Byte Character Set",
          "Not Set",
        ],
      },
    ],
  },

  {
    id: "ccpp",
    label: "C/C++",
    group: "Configuration Properties",
    fields: [
      {
        key: "additionalIncludeDirectories",
        label: "Additional Include Directories",
        type: "list",
      },
      {
        key: "preprocessorDefinitions",
        label: "Preprocessor Definitions",
        type: "list",
      },
      {
        key: "optimization",
        label: "Optimization",
        type: "select",
        options: [
          "Disabled (/Od)",
          "Minimize Size (/O1)",
          "Maximize Speed (/O2)",
          "Full (/Ox)",
        ],
      },
      {
        key: "languageStandard",
        label: "Language Standard",
        type: "select",
        options: ["stdcpp14", "stdcpp17", "stdcpp20", "stdcpp23"],
      },
      {
        key: "runtimeLibrary",
        label: "Runtime Library",
        type: "select",
        options: [
          "MultiThreadedDLL",
          "MultiThreadedDebugDLL",
          "MultiThreaded",
          "MultiThreadedDebug",
        ],
      },
      {
        key: "warnings",
        label: "Warning Level",
        type: "select",
        options: [
          "Turn Off (/W0)",
          "Level1 (/W1)",
          "Level2 (/W2)",
          "Level3 (/W3)",
          "Level4 (/W4)",
          "EnableAll (/Wall)",
        ],
      },
      {
        key: "treatWarningsAsErrors",
        label: "Treat Warnings as Errors",
        type: "bool",
      },
      {
        key: "debugInformationFormat",
        label: "Debug Information Format",
        type: "select",
        options: ["None", "Program Database (/Zi)", "Edit and Continue (/ZI)"],
      },
    ],
  },

  {
    id: "linker",
    label: "Linker",
    group: "Configuration Properties",
    fields: [
      {
        key: "additionalLibraryDirectories",
        label: "Additional Library Directories",
        type: "list",
      },
      {
        key: "additionalDependencies",
        label: "Additional Dependencies",
        type: "list",
      },
      {
        key: "subsystem",
        label: "SubSystem",
        type: "select",
        options: [
          "Console (/SUBSYSTEM:CONSOLE)",
          "Windows (/SUBSYSTEM:WINDOWS)",
          "Native",
        ],
      },
      {
        key: "entryPoint",
        label: "Entry Point",
        type: "text",
      },
      {
        key: "generateDebugInfo",
        label: "Generate Debug Info",
        type: "bool",
      },
      {
        key: "optimization",
        label: "Linker Optimization",
        type: "select",
        options: [
          "Off",
          "References (/OPT:REF)",
          "References and ICF (/OPT:REF,ICF)",
        ],
      },
    ],
  },

  {
    id: "resources",
    label: "Resources",
    group: "Configuration Properties",
    fields: [
      {
        key: "additionalIncludeDirectories",
        label: "Additional Include Directories",
        type: "list",
      },
      {
        key: "preprocessorDefinitions",
        label: "Preprocessor Definitions",
        type: "list",
      },
      {
        key: "culture",
        label: "Culture",
        type: "text",
      },
    ],
  },

  {
    id: "buildEvents",
    label: "Build Events",
    group: "Configuration Properties",
    fields: [
      {
        key: "preBuildEvent",
        label: "Pre-Build Event",
        type: "text",
      },
      {
        key: "preLinkEvent",
        label: "Pre-Link Event",
        type: "text",
      },
      {
        key: "postBuildEvent",
        label: "Post-Build Event",
        type: "text",
      },
    ],
  },
];

let currentSection = "general";

let dialogConfig = "Debug";
let dialogPlatform = "x64";

const dlg = document.getElementById("prop-dialog");
const nav = document.getElementById("propdlg-nav");
const grid = document.getElementById("propdlg-grid");

const cfgSelect = document.getElementById("propdlg-cfg");
const platformSelect = document.getElementById("propdlg-plat");
const cfgScopeSelect = document.getElementById("propdlg-cfgname");

function getDialogConfig() {
  return project.configs?.[dialogConfig]?.[dialogPlatform] || null;
}

export function openPropDialog() {
  dialogConfig = project.activeConfig;
  dialogPlatform = project.activePlatform;

  cfgSelect.value = dialogConfig;
  platformSelect.value = dialogPlatform;

  if (cfgScopeSelect) {
    cfgScopeSelect.value = "All Configurations";
  }

  document.getElementById("propdlg-title").textContent =
    `${project.name} Property Pages`;

  renderNav();
  renderGrid();

  dlg.classList.remove("hidden");
}

export function closePropDialog() {
  dlg.classList.add("hidden");
}

cfgSelect.addEventListener("change", () => {
  dialogConfig = cfgSelect.value;

  if (cfgScopeSelect) {
    cfgScopeSelect.value = "All Configurations";
  }

  renderGrid();
});

platformSelect.addEventListener("change", () => {
  dialogPlatform = platformSelect.value;

  renderGrid();
});

if (cfgScopeSelect) {
  cfgScopeSelect.addEventListener("change", () => {
    if (cfgScopeSelect.value === "All Configurations") {
      renderGrid();
      return;
    }

    dialogConfig = cfgScopeSelect.value;
    cfgSelect.value = dialogConfig;

    renderGrid();
  });
}

function renderNav() {
  nav.innerHTML = "";

  let lastGroup = null;

  for (const s of SCHEMA) {
    if (s.group !== lastGroup) {
      const g = document.createElement("div");
      g.className = "nav-group";
      g.textContent = s.group;

      nav.appendChild(g);

      lastGroup = s.group;
    }

    const item = document.createElement("div");

    item.className = "nav-item" + (s.id === currentSection ? " active" : "");

    item.textContent = s.label;

    item.addEventListener("click", () => {
      currentSection = s.id;

      renderNav();
      renderGrid();
    });

    nav.appendChild(item);
  }
}

function renderGrid() {
  grid.innerHTML = "";

  const section = SCHEMA.find((s) => s.id === currentSection);

  if (!section) return;

  const cfg = getDialogConfig();

  if (!cfg) {
    grid.innerHTML = '<div class="prop-empty">Configuration not found.</div>';
    return;
  }

  const wrap = document.createElement("div");

  wrap.className = "pgrid-section";

  const title = document.createElement("div");

  title.className = "pgrid-section-title";
  title.textContent = `${section.label} — ${dialogConfig} | ${dialogPlatform}`;

  wrap.appendChild(title);

  for (const field of section.fields) {
    const row = document.createElement("div");
    row.className = "pgrid-row";

    const label = document.createElement("label");
    label.textContent = field.label;

    row.appendChild(label);

    const value = cfg[section.id]?.[field.key];

    let input;

    if (field.type === "select") {
      input = document.createElement("select");

      for (const opt of field.options) {
        const option = document.createElement("option");

        option.value = opt;
        option.textContent = opt;

        if (opt === value) {
          option.selected = true;
        }

        input.appendChild(option);
      }
    } else if (field.type === "bool") {
      input = document.createElement("select");

      for (const v of ["false", "true"]) {
        const option = document.createElement("option");

        option.value = v;
        option.textContent = v;

        if (String(Boolean(value)) === v) {
          option.selected = true;
        }

        input.appendChild(option);
      }
    } else if (field.type === "list") {
      input = document.createElement("input");

      input.type = "text";

      input.value = Array.isArray(value) ? value.join(";") : value || "";

      input.placeholder = "semicolon-separated values";
    } else {
      input = document.createElement("input");

      input.type = "text";
      input.value = value ?? "";
    }

    input.addEventListener("change", () => {
      let v = input.value;

      if (field.type === "bool") {
        v = v === "true";
      } else if (field.type === "list") {
        v = v
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      setConfigValueFor(dialogConfig, dialogPlatform, section.id, field.key, v);
    });

    row.appendChild(input);
    wrap.appendChild(row);
  }

  grid.appendChild(wrap);
}
