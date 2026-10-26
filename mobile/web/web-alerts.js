// iPhone web app alerts (alerts.js is the Android app's).
//
// iOS stops a web app as soon as it leaves the screen, so the timer cannot
// ring then. Instead, as the app leaves the screen with a block running, the
// end of that block is booked with the push function (supabase/functions/push);
// at that time it sends a Web Push through Apple, which shows the notification
// and plays the alert sound even with the phone locked. Coming back to the app
// cancels the booking, and the timer rings itself as usual. The timer saves its
// state to localStorage on every change; that is what is read here, so the
// timer's own code stays the same as on the computer.
//
// Push needs iOS 16.4+, the app added to the Home Screen, and permission. Until
// then (or if the push function is not set up), the screen is kept on while a
// clock counts down so that the bell can ring. Locking the phone is still fine:
// the clocks run on timestamps and catch up on return.
//
// Also: window.Notification for the Settings section (permission, the test).
(function () {
  "use strict";

  const L = window.__MUHURTA_LOCAL__;
  const D = window.__MUHURTA__;
  if (!L || !D) return;
  const PUSH_URL = D.push_url;
  const pwa = window.__MUHURTA_PWA__;
  const Real = window.Notification;

  // Rhythm's saved session is still called "timer"; the simple Timer's is "countdown".
  const TIMER_KEY = "muhurat_timer_session_v1";
  const COUNTDOWN_KEY = "muhurat_countdown_session_v1";
  const FLOW_KEY = "muhurat_flow_session_v1";
  // The push function's public key, once seen: also says the function is there.
  const KEY_KEY = "muhurta-push-key";
  const SUB_KEY_KEY = "muhurta-push-subscribed-key";
  const ENDS = {
    work: { title: "Focus complete", body: "Time for a rest." },
    rest: { title: "Rest complete", body: "Ready to focus again?" },
    cumulative: { title: "Pool rest complete", body: "Resume focus when ready." },
    countdown: { title: "Time's up", body: "Your timer is done." },
  };

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch (_) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (_) {}
    },
  };

  function saved(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }

  // The end of whichever clock is counting down (only one runs at a time).
  function nextEnd() {
    const rhythm = saved(TIMER_KEY);
    if (rhythm && rhythm.running && ENDS[rhythm.mode] && rhythm.phaseEndsAt) {
      return { at: Number(rhythm.phaseEndsAt), ...ENDS[rhythm.mode] };
    }
    const countdown = saved(COUNTDOWN_KEY);
    if (countdown && countdown.mode === "running" && countdown.endsAt) {
      return { at: Number(countdown.endsAt), ...ENDS.countdown };
    }
    return null;
  }

  /* ---------- push: what this phone can do ---------- */

  // Only the Home Screen app can receive pushes on an iPhone.
  const pushDevice = Boolean(PUSH_URL && pwa && pwa.standalone && Real && "PushManager" in window && navigator.serviceWorker);
  let subscription = null; // PushSubscription.toJSON(), once subscribed

  // Settings shows its Notifications section only where they can work.
  L.notifications = pushDevice && Boolean(store.get(KEY_KEY));
  if (!pushDevice) {
    // A Safari tab or an older iPhone: nothing would ever arrive, so don't ask.
    try {
      delete window.Notification;
    } catch (_) {}
  }

  const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

  // The function's key, fresh when online (and a sign it is set up).
  async function pushKey() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(PUSH_URL, { cache: "no-store", signal: ctl.signal });
      clearTimeout(t);
      const key = res.ok ? String((await res.json()).publicKey || "") : "";
      if (key) store.set(KEY_KEY, key);
      return key || store.get(KEY_KEY);
    } catch (_) {
      return store.get(KEY_KEY);
    }
  }

  async function subscribe() {
    if (!pushDevice || Real.permission !== "granted") return null;
    const key = await pushKey();
    if (!key) return null;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // New keys on the server: the old subscription can no longer be used.
    if (sub && store.get(SUB_KEY_KEY) !== key) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      store.set(SUB_KEY_KEY, key);
    }
    subscription = sub.toJSON();
    keepAwake();
    return subscription;
  }

  // Sent so that it still goes out as the app leaves the screen: a beacon,
  // text/plain (no CORS preflight), no sign-in.
  function post(payload) {
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(PUSH_URL, new Blob([body], { type: "text/plain" }))) return;
    } catch (_) {}
    fetch(PUSH_URL, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
  }

  /* ---------- booking the end of the running block ---------- */

  const pushOn = () => Boolean(subscription && L.internals.loadSettings().notifications_enabled && Real.permission === "granted");
  let booked = null; // "at|title" of what the function holds now

  function wanted() {
    const end = nextEnd();
    if (!end || !(end.at > Date.now() + 1500) || !pushOn()) return null;
    return end;
  }

  function book() {
    const w = wanted();
    if (!w) return cancel();
    const key = `${Math.round(w.at / 1000)}|${w.title}`;
    if (booked === key) return;
    post({ action: "book", subscription, at: w.at, title: w.title, body: w.body });
    booked = key;
  }

  function cancel(always) {
    if (!subscription || (!booked && !always)) return;
    booked = null;
    post({ action: "cancel", endpoint: subscription.endpoint });
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") {
      book();
      showRunning();
    } else {
      cancel();
      tidyRunning();
    }
    keepAwake();
  }

  /* ---------- what is running, in Notification Center ---------- */

  // Like the Mac app's menu bar, as far as an iPhone web app can go: iOS can't
  // tick a clock in a notification for it, so as the app leaves the screen
  // with a clock running, it posts one quiet note saying until when ("Focus ·
  // Rhythm, until 9:32 AM"). The end-of-block push takes its place (sw.js);
  // pausing or stopping takes it away. Posted once per block, not every time
  // the app is left.
  const RUNNING_TAG = "muhurta-running";
  const SHOWN_KEY = "muhurta-running-shown";
  const PHASES = { work: "Focus", rest: "Rest", cumulative: "Pool rest" };
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function runningNote() {
    const rhythm = saved(TIMER_KEY);
    if (rhythm && rhythm.running) {
      if (PHASES[rhythm.mode] && rhythm.phaseEndsAt > Date.now()) {
        return { key: `r${rhythm.phaseEndsAt}`, title: `${PHASES[rhythm.mode]} · Rhythm`, body: `Until ${clock(rhythm.phaseEndsAt)}` };
      }
      const s = rhythm.session || {};
      if (rhythm.mode === "extend" && s.segStartedAt) {
        return { key: `e${s.segStartedAt}`, title: "Extra focus · Rhythm", body: `Since ${clock(s.segStartedAt)}` };
      }
    }
    const countdown = saved(COUNTDOWN_KEY);
    if (countdown && countdown.mode === "running" && countdown.endsAt > Date.now()) {
      return { key: `c${countdown.endsAt}`, title: "Timer", body: `Until ${clock(countdown.endsAt)}` };
    }
    if (countdown && countdown.mode === "overtime" && countdown.overtimeStartedAt) {
      return { key: `o${countdown.overtimeStartedAt}`, title: "Timer · overtime", body: `Counting the extra time since ${clock(countdown.overtimeStartedAt)}` };
    }
    const flow = saved(FLOW_KEY);
    if (flow && flow.mode === "running" && flow.runStartedAt) {
      return { key: `f${flow.runStartedAt}`, title: "Flow", body: `Running since ${clock(flow.runStartedAt)}` };
    }
    return null;
  }

  const notesOn = () =>
    Boolean(pushDevice && Real.permission === "granted" && L.internals.loadSettings().notifications_enabled);

  async function showRunning() {
    const note = runningNote();
    if (!note || !notesOn() || store.get(SHOWN_KEY) === note.key) return;
    store.set(SHOWN_KEY, note.key);
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(note.title, { body: note.body, tag: RUNNING_TAG, silent: true, icon: "icons/icon-192.png" });
    } catch (_) {}
  }

  // In view: a note that no longer fits what runs (paused, stopped, the next
  // block) is taken away.
  async function tidyRunning() {
    const note = runningNote();
    if (note && store.get(SHOWN_KEY) === note.key) return;
    if (!store.get(SHOWN_KEY)) return;
    store.set(SHOWN_KEY, "");
    try {
      const reg = await navigator.serviceWorker.ready;
      (await reg.getNotifications({ tag: RUNNING_TAG })).forEach((n) => n.close());
    } catch (_) {}
  }

  /* ---------- keep the screen on, when push can't ring for us ---------- */

  let lock = null;
  let asking = false;

  async function keepAwake() {
    if (!navigator.wakeLock) return;
    const end = nextEnd();
    const want = Boolean(end && end.at > Date.now()) && document.visibilityState === "visible" && !pushOn();
    if (want && !lock && !asking) {
      asking = true;
      try {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => (lock = null));
      } catch (_) {
        lock = null; // low battery mode, or not allowed: the timer still works
      } finally {
        asking = false;
      }
    } else if (!want && lock) {
      const l = lock;
      lock = null;
      l.release().catch(() => {});
    }
  }

  document.addEventListener("visibilitychange", onVisibility);
  // pagehide covers closing the app straight from this page.
  window.addEventListener("pagehide", () => {
    book();
    showRunning();
  });
  L.ready.then(async () => {
    await subscribe().catch((err) => console.warn("push subscription failed", err));
    // A booking left from before (the app was closed in the background): in
    // view now, so the timer rings itself.
    if (document.visibilityState === "visible") cancel(true);
    else book();
    keepAwake();
  });
  // Each start, pause and end saves the clock's state: check then, and now and
  // then for a block that ended on its own.
  const realSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    realSetItem.call(this, key, value);
    if (this !== window.localStorage || (key !== TIMER_KEY && key !== COUNTDOWN_KEY && key !== FLOW_KEY)) return;
    if (document.visibilityState === "hidden") book();
    else tidyRunning();
    keepAwake();
  };
  const realRemove = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (key) {
    realRemove.call(this, key);
    if (this === window.localStorage && (key === TIMER_KEY || key === COUNTDOWN_KEY || key === FLOW_KEY)) tidyRunning();
  };
  setInterval(keepAwake, 15000);

  if (!pushDevice) return;

  /* ---------- window.Notification for Settings ---------- */

  window.Notification = class {
    constructor(title, options) {
      // Settings' "Send a test": through the push function when subscribed, so
      // it tests the real path (lock the phone and it still arrives).
      if (subscription) {
        post({ action: "book", subscription, at: Date.now() + 3000, title: String(title), body: "Notifications are working. Lock your phone; they arrive there too." });
        return;
      }
      navigator.serviceWorker.ready
        .then((reg) => reg.showNotification(String(title), { body: String((options && options.body) || ""), tag: "muhurta-test" }))
        .catch(() => {});
    }
    static get permission() {
      return Real.permission;
    }
    static async requestPermission() {
      // Asked straight away, inside the tap: iOS only asks from a tap.
      const p = await Real.requestPermission();
      if (p === "granted") await subscribe().catch((err) => console.warn("push subscription failed", err));
      return p;
    }
  };

  /* ---------- Settings: iPhone words for the Notifications section ---------- */

  const WORDS = {
    "Desktop notifications": "Alert when a block ends",
    "A quiet alert when a block ends while this tab is out of view.":
      "A notification when focus or rest ends while the app is closed or the phone is locked.",
    "Allowed in this browser.": "Allowed on this iPhone.",
    "Your browser still needs permission before it can show them.": "Your iPhone still needs your permission before it can show them.",
    "Blocked by your browser. Allow notifications for this site in the browser's site settings, then reload this page.":
      "Turned off for this app. Allow them in iPhone Settings > Notifications > Muhurta.",
  };

  function phoneWords(root) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.nodeValue.trim();
      if (WORDS[t]) n.nodeValue = n.nodeValue.replace(t, WORDS[t]);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const sec = document.getElementById("notifications");
    if (!sec) return;
    phoneWords(sec);
    new MutationObserver(() => phoneWords(sec)).observe(sec, { childList: true, subtree: true, characterData: true });
  });

  // The first time the function is seen (it was set up after the app was
  // added), Settings shows its Notifications section from the next page on.
  if (!L.notifications) pushKey().catch(() => {});
})();
