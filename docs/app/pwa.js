// The iPhone web app: what makes the website copy behave like an installed app.
//
// - The service worker (sw.js) keeps every file on the phone, so after the
//   first visit the app opens and works with no connection.
// - Updates: Settings > About and the update notice call update(); the new
//   version installs in the background and the page reloads into it.
// - Storage: asks Safari to keep the app's data (IndexedDB) for good.
// - In Safari itself (not yet on the Home Screen), a tip explains how to add
//   it there: that is what makes it open full screen, offline, like an app.
//
// Loaded first on every page of docs/app (mobile/build_web.py --iphone).
(function () {
  "use strict";

  const base = new URL(".", document.currentScript.src);
  const sw = navigator.serviceWorker;
  const standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  let registration = null;

  if (sw) {
    window.addEventListener("load", () => {
      sw.register(new URL("sw.js", base).href, { scope: base.pathname })
        .then((reg) => {
          registration = reg;
          // An app left open for days still hears about new versions.
          setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
        })
        .catch((err) => console.warn("offline copy unavailable", err));
    });
  }

  // Reload into the new version once its service worker has taken over (or
  // straight away if it already has: it installs by itself in the background).
  async function update() {
    if (!sw) return location.reload();
    const reg = registration || (await sw.getRegistration(base.pathname));
    if (!reg) return location.reload();
    let reloading = false;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    };
    sw.addEventListener("controllerchange", reload);
    try {
      await reg.update();
    } catch (_) {
      return; // offline: the notice stays and says so on the next check
    }
    if (!reg.installing && !reg.waiting) reload();
    // Safety net: a slow install still ends in the new version.
    setTimeout(reload, 20000);
  }

  window.__MUHURTA_PWA__ = { update, standalone };

  // Safari may clear a website's data after weeks unused; an app on the Home
  // Screen is kept. Ask to keep it either way (everything is in the account too).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ---------- the "Add to Home Screen" tip, in Safari only ---------- */

  const TIP_KEY = "muhurta-install-tip-dismissed";
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function tipDismissed() {
    try {
      return localStorage.getItem(TIP_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  // At the top of the page, in its flow: never over the timer's buttons.
  function showTip() {
    const main = document.querySelector("main");
    if (standalone || !isIos || tipDismissed() || !main) return;
    const tip = document.createElement("div");
    tip.className = "install-tip";
    tip.setAttribute("role", "note");
    tip.style.cssText = "display:flex;align-items:center;gap:0.75rem;margin:0 auto 1rem;max-width:34rem;padding:0.7rem 0.9rem;" +
      "border:1px solid var(--line);background:var(--surface);color:var(--muted);border-radius:0.9rem;font-size:0.85rem;line-height:1.4";
    const text = document.createElement("span");
    text.style.flex = "1";
    text.innerHTML = "Use it as an app, offline too: tap <strong>Share</strong> " +
      '<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.2em" aria-label="the Share button">' +
      '<path d="M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1"/></svg>' +
      " then <strong>Add to Home Screen</strong>.";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn btn-quiet btn-small";
    ok.textContent = "OK";
    ok.addEventListener("click", () => {
      try {
        localStorage.setItem(TIP_KEY, "1");
      } catch (_) {}
      tip.remove();
    });
    tip.append(text, ok);
    main.prepend(tip);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("is-web-app");
    if (standalone) document.body.classList.add("is-standalone");
    showTip();
  });
})();
