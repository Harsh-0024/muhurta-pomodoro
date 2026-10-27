// The iPhone web app's service worker: keeps every file of the app on the
// phone, so it opens and works with no connection. Only signing in, syncing
// and the update check (version.json) use the network. It also shows the
// end-of-block notifications that arrive by push (web-alerts.js).
//
// mobile/build_web.py --iphone fills in CACHE (changes with any file) and
// FILES (everything in docs/app). A new build installs as a whole next to the
// old one, takes over, and the old copy is removed.
"use strict";

const CACHE = "muhurta-1.16.1-56b577263e";
const FILES = ["./", "account.js", "dashboard.html", "flow.html", "fonts/CormorantGaramond-latin-905594f5.woff2", "fonts/CormorantGaramond-latin-ac5feb95.woff2", "fonts/CormorantGaramond-latin-ext-48072044.woff2", "fonts/CormorantGaramond-latin-ext-7604886f.woff2", "fonts/DMSans-latin-446a7271.woff2", "fonts/DMSans-latin-ext-3a3015d5.woff2", "fonts/DMSans-latin-ext-a18ee4a6.woff2", "fonts/DMSans-latin-fc88c230.woff2", "fonts/fonts.css", "history.html", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "index.html", "local-api.js", "manifest.webmanifest", "mobile-data.js", "pwa.js", "settings.html", "sign-in.html", "static/audio/opening-bells.mp3", "static/audio/soothing-church-bell.mp3", "static/css/app.css", "static/css/mobile.css", "static/js/admin.js", "static/js/alive.js", "static/js/app.js", "static/js/dashboard.js", "static/js/dialog.js", "static/js/feedback.js", "static/js/flow.js", "static/js/history.js", "static/js/menubar.js", "static/js/mobile.js", "static/js/native.js", "static/js/one-clock.js", "static/js/quick-lengths.js", "static/js/quotes.js", "static/js/session-monitor.js", "static/js/settings.js", "static/js/shortcuts.js", "static/js/sign-in.js", "static/js/sounds.js", "static/js/timer-core.js", "static/js/timer.js", "static/js/update-check.js", "static/js/whats-new.js", "timer.html", "web-alerts.js"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // "reload": straight from the website, not an older copy the browser kept.
    await cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE && name.startsWith("muhurta-")) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

const scope = new URL(self.registration.scope);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  // Which version the website has now: always asked fresh.
  if (url.pathname === scope.pathname + "version.json") {
    event.respondWith(fetch(req, { cache: "no-store" }).catch(() => Response.json({ error: "offline" }, { status: 503 })));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Pages and files carry ?v=<version>; the copy kept here is the same file.
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      // Offline, and an address the app does not have: open the app instead.
      if (req.mode === "navigate") {
        const home = await cache.match("./");
        if (home) return home;
      }
      throw err;
    }
  })());
});

// The end of a block, sent by the push function (supabase/functions/push)
// while the app was closed: shown even with the phone locked.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {}
  event.waitUntil((async () => {
    // The block has ended: the quiet "until 9:32" note (web-alerts.js) goes.
    if (data.tag === "muhurta-block-end") {
      (await self.registration.getNotifications({ tag: "muhurta-running" })).forEach((n) => n.close());
    }
    await self.registration.showNotification(String(data.title || "Muhurta Pomodoro"), {
      body: String(data.body || ""),
      tag: String(data.tag || "muhurta"),
      icon: "icons/icon-192.png",
      renotify: true,
    });
  })());
});

// A tap on a notification brings the app forward.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (open.length) return open[0].focus();
    return self.clients.openWindow(scope.href);
  })());
});
