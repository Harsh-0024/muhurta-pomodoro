// Refresh = sync, on every device. ⌘R / Ctrl+R / F5 on a computer, or pulling
// the page down in the phone apps, first uploads what this device has and
// downloads what the others have; then every other device with the app open
// does the same (devices.py, mobile/web/devices.js), and the page reloads to
// show all of it. A small note says how it went, including which device
// could not sync because it is not connected to the internet. A device that
// is synced from elsewhere says so too, and reloads when nothing is in use.
(function () {
  "use strict";

  const WAIT_MS = 22000; // this device, the others (up to ~12 s), this one again
  const SHORT_MS = 1800;
  const LONG_MS = 6500; // a warning stays long enough to read
  const POLL_MS = 3000; // asking this app (not the network) whether another device synced it
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
      pill.setAttribute("aria-live", "polite");
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

  // {text, warn}: shown for a moment, or longer when it is a warning.
  function note(n) {
    show(n.text, n.warn ? "is-done is-long is-warn" : "is-done");
    hideTimer = setTimeout(hide, n.warn ? LONG_MS : SHORT_MS);
  }

  const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

  async function syncNow() {
    if (offline()) return "offline";
    return Promise.race([
      fetch("/api/cloud/sync-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ everywhere: true }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      new Promise((done) => setTimeout(() => done("slow"), WAIT_MS)),
    ]);
  }

  // "your Mac", "your Mac and your iPhone"; "the other device" when unnamed.
  function who(names) {
    const unique = [...new Set(names)];
    if (unique.length !== names.length || unique.includes("your other device")) {
      return names.length === 1 ? "the other device" : `${names.length} of your other devices`;
    }
    return unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
  }

  function outcome(st) {
    if (st === "offline") return { text: "No internet connection · this device can't sync right now", warn: true };
    if (st === "slow") return { text: "Still syncing in the background" };
    if (!st) return { text: "Couldn't sync just now", warn: true };
    if (!st.signed_in || !st.sync) return { text: "Refreshed" };
    if (st.sync.error === "offline") return { text: "No internet connection · this device can't sync right now", warn: true };
    if (st.sync.error) return { text: "Couldn't sync just now", warn: true };
    const d = st.devices;
    if (!d) return { text: "Synced" };
    if (d.missing && d.missing.length) {
      const verb = d.missing.length === 1 ? "is" : "are";
      return { text: `Refresh started but could not happen because ${who(d.missing)} ${verb} not connected to the internet.`, warn: true };
    }
    if (d.unreachable) return { text: "Synced here · couldn't reach your other devices just now", warn: true };
    if (d.slow && d.slow.length) return { text: `Synced · ${who(d.slow)} still syncing` };
    if (d.synced && d.synced.length) return { text: "Synced on all your devices" };
    return { text: "Synced" };
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    show(offline() ? "Refreshing…" : "Syncing your devices…", "is-syncing");
    const st = await syncNow();
    try {
      sessionStorage.setItem(DONE_KEY, JSON.stringify(outcome(st)));
    } catch (_) {}
    window.location.reload();
  }

  function stored() {
    try {
      const raw = sessionStorage.getItem(DONE_KEY);
      sessionStorage.removeItem(DONE_KEY);
      if (!raw) return null;
      try {
        const n = JSON.parse(raw);
        if (n && typeof n.text === "string") return n;
      } catch (_) {}
      return { text: raw }; // written by an older version
    } catch (_) {
      return null;
    }
  }

  // After our own reload: say how it went. After the browser's own reload
  // button (which no page can catch first): sync everywhere now, and say so
  // when something went wrong.
  function afterLoad() {
    const done = stored();
    if (done) {
      note(done);
      return;
    }
    const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (nav && nav.type === "reload") {
      syncNow().then((st) => {
        const n = outcome(st);
        if (n.warn) note(n);
      });
    }
  }

  // Another device was refreshed and synced this one: say so, and reload to
  // show it unless something here is in use (typing, a dialog open).
  function inUse() {
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return true;
    if (document.body.classList.contains("modal-open")) return true;
    return !!document.querySelector("dialog[open]");
  }

  function watchRemote() {
    let last = null;
    let shown = 0;
    async function poll() {
      if (document.visibilityState === "hidden" || busy) return;
      let r;
      try {
        const res = await fetch("/api/cloud/remote-sync");
        if (!res.ok) return;
        r = await res.json();
      } catch (_) {
        return;
      }
      if (!r || !r.seq) return;
      if (last === null) {
        last = r.done ? r.seq : 0; // already over before this page opened
        if (r.done) return;
      }
      if (r.seq === last) return;
      if (!r.done) {
        if (shown !== r.seq) show(`Syncing · refreshed from ${r.from}`, "is-syncing");
        shown = r.seq;
        return;
      }
      last = r.seq;
      const n = r.ok ? { text: `Synced · refreshed from ${r.from}` } : { text: "Couldn't sync just now", warn: true };
      if (r.ok && !inUse()) {
        try {
          sessionStorage.setItem(DONE_KEY, JSON.stringify(n));
        } catch (_) {}
        window.location.reload();
        return;
      }
      note(r.ok ? { text: `Synced from ${r.from} · refresh to see it` } : n);
    }
    setInterval(poll, POLL_MS);
    poll();
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
  watchRemote();
})();
