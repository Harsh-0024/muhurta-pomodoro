// Tells the app this window is open, so it can quit once every window is
// closed (see presence.py). Silent: if the app is already gone, nothing shows.
(function () {
  "use strict";

  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const url = (event) => `/api/alive?page=${id}${event ? `&event=${event}` : ""}`;

  function checkIn() {
    fetch(url(), { method: "POST", keepalive: true }).catch(() => {});
  }

  checkIn();
  setInterval(checkIn, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkIn();
  });
  // Closing the window (or leaving for another page of the app) says goodbye.
  window.addEventListener("pagehide", () => {
    if (navigator.sendBeacon) navigator.sendBeacon(url("closed"));
  });
})();
