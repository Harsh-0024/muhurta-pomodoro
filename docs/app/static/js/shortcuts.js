(function () {
  "use strict";

  const SHORTCUTS = [
    { keys: "S", action: "Start or resume" },
    { keys: "Space", action: "Pause or resume (or rest, if waiting)" },
    { keys: "Shift + /", action: "Open this guide" },
    { keys: "R", action: "Reset" },
    { keys: "T", action: "Take rest from pool" },
    { keys: "K", action: "Skip remaining rest (during rest)" },
    { keys: "B", action: "Rest (during overtime)" },
    { keys: "3", action: "Skip (during overtime)" },
    { keys: "1 · 2 · 3", action: "Choose options when a dialog is open" },
    { keys: "⌘R · Ctrl+R · F5", action: "Refresh and sync with your account" },
  ];

  function isInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function renderList(container) {
    if (!container) return;
    container.innerHTML = SHORTCUTS.map(
      (s) =>
        `<li class="shortcut-row"><kbd class="shortcut-keys">${s.keys}</kbd><span class="shortcut-action">${s.action}</span></li>`
    ).join("");
  }

  function openModal() {
    const modal = document.getElementById("shortcutsModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    modal.querySelector(".modal-close")?.focus();
  }

  function closeModal() {
    const modal = document.getElementById("shortcutsModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function wireChord() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (isInput(e.target)) return;
        const isGuideShortcut = e.shiftKey && (e.key === "?" || e.key === "/" || e.code === "Slash");
        if (isGuideShortcut) {
          e.preventDefault();
          e.stopPropagation();
          openModal();
        }
      },
      true
    );
  }

  function wireModal() {
    const modal = document.getElementById("shortcutsModal");
    if (!modal) return;
    renderList(document.getElementById("shortcutsList"));
    modal.querySelector(".modal-backdrop")?.addEventListener("click", closeModal);
    modal.querySelector(".modal-close")?.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
    });
    document.getElementById("btnShowShortcuts")?.addEventListener("click", openModal);
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireModal();
    wireChord();
  });

  window.MuhuratShortcuts = { open: openModal, close: closeModal, list: SHORTCUTS };
})();
