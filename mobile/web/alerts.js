// Phone alerts: a bell and a notification when a focus or rest block ends
// while the app is out of view (closed, in the background, screen off).
//
// Android pauses an app in the background, so the timer's own end-of-block
// sound cannot play then. Instead, when the app leaves the screen, the end of
// the running block is booked with Android (Local Notifications plugin); when
// the app comes back, the booking is cancelled and the timer rings as usual.
// The timer saves its state to localStorage on every change; that is what is
// read here, so the timer's own code stays the same as on the computer.
//
// Also: window.Notification for the Settings section (permission, the test
// notification), and the status bar's icons following the app's theme.
(function () {
  "use strict";

  const L = window.__MUHURTA_LOCAL__;
  const plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
  const LN = plugins.LocalNotifications;
  if (!L || !LN) return; // not inside the app

  // Rhythm's saved session is still called "timer"; the simple Timer's is "countdown".
  const TIMER_KEY = "muhurat_timer_session_v1";
  const COUNTDOWN_KEY = "muhurat_countdown_session_v1";
  const PERM_KEY = "muhurta-notify-permission";
  const BLOCK_ID = 1;
  const TEST_ID = 2;
  const ENDS = {
    work: { channel: "focus-end", title: "Focus complete", body: "Time for a rest." },
    rest: { channel: "rest-end", title: "Rest complete", body: "Ready to focus again?" },
    cumulative: { channel: "rest-end", title: "Pool rest complete", body: "Resume focus when ready." },
    countdown: { channel: "focus-end", title: "Time's up", body: "Your timer is done." },
  };

  L.notifications = true;

  /* ---------- permission, mirrored as the web's Notification.permission ---------- */

  const readPerm = () => {
    try {
      return localStorage.getItem(PERM_KEY) || "default";
    } catch (_) {
      return "default";
    }
  };
  const keepPerm = (display) => {
    const p = display === "granted" ? "granted" : display === "denied" ? "denied" : "default";
    try {
      localStorage.setItem(PERM_KEY, p);
    } catch (_) {}
    return p;
  };

  LN.checkPermissions().then((r) => keepPerm(r.display)).catch(() => {});

  window.Notification = class {
    constructor(title, options) {
      // Only the Settings test reaches here while the app is in view; ends of
      // blocks come from the booking below, so nothing arrives twice.
      if (document.visibilityState !== "visible") return;
      LN.schedule({ notifications: [{ id: TEST_ID, title: String(title), body: String((options && options.body) || ""), channelId: "general", isExactNotification: false }] })
        .catch(() => {});
    }
    static get permission() {
      return readPerm();
    }
    static async requestPermission() {
      try {
        return keepPerm((await LN.requestPermissions()).display);
      } catch (_) {
        return readPerm();
      }
    }
  };

  /* ---------- channels: how each kind of alert sounds ---------- */

  const channels = Promise.all([
    LN.createChannel({ id: "focus-end", name: "Focus ends", description: "A bell when a focus block ends", importance: 5, sound: "focus_end.mp3", vibration: true, visibility: 1 }),
    LN.createChannel({ id: "rest-end", name: "Rest ends", description: "A bell when a rest ends", importance: 5, sound: "rest_end.mp3", vibration: true, visibility: 1 }),
    LN.createChannel({ id: "general", name: "Other", description: "Test notifications", importance: 3, visibility: 1 }),
  ]).catch(() => {});

  /* ---------- booking the end of the running block ---------- */

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

  function wanted() {
    const end = nextEnd();
    if (!end || !(end.at > Date.now() + 1500)) return null;
    const settings = L.internals.loadSettings();
    if (!settings.notifications_enabled || readPerm() !== "granted") return null;
    return end;
  }

  let booked = null; // "at|channel" of what Android holds now

  async function cancel() {
    if (!booked) return;
    booked = null;
    try {
      await LN.cancel({ notifications: [{ id: BLOCK_ID }] });
    } catch (_) {}
  }

  async function book() {
    const w = wanted();
    if (!w) return cancel();
    const key = `${Math.round(w.at / 1000)}|${w.channel}`;
    if (booked === key) return;
    await channels;
    try {
      // On the minute when Android allows it (USE_EXACT_ALARM, granted to
      // timers). If someone turned that off, ask for a normal alert rather than
      // have the plugin open Android's settings as the app leaves the screen.
      let exact = true;
      try {
        exact = (await LN.checkExactNotificationSetting()).exact_alarm === "granted";
      } catch (_) {}
      await LN.cancel({ notifications: [{ id: BLOCK_ID }] });
      await LN.schedule({
        notifications: [{
          id: BLOCK_ID, title: w.title, body: w.body, channelId: w.channel,
          schedule: { at: new Date(w.at), allowWhileIdle: true }, isExactNotification: exact,
        }],
      });
      booked = key;
    } catch (err) {
      console.warn("could not book the end-of-block alert", err);
    }
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") book();
    else cancel();
  }

  document.addEventListener("visibilitychange", onVisibility);
  // pagehide covers closing the app straight from this page.
  window.addEventListener("pagehide", () => book());
  // In view on start: nothing booked (the timer rings itself). Out of view
  // (opened behind the lock screen): book now.
  L.ready.then(() => {
    if (document.visibilityState === "hidden") book();
    else LN.cancel({ notifications: [{ id: BLOCK_ID }] }).catch(() => {});
  });

  // A clock changed while out of view (rare: the app is usually paused).
  const realSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    realSetItem.call(this, key, value);
    if (this === window.localStorage && (key === TIMER_KEY || key === COUNTDOWN_KEY) && document.visibilityState === "hidden") book();
  };

  /* ---------- Settings: phone words for the Notifications section ---------- */

  const WORDS = {
    "Desktop notifications": "Alert when a block ends",
    "A quiet alert when a block ends while this tab is out of view.":
      "A bell and a notification when focus or rest ends while the app is closed or the screen is off.",
    "Allowed in this browser.": "Allowed on this phone.",
    "Your browser still needs permission before it can show them.": "Android still needs your permission before it can show them.",
    "Blocked by your browser. Allow notifications for this site in the browser's site settings, then reload this page.":
      "Turned off for this app. Allow them in Android Settings > Apps > Muhurta > Notifications.",
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

  /* ---------- status bar icons follow the app's theme, not only the phone's ---------- */

  const Bars = plugins.SystemBars;
  // Only when the page itself is drawn behind the bars (Android System WebView
  // 140 and later). On older ones the strip behind the icons is the phone's own
  // light or dark colour, so the icons stay with the phone's mode.
  function drawnBehindBars() {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden";
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return h > 0;
  }
  function barsForTheme() {
    if (!Bars || !document.body) return;
    if (!drawnBehindBars()) {
      Bars.setStyle({ style: "DEFAULT" }).catch(() => {});
      return;
    }
    const theme = document.body.dataset.theme;
    const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    // DARK = light icons for a dark page; LIGHT = dark icons for a light page.
    Bars.setStyle({ style: dark ? "DARK" : "LIGHT" }).catch(() => {});
  }
  document.addEventListener("DOMContentLoaded", () => {
    barsForTheme();
    new MutationObserver(barsForTheme).observe(document.body, { attributes: true, attributeFilter: ["data-theme"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", barsForTheme);
  });
})();
