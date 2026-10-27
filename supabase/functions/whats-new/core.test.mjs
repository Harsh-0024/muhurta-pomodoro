// node supabase/functions/whats-new/core.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linesFor, parseLines, problemWith, whatsNew } from "./core.js";

const notes = {
  "1.16.0": [{ text: "Mac menu bar is calmer.", for: ["mac"] }, { text: "Timer rings softer.", for: ["mac", "windows", "android", "iphone"] }],
  "1.15.0": [{ text: "Dashboard shows your usual sitting.", for: ["mac", "windows", "android", "iphone"] }],
  "1.14.0": [{ text: "Android live clock.", for: ["android"] }, "Overtime wording."],
};
const answer = (lines) => ({ name: "fake", ask: async () => JSON.stringify(lines) });
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };

await t("lines only for the device, newest first, after `from` up to `to`", () =>
  assert.deepEqual(linesFor(notes, "android", "1.13.0", "1.16.0").map(([v]) => v), ["1.16.0", "1.15.0", "1.14.0", "1.14.0"]));
await t("a Mac-only line never reaches Android", () =>
  assert.ok(!linesFor(notes, "android", "1.15.0", "1.16.0").some(([, l]) => l.includes("menu bar"))));
await t("one version: its lines as written, no AI", async () => {
  let asked = false;
  const r = await whatsNew({ notes, from: "1.15.0", to: "1.16.0", device: "mac", providers: [{ name: "x", ask: async () => { asked = true; return "[]"; } }] });
  assert.deepEqual(r, { lines: ["Mac menu bar is calmer.", "Timer rings softer."], source: "notes" });
  assert.equal(asked, false);
});
await t("nothing for the device: no lines", async () =>
  assert.deepEqual((await whatsNew({ notes, from: "1.15.0", to: "1.16.0", device: "windows" })).lines, ["Timer rings softer."]));
await t("several versions: the AI's summary, saved", async () => {
  let kept = null;
  const r = await whatsNew({ notes, from: "1.13.0", to: "1.16.0", device: "android", providers: [answer(["A calmer timer.", "A live clock on your phone."])], save: async (l, s) => { kept = [l, s]; } });
  assert.deepEqual(r, { lines: ["A calmer timer.", "A live clock on your phone."], source: "fake" });
  assert.deepEqual(kept, [r.lines, "fake"]);
});
await t("a saved summary is reused without asking", async () => {
  const r = await whatsNew({ notes, from: "1.13.0", to: "1.16.0", device: "android", saved: ["Saved line."], providers: [{ name: "x", ask: async () => { throw new Error("should not ask"); } }] });
  assert.deepEqual(r, { lines: ["Saved line."], source: "saved" });
});
await t("first AI busy, second answers", async () => {
  const r = await whatsNew({ notes, from: "1.13.0", to: "1.16.0", device: "iphone", providers: [{ name: "a", ask: async () => { throw new Error("429"); } }, { ...answer(["From the second."]), name: "b" }] });
  assert.equal(r.source, "b");
});
await t("an answer in the wrong shape is skipped", async () => {
  const r = await whatsNew({ notes, from: "1.13.0", to: "1.16.0", device: "iphone", providers: [{ name: "a", ask: async () => "Sure! Here you go." }, { ...answer(["Good."]), name: "b" }] });
  assert.equal(r.source, "b");
});
await t("every AI fails: the plain lines, no version numbers", async () => {
  const r = await whatsNew({ notes, from: "1.13.0", to: "1.16.0", device: "android", providers: [{ name: "a", ask: async () => { throw new Error("down"); } }] });
  assert.equal(r.fallback, true);
  assert.deepEqual(r.lines, ["Timer rings softer.", "Dashboard shows your usual sitting.", "Android live clock.", "Overtime wording."]);
});
await t("a save that fails still answers", async () => {
  const r = await whatsNew({ notes, from: "1.13.0", to: "1.16.0", device: "android", providers: [answer(["X."])], save: async () => { throw new Error("db"); } });
  assert.deepEqual(r.lines, ["X."]);
});
await t("parseLines: fences ok; too many, version numbers or non-strings rejected", () => {
  assert.deepEqual(parseLines('```json\n["a", "b"]\n```'), ["a", "b"]);
  assert.equal(parseLines(JSON.stringify(["1", "2", "3", "4", "5", "6"])), null);
  assert.equal(parseLines('["New in 1.15.0: x"]'), null);
  assert.equal(parseLines('["a", 3]'), null);
  assert.equal(parseLines("[]"), null);
  assert.deepEqual(parseLines('{"lines": ["a", "b"]}'), ["a", "b"]);
  assert.deepEqual(parseLines(JSON.stringify(["a  \nb\n"])), ["a", "b"]);
  assert.equal(parseLines('{"text": "a"}'), null);
});
await t("only real requests are accepted", () => {
  assert.equal(problemWith({ from: "1.13.0", to: "1.16.0", device: "android" }, notes), null);
  assert.equal(problemWith({ from: "1.13.0", to: "1.16.0", device: "linux" }, notes), "unknown device");
  assert.equal(problemWith({ from: "1.16.0", to: "1.13.0", device: "mac" }, notes), "nothing to compare");
  assert.equal(problemWith({ from: "1.13.0", to: "9.9.9", device: "mac" }, notes), "unknown version");
  assert.equal(problemWith({ from: "x", to: "1.16.0", device: "mac" }, notes), "bad version");
});
await t("the real record parses and every line has known devices", () => {
  const real = JSON.parse(readFileSync(new URL("../../../docs/release-notes.json", import.meta.url))).versions;
  for (const items of Object.values(real)) for (const i of items) assert.ok(i.text && i.for.every((d) => ["mac", "windows", "android", "iphone"].includes(d)));
});
console.log(`\n${n} checks passed`);
