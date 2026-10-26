(function () {
  "use strict";

  let resolver = null;

  function close(value) {
    const modal = document.getElementById("confirmModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    if (resolver) {
      resolver(value);
      resolver = null;
    }
  }

  function confirmDialog({ title = "Are you sure?", message = "", accept = "Continue", cancel = "Cancel" } = {}) {
    const modal = document.getElementById("confirmModal");
    if (!modal) return Promise.resolve(window.confirm(message || title));
    if (resolver) close(false);

    const titleEl = document.getElementById("confirmTitle");
    const messageEl = document.getElementById("confirmMessage");
    const acceptBtn = document.getElementById("confirmAccept");
    const cancelBtn = document.getElementById("confirmCancel");

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (acceptBtn) acceptBtn.textContent = accept;
    if (cancelBtn) cancelBtn.textContent = cancel;

    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    cancelBtn?.focus();

    return new Promise((resolve) => {
      resolver = resolve;
    });
  }

  function wire() {
    const modal = document.getElementById("confirmModal");
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = "1";
    document.getElementById("confirmAccept")?.addEventListener("click", () => close(true));
    document.getElementById("confirmCancel")?.addEventListener("click", () => close(false));
    modal.querySelector(".modal-backdrop")?.addEventListener("click", () => close(false));
    document.addEventListener("keydown", (e) => {
      if (modal.classList.contains("hidden")) return;
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    });
  }

  document.addEventListener("DOMContentLoaded", wire);
  window.MuhurataDialog = { confirm: confirmDialog };
})();
