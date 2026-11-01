// Go to the page of the clock that is running, as when you click the time in
// the Mac menu bar (menubar.py) or tap the running clock's notification on a
// phone: you land on Rhythm, Timer or Flow, not on whichever page was last open.
//
// MuhurtaOpenRunning(kind) goes to that clock ("timer" is Rhythm's focus,
// "rest" its rest, "countdown" the simple Timer, "flow" Flow, as menubar.py
// names them). Without a kind it picks from the saved sessions: running
// first, then one waiting on you (a Rhythm choice, Timer's bell), then
// paused; the newest wins a tie. Nothing going on: it stays where it is.
(function () {
  "use strict";

  const PAGES = window.__CLOCK_PAGES__ || {};
  const PAGE_IDS = { rhythm: "home", countdown: "timer", flow: "flow" };
  const KINDS = { timer: "rhythm", rest: "rhythm", rhythm: "rhythm", countdown: "countdown", flow: "flow" };

  function parse(raw) {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  // The newer of the local and per-window copies (one-clock.js).
  function read(key) {
    try {
      const local = parse(localStorage.getItem(key));
      const own = parse(sessionStorage.getItem(key));
      if (!local) return own;
      if (!own) return local;
      return Number(own.savedAt || 0) > Number(local.savedAt || 0) ? own : local;
    } catch (_) {
      return null;
    }
  }

  // 3 running, 2 waiting on you, 1 paused, 0 nothing going on.
  function rhythmRank(d) {
    if (!d || !d.mode || d.mode === "idle" || d.mode === "complete") return 0;
    if (d.mode === "work_choice" || d.mode === "rest_choice") return 2;
    return d.running ? 3 : 1;
  }

  function countdownRank(d) {
    if (!d) return 0;
    return { running: 3, overtime: 3, ringing: 2, paused: 1 }[d.mode] || 0;
  }

  function flowRank(d) {
    if (!d) return 0;
    return { running: 3, paused: 1 }[d.mode] || 0;
  }

  function pick() {
    const all = [
      { clock: "rhythm", d: read("muhurat_timer_session_v1"), rank: rhythmRank },
      { clock: "countdown", d: read("muhurat_countdown_session_v1"), rank: countdownRank },
      { clock: "flow", d: read("muhurat_flow_session_v1"), rank: flowRank },
    ]
      .map((c) => ({ clock: c.clock, rank: c.rank(c.d), at: Number((c.d && c.d.savedAt) || 0) }))
      .filter((c) => c.rank > 0)
      .sort((a, b) => b.rank - a.rank || b.at - a.at);
    return all.length ? all[0].clock : null;
  }

  function open(kind) {
    const clock = KINDS[kind] || pick();
    if (!clock || !PAGES[clock] || window.__PAGE__ === PAGE_IDS[clock]) return false;
    window.location.assign(PAGES[clock]);
    return true;
  }

  window.MuhurtaOpenRunning = open;

  // The iPhone app's notifications (mobile/web/sw.js): a tap while the app is
  // open sends a message; with the app closed, it opens with ?open=running.
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "open-running") open();
    });
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get("open") === "running") {
    params.delete("open");
    const rest = params.toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
    open();
  }
})();
