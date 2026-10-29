// The phone apps' own code (mobile/web: local-api.js, account.js, backup.js),
// end to end, the way tests/test_sign_in.py checks the computer's: the real
// scripts run in Node with a stand-in for the phone's storage (IndexedDB) and
// for Supabase. Nothing leaves this computer.
//
//     node --test tests/phone/
//
// Builds mobile/www first (python mobile/build_web.py) for the data the
// scripts need; set PYTHON to choose the Python.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.PYTHON || (existsSync(join(ROOT, ".venv/bin/python")) ? join(ROOT, ".venv/bin/python") : "python3");
const built = spawnSync(PYTHON, [join(ROOT, "mobile/build_web.py")], { cwd: ROOT, encoding: "utf8" });
assert.equal(built.status, 0, `mobile/build_web.py failed:\n${built.stdout}\n${built.stderr}`);

/* ---------------------------------------------------------------------- */
/* the stand-in Supabase (the same rules as the one in test_sign_in.py)    */
/* ---------------------------------------------------------------------- */
const APP_CODE = "654321"; // what the authenticator app shows
const server = {
  users: new Map(), // email -> {id, password, meta, factors: []}
  rows: new Map(), // table -> Map(key -> row)
  errorReports: [],
  stamp: Date.parse("2026-01-01T00:00:00Z"),
};
const KEYS = { activity_segments: ["uuid"], custom_presets: ["uuid"], app_settings: [], focus_by_device: ["day", "device_id"], app_devices: ["device_id"] };
const b64 = (s) => Buffer.from(s).toString("base64url");
const claims = (token) => {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString());
  } catch (_) {
    return {};
  }
};
const userById = (id) => [...server.users.values()].find((u) => u.id === id);
const emailOf = (id) => [...server.users.entries()].find(([, u]) => u.id === id)?.[0];
const twoStepBlocks = (token) => {
  const u = userById(claims(token).sub);
  return Boolean(u && u.factors.some((f) => f.status === "verified") && claims(token).aal !== "aal2");
};
function sessionFor(user, aal = "aal1") {
  return [200, {
    access_token: `h.${b64(JSON.stringify({ sub: user.id, aal }))}.s`, refresh_token: `ref:${user.id}:${aal}`, expires_in: 3600,
    user: { id: user.id, email: emailOf(user.id), user_metadata: { ...user.meta }, factors: user.factors.map((f) => ({ ...f })) },
  }];
}

