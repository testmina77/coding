// layout.js — panel resizers, activity bar, sidebar sections, status bar toggles

import { loadSetting, saveSetting } from "./persistence.js";

const state = {
  sidebarWidth: 260,
  panelHeight: 220,
  propertiesWidth: 280,
  sidebarVisible: true,
  panelVisible: true,
  propertiesVisible: true,
  activeView: "explorer",
};

export function initLayout() {
  state.sidebarWidth = loadSetting("layout.sidebarWidth", 260);
  state.panelHeight = loadSetting("layout.panelHeight", 220);
  state.propertiesWidth = loadSetting("layout.propertiesWidth", 280);
  state.sidebarVisible = loadSetting("layout.sidebarVisible", true);
  state.panelVisible = loadSetting("layout.panelVisible", true);
  state.propertiesVisible = loadSetting("layout.propertiesVisible", true);
  state.activeView = loadSetting("layout.activeView", "explorer");

  applyLayout();
  wireResizers();
  wireActivityBar();
  wireSectionCollapse();
  wirePanelTabs();
  wireStatusToggles();
}

function applyLayout() {
  const sidebar = document.getElementById("sidebar");
  const props = document.getElementById("properties-panel");
  const panel = document.getElementById("panel");

  sidebar.style.width = state.sidebarWidth + "px";
  props.style.width = state.propertiesWidth + "px";
  panel.style.height = state.panelHeight + "px";

  sidebar.style.display = state.sidebarVisible ? "" : "none";
  props.style.display = state.propertiesVisible ? "" : "none";
  panel.style.display = state.panelVisible ? "" : "none";

  setActiveView(state.activeView);
}

function wireResizers() {
  document.querySelectorAll(".resizer-v, .resizer-h").forEach((rz) => {
    rz.addEventListener("mousedown", (e) => {
      e.preventDefault();
      rz.classList.add("dragging");
      const isV = rz.classList.contains("resizer-v");
      const target = rz.dataset.resize;
      const startPos = isV ? e.clientX : e.clientY;

      let startSize;
      if (target === "sidebar") startSize = state.sidebarWidth;
      else if (target === "properties") startSize = state.propertiesWidth;
      else if (target === "panel") startSize = state.panelHeight;

      const onMove = (ev) => {
        const delta = (isV ? ev.clientX : ev.clientY) - startPos;
        if (target === "sidebar") {
          state.sidebarWidth = Math.max(150, Math.min(600, startSize + delta));
          document.getElementById("sidebar").style.width =
            state.sidebarWidth + "px";
        } else if (target === "properties") {
          state.propertiesWidth = Math.max(
            150,
            Math.min(600, startSize - delta),
          );
          document.getElementById("properties-panel").style.width =
            state.propertiesWidth + "px";
        } else if (target === "panel") {
          state.panelHeight = Math.max(
            80,
            Math.min(window.innerHeight - 200, startSize - delta),
          );
          document.getElementById("panel").style.height =
            state.panelHeight + "px";
        }
      };
      const onUp = () => {
        rz.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        saveSetting("layout.sidebarWidth", state.sidebarWidth);
        saveSetting("layout.panelHeight", state.panelHeight);
        saveSetting("layout.propertiesWidth", state.propertiesWidth);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

function wireActivityBar() {
  document.querySelectorAll(".ab-item").forEach((item) => {
    item.addEventListener("click", () => {
      const view = item.dataset.view;
      if (view === "settings") {
        import("./command-palette.js").then((m) => m.openPalette());
        return;
      }
      if (state.activeView === view && state.sidebarVisible) {
        state.sidebarVisible = false;
      } else {
        state.activeView = view;
        state.sidebarVisible = true;
      }
      saveSetting("layout.activeView", state.activeView);
      saveSetting("layout.sidebarVisible", state.sidebarVisible);
      applyLayout();
    });
  });
}

export function setActiveView(view) {
  state.activeView = view;
  document.querySelectorAll(".ab-item").forEach((i) => {
    i.classList.toggle("active", i.dataset.view === view);
  });
  document.querySelectorAll(".sidebar-view").forEach((v) => {
    v.classList.toggle("hidden", v.id !== "view-" + view);
  });

  const titles = {
    explorer: "EXPLORER",
    search: "SEARCH",
    source: "SOURCE CONTROL",
    run: "RUN AND DEBUG",
    extensions: "EXTENSIONS",
  };
  const titleEl = document.getElementById("sidebar-title");
  if (titleEl) titleEl.textContent = titles[view] || view.toUpperCase();

  if (view === "search") {
    setTimeout(() => document.getElementById("search-input")?.focus(), 50);
  }
}

function wireSectionCollapse() {
  document.querySelectorAll(".section-header").forEach((h) => {
    h.addEventListener("click", () => {
      h.classList.toggle("collapsed");
    });
  });
}

function wirePanelTabs() {
  document.querySelectorAll(".panel-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.panel;
      document
        .querySelectorAll(".panel-tab")
        .forEach((t) => t.classList.toggle("active", t === tab));
      document
        .querySelectorAll(".panel-view")
        .forEach((v) => v.classList.toggle("active", v.dataset.panel === name));
      const filter = document.getElementById("output-filter");
      if (filter) filter.style.display = name === "output" ? "" : "none";
      if (name === "terminal") {
        import("./terminal.js").then((m) => m.focusTerminal());
      }
    });
  });

  document.getElementById("panel-close")?.addEventListener("click", () => {
    togglePanel();
  });
}

function wireStatusToggles() {
  document
    .getElementById("sb-minimap")
    ?.addEventListener("click", () =>
      import("./editor.js").then((m) => m.toggleMinimap()),
    );
  document
    .getElementById("sb-wordwrap")
    ?.addEventListener("click", () =>
      import("./editor.js").then((m) => m.toggleWordWrap()),
    );
}

export function toggleSidebar() {
  state.sidebarVisible = !state.sidebarVisible;
  saveSetting("layout.sidebarVisible", state.sidebarVisible);
  applyLayout();
}

export function togglePanel() {
  state.panelVisible = !state.panelVisible;
  saveSetting("layout.panelVisible", state.panelVisible);
  applyLayout();
}

export function toggleProperties() {
  state.propertiesVisible = !state.propertiesVisible;
  saveSetting("layout.propertiesVisible", state.propertiesVisible);
  applyLayout();
}

export function showPanel(name) {
  state.panelVisible = true;
  applyLayout();
  document.querySelector(`.panel-tab[data-panel="${name}"]`)?.click();
}

export function getLayoutState() {
  return state;
}
