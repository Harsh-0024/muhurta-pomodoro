// In the app's own window (macOS's web view or Windows' WebView2, not a
// browser) there are no web notifications, so hand them to the app, which
// shows them instead. In a browser this does nothing. Loaded before the other
// scripts, which read window.Notification.
(function () {
  "use strict";
  const mac = !!(window.webkit && window.webkit.messageHandlers);
  const windows = !!(window.chrome && window.chrome.webview);
  if (!mac && !windows) return; // a browser

  const api = () => window.pywebview && window.pywebview.api;

  function send(title, body) {
    try {
      api().notify(String(title), String(body || ""));
    } catch (_) {}
  }

  window.Notification = class {
    constructor(title, options) {
      send(title, options && options.body);
    }
    static get permission() {
      return "granted";
    }
    static requestPermission() {
      return Promise.resolve("granted");
    }
  };

  // Windows: the page's title (the time left) on the window and in the
  // taskbar, as a browser's window showed it. The Mac shows it in the menu bar.
  if (!windows) return;
  let sentTitle = null;

  function sendTitle() {
    const a = api();
    if (!a || typeof a.title !== "function" || document.title === sentTitle) return;
    sentTitle = document.title;
    try {
      a.title(sentTitle);
    } catch (_) {}
  }

  window.addEventListener("pywebviewready", sendTitle);
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.querySelector("title");
    if (el) new MutationObserver(sendTitle).observe(el, { childList: true, characterData: true, subtree: true });
    sendTitle();
  });
})();
