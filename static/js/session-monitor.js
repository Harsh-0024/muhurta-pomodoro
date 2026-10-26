(function () {
  "use strict";

  const SESSION_STORAGE_KEY = "muhurat_timer_session_v1";
  const baseTitle = "Muhurta Pomodoro";
  let settings = null;
  let presets = null;
  let monitorTimer = null;
  const pendingSounds = new Set();
  const pendingTransitions = new Set();

  function parseSession(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function readSession() {
    try {
      const local = parseSession(localStorage.getItem(SESSION_STORAGE_KEY));
      const session = parseSession(sessionStorage.getItem(SESSION_STORAGE_KEY));
      if (!local && !session) return null;
      const data = !local
        ? session
        : !session
          ? local
          : Number(session.savedAt || 0) > Number(local.savedAt || 0)
            ? session
            : local;
      if (data) writeSession(data);
      return data;
    } catch (_) {
      return null;
    }
  }

  function writeSession(data) {
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  async function loadSettings() {
    if (settings) return settings;
    try {
      const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
      if (res.ok) settings = await res.json();
    } catch (_) {}
    return settings || {};
  }

  async function loadPresets() {
    if (presets) return presets;
    try {
      const res = await fetch("/api/presets", { headers: { Accept: "application/json" } });
      if (res.ok) {
        const payload = await res.json();
        presets = [...(payload.builtins || []), ...(payload.custom || [])];
      }
    } catch (_) {}
    return presets || [];
  }

  function formatClock(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function phaseKey(data) {
    if (data.phaseNotificationKey) return data.phaseNotificationKey;
    if (!data.phaseEndsAt) return null;
    return `${data.mode}:${data.phaseIndex}:${Math.round(data.phaseEndsAt)}`;
  }

  function presetById(list, id) {
    return (list || []).find((p) => p.id === id) || null;
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

  function phaseKind(p, i) {
    if (p && i === lastRestIndex(p)) return "long";
    if (i % 2 === 0) return "work";
    return "short";
  }

  function phaseDurationSec(p, i) {
    const k = phaseKind(p, i);
    if (k === "work") return Number(p.work_min || 0) * 60;
    if (k === "short") return Number(p.short_rest_min || 0) * 60;
    return Number(p.long_rest_min || 0) * 60;
  }

  function buildPendingRest(p, workIndex) {
    const restIndex = workIndex + 1;
    const kind = phaseKind(p, restIndex);
    return { sec: phaseDurationSec(p, restIndex), kind, restIndex, workIndex };
  }

  function localDayISO(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function postJSON(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  function remainingForCountdown(data) {
    const end = Number(data.phaseEndsAt || 0);
    if (data.running && end) return (end - Date.now()) / 1000;
    return Number(data.remainingSec || 0);
  }

  function syncTitle(data) {
    // On the Timer page a running Timer owns the title (timer.js); writing
    // ours too made the two take turns and the window title blink.
    const timer = window.__PAGE__ === "timer" && window.MuhurtaTimer?.read();
    if (timer && timer.mode !== "idle") return;
    if (!data?.session?.active || data.mode === "idle") {
      document.title = baseTitle;
      return;
    }
    if (data.mode === "extend") {
      const started = Number(data.session?.segStartedAt || Date.now());
      const extendSec = Number(data.session?.extendSec || 0);
      const base = Number(data.extendBaseSec || 0);
      const live = data.running ? (Date.now() - started) / 1000 : 0;
      document.title = `+${formatClock(Math.max(0, extendSec + live - base))} focus`;
      return;
    }
    if (data.mode === "complete") {
      document.title = "done";
      return;
    }
    if (data.mode === "work_choice" && data.pendingRest?.sec) {
      document.title = `${formatClock(data.pendingRest.sec)} break`;
      return;
    }
    if (data.mode === "rest_choice") {
      document.title = "ready for focus";
      return;
    }
    const remaining = remainingForCountdown(data);
    if (!data.running) {
      document.title = `${formatClock(remaining)} paused`;
      return;
    }
    const suffix = data.mode === "work" ? "focus" : data.mode === "rest" || data.mode === "cumulative" ? "rest" : "timer";
    document.title = `${formatClock(remaining)} ${suffix}`;
  }

  async function playDueSound(data) {
    if (!data?.running || !data.phaseEndsAt || Date.now() < Number(data.phaseEndsAt)) return;
    if (!["work", "rest", "cumulative"].includes(data.mode)) return;
    const key = phaseKey(data);
    if (!key || data.monitorNotifiedPhase === key) return;
    if (pendingSounds.has(key)) return;
    pendingSounds.add(key);
    const current = await loadSettings();
    try {
      if (data.mode === "work") await window.FocusSounds?.workComplete(current);
      else await window.FocusSounds?.breakComplete(current);
      data.phaseNotificationKey = key;
      data.monitorNotifiedPhase = key;
      writeSession(data);
    } catch (_) {
    } finally {
      pendingSounds.delete(key);
    }
  }

  async function advanceDueWork(data) {
    if (!data?.running || data.mode !== "work" || !data.phaseEndsAt) return;
    if (Date.now() < Number(data.phaseEndsAt)) return;
    const key = phaseKey(data);
    if (!key || data.monitorAdvancedPhase === key || pendingTransitions.has(key)) return;
    pendingTransitions.add(key);

    try {
      const [currentSettings, allPresets] = await Promise.all([loadSettings(), loadPresets()]);
      const preset = presetById(allPresets, data.presetId);
      if (!preset) return;

      const endedAt = Number(data.phaseEndsAt);
      const plannedSec =
        Number(data.session?.segDurationSec || 0) || phaseDurationSec(preset, Number(data.phaseIndex || 0));
      const knownStart = Number(data.session?.segStartedAt || 0);
      const startedAt = knownStart || endedAt - plannedSec * 1000;
      // The real length. After a pause the block's last part is shorter than
      // the full block, which is already counted in the parts before it.
      const durationSec = Math.max(0, (endedAt - startedAt) / 1000);
      const now = Date.now();
      const session = data.session || {};
      const rest = buildPendingRest(preset, Number(data.phaseIndex || 0));

      session.active = true;
      session.workSec = Number(session.workSec || 0) + durationSec;
      session.segStartedAt = now;
      data.pendingRest = rest;
      data.monitorNotifiedPhase = key;
      data.monitorAdvancedPhase = key;

      postJSON("/api/activity/segment", {
        day: localDayISO(startedAt),
        kind: "work",
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        duration_sec: durationSec,
        preset_id: data.presetId,
        preset_name: preset.name || "",
        phase_index: data.phaseIndex,
        details: { duration_sec: plannedSec, advanced_by: "session-monitor" },
      });
      postJSON("/api/focus/log", {
        day: localDayISO(endedAt),
        // Today's total counts each finished block once, at its full length,
        // like the timer page does; the parts before a pause add nothing there.
        minutes: Math.max(1, Math.min(240, Math.round(plannedSec / 60))),
      });

      if (currentSettings.auto_start_break && rest) {
        data.mode = "rest";
        data.phaseIndex = rest.restIndex;
        data.remainingSec = rest.sec;
        data.phaseEndsAt = now + rest.sec * 1000;
        data.phaseNotificationKey = `${data.mode}:${data.phaseIndex}:${Math.round(data.phaseEndsAt)}`;
        session.segKind = "rest";
        session.segDurationSec = rest.sec;
      } else {
        data.mode = "extend";
        data.running = true;
        data.remainingSec = 0;
        data.phaseEndsAt = null;
        data.extendBaseSec = Number(session.extendSec || 0);
        session.segKind = "extend";
        session.segDurationSec = 0;
      }

      data.session = session;
      data.savedAt = now;
      writeSession(data);
      syncTitle(data);
    } finally {
      pendingTransitions.delete(key);
    }
  }

  function tick() {
    if (window.__PAGE__ === "home" || window.__PAGE__ === "flow") return;
    const data = readSession();
    syncTitle(data);
    playDueSound(data);
    advanceDueWork(data);
  }

  function start() {
    if (window.__PAGE__ === "home" || window.__PAGE__ === "flow") return;
    tick();
    monitorTimer = window.setInterval(tick, 500);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("storage", tick);
  }

  document.addEventListener("DOMContentLoaded", start);
  window.MuhurataSessionMonitor = {
    refreshSettings() {
      settings = null;
      return loadSettings();
    },
    stop() {
      if (monitorTimer) window.clearInterval(monitorTimer);
    },
  };
})();
