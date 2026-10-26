(function () {
  "use strict";

  let audioCtx = null;
  const buffers = new Map();

  const SOUND_OPTIONS = [
    {
      id: "soothing-bell",
      label: "Soothing bell",
      detail: "A single long bell for entering rest.",
      asset: "/static/audio/soothing-church-bell.mp3",
      gain: 0.85,
    },
    {
      id: "opening-bells",
      label: "Opening bells",
      detail: "A brighter bell cue for returning to work.",
      asset: "/static/audio/opening-bells.mp3",
      gain: 0.9,
    },
  ];
  const SOUND_BY_ID = Object.fromEntries(SOUND_OPTIONS.map((item) => [item.id, item]));

  function ensureCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    // "interrupted": iOS, after the app was in the background or a call came in.
    if (audioCtx && (audioCtx.state === "suspended" || audioCtx.state === "interrupted")) return audioCtx.resume();
    return Promise.resolve();
  }

  function masterGain(settings) {
    return Math.min(1, Number(settings?.sound_volume ?? 70) / 100);
  }

  function tone(settings, freq, start, dur, vol, type) {
    if (!settings?.sound_enabled || !audioCtx) return;
    const g = masterGain(settings) * vol;
    if (g < 0.01) return;
    const t0 = audioCtx.currentTime + start;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(g, t0 + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.08);
  }

  function sequence(settings, notes) {
    if (!settings?.sound_enabled) return Promise.resolve();
    return ensureCtx().then(() => {
      notes.forEach(([freq, start, dur, vol, type]) =>
        tone(settings, freq, start, dur, vol, type || "sine")
      );
    });
  }

  async function loadBuffer(option) {
    if (buffers.has(option.id)) return buffers.get(option.id);
    const res = await fetch(option.asset);
    if (!res.ok) throw new Error("Could not load sound");
    const data = await res.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(data.slice(0));
    buffers.set(option.id, decoded);
    return decoded;
  }

  async function playAsset(settings, option) {
    if (!settings?.sound_enabled) return;
    await ensureCtx();
    if (!audioCtx) return;
    const gainValue = masterGain(settings) * (option.gain ?? 1);
    if (gainValue < 0.01) return;
    const buffer = await loadBuffer(option);
    const source = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(gainValue, audioCtx.currentTime);
    source.connect(gain);
    gain.connect(audioCtx.destination);
    source.start();
  }

  function playSound(settings, soundId) {
    const option = SOUND_BY_ID[soundId] || SOUND_BY_ID["opening-bells"];
    if (option.asset) return playAsset(settings, option);
    if (!settings?.sound_enabled) return Promise.resolve();
    return ensureCtx().then(() => option.synth(settings));
  }

  function selected(settings, key, fallback) {
    const legacyKeys = {
      sound_rest_end: "sound_break_end",
      sound_work_begin: "sound_session_start",
    };
    const value = settings?.[key] || settings?.[legacyKeys[key]] || fallback;
    return SOUND_BY_ID[value] ? value : fallback;
  }

  // The manual_* keys are the ones Settings edits, so they win regardless of
  // auto-start; the older common keys are only a fallback for old databases.
  function selectedForFlow(settings, manualKey, commonKey, fallback) {
    return selected(settings, manualKey, selected(settings, commonKey, fallback));
  }

  window.FocusSounds = {
    options: SOUND_OPTIONS.map(({ id, label, detail }) => ({ id, label, detail })),

    prime(settings) {
      if (!settings?.sound_enabled) return Promise.resolve();
      return ensureCtx().then(() => tone(settings, 440, 0, 0.04, 0.2, "sine"));
    },

    preview(soundId, settings) {
      return playSound({ ...settings, sound_enabled: true }, soundId);
    },

    workComplete(settings) {
      if (!settings?.chime_work_end) return;
      return playSound(
        settings,
        selectedForFlow(settings, "manual_sound_work_end", "sound_work_end", "soothing-bell")
      );
    },

    breakComplete(settings) {
      if (!settings?.chime_break_end) return;
      return playSound(
        settings,
        selectedForFlow(settings, "manual_sound_rest_end", "sound_rest_end", "opening-bells")
      );
    },

    tick(settings) {
      if (!settings?.tick_sound_enabled) return;
      return sequence(settings, [[880, 0, 0.06, 0.12]]);
    },

    start(settings) {
      if (!settings?.chime_session_start) return;
      return playSound(
        settings,
        selectedForFlow(settings, "manual_sound_work_begin", "sound_work_begin", "opening-bells")
      );
    },

    poolAdd(settings) {
      if (!settings?.chime_pool_add) return;
      return playSound(
        settings,
        selectedForFlow(settings, "manual_sound_action", "sound_action", "opening-bells")
      );
    },

    choice(settings) {
      if (!settings?.chime_choice) return;
      return playSound(
        settings,
        selectedForFlow(settings, "manual_sound_action", "sound_action", "opening-bells")
      );
    },

    skip(settings) {
      if (!settings?.chime_skip) return;
      return playSound(
        settings,
        selectedForFlow(settings, "manual_sound_action", "sound_action", "opening-bells")
      );
    },
  };
})();
