// In the Mac app, tell the app what is running so it can show the time in
// the menu bar (menubar.py), like Apple's Clock. Runs on every page and reads
// the saved sessions of Rhythm ("timer"), Timer ("countdown") and Flow, so it
// works wherever the window is.
// The app counts the seconds itself; this only says when something changes.
// In a browser this does nothing.
(function () {
  "use strict";
  if (!window.webkit || !window.webkit.messageHandlers) return; // a browser

  const TIMER_KEY = "muhurat_timer_session_v1";
  const FLOW_KEY = "muhurat_flow_session_v1";
  const COUNTDOWN_KEY = "muhurat_countdown_session_v1";
  let lastSent = null;

  function read(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function timerState(d) {
    if (!d) return null;
    if (d.mode === "extend") {
      const s = d.session || {};
      let sec = Number(s.extendSec || 0) - Number(d.extendBaseSec || 0);
      const open = s.segKind === "extend" && s.segStartedAt;
      if (open && d.running) {
        return { kind: "timer", up: true, sec, since: s.segStartedAt, until: null, paused: false };
      }
      if (open) sec += Math.max(0, (Number(d.savedAt || Date.now()) - s.segStartedAt) / 1000);
      return { kind: "timer", up: true, sec, since: null, until: null, paused: true };
    }
    if (!["work", "rest", "cumulative"].includes(d.mode)) return null;
    // Rest (and rest taken from the pool) gets its own icon.
    const kind = d.mode === "work" ? "timer" : "rest";
    if (d.running && d.phaseEndsAt) {
      if (d.phaseEndsAt <= Date.now()) return null;
      return { kind, up: false, sec: 0, since: null, until: d.phaseEndsAt, paused: false };
    }
    return { kind, up: false, sec: Number(d.remainingSec || 0), since: null, until: null, paused: true };
  }

  function flowState(d) {
    if (!d || (d.mode !== "running" && d.mode !== "paused")) return null;
    const sec = Number(d.focusedSec || 0);
    if (d.mode === "running" && d.runStartedAt) {
      return { kind: "flow", up: true, sec, since: d.runStartedAt, until: null, paused: false };
    }
    return { kind: "flow", up: true, sec, since: null, until: null, paused: true };
  }

  function countdownState(d) {
    if (!d) return null;
    const base = { kind: "countdown", up: false, sec: 0, since: null, until: null, paused: false };
    if (d.mode === "running" && d.endsAt) return { ...base, until: d.endsAt };
    if (d.mode === "paused") return { ...base, sec: Number(d.remainingSec || 0), paused: true };
    if (d.mode === "ringing") return base; // 00:00 until dismissed
    if (d.mode === "overtime" && d.overtimeStartedAt) return { ...base, up: true, since: d.overtimeStartedAt };
    return null;
  }

  function current() {
    const all = [
      timerState(read(TIMER_KEY)),
      countdownState(read(COUNTDOWN_KEY)),
      flowState(read(FLOW_KEY)),
    ].filter(Boolean);
    // Whichever is running wins; if all are paused, the newest kind (Flow,
    // then Timer, then Rhythm).
    return all.find((s) => !s.paused) || all[all.length - 1] || null;
  }

  function check() {
    const api = window.pywebview && window.pywebview.api;
    if (!api || typeof api.menu_bar !== "function") return;
    const state = current();
    const key = JSON.stringify(state);
    if (key === lastSent) return;
    lastSent = key;
    try {
      api.menu_bar(state);
    } catch (_) {}
  }

  window.setInterval(check, 1000);
  window.addEventListener("pywebviewready", check);
  window.addEventListener("storage", check);
})();
