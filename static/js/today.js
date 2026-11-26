// Today's focus under the clock on Rhythm, Timer and Flow: "Today 1h 12m of 2h",
// with a thin line filling toward the daily goal. It counts what is logged
// for today plus the block that is running now, so it moves as you work.
// A tap opens the Dashboard.
(function () {
  "use strict";

  const KEYS = {
    rhythm: "muhurat_timer_session_v1",
    countdown: "muhurat_countdown_session_v1",
    flow: "muhurat_flow_session_v1",
  };
  const REFRESH_MS = 30000;
  let el = null;
  let loggedSec = 0; // today's focus already in the record
  let loggedDay = "";
  let goalMin = 0;
  let lastLive = "";
  let shown = { day: "", sec: 0 };
  let settling = false; // a block just ended: hold the number until the record has it
  let loading = false;

  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function read(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }

  // The focus block running right now: when it started, or null.
  function liveStart() {
    const r = read(KEYS.rhythm);
    const s = r?.session;
    if (r?.running && s?.segStartedAt && (s.segKind === "work" || s.segKind === "extend")) return Number(s.segStartedAt);
    const c = read(KEYS.countdown);
    if (c?.mode === "running" && c.runStartedAt) return Number(c.runStartedAt);
    if (c?.mode === "overtime" && c.overtimeStartedAt) return Number(c.overtimeStartedAt);
    const f = read(KEYS.flow);
    if (f?.mode === "running" && f.runStartedAt) return Number(f.runStartedAt);
    return null;
  }

  // The part of the running block that fell today, in seconds (0 when nothing runs).
  function liveTodaySec(now = Date.now()) {
    const start = liveStart();
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    return start ? Math.max(0, (now - Math.max(start, midnight)) / 1000) : 0;
  }
  // The Dashboard's Today ring counts the running block too, so it agrees with this line.
  window.MuhurtaToday = { liveTodaySec };

  function format(sec) {
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
  }

  async function load() {
    if (loading) return;
    loading = true;
    const day = dayKey(Date.now());
    try {
      const [dayRes, setRes] = await Promise.all([
        fetch(`/api/activity/day?day=${day}`, { headers: { Accept: "application/json" } }),
        fetch("/api/settings", { headers: { Accept: "application/json" } }),
      ]);
      if (dayRes.ok) {
        loggedSec = Number((await dayRes.json()).totals?.productive_sec || 0);
        loggedDay = day;
      }
      if (setRes.ok) goalMin = Number((await setRes.json()).daily_focus_goal_minutes || 0);
      settling = false;
    } catch (_) {
      // Offline: keep what is shown.
    } finally {
      loading = false;
      draw();
    }
  }

  function draw() {
    if (!el) return;
    const now = Date.now();
    const today = dayKey(now);
    if (loggedDay !== today) {
      // Past midnight: yesterday's total is not today's.
      loggedSec = 0;
      loggedDay = today;
      load();
    }
    const start = liveStart();
    const live = start ? `${start}` : "";
    if (live !== lastLive) {
      // A block started, paused or ended: the record changes in a moment.
      if (lastLive) settling = true;
      lastLive = live;
      window.setTimeout(load, 700);
    }
    // Only the part of the running block that fell today counts for today.
    const liveSec = liveTodaySec(now);
    let sec = loggedSec + liveSec;
    if (shown.day === today && settling && sec < shown.sec) sec = shown.sec;
    shown = { day: today, sec };

    el.classList.toggle("hidden", sec < 60 && !goalMin);
    const met = goalMin > 0 && sec >= goalMin * 60;
    el.classList.toggle("is-met", met);
    el.querySelector(".today-value").textContent = format(sec);
    el.querySelector(".today-goal").textContent = goalMin > 0 ? (met ? "· goal reached" : `of ${format(goalMin * 60)}`) : "";
    el.querySelector(".today-fill").style.width = goalMin > 0 ? `${Math.min(100, (sec / (goalMin * 60)) * 100).toFixed(1)}%` : "0";
    el.querySelector(".today-track").classList.toggle("hidden", !(goalMin > 0));
    el.setAttribute("aria-label", `Today's focus: ${format(sec)}${goalMin > 0 ? ` of a ${format(goalMin * 60)} goal` : ""}. Open the dashboard.`);
  }

  function init() {
    const quote = document.querySelector(".timer-layout .focus-quote");
    const dash = window.__CLOCK_PAGES__?.dashboard;
    if (!quote || !dash) return;
    el = document.createElement("a");
    el.className = "today-line hidden";
    el.href = dash;
    el.innerHTML =
      '<span class="today-text"><span class="today-key">Today</span> <b class="today-value">0m</b> <span class="today-goal"></span></span>' +
      '<span class="today-track"><span class="today-fill"></span></span>';
    quote.parentNode.insertBefore(el, quote);
    loggedDay = dayKey(Date.now());
    lastLive = liveStart() ? `${liveStart()}` : "";
    load();
    window.setInterval(draw, 1000);
    window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") load();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
