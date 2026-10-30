// Refresh = sync. ⌘R / Ctrl+R / F5 on a computer, or pulling the page down in
// the phone apps, first uploads what this device has and downloads what the
// others have, then reloads the page so it shows all of it.
(function () {
  "use strict";

  const WAIT_MS = 8000; // slow or no connection: reload anyway, sync carries on in the background
  const PULL_READY = 64; // how far (px, after damping) the page has to be pulled
  const PULL_MAX = 96;
  const DONE_KEY = "muhurta-refresh-synced";

  let pill = null;
  let busy = false;
  let hideTimer = 0;

  function el() {
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "refresh-sync";
      pill.setAttribute("role", "status");
      pill.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg><span></span>';
      document.body.appendChild(pill);
    }
    return pill;
  }

  function show(text, state) {
    const p = el();
    clearTimeout(hideTimer);
    p.className = `refresh-sync is-visible ${state || ""}`;
    p.style.opacity = "";
    p.style.transform = "";
    p.querySelector("svg").style.transform = "";
    p.querySelector("span").textContent = text;
  }

  function hide() {
    if (!pill) return;
    pill.className = "refresh-sync";
    pill.style.opacity = "";
    pill.style.transform = "";
  }

  async function syncNow() {
    return Promise.race([
      fetch("/api/cloud/sync-now", { method: "POST" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      new Promise((done) => setTimeout(() => done("slow"), WAIT_MS)),
    ]);
  }

  function outcome(st) {
    if (st === "slow") return "Still syncing in the background";
    if (!st) return "Couldn't sync just now";
    if (!st.signed_in || !st.sync) return "Refreshed";
    if (st.sync.error === "offline") return "Offline · showing this device's data";
    if (st.sync.error) return "Couldn't sync just now";
    return "Synced";
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    show("Syncing…", "is-syncing");
    const st = await syncNow();
    try {
      sessionStorage.setItem(DONE_KEY, outcome(st));
    } catch (_) {}
    window.location.reload();
  }

  // After our own reload: say how it went. After the browser's own reload
  // button (which no page can catch first): sync quietly now.
  function afterLoad() {
    let done = null;
    try {
      done = sessionStorage.getItem(DONE_KEY);
      sessionStorage.removeItem(DONE_KEY);
    } catch (_) {}
    if (done) {
      show(done, "is-done");
      hideTimer = setTimeout(hide, 1800);
      return;
    }
    const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (nav && nav.type === "reload") syncNow();
  }

  function wireKeys() {
    window.addEventListener(
      "keydown",
      (e) => {
        const cmdR = (e.metaKey || e.ctrlKey) && !e.altKey && (e.key || "").toLowerCase() === "r";
        if (!cmdR && e.key !== "F5") return;
        e.preventDefault();
        e.stopImmediatePropagation(); // never the timer's own "R" (Reset)
        refresh();
      },
      true
    );
  }

  // Only inside the phone apps: a browser tab already has its own pull to
  // refresh, which ends in afterLoad() above.
  function inPhoneApp() {
    if (!document.body.classList.contains("is-mobile")) return false;
    const native = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    return !!native || navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  }

  function scrolledInside(node) {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      if (n.scrollTop > 0) return true;
    }
    return false;
  }

  function wirePull() {
    let tracking = false;
    let pulling = false;
    let startX = 0;
    let startY = 0;
    let dist = 0;

    function draw() {
      const p = el();
      const ready = dist >= PULL_READY;
      p.className = `refresh-sync is-pulling${ready ? " is-ready" : ""}`;
      p.style.opacity = String(Math.min(1, dist / PULL_READY));
      p.style.transform = `translate(-50%, ${Math.round(dist * 0.6 - 24)}px)`;
      p.querySelector("svg").style.transform = `rotate(${Math.round(dist * 4)}deg)`;
      p.querySelector("span").textContent = ready ? "Release to sync" : "Pull to sync";
    }

    function end(e) {
      if (pulling) {
        if (e.type === "touchend" && dist >= PULL_READY) refresh();
        else hide();
      }
      tracking = pulling = false;
      dist = 0;
    }

    document.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        tracking =
          !busy &&
          e.touches.length === 1 &&
          window.scrollY <= 0 &&
          !document.body.classList.contains("modal-open") &&
          !scrolledInside(e.target) &&
          !(e.target.closest && e.target.closest('input[type="range"]'));
        pulling = false;
        startX = t.clientX;
        startY = t.clientY;
      },
      { passive: true }
    );

    document.addEventListener(
      "touchmove",
      (e) => {
        if (!tracking) return;
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (!pulling) {
          if (dy <= 0 || Math.abs(dx) > dy) {
            tracking = false; // scrolling up, or sideways (sliders, the year grid)
            return;
          }
          if (dy < 8) return;
          pulling = true;
        }
        if (e.cancelable) e.preventDefault(); // no rubber-band bounce while pulling
        dist = Math.max(0, Math.min(PULL_MAX, (dy - 8) * 0.55));
        draw();
      },
      { passive: false }
    );

    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", end, { passive: true });
  }

  window.__MUHURTA_REFRESH__ = refresh;
  wireKeys();
  if (inPhoneApp()) wirePull();
  afterLoad();
})();
