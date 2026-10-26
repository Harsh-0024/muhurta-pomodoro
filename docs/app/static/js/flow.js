(function () {
  "use strict";

  const STORAGE_KEY = "muhurat_flow_session_v1";
  const baseTitle = "Muhurta Pomodoro";
  let tickTimer = null;
  let quoteLoadId = 0;
  let settings = null;
  let settingsPromise = null;
  let noticeTimer = null;

  const state = {
    mode: "idle",
    startedAt: null,
    runStartedAt: null,
    focusedSec: 0,
    currentQuote: null,
  };

  function api(path, opts) {
    return fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    }).then(async (res) => {
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return res.json();
    });
  }

  function loadSettings() {
    if (settings) return Promise.resolve(settings);
    if (!settingsPromise) {
      settingsPromise = api("/api/settings")
        .then((data) => {
          settings = data || {};
          return settings;
        })
        .catch(() => {
          settings = {};
          return settings;
        });
    }
    return settingsPromise;
  }

  function localDayISO(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function playWorkBeginChime() {
    loadSettings().then((current) => window.FocusSounds?.start(current));
  }

  function playWorkCompleteChime() {
    loadSettings().then((current) => window.FocusSounds?.workComplete(current));
  }

  function logFlowSegment(startedAt, endedAt) {
    const durationSec = Math.max(0, (endedAt - startedAt) / 1000);
    if (durationSec < 0.5) return;
    api("/api/activity/segment", {
      method: "POST",
      body: JSON.stringify({
        day: localDayISO(startedAt),
        kind: "flow",
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        duration_sec: durationSec,
        preset_id: "flow",
        preset_name: "Flow",
        details: { mode: "stopwatch" },
      }),
    }).catch(() => {});
  }

  function showNotice(message) {
    const el = document.getElementById("flowNotice");
    if (!el || !message) return;
    el.textContent = message;
    el.classList.remove("hidden");
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      el.classList.add("hidden");
      el.textContent = "";
    }, 5200);
  }

  function parseStored(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function pauseOthers() {
    const notices = await window.OneClock.pauseOthers("flow", "Flow");
    if (notices.length) showNotice(notices.join(" "));
  }

  function readStored() {
    try {
      return parseStored(localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return null;
    }
  }

  function persist() {
    try {
      if (state.mode === "idle") {
        localStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(STORAGE_KEY);
        return;
      }
      const payload = { ...state, savedAt: Date.now() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  function restore() {
    const saved = readStored();
    applyStoredFlow(saved, false);
  }

  function applyStoredFlow(saved, fromExternal) {
    if (!saved || !["running", "paused"].includes(saved.mode) || !saved.startedAt) return;
    state.mode = saved.mode;
    state.startedAt = Number(saved.startedAt) || null;
    state.runStartedAt = saved.mode === "running" ? Number(saved.runStartedAt || saved.savedAt || Date.now()) : null;
    state.focusedSec = Math.max(0, Number(saved.focusedSec || 0));
    state.currentQuote = saved.currentQuote || null;
    applyQuote(state.currentQuote);
    if (fromExternal && saved.notice) showNotice(saved.notice);
    render();
    if (state.mode === "running") startTicking();
    else if (state.mode === "paused") startTicking();
  }

  function formatDuration(sec, options = {}) {
    const rounded = Math.max(0, Math.floor(sec));
    const h = Math.floor(rounded / 3600);
    const m = Math.floor((rounded % 3600) / 60);
    const s = rounded % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    if (options.padded) return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function focusedSec() {
    const live = state.mode === "running" && state.runStartedAt ? (Date.now() - state.runStartedAt) / 1000 : 0;
    return state.focusedSec + live;
  }

  function elapsedSec() {
    return state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  }

  function productivity() {
    const elapsed = elapsedSec();
    if (!state.startedAt || elapsed < 0.5) return null;
    return Math.min(100, (focusedSec() / elapsed) * 100);
  }

  function readDisplayedQuote() {
    const quote = document.getElementById("flowQuoteText")?.textContent?.trim();
    const author = document.getElementById("flowQuoteAuthor")?.textContent?.trim();
    return quote && author ? { quote, author } : null;
  }

  function applyQuote(quote) {
    if (!quote?.quote || !quote?.author) return;
    const quoteEl = document.getElementById("flowQuoteText");
    const authorEl = document.getElementById("flowQuoteAuthor");
    if (!quoteEl || !authorEl) return;
    quoteEl.textContent = quote.quote;
    authorEl.textContent = quote.author;
  }

  async function loadQuote() {
    const loadId = ++quoteLoadId;
    const wrap = document.getElementById("flowQuote");
    try {
      const res = await api("/api/quote");
      if (loadId !== quoteLoadId || !res?.quote || !res?.author) return;
      wrap?.classList.add("is-updating");
      state.currentQuote = { quote: res.quote, author: res.author };
      applyQuote(state.currentQuote);
      persist();
      window.setTimeout(() => wrap?.classList.remove("is-updating"), 260);
    } catch (_) {}
  }

  function renderStats() {
    const focused = focusedSec();
    const elapsed = elapsedSec();
    const pct = productivity();
    const focusedEl = document.getElementById("flowFocusedDisplay");
    const elapsedEl = document.getElementById("flowElapsedDisplay");
    const productivityEl = document.getElementById("flowProductivityDisplay");
    if (focusedEl) focusedEl.textContent = formatDuration(focused);
    if (elapsedEl) elapsedEl.textContent = formatDuration(elapsed);
    if (productivityEl) productivityEl.textContent = pct == null ? "—" : `${pct.toFixed(1)}%`;
  }

  function renderTimer() {
    const timeEl = document.getElementById("flowTimeDisplay");
    const labelEl = document.getElementById("flowPhaseLabel");
    const hintEl = document.getElementById("flowHint");
    const wrap = document.getElementById("flowRingWrap");
    const focused = focusedSec();

    if (timeEl) timeEl.textContent = formatDuration(focused, { padded: true });
    if (labelEl) labelEl.textContent = state.mode === "paused" ? "Paused" : "Flow";
    if (hintEl) {
      if (state.mode === "idle") hintEl.textContent = "Start when ready";
      else if (state.mode === "paused") hintEl.textContent = "Pressure-free pause";
      else hintEl.textContent = "Open focus";
    }
    wrap?.classList.toggle("is-flowing", state.mode === "running");
  }

  function renderControls() {
    const start = document.getElementById("btnFlowStart");
    const pause = document.getElementById("btnFlowPause");
    const resume = document.getElementById("btnFlowResume");
    const stop = document.getElementById("btnFlowStop");
    start?.classList.toggle("hidden", state.mode !== "idle");
    pause?.classList.toggle("hidden", state.mode !== "running");
    resume?.classList.toggle("hidden", state.mode !== "paused");
    stop?.classList.toggle("hidden", state.mode === "idle");
  }

  function updateTitle() {
    if (state.mode === "idle") {
      document.title = baseTitle;
      return;
    }
    document.title = `${formatDuration(focusedSec(), { padded: true })} flow${state.mode === "paused" ? " paused" : ""}`;
  }

  function render() {
    renderStats();
    renderTimer();
    renderControls();
    updateTitle();
  }

  function startTicking() {
    stopTicking();
    tickTimer = window.setInterval(() => {
      render();
      persist();
    }, 250);
    render();
  }

  function stopTicking() {
    if (tickTimer) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  async function startFlow() {
    await pauseOthers();
    const now = Date.now();
    state.mode = "running";
    state.startedAt = now;
    state.runStartedAt = now;
    state.focusedSec = 0;
    state.currentQuote = readDisplayedQuote();
    playWorkBeginChime();
    loadQuote();
    startTicking();
    persist();
  }

  function pauseFlow() {
    if (state.mode !== "running") return;
    const now = Date.now();
    if (state.runStartedAt) {
      state.focusedSec += Math.max(0, (now - state.runStartedAt) / 1000);
      logFlowSegment(state.runStartedAt, now);
    }
    state.mode = "paused";
    state.runStartedAt = null;
    startTicking();
    render();
    persist();
  }

  async function resumeFlow() {
    if (state.mode !== "paused") return;
    await pauseOthers();
    state.mode = "running";
    state.runStartedAt = Date.now();
    playWorkBeginChime();
    loadQuote();
    startTicking();
    persist();
  }

  function stopFlow() {
    const now = Date.now();
    if (state.mode !== "idle") playWorkCompleteChime();
    if (state.mode === "running" && state.runStartedAt) {
      state.focusedSec += Math.max(0, (now - state.runStartedAt) / 1000);
      logFlowSegment(state.runStartedAt, now);
    }
    state.mode = "idle";
    state.startedAt = null;
    state.runStartedAt = null;
    state.focusedSec = 0;
    stopTicking();
    render();
    persist();
  }

  function wireControls() {
    document.getElementById("btnFlowStart")?.addEventListener("click", startFlow);
    document.getElementById("btnFlowPause")?.addEventListener("click", pauseFlow);
    document.getElementById("btnFlowResume")?.addEventListener("click", resumeFlow);
    document.getElementById("btnFlowStop")?.addEventListener("click", stopFlow);
    window.addEventListener("beforeunload", persist);
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      applyStoredFlow(parseStored(event.newValue), true);
    });
    document.addEventListener("visibilitychange", () => {
      render();
      persist();
    });
  }

  function init() {
    restore();
    loadSettings();
    wireControls();
    render();
    if (state.mode === "running") startTicking();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
