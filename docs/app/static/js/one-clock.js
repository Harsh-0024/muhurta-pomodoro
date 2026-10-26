// Only one clock runs at a time. Starting Rhythm, Timer or Flow pauses
// whichever of the others is running, straight in its saved session, so it
// works whichever page that one was started on. Each pause logs the time
// that ran up to now and returns a notice to show ("Flow paused while
// Timer starts."), or null when nothing was running.
//
// Rhythm's saved session is the oldest, so it is still called "timer".
(function () {
  "use strict";

  const RHYTHM_KEY = "muhurat_timer_session_v1";
  const FLOW_KEY = "muhurat_flow_session_v1";
  const SESSION_COMMAND_KEY = "muhurat_session_command_v1";
  const ACTIVE_RHYTHM_MODES = new Set(["work", "extend", "rest", "cumulative"]);
  let presetPromise = null;

  function api(path, opts) {
    return fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    }).then(async (res) => {
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return res.json();
    });
  }

  function localDayISO(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function logSegment(body, startedAt, endedAt) {
    const durationSec = Math.max(0, (endedAt - startedAt) / 1000);
    if (durationSec < 0.5) return;
    api("/api/activity/segment", {
      method: "POST",
      body: JSON.stringify({
        day: localDayISO(startedAt),
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        duration_sec: durationSec,
        ...body,
      }),
    }).catch(() => {});
  }

  function parse(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  // The newer of the local and per-window copies.
  function readStored(key) {
    try {
      const local = parse(localStorage.getItem(key));
      const session = parse(sessionStorage.getItem(key));
      if (!local) return session;
      if (!session) return local;
      return Number(session.savedAt || 0) > Number(local.savedAt || 0) ? session : local;
    } catch (_) {
      return null;
    }
  }

  function writeStored(key, data, target, by) {
    try {
      const raw = JSON.stringify(data);
      localStorage.setItem(key, raw);
      sessionStorage.setItem(key, raw);
      localStorage.setItem(
        SESSION_COMMAND_KEY,
        JSON.stringify({ target, action: `paused-by-${by}`, at: Date.now() })
      );
    } catch (_) {}
  }

  /* ---------- Rhythm ---------- */

  function loadPresets() {
    if (!presetPromise) {
      presetPromise = api("/api/presets")
        .then((data) => [...(data.builtins || []), ...(data.custom || [])])
        .catch(() => []);
    }
    return presetPromise;
  }

  function restAccrualRate(preset) {
    if (!preset) return 0;
    const workSec = 4 * Number(preset.work_min || 0) * 60;
    const restSec = (3 * Number(preset.short_rest_min || 0) + Number(preset.long_rest_min || 0)) * 60;
    return workSec > 0 ? restSec / workSec : 0;
  }

  function syncStoredExtendPool(data, preset) {
    if (data.mode !== "extend" || !preset || !data.session) return;
    const session = data.session;
    const live = session.segKind === "extend" && session.segStartedAt ? Math.max(0, (Date.now() - Number(session.segStartedAt)) / 1000) : 0;
    const extendTotal = Number(session.extendSec || 0) + live;
    const target = extendTotal * restAccrualRate(preset);
    const previous = Number(session.extendPoolAccrued || 0);
    const delta = target - previous;
    if (delta > 0.001) {
      session.extendPoolAccrued = target;
      session.poolSec = Number(session.poolSec || 0) + delta;
    }
  }

  function commitStoredRhythmSegment(data, preset, now, by) {
    const session = data.session;
    if (!session?.segStartedAt || !session.segKind) return;
    if (session.segKind === "extend") syncStoredExtendPool(data, preset);
    const startedAt = Number(session.segStartedAt);
    const elapsed = Math.max(0, (now - startedAt) / 1000);
    if (session.segKind === "work") session.workSec = Number(session.workSec || 0) + elapsed;
    else if (session.segKind === "extend") session.extendSec = Number(session.extendSec || 0) + elapsed;
    else if (session.segKind === "rest" || session.segKind === "cumulative")
      session.restTakenSec = Number(session.restTakenSec || 0) + elapsed;
    logSegment(
      {
        kind: session.segKind,
        preset_id: data.presetId || "",
        preset_name: data.presetName || "",
        phase_index: data.phaseIndex,
        details: { duration_sec: Number(session.segDurationSec || 0), paused_by: by },
      },
      startedAt,
      now
    );
    session.segStartedAt = null;
    session.segKind = null;
    session.segDurationSec = 0;
  }

  async function pauseRhythm(by, label) {
    const data = readStored(RHYTHM_KEY);
    if (!data?.running || !ACTIVE_RHYTHM_MODES.has(data.mode) || !data?.session?.active) return null;
    const now = Date.now();
    const presets = await loadPresets();
    const preset = presets.find((p) => p.id === data.presetId) || null;
    if (preset) data.presetName = preset.name || "";
    if (data.phaseEndsAt) data.remainingSec = Math.max(0, (Number(data.phaseEndsAt) - now) / 1000);
    commitStoredRhythmSegment(data, preset, now, by);
    data.running = false;
    data.phaseEndsAt = null;
    data.pauseStartedAt = now;
    data.pausedBy = by;
    data.notice = `Rhythm paused while ${label} starts.`;
    data.savedAt = now;
    writeStored(RHYTHM_KEY, data, "timer", by);
    return data.notice;
  }

  /* ---------- Flow ---------- */

  function pauseFlow(by, label) {
    const data = readStored(FLOW_KEY);
    if (!data || data.mode !== "running" || !data.runStartedAt) return null;
    const now = Date.now();
    const runStartedAt = Number(data.runStartedAt);
    data.focusedSec = Math.max(0, Number(data.focusedSec || 0)) + Math.max(0, (now - runStartedAt) / 1000);
    logSegment(
      { kind: "flow", preset_id: "flow", preset_name: "Flow", details: { mode: "stopwatch", paused_by: by } },
      runStartedAt,
      now
    );
    data.mode = "paused";
    data.runStartedAt = null;
    data.pausedBy = by;
    data.notice = `Flow paused while ${label} starts.`;
    data.savedAt = now;
    writeStored(FLOW_KEY, data, "flow", by);
    return data.notice;
  }

  /* ---------- Timer ---------- */

  function pauseTimer(by, label) {
    return window.MuhurtaTimer ? window.MuhurtaTimer.pauseFor(by, label) : null;
  }

  // Pause everything except `own` ("rhythm" | "timer" | "flow"); `label` is
  // how the notice names the one starting. Resolves to the notices shown.
  async function pauseOthers(own, label) {
    const by = { rhythm: "timer", timer: "countdown", flow: "flow" }[own];
    const notices = [];
    if (own !== "rhythm") notices.push(await pauseRhythm(by, label));
    if (own !== "flow") notices.push(pauseFlow(by, label));
    if (own !== "timer") notices.push(pauseTimer(by, label));
    return notices.filter(Boolean);
  }

  window.OneClock = { pauseOthers, logSegment, localDayISO };
})();
