// The iPhone web app's service worker: keeps every file of the app on the
// phone, so it opens and works with no connection. Only signing in, syncing
// and the update check (version.json) use the network. It also shows the
// end-of-block notifications that arrive by push (web-alerts.js).
//
// mobile/build_web.py --iphone fills in CACHE (changes with any file) and
// FILES (everything in docs/app). A new build installs as a whole next to the
// old one, takes over, and the old copy is removed.
"use strict";

const CACHE = __CACHE__;
const FILES = __FILES__;

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
  event.waitUntil(self.registration.showNotification(String(data.title || "Muhurta Pomodoro"), {
    body: String(data.body || ""),
    tag: String(data.tag || "muhurta"),
    icon: "icons/icon-192.png",
    renotify: true,
  }));
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