function supabase(method, url, body, token) {
  const u = new URL(url);
  const p = u.pathname;
  const q = u.searchParams;
  const me = userById(claims(token).sub);
  if (p === "/auth/v1/otp") return [200, {}];
  if (p === "/auth/v1/verify") {
    if (body.token !== "123456") return [400, { msg: "bad code" }];
    if (!server.users.has(body.email)) server.users.set(body.email, { id: crypto.randomUUID(), password: null, meta: {}, factors: [] });
    return sessionFor(server.users.get(body.email));
  }
  if (p === "/auth/v1/token" && q.get("grant_type") === "password") {
    const user = server.users.get(body.email);
    return user && user.password === body.password ? sessionFor(user) : [400, { error_code: "invalid_credentials" }];
  }
  if (p === "/auth/v1/token" && q.get("grant_type") === "refresh_token") {
    const [, id, aal] = body.refresh_token.split(":");
    const user = userById(id);
    return user ? sessionFor(user, aal) : [400, { error_code: "refresh_token_not_found" }];
  }
  if (p === "/auth/v1/user" && method === "GET") return [200, { id: me.id, factors: me.factors.map((f) => ({ ...f })) }];
  if (p === "/auth/v1/user" && method === "PUT") {
    if (body.data) Object.assign(me.meta, body.data);
    if (body.password) me.password = body.password;
    return [200, {}];
  }
  if (p === "/auth/v1/logout") return [204, null];
  if (p === "/auth/v1/factors" && method === "POST") {
    const factor = { id: crypto.randomUUID(), factor_type: "totp", status: "unverified" };
    me.factors.push(factor);
    return [200, { id: factor.id, type: "totp", totp: { qr_code: "data:image/svg+xml;utf-8,<svg/>", secret: "JBSWY3DP", uri: "otpauth://totp/x" } }];
  }
  if (p.startsWith("/auth/v1/factors/")) {
    const [fid, action] = p.slice("/auth/v1/factors/".length).split("/");
    const factor = me.factors.find((f) => f.id === fid);
    if (!factor) return [404, { error_code: "mfa_factor_not_found" }];
    if (method === "DELETE") {
      if (factor.status === "verified" && claims(token).aal !== "aal2") return [403, { error_code: "insufficient_aal" }];
      me.factors.splice(me.factors.indexOf(factor), 1);
      return [200, { id: fid }];
    }
    if (action === "challenge") return [200, { id: `challenge-${fid}` }];
    if (body.challenge_id !== `challenge-${fid}` || body.code !== APP_CODE) return [422, { error_code: "mfa_verification_failed" }];
    factor.status = "verified";
    return sessionFor(me, "aal2");
  }
  if (p === "/rest/v1/rpc/username_available") return [200, true];
  if (p === "/rest/v1/rpc/is_admin") return [200, false];
  if (p === "/rest/v1/rpc/delete_my_account") {
    if (twoStepBlocks(token)) return [400, { message: "two-step sign-in needed" }];
    server.users.delete(emailOf(me.id));
    for (const store of server.rows.values()) for (const [k, r] of store) if (r.user_id === me.id) store.delete(k);
    return [204, null];
  }
  if (p.startsWith("/rest/v1/rpc/")) return [404, { code: "PGRST202" }];
  if (p === "/rest/v1/profiles") return [201, null];
  if (p === "/rest/v1/error_reports") {
    if (token) return [400, { message: "error notes are sent without the sign-in" }];
    server.errorReports.push(...body);
    return [201, null];
  }
  const table = p.split("/").pop();
  if (!(table in KEYS)) return [404, { code: "PGRST205" }];
  if (twoStepBlocks(token)) return [403, { code: "42501" }];
  const store = server.rows.get(table) || server.rows.set(table, new Map()).get(table);
  const key = (r) => [me.id, ...KEYS[table].map((k) => r[k])].join("|");
  if (method === "GET") {
    const since = q.get("server_updated_at");
    let rows = [...store.values()].filter((r) => r.user_id === me.id);
    if (since) rows = rows.filter((r) => Date.parse(r.server_updated_at) > Date.parse(since.slice(3)));
    rows.sort((a, b) => a.server_updated_at.localeCompare(b.server_updated_at));
    const off = Number(q.get("offset") || 0);
    return [200, rows.slice(off, off + Number(q.get("limit") || 1000)).map((r) => ({ ...r }))];
  }
  if (method === "POST") {
    for (const r of Array.isArray(body) ? body : [body]) {
      const old = store.get(key(r));
      if (old && r.updated_at && r.updated_at <= old.updated_at) continue; // newest wins
      store.set(key(r), { ...old, ...r, user_id: me.id, server_updated_at: new Date(++server.stamp).toISOString() });
    }
    return [201, null];
  }
  if (method === "PATCH") {
    const ids = (q.get("uuid") || "in.()").slice(4, -1).split(",");
    for (const r of store.values()) {
      if (r.user_id === me.id && ids.includes(r.uuid) && body.updated_at > r.updated_at) {
        Object.assign(r, body, { server_updated_at: new Date(++server.stamp).toISOString() });
      }
    }
    return [204, null];
  }
  return [405, null];
}

