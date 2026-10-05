// contextmenu.js — reusable context menu (VS Code style)

let currentMenu = null;

export function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = x + "px";
  menu.style.top = y + "px";

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement("div");
    el.className = "ctx-item" + (item.disabled ? " disabled" : "");
    const label = document.createElement("span");
    label.textContent = item.label;
    el.appendChild(label);
    if (item.shortcut) {
      const s = document.createElement("span");
      s.className = "ctx-shortcut";
      s.textContent = item.shortcut;
      el.appendChild(s);
    }
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      hideContextMenu();
      if (!item.disabled && item.action) item.action();
    });
    menu.appendChild(el);
  }

  document.body.appendChild(menu);
  currentMenu = menu;

  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = x - r.width + "px";
  if (r.bottom > window.innerHeight) menu.style.top = y - r.height + "px";
}

export function hideContextMenu() {
  if (currentMenu) {
    currentMenu.remove();
    currentMenu = null;
  }
}

document.addEventListener("click", hideContextMenu);
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".ctx-menu")) hideContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideContextMenu();
});
