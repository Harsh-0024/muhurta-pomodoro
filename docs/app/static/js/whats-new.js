// After an update, a card shows once what is new for this device since the
// version it had before (release_notes.py). No version numbers: one version's
// lines as they are; several skipped versions, one short summary written by
// the summary server (supabase/functions/whats-new), asked for while the
// update downloaded (update-check.js) or now, else this device's lines.
// Closing it marks it as seen.
(function () {
  "use strict";

  const KEPT_KEY = "muhurta-whats-new-summary";
  const ASK_TIMEOUT_MS = 6000;

  // One short summary of everything new for `device` from `from` to `to`.
  // Plain text body: no extra round trip before the request (CORS).
  async function ask(url, from, to, device) {
    if (!url || !from || !to || !device) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ASK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST", body: JSON.stringify({ from, to, device }),
        headers: { "Content-Type": "text/plain" }, signal: ctl.signal,
      });
      const data = res.ok ? await res.json() : null;
      const lines = data && Array.isArray(data.lines) ? data.lines.filter((l) => typeof l === "string" && l.trim()) : [];
      return lines.length ? lines : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const keyFor = (from, to, device) => `${from}>${to}:${device}`;

  // Asked as an update starts, so the card has it as soon as the app reopens.
  async function prefetch(from, to, device, url) {
    const lines = await ask(url, from, to, device);
    if (!lines) return;
    try {
      localStorage.setItem(KEPT_KEY, JSON.stringify({ key: keyFor(from, to, device), lines }));
    } catch (_) {}
  }

  async function summaryFor(d) {
    if (!d.several) return null;
    try {
      const kept = JSON.parse(localStorage.getItem(KEPT_KEY) || "null");
      if (kept && kept.key === keyFor(d.from, d.current, d.device) && Array.isArray(kept.lines) && kept.lines.length) {
        return kept.lines;
      }
    } catch (_) {}
    return ask(d.summary_url, d.from, d.current, d.device);
  }

  window.MuhurtaWhatsNew = { prefetch };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function show(data) {
    const modal = el("div", "modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-labelledby", "whatsNewTitle");
    const backdrop = el("div", "modal-backdrop");
    const sheet = el("div", "modal-sheet whats-new-sheet");
    const title = el("h2", "modal-title", "What's new");
    title.id = "whatsNewTitle";
    sheet.append(el("p", "modal-kicker", "Updated"), title);

    // The notes scroll inside the card; the title and button stay in view.
    const body = el("div", "whats-new-body");
    body.tabIndex = 0; // arrow keys and Page Down scroll it too
    const list = el("ul", "whats-new-list");
    data.shown.forEach((line) => list.append(el("li", null, line)));
    body.append(list);
    sheet.append(body);

    const actions = el("div", "modal-actions");
    const ok = el("button", "btn btn-primary", "Got it");
    ok.type = "button";
    if (data.get_app_url) {
      // Running the Terminal install on a Mac: point the way to the app.
      body.append(
        el("p", "modal-copy whats-new-switch",
          "You installed with the Terminal. Switch to the app whenever you like: it uses " +
          "the same history on this computer, so nothing is lost."));
      ok.className = "btn btn-quiet";
      const get = el("a", "btn btn-primary", "Get the Mac app");
      get.href = data.get_app_url;
      get.target = "_blank";
      get.rel = "noopener";
      actions.append(ok, get);
    } else {
      actions.append(ok);
    }
    sheet.append(actions);
    modal.append(backdrop, sheet);

    const close = () => {
      modal.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      removeEventListener("resize", markMore);
      fetch("/api/whats-new/seen", { method: "POST" }).catch(() => {});
    };
    const onKey = (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && e.target !== body)) close();
    };
    // Show the fade only while there is more below.
    const markMore = () => body.classList.toggle("more", body.scrollTop + body.clientHeight < body.scrollHeight - 4);
    body.addEventListener("scroll", markMore, { passive: true });
    addEventListener("resize", markMore);
    ok.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(modal);
    document.body.classList.add("modal-open");
    markMore();
    ok.focus();
  }

  fetch("/api/whats-new", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d || !Array.isArray(d.lines) || !d.lines.length) return;
      return summaryFor(d).then((summary) => {
        try {
          localStorage.removeItem(KEPT_KEY);
        } catch (_) {}
        show({ ...d, shown: summary || d.lines.map((l) => l.text) });
      });
    })
    .catch(() => {});
})();
