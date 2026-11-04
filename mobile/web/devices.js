// Refresh one device, sync them all: the phone apps' side of devices.py.
//
// While the app is on screen and signed in, it keeps a live connection to
// the account's own channel (Supabase Realtime, private: see the "devices"
// section of supabase/schema.sql) and marks this phone open in app_devices.
// When another device is refreshed it says "sync": this phone answers
// "heard", syncs, and answers "synced". When this phone is refreshed it asks
// the others the same and reports which open devices did not answer (not
// connected to the internet).
//
// Going to the background counts as closing the app: the phone marks itself
// closed and leaves the channel, so other devices do not wait for it. It
// syncs by itself when it comes back (account.js).
(function () {
  "use strict";

  const D = window.__MUHURTA__;
  const L = window.__MUHURTA_LOCAL__;
  const A = window.__MUHURTA_ACCOUNT__;
  if (!L || !A || !A.configured || typeof WebSocket !== "function") return;
  const { route, nowIso } = L.internals;

  const TOPIC = "muhurta-devices:";
  const EVENT = "muhurta";
  const HEARTBEAT_MS = 25000;
  const RECENT_MS = 24 * 60 * 60 * 1000;
  const OPEN_EVERY_MS = 60 * 60 * 1000;
  const JOIN_WAIT_MS = 3000;
  const HEAR_WAIT_MS = 4000;
  const SYNC_WAIT_MS = 12000;
  const DENIED_RETRY_MS = 10 * 60 * 1000;
  const NAMES = { darwin: "your Mac", win32: "your Windows PC", ios: "your iPhone", android: "your Android phone" };
  const nameFor = (platform) => NAMES[String(platform || "")] || "your other device";
  const PLATFORM = D.platform || "android";
  const me = () => ({ device: L.deviceId(), name: nameFor(PLATFORM) });

  let ws = null;
  let topic = null;
  let joinRef = null;
  let ref = 0;
  let joined = false;
  let joinWaiters = [];
  let beat = null;
  let openTimer = null;
  let lastHeard = 0;
  let retry = null;
  let backoff = 2000;
  let deniedUntil = 0;
  const requests = new Map(); // refresh id -> {heard: Map, synced: Map, wake}
  const remote = { seq: 0, from: null, done: true, ok: true };

  const nextRef = () => String(++ref);
  const visible = () => !document.visibilityState || document.visibilityState === "visible";

  function send(event, payload, to) {
    if (!ws || ws.readyState !== 1) throw new Error("not connected");
    ws.send(JSON.stringify({ topic: to || topic, event, payload, ref: nextRef(), join_ref: to ? null : joinRef }));
  }
  const broadcast = (data) => send("broadcast", { type: "broadcast", event: EVENT, payload: data });

  function setJoined(on) {
    joined = on;
    const waiting = joinWaiters;
    joinWaiters = [];
    for (const w of waiting) w(on);
  }

  async function mark(open) {
    const uid = A.userId();
    let token;
    try {
      token = await A.accessToken();
    } catch (_) {
      return;
    }
    if (!uid || !token) return;
    const at = nowIso();
    try {
      if (open) {
        await A.request("POST", "/rest/v1/app_devices?on_conflict=user_id,device_id",
          { user_id: uid, device_id: L.deviceId(), app_version: D.version, platform: PLATFORM, last_seen: at, app_open: true },
          token, { Prefer: "resolution=merge-duplicates,return=minimal" });
      } else {
        // Only if nothing newer was written: moving between pages closes one
        // page and opens the next, and the next one's "open" must win.
        const path = `/rest/v1/app_devices?device_id=eq.${L.deviceId()}&last_seen=lt.${encodeURIComponent(at)}`;
        const body = { app_open: false, last_seen: at };
        const http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
        if (http) {
          await A.request("PATCH", path, body, token, { Prefer: "return=minimal" });
        } else {
          // keepalive: the page may be going away as this is sent
          await fetch(`${A.url}${path}`, {
            method: "PATCH", keepalive: true, body: JSON.stringify(body),
            headers: { apikey: A.key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          }).catch(() => {});
        }
      }
    } catch (_) {}
  }

  function stop() {
    clearInterval(beat);
    clearInterval(openTimer);
    clearTimeout(retry);
    beat = openTimer = retry = null;
    const old = ws;
    ws = null;
    if (old) {
      old.onclose = old.onmessage = old.onerror = null;
      try {
        old.close();
      } catch (_) {}
    }
    setJoined(false);
  }

  function later() {
    clearTimeout(retry);
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60000);
  }

  async function connect() {
    if (ws || !visible() || Date.now() < deniedUntil) return;
    const uid = A.userId();
    if (!uid) return;
    let token;
    try {
      token = await A.accessToken();
    } catch (_) {
      later();
      return;
    }
    if (!token || ws || !visible()) return;
    const url = `${A.url.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(A.key)}&vsn=1.0.0`;
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (_) {
      later();
      return;
    }
    ws = sock;
    topic = `realtime:${TOPIC}${uid}`;
    joinRef = nextRef();
    sock.onopen = () => {
      sock.send(JSON.stringify({
        topic, event: "phx_join", ref: joinRef, join_ref: joinRef,
        payload: { config: { broadcast: { self: false, ack: false }, presence: { key: "" }, postgres_changes: [], private: true }, access_token: token },
      }));
      lastHeard = Date.now();
      beat = setInterval(() => {
        if (Date.now() - lastHeard > HEARTBEAT_MS * 3) {
          stop();
          later();
          return;
        }
        try {
          send("heartbeat", {}, "phoenix");
        } catch (_) {}
      }, HEARTBEAT_MS);
    };
    sock.onmessage = (ev) => {
      lastHeard = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.event === "phx_reply" && msg.ref === joinRef) {
        if (msg.payload && msg.payload.status === "ok") {
          backoff = 2000;
          setJoined(true);
          mark(true);
          openTimer = setInterval(async () => {
            try {
              const fresh = await A.accessToken();
              if (fresh && fresh !== token) {
                token = fresh;
                send("access_token", { access_token: token });
              }
            } catch (_) {}
            mark(true);
          }, OPEN_EVERY_MS);
        } else {
          deniedUntil = Date.now() + DENIED_RETRY_MS; // not set up on the server yet
          stop();
        }
        return;
      }
      if ((msg.event === "phx_error" || msg.event === "phx_close") && msg.topic === topic) {
        stop();
        later();
        return;
      }
      if (msg.event === "broadcast") handle(msg.payload || {});
    };
    sock.onclose = sock.onerror = () => {
      if (ws !== sock) return;
      stop();
      later();
    };
  }

  function handle(payload) {
    if (payload.event !== EVENT) return;
    const data = payload.payload || {};
    const mine = L.deviceId();
    if (data.kind === "sync" && data.device !== mine) {
      const id = String(data.id || "");
      try {
        broadcast({ kind: "heard", id, to: data.device, ...me() });
      } catch (_) {}
      answer(id, data);
    } else if ((data.kind === "heard" || data.kind === "synced") && data.to === mine) {
      const req = requests.get(String(data.id || ""));
      if (req) {
        req[data.kind].set(String(data.device || ""), String(data.name || nameFor("")));
        req.wake();
      }
    }
  }

  // Another device was refreshed: sync here too, then say so.
  async function answer(id, data) {
    remote.seq = Date.now();
    remote.from = String(data.name || nameFor(""));
    remote.done = false;
    remote.ok = true;
    const st = await A.runOnce();
    remote.ok = !st.error;
    remote.done = true;
    try {
      broadcast({ kind: "synced", id, to: data.device, ok: remote.ok, ...me() });
    } catch (_) {}
  }

  async function openDevices(token) {
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    const q = `select=device_id,platform&app_open=is.true&last_seen=gte.${encodeURIComponent(since)}&device_id=neq.${L.deviceId()}`;
    try {
      const [code, rows] = await A.request("GET", `/rest/v1/app_devices?${q}`, null, token);
      if (code >= 400 || !Array.isArray(rows)) return new Map();
      return new Map(rows.filter((r) => r.device_id).map((r) => [String(r.device_id), nameFor(r.platform)]));
    } catch (_) {
      return new Map();
    }
  }

  function waitJoined(ms) {
    if (joined) return Promise.resolve(true);
    connect();
    return new Promise((done) => {
      const t = setTimeout(() => {
        joinWaiters = joinWaiters.filter((w) => w !== finish);
        done(joined);
      }, ms);
      const finish = (on) => {
        clearTimeout(t);
        done(on);
      };
      joinWaiters.push(finish);
    });
  }

  // Ask every other open device to sync; call after syncing this phone.
  async function syncEverywhere() {
    const out = { asked: 0, synced: [], missing: [], slow: [], unreachable: false };
    let token = null;
    try {
      token = await A.accessToken();
    } catch (_) {}
    if (!token || !A.userId()) return out;
    const expected = await openDevices(token);
    if (!(await waitJoined(JOIN_WAIT_MS))) {
      out.unreachable = expected.size > 0 && Date.now() >= deniedUntil;
      return out;
    }
    const id = crypto.randomUUID().replace(/-/g, "");
    const req = { heard: new Map(), synced: new Map(), wake: () => {} };
    requests.set(id, req);
    const until = (test, ms) => new Promise((done) => {
      if (test()) return done();
      const t = setTimeout(() => done(), ms);
      req.wake = () => {
        if (test()) {
          clearTimeout(t);
          done();
        }
      };
    });
    try {
      broadcast({ kind: "sync", id, ...me() });
      const start = Date.now();
      await until(() => [...expected.keys()].every((d) => req.heard.has(d)), expected.size ? HEAR_WAIT_MS : 1500);
      await until(() => [...req.heard.keys()].every((d) => req.synced.has(d)), Math.max(0, SYNC_WAIT_MS - (Date.now() - start)));
    } catch (_) {
      out.unreachable = expected.size > 0;
      return out;
    } finally {
      requests.delete(id);
    }
    out.asked = new Set([...expected.keys(), ...req.heard.keys()]).size;
    out.synced = [...req.synced.values()].sort();
    out.missing = [...expected].filter(([d]) => !req.heard.has(d)).map(([, n]) => n).sort();
    out.slow = [...req.heard].filter(([d]) => !req.synced.has(d)).map(([, n]) => n).sort();
    return out;
  }

  // Signing out: not open here any more; joins again after the next sign-in.
  async function leaving() {
    await mark(false);
    stop();
  }

  route("GET", /^\/api\/cloud\/remote-sync$/, () => ({ ...remote }));

  document.addEventListener("visibilitychange", () => {
    if (visible()) {
      backoff = 2000;
      connect();
    } else {
      // In the background the phone stops answering: count as closed.
      mark(false);
      stop();
    }
  });
  window.addEventListener("pagehide", () => {
    if (ws) mark(false);
  });
  window.addEventListener("online", () => {
    backoff = 2000;
    if (!ws) connect();
  });

  window.__MUHURTA_DEVICES__ = { syncEverywhere, leaving, remote: () => ({ ...remote }), connected: () => joined };
  L.ready.then(() => setTimeout(connect, 500));
})();
