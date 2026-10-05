// shortcuts.js — global keyboard bindings

export function initShortcuts(dispatch) {
  document.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const cmdKey = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();

    // Command palette
    if (cmdKey && e.shiftKey && key === "p") {
      e.preventDefault();
      dispatch("cmd-palette");
      return;
    }
    if (e.key === "F1") {
      e.preventDefault();
      dispatch("cmd-palette");
      return;
    }

    // Quick open
    if (cmdKey && !e.shiftKey && key === "p") {
      e.preventDefault();
      dispatch("quick-open");
      return;
    }

    // Save
    if (cmdKey && e.shiftKey && key === "s") {
      e.preventDefault();
      dispatch("save-all");
      return;
    }
    if (cmdKey && !e.shiftKey && key === "s") {
      e.preventDefault();
      dispatch("save");
      return;
    }

    // Build
    if (cmdKey && e.shiftKey && key === "b") {
      e.preventDefault();
      dispatch("build");
      return;
    }

    // Toggle sidebar
    if (cmdKey && !e.shiftKey && key === "b") {
      e.preventDefault();
      dispatch("toggle-sidebar");
      return;
    }

    // Toggle panel
    if (cmdKey && !e.shiftKey && key === "j") {
      e.preventDefault();
      dispatch("toggle-panel");
      return;
    }

    // Toggle terminal
    if (cmdKey && e.key === "`") {
      e.preventDefault();
      dispatch("terminal");
      return;
    }

    // View switches
    if (cmdKey && e.shiftKey && key === "e") {
      e.preventDefault();
      dispatch("view-explorer");
      return;
    }
    if (cmdKey && e.shiftKey && key === "f") {
      e.preventDefault();
      dispatch("view-search");
      return;
    }
    if (cmdKey && e.shiftKey && key === "g") {
      e.preventDefault();
      dispatch("view-source");
      return;
    }
    if (cmdKey && e.shiftKey && key === "x") {
      e.preventDefault();
      dispatch("view-extensions");
      return;
    }

    // Find / Replace
    if (cmdKey && !e.shiftKey && key === "f") {
      e.preventDefault();
      dispatch("find");
      return;
    }
    if (cmdKey && !e.shiftKey && key === "h") {
      e.preventDefault();
      dispatch("replace");
      return;
    }

    // Format
    if (e.shiftKey && e.altKey && key === "f") {
      e.preventDefault();
      dispatch("format-document");
      return;
    }

    // Word wrap
    if (e.altKey && !e.shiftKey && key === "z") {
      e.preventDefault();
      dispatch("toggle-wordwrap");
      return;
    }

    // New / open
    if (cmdKey && e.shiftKey && key === "n") {
      e.preventDefault();
      dispatch("new-project");
      return;
    }
    if (cmdKey && !e.shiftKey && key === "o") {
      e.preventDefault();
      dispatch("open-project");
      return;
    }

    // Run
    if (e.key === "F5") {
      e.preventDefault();
      dispatch("run");
      return;
    }

    // Project properties
    if (e.altKey && e.key === "Enter") {
      e.preventDefault();
      dispatch("project-properties");
      return;
    }
  });
}
