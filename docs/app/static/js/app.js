(function () {
  "use strict";

  const RING_LEN = 2 * Math.PI * 96;
  const baseTitle = "Muhurta Pomodoro";
  const SESSION_STORAGE_KEY = "muhurat_timer_session_v1";
  let noticeTimer = null;

  /** @type {ReturnType<typeof setInterval> | null} */
  let tickTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let statsTimer = null;
  /** @type {number | null} */
  let phaseEndsAt = null;
  // When the block that just ran out was due to end (kept for commitSegment).
  let lastPhaseDueAt = null;
  let quoteLoadId = 0;

  const state = {
    presets: [],
    settings: {},
    presetId: null,
    phaseIndex: 0,
    remainingSec: 0,
    running: false,
    lastMinuteBucket: null,
    /** idle | work | extend | rest | cumulative | work_choice | rest_choice | complete */
    mode: "idle",
    pendingRest: null,
    afterRestWorkIndex: null,
    resumeAfterPoolRest: null,
    extendBaseSec: 0,
    pauseStartedAt: null,
    currentQuote: null,
    restartAfterLevelChange: false,
    phaseNotificationKey: null,
    monitorNotifiedPhase: null,
    session: {
      active: false,
      startedAt: null,
      workSec: 0,
      extendSec: 0,
      restTakenSec: 0,
      poolSec: 0,
      extendPoolAccrued: 0,
      segStartedAt: null,
      segKind: null,
      segDurationSec: 0,
    },
  };

  function restAccrualRate(p) {
    const workSec = 4 * p.work_min * 60;
    const restSec = 3 * p.short_rest_min * 60 + p.long_rest_min * 60;
    return workSec > 0 ? restSec / workSec : 0;
  }

  function totalExtendSec() {
    const s = state.session;
    return s.extendSec + (s.segKind === "extend" ? liveSegmentElapsed() : 0);
  }

  function currentExtendSec() {
    return Math.max(0, totalExtendSec() - (state.extendBaseSec || 0));
  }

  function syncExtendPoolAccrual() {
    if (state.mode !== "extend") return;
    const p = currentPreset();
    if (!p) return;
    const rate = restAccrualRate(p);
    const extTotal = totalExtendSec();
    const target = extTotal * rate;
    const prev = state.session.extendPoolAccrued || 0;
    const delta = target - prev;
    if (delta > 0.001) {
      state.session.extendPoolAccrued = target;
      state.session.poolSec += delta;
    }
  }

  function persistSession() {
    if (window.__PAGE__ !== "home") return;
    if (!state.session.active && state.mode === "idle") {
      try {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch (_) {}
      return;
    }
    try {
      const payload = {
        presetId: state.presetId,
        phaseIndex: state.phaseIndex,
        remainingSec: state.remainingSec,
        running: state.running,
        mode: state.mode,
        pendingRest: state.pendingRest,
        afterRestWorkIndex: state.afterRestWorkIndex,
        resumeAfterPoolRest: state.resumeAfterPoolRest,
        extendBaseSec: state.extendBaseSec,
        pauseStartedAt: state.pauseStartedAt,
        currentQuote: state.currentQuote || readDisplayedQuote(),
        lastMinuteBucket: state.lastMinuteBucket,
        phaseEndsAt,
        phaseNotificationKey: state.phaseNotificationKey,
        monitorNotifiedPhase: state.monitorNotifiedPhase,
        session: {
          active: state.session.active,
          startedAt: state.session.startedAt,
          workSec: state.session.workSec,
          extendSec: state.session.extendSec,
          restTakenSec: state.session.restTakenSec,
          poolSec: state.session.poolSec,
          extendPoolAccrued: state.session.extendPoolAccrued,
          segKind: state.session.segKind,
          segDurationSec: state.session.segDurationSec,
          segStartedAt: state.session.segStartedAt,
        },
        savedAt: Date.now(),
      };
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  function parseStoredSession(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function readStoredSession() {
    const local = parseStoredSession(localStorage.getItem(SESSION_STORAGE_KEY));
    const session = parseStoredSession(sessionStorage.getItem(SESSION_STORAGE_KEY));
    if (!local) return session;
    if (!session) return local;
    return Number(session.savedAt || 0) > Number(local.savedAt || 0) ? session : local;
  }

  function restoreSession() {
    try {
      const data = readStoredSession();
      if (!data) return false;
      if (!data?.session?.active || !presetById(data.presetId)) return false;

      state.presetId = data.presetId;
      state.phaseIndex = data.phaseIndex ?? 0;
      state.mode = data.mode ?? "idle";
      state.pendingRest = data.pendingRest ?? null;
      state.afterRestWorkIndex = data.afterRestWorkIndex ?? null;
      state.resumeAfterPoolRest = data.resumeAfterPoolRest ?? null;
      state.extendBaseSec = data.extendBaseSec ?? 0;
      state.pauseStartedAt = data.pauseStartedAt ?? null;
      state.currentQuote = data.currentQuote ?? null;
      state.lastMinuteBucket = data.lastMinuteBucket ?? null;
      state.phaseNotificationKey = data.phaseNotificationKey ?? null;
      state.monitorNotifiedPhase = data.monitorNotifiedPhase ?? null;
      state.session = {
        active: true,
        startedAt: data.session.startedAt,
        workSec: data.session.workSec ?? 0,
        extendSec: data.session.extendSec ?? 0,
        restTakenSec: data.session.restTakenSec ?? 0,
        poolSec: data.session.poolSec ?? 0,
        extendPoolAccrued: data.session.extendPoolAccrued ?? 0,
        segKind: data.session.segKind,
        segDurationSec: data.session.segDurationSec ?? 0,
        segStartedAt: data.session.segStartedAt,
      };

      let restoredExpiredCountdown = false;
      if (state.mode === "extend") {
        state.remainingSec = data.remainingSec ?? 0;
        state.running = !!data.running;
        phaseEndsAt = null;
      } else if (data.running && data.phaseEndsAt) {
        const left = (data.phaseEndsAt - Date.now()) / 1000;
        if (left <= 0 && ["work", "rest", "cumulative"].includes(state.mode)) {
          state.remainingSec = 0;
          state.running = false;
          phaseEndsAt = null;
          restoredExpiredCountdown = true;
        } else {
          state.remainingSec = left;
          state.running = true;
          phaseEndsAt = data.phaseEndsAt;
        }
      } else {
        state.remainingSec = data.remainingSec ?? 0;
        state.running = false;
        phaseEndsAt = null;
      }

      syncLevelSelect();
      applyQuote(state.currentQuote);

      if (state.session.segStartedAt && state.session.segKind && !restoredExpiredCountdown) {
        const pausedMs = Date.now() - data.savedAt;
        if (!state.running && pausedMs > 0) {
          state.session.segStartedAt += pausedMs;
        }
      }

      ensureStatsLoop();
      applyBodyPhaseClass();
      updateAll();

      if (state.running) startTicking();
      else if (state.mode === "extend") syncExtendPoolAccrual();

      if (state.remainingSec <= 0 && ["work", "rest", "cumulative"].includes(state.mode)) {
        setTimeout(() => onTimerElapsed(), 50);
      } else if (state.mode === "work_choice" && state.pendingRest) {
        showWorkChoices(true);
      } else if (state.mode === "rest_choice") {
        showRestChoices(true);
      } else if (state.mode === "complete") {
        showCycleComplete(true);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function setupIdleTimer() {
    const p = currentPreset();
    if (!p) return;
    state.phaseIndex = 0;
    state.mode = "idle";
    state.remainingSec = phaseDurationSec(p, 0);
    state.running = false;
    state.pendingRest = null;
    state.afterRestWorkIndex = null;
    state.resumeAfterPoolRest = null;
    state.extendBaseSec = 0;
    state.pauseStartedAt = null;
    state.currentQuote = readDisplayedQuote();
    disarmPhaseEnd();
    applyBodyPhaseClass();
    updateAll();
  }

  async function api(path, opts) {
    const r = await fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(t || r.statusText);
    }
    if (r.status === 204) return null;
    return r.json();
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function presetById(id) {
    return state.presets.find((p) => p.id === id) || null;
  }

  function currentPreset() {
    return presetById(state.presetId);
  }

  function phaseKind(i) {
    const p = currentPreset();
    if (p && i === lastRestIndex(p)) return "long";
    if (i % 2 === 0) return "work";
    return "short";
  }

  function workCycleCount(p) {
    return Math.max(1, Number(p?.work_cycles || 4));
  }

  function lastWorkIndex(p) {
    return (workCycleCount(p) - 1) * 2;
  }

  function lastRestIndex(p) {
    return lastWorkIndex(p) + 1;
  }

  function isFinalWorkIndex(i) {
    const p = currentPreset();
    return !!p && i === lastWorkIndex(p);
  }

  function isFinalRestIndex(i) {
    const p = currentPreset();
    return !!p && i === lastRestIndex(p);
  }

  function phaseDurationSec(p, i) {
    const k = phaseKind(i);
    if (k === "work") return p.work_min * 60;
    if (k === "short") return p.short_rest_min * 60;
    return p.long_rest_min * 60;
  }

  function restIndexAfterWork(workIndex) {
    return workIndex + 1;
  }

  function workIndexAfterRest(restIndex) {
    const p = currentPreset();
    const next = restIndex + 1;
    return p && next <= lastWorkIndex(p) ? next : 0;
  }

  function workIndexAfterSkipRest(workIndex) {
    const p = currentPreset();
    const next = workIndex + 2;
    return p && next <= lastWorkIndex(p) ? next : 0;
  }

  function workBlockNumber(i) {
    if (phaseKind(i) !== "work") return null;
    return i / 2 + 1;
  }

  function formatClock(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function formatPool(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function breakTitle(kind) {
    return kind === "long" ? "Long break" : "Short break";
  }

  function nextFocusIndex() {
    if (state.afterRestWorkIndex != null) return state.afterRestWorkIndex;
    return workIndexAfterRest(state.phaseIndex);
  }

  function nextFocusDurationSec() {
    const p = currentPreset();
    return p ? phaseDurationSec(p, nextFocusIndex()) : 0;
  }

  function playWorkCompleteChime() {
    window.FocusSounds?.workComplete(state.settings);
  }

  function playBreakCompleteChime() {
    window.FocusSounds?.breakComplete(state.settings);
  }

  function playWorkBeginChime() {
    window.FocusSounds?.start(state.settings);
  }

  function playMinutePulse() {
    window.FocusSounds?.tick(state.settings);
  }

  function playChoiceChime() {
    window.FocusSounds?.choice(state.settings);
  }

  function playPoolChime() {
    window.FocusSounds?.poolAdd(state.settings);
  }

  function playSkipChime() {
    window.FocusSounds?.skip(state.settings);
  }

  function primeAudio() {
    window.FocusSounds?.prime(state.settings);
  }

  async function requestNotifyPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") await Notification.requestPermission();
  }

  function notify(title, body) {
    if (!state.settings.notifications_enabled) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    try {
      new Notification(title, { body, silent: true });
    } catch (_) {}
  }

  function logWorkBlock(minutes) {
    return api("/api/focus/log", {
      method: "POST",
      body: JSON.stringify({ day: todayISO(), minutes }),
    }).catch(() => {});
  }

  function localDayISO(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function showTimerNotice(message) {
    const el = document.getElementById("timerNotice");
    if (!el || !message) return;
    el.textContent = message;
    el.classList.remove("hidden");
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      el.classList.add("hidden");
      el.textContent = "";
    }, 5200);
  }

  function pauseOthers() {
    window.OneClock.pauseOthers("rhythm", "Rhythm").then((notices) => {
      if (notices.length) showTimerNotice(notices.join(" "));
    });
  }

  function logActivitySegment(kind, startedAt, endedAt, details = {}) {
    const duration = Math.max(0, (endedAt - startedAt) / 1000);
    if (duration < 0.5) return Promise.resolve();
    const p = currentPreset();
    return api("/api/activity/segment", {
      method: "POST",
      body: JSON.stringify({
        day: localDayISO(startedAt),
        kind,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        duration_sec: duration,
        preset_id: state.presetId,
        preset_name: p?.name || "",
        phase_index: state.phaseIndex,
        details,
      }),
    }).catch(() => {});
  }

  function ensureSession() {
    const s = state.session;
    if (!s.active) {
      s.active = true;
      s.startedAt = Date.now();
    }
    ensureStatsLoop();
  }

  function ensureStatsLoop() {
    if (statsTimer) return;
    statsTimer = setInterval(() => {
      if (!state.session.active) {
        if (statsTimer) clearInterval(statsTimer);
        statsTimer = null;
        return;
      }
      renderLiveStats();
      if (state.mode === "extend") {
        if (state.running && !tickTimer) startTicking();
        repaintExtendFocus();
        persistSession();
      }
    }, 200);
  }

  function stopStatsLoop() {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  }

  function commitSegment() {
    const s = state.session;
    if (!s.segStartedAt || !s.segKind) return;
    if (s.segKind === "extend") syncExtendPoolAccrual();
    const startedAt = s.segStartedAt;
    const completedTimedSegment =
      s.segDurationSec > 0 &&
      state.remainingSec <= 0 &&
      (s.segKind === "work" || s.segKind === "rest" || s.segKind === "cumulative");
    let endedAt = Date.now();
    if (completedTimedSegment) {
      // A finished block ends when it was due, never later. After a pause the
      // part still to run is shorter than the full block, so "start + full
      // length" would run past the real end into whatever came next.
      endedAt = Math.min(startedAt + s.segDurationSec * 1000, lastPhaseDueAt || Date.now());
    }
    lastPhaseDueAt = null;
    const elapsed = Math.max(0, (endedAt - startedAt) / 1000);
    if (s.segKind === "work") s.workSec += elapsed;
    else if (s.segKind === "extend") s.extendSec += elapsed;
    else if (s.segKind === "rest" || s.segKind === "cumulative") s.restTakenSec += elapsed;
    logActivitySegment(s.segKind, startedAt, endedAt, {
      duration_sec: s.segDurationSec,
    });
    s.segStartedAt = null;
    s.segKind = null;
    s.segDurationSec = 0;
    persistSession();
  }

  function commitPauseSegment() {
    if (!state.pauseStartedAt) return;
    const startedAt = state.pauseStartedAt;
    const endedAt = Date.now();
    const elapsed = Math.max(0, (endedAt - startedAt) / 1000);
    state.session.restTakenSec += elapsed;
    state.pauseStartedAt = null;
    logActivitySegment("pause", startedAt, endedAt);
    persistSession();
  }

  function startSegment(kind, durationSec) {
    const s = state.session;
    s.segKind = kind;
    s.segStartedAt = Date.now();
    s.segDurationSec = durationSec || 0;
  }

  function liveSegmentElapsed() {
    const s = state.session;
    if (!s.segStartedAt || !s.segKind) return 0;
    return (Date.now() - s.segStartedAt) / 1000;
  }

  function completedWorkFloorSec() {
    const p = currentPreset();
    if (!p) return 0;
    const maxBlocks = workCycleCount(p);
    let blocks = 0;

    if (state.mode === "complete") {
      blocks = maxBlocks;
    } else if (
      state.pendingRest &&
      state.pendingRest.workIndex != null &&
      (state.mode === "work_choice" || state.mode === "rest" || state.mode === "extend")
    ) {
      blocks = Math.floor(state.pendingRest.workIndex / 2) + 1;
    } else if (state.mode === "rest") {
      blocks = Math.floor(state.phaseIndex / 2) + 1;
    } else if (
      (state.mode === "rest_choice" || (state.mode === "cumulative" && !state.resumeAfterPoolRest)) &&
      state.afterRestWorkIndex != null
    ) {
      blocks = Math.floor(state.afterRestWorkIndex / 2);
    } else if (state.mode === "work" || state.mode === "cumulative") {
      blocks = Math.floor(state.phaseIndex / 2);
    }

    return Math.max(0, Math.min(maxBlocks, blocks)) * p.work_min * 60;
  }

  function liveWorkSec() {
    const s = state.session;
    const completed = Math.max(s.workSec + s.extendSec, completedWorkFloorSec());
    const k = s.segKind;
    const live = k === "work" || k === "extend" ? liveSegmentElapsed() : 0;
    return completed + live;
  }

  function sessionElapsedSec() {
    const s = state.session;
    if (!s.active || !s.startedAt) return 0;
    return (Date.now() - s.startedAt) / 1000;
  }

  function productivityPct() {
    const elapsed = sessionElapsedSec();
    if (elapsed < 0.5) return null;
    return Math.min(100, (liveWorkSec() / elapsed) * 100);
  }

  function addToPool(sec, chime) {
    const add = Math.max(0, sec);
    if (add <= 0) return;
    state.session.poolSec += add;
    if (chime !== false) playPoolChime();
    renderLiveStats();
    persistSession();
  }

  function renderLiveStats() {
    if (state.mode === "extend") syncExtendPoolAccrual();
    const poolEl = document.getElementById("poolDisplay");
    const workEl = document.getElementById("workDisplay");
    const prodEl = document.getElementById("productivityDisplay");
    if (poolEl) poolEl.textContent = formatPool(state.session.poolSec);
    if (workEl) workEl.textContent = formatPool(liveWorkSec());
    if (prodEl) {
      const p = productivityPct();
      prodEl.textContent = p === null ? "—" : `${p.toFixed(1)}%`;
    }
    updateControlVisibility();
  }

  function syncRemainingFromClock() {
    if (!state.running || !phaseEndsAt) return;
    state.remainingSec = Math.max(0, (phaseEndsAt - Date.now()) / 1000);
  }

  function reconcileTimedPhaseFromClock() {
    if (!state.running || !["work", "rest", "cumulative"].includes(state.mode)) return false;
    syncRemainingFromClock();
    if (state.remainingSec > 0) return false;
    onTimerElapsed();
    return true;
  }

  function armPhaseEnd() {
    phaseEndsAt = Date.now() + state.remainingSec * 1000;
    state.phaseNotificationKey = `${state.mode}:${state.phaseIndex}:${Math.round(phaseEndsAt)}`;
  }

  function disarmPhaseEnd() {
    phaseEndsAt = null;
  }

  function phaseAlreadyChimed() {
    return !!state.phaseNotificationKey && state.monitorNotifiedPhase === state.phaseNotificationKey;
  }

  function applyBodyPhaseClass() {
    document.body.classList.remove(
      "rest-short",
      "rest-long",
      "focus-work",
      "mode-extend",
      "mode-choice",
      "mode-cumulative",
      "mode-complete"
    );
    if (state.mode === "complete") {
      document.body.classList.add("mode-choice", "mode-complete");
      return;
    }
    if (state.mode === "work_choice") {
      document.body.classList.add("mode-choice");
      const k = state.pendingRest?.kind;
      if (k === "short") document.body.classList.add("rest-short");
      else if (k === "long") document.body.classList.add("rest-long");
      return;
    }
    if (state.mode === "rest_choice") {
      document.body.classList.add("mode-choice", "focus-work");
      return;
    }
    if (state.mode === "extend") {
      document.body.classList.add("focus-work", "mode-extend");
      return;
    }
    if (state.mode === "cumulative") {
      document.body.classList.add("rest-short", "mode-cumulative");
      return;
    }
    const k =
      state.mode === "rest"
        ? state.pendingRest?.kind || phaseKind(state.phaseIndex)
        : phaseKind(state.phaseIndex);
    if (k === "short" || (state.mode === "rest" && state.pendingRest?.kind === "short"))
      document.body.classList.add("rest-short");
    else if (k === "long") document.body.classList.add("rest-long");
    else if (state.mode === "work" || state.mode === "idle") document.body.classList.add("focus-work");
  }

  function updateRing() {
    const el = document.getElementById("ringProgress");
    const wrap = document.querySelector(".timer-ring-wrap");
    if (!el) return;
    if (state.mode === "extend") {
      el.style.strokeDashoffset = "0";
      wrap?.classList.add("ring-extend");
      return;
    }
    wrap?.classList.remove("ring-extend");
    if (
      (state.mode === "work_choice" && state.pendingRest) ||
      state.mode === "rest_choice"
    ) {
      el.style.strokeDashoffset = "0";
      return;
    }
    if (state.mode === "work_choice" || state.mode === "rest_choice") {
      el.style.strokeDashoffset = String(RING_LEN);
      return;
    }
    const p = currentPreset();
    if (!p) return;
    let total = state.remainingSec;
    if (state.mode === "work" || state.mode === "rest" || state.mode === "cumulative") {
      total = state.session.segDurationSec || phaseDurationSec(p, state.phaseIndex);
    }
    const frac = total > 0 ? 1 - state.remainingSec / total : 0;
    el.style.strokeDashoffset = String(RING_LEN * (1 - Math.min(1, Math.max(0, frac))));
  }

  function updateLabels() {
    const p = currentPreset();
    const phase = document.getElementById("phaseLabel");
    const hint = document.getElementById("cycleHint");
    if (!p || !phase || !hint) return;

    if (state.mode === "extend") {
      phase.textContent = "Extended focus";
      hint.textContent = "";
      hint.classList.add("hidden");
      return;
    }
    hint.classList.remove("hidden");
    if (state.mode === "complete") {
      phase.textContent = "Complete";
      hint.textContent = `${p.name} finished`;
      return;
    }
    if (state.mode === "work_choice") {
      phase.textContent = state.pendingRest ? breakTitle(state.pendingRest.kind) : "Break";
      hint.textContent = "Focus complete";
      return;
    }
    if (state.mode === "rest_choice") {
      const next = nextFocusIndex();
      const pool = formatPool(state.session.poolSec);
      phase.textContent = "Deep work";
      hint.textContent =
        state.session.poolSec >= 1
          ? `${pool} in pool`
          : `Session ${workBlockNumber(next) || 1} of ${workCycleCount(p)} · ${p.name}`;
      return;
    }
    if (state.mode === "cumulative") {
      phase.textContent = "Cumulative rest";
      hint.textContent = "Deferred time, taken together";
      return;
    }

    const k = state.mode === "rest" ? state.pendingRest?.kind || phaseKind(state.phaseIndex) : phaseKind(state.phaseIndex);
    if (k === "work" || state.mode === "work") {
      const n = workBlockNumber(state.phaseIndex);
      phase.textContent = "Deep work";
      hint.textContent = `Session ${n} of ${workCycleCount(p)} · ${p.name}`;
    } else if (k === "short") {
      phase.textContent = "Short rest";
      hint.textContent = `${p.name} · breathe`;
    } else {
      phase.textContent = "Long rest";
      hint.textContent = `${p.name} · cycle pause`;
    }
  }

  function updateTimeDisplay() {
    const td = document.getElementById("timeDisplay");
    if (!td) return;
    if (state.mode === "extend") {
      td.textContent = `+${formatClock(currentExtendSec())}`;
      td.classList.add("time-extend");
      return;
    }
    td.classList.remove("time-extend");
    if (state.mode === "work_choice" && state.pendingRest) {
      td.textContent = formatClock(state.pendingRest.sec);
      return;
    }
    if (state.mode === "rest_choice") {
      td.textContent = formatClock(nextFocusDurationSec());
      return;
    }
    td.textContent = formatClock(state.remainingSec);
  }

  function updateDocumentTitle() {
    if (window.__PAGE__ !== "home") {
      document.title = baseTitle;
      return;
    }
    if (state.mode === "extend") {
      document.title = `+${formatClock(currentExtendSec())} focus`;
      return;
    }
    if (state.mode === "work_choice" && state.pendingRest) {
      document.title = `${formatClock(state.pendingRest.sec)} break`;
      return;
    }
    if (state.mode === "rest_choice") {
      document.title = `${formatClock(nextFocusDurationSec())} focus`;
      return;
    }
    if (state.mode === "complete") {
      document.title = "done";
      return;
    }
    if (!state.running && state.mode !== "idle") {
      document.title = `${formatClock(state.remainingSec)} paused`;
      return;
    }
    const suffix =
      state.mode === "work" || state.mode === "idle" ? "focus" : "rest";
    document.title = `${formatClock(state.remainingSec)} ${suffix}`;
  }

  function repaintExtendFocus() {
    if (state.mode !== "extend") return;
    updateTimeDisplay();
    updateRing();
    updateDocumentTitle();
    updateLabels();
  }

  function askConfirm(options) {
    if (window.MuhurataDialog?.confirm) return window.MuhurataDialog.confirm(options);
    return Promise.resolve(window.confirm(options?.message || options?.title || "Continue?"));
  }

  function readDisplayedQuote() {
    const quote = document.getElementById("quoteText")?.textContent?.trim();
    const author = document.getElementById("quoteAuthor")?.textContent?.trim();
    return quote && author ? { quote, author } : null;
  }

  function applyQuote(quote) {
    if (!quote?.quote || !quote?.author) return;
    const quoteEl = document.getElementById("quoteText");
    const authorEl = document.getElementById("quoteAuthor");
    if (!quoteEl || !authorEl) return;
    quoteEl.textContent = quote.quote;
    authorEl.textContent = quote.author;
  }

  async function loadQuote() {
    const loadId = ++quoteLoadId;
    const wrap = document.getElementById("focusQuote");
    const quoteEl = document.getElementById("quoteText");
    const authorEl = document.getElementById("quoteAuthor");
    if (!quoteEl || !authorEl) return;
    try {
      const res = await api("/api/quote");
      if (loadId !== quoteLoadId) return;
      if (!res?.quote || !res?.author) return;
      wrap?.classList.add("is-updating");
      state.currentQuote = { quote: res.quote, author: res.author };
      applyQuote(state.currentQuote);
      wrap?.classList.remove("is-loading");
      persistSession();
      window.setTimeout(() => wrap?.classList.remove("is-updating"), 260);
    } catch (_) {}
  }

  function setChoicePanel(visible, prompt, actions, options = {}) {
    const panel = document.getElementById("choicePanel");
    const promptEl = document.getElementById("choicePrompt");
    const actionsEl = document.getElementById("choiceActions");
    if (!panel || !promptEl || !actionsEl) return;
    panel.classList.toggle("hidden", !visible);
    const useEqualActions = visible && !!options.equalActions;
    actionsEl.classList.toggle("choice-actions-equal", useEqualActions);
    if (useEqualActions) {
      actionsEl.style.setProperty("--choice-action-count", String(actions.length));
      actionsEl.style.setProperty(
        "--choice-actions-width",
        actions.length <= 2 ? "18.6rem" : "28rem"
      );
    } else {
      actionsEl.style.removeProperty("--choice-action-count");
      actionsEl.style.removeProperty("--choice-actions-width");
    }
    if (!visible) {
      actionsEl.innerHTML = "";
      promptEl.textContent = "";
      promptEl.classList.add("hidden");
      panel.removeAttribute("aria-label");
      return;
    }
    promptEl.textContent = prompt;
    promptEl.classList.toggle("hidden", !prompt);
    if (prompt) {
      panel.setAttribute("aria-labelledby", "choicePrompt");
      panel.removeAttribute("aria-label");
    } else {
      panel.removeAttribute("aria-labelledby");
      panel.setAttribute("aria-label", "Rhythm choices");
    }
    actionsEl.innerHTML = "";
    actions.forEach(({ label, primary, onClick, disabled }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = primary ? "btn btn-primary" : "btn btn-quiet";
      btn.textContent = label;
      btn.disabled = !!disabled;
      if (!disabled) {
        btn.addEventListener("click", () => {
          hideChoices();
          onClick();
        });
      }
      actionsEl.appendChild(btn);
    });
  }

  function hideChoices() {
    setChoicePanel(false, "", []);
    document.getElementById("mainControls")?.classList.remove("hidden");
  }

  function showWorkChoices(silent) {
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    state.mode = "work_choice";
    const pr = state.pendingRest;
    if (!silent) playChoiceChime();
    setChoicePanel(
      true,
      "",
      [
        { label: "Extend", primary: false, onClick: () => chooseExtendFocus() },
        { label: "Rest", primary: true, onClick: () => chooseStartRest() },
        { label: "Skip", primary: false, onClick: () => chooseSkipRest() },
      ],
      { equalActions: true }
    );
    applyBodyPhaseClass();
    updateLabels();
    updateRing();
    updateTimeDisplay();
    updateDocumentTitle();
    updateControlVisibility();
    renderLiveStats();
  }

  function showRestChoices(silent) {
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    state.mode = "rest_choice";
    const pool = state.session.poolSec;
    if (!silent) playChoiceChime();
    const actions = [
      { label: "Start focus", primary: true, onClick: () => chooseStartNextFocus() },
    ];
    if (pool >= 1) {
      actions.push({
        label: "Pool rest",
        primary: false,
        onClick: () => chooseCumulativeRest(),
      });
    }
    setChoicePanel(true, "", actions, { equalActions: true });
    applyBodyPhaseClass();
    updateLabels();
    updateRing();
    updateTimeDisplay();
    updateDocumentTitle();
    updateControlVisibility();
    renderLiveStats();
  }

  function showCycleComplete(silent) {
    const p = currentPreset();
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    state.mode = "complete";
    state.pendingRest = null;
    state.afterRestWorkIndex = null;
    state.resumeAfterPoolRest = null;
    if (!silent) {
      playChoiceChime();
      notify("Cycle complete", p ? `${p.name} complete.` : "Session complete.");
    }
    setChoicePanel(true, p ? `${p.name} complete` : "Cycle complete", [
      { label: "Done", primary: false, onClick: () => resetSession() },
      { label: "Start next cycle", primary: true, onClick: () => startNextCycle() },
      { label: "Change level", primary: false, onClick: () => chooseLevelAndRestart() },
    ]);
    applyBodyPhaseClass();
    updateLabels();
    updateRing();
    updateTimeDisplay();
    updateDocumentTitle();
    updateControlVisibility();
    renderLiveStats();
    persistSession();
  }

  function buildPendingRest(workIndex) {
    const p = currentPreset();
    if (!p) return null;
    const ri = restIndexAfterWork(workIndex);
    const kind = phaseKind(ri);
    return { sec: phaseDurationSec(p, ri), kind, restIndex: ri, workIndex };
  }

  function onWorkBlockComplete(fromEarlyEnd) {
    const p = currentPreset();
    if (!p) return;
    ensureSession();
    commitSegment();
    if (!phaseAlreadyChimed()) playWorkCompleteChime();
    logWorkBlock(p.work_min);

    state.pendingRest = buildPendingRest(state.phaseIndex);
    if (state.settings.auto_start_break && state.pendingRest) {
      const restName = state.pendingRest.kind === "long_rest" ? "long rest" : "short rest";
      notify("Focus complete", `${p.name} · starting ${restName}.`);
      chooseStartRest();
      return;
    }
    notify("Focus complete", `${p.name} · extending focus until rest.`);
    startExtendFocus(false);
  }

  function onRestComplete() {
    const p = currentPreset();
    if (!p) return;
    commitSegment();
    if (!phaseAlreadyChimed()) playBreakCompleteChime();
    if (state.resumeAfterPoolRest) {
      notify("Pool rest complete", "Resume focus when ready.");
      restoreInterruptedFocus(false);
      return;
    }

    if (state.mode === "cumulative") {
      if (state.afterRestWorkIndex == null) {
        state.afterRestWorkIndex = workIndexAfterRest(state.phaseIndex);
      }
      if (state.settings.auto_start_work) chooseStartNextFocus();
      else {
        notify("Pool rest complete", "Start focus when ready.");
        showRestChoices();
      }
      return;
    }

    if (state.pendingRest) {
      state.afterRestWorkIndex = workIndexAfterRest(state.pendingRest.restIndex);
    }

    state.pendingRest = null;
    if (!state.settings.auto_start_work && state.session.poolSec >= 1) {
      notify("Rest complete", "Starting pooled rest.");
      chooseCumulativeRest();
      return;
    }
    if (isFinalRestIndex(state.phaseIndex)) {
      showCycleComplete();
      return;
    }
    if (state.settings.auto_start_work) {
      notify("Rest complete", "Starting next focus.");
      chooseStartNextFocus();
    } else {
      notify("Rest complete", "Start focus when ready.");
      showRestChoices();
    }
  }

  function chooseStartRest() {
    const pr = state.pendingRest;
    if (!pr) return;
    ensureSession();
    state.phaseIndex = pr.restIndex;
    state.mode = "rest";
    state.remainingSec = pr.sec;
    state.pendingRest = { ...pr };
    startSegment("rest", pr.sec);
    startCountdown(true);
    applyBodyPhaseClass();
  }

  function chooseExtendFocus() {
    startExtendFocus(true);
  }

  function startExtendFocus(playBeginSound) {
    const pr = state.pendingRest;
    if (!pr) return;
    pauseOthers();
    ensureSession();
    state.extendBaseSec = state.session.extendSec;
    state.mode = "extend";
    state.running = true;
    disarmPhaseEnd();
    startSegment("extend", 0);
    if (playBeginSound) playWorkBeginChime();
    startTicking();
    applyBodyPhaseClass();
    updateAll();
    persistSession();
  }

  function chooseSkipRest() {
    const pr = state.pendingRest;
    if (!pr) return;
    addToPool(pr.sec);
    playSkipChime();
    state.pendingRest = null;
    if (isFinalWorkIndex(pr.workIndex)) {
      startNextCycleAfterSkippedRest();
      return;
    }
    state.phaseIndex = workIndexAfterSkipRest(pr.workIndex);
    beginWork(true);
  }

  function skipRestFromExtend() {
    if (state.mode !== "extend") return;
    syncExtendPoolAccrual();
    commitSegment();
    const pr = state.pendingRest;
    if (!pr) return;
    playWorkCompleteChime();
    addToPool(pr.sec, false);
    playSkipChime();
    state.pendingRest = null;
    if (isFinalWorkIndex(pr.workIndex)) {
      startNextCycleAfterSkippedRest();
      return;
    }
    state.phaseIndex = workIndexAfterSkipRest(pr.workIndex);
    beginWork(true);
  }

  function chooseStartNextFocus() {
    const wi = state.afterRestWorkIndex;
    if (wi == null) return;
    state.phaseIndex = wi;
    state.afterRestWorkIndex = null;
    beginWork(true);
  }

  function chooseCumulativeRest() {
    const pool = state.session.poolSec;
    if (pool < 1) return;
    ensureSession();
    if (state.afterRestWorkIndex == null && state.pendingRest) {
      state.afterRestWorkIndex = workIndexAfterRest(state.pendingRest.restIndex);
    }
    state.pendingRest = null;
    state.session.poolSec = 0;
    renderLiveStats();
    state.mode = "cumulative";
    state.remainingSec = pool;
    startSegment("cumulative", pool);
    startCountdown(true);
  }

  function takePoolRestNow() {
    const pool = state.session.poolSec;
    if (pool < 1 || state.mode === "cumulative" || state.mode === "complete") return;
    if (state.mode === "work_choice" || state.mode === "rest_choice") return;
    if (state.mode === "rest") return;

    syncRemainingFromClock();
    const interruptedDuration =
      state.session.segDurationSec ||
      (state.mode === "work" ? phaseDurationSec(currentPreset(), state.phaseIndex) : state.remainingSec);
    if (state.session.segStartedAt) commitSegment();
    state.resumeAfterPoolRest = {
      mode: state.mode,
      phaseIndex: state.phaseIndex,
      remainingSec: state.remainingSec,
      segDurationSec: interruptedDuration,
      pendingRest: state.pendingRest ? { ...state.pendingRest } : null,
      afterRestWorkIndex: state.afterRestWorkIndex,
      extendBaseSec: state.extendBaseSec,
    };
    state.session.poolSec = 0;
    state.mode = "cumulative";
    state.running = true;
    state.remainingSec = pool;
    startSegment("cumulative", pool);
    startCountdown(true);
    applyBodyPhaseClass();
  }

  function restoreInterruptedFocus(autoRun) {
    const saved = state.resumeAfterPoolRest;
    state.resumeAfterPoolRest = null;
    if (!saved || saved.mode === "idle") {
      setupIdleTimer();
      return;
    }
    state.mode = saved.mode;
    state.phaseIndex = saved.phaseIndex;
    state.remainingSec = saved.remainingSec;
    state.pendingRest = saved.pendingRest;
    state.afterRestWorkIndex = saved.afterRestWorkIndex;
    state.extendBaseSec = saved.extendBaseSec ?? state.extendBaseSec ?? 0;
    state.running = !!autoRun;
    state.pauseStartedAt = autoRun ? null : Date.now();
    if (state.mode === "extend") {
      if (autoRun) {
        startSegment("extend", 0);
        playWorkBeginChime();
        startTicking();
      } else {
        disarmPhaseEnd();
        stopTicking();
      }
      updateAll();
      return;
    }
    if (state.mode === "work") {
      if (autoRun) {
        startSegment("work", saved.segDurationSec || phaseDurationSec(currentPreset(), state.phaseIndex));
        playWorkBeginChime();
        startCountdown(true);
      } else {
        disarmPhaseEnd();
        stopTicking();
        updateAll();
      }
      applyBodyPhaseClass();
      return;
    }
    setupIdleTimer();
  }

  function startNextCycle() {
    hideChoices();
    state.phaseIndex = 0;
    state.pendingRest = null;
    state.afterRestWorkIndex = null;
    state.resumeAfterPoolRest = null;
    state.restartAfterLevelChange = false;
    beginWork(true);
  }

  function startNextCycleAfterSkippedRest() {
    notify("Rest skipped", "Next cycle started.");
    state.phaseIndex = 0;
    state.pendingRest = null;
    state.afterRestWorkIndex = null;
    state.resumeAfterPoolRest = null;
    state.restartAfterLevelChange = false;
    beginWork(true);
  }

  function chooseLevelAndRestart() {
    state.restartAfterLevelChange = true;
    setChoicePanel(true, "Choose a level", [
      { label: "Done", primary: false, onClick: () => resetSession() },
    ]);
    toggleLevelMenu();
    document.getElementById("levelButton")?.focus();
  }

  function beginRestFromExtend() {
    syncExtendPoolAccrual();
    commitSegment();
    const pr = state.pendingRest;
    if (!pr) return;
    playWorkCompleteChime();
    state.mode = "rest";
    state.phaseIndex = pr.restIndex;
    state.remainingSec = pr.sec;
    state.pendingRest = { ...pr };
    startSegment("rest", pr.sec);
    startCountdown(true);
    applyBodyPhaseClass();
  }

  function beginWork(autoRun) {
    const p = currentPreset();
    if (!p) return;
    ensureSession();
    loadQuote();
    state.mode = "work";
    state.remainingSec = phaseDurationSec(p, state.phaseIndex);
    state.pendingRest = null;
    state.extendBaseSec = state.session.extendSec;
    startSegment("work", state.remainingSec);
    if (autoRun) {
      playWorkBeginChime();
      startCountdown(true);
    }
    else {
      state.running = false;
      disarmPhaseEnd();
      updateAll();
    }
  }

  function startCountdown(run) {
    if (run) pauseOthers();
    state.running = run;
    if (run) {
      armPhaseEnd();
      state.lastMinuteBucket = Math.floor(state.remainingSec / 60);
      startTicking();
    } else {
      disarmPhaseEnd();
      stopTicking();
    }
    updateControlVisibility();
    updateAll();
  }

  function pauseTimer() {
    if (state.running) {
      syncRemainingFromClock();
      commitSegment();
      state.pauseStartedAt = Date.now();
    }
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    updateControlVisibility();
    updateAll();
  }

  function resumeTimer() {
    requestNotifyPermission();
    primeAudio();
    commitPauseSegment();
    if (state.mode === "extend") {
      if (!state.session.segStartedAt) startSegment("extend", 0);
      state.running = true;
      startTicking();
    } else if (state.mode === "work" || state.mode === "rest" || state.mode === "cumulative") {
      if (!state.session.segStartedAt) {
        const kind =
          state.mode === "work" ? "work" : state.mode === "cumulative" ? "cumulative" : "rest";
        const p = currentPreset();
        const duration =
          state.mode === "work"
            ? phaseDurationSec(p, state.phaseIndex)
            : state.mode === "rest"
              ? state.pendingRest?.sec || phaseDurationSec(p, state.phaseIndex)
              : state.remainingSec;
        startSegment(kind, duration);
      }
      if (state.remainingSec <= 0) {
        const p = currentPreset();
        if (p && state.mode === "work")
          state.remainingSec = phaseDurationSec(p, state.phaseIndex);
      }
      startCountdown(true);
    } else if (state.mode === "idle") {
      beginWork(true);
    }
    updateControlVisibility();
    updateAll();
  }

  function skipRemainingRest() {
    if (state.mode !== "rest" && state.mode !== "cumulative") return;
    syncRemainingFromClock();
    commitSegment();
    addToPool(state.remainingSec);
    playSkipChime();
    state.remainingSec = 0;
    disarmPhaseEnd();
    stopTicking();

    if (state.resumeAfterPoolRest) {
      notify("Pool rest skipped", "Focus resumed.");
      restoreInterruptedFocus(true);
      return;
    }

    let nextWork;
    if (state.mode === "cumulative") {
      nextWork = state.afterRestWorkIndex ?? 0;
    } else if (state.pendingRest) {
      nextWork = workIndexAfterRest(state.pendingRest.restIndex);
    } else {
      nextWork = workIndexAfterRest(state.phaseIndex);
    }
    state.pendingRest = null;
    state.phaseIndex = nextWork;
    beginWork(true);
  }

  function onTimerElapsed() {
    state.running = false;
    lastPhaseDueAt = phaseEndsAt;
    disarmPhaseEnd();
    stopTicking();
    if (state.mode === "work") {
      state.remainingSec = 0;
      onWorkBlockComplete(false);
    } else if (state.mode === "rest" || state.mode === "cumulative") {
      state.remainingSec = 0;
      onRestComplete();
    }
  }

  function tick() {
    renderLiveStats();

    if (state.mode === "extend" && state.running) {
      repaintExtendFocus();
      return;
    }

    if (!state.running) return;
    if (reconcileTimedPhaseFromClock()) return;

    const bucket = Math.floor(state.remainingSec / 60);
    if (
      state.lastMinuteBucket !== null &&
      bucket < state.lastMinuteBucket &&
      state.remainingSec > 0.25
    ) {
      playMinutePulse();
    }
    state.lastMinuteBucket = bucket;

    if (state.remainingSec <= 0) {
      onTimerElapsed();
      return;
    }

    updateTimeDisplay();
    updateRing();
    updateDocumentTitle();
  }

  function startTicking() {
    stopTicking();
    tickTimer = setInterval(tick, 250);
    tick();
  }

  function stopTicking() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function visibleControlSnapshot() {
    const controls = document.getElementById("mainControls");
    if (!controls) return new Map();
    return new Map(
      [...controls.querySelectorAll("button")].map((btn) => [
        btn.id || btn.textContent,
        {
          hidden: btn.classList.contains("hidden"),
          text: btn.textContent,
          primary: btn.classList.contains("btn-primary"),
        },
      ])
    );
  }

  function animateControlChanges(before) {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    const controls = document.getElementById("mainControls");
    if (!controls) return;
    const buttons = [...controls.querySelectorAll("button")];
    const changed = buttons.some((btn) => {
      const prev = before.get(btn.id || btn.textContent);
      return (
        !prev ||
        prev.hidden !== btn.classList.contains("hidden") ||
        prev.text !== btn.textContent ||
        prev.primary !== btn.classList.contains("btn-primary")
      );
    });
    if (!changed) return;
    controls.animate(
      [
        { opacity: 0.96, transform: "translateY(2px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
    );
    buttons.filter((btn) => !btn.classList.contains("hidden")).forEach((btn) => {
      const prev = before.get(btn.id || btn.textContent);
      if (prev && !prev.hidden && prev.text === btn.textContent && prev.primary === btn.classList.contains("btn-primary")) return;
      btn.animate(
        [
          { opacity: 0, transform: "translateY(0.35rem) scale(0.98)" },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
      );
    });
  }

  function updateControlVisibility() {
    const before = visibleControlSnapshot();
    const primary = document.getElementById("btnPrimary");
    const takeRest = document.getElementById("btnTakePoolRest");
    const skipRem = document.getElementById("btnSkipRemaining");
    const beginRest = document.getElementById("btnBeginRest");
    const skipExtend = document.getElementById("btnSkipRestExtend");
    const reset = document.getElementById("btnReset");
    const inChoice = state.mode === "work_choice" || state.mode === "rest_choice" || state.mode === "complete";
    const inRest = state.mode === "rest" || state.mode === "cumulative";
    const inExtend = state.mode === "extend";
    const poolAvailable = state.session.poolSec >= 1;
    const poolRestReplacesPause = state.mode === "work" && poolAvailable;

    if (skipRem) {
      skipRem.classList.toggle("hidden", inChoice || !inRest);
      skipRem.textContent = "Skip";
      skipRem.title = "Bank remaining rest to the pool and start next focus";
    }
    if (takeRest) {
      const canTake = poolAvailable && !inChoice && !inRest && !inExtend && state.mode !== "complete";
      takeRest.classList.toggle("hidden", !canTake);
      takeRest.textContent = "Pool rest";
      takeRest.title = "Use accumulated rest";
      takeRest.classList.toggle("btn-primary", poolRestReplacesPause);
      takeRest.classList.toggle("btn-quiet", !poolRestReplacesPause);
    }
    beginRest?.classList.toggle("hidden", !inExtend || inChoice);
    skipExtend?.classList.toggle("hidden", !inExtend || inChoice);
    if (beginRest) beginRest.textContent = "Rest";
    if (skipExtend) skipExtend.textContent = "Skip";
    reset?.classList.toggle("hidden", inChoice);

    if (inChoice) {
      primary?.classList.add("hidden");
      animateControlChanges(before);
      return;
    }

    if (primary) {
      primary.classList.toggle("hidden", inRest || inExtend || poolRestReplacesPause);
      primary.disabled = false;
      if (state.running) {
        primary.textContent = "Pause";
      } else {
        if (state.mode === "idle") primary.textContent = "Start";
        else primary.textContent = "Resume";
      }
    }
    animateControlChanges(before);
  }

  function updateAll() {
    updateLabels();
    updateTimeDisplay();
    updateRing();
    updateDocumentTitle();
    updateControlVisibility();
    renderLiveStats();
    persistSession();
  }

  function resetSession() {
    pauseTimer();
    commitSegment();
    commitPauseSegment();
    stopTicking();
    stopStatsLoop();
    state.mode = "idle";
    state.phaseIndex = 0;
    state.pendingRest = null;
    state.afterRestWorkIndex = null;
    state.resumeAfterPoolRest = null;
    state.extendBaseSec = 0;
    state.pauseStartedAt = null;
    state.currentQuote = null;
    state.restartAfterLevelChange = false;
    state.phaseNotificationKey = null;
    state.monitorNotifiedPhase = null;
    state.session = {
      active: false,
      startedAt: null,
      workSec: 0,
      extendSec: 0,
      restTakenSec: 0,
      poolSec: 0,
      extendPoolAccrued: 0,
      segStartedAt: null,
      segKind: null,
      segDurationSec: 0,
    };
    const p = currentPreset();
    if (p) state.remainingSec = phaseDurationSec(p, 0);
    hideChoices();
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (_) {}
    setChoicePanel(false, "", []);
    applyBodyPhaseClass();
    updateAll();
    renderLiveStats();
  }

  function syncLevelSelect() {
    const buttonText = document.getElementById("levelButtonText");
    const button = document.getElementById("levelButton");
    const p = presetById(state.presetId);
    if (buttonText && p) buttonText.textContent = p.name;
    if (button && p) button.setAttribute("aria-label", `Focus level: ${p.name}`);
    document.querySelectorAll(".level-option").forEach((option) => {
      const active = option.getAttribute("data-id") === state.presetId;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function closeLevelMenu() {
    const menu = document.getElementById("levelMenu");
    const button = document.getElementById("levelButton");
    menu?.classList.add("hidden");
    button?.setAttribute("aria-expanded", "false");
  }

  function toggleLevelMenu() {
    const menu = document.getElementById("levelMenu");
    const button = document.getElementById("levelButton");
    if (!menu || !button) return;
    const open = menu.classList.toggle("hidden");
    button.setAttribute("aria-expanded", open ? "false" : "true");
  }

  async function selectPreset(id, fromUser) {
    if (!presetById(id)) return;
    if (state.presetId === id && !state.restartAfterLevelChange) return;
    if (state.restartAfterLevelChange) {
      hideChoices();
      state.presetId = id;
      syncLevelSelect();
      closeLevelMenu();
      startNextCycle();
      return;
    }
    if (
      fromUser &&
      state.session.active &&
      !(await askConfirm({
        title: "Switch level?",
        message: "This will reset the current session, including progress and rest pool.",
        accept: "Switch",
      }))
    ) {
      syncLevelSelect();
      closeLevelMenu();
      return;
    }
    state.presetId = id;
    syncLevelSelect();
    closeLevelMenu();
    resetSession();
  }

  function renderLevelSelect() {
    const menu = document.getElementById("levelMenu");
    const button = document.getElementById("levelButton");
    if (!menu || !button) return;
    menu.innerHTML = "";
    state.presets.forEach((p) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "level-option";
      option.setAttribute("role", "option");
      option.setAttribute("data-id", p.id);
      option.innerHTML = `
        <span>
          <span class="level-name">${escapeHtml(p.name)}</span>
          <span class="level-sub">${escapeHtml(p.subtitle || (p.kind === "custom" ? "Custom" : ""))}</span>
        </span>
        <span class="level-meta">${p.work_min} / ${p.short_rest_min} / ${p.long_rest_min} min</span>
      `;
      option.addEventListener("click", () => selectPreset(p.id, true));
      menu.appendChild(option);
    });
    syncLevelSelect();
    if (!button.dataset.wired) {
      button.dataset.wired = "1";
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleLevelMenu();
      });
      document.addEventListener("click", (e) => {
        if (!document.getElementById("levelPicker")?.contains(e.target)) closeLevelMenu();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeLevelMenu();
      });
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  async function handleShortcut(e) {
    if (isTypingTarget(e.target)) return;
    const k = e.key.toLowerCase();

    if (state.mode === "work_choice") {
      if (k === "1") {
        e.preventDefault();
        hideChoices();
        chooseExtendFocus();
      } else if (k === "2") {
        e.preventDefault();
        hideChoices();
        chooseStartRest();
      } else if (k === "3") {
        e.preventDefault();
        hideChoices();
        chooseSkipRest();
      }
      return;
    }
    if (state.mode === "rest_choice") {
      if (k === "1") {
        e.preventDefault();
        hideChoices();
        chooseStartNextFocus();
      } else if (k === "2" && state.session.poolSec >= 1) {
        e.preventDefault();
        hideChoices();
        chooseCumulativeRest();
      }
      return;
    }

    if (k === "s") {
      e.preventDefault();
      if (!state.running && !["work_choice", "rest_choice", "complete"].includes(state.mode)) resumeTimer();
      return;
    }
    if (k === "t") {
      e.preventDefault();
      takePoolRestNow();
      return;
    }
    if (k === "r") {
      e.preventDefault();
      if (
        state.session.active &&
        !(await askConfirm({
          title: "Reset session?",
          message: "Progress and rest pool will clear.",
          accept: "Reset",
        }))
      ) return;
      resetSession();
      return;
    }
    if (k === "k" && (state.mode === "rest" || state.mode === "cumulative")) {
      e.preventDefault();
      skipRemainingRest();
      return;
    }
    if (k === "b" && state.mode === "extend") {
      e.preventDefault();
      beginRestFromExtend();
      return;
    }
    if (k === "3" && state.mode === "extend") {
      e.preventDefault();
      skipRestFromExtend();
    }
  }

  function wireControls() {
    document.getElementById("btnPrimary")?.addEventListener("click", () => {
      if (state.mode === "work_choice" || state.mode === "rest_choice" || state.mode === "complete") return;
      if (state.running) {
        pauseTimer();
        return;
      }
      primeAudio();
      resumeTimer();
    });
    document.getElementById("btnTakePoolRest")?.addEventListener("click", () => takePoolRestNow());
    document.getElementById("btnSkipRemaining")?.addEventListener("click", () => skipRemainingRest());
    document.getElementById("btnBeginRest")?.addEventListener("click", () => beginRestFromExtend());
    document.getElementById("btnSkipRestExtend")?.addEventListener("click", () => skipRestFromExtend());
    document.getElementById("btnReset")?.addEventListener("click", async () => {
      if (
        state.session.active &&
        !(await askConfirm({
          title: "Reset session?",
          message: "Progress and rest pool will clear.",
          accept: "Reset",
        }))
      ) return;
      resetSession();
    });

    document.addEventListener("keydown", (e) => {
      handleShortcut(e);
    });
    document.addEventListener("keyup", (e) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (state.running && state.mode === "work" && state.session.poolSec >= 1) takePoolRestNow();
      else if (state.running && state.mode === "extend") beginRestFromExtend();
      else if (state.running && state.mode !== "rest" && state.mode !== "cumulative") pauseTimer();
      else if (!["work_choice", "rest_choice", "complete"].includes(state.mode)) resumeTimer();
    });
  }

  async function init() {
    if (window.__PAGE__ !== "home") return;
    wireControls();
    try {
      const [presetRes, settings] = await Promise.all([
        api("/api/presets"),
        api("/api/settings"),
      ]);
      state.settings = settings;
      state.presets = [...presetRes.builtins, ...presetRes.custom];
      renderLevelSelect();
      const def = settings.default_preset_id;
      const defaultId = presetById(def) ? def : state.presets[0]?.id;
      if (!restoreSession()) {
        state.presetId = defaultId;
        syncLevelSelect();
        setupIdleTimer();
      } else {
        syncLevelSelect();
      }
      renderLiveStats();
    } catch (e) {
      console.error(e);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistSession();
    else {
      const stored = readStoredSession();
      if (stored?.monitorAdvancedPhase) {
        restoreSession();
        return;
      }
    }
    if (document.visibilityState !== "hidden" && state.running) {
      if (state.mode === "extend") startTicking();
      else if (reconcileTimedPhaseFromClock()) return;
      updateAll();
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== SESSION_STORAGE_KEY || !event.newValue || window.__PAGE__ !== "home") return;
    const data = parseStoredSession(event.newValue);
    if (!data) return;
    if (data.monitorAdvancedPhase) {
      restoreSession();
      return;
    }
    if (data.pausedBy !== "flow" && data.pausedBy !== "countdown") return;
    restoreSession();
    if (data.notice) showTimerNotice(data.notice);
  });

  document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("pagehide", persistSession);
  window.addEventListener("beforeunload", persistSession);
})();
