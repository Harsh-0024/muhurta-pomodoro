// The phone apps have no Python, so this file is their "server": it answers the
// same /api/... requests the screens make to app.py on a computer, and keeps
// the data on the phone (IndexedDB). The same file runs in the Android app and
// in the iPhone web app (D.platform "ios", mobile/build_web.py --iphone). It follows app.py and db.py rule for rule;
// when one of those changes, change the matching part here too.
//
// Loaded first on every page (mobile/build_web.py puts it at the top of
// <head>), so it is in place before any screen asks for anything. The fixed
// data it needs (levels, default settings, release notes, quotes) comes from
// the Python files through mobile-data.js, built at the same time.
(function () {
  "use strict";

  const D = window.__MUHURTA__;
  const WEB = D.platform === "ios";
  const PRODUCTIVE_KINDS = D.productive_kinds;
  const REST_KINDS = D.rest_kinds;
  const SEGMENT_KINDS = [...PRODUCTIVE_KINDS, ...REST_KINDS];
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const SEGMENT_CLOCK_SLACK_SEC = 5;
  const HISTORY_MIN_SEC = 60;
  const HISTORY_MAX_SEC = 24 * 60 * 60;
  const HISTORY_FUTURE_SLACK_SEC = 5 * 60;
  // Blocks, as in db.py and static/js/quick-lengths.js: a break under 5
  // minutes doesn't end one; 5 minutes or a scheduled rest taken in full does.
  const RHYTHM_BOUT_GAP_SEC = 5 * 60;
  const RHYTHM_NOISE_FLOOR_SEC = 5 * 60;
  const BELL_MIN_BOUTS = 15;

  /* ------------------------------------------------------------------ */
  /* storage: everything is read into memory once per page, and each     */
  /* change is written straight back                                     */
  /* ------------------------------------------------------------------ */

  const STORES = { segments: "id", presets: "id", focus: "key", tombstones: "key", kv: "k" };
  const S = { segments: new Map(), presets: new Map(), focus: new Map(), tombstones: new Map(), kv: new Map() };
  let idb = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("muhurta", 1);
      req.onupgradeneeded = () => {
        for (const [name, keyPath] of Object.entries(STORES)) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function readAll(name) {
    return new Promise((resolve, reject) => {
      const req = idb.transaction(name).objectStore(name).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // puts: [[store, record]], deletes: [[store, key]] - one transaction, so a
  // change and its tombstone are saved together or not at all.
  function write(puts, deletes) {
    puts = puts || [];
    deletes = deletes || [];
    for (const [name, rec] of puts) S[name].set(rec[STORES[name]], rec);
    for (const [name, key] of deletes) S[name].delete(key);
    const names = [...new Set([...puts, ...deletes].map((x) => x[0]))];
    if (!names.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(names, "readwrite");
      for (const [name, rec] of puts) tx.objectStore(name).put(rec);
      for (const [name, key] of deletes) tx.objectStore(name).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const ready = (async () => {
    idb = await openDb();
    for (const name of Object.keys(STORES)) {
      for (const rec of await readAll(name)) S[name].set(rec[STORES[name]], rec);
    }
    if (!S.kv.get("device")) {
      // This phone's id, like local_device on a computer (migration 0002).
      await write([["kv", { k: "device", device_id: uuid(), created_at: nowIso() }]]);
    }
    if (!S.kv.get("settings")) {
      await write([["kv", { k: "settings", json: {}, updated_at: nowIso(), synced_version: null }]]);
    }
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (_) {}
    const theme = loadSettings().theme;
    rememberTheme(theme);
    applyTheme(theme);
  })();

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // UTC ISO with milliseconds: the format the desktop's sync triggers write.
  const nowIso = () => new Date().toISOString();

  // A stored time as milliseconds; one without a timezone counts as UTC.
  function parseTime(value) {
    if (value == null) return null;
    let s = String(value).trim();
    if (!s) return null;
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && /T|\s\d/.test(s)) s += "Z";
    const ms = Date.parse(s.replace(" ", "T"));
    return Number.isFinite(ms) ? ms : null;
  }

  // Like the desktop: a time the user sent must carry its own timezone.
  function parseTimeStrict(value) {
    const s = String(value || "").trim();
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return null;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }

  const toIso = (ms) => new Date(ms).toISOString();

  function localDay(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function dayFromIso(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const daysBetween = (a, b) => Math.round((b - a) / 86400000); // both local midnights

  // Python's round(): an exact half goes to the even digit (102.25 -> 102.2),
  // so the phone shows the same numbers as the computer.
  // Works on the number's exact decimal digits, as Python does.
  function round(x, n) {
    if (!Number.isFinite(x)) return x;
    const [int, frac = ""] = Math.abs(x).toFixed(Math.min(100, n + 60)).split(".");
    const keep = frac.slice(0, n);
    const rest = frac.slice(n);
    let up = rest[0] > "5" || (rest[0] === "5" && /[1-9]/.test(rest.slice(1)));
    if (rest[0] === "5" && !/[1-9]/.test(rest.slice(1))) up = Number((int + keep).slice(-1)) % 2 === 1;
    let v = Number(`${int}.${keep || "0"}`);
    if (up) v = Number((v + 10 ** -n).toFixed(n));
    return x < 0 ? -v : v;
  }

  function deviceId() {
    return S.kv.get("device").device_id;
  }

  function versionTuple(text) {
    return (String(text || "").match(/\d+/g) || []).slice(0, 3).map(Number);
  }

  function compareVersions(a, b) {
    const x = versionTuple(a);
    const y = versionTuple(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  class HttpError extends Error {
    constructor(status, message, extra) {
      super(message);
      this.status = status;
      this.extra = extra || {};
    }
  }

  /* ------------------------------------------------------------------ */
  /* settings (db.load_settings / save_settings, app.api_put_settings)   */
  /* ------------------------------------------------------------------ */

  function loadSettings() {
    const data = { ...(S.kv.get("settings").json || {}) };
    return { ...D.default_settings, ...data };
  }

  async function saveSettings(partial) {
    const merged = { ...loadSettings(), ...partial };
    for (const k of Object.keys(merged)) if (!(k in D.default_settings)) delete merged[k];
    const row = S.kv.get("settings");
    await write([["kv", { ...row, json: merged, updated_at: nowIso() }]]);
    rememberTheme(merged.theme);
    return merged;
  }

  async function resetSettings() {
    const row = S.kv.get("settings");
    await write([["kv", { ...row, json: {}, updated_at: nowIso() }]]);
    rememberTheme(loadSettings().theme);
    return loadSettings();
  }

  // On a computer, app.py writes the theme into each page. Here the pages are
  // built once, so set it on <body> as each page starts. A copy in
  // localStorage is read at once, so a dark page never flashes light first;
  // the stored settings stay the real record.
  const THEME_KEY = "muhurta-theme";
  const cleanTheme = (t) => (["light", "dark", "system"].includes(t) ? t : "system");

  function rememberTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, cleanTheme(theme));
    } catch (_) {}
  }

  function applyTheme(theme) {
    const set = () => {
      if (document.body) document.body.dataset.theme = cleanTheme(theme);
      return !!document.body;
    };
    if (set()) return;
    const mo = new MutationObserver(() => {
      if (set()) mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true });
  }

  try {
    const quick = localStorage.getItem(THEME_KEY);
    if (quick) applyTheme(quick);
  } catch (_) {}

  function presetExists(id) {
    if (id.startsWith("builtin-")) return D.builtins.some((b) => b.id === id);
    const m = /^custom-(\d+)$/.exec(id || "");
    return !!(m && S.presets.has(Number(m[1])));
  }

  function parseSettingsBody(body) {
    const patch = {};
    const bools = ["auto_start_work", "auto_start_break", "sound_enabled", "tick_sound_enabled", "chime_work_end",
      "chime_break_end", "chime_session_start", "chime_pool_add", "chime_choice", "chime_skip", "notifications_enabled"];
    for (const k of bools) if (k in body) patch[k] = !!body[k];
    if ("sound_volume" in body) {
      const vol = Number.parseInt(body.sound_volume, 10);
      if (!Number.isFinite(vol)) throw new HttpError(400, "Invalid volume");
      if (vol < 0 || vol > 100) throw new HttpError(400, "Volume must be 0–100");
      patch.sound_volume = vol;
    }
    for (const key of D.sound_setting_keys) {
      if (key in body) {
        const sound = String(body[key]);
        if (!D.sound_choices.includes(sound)) throw new HttpError(400, "Invalid sound choice");
        patch[key] = sound;
      }
    }
    if ("theme" in body) {
      const t = String(body.theme);
      if (!["light", "dark", "system"].includes(t)) throw new HttpError(400, "Invalid theme");
      patch.theme = t;
    }
    if ("timer_end" in body) {
      const t = String(body.timer_end);
      if (!["stop", "ring", "overtime"].includes(t)) throw new HttpError(400, "Invalid timer ending");
      patch.timer_end = t;
    }
    if ("default_preset_id" in body) {
      const pid = String(body.default_preset_id);
      if (!presetExists(pid)) throw new HttpError(400, "Unknown default preset");
      patch.default_preset_id = pid;
    }
    if ("daily_focus_goal_minutes" in body) {
      const goal = Number.parseInt(body.daily_focus_goal_minutes, 10);
      if (!Number.isFinite(goal)) throw new HttpError(400, "Invalid daily goal");
      if (goal < 15 || goal > 960) throw new HttpError(400, "Daily goal must be 15–960 minutes");
      patch.daily_focus_goal_minutes = goal;
    }
    return patch;
  }

  /* ------------------------------------------------------------------ */
  /* levels (presets)                                                    */
  /* ------------------------------------------------------------------ */

  function builtinPublic(b) {
    const total = b.cycle_min || (b.total_work_min || 0) + (b.total_rest_min || 0);
    return { ...b, kind: "builtin", focus_ratio_pct: total ? round((100 * (b.total_work_min || 0)) / total, 1) : 0 };
  }

  function customPublic(row) {
    const { work_min: w, short_rest_min: s, long_rest_min: l } = row;
    const tw = 4 * w;
    const tr = 3 * s + l;
    const total = tw + tr;
    return {
      id: `custom-${row.id}`,
      kind: "custom",
      name: row.name,
      subtitle: "Your rhythm",
      work_min: w,
      short_rest_min: s,
      long_rest_min: l,
      total_work_min: tw,
      total_rest_min: tr,
      cycle_min: total,
      focus_ratio_pct: total ? round((100 * tw) / total, 2) : 0,
      created_at: row.created_at,
    };
  }

  function parsePresetBody(data) {
    const name = String(data.name || "").trim();
    const w = Number.parseInt(data.work_min, 10);
    const s = Number.parseInt(data.short_rest_min, 10);
    const l = Number.parseInt(data.long_rest_min, 10);
    if (![w, s, l].every(Number.isFinite)) throw new HttpError(400, "Invalid durations");
    if (!name || name.length > 80) throw new HttpError(400, "Name must be 1–80 characters");
    if (!(w >= 1 && w <= 180 && s >= 1 && s <= 60 && l >= 1 && l <= 120)) {
      throw new HttpError(400, "Durations out of allowed range");
    }
    return { name, work_min: w, short_rest_min: s, long_rest_min: l };
  }

  function nextId(store) {
    let max = 0;
    for (const id of S[store].keys()) max = Math.max(max, id);
    return max + 1;
  }

  // created_at like SQLite's datetime('now'): "YYYY-MM-DD HH:MM:SS", UTC.
  const sqliteNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

  function tombstone(table, row) {
    return ["tombstones", { key: `${table}|${row.uuid}`, table_name: table, uuid: row.uuid, deleted_at: nowIso(), synced_version: null }];
  }

  /* ------------------------------------------------------------------ */
  /* sessions (activity segments)                                        */
  /* ------------------------------------------------------------------ */

  function splitSeconds(kind, duration) {
    return [PRODUCTIVE_KINDS.includes(kind) ? duration : 0, REST_KINDS.includes(kind) ? duration : 0];
  }

  function segmentPublic(row) {
    return {
      id: row.id,
      day: row.day,
      kind: row.kind,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_sec: row.duration_sec,
      productive_sec: row.productive_sec,
      rest_sec: row.rest_sec,
      preset_id: row.preset_id,
      preset_name: row.preset_name,
      phase_index: row.phase_index,
      details: row.details || {},
      created_at: row.created_at,
    };
  }

  const segments = () => [...S.segments.values()];
  const byStartAsc = (a, b) => (parseTime(a.started_at) - parseTime(b.started_at)) || a.id - b.id;
  const byStartDesc = (a, b) => -byStartAsc(a, b);

  async function addSegment(seg) {
    const [productive, rest] = splitSeconds(seg.kind, seg.duration_sec);
    // The timer page and the background monitor can both save the same
    // finished block. Same phone, same kind, same start: keep the first.
    const me = deviceId();
    const existing = segments().find((r) => r.kind === seg.kind && r.started_at === seg.started_at && r.device_id === me);
    if (existing) return segmentPublic(existing);
    const now = nowIso();
    const row = {
      id: nextId("segments"),
      uuid: uuid(),
      day: seg.day,
      kind: seg.kind,
      started_at: seg.started_at,
      ended_at: seg.ended_at,
      duration_sec: seg.duration_sec,
      productive_sec: productive,
      rest_sec: rest,
      preset_id: seg.preset_id ?? null,
      preset_name: seg.preset_name ?? null,
      phase_index: seg.phase_index ?? null,
      details: seg.details || {},
      created_at: sqliteNow(),
      updated_at: now,
      synced_version: null,
      device_id: me,
    };
    await write([["segments", row]]);
    return segmentPublic(row);
  }

  function overlappingIds(startMs, endMs, excludeId) {
    const ids = new Set();
    for (const r of segments()) {
      if (r.id === excludeId) continue;
      if (parseTime(r.started_at) < endMs && parseTime(r.ended_at) > startMs) ids.add(r.id);
    }
    return ids;
  }

  function conflict(ids) {
    const first = [...ids].map((id) => S.segments.get(id)).sort(byStartAsc)[0];
    return new HttpError(409, "Those times overlap another session.", { conflict: first ? segmentPublic(first) : null });
  }

  // Trim time two *devices* both recorded, so it is counted once (db._count_shared_time_once).
  function countSharedTimeOnce(rows) {
    const out = [];
    const coveredUntil = new Map();
    for (const row of rows) {
      const item = { ...row };
      let start = parseTime(item.started_at);
      const end = parseTime(item.ended_at);
      if (start == null || end == null || end <= start) continue;
      const device = item.device_id || "";
      let otherEnd = null;
      for (const [dev, e] of coveredUntil) if (dev !== device && (otherEnd == null || e > otherEnd)) otherEnd = e;
      coveredUntil.set(device, Math.max(coveredUntil.get(device) ?? end, end));
      if (otherEnd != null && otherEnd > start) {
        if (otherEnd >= end) continue;
        const keep = (end - otherEnd) / (end - start);
        for (const k of ["duration_sec", "productive_sec", "rest_sec"]) item[k] = Number(item[k] || 0) * keep;
        start = otherEnd;
      }
      out.push([item, start, end]);
    }
    return out;
  }

  function parseHistoryBody(data) {
    const day = String(data.day || "");
    if (!DAY_RE.test(day)) throw new HttpError(400, "Invalid day");
    const rawStart = String(data.started_at || "");
    const rawEnd = String(data.ended_at || "");
    if (!Number.isFinite(Date.parse(rawStart)) || !Number.isFinite(Date.parse(rawEnd))) {
      throw new HttpError(400, "Invalid start or end time");
    }
    const start = parseTimeStrict(rawStart);
    const end = parseTimeStrict(rawEnd);
    if (start == null || end == null) throw new HttpError(400, "Times need a timezone");
    const duration = (end - start) / 1000;
    if (duration <= 0) throw new HttpError(400, "The end has to come after the start");
    if (duration < HISTORY_MIN_SEC) throw new HttpError(400, "A session has to be at least a minute long");
    if (duration > HISTORY_MAX_SEC) throw new HttpError(400, "A session can be at most 24 hours long");
    if ((end - Date.now()) / 1000 > HISTORY_FUTURE_SLACK_SEC) throw new HttpError(400, "That session would end in the future");
    return { day, started_at: toIso(start), ended_at: toIso(end), duration_sec: duration };
  }

  async function updateSegment(id, p) {
    const row = S.segments.get(id);
    if (!row) return null;
    const startMs = parseTime(p.started_at);
    const endMs = parseTime(p.ended_at);
    // Only overlaps the new times introduce are refused.
    const before = overlappingIds(parseTime(row.started_at), parseTime(row.ended_at), id);
    const clash = [...overlappingIds(startMs, endMs, id)].filter((x) => !before.has(x));
    if (clash.length) throw conflict(new Set(clash));

    const details = JSON.parse(JSON.stringify(row.details || {}));
    const edit = details.edit || {};
    const original = edit.original || { day: row.day, started_at: row.started_at, ended_at: row.ended_at, duration_sec: row.duration_sec };
    let { day, started_at, ended_at, duration_sec } = p;
    if (parseTime(original.started_at) === startMs && parseTime(original.ended_at) === endMs) {
      delete details.edit;
      ({ day, started_at, ended_at } = original);
      duration_sec = Number(original.duration_sec);
    } else {
      details.edit = { original, edited_at: nowIso() };
    }
    const [productive, rest] = splitSeconds(row.kind, duration_sec);
    const next = { ...row, day, started_at, ended_at, duration_sec, productive_sec: productive, rest_sec: rest, details, updated_at: nowIso() };
    await write([["segments", next]]);
    return segmentPublic(next);
  }

  function earliestDay() {
    let min = null;
    for (const r of S.segments.values()) if (min == null || r.day < min) min = r.day;
    return min;
  }

  /* ------------------------------------------------------------------ */
  /* dashboard (db.dashboard_summary), in the phone's own timezone       */
  /* ------------------------------------------------------------------ */

  function percentile(sorted, p) {
    const n = sorted.length;
    if (!n) return 0;
    if (n === 1) return sorted[0];
    const k = ((n - 1) * p) / 100;
    const f = Math.floor(k);
    const c = Math.min(f + 1, n - 1);
    return sorted[f] + (k - f) * (sorted[c] - sorted[f]);
  }

  function bellBandwidth(d) {
    const n = d.length;
    const mean = d.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0;
    const std = Math.sqrt(variance);
    const iqr = percentile(d, 75) - percentile(d, 25);
    const spread = iqr > 0 ? Math.min(std, iqr / 1.34) : std;
    let h = 0.9 * spread * n ** -0.2;
    if (h <= 0) h = std > 0 ? std * n ** -0.2 : 0;
    if (h <= 0) h = Math.max(0.5, d[n - 1] * 0.05);
    return h;
  }

  function bellDomain(d, h) {
    const q1 = percentile(d, 25);
    const q3 = percentile(d, 75);
    const iqr = Math.max(0, q3 - q1);
    const p1 = percentile(d, 1);
    const p95 = percentile(d, 95);
    const max = d[d.length - 1];
    const lo = Math.max(0, p1 - 2 * h);
    const fence = Math.max(q3 + 3 * iqr, p95 * 1.25, q3 + 2 * h);
    let hi = Math.min(Math.min(max, fence) + 2 * h, max + 2 * h);
    if (hi <= lo) hi = lo + Math.max(1, h);
    return [lo, hi];
  }

  function kde(d, lo, hi, h, points = 160) {
    const n = d.length;
    if (!n || h <= 0 || points < 2) return [];
    const step = (hi - lo) / (points - 1);
    const out = [];
    for (let i = 0; i < points; i++) {
      const x = lo + i * step;
      let density = 0;
      for (const v of d) {
        const z = (x - v) / h;
        if (z > -6 && z < 6) density += 0.3989422804014327 * Math.exp(-0.5 * z * z);
      }
      out.push([round(x, 2), density / (n * h)]);
    }
    return out;
  }

  function bellCurve(boutsSec) {
    const mins = boutsSec.map((s) => s / 60);
    if (mins.length < BELL_MIN_BOUTS) return { ready: false, bout_count: mins.length, min_required: BELL_MIN_BOUTS };
    const d = [...mins].sort((a, b) => a - b);
    const n = d.length;
    const mean = d.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
    const h = bellBandwidth(d);
    const [lo, hi] = bellDomain(d, h);
    const curve = kde(d, lo, hi, h);
    let peak = percentile(d, 50);
    let yMax = 0;
    for (const [x, y] of curve) if (y > yMax) { yMax = y; peak = x; }
    return {
      ready: true,
      bout_count: n,
      mean_min: round(mean, 1),
      median_min: round(percentile(d, 50), 1),
      std_dev_min: round(std, 1),
      peak_min: round(peak, 1),
      p5_min: round(percentile(d, 5), 1),
      p25_min: round(percentile(d, 25), 1),
      p75_min: round(percentile(d, 75), 1),
      p95_min: round(percentile(d, 95), 1),
      max_min: round(d[n - 1], 1),
      bandwidth_min: round(h, 2),
      x_min: round(lo, 2),
      x_max: round(hi, 2),
      y_max: yMax,
      clipped_count: d.filter((x) => x > hi).length,
      curve,
      durations: d.map((x) => round(x, 2)),
    };
  }

  const emptyBucket = () => ({ productive_sec: 0, rest_sec: 0, duration_sec: 0, segment_count: 0, focus_segments: 0 });

  // Spread a session over the local days it touches (db._credit_row_to_days).
  function creditToDays(buckets, row, startMs, endMs, rangeStart, rangeEnd) {
    const duration = Math.max(0, Number(row.duration_sec || 0));
    const productive = Math.max(0, Number(row.productive_sec || 0));
    const rest = Math.max(0, Number(row.rest_sec || 0));
    const actual = Math.max(0, (endMs - startMs) / 1000);
    if (actual <= 0) return;
    let cursor = Math.max(startMs, rangeStart.getTime());
    const stop = Math.min(endMs, rangeEnd.getTime());
    while (cursor < stop) {
      const c = new Date(cursor);
      const nextMidnight = new Date(c.getFullYear(), c.getMonth(), c.getDate() + 1).getTime();
      const chunkEnd = Math.min(stop, nextMidnight);
      const fraction = (chunkEnd - cursor) / 1000 / actual;
      if (fraction > 0) {
        const key = localDay(c);
        const b = buckets.get(key) || emptyBucket();
        const dur = duration * fraction;
        const prod = productive * fraction;
        const rst = rest * fraction;
        if (dur > 0 || prod > 0 || rst > 0) {
          b.duration_sec += dur;
          b.productive_sec += prod;
          b.rest_sec += rst;
          b.segment_count += 1;
          if (prod > 0) b.focus_segments += 1;
        }
        buckets.set(key, b);
      }
      cursor = chunkEnd;
    }
  }

  function dashboard(endDayIso, days, year) {
    const today = dayFromIso(localDay(new Date()));
    let selectedYear = year;
    let startDay;
    let endDay;
    if (selectedYear != null) {
      selectedYear = Math.max(1970, Math.min(selectedYear, today.getFullYear()));
    } else {
      days = Math.max(7, Math.min(Number(days) || 365, 370));
      endDay = endDayIso && DAY_RE.test(endDayIso) ? dayFromIso(endDayIso) : today;
      selectedYear = endDay.getFullYear();
      startDay = addDays(endDay, -(days - 1));
    }

    const years = new Set();
    for (const r of S.segments.values()) years.add(Number(r.day.slice(0, 4)));
    for (const r of S.focus.values()) years.add(Number(r.day.slice(0, 4)));
    years.delete(NaN);
    const firstYear = years.size ? Math.min(...years) : selectedYear;
    if (years.size) selectedYear = Math.max(firstYear, Math.min(selectedYear, today.getFullYear()));
    if (year != null) {
      startDay = new Date(selectedYear, 0, 1);
      endDay = new Date(selectedYear, 11, 31);
      days = daysBetween(startDay, endDay) + 1;
    }
    const calcEnd = endDay < today ? endDay : today;
    const yearList = [];
    for (let y = firstYear; y <= Math.max(today.getFullYear(), selectedYear, firstYear); y++) yearList.push(y);

    const rangeStart = startDay;
    const rangeEnd = addDays(endDay, 1);
    const rows = segments()
      .filter((r) => parseTime(r.started_at) < rangeEnd.getTime() && parseTime(r.ended_at) > rangeStart.getTime())
      .sort(byStartAsc);

    const settings = loadSettings();
    const goal = Number(settings.daily_focus_goal_minutes) || 120;
    const activity = new Map();
    let boutSec = 0;
    let boutEnd = null;
    const bouts = [];
    const finalize = () => {
      if (boutSec >= RHYTHM_NOISE_FLOOR_SEC) bouts.push(boutSec);
      boutSec = 0;
      boutEnd = null;
    };
    for (const [row, startMs, endMs] of countSharedTimeOnce(rows)) {
      const productive = Math.max(0, Number(row.productive_sec || 0));
      if (productive > 0) {
        const joins = boutSec > 0 && boutEnd != null && (startMs - boutEnd) / 1000 < RHYTHM_BOUT_GAP_SEC;
        if (boutSec > 0 && !joins) finalize();
        boutSec += productive;
        boutEnd = boutEnd != null && joins ? Math.max(boutEnd, endMs) : endMs;
      } else if (boutSec > 0 && row.kind === "rest") {
        const planned = Number((row.details || {}).duration_sec) || 0;
        if (planned > 0 && Number(row.duration_sec || 0) >= planned - 1) finalize(); // the rhythm's own rest, taken as planned
      }
      creditToDays(activity, row, startMs, endMs, rangeStart, rangeEnd);
    }
    finalize();

    const records = [];
    const recent = [];
    let totalFocus = 0;
    let totalRest = 0;
    let totalTracked = 0;
    let activeDays = 0;
    let goalDays = 0;
    let bestDay = null;
    let longest = 0;
    let running = 0;
    let current = 0;
    let firstActive = null;
    const calcEndIso = localDay(calcEnd);
    for (let i = 0; i < days; i++) {
      const day = addDays(startDay, i);
      const iso = localDay(day);
      const seg = activity.get(iso);
      const focus = seg ? seg.productive_sec / 60 : 0;
      const rest = seg ? seg.rest_sec / 60 : 0;
      const tracked = Math.max(seg ? seg.duration_sec / 60 : 0, focus + rest);
      if (focus > 0) {
        activeDays += 1;
        if (!firstActive) firstActive = day;
        running += 1;
        longest = Math.max(longest, running);
      } else {
        running = 0;
      }
      if (focus >= goal) goalDays += 1;
      if (focus > 0 && (!bestDay || focus > bestDay.focus_minutes)) bestDay = { day: iso, focus_minutes: round(focus, 1) };
      totalFocus += focus;
      totalRest += rest;
      totalTracked += tracked;
      const record = {
        day: iso,
        weekday: (day.getDay() + 6) % 7,
        focus_minutes: round(focus, 1),
        rest_minutes: round(rest, 1),
        tracked_minutes: round(tracked, 1),
        segment_count: seg ? seg.segment_count : 0,
        focus_segments: seg ? seg.focus_segments : 0,
        goal_met: focus >= goal,
      };
      records.push(record);
      if (iso <= calcEndIso) {
        current = focus > 0 ? current + 1 : 0;
        recent.unshift(record);
        if (recent.length > 14) recent.pop();
      }
    }
    const elapsed = Math.max(1, daysBetween(firstActive || startDay, calcEnd) + 1);
    return {
      range: {
        start: localDay(startDay),
        end: localDay(endDay),
        days,
        year: selectedYear,
        years: yearList,
        calc_start: firstActive ? localDay(firstActive) : localDay(startDay),
        calc_end: calcEndIso,
      },
      goal_minutes: goal,
      days: records,
      recent_days: recent,
      bell_curve: bellCurve(bouts),
      summary: {
        total_focus_minutes: round(totalFocus, 1),
        total_rest_minutes: round(totalRest, 1),
        total_tracked_minutes: round(totalTracked, 1),
        active_days: activeDays,
        goal_days: goalDays,
        current_streak: current,
        longest_streak: longest,
        best_day: bestDay,
        days_elapsed: elapsed,
        consistency_days_per_week: round((activeDays / elapsed) * 7, 2),
        average_focus_active_day: activeDays ? round(totalFocus / activeDays, 1) : 0,
        productivity_pct: totalTracked ? round((totalFocus / totalTracked) * 100, 1) : null,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* the endpoints                                                       */
  /* ------------------------------------------------------------------ */

  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

  route("GET", /^\/api\/presets$/, () => ({
    builtins: D.builtins.map(builtinPublic),
    custom: [...S.presets.values()].sort((a, b) => a.id - b.id).map(customPublic),
  }));

  route("POST", /^\/api\/presets$/, async ({ body }) => {
    const p = parsePresetBody(body);
    const row = { id: nextId("presets"), uuid: uuid(), ...p, created_at: sqliteNow(), updated_at: nowIso(), synced_version: null };
    await write([["presets", row]]);
    return [201, customPublic(row)];
  });

  route("PUT", /^\/api\/presets\/(\d+)$/, async ({ body, m }) => {
    const p = parsePresetBody(body);
    const row = S.presets.get(Number(m[1]));
    if (!row) throw new HttpError(404, "Not found");
    const next = { ...row, ...p, updated_at: nowIso() };
    await write([["presets", next]]);
    return customPublic(next);
  });

  route("DELETE", /^\/api\/presets\/(\d+)$/, async ({ m }) => {
    const id = Number(m[1]);
    const row = S.presets.get(id);
    if (!row) throw new HttpError(404, "Not found");
    await write([tombstone("custom_presets", row)], [["presets", id]]);
    if (loadSettings().default_preset_id === `custom-${id}`) await saveSettings({ default_preset_id: "builtin-shishya" });
    return [204, null];
  });

  route("GET", /^\/api\/settings$/, () => loadSettings());
  route("POST", /^\/api\/settings\/reset$/, () => resetSettings());
  route("PUT", /^\/api\/settings$/, async ({ body }) => {
    const patch = parseSettingsBody(body);
    return Object.keys(patch).length ? saveSettings(patch) : loadSettings();
  });

  route("POST", /^\/api\/alive$/, () => [204, null]);

  route("GET", /^\/api\/quote$/, async () => {
    const fallback = D.quotes[Math.floor(Math.random() * D.quotes.length)];
    try {
      const http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
      if (http) {
        const res = await Promise.race([
          http.get({ url: "https://zenquotes.io/api/random", headers: { "User-Agent": "MuhurataTimer/1.0" } }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
        ]);
        const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        const item = Array.isArray(data) && data.length ? data[0] : {};
        const quote = String(item.q || "").trim();
        const author = String(item.a || "").trim();
        if (quote && author) return { quote, author, source: "zenquotes" };
      }
    } catch (_) {}
    return { ...fallback, source: "fallback" };
  });

  // Update notices (app.py _update_info / api_version): the latest release on
  // GitHub and the owner's rules (docs/update-policy.json). Checked hourly,
  // ten minutes after a failure; offline keeps what was known, including a
  // "you must update". The phone gets the new version from the website. The
  // iPhone web app asks the website which version it has (version.json) and
  // updates itself in place (pwa.js).
  const UPDATE_CHECK_MS = 60 * 60 * 1000;
  const UPDATE_RETRY_MS = 10 * 60 * 1000;
  let updateCheck = null;

  async function webGet(url, headers) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const res = await fetch(url, { headers: headers || {}, cache: "no-store", signal: ctl.signal });
      return { status: res.status, data: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJson(url, headers) {
    const http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    if (!http && !WEB) throw new Error("no network");
    const res = http
      ? await http.get({ url, headers: { "User-Agent": "MuhurataTimer", ...(headers || {}) }, connectTimeout: 5000, readTimeout: 5000, responseType: "text" })
      : await webGet(url, headers);
    if (res.status === 404) {
      const err = new Error("not found");
      err.status = 404;
      throw err;
    }
    if (res.status >= 400) throw Object.assign(new Error(`the update server answered ${res.status}`), { status: res.status });
    return typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  }

  function cleanPolicy(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    const blocked = Array.isArray(raw.blocked_versions) ? raw.blocked_versions : [];
    return {
      minimum_version: String(raw.minimum_version || "").replace(/^v/, ""),
      blocked_versions: blocked.map((v) => String(v).replace(/^v/, "")),
      message: String(raw.message || "").slice(0, 500),
    };
  }

  async function updateInfo(force) {
    const data = { ...(S.kv.get("update_check") || {}), k: "update_check" };
    const wait = data.error ? UPDATE_RETRY_MS : UPDATE_CHECK_MS;
    if (!force && Date.now() - Number(data.checked_at || 0) < wait) return data;
    if (updateCheck) return updateCheck;
    updateCheck = (async () => {
      let error = null;
      try {
        if (WEB) {
          const site = await getJson(new URL(D.base + "version.json", location.href).href);
          data.latest = String(site.version || "").replace(/^v/, "") || data.latest;
        } else {
          const rel = await getJson(D.releases_api, { Accept: "application/vnd.github+json" });
          data.latest = String(rel.tag_name || "").replace(/^v/, "") || data.latest;
        }
      } catch (err) {
        error = err.status ? err.message : "no internet connection";
      }
      try {
        data.policy = cleanPolicy(await getJson(D.update_policy_url));
      } catch (err) {
        if (err.status !== 404) error = error || (err.status ? err.message : "no internet connection");
      }
      const now = Date.now();
      data.failing_since = error ? data.failing_since || now : null;
      data.checked_at = now;
      data.error = error;
      await write([["kv", data]]);
      return data;
    })();
    try {
      return await updateCheck;
    } finally {
      updateCheck = null;
    }
  }

  route("GET", /^\/api\/version$/, async ({ q }) => {
    const info = await updateInfo(q.get("refresh") === "1");
    const payload = {
      current: D.version, bundled: true, update_available: false, required: false,
      checked_at: info.checked_at ? info.checked_at / 1000 : null, check_error: info.error || null,
    };
    if (info.error && info.failing_since) {
      payload.check_failing_days = Math.floor((Date.now() - info.failing_since) / 86400000);
      payload.url = D.download_page;
    }
    const latest = info.latest;
    if (!latest || compareVersions(latest, D.version) <= 0) return payload;
    const policy = cleanPolicy(info.policy);
    const required = (Boolean(policy.minimum_version) && compareVersions(D.version, policy.minimum_version) < 0)
      || policy.blocked_versions.some((v) => compareVersions(v, D.version) === 0);
    return { ...payload, update_available: true, latest, how: WEB ? "restart" : "download", url: D.download_page, required, message: policy.message };
  });

  route("POST", /^\/api\/update\/restart$/, () => {
    const pwa = window.__MUHURTA_PWA__;
    if (!WEB || !pwa) throw new HttpError(409, "This copy cannot restart itself.");
    // The new version installs in the background; pwa.js reloads the page once it is in.
    pwa.update();
    return [204, null];
  });

  // Release notes: a new install has nothing to catch up on.
  route("GET", /^\/api\/whats-new$/, async () => {
    const seen = S.kv.get("seen_version");
    if (!seen) {
      await write([["kv", { k: "seen_version", version: D.version }]]);
      return { current: D.version, notes: [] };
    }
    const notes = Object.entries(D.notes)
      .filter(([v]) => compareVersions(v, D.version) <= 0 && compareVersions(v, seen.version) > 0)
      .map(([version, items]) => ({ version, items }));
    if (!notes.length) await write([["kv", { k: "seen_version", version: D.version }]]);
    return { current: D.version, notes };
  });
  route("POST", /^\/api\/whats-new\/seen$/, async () => {
    await write([["kv", { k: "seen_version", version: D.version }]]);
    return [204, null];
  });

  const focusMinutes = (day) => [...S.focus.values()].filter((r) => r.day === day).reduce((a, r) => a + r.minutes, 0);

  route("GET", /^\/api\/focus\/today$/, ({ q }) => {
    const day = DAY_RE.test(q.get("day") || "") ? q.get("day") : localDay(new Date());
    return { day, minutes: focusMinutes(day) };
  });

  route("POST", /^\/api\/focus\/log$/, async ({ body }) => {
    const minutes = Number.parseInt(body.minutes ?? 0, 10);
    if (!Number.isFinite(minutes)) throw new HttpError(400, "Invalid minutes");
    const day = String(body.day || "");
    if (!DAY_RE.test(day)) throw new HttpError(400, "Invalid day");
    if (minutes < 1 || minutes > 240) throw new HttpError(400, "Minutes out of range");
    // Only this phone's row for the day is touched (focus_by_device).
    const me = deviceId();
    const key = `${day}|${me}`;
    const row = S.focus.get(key) || { key, day, device_id: me, minutes: 0, synced_version: null };
    await write([["focus", { ...row, minutes: row.minutes + minutes, updated_at: nowIso() }]]);
    return { day, minutes: focusMinutes(day) };
  });

  route("POST", /^\/api\/activity\/segment$/, async ({ body }) => {
    const kind = String(body.kind || "");
    if (!SEGMENT_KINDS.includes(kind)) throw new HttpError(400, "Invalid activity kind");
    const day = String(body.day || "");
    if (!DAY_RE.test(day)) throw new HttpError(400, "Invalid day");
    let started_at = String(body.started_at || "");
    let ended_at = String(body.ended_at || "");
    const start = parseTime(started_at);
    let end = parseTime(ended_at);
    let duration = Number(body.duration_sec);
    if (start == null || end == null || !Number.isFinite(duration)) throw new HttpError(400, "Invalid activity timing");
    // Safety net: a finished session cannot end in the future.
    const now = Date.now();
    if (end > now + SEGMENT_CLOCK_SLACK_SEC * 1000 && start < now) {
      end = now;
      ended_at = toIso(end);
      duration = (end - start) / 1000;
    }
    if (!(duration >= 0.5 && duration <= 24 * 60 * 60)) throw new HttpError(400, "Activity duration out of range");
    let phase = body.phase_index;
    if (phase != null) {
      phase = Number.parseInt(phase, 10);
      if (!Number.isFinite(phase)) throw new HttpError(400, "Invalid phase index");
    }
    const details = body.details;
    if (details != null && (typeof details !== "object" || Array.isArray(details))) throw new HttpError(400, "Invalid details");
    const seg = await addSegment({
      day, kind, started_at, ended_at, duration_sec: duration,
      preset_id: String(body.preset_id || ""), preset_name: String(body.preset_name || ""),
      phase_index: phase ?? null, details: details || {},
    });
    return [201, seg];
  });

  route("GET", /^\/api\/activity\/day$/, ({ q }) => {
    const day = DAY_RE.test(q.get("day") || "") ? q.get("day") : localDay(new Date());
    const rows = segments().filter((r) => r.day === day).sort(byStartAsc);
    const counted = countSharedTimeOnce(rows).map(([item]) => item);
    const productive = counted.reduce((a, s) => a + Number(s.productive_sec), 0);
    const rest = counted.reduce((a, s) => a + Number(s.rest_sec), 0);
    const tracked = productive + rest;
    return {
      day,
      segments: rows.map(segmentPublic),
      totals: { productive_sec: productive, rest_sec: rest, tracked_sec: tracked, productivity_pct: tracked ? round((productive / tracked) * 100, 2) : null },
    };
  });

  route("GET", /^\/api\/activity\/history$/, ({ q }) => {
    const earliest = earliestDay();
    if (q.get("long")) {
      return {
        segments: segments().filter((r) => r.duration_sec >= D.long_segment_sec).sort(byStartDesc).slice(0, 200).map(segmentPublic),
        long_threshold_sec: D.long_segment_sec,
        earliest_day: earliest,
      };
    }
    const end = DAY_RE.test(q.get("end") || "") ? q.get("end") : localDay(new Date());
    const days = Math.max(1, Math.min(Number.parseInt(q.get("days") || "7", 10) || 7, 62));
    const start = localDay(addDays(dayFromIso(end), -(days - 1)));
    return {
      start,
      end,
      segments: segments().filter((r) => r.day >= start && r.day <= end).sort(byStartDesc).map(segmentPublic),
      long_threshold_sec: D.long_segment_sec,
      earliest_day: earliest,
    };
  });

  route("POST", /^\/api\/activity\/manual$/, async ({ body }) => {
    const kind = String(body.kind || "");
    if (!["work", "rest"].includes(kind)) throw new HttpError(400, "Choose focus or rest");
    const p = parseHistoryBody(body);
    const clash = overlappingIds(parseTime(p.started_at), parseTime(p.ended_at), null);
    if (clash.size) throw conflict(clash);
    const seg = await addSegment({
      ...p, kind, preset_id: "manual", preset_name: "Added by hand", details: { source: "manual" },
    });
    return [201, seg];
  });

  route("PUT", /^\/api\/activity\/segment\/(\d+)$/, async ({ body, m }) => {
    const p = parseHistoryBody(body);
    const seg = await updateSegment(Number(m[1]), p);
    if (!seg) throw new HttpError(404, "Not found");
    return seg;
  });

  route("DELETE", /^\/api\/activity\/segment\/(\d+)$/, async ({ m }) => {
    const id = Number(m[1]);
    const row = S.segments.get(id);
    if (!row) throw new HttpError(404, "Not found");
    await write([tombstone("activity_segments", row)], [["segments", id]]);
    return [204, null];
  });

  route("GET", /^\/api\/dashboard$/, ({ q }) => {
    const day = q.get("day");
    if (day && !DAY_RE.test(day)) throw new HttpError(400, "Invalid day");
    let year = null;
    if (q.get("year")) {
      year = Number.parseInt(q.get("year"), 10);
      if (!Number.isFinite(year)) throw new HttpError(400, "Invalid year");
    }
    return dashboard(day, Number.parseInt(q.get("days") || "365", 10) || 365, year);
  });

  /* ------------------------------------------------------------------ */
  /* answering fetch("/api/...")                                         */
  /* ------------------------------------------------------------------ */

  const json = (status, body) =>
    status === 204 || body === null
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // What works before signing in (app.py OPEN_ENDPOINTS).
  const OPEN = /^\/api\/(cloud\/(status|sign-in|send-code|verify|set-password|cancel|username-available|providers|oauth\/start)|alive|version|update\/restart)$/;

  async function handle(method, url, bodyText) {
    await ready;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const account = window.__MUHURTA_ACCOUNT__;
    if (account && !OPEN.test(path) && !account.signedIn()) {
      return new Response(JSON.stringify({ error: "Please sign in first." }), {
        status: 401, headers: { "Content-Type": "application/json", "X-Signed-Out": "1" },
      });
    }
    let body = {};
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) || {};
      } catch (_) {
        body = {};
      }
    }
    for (const r of routes) {
      if (r.method !== "*" && r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      try {
        const out = await r.fn({ body, q: url.searchParams, m });
        const res = Array.isArray(out) ? json(out[0], out[1]) : json(200, out);
        // Any saved change syncs a few seconds later (app.py _sync_after_change).
        if (method !== "GET" && res.status < 400 && !/^\/api\/(cloud\/|alive)/.test(path) && account) account.nudge();
        return res;
      } catch (err) {
        if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
        console.error("local api", method, path, err);
        return json(500, { error: "Something went wrong on this phone. Try again." });
      }
    }
    return json(404, { error: "Not found" });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = String((init && init.method) || (req && req.method) || "GET").toUpperCase();
    let bodyText = init && init.body != null ? init.body : null;
    if (bodyText == null && req && method !== "GET") bodyText = await req.text();
    return handle(method, url, typeof bodyText === "string" ? bodyText : null);
  };

  // navigator.sendBeacon carries the "page closed" ping; nothing to do here.
  const realBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  navigator.sendBeacon = function (target, data) {
    try {
      const url = new URL(String(target), location.href);
      if (url.origin === location.origin && url.pathname.startsWith("/api/")) return true;
    } catch (_) {}
    return realBeacon ? realBeacon(target, data) : false;
  };

  // account.js (sign-in and sync) builds on these; tests in the emulator use them too.
  window.__MUHURTA_LOCAL__ = {
    ready, stores: S, deviceId: () => deviceId(), cloudConfigured: false, notifications: false,
    internals: { S, write, route, routes, HttpError, nowIso, loadSettings, rememberTheme, applyTheme, parseTime },
  };
})();
