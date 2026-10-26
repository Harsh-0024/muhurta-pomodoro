// Signing in and syncing on the phone: cloud.py and sync.py, rule for rule.
// When one of those changes, change the matching part here too.
//
// The phone keeps its own full copy of the account's data (local-api.js) and
// only copies changes in both directions when signed in and online: rows
// whose synced_version differs from updated_at go up, deletes go up from the
// tombstones, and everything the server stamped since the last download comes
// down. Newest change wins, on the server (keep_newest in supabase/schema.sql)
// and here. Failures are remembered and retried; they never reach the timer.
(function () {
  "use strict";

  const D = window.__MUHURTA__;
  const L = window.__MUHURTA_LOCAL__;
  const { S, write, route, HttpError, nowIso, loadSettings, rememberTheme, applyTheme } = L.internals;
  const URL_BASE = String(D.supabase_url || "").replace(/\/+$/, "");
  const KEY = D.supabase_key;
  const CONFIGURED = Boolean(URL_BASE && KEY);

  const TIMEOUT_MS = 15000;
  const REFRESH_EARLY = 120;
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const CODE_RE = /^\d{6,10}$/;
  const USERNAME_RE = /^[a-z][a-z0-9_.]{2,19}$/;
  const NAME_MAX = 50;
  const PASSWORD_MIN = 8;
  const PASSWORD_MAX = 72;
  const PROFILE_KEYS = ["first_name", "last_name", "username"];

  const INTERVAL_MS = 300 * 1000;
  const DEBOUNCE_MS = 5000;
  const PULL_OVERLAP_MS = 5 * 60 * 1000;
  const PAGE = 1000;
  const PUSH_CHUNK = 500;
  const LOCAL_ONLY_SETTINGS = ["sound_volume", "notifications_enabled", "default_preset_id"];
  const NEVER = "1970-01-01T00:00:00.000Z";
  const DEVICE_REPORT_EVERY_MS = 6 * 60 * 60 * 1000;
  const SEGMENT_COLS = ["day", "kind", "started_at", "ended_at", "duration_sec", "productive_sec", "rest_sec",
    "preset_id", "preset_name", "phase_index", "details_json", "created_at", "device_id"];
  const PRESET_COLS = ["name", "work_min", "short_rest_min", "long_rest_min", "created_at"];

  const offline = () => new HttpError(503, "No internet connection right now. Try again when you are online.");

  /* ------------------------------------------------------------------ */
  /* HTTP                                                                */
  /* ------------------------------------------------------------------ */

  // The app's own native HTTP (CapacitorHttp) when it is there: no browser
  // CORS rules, and it works the same against a test server.
  async function request(method, path, body, token, headers) {
    if (!CONFIGURED) throw new HttpError(503, "Sync is not available in this version of the app.");
    const h = { apikey: KEY, Accept: "application/json", ...(headers || {}) };
    if (body !== undefined && body !== null) h["Content-Type"] = "application/json";
    if (token) h.Authorization = `Bearer ${token}`;
    const url = `${URL_BASE}${path}`;
    const http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    let status;
    let text;
    try {
      if (http) {
        const res = await http.request({
          url, method, headers: h, data: body ?? undefined, connectTimeout: TIMEOUT_MS, readTimeout: TIMEOUT_MS,
          responseType: "text",
        });
        status = res.status;
        text = typeof res.data === "string" ? res.data : res.data == null ? "" : JSON.stringify(res.data);
      } else {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        const res = await fetch(url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), signal: ctl.signal });
        clearTimeout(timer);
        status = res.status;
        text = await res.text();
      }
    } catch (_) {
      throw offline();
    }
    if (!status) throw offline();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_) {
      payload = null;
    }
    return [status, payload];
  }

  function errorText(payload) {
    if (!payload || typeof payload !== "object") return "";
    return ["error_code", "code", "error", "msg", "message", "error_description"].map((k) => String(payload[k] || "")).join(" ").toLowerCase();
  }

  /* ------------------------------------------------------------------ */
  /* the session (cloud_session.json on a computer)                      */
  /* ------------------------------------------------------------------ */

  const session = () => {
    const s = S.kv.get("cloud_session");
    return s && s.refresh_token ? s : null;
  };

  // The name Google or Microsoft gave us, to fill in the profile step.
  function nameFrom(user) {
    const meta = user && user.user_metadata;
    if (!meta || typeof meta !== "object") return "";
    return String(meta.full_name || meta.name || "").trim().slice(0, 100);
  }

  function profileFrom(user) {
    const meta = user && user.user_metadata;
    if (!meta || typeof meta !== "object" || !meta.username) return null;
    return Object.fromEntries(PROFILE_KEYS.map((k) => [k, String(meta[k] || "")]));
  }

  // Halfway through (after the code, before the password), the sign-in page
  // picks up where it stopped; it reads this as it loads, before storage opens.
  const PENDING_KEY = "muhurta-pending";
  // And whether this phone is signed in, so a page can send you to sign-in
  // (or away from it) the moment it starts, before anything is drawn.
  const AUTH_KEY = "muhurta-signed-in";
  // Signed in without a name yet: the sign-in page asks for it first.
  const NEEDS_PROFILE_KEY = "muhurta-needs-profile";
  function rememberPending(s) {
    try {
      if (s && !s.password_pending && !s.profile && s.from_provider) {
        localStorage.setItem(NEEDS_PROFILE_KEY, JSON.stringify({ email: s.email || "", name: s.suggested_name || "" }));
      } else localStorage.removeItem(NEEDS_PROFILE_KEY);
      if (s && s.password_pending) localStorage.setItem(PENDING_KEY, JSON.stringify({ email: s.email || "", profile: Boolean(s.profile) }));
      else localStorage.removeItem(PENDING_KEY);
      if (s && !s.password_pending) localStorage.setItem(AUTH_KEY, "1");
      else localStorage.removeItem(AUTH_KEY);
    } catch (_) {}
  }

  async function saveSession(payload, passwordPending, profile, fromProvider) {
    const user = payload.user || {};
    const expiresAt = payload.expires_at || Date.now() / 1000 + Number(payload.expires_in || 3600);
    const s = {
      k: "cloud_session",
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: Math.floor(expiresAt),
      user_id: user.id,
      email: user.email,
      password_pending: Boolean(passwordPending),
      profile: profileFrom(user) || profile || null,
      suggested_name: nameFrom(user) || ((session() || {}).suggested_name || ""),
      from_provider: Boolean(fromProvider),
    };
    await write([["kv", s]]);
    rememberPending(s);
    return s;
  }

  async function forget() {
    await write([], [["kv", "cloud_session"]]);
    rememberPending(null);
  }

  function status() {
    const s = session();
    const pending = Boolean(s && s.password_pending);
    return {
      configured: CONFIGURED,
      signed_in: Boolean(s) && !pending,
      password_pending: pending,
      email: s ? s.email : null,
      profile: (s && s.profile) || null,
      suggested_name: (s && s.suggested_name) || "",
    };
  }

  /* ------------------------------------------------------------------ */
  /* what an account must look like                                      */
  /* ------------------------------------------------------------------ */

  function passwordProblems(password, email, username) {
    const p = [];
    if (password.length < PASSWORD_MIN) p.push(`at least ${PASSWORD_MIN} characters`);
    if (new TextEncoder().encode(password).length > PASSWORD_MAX) p.push(`at most ${PASSWORD_MAX} characters`);
    if (!/[a-z]/.test(password)) p.push("a lowercase letter");
    if (!/[A-Z]/.test(password)) p.push("a capital letter");
    if (!/\d/.test(password)) p.push("a number");
    if (!/[^A-Za-z0-9\s]/.test(password)) p.push("a symbol, like ! ? # or @");
    const lowered = password.toLowerCase();
    for (const part of [username || "", (email || "").split("@")[0]]) {
      if (part && part.length >= 3 && lowered.includes(part.toLowerCase())) {
        p.push("not your username or email");
        break;
      }
    }
    return p;
  }

  function cleanProfile(first, last, username) {
    const f = String(first || "").split(/\s+/).filter(Boolean).join(" ");
    const l = String(last || "").split(/\s+/).filter(Boolean).join(" ");
    const u = String(username || "").trim().toLowerCase().replace(/^@+/, "");
    if (!f) throw new HttpError(400, "Enter your first name.");
    if (f.length > NAME_MAX || l.length > NAME_MAX) throw new HttpError(400, `Names can be at most ${NAME_MAX} characters.`);
    if (!USERNAME_RE.test(u)) throw new HttpError(400, "A username is 3 to 20 characters: letters, numbers, _ or ., starting with a letter.");
    return { first_name: f, last_name: l, username: u };
  }

  function cleanEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(e)) throw new HttpError(400, "That doesn't look like an email address.");
    return e;
  }

  async function usernameAvailable(name) {
    const u = String(name || "").trim().toLowerCase();
    if (!USERNAME_RE.test(u)) return false;
    const s = session();
    const token = s && s.expires_at > Date.now() / 1000 ? s.access_token : null;
    const [code, payload] = await request("POST", "/rest/v1/rpc/username_available", { name: u }, token);
    if (code === 200 && typeof payload === "boolean") return payload;
    if (code === 404) return true;
    throw new HttpError(502, "Couldn't check that username right now. Try again.");
  }

  async function storeProfile(profile, token) {
    let [code, payload] = await request("POST", "/rest/v1/profiles?on_conflict=user_id",
      { ...profile, updated_at: new Date().toISOString().slice(0, 19) + "Z" }, token,
      { Prefer: "resolution=merge-duplicates,return=minimal" });
    if (code === 409 || errorText(payload).includes("23505")) throw new HttpError(409, "Someone just took that username. Choose another.");
    if (code >= 400 && code !== 404) throw new HttpError(502, "Your name couldn't be saved. Try again.");
    [code] = await request("PUT", "/auth/v1/user", { data: profile }, token);
    if (code >= 400) throw new HttpError(502, "Your name couldn't be saved. Try again.");
    const s = session();
    if (s) {
      const next = { ...s, profile };
      await write([["kv", next]]);
      rememberPending(next); // a name now: the app opens normally from here on
    }
  }

  let refreshing = null;

  // A valid access token, renewed if needed. null when signed out.
  async function accessToken() {
    if (refreshing) return refreshing;
    const s = session();
    if (!s) return null;
    if (s.expires_at - REFRESH_EARLY > Date.now() / 1000) return s.access_token;
    refreshing = (async () => {
      const [code, payload] = await request("POST", "/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
      if (code < 400 && payload && payload.access_token) {
        payload.user = payload.user || { id: s.user_id, email: s.email };
        return (await saveSession(payload, s.password_pending, s.profile, s.from_provider)).access_token;
      }
      if ([400, 401, 403].includes(code)) {
        // Revoked or expired (signed out elsewhere): sign out here too.
        await forget();
        return null;
      }
      throw new HttpError(502, "The sync service is having trouble. It will try again later.");
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }

  async function signOutOfService() {
    const s = session();
    if (s) {
      try {
        // scope=local: this phone only; Supabase's default signs out everywhere.
        await request("POST", "/auth/v1/logout?scope=local", {}, s.access_token);
      } catch (_) {}
    }
    await forget();
  }

  /* ------------------------------------------------------------------ */
  /* sync state (sync_state.json on a computer)                          */
  /* ------------------------------------------------------------------ */

  const loadState = () => ({ ...(S.kv.get("sync_state") || {}), k: "sync_state" });
  const saveState = (st) => write([["kv", { ...st, k: "sync_state" }]]);
  let running = false;

  function pendingChanges() {
    let n = 0;
    for (const r of S.segments.values()) if (r.synced_version !== r.updated_at) n++;
    for (const r of S.presets.values()) if (r.synced_version !== r.updated_at) n++;
    for (const r of S.focus.values()) if (r.synced_version !== r.updated_at) n++;
    const st = S.kv.get("settings");
    if (st && st.synced_version !== st.updated_at) n++;
    return n + S.tombstones.size;
  }

  function syncStatus() {
    const st = loadState();
    return { running, last_sync: st.last_sync || null, error: st.last_error || null, pending: pendingChanges() };
  }

  /* ------------------------------------------------------------------ */
  /* signing in to a new account / clearing                              */
  /* ------------------------------------------------------------------ */

  function settingsRow() {
    return S.kv.get("settings");
  }

  async function settingsLoseToAccount(extra) {
    await write([["kv", { ...settingsRow(), ...(extra || {}), updated_at: NEVER, synced_version: NEVER }]]);
  }

  // Empty the phone of everything that belongs to an account. Kept: the
  // settings that belong to the phone (volume, notification permission).
  async function clearAccountData() {
    const deletes = [
      ...[...S.segments.keys()].map((k) => ["segments", k]),
      ...[...S.presets.keys()].map((k) => ["presets", k]),
      ...[...S.focus.keys()].map((k) => ["focus", k]),
      ...[...S.tombstones.keys()].map((k) => ["tombstones", k]),
    ];
    await write([], deletes);
    const mine = settingsRow().json || {};
    const kept = {};
    for (const k of LOCAL_ONLY_SETTINGS) if (k in mine && k !== "default_preset_id") kept[k] = mine[k];
    await settingsLoseToAccount({ json: kept });
  }

  function hasOwnSettings() {
    return Object.keys(settingsRow().json || {}).some((k) => !LOCAL_ONLY_SETTINGS.includes(k));
  }

  // An account this phone has not synced with yet: data that belongs to
  // another account is cleared; data that belongs to nobody (used before
  // signing in) is added to the account.
  async function switchAccount(st, uid) {
    if (st.user_id) {
      await clearAccountData();
    } else {
      const puts = [];
      for (const r of S.segments.values()) if (r.synced_version != null) puts.push(["segments", { ...r, synced_version: null }]);
      for (const r of S.presets.values()) if (r.synced_version != null) puts.push(["presets", { ...r, synced_version: null }]);
      for (const r of S.focus.values()) if (r.synced_version != null) puts.push(["focus", { ...r, synced_version: null }]);
      if (settingsRow().synced_version != null) puts.push(["kv", { ...settingsRow(), synced_version: null }]);
      await write(puts);
      if (!hasOwnSettings()) await settingsLoseToAccount();
    }
    for (const k of Object.keys(st)) if (k !== "k") delete st[k];
    st.user_id = uid;
  }

  /* ------------------------------------------------------------------ */
  /* one full sync                                                       */
  /* ------------------------------------------------------------------ */

  async function api(method, path, token, body, prefer) {
    const [code, payload] = await request(method, `/rest/v1/${path}`, body, token, prefer ? { Prefer: prefer } : undefined);
    if (code >= 400) {
      console.warn("sync", method, path.split("?")[0], code, payload);
      if (code === 401 || code === 403) throw new HttpError(502, "Your sign-in needs renewing. It will retry shortly.");
      throw new HttpError(502, "The sync service refused a change. It will retry later.");
    }
    return payload;
  }

  async function upsert(table, conflict, rows, token) {
    for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
      await api("POST", `${table}?on_conflict=${conflict}`, token, rows.slice(i, i + PUSH_CHUNK), "resolution=merge-duplicates,return=minimal");
    }
  }

  // The server's columns for a phone row (details are kept as an object here).
  function segmentToServer(r) {
    const out = {};
    for (const c of SEGMENT_COLS) out[c] = c === "details_json" ? JSON.stringify(r.details || {}) : r[c] ?? null;
    return out;
  }

  const TABLES = {
    activity_segments: {
      store: "segments", cols: SEGMENT_COLS, toServer: segmentToServer,
      fromServer: (r) => {
        let details = {};
        try {
          details = JSON.parse(r.details_json || "{}") || {};
        } catch (_) {}
        const out = { details };
        for (const c of SEGMENT_COLS) if (c !== "details_json") out[c] = r[c] ?? null;
        return out;
      },
    },
    custom_presets: {
      store: "presets", cols: PRESET_COLS,
      toServer: (r) => Object.fromEntries(PRESET_COLS.map((c) => [c, r[c] ?? null])),
      fromServer: (r) => Object.fromEntries(PRESET_COLS.map((c) => [c, r[c] ?? null])),
    },
  };

  async function pushRows(table, uid, token) {
    const t = TABLES[table];
    const rows = [...S[t.store].values()].filter((r) => r.uuid && r.synced_version !== r.updated_at);
    if (!rows.length) return 0;
    await upsert(table, "user_id,uuid", rows.map((r) => ({ user_id: uid, deleted_at: null, uuid: r.uuid, updated_at: r.updated_at, ...t.toServer(r) })), token);
    // Only rows not edited while uploading are marked done.
    const puts = [];
    for (const r of rows) {
      const now = S[t.store].get(r.id);
      if (now && now.updated_at === r.updated_at) puts.push([t.store, { ...now, synced_version: r.updated_at }]);
    }
    await write(puts);
    return rows.length;
  }

  async function pushDeletes(table, token) {
    const uuids = [...S.tombstones.values()].filter((t) => t.table_name === table).map((t) => t.uuid);
    for (let i = 0; i < uuids.length; i += 100) {
      const chunk = uuids.slice(i, i + 100);
      const stamp = nowIso();
      // An update, not an upsert: a row deleted before it ever reached the
      // server has nothing there to delete, and that is fine.
      await api("PATCH", `${table}?uuid=in.(${chunk.join(",")})`, token, { deleted_at: stamp, updated_at: stamp }, "return=minimal");
      await write([], chunk.map((u) => ["tombstones", `${table}|${u}`]));
    }
    return uuids.length;
  }

  async function pushSettings(uid, token) {
    const row = settingsRow();
    if (row.synced_version === row.updated_at) return 0;
    const shared = {};
    for (const [k, v] of Object.entries(row.json || {})) if (!LOCAL_ONLY_SETTINGS.includes(k)) shared[k] = v;
    await upsert("app_settings", "user_id", [{ user_id: uid, json: JSON.stringify(shared), updated_at: row.updated_at, deleted_at: null }], token);
    const now = settingsRow();
    if (now.updated_at === row.updated_at) await write([["kv", { ...now, synced_version: row.updated_at }]]);
    return 1;
  }

  async function pushFocus(uid, token) {
    const rows = [...S.focus.values()].filter((r) => r.synced_version !== r.updated_at);
    if (!rows.length) return 0;
    await upsert("focus_by_device", "user_id,day,device_id",
      rows.map((r) => ({ user_id: uid, deleted_at: null, day: r.day, device_id: r.device_id, minutes: r.minutes, updated_at: r.updated_at })), token);
    const puts = [];
    for (const r of rows) {
      const now = S.focus.get(r.key);
      if (now && now.updated_at === r.updated_at) puts.push(["focus", { ...now, synced_version: r.updated_at }]);
    }
    await write(puts);
    return rows.length;
  }

  async function pull(table, cursor, token) {
    let query = `select=*&order=server_updated_at.asc&limit=${PAGE}`;
    if (cursor) {
      const since = new Date(Date.parse(cursor) - PULL_OVERLAP_MS).toISOString();
      query += "&server_updated_at=gt." + encodeURIComponent(since);
    }
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = (await api("GET", `${table}?${query}&offset=${offset}`, token)) || [];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    let newest = cursor || null;
    for (const r of rows) if (!newest || Date.parse(r.server_updated_at) > Date.parse(newest)) newest = r.server_updated_at;
    return [rows, newest];
  }

  function nextId(store) {
    let max = 0;
    for (const id of S[store].keys()) max = Math.max(max, id);
    return max + 1;
  }

  async function applyRows(table, rows) {
    const t = TABLES[table];
    const byUuid = new Map([...S[t.store].values()].map((r) => [r.uuid, r]));
    let changed = 0;
    for (const r of rows) {
      const local = byUuid.get(r.uuid);
      if (r.deleted_at) {
        // A delete from the server: nothing to send back.
        const del = [["tombstones", `${table}|${r.uuid}`]];
        if (local) {
          del.push([t.store, local.id]);
          byUuid.delete(r.uuid);
          changed++;
        }
        await write([], del);
        continue;
      }
      if (!local) {
        if (S.tombstones.has(`${table}|${r.uuid}`)) continue; // deleted here; on its way up
        const row = { id: nextId(t.store), uuid: r.uuid, ...t.fromServer(r), updated_at: r.updated_at, synced_version: r.updated_at };
        await write([[t.store, row]]);
        byUuid.set(r.uuid, row);
        changed++;
      } else if (r.updated_at > local.updated_at) {
        const row = { ...local, ...t.fromServer(r), updated_at: r.updated_at, synced_version: r.updated_at };
        await write([[t.store, row]]);
        byUuid.set(r.uuid, row);
        changed++;
      } else if (r.updated_at === local.updated_at && local.synced_version !== local.updated_at) {
        await write([[t.store, { ...local, synced_version: local.updated_at }]]);
      }
      // else: the copy here is newer and goes up on the next upload
    }
    return changed;
  }

  async function applySettings(rows) {
    if (!rows.length) return 0;
    const r = rows[rows.length - 1];
    const local = settingsRow();
    if (r.updated_at < (local.updated_at || "")) return 0;
    if (r.updated_at === local.updated_at) {
      if (local.synced_version !== local.updated_at) await write([["kv", { ...local, synced_version: local.updated_at }]]);
      return 0;
    }
    const mine = local.json || {};
    let theirs = {};
    try {
      theirs = JSON.parse(r.json || "{}") || {};
    } catch (_) {}
    const merged = {};
    for (const [k, v] of Object.entries(theirs)) if (!LOCAL_ONLY_SETTINGS.includes(k)) merged[k] = v;
    for (const k of LOCAL_ONLY_SETTINGS) if (k in mine) merged[k] = mine[k];
    await write([["kv", { ...local, json: merged, updated_at: r.updated_at, synced_version: r.updated_at }]]);
    const theme = loadSettings().theme;
    rememberTheme(theme);
    applyTheme(theme);
    return 1;
  }

  async function applyFocus(rows) {
    let changed = 0;
    for (const r of rows) {
      const key = `${r.day}|${r.device_id}`;
      const local = S.focus.get(key);
      if (local && r.updated_at <= local.updated_at) {
        if (r.updated_at === local.updated_at && local.synced_version !== local.updated_at) {
          await write([["focus", { ...local, synced_version: local.updated_at }]]);
        }
        continue;
      }
      await write([["focus", { key, day: r.day, device_id: r.device_id, minutes: r.minutes, updated_at: r.updated_at, synced_version: r.updated_at }]]);
      changed++;
    }
    return changed;
  }

  async function reportVersion(st, uid, token) {
    const last = st.device_report || {};
    if (last.version === D.version && Date.now() - Number(last.at || 0) < DEVICE_REPORT_EVERY_MS) return;
    try {
      const [code, payload] = await request("POST", "/rest/v1/app_devices?on_conflict=user_id,device_id",
        { user_id: uid, device_id: L.deviceId(), app_version: D.version, platform: D.platform || "android", last_seen: nowIso() }, token,
        { Prefer: "resolution=merge-duplicates,return=minimal" });
      if (code < 400 || code === 404) st.device_report = { version: D.version, at: Date.now() };
      else console.warn("version report", code, payload);
    } catch (_) {}
  }

  async function doSync(st, uid, token) {
    if (st.user_id !== uid) await switchAccount(st, uid);
    // Deletes go first, so a download cannot bring back a row deleted here.
    let up = 0;
    for (const t of Object.keys(TABLES)) up += await pushDeletes(t, token);
    for (const t of Object.keys(TABLES)) up += await pushRows(t, uid, token);
    up += (await pushSettings(uid, token)) + (await pushFocus(uid, token));
    st.cursors = st.cursors || {};
    let down = 0;
    for (const t of Object.keys(TABLES)) {
      let rows;
      [rows, st.cursors[t]] = await pull(t, st.cursors[t], token);
      down += await applyRows(t, rows);
    }
    let rows;
    [rows, st.cursors.app_settings] = await pull("app_settings", st.cursors.app_settings, token);
    down += await applySettings(rows);
    [rows, st.cursors.focus_by_device] = await pull("focus_by_device", st.cursors.focus_by_device, token);
    down += await applyFocus(rows);
    await reportVersion(st, uid, token);
    return [up, down];
  }

  let syncing = null;

  // Upload, then download. Never throws; the result is in syncStatus().
  function runOnce() {
    if (syncing) return syncing;
    syncing = (async () => {
      running = true;
      const st = loadState();
      try {
        const token = await accessToken();
        const s = session();
        if (token && s && s.user_id && !s.password_pending) {
          const [up, down] = await doSync(st, s.user_id, token);
          st.last_sync = nowIso();
          st.last_error = null;
          if (up || down) {
            console.info(`sync: ${up} up, ${down} down`);
            if (down) window.dispatchEvent(new CustomEvent("muhurta:synced", { detail: { up, down } }));
          }
        }
      } catch (err) {
        st.last_error = err instanceof HttpError ? (err.status === 503 ? "offline" : err.message) : "Something went wrong while syncing. It will retry later.";
        if (!(err instanceof HttpError)) console.error("sync failed", err);
      } finally {
        running = false;
        await saveState(st);
      }
      return syncStatus();
    })();
    return syncing.finally(() => {
      syncing = null;
    });
  }

  async function enterAccount() {
    const s = session();
    if (s && s.user_id) {
      const st = loadState();
      if (st.user_id !== s.user_id) {
        await switchAccount(st, s.user_id);
        await saveState(st);
      }
    }
    return runOnce();
  }

  let wakeTimer = null;
  function nudge() {
    if (!status().signed_in) return;
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(runOnce, DEBOUNCE_MS);
  }

  const fullStatus = () => {
    const st = status();
    st.sync = st.signed_in ? syncStatus() : null;
    return st;
  };

  /* ------------------------------------------------------------------ */
  /* the /api/cloud endpoints                                            */
  /* ------------------------------------------------------------------ */

  const profileFromBody = (b) => cleanProfile(b.first_name, b.last_name, b.username);

  route("GET", /^\/api\/cloud\/status$/, () => fullStatus());

  route("POST", /^\/api\/cloud\/sync-now$/, async () => {
    await runOnce();
    return fullStatus();
  });

  route("POST", /^\/api\/cloud\/sign-in$/, async ({ body }) => {
    const email = cleanEmail(body.email);
    const password = String(body.password || "");
    if (!password) throw new HttpError(400, "Enter your password.");
    const [code, payload] = await request("POST", "/auth/v1/token?grant_type=password", { email, password });
    if (code === 429) throw new HttpError(429, "Too many tries. Wait a minute, then try again.");
    if (code >= 400 || !payload || !payload.access_token) {
      if (errorText(payload).includes("email_not_confirmed")) throw new HttpError(400, "This email isn't confirmed yet. Use Create an account to get a code.");
      throw new HttpError(401, "Wrong email or password. Forgot it? Reset it with a code.");
    }
    await saveSession(payload);
    await enterAccount();
    return fullStatus();
  });

  route("POST", /^\/api\/cloud\/send-code$/, async ({ body }) => {
    const newAccount = body.purpose !== "reset";
    if (newAccount) {
      const profile = profileFromBody(body);
      if (!(await usernameAvailable(profile.username))) {
        throw new HttpError(409, "That username is taken. Choose another.", { field: "username" });
      }
    }
    const email = cleanEmail(body.email);
    const [code, payload] = await request("POST", "/auth/v1/otp", { email, create_user: newAccount });
    const text = errorText(payload);
    if (code === 429 || text.includes("rate")) throw new HttpError(429, "Too many codes asked for. Wait a minute, then try again.");
    if (code >= 400 && !newAccount && (text.includes("signup") || text.includes("not found") || text.includes("otp_disabled"))) {
      throw new HttpError(404, "There's no account with that email. Create one instead.");
    }
    if (code >= 400) throw new HttpError(502, "The code could not be sent. Check the address and try again.");
    return { sent: true };
  });

  route("GET", /^\/api\/cloud\/username-available$/, async ({ q }) => ({ available: await usernameAvailable(q.get("name")) }));

  route("PUT", /^\/api\/cloud\/profile$/, async ({ body }) => {
    const profile = profileFromBody(body);
    const current = (status().profile || {}).username;
    if (profile.username !== current && !(await usernameAvailable(profile.username))) {
      throw new HttpError(409, "That username is taken. Choose another.");
    }
    const token = await accessToken();
    if (!token) throw new HttpError(401, "Please sign in first.");
    await storeProfile(profile, token);
    return status();
  });

  route("POST", /^\/api\/cloud\/verify$/, async ({ body }) => {
    const email = String(body.email || "").trim().toLowerCase();
    const code = String(body.code || "").replace(/\s+/g, "");
    if (!CODE_RE.test(code)) throw new HttpError(400, "The code is the number in the email, 6 digits or more.");
    const [status_, payload] = await request("POST", "/auth/v1/verify", { type: "email", email, token: code });
    if (status_ === 429) throw new HttpError(429, "Too many tries. Wait a minute, then try again.");
    if (status_ >= 400 || !payload || !payload.access_token) {
      throw new HttpError(400, "That code is wrong or has expired. Ask for a new one if it is over an hour old.");
    }
    await saveSession(payload, true); // usable once a password is chosen
    return status();
  });

  route("POST", /^\/api\/cloud\/set-password$/, async ({ body }) => {
    const password = String(body.password || "");
    const profile = body.username ? profileFromBody(body) : null;
    const s = session() || {};
    const problems = passwordProblems(password, s.email || "", (profile || {}).username || "");
    if (problems.length) throw new HttpError(400, "Your password needs " + problems.join(", ") + ".");
    const token = await accessToken();
    if (!token) throw new HttpError(401, "That took too long. Start again with a new code.");
    if (profile) await storeProfile(profile, token);
    const [code, payload] = await request("PUT", "/auth/v1/user", { password }, token);
    const text = errorText(payload);
    if (code === 429) throw new HttpError(429, "Too many tries. Wait a minute, then try again.");
    if (code >= 400 && !text.includes("same_password")) {
      if (text.includes("weak") || text.includes("password")) throw new HttpError(400, (payload && (payload.msg || payload.message)) || "Choose a stronger password.");
      throw new HttpError(502, "The password could not be saved. Try again.");
    }
    const now = session();
    if (now) {
      const done = { ...now, password_pending: false };
      await write([["kv", done]]);
      rememberPending(done);
    }
    await enterAccount();
    return fullStatus();
  });

  route("POST", /^\/api\/cloud\/cancel$/, async () => {
    if (status().password_pending) await signOutOfService();
    return status();
  });

  route("POST", /^\/api\/cloud\/sign-out$/, async ({ body }) => {
    if (status().signed_in) await runOnce();
    if (status().signed_in && !body.force) {
      const pending = pendingChanges();
      if (pending) {
        const noun = pending === 1 ? "change has" : "changes have";
        throw new HttpError(409, `${pending} ${noun} not reached your account yet (no connection?). Signing out now removes them from this phone for good.`, { pending });
      }
    }
    await signOutOfService();
    await clearAccountData();
    await write([["kv", { k: "sync_state" }]]);
    return status();
  });

  /* ------------------------------------------------------------------ */
  /* sign in with Google / Microsoft (cloud.py's oauth_*, PKCE flow)     */
  /* ------------------------------------------------------------------ */
  // The phone leaves for Google / Microsoft and comes back with a one-time
  // code, which only this phone can exchange (only it knows the verifier).
  //   Android app:     back through its own link, com.muhurata.timer://auth-callback
  //                    (the intent filter in AndroidManifest.xml, @capacitor/app).
  //   iPhone web app:  back to its own sign-in page on the website.
  // Supabase -> URL Configuration must allow both.
  const PROVIDERS = { google: "Google", azure: "Microsoft" };
  const OAUTH_KEY = "muhurta-oauth";
  const OAUTH_TIMEOUT_MS = 10 * 60 * 1000;
  const ANDROID_RETURN = "com.muhurata.timer://auth-callback";
  const WEB_APP = D.platform === "ios";

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  function returnAddress() {
    return WEB_APP ? location.origin + SIGN_IN : ANDROID_RETURN;
  }

  route("GET", /^\/api\/cloud\/providers$/, async () => {
    try {
      const [code, payload] = await request("GET", "/auth/v1/settings");
      const external = code === 200 && payload && payload.external;
      if (!external) return { providers: [] };
      return { providers: Object.entries(PROVIDERS).filter(([id]) => external[id]).map(([id, name]) => ({ id, name })) };
    } catch (_) {
      return { providers: [] }; // offline: email only
    }
  });

  route("POST", /^\/api\/cloud\/oauth\/start$/, async ({ body }) => {
    const provider = String(body.provider || "");
    if (!PROVIDERS[provider]) throw new HttpError(400, "That sign-in option isn't available.");
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    try {
      localStorage.setItem(OAUTH_KEY, JSON.stringify({ verifier, provider, at: Date.now() }));
    } catch (_) {}
    const query = new URLSearchParams({ provider, redirect_to: returnAddress(), code_challenge: challenge,
      code_challenge_method: "s256" });
    if (provider === "azure") query.set("scopes", "email"); // Microsoft leaves the email out otherwise
    // Not opened here: the page goes there itself (the Android app hands it to the browser).
    return { url: `${URL_BASE}/auth/v1/authorize?${query}`, opened: false };
  });

  // The way back: exchange the code, then reload the sign-in page, which
  // sends you into the app or to "Finish your profile".
  async function finishOAuth(params) {
    let pending = null;
    try {
      pending = JSON.parse(localStorage.getItem(OAUTH_KEY) || "null");
      localStorage.removeItem(OAUTH_KEY); // a code works once
    } catch (_) {}
    let message = "";
    if (params.get("error")) {
      message = params.get("error_description") || "The sign-in was cancelled.";
    } else if (!pending || Date.now() - pending.at > OAUTH_TIMEOUT_MS) {
      message = "This sign-in has expired. Try again.";
    } else {
      try {
        const [code, payload] = await request("POST", "/auth/v1/token?grant_type=pkce",
          { auth_code: params.get("code") || "", code_verifier: pending.verifier });
        if (code >= 400 || !payload || !payload.access_token) message = "The sign-in couldn't be completed. Try again.";
        else {
          await saveSession(payload, false, null, true);
          await enterAccount();
        }
      } catch (_) {
        message = "No internet connection right now. Try again when you are online.";
      }
    }
    location.replace(SIGN_IN + (message ? `?oauth_error=${encodeURIComponent(message.slice(0, 200))}` : ""));
  }

  function oauthReturn(url) {
    try {
      const u = new URL(url);
      const params = new URLSearchParams(u.search || u.hash.replace(/^#/, ""));
      if (params.get("code") || params.get("error")) L.ready.then(() => finishOAuth(params));
    } catch (_) {}
  }

  // Android: the app is woken (or started) by its own link.
  const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!WEB_APP && AppPlugin) {
    AppPlugin.addListener("appUrlOpen", (e) => {
      if (String(e.url || "").startsWith(ANDROID_RETURN)) oauthReturn(e.url);
    });
    AppPlugin.getLaunchUrl().then((r) => {
      if (r && String(r.url || "").startsWith(ANDROID_RETURN)) oauthReturn(r.url);
    }).catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* pages: signed out goes to sign-in; background sync while open       */
  /* ------------------------------------------------------------------ */

  // The app's own folder: "/" in the Android app, /muhurta-pomodoro/app/ on the website.
  const HOME = D.base || "/";
  const SIGN_IN = HOME + "sign-in.html";
  const onSignIn = location.pathname === SIGN_IN;

  // The quick answer first; the stored session below has the final say.
  let quickSignedIn = false;
  try {
    quickSignedIn = localStorage.getItem(AUTH_KEY) === "1";
  } catch (_) {}
  let needsProfile = null;
  try {
    needsProfile = JSON.parse(localStorage.getItem(NEEDS_PROFILE_KEY) || "null");
  } catch (_) {}
  // iPhone web app: back from Google / Microsoft on this very page.
  const backFromProvider = onSignIn && WEB_APP && /[?&](code|error)=/.test(location.search);
  if (CONFIGURED && !quickSignedIn && !onSignIn) location.replace(SIGN_IN);
  if (CONFIGURED && quickSignedIn && onSignIn && !needsProfile && !backFromProvider) location.replace(HOME);
  if (backFromProvider) oauthReturn(location.href);

  if (onSignIn && needsProfile && !backFromProvider) {
    // Filled in as the page's #signin appears, so sign-in.js asks for a name.
    const mo = new MutationObserver(() => {
      const el = document.getElementById("signin");
      if (!el) return;
      mo.disconnect();
      el.dataset.needsProfile = "1";
      el.dataset.signedInEmail = needsProfile.email;
      el.dataset.suggestedName = needsProfile.name;
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (onSignIn) {
    let pending = null;
    try {
      pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
    } catch (_) {}
    if (pending) {
      // Filled in as the page's #signin appears, before sign-in.js reads it.
      const mo = new MutationObserver(() => {
        const el = document.getElementById("signin");
        if (!el) return;
        mo.disconnect();
        el.dataset.pendingEmail = pending.email;
        el.dataset.pendingProfile = pending.profile ? "1" : "";
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  L.ready.then(() => {
    const st = status();
    rememberPending(session());
    if (CONFIGURED && !st.signed_in && !onSignIn) {
      location.replace(SIGN_IN);
      return;
    }
    if (onSignIn && (!CONFIGURED || st.signed_in) && !needsProfile && !backFromProvider) {
      location.replace(HOME);
      return;
    }
    if (st.signed_in) {
      setTimeout(runOnce, 3000);
      setInterval(runOnce, INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") runOnce();
      });
    }
  });

  /* ------------------------------------------------------------------ */
  /* feedback: Settings -> Feedback (cloud.py send_feedback, my_feedback) */
  /* ------------------------------------------------------------------ */

  const FEEDBACK_KINDS = ["like", "dislike", "improve", "idea"];
  const FEEDBACK_MAX = 2000;
  const FEEDBACK_COLS = "id,kind,message,status,created_at";

  async function feedbackCall(method, path, body, prefer) {
    const token = await accessToken();
    if (!token) throw new HttpError(401, "Please sign in first.");
    const [code, payload] = await request(method, path, body, token, prefer ? { Prefer: prefer } : undefined);
    if (code === 404 || errorText(payload).includes("42p01")) {
      throw new HttpError(404, "Feedback isn't set up on the server yet (run the feedback section of supabase/schema.sql).");
    }
    if (code >= 400) throw new HttpError(502, "The server couldn't take that just now. Try again.");
    return payload;
  }

  route("GET", /^\/api\/feedback$/, async () => {
    const rows = await feedbackCall("GET", `/rest/v1/feedback?select=${FEEDBACK_COLS}&order=created_at.desc&limit=20`);
    return { items: Array.isArray(rows) ? rows : [] };
  });

  route("POST", /^\/api\/feedback$/, async ({ body }) => {
    const kind = String(body.kind || "").trim().toLowerCase();
    const message = String(body.message || "").trim();
    if (!FEEDBACK_KINDS.includes(kind)) throw new HttpError(400, "Choose what kind of feedback this is.");
    if (!message) throw new HttpError(400, "Write a few words first.");
    if (message.length > FEEDBACK_MAX) throw new HttpError(400, `Keep it under ${FEEDBACK_MAX} characters.`);
    const rows = await feedbackCall("POST", `/rest/v1/feedback?select=${FEEDBACK_COLS}`,
      { kind, message, app_version: String(D.version || "").slice(0, 20), platform: "android" }, "return=representation");
    return [201, Array.isArray(rows) && rows[0] ? rows[0] : {}];
  });

  window.__MUHURTA_ACCOUNT__ = { signedIn: () => !CONFIGURED || status().signed_in, nudge, runOnce, status: fullStatus };
  L.cloudConfigured = CONFIGURED;
})();