/* ---------------------------------------------------------------------- */
/* a phone: the scripts, in a window of their own                          */
/* ---------------------------------------------------------------------- */
function fakeIndexedDB() {
  const dbs = new Map();
  const later = (f) => setTimeout(f, 0);
  return {
    open(name) {
      const req = {};
      later(() => {
        const isNew = !dbs.has(name);
        if (isNew) dbs.set(name, new Map());
        const stores = dbs.get(name);
        req.result = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n, { keyPath }) => stores.set(n, { keyPath, map: new Map() }),
          transaction() {
            const tx = {
              objectStore(n) {
                const st = stores.get(n);
                return {
                  getAll() {
                    const r = {};
                    later(() => {
                      r.result = [...st.map.values()].map((v) => structuredClone(v));
                      r.onsuccess?.();
                    });
                    return r;
                  },
                  put: (rec) => st.map.set(rec[st.keyPath], structuredClone(rec)),
                  delete: (k) => st.map.delete(k),
                };
              },
            };
            later(() => tx.oncomplete?.());
            return tx;
          },
        };
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

async function phone() {
  const storage = new Map();
  const ctx = {
    console, URL, Response, Request, Headers, File, Blob, AbortController, TextEncoder, TextDecoder, crypto,
    atob, btoa, structuredClone, Promise, JSON, Math, Date,
    setTimeout: (f, ms) => setTimeout(f, ms).unref(),
    clearTimeout, setInterval: (f, ms) => setInterval(f, ms).unref(), clearInterval,
    indexedDB: fakeIndexedDB(),
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    location: { href: "http://localhost/sign-in.html", origin: "http://localhost", pathname: "/sign-in.html", search: "", replace() {} },
    navigator: {},
    document: { body: { dataset: {} }, documentElement: {}, getElementById: () => null, addEventListener() {}, visibilityState: "visible" },
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    addEventListener() {},
    dispatchEvent() {},
    fetch: () => Promise.reject(new Error("the phone code went to the real network")),
  };
  ctx.window = ctx;
  ctx.Capacitor = { Plugins: { CapacitorHttp: {
    async request({ method, url, data, headers }) {
      const token = (headers.Authorization || "").replace(/^Bearer /, "") || null;
      const [status, payload] = supabase(method, url, data, token);
      return { status, data: payload == null ? "" : JSON.stringify(payload) };
    },
  } } };
  vm.createContext(ctx);
  for (const name of ["mobile-data.js", "local-api.js", "account.js", "backup.js"]) {
    vm.runInContext(readFileSync(join(ROOT, "mobile/www", name), "utf8"), ctx, { filename: name });
  }
  await ctx.__MUHURTA_LOCAL__.ready;
  const call = async (method, path, body) => {
    const res = await ctx.fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {}
    return { status: res.status, data, headers: res.headers };
  };
  return { ctx, call, stores: ctx.__MUHURTA_LOCAL__.stores };
}

const GOOD = "Correct-horse9";
async function createAccount(p, email) {
  const profile = { first_name: "Asha", last_name: "Rao", username: `u_${email.split("@")[0]}` };
  assert.equal((await p.call("POST", "/api/cloud/send-code", { email, purpose: "new", ...profile })).status, 200);
  assert.equal((await p.call("POST", "/api/cloud/verify", { email, code: "123456" })).status, 200);
  const r = await p.call("POST", "/api/cloud/set-password", { password: GOOD, ...profile });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.signed_in);
}
const serverPresets = (email) => [...(server.rows.get("custom_presets") || new Map()).values()]
  .filter((r) => r.user_id === server.users.get(email)?.id && !r.deleted_at).map((r) => r.name);

/* ---------------------------------------------------------------------- */
/* the checks                                                              */
/* ---------------------------------------------------------------------- */
test("an account: sign up, a rhythm syncs up", async () => {
  const p = await phone();
  await createAccount(p, "asha@x.com");
  const r = await p.call("POST", "/api/presets", { name: "Phone rhythm", work_min: 25, short_rest_min: 5, long_rest_min: 15 });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  await p.call("POST", "/api/cloud/sync-now");
  assert.deepEqual(serverPresets("asha@x.com"), ["Phone rhythm"]);
});

test("backup: a file in the server's shape, a CSV, and restores that add only what's missing", async () => {
  const p = await phone();
  assert.equal((await p.call("POST", "/api/cloud/sign-in", { email: "asha@x.com", password: GOOD })).status, 200);
  const r = await p.call("GET", "/api/backup");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Disposition"), /attachment; filename="muhurta-backup-/);
  assert.deepEqual(r.data.custom_presets.map((x) => x.name), ["Phone rhythm"]);
  assert.equal(r.data.app, "muhurta-pomodoro");
  const csv = await p.call("GET", "/api/backup/sessions.csv");
  assert.match(csv.data, /^Date,Kind,Started,Ended,Minutes/);
  assert.equal((await p.call("POST", "/api/backup/restore", { app: "other" })).status, 400);
  assert.equal((await p.call("POST", "/api/backup/restore", { ...r.data, format: 99 })).status, 400);
  assert.equal((await p.call("POST", "/api/backup/restore", r.data)).data.combinations, 0);

  // A backup made on a computer (backup.py) restores here: same shape.
  const fromComputer = {
    app: "muhurta-pomodoro", kind: "backup", format: 1,
    activity_segments: [{
      uuid: "11111111-2222-4333-8444-555555555555", updated_at: "2026-02-01T10:00:00.000Z", day: "2026-02-01",
      kind: "work", started_at: "2026-02-01T09:00:00Z", ended_at: "2026-02-01T09:25:00Z", duration_sec: 1500,
      productive_sec: 1500, rest_sec: 0, preset_id: "ghadi", preset_name: "Ghadi", phase_index: 0,
      details_json: "{}", created_at: "2026-02-01 09:25:00", device_id: "mac-1",
    }],
    custom_presets: [], focus_by_device: [{ day: "2026-02-01", device_id: "mac-1", minutes: 25, updated_at: "2026-02-01T10:00:00.000Z" }],
    settings: {},
  };
  const back = await p.call("POST", "/api/backup/restore", fromComputer);
  assert.deepEqual(back.data, { sessions: 1, combinations: 0, days: 1, settings: false });
  const csv2 = await p.call("GET", "/api/backup/sessions.csv");
  assert.match(csv2.data, /2026-02-01,Focus,.*,25\.0,25\.0,0\.0,Ghadi/);
  await p.call("POST", "/api/cloud/sync-now");
  const up = [...server.rows.get("activity_segments").values()].find((x) => x.uuid === fromComputer.activity_segments[0].uuid);
  assert.ok(up, "the restored session reached the account");
  await p.call("POST", "/api/cloud/sign-out", { force: true });
});

test("error reports: kept, counted, sent without the sign-in", async () => {
  const p = await phone();
  await p.call("POST", "/api/cloud/sign-in", { email: "asha@x.com", password: GOOD });
  const body = { message: "TypeError: x is undefined", detail: "at timer.js:1", page: "/timer.html" };
  assert.equal((await p.call("POST", "/api/error-report", body)).status, 204);
  await p.call("POST", "/api/error-report", body);
  await p.call("POST", "/api/cloud/sync-now");
  assert.equal(server.errorReports.length, 1);
  assert.equal(server.errorReports[0].times, 2);
  assert.equal(server.errorReports[0].platform, "android");
  assert.ok(!("user_id" in server.errorReports[0]));
  await p.call("POST", "/api/cloud/sync-now");
  assert.equal(server.errorReports.length, 1, "not sent twice");
  await p.call("POST", "/api/cloud/sign-out", { force: true });
});

test("two-step sign-in: on, asked for at sign-in, off", async () => {
  const p = await phone();
  await p.call("POST", "/api/cloud/sign-in", { email: "asha@x.com", password: GOOD });
  assert.deepEqual((await p.call("GET", "/api/cloud/two-step")).data, { enabled: false });
  const started = (await p.call("POST", "/api/cloud/two-step/start")).data;
  assert.match(started.qr_code, /^data:image\/svg/);
  assert.equal((await p.call("POST", "/api/cloud/two-step/confirm", { factor_id: started.factor_id, code: "111111" })).status, 400);
  assert.equal((await p.call("POST", "/api/cloud/two-step/confirm", { factor_id: started.factor_id, code: APP_CODE })).status, 200);
  assert.deepEqual((await p.call("GET", "/api/cloud/two-step")).data, { enabled: true });
  await p.call("POST", "/api/cloud/sign-out", { force: true });
  assert.equal(p.stores.presets.size, 0);

  const st = (await p.call("POST", "/api/cloud/sign-in", { email: "asha@x.com", password: GOOD })).data;
  assert.ok(st.mfa_pending && !st.signed_in, "a password alone asks for the code");
  assert.equal(p.stores.presets.size, 0, "nothing downloaded before the code");
  assert.equal((await p.call("GET", "/api/presets")).status, 401, "the app stays closed");
  assert.equal((await p.call("POST", "/api/cloud/mfa-verify", { code: "000000" })).status, 400);
  const ok = (await p.call("POST", "/api/cloud/mfa-verify", { code: APP_CODE })).data;
  assert.ok(ok.signed_in);
  assert.equal(p.stores.presets.size, 1, "in, with the data");

  assert.equal((await p.call("POST", "/api/cloud/two-step/off", { code: "12" })).status, 400);
  assert.deepEqual((await p.call("POST", "/api/cloud/two-step/off", { code: APP_CODE })).data, { enabled: false });
  await p.call("POST", "/api/cloud/sign-out", { force: true });
  assert.ok((await p.call("POST", "/api/cloud/sign-in", { email: "asha@x.com", password: GOOD })).data.signed_in);
  await p.call("POST", "/api/cloud/sign-out", { force: true });
});

test("deleting the account, then restoring its backup into a new one", async () => {
  const p = await phone();
  await p.call("POST", "/api/cloud/sign-in", { email: "asha@x.com", password: GOOD });
  const saved = (await p.call("GET", "/api/backup")).data;
  assert.equal((await p.call("POST", "/api/cloud/delete-account", { confirm: "someone@else.com" })).status, 400);
  assert.ok(server.users.has("asha@x.com"), "the wrong email deletes nothing");
  const r = await p.call("POST", "/api/cloud/delete-account", { confirm: " ASHA@x.com " });
  assert.equal(r.status, 200);
  assert.equal(r.data.signed_in, false);
  assert.ok(!server.users.has("asha@x.com"), "gone from the server");
  assert.equal(p.stores.presets.size, 0, "gone from the phone");
  assert.equal((await p.call("POST", "/api/cloud/sign-in", { email: "asha@x.com", password: GOOD })).status, 401);

  await createAccount(p, "asha@x.com");
  const back = (await p.call("POST", "/api/backup/restore", saved)).data;
  assert.equal(back.combinations, 1);
  await p.call("POST", "/api/cloud/sync-now");
  assert.deepEqual(serverPresets("asha@x.com"), ["Phone rhythm"]);
});
