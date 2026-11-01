// When a page breaks, tell the app's admin (errors.py on a computer,
// local-api.js on a phone): the message, where in the code, and which page.
// Nothing about the person. Loaded first, so it hears the other scripts'
// errors too. A few per page at most; the same error once.
(function () {
  "use strict";

  const seen = new Set();
  let sent = 0;

  function report(message, detail) {
    message = String(message || "").trim();
    // "Script error." is a browser hiding another site's error: nothing to learn.
    if (!message || message === "Script error." || sent >= 5) return;
    const key = message + "|" + String(detail || "").split("\n")[0];
    if (seen.has(key)) return;
    seen.add(key);
    sent++;
    try {
      fetch("/api/error-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.slice(0, 500), detail: String(detail || "").slice(0, 4000), page: location.pathname }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  window.addEventListener("error", (ev) => {
    if (ev.target && ev.target !== window) return; // an image or file that didn't load
    report(ev.message, ev.error && ev.error.stack ? ev.error.stack : `${ev.filename || ""}:${ev.lineno || 0}:${ev.colno || 0}`);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    report(r && r.message ? r.message : String(r), r && r.stack);
  });
})();
