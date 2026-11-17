// Keyboard focus for every pop-up (.modal): Tab and Shift+Tab stay inside the open one, and
// when it closes, focus goes back to what was focused before it opened instead of being lost
// (which sent the next Tab to the top of the page). Works for pop-ups shown with .hidden and
// for ones added and removed (What's new), since all of them set body.modal-open while open.
(function () {
  "use strict";

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const openModal = () => [...document.querySelectorAll(".modal:not(.hidden)")].filter(visible).pop() || null;

  // The last thing focused outside any pop-up: where focus returns when one closes.
  let lastOutside = null;
  document.addEventListener("focusin", (e) => {
    if (!e.target.closest?.(".modal")) lastOutside = e.target;
  });

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Tab") return;
      const modal = openModal();
      if (!modal) return;
      const items = [...modal.querySelectorAll(FOCUSABLE)].filter(visible);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = modal.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    },
    true
  );

  function restore() {
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || (active.closest(".modal") && !visible(active));
    if (!lost || !lastOutside || !lastOutside.isConnected || !visible(lastOutside)) return;
    lastOutside.focus({ preventScroll: true });
  }

  let wasOpen = document.body.classList.contains("modal-open");
  new MutationObserver(() => {
    const open = document.body.classList.contains("modal-open");
    // After the closing code has run (it may move focus itself): only step in if focus was lost.
    if (wasOpen && !open) setTimeout(restore, 0);
    wasOpen = open;
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // A button switched off while it works ("Sending…", "Saving…") drops keyboard focus to the
  // top of the page. When it's switched back on, focus returns to it, unless something else
  // has taken focus in the meantime.
  // (Browsers don't send a focus event when that happens, so this watches the switch itself.)
  let lastFocus = null;
  let parked = null;
  document.addEventListener("focusin", (e) => {
    lastFocus = e.target;
    parked = null;
  });
  new MutationObserver((changes) => {
    for (const { target: el } of changes) {
      if (!(el instanceof HTMLButtonElement)) continue;
      const lost = !document.activeElement || document.activeElement === document.body;
      if (el.disabled) {
        if (document.activeElement === el || (lastFocus === el && lost)) parked = el;
      } else if (parked === el) {
        parked = null;
        if (lost && el.isConnected && visible(el)) el.focus({ preventScroll: true });
      }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
})();
