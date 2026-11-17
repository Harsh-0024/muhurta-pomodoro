// The simple Timer's own timekeeping (static/js/timer-core.js), run in Node
// with a stand-in for the page: a fake clock, localStorage and OneClock.
//
//     node --test tests/clocks.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "static/js/timer-core.js"), "utf8");
const KEY = "muhurat_countdown_session_v1";

// A page with nothing on it: the Timer's saved session, a clock we can move,
// and a list of the focus it logged.
function page(settings = {}) {
  const store = new Map();
  const logged = [];
  let now = Date.parse("2026-11-17T10:00:00Z");
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const window = {
    __PAGE__: "timer",
    addEventListener() {},
    dispatchEvent() {},
    setInterval() {},
    OneClock: { logSegment: (body, startedAt, endedAt) => logged.push({ ...body, sec: Math.round((endedAt - startedAt) / 1000) }) },
  };
  const context = vm.createContext({
    window,
    document: { addEventListener() {}, visibilityState: "visible", hasFocus: () => true },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async () => ({ ok: true, json: async () => settings }),
    Date: FakeDate,
    CustomEvent: class {},
    console,
  });
  vm.runInContext(SOURCE, context);
  return {
    T: window.MuhurtaTimer,
    logged,
    read: () => JSON.parse(store.get(KEY) || "null"),
    set: (data) => store.set(KEY, JSON.stringify(data)),
    wait: (sec) => {
      now += sec * 1000;
    },
    now: () => now,
  };
}

test("add time to a running timer: it ends later and is set for longer", () => {
  const p = page();
  p.T.start(25 * 60, null);
  p.wait(60);
  assert.equal(p.T.addTime(300), true);
  const d = p.read();
  assert.equal(d.mode, "running");
  assert.equal(d.durationSec, 30 * 60);
  assert.equal(Math.round(p.T.remainingSec(d, p.now())), 29 * 60);
  assert.equal(p.logged.length, 0); // nothing ended, so nothing is logged yet
});

test("add time to a paused timer: more is left, and the run so far was logged once", () => {
  const p = page();
  p.T.start(10 * 60, null);
  p.wait(120);
  assert.equal(p.T.pause(), true);
  assert.equal(p.T.addTime(60), true);
  const d = p.read();
  assert.equal(d.mode, "paused");
  assert.equal(Math.round(d.remainingSec), 9 * 60);
  assert.equal(d.durationSec, 11 * 60);
  assert.deepEqual(p.logged.map((l) => [l.kind, l.sec]), [["timer", 120]]);
  p.T.resume();
  p.wait(30);
  p.T.stop();
  assert.equal(p.read(), null);
  assert.deepEqual(p.logged.map((l) => l.sec), [120, 30]);
});

test("add time to a ringing timer: it counts again for that long", () => {
  const p = page();
  p.T.start(60, null);
  p.wait(60);
  // As a "Keep ringing" timer is left when it reaches zero.
  p.set({ ...p.read(), mode: "ringing", endsAt: null, runStartedAt: null, ringingSince: p.now(), lastRingAt: p.now() });
  p.wait(20);
  assert.equal(p.T.addTime(300), true);
  const d = p.read();
  assert.equal(d.mode, "running");
  assert.equal(d.durationSec, 60 + 300);
  assert.equal(Math.round(p.T.remainingSec(d, p.now())), 300);
  p.wait(100);
  p.T.stop();
  // Only the new run is logged here; the first minute was logged when it ended.
  assert.deepEqual(p.logged.map((l) => l.sec), [100]);
});

test("a timer can't be pushed past 24 hours, and an idle one takes no time", () => {
  const p = page();
  assert.equal(p.T.addTime(60), false); // nothing running
  p.T.start(23 * 3600 + 58 * 60, null);
  assert.equal(p.T.addTime(60), true);
  assert.equal(p.T.addTime(300), false);
  assert.equal(p.read().durationSec, 23 * 3600 + 59 * 60);
  assert.equal(p.T.addTime(-5), false);
});

test("starting another clock pauses a running timer with a notice", () => {
  const p = page();
  p.T.start(600, null);
  p.wait(45);
  const notice = p.T.pauseFor("flow", "Flow");
  assert.equal(notice, "Timer paused while Flow starts.");
  const d = p.read();
  assert.equal(d.mode, "paused");
  assert.equal(d.pausedBy, "flow");
  assert.deepEqual(p.logged.map((l) => [l.sec, l.details.paused_by]), [[45, "flow"]]);
});
