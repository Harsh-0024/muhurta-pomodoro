// The Timer page: set a time, start, and it counts down. The timing itself
// lives in timer-core.js, which runs on every page; this draws it.
(function () {
  "use strict";

  const LAST_KEY = "muhurat_countdown_last_v1";
  const RING_LEN = 2 * Math.PI * 96;
  const MAX_SEC = 24 * 60 * 60 - 1;
  const T = () => window.MuhurtaTimer;
  let tickTimer = null;
  let noticeTimer = null;
  let quoteLoadId = 0;
  let lastQuoteKey = null;

  const $ = (id) => document.getElementById(id);

  function api(path) {
    return fetch(path, { headers: { Accept: "application/json" } }).then((res) => {
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    });
  }

  function formatClock(sec, { padded = true } = {}) {
    const rounded = Math.max(0, Math.ceil(sec - 0.001));
    const h = Math.floor(rounded / 3600);
    const m = Math.floor((rounded % 3600) / 60);
    const s = rounded % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${padded ? String(m).padStart(2, "0") : m}:${String(s).padStart(2, "0")}`;
  }

  function formatDuration(sec) {
    const rounded = Math.max(0, Math.floor(sec));
    const h = Math.floor(rounded / 3600);
    const m = Math.floor((rounded % 3600) / 60);
    const s = rounded % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatSet(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s || !parts.length) parts.push(`${s}s`);
    return parts.join(" ");
  }

  function formatTimeOfDay(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  /* ---------- the length fields ---------- */

  // The length lives in one field showing "25:00". Typing a plain number
  // means minutes; "m:ss" and "h:mm:ss" work too.
  let entrySec = 25 * 60;

  function parseEntry(text) {
    const s = String(text || "").trim();
    let sec = null;
    if (/^\d{1,4}$/.test(s)) sec = Number(s) * 60;
    else if (/^\d{1,3}:\d{1,2}$/.test(s)) {
      const [m, ss] = s.split(":").map(Number);
      sec = ss < 60 ? m * 60 + ss : null;
    } else if (/^\d{1,2}:\d{1,2}:\d{1,2}$/.test(s)) {
      const [h, m, ss] = s.split(":").map(Number);
      sec = m < 60 && ss < 60 ? h * 3600 + m * 60 + ss : null;
    }
    return sec && sec >= 1 && sec <= MAX_SEC ? sec : null;
  }

  function enteredSec() {
    return parseEntry($("timerEntry").value) ?? (document.activeElement === $("timerEntry") ? 0 : entrySec);
  }

  function fillFields(sec) {
    entrySec = Math.max(1, Math.min(MAX_SEC, Math.round(sec)));
    $("timerEntry").value = formatClock(entrySec);
    renderIdle();
  }

  function markPick() {
    document.querySelectorAll("#timerQuick [data-min]").forEach((btn) => {
      btn.classList.toggle("is-active", Number(btn.dataset.min) * 60 === enteredSec());
    });
  }

  function readLast() {
    try {
      const n = Number(localStorage.getItem(LAST_KEY));
      return n > 0 ? n : 25 * 60;
    } catch (_) {
      return 25 * 60;
    }
  }

  function saveLast(sec) {
    try {
      localStorage.setItem(LAST_KEY, String(sec));
    } catch (_) {}
  }

  /* ---------- quote ---------- */

  function applyQuote(quote) {
    if (!quote?.quote || !quote?.author) return;
    $("timerQuoteText").textContent = quote.quote;
    $("timerQuoteAuthor").textContent = quote.author;
  }

  function displayedQuote() {
    const quote = $("timerQuoteText")?.textContent?.trim();
    const author = $("timerQuoteAuthor")?.textContent?.trim();
    return quote && author ? { quote, author } : null;
  }

  async function loadQuote() {
    const loadId = ++quoteLoadId;
    const wrap = $("timerQuote");
    try {
      const res = await api("/api/quote");
      if (loadId !== quoteLoadId || !res?.quote || !res?.author) return;
      wrap?.classList.add("is-updating");
      applyQuote(res);
      T().setQuote({ quote: res.quote, author: res.author });
      window.setTimeout(() => wrap?.classList.remove("is-updating"), 260);
    } catch (_) {}
  }

  /* ---------- notices ---------- */

  function showNotice(message) {
    const el = $("timerNotice");
    if (!el || !message) return;
    el.textContent = message;
    el.classList.remove("hidden");
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      el.classList.add("hidden");
      el.textContent = "";
    }, 5200);
  }

  /* ---------- drawing ---------- */

  function setRing(frac) {
    const el = $("timerRingProgress");
    if (!el) return;
    el.style.strokeDashoffset = String(RING_LEN * (1 - Math.min(1, Math.max(0, frac))));
    // At zero length the rounded end still draws a dot; hide it until it moves.
    el.style.opacity = frac > 0.001 ? "" : "0";
  }

  function show(id, visible) {
    $(id)?.classList.toggle("hidden", !visible);
  }

  function renderIdle() {
    const data = T().read();
    if (data) return;
    const sec = enteredSec();
    $("btnTimerStart").disabled = sec < 1;
    $("timerSetDisplay").textContent = sec ? formatSet(sec) : "—";
    $("timerEndsDisplay").textContent = sec ? formatTimeOfDay(Date.now() + sec * 1000) : "—";
    markPick();
  }

  function render() {
    const data = T().read();
    const mode = data?.mode || "idle";
    const now = Date.now();
    const set = Number(data?.durationSec || 0);
    const remaining = T().remainingSec(data, now);
    const over = T().overtimeSec(data, now);
    const idle = mode === "idle";

    document.body.classList.toggle("timer-running", mode === "running");
    document.body.classList.toggle("timer-ringing", mode === "ringing");
    document.body.classList.toggle("timer-overtime", mode === "overtime");
    show("timerEntry", idle);
    show("timerQuick", idle);
    show("timerTimeDisplay", !idle);

    show("btnTimerStart", idle);
    show("btnTimerPause", mode === "running");
    show("btnTimerResume", mode === "paused");
    show("btnTimerDismiss", mode === "ringing");
    show("btnTimerStop", mode === "running" || mode === "paused" || mode === "overtime");
    $("btnTimerStop").textContent = mode === "overtime" ? "Stop" : "Cancel";

    const label = { idle: "Timer", running: "Timer", paused: "Paused", ringing: "Time's up", overtime: "Overtime" }[mode];
    $("timerPhaseLabel").textContent = label;

    if (idle) {
      setRing(0);
      $("timerHint").textContent =
        document.activeElement === $("timerEntry") ? "Minutes, or h:mm:ss" : "Tap the time to change it";
      $("timerEndsKey").textContent = "ends at";
      $("timerFocusedDisplay").textContent = "0:00";
      // Idle: the title is session-monitor.js's (a Rhythm session may be running).
      renderIdle();
      return;
    }

    $("timerSetDisplay").textContent = formatSet(set);
    const time = $("timerTimeDisplay");
    if (mode === "overtime") time.textContent = `+${formatClock(Math.floor(over))}`;
    else time.textContent = formatClock(remaining);
    time.classList.toggle("time-extend", mode === "overtime");

    if (mode === "running") {
      $("timerEndsKey").textContent = "ends at";
      $("timerEndsDisplay").textContent = formatTimeOfDay(Number(data.endsAt));
      $("timerHint").textContent = "Counting down";
    } else if (mode === "paused") {
      $("timerEndsKey").textContent = "left";
      $("timerEndsDisplay").textContent = formatDuration(remaining);
      $("timerHint").textContent = "Resume when ready";
    } else {
      $("timerEndsKey").textContent = "ended at";
      const endedAt = mode === "ringing" ? data.ringingSince : data.overtimeStartedAt;
      $("timerEndsDisplay").textContent = endedAt ? formatTimeOfDay(Number(endedAt)) : "—";
      $("timerHint").textContent = mode === "ringing" ? `${formatSet(set)} done` : "Counting the extra time";
    }

    setRing(mode === "ringing" || mode === "overtime" ? 1 : set ? 1 - remaining / set : 0);
    $("timerFocusedDisplay").textContent = formatDuration(set - remaining + over);

    const quoteKey = data.currentQuote ? data.currentQuote.quote : null;
    if (quoteKey && quoteKey !== lastQuoteKey) {
      lastQuoteKey = quoteKey;
      applyQuote(data.currentQuote);
    }

    if (mode === "running") document.title = `${formatClock(remaining)} timer`;
    else if (mode === "paused") document.title = `${formatClock(remaining)} timer paused`;
    else if (mode === "overtime") document.title = `+${formatClock(Math.floor(over))} timer`;
    else document.title = "Time's up";

    if (data.pausedBy && data.notice && data.notice !== render.lastNotice) {
      render.lastNotice = data.notice;
      showNotice(data.notice);
    }
  }

  function startTicking() {
    if (tickTimer) return;
    tickTimer = window.setInterval(render, 250);
  }

  /* ---------- actions ---------- */

  async function start() {
    const sec = enteredSec();
    if (sec < 1) return;
    saveLast(sec);
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    const notices = await window.OneClock.pauseOthers("timer", "Timer");
    T().start(sec, displayedQuote());
    T().loadSettings().then((s) => window.FocusSounds?.start(s));
    loadQuote();
    if (notices.length) showNotice(notices.join(" "));
    render();
  }

  async function resume() {
    const notices = await window.OneClock.pauseOthers("timer", "Timer");
    T().resume();
    T().loadSettings().then((s) => window.FocusSounds?.start(s));
    loadQuote();
    if (notices.length) showNotice(notices.join(" "));
    render();
  }

  function stop() {
    const data = T().read();
    T().stop();
    if (data?.durationSec) fillFields(Number(data.durationSec));
    render();
  }

  function wire() {
    $("btnTimerStart").addEventListener("click", start);
    $("btnTimerPause").addEventListener("click", () => {
      T().pause();
      render();
    });
    $("btnTimerResume").addEventListener("click", resume);
    $("btnTimerStop").addEventListener("click", stop);
    $("btnTimerDismiss").addEventListener("click", stop);

    $("timerQuick").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-min]");
      if (btn) fillFields(Number(btn.dataset.min) * 60);
    });

    const entry = $("timerEntry");
    entry.addEventListener("focus", () => {
      entry.select();
      render();
    });
    entry.addEventListener("input", () => {
      entry.value = entry.value.replace(/[^\d:]/g, "").slice(0, 8);
      renderIdle();
    });
    entry.addEventListener("blur", () => {
      fillFields(parseEntry(entry.value) ?? entrySec);
      render();
    });
    entry.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        entry.blur();
        start();
      } else if (e.key === "Escape") {
        entry.value = formatClock(entrySec);
        entry.blur();
      }
    });

    window.addEventListener("muhurta-timer-done", (e) => {
      if (e.detail?.end === "stop") showNotice(`Time's up. ${e.detail.label} timer done.`);
    });
    T().onChange(render);
    document.addEventListener("visibilitychange", render);
  }

  function init() {
    const data = T().read();
    fillFields(data?.durationSec ? Number(data.durationSec) : readLast());
    if (data?.currentQuote) applyQuote(data.currentQuote);
    render.lastNotice = data?.notice || null; // shown already, before this load
    wire();
    render();
    startTicking();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
