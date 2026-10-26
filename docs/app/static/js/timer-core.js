// The simple Timer's saved session, on every page. The Timer page draws it;
// this keeps time, so a timer that runs out while another page is open
// still chimes, notifies and logs its focus there (session-monitor.js does
// the same for Rhythm).
//
// What happens at zero is the timer_end setting:
//   "stop"     chime once and finish (the default)
//   "ring"     chime every few seconds until dismissed, like a phone alarm
//   "overtime" chime once, then keep counting up (+0:42) until stopped
// The time counted, overtime included, is focus.
(function () {
  "use strict";

  const KEY = "muhurat_countdown_session_v1";
  const RING_EVERY_MS = 4000;
  const RING_FOR_MS = 5 * 60 * 1000; // a forgotten alarm goes quiet after this
  const ENDS = new Set(["stop", "ring", "overtime"]);
  const listeners = new Set();
  let settings = null;
  let settingsPromise = null;
  let banner = null;

  // fresh: fetch again, for a setting changed since this page opened.
  function loadSettings(fresh = false) {
    if (fresh) settingsPromise = null;
    else if (settings) return Promise.resolve(settings);
    if (!settingsPromise) {
      settingsPromise = fetch("/api/settings", { headers: { Accept: "application/json" } })
        .then((res) => (res.ok ? res.json() : {}))
        .catch(() => ({}))
        .then((data) => {
          settings = data || {};
          return settings;
        });
    }
    return settingsPromise;
  }

  function read() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || "null");
      return data && data.mode ? data : null;
    } catch (_) {
      return null;
    }
  }

  function write(data) {
    try {
      if (data) localStorage.setItem(KEY, JSON.stringify({ ...data, savedAt: Date.now() }));
      else localStorage.removeItem(KEY);
    } catch (_) {}
    changed();
  }

  function changed() {
    const data = read();
    listeners.forEach((fn) => {
      try {
        fn(data);
      } catch (_) {}
    });
    renderBanner(data);
  }

  function logFocus(data, startedAt, endedAt, extra = {}) {
    window.OneClock?.logSegment(
      {
        kind: "timer",
        preset_id: "timer",
        preset_name: "Timer",
        details: { mode: "countdown", set_sec: Number(data.durationSec || 0), ...extra },
      },
      startedAt,
      endedAt
    );
  }

  function remainingSec(data, now = Date.now()) {
    if (!data) return 0;
    if (data.mode === "running") return Math.max(0, (Number(data.endsAt) - now) / 1000);
    if (data.mode === "paused") return Math.max(0, Number(data.remainingSec || 0));
    return 0;
  }

  function overtimeSec(data, now = Date.now()) {
    if (data?.mode !== "overtime" || !data.overtimeStartedAt) return 0;
    return Math.max(0, (now - Number(data.overtimeStartedAt)) / 1000);
  }

  function chime() {
    loadSettings().then((s) => window.FocusSounds?.workComplete(s));
  }

  function notify(title, body) {
    loadSettings().then((s) => {
      if (!s.notifications_enabled) return;
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      if (document.visibilityState === "visible" && document.hasFocus()) return;
      try {
        new Notification(title, { body, silent: true });
      } catch (_) {}
    });
  }

  function setLabel(sec) {
    const m = Math.round(sec / 60);
    if (m >= 60) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
    return m >= 1 ? `${m} min` : `${Math.round(sec)} sec`;
  }

  /* ---------- actions ---------- */

  function start(durationSec, quote) {
    const now = Date.now();
    write({
      mode: "running",
      durationSec,
      startedAt: now,
      runStartedAt: now,
      endsAt: now + durationSec * 1000,
      currentQuote: quote || null,
    });
  }

  function pause(extra = {}) {
    const data = read();
    if (data?.mode !== "running") return false;
    const now = Date.now();
    logFocus(data, Number(data.runStartedAt), now, extra.paused_by ? { paused_by: extra.paused_by } : {});
    write({
      ...data,
      mode: "paused",
      remainingSec: remainingSec(data, now),
      endsAt: null,
      runStartedAt: null,
      pausedBy: extra.paused_by || null,
      notice: extra.notice || null,
    });
    return true;
  }

  function resume() {
    const data = read();
    if (data?.mode !== "paused") return;
    const now = Date.now();
    write({
      ...data,
      mode: "running",
      runStartedAt: now,
      endsAt: now + remainingSec(data) * 1000,
      pausedBy: null,
      notice: null,
    });
  }

  function setQuote(quote) {
    const data = read();
    if (data) write({ ...data, currentQuote: quote });
  }

  // Cancel a countdown, stop the overtime count, or silence the alarm.
  function stop(extra = {}) {
    const data = read();
    if (!data) return;
    const now = Date.now();
    if (data.mode === "running") logFocus(data, Number(data.runStartedAt), now, extra);
    if (data.mode === "overtime") logFocus(data, Number(data.overtimeStartedAt), now, { overtime: true, ...extra });
    write(null);
  }

  // Another clock is starting (one-clock.js).
  function pauseFor(by, label) {
    const data = read();
    if (data?.mode === "running") {
      const notice = `Timer paused while ${label} starts.`;
      pause({ paused_by: by, notice });
      return notice;
    }
    if (data?.mode === "overtime") {
      stop({ paused_by: by });
      return `Timer stopped while ${label} starts.`;
    }
    if (data?.mode === "ringing") stop();
    return null;
  }

  /* ---------- reaching zero ---------- */

  async function finish(data) {
    const s = await loadSettings(true);
    // Another window may have finished it while settings loaded.
    const now = read();
    if (now?.mode !== "running" || now.endsAt !== data.endsAt) return;
    const endedAt = Number(data.endsAt);
    logFocus(data, Number(data.runStartedAt), endedAt);
    const end = ENDS.has(s.timer_end) ? s.timer_end : "stop";
    const label = setLabel(Number(data.durationSec || 0));
    if (end === "ring") {
      write({ ...data, mode: "ringing", endsAt: null, runStartedAt: null, ringingSince: endedAt, lastRingAt: Date.now() });
    } else if (end === "overtime") {
      write({ ...data, mode: "overtime", endsAt: null, runStartedAt: null, overtimeStartedAt: endedAt });
    } else {
      write(null);
    }
    window.dispatchEvent(new CustomEvent("muhurta-timer-done", { detail: { end, label } }));
    chime();
    notify("Time's up", end === "overtime" ? `${label} done. Counting the extra time.` : `${label} timer done.`);
  }

  function tick() {
    const data = read();
    if (!data) return;
    const now = Date.now();
    if (data.mode === "running" && Number(data.endsAt) <= now) {
      finish(data);
    } else if (data.mode === "ringing") {
      if (now - Number(data.ringingSince) > RING_FOR_MS) write(null);
      else if (now - Number(data.lastRingAt || 0) >= RING_EVERY_MS) {
        write({ ...data, lastRingAt: now });
        chime();
      }
    }
  }

  /* ---------- the alarm, on pages other than Timer ---------- */

  function renderBanner(data) {
    if (window.__PAGE__ === "timer") return;
    const ringing = data?.mode === "ringing";
    if (!ringing) {
      banner?.classList.add("hidden");
      return;
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "timer-alarm";
      banner.setAttribute("role", "alert");
      banner.innerHTML =
        '<div class="update-bar-copy"><p class="update-bar-title">Time\'s up</p>' +
        '<p class="update-bar-sub timer-alarm-text"></p></div>' +
        '<span class="update-bar-actions">' +
        '<a class="btn btn-ghost btn-small" href="/muhurta-pomodoro/app/timer.html">Open Timer</a>' +
        '<button type="button" class="btn btn-primary btn-small">Dismiss</button>' +
        "</span>";
      banner.querySelector("button").addEventListener("click", () => stop());
      document.body.appendChild(banner);
    }
    banner.querySelector(".timer-alarm-text").textContent = `Your ${setLabel(Number(data.durationSec || 0))} timer is done.`;
    banner.classList.remove("hidden");
  }

  window.MuhurtaTimer = {
    read,
    start,
    pause,
    resume,
    stop,
    setQuote,
    pauseFor,
    remainingSec,
    overtimeSec,
    loadSettings,
    onChange(fn) {
      listeners.add(fn);
    },
  };

  window.addEventListener("storage", (event) => {
    if (event.key === KEY) changed();
  });
  document.addEventListener("DOMContentLoaded", () => {
    renderBanner(read());
    tick();
    window.setInterval(tick, 250);
  });
})();
