// The running clock in Android's notification shade, like the Mac app's menu
// bar (static/js/menubar.js): whatever runs, Rhythm, Timer or Flow, shows as
// an ongoing notification with the time ticking, also on the lock screen.
//
// It reads the clocks' saved sessions, so the timer's own code stays the same
// as on the computer, and tells the app (LiveTimerPlugin.java) only when what
// runs changes; Android itself ticks the clock, so it keeps going while the
// app is paused in the background. A countdown's notification goes away at
// zero, where the end-of-block bell (alerts.js) takes over.
(function () {
  "use strict";

  const L = window.__MUHURTA_LOCAL__;
  const Live = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LiveTimer;
  if (!L || !Live) return; // not inside the Android app

  // Rhythm's saved session is still called "timer"; the simple Timer's is "countdown".
  const RHYTHM_KEY = "muhurat_timer_session_v1";
  const COUNTDOWN_KEY = "muhurat_countdown_session_v1";
  const FLOW_KEY = "muhurat_flow_session_v1";
  const ASKED_KEY = "muhurta-live-asked";
  const PHASES = { work: "Focus", rest: "Rest", cumulative: "Pool rest" };

  function saved(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }

  const paused = (label, sec, up) => ({ label: `${label} · paused`, up, sec, paused: true });

  function rhythmState(d) {
    if (!d) return null;
    if (d.mode === "extend") {
      const s = d.session || {};
      const sec = Number(s.extendSec || 0) - Number(d.extendBaseSec || 0);
      const open = s.segKind === "extend" && s.segStartedAt;
      if (open && d.running) return { label: "Extra focus · Rhythm", up: true, sec, since: Number(s.segStartedAt), plus: true };
      const extra = open ? Math.max(0, (Number(d.savedAt || Date.now()) - s.segStartedAt) / 1000) : 0;
      return { ...paused("Extra focus", sec + extra, true), plus: true };
    }
    const phase = PHASES[d.mode];
    if (!phase) return null;
    if (d.running && d.phaseEndsAt) {
      if (Number(d.phaseEndsAt) <= Date.now()) return null; // the bell's moment
      return { label: `${phase} · Rhythm`, up: false, until: Number(d.phaseEndsAt) };
    }
    return paused(phase, Number(d.remainingSec || 0), false);
  }

  function countdownState(d) {
    if (!d) return null;
    if (d.mode === "running" && d.endsAt) {
      if (Number(d.endsAt) <= Date.now()) return null;
      return { label: "Timer", up: false, until: Number(d.endsAt) };
    }
    if (d.mode === "paused") return paused("Timer", Number(d.remainingSec || 0), false);
    if (d.mode === "ringing") return { label: "Time's up", up: false, sec: 0, paused: true };
    if (d.mode === "overtime" && d.overtimeStartedAt) {
      return { label: "Timer · overtime", up: true, sec: 0, since: Number(d.overtimeStartedAt), plus: true };
    }
    return null;
  }

  function flowState(d) {
    if (!d || (d.mode !== "running" && d.mode !== "paused")) return null;
    const sec = Number(d.focusedSec || 0);
    if (d.mode === "running" && d.runStartedAt) return { label: "Flow", up: true, sec, since: Number(d.runStartedAt) };
    return paused("Flow", sec, true);
  }

  function current() {
    const all = [rhythmState(saved(RHYTHM_KEY)), countdownState(saved(COUNTDOWN_KEY)), flowState(saved(FLOW_KEY))].filter(Boolean);
    // Whichever is running wins; if all are paused, the newest kind.
    return all.find((s) => !s.paused) || all[all.length - 1] || null;
  }

  // The first time a clock starts, ask Android once for notifications
  // (alerts.js keeps the answer for Settings).
  function askOnce(state) {
    if (!state || state.paused || !window.Notification || Notification.permission !== "default") return;
    try {
      if (localStorage.getItem(ASKED_KEY)) return;
      localStorage.setItem(ASKED_KEY, "1");
    } catch (_) {
      return;
    }
    Notification.requestPermission().then(() => {
      last = null;
      check();
    });
  }

  let last = null; // what the notification shows now, as JSON
  let busy = false;

  async function check() {
    if (busy) return;
    const state = current();
    const key = JSON.stringify(state);
    if (key === last) return;
    busy = true;
    try {
      if (state) {
        const r = await Live.show(state);
        last = r && r.shown ? key : null;
        if (!last) askOnce(state);
      } else {
        await Live.hide();
        last = key;
      }
    } catch (_) {
      last = null;
    } finally {
      busy = false;
    }
  }

  // Every start, pause and end saves a clock's state.
  const realSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    realSetItem.call(this, key, value);
    if (this === window.localStorage && (key === RHYTHM_KEY || key === COUNTDOWN_KEY || key === FLOW_KEY)) setTimeout(check, 0);
  };
  const realRemove = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (key) {
    realRemove.call(this, key);
    if (this === window.localStorage && (key === RHYTHM_KEY || key === COUNTDOWN_KEY || key === FLOW_KEY)) setTimeout(check, 0);
  };
  document.addEventListener("visibilitychange", () => {
    last = null; // the notification may have timed out or been swiped away meanwhile
    check();
  });
  L.ready.then(check);
  setInterval(check, 1000);
})();
