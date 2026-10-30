// The phone's side of backup.py, rule for rule: a backup file of the
// account's data, the sessions as CSV, and putting a backup back. When one of
// them changes, change the other.
//
// The file holds rows in the server's shape (account.js TABLES), so a backup
// made on a phone restores on a computer and the other way round. Restoring
// adds back what is missing and never changes anything still here; what it
// adds is stamped as a change made now, so it uploads to the account.
(function () {
  "use strict";

  const D = window.__MUHURTA__;
  const L = window.__MUHURTA_LOCAL__;
  const { S, write, route, HttpError, nowIso } = L.internals;
  const R = L.syncRows;

  const FORMAT = 1;
  const KIND_NAMES = { work: "Focus", extend: "Overtime", timer: "Timer", flow: "Flow",
    rest: "Rest", cumulative: "Rest pool", pause: "Pause" };
  const MAX_ROWS = 200000;

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  function file(text, name, type) {
    return new Response(text, {
      status: 200,
      headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"` },
    });
  }

  function exportData() {
    const data = {
      app: "muhurta-pomodoro", kind: "backup", format: FORMAT, exported_at: nowIso(),
      app_version: D.version, email: R.email(),
    };
    for (const [table, t] of Object.entries(R.TABLES)) {
      data[table] = [...S[t.store].values()]
        .filter((r) => r.uuid)
        .sort((a, b) => a.id - b.id)
        .map((r) => ({ uuid: r.uuid, updated_at: r.updated_at, ...t.toServer(r) }));
    }
    data.focus_by_device = [...S.focus.values()]
      .map((r) => ({ day: r.day, device_id: r.device_id, minutes: r.minutes, updated_at: r.updated_at }))
      .sort((a, b) => (a.day + a.device_id).localeCompare(b.day + b.device_id));
    const mine = R.settingsRow().json || {};
    data.settings = Object.fromEntries(Object.entries(mine).filter(([k]) => !R.LOCAL_ONLY_SETTINGS.includes(k)));
    return data;
  }

  const csvCell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  function localTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso || "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const minutes = (sec) => ((Number(sec) || 0) / 60).toFixed(1);

  function sessionsCsv() {
    const lines = [["Date", "Kind", "Started", "Ended", "Minutes", "Focus minutes", "Rest minutes", "Combination"]];
    const rows = exportData().activity_segments.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    for (const r of rows) {
      lines.push([r.day, KIND_NAMES[r.kind] || r.kind, localTime(r.started_at), localTime(r.ended_at),
        minutes(r.duration_sec), minutes(r.productive_sec), minutes(r.rest_sec), r.preset_name || ""]);
    }
    return lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  function rowsOf(data, key) {
    const rows = data[key] || [];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS || !rows.every((r) => r && typeof r === "object")) {
      throw new HttpError(400, "This backup file is damaged.");
    }
    return rows;
  }

  async function restore(data) {
    if (!data || data.app !== "muhurta-pomodoro" || data.kind !== "backup") {
      throw new HttpError(400, "That isn't a Muhurta backup file.");
    }
    if (!Number.isInteger(data.format) || data.format > FORMAT) {
      throw new HttpError(400, "This backup comes from a newer version of the app. Update first, then restore it.");
    }
    const added = { sessions: 0, combinations: 0, days: 0, settings: false };
    const stamp = nowIso();
    for (const [table, label] of [["activity_segments", "sessions"], ["custom_presets", "combinations"]]) {
      const t = R.TABLES[table];
      const have = new Set([...S[t.store].values()].map((r) => r.uuid));
      const puts = [];
      const deletes = [];
      let id = R.nextId(t.store);
      for (const r of rowsOf(data, table)) {
        if (typeof r.uuid !== "string" || !r.uuid || have.has(r.uuid)) continue;
        if (t.cols.some((c) => c !== "preset_id" && c !== "preset_name" && c !== "phase_index" && c !== "device_id" && r[c] == null)) continue;
        puts.push([t.store, { id: id++, uuid: r.uuid, ...t.fromServer(r), updated_at: stamp, synced_version: null }]);
        deletes.push(["tombstones", `${table}|${r.uuid}`]);
        have.add(r.uuid);
        added[label]++;
      }
      await write(puts, deletes);
    }
    const focus = [];
    for (const r of rowsOf(data, "focus_by_device")) {
      const key = `${r.day}|${r.device_id}`;
      if (!r.day || !r.device_id || !Number.isFinite(Number(r.minutes)) || S.focus.has(key)) continue;
      focus.push(["focus", { key, day: String(r.day), device_id: String(r.device_id), minutes: Math.trunc(Number(r.minutes)), updated_at: stamp, synced_version: null }]);
    }
    await write(focus);
    added.days = focus.length;
    const settings = data.settings;
    if (settings && typeof settings === "object" && Object.keys(settings).length && !R.hasOwnSettings()) {
      const row = R.settingsRow();
      const merged = {};
      for (const [k, v] of Object.entries(settings)) if (!R.LOCAL_ONLY_SETTINGS.includes(k)) merged[k] = v;
      for (const k of R.LOCAL_ONLY_SETTINGS) if (k in (row.json || {})) merged[k] = row.json[k];
      await write([["kv", { ...row, json: merged, updated_at: stamp }]]);
      added.settings = true;
    }
    return added;
  }

  route("GET", /^\/api\/backup$/, () =>
    file(JSON.stringify(exportData(), null, 1), `muhurta-backup-${today()}.json`, "application/json"));
  route("GET", /^\/api\/backup\/sessions\.csv$/, () =>
    file(sessionsCsv(), `muhurta-sessions-${today()}.csv`, "text/csv"));
  route("POST", /^\/api\/backup\/restore$/, ({ body }) => restore(body));
})();
