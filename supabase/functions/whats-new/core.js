// What's new after skipping versions: the logic of the whats-new function,
// kept free of servers and keys so it can be tested on its own
// (supabase/functions/whats-new/core.test.mjs).
//
// The record is every release's lines with the devices they are for
// (release_notes.py -> docs/release-notes.json). For one person's update, from
// the version they had to the new one, on their device:
//   - nothing for that device: no lines (the app shows no card);
//   - one version with lines: those lines as written;
//   - several: one short summary, written by the first AI that answers well,
//     saved and reused for everyone making the same jump; if none answers,
//     the plain lines, without version numbers.

export const DEVICES = ["mac", "windows", "android", "iphone"];
const DEVICE_NAMES = { mac: "Mac", windows: "Windows", android: "Android", iphone: "iPhone" };
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export const MAX_LINES = 5;
const MAX_LINE_CHARS = 220;

const tuple = (v) => String(v).split(".").map(Number);
export function compareVersions(a, b) {
  const x = tuple(a);
  const y = tuple(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const itemText = (item) => (item && typeof item === "object" ? String(item.text) : String(item));
const itemDevices = (item) => (item && typeof item === "object" && Array.isArray(item.for) && item.for.length ? item.for : DEVICES);

// [version, line] for `device`, after `from` up to and including `to`, newest first.
export function linesFor(notes, device, from, to) {
  const out = [];
  for (const [v, items] of Object.entries(notes || {})) {
    if (!VERSION.test(v) || compareVersions(v, from) <= 0 || compareVersions(v, to) > 0) continue;
    for (const item of items || []) if (itemDevices(item).includes(device)) out.push([v, itemText(item)]);
  }
  return out.sort((a, b) => compareVersions(b[0], a[0]));
}

// Only real requests: a known device, two version numbers in order, and a
// new version the record knows. Keeps the AI bill to real jumps only.
export function problemWith(req, notes) {
  if (!req || typeof req !== "object") return "bad request";
  const { from, to, device } = req;
  if (!DEVICES.includes(device)) return "unknown device";
  if (!VERSION.test(String(from)) || !VERSION.test(String(to))) return "bad version";
  if (compareVersions(from, to) >= 0) return "nothing to compare";
  if (!notes || !(to in notes)) return "unknown version";
  return null;
}

export const cacheKey = ({ from, to, device }) => `${from}>${to}:${device}`;

export function prompt(device, lines) {
  return [
    "You write the short \"What's new\" note that Muhurta Pomodoro shows after an update.",
    "Muhurta Pomodoro is a calm focus timer: Rhythm (focus and rest cycles), Timer (a simple countdown),",
    "Flow (an open stopwatch) and a dashboard of your focus.",
    `This person uses the ${DEVICE_NAMES[device]} app and skipped a few updates. These are the changes they missed,`,
    "newest first. Some may be later improvements of earlier ones; then only the newest state matters.",
    "",
    ...lines.map(([, text]) => `- ${text}`),
    "",
    `Write at most ${MAX_LINES} lines, fewer when fewer cover it. Merge related changes into one line.`,
    "Put what they will notice most first. Use simple, warm, everyday words and short sentences.",
    "Mention only what is listed above. Never mention version numbers or other devices.",
    "Answer with only a JSON array of strings, one string per line, and nothing else.",
  ].join("\n");
}

// The AI's answer, if it is what was asked for: a JSON array of 1-5 short strings.
export function parseLines(text) {
  if (typeof text !== "string") return null;
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let value;
  try {
    value = JSON.parse(body.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const lines = value.filter((l) => typeof l === "string").map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > MAX_LINES || lines.length !== value.length) return null;
  if (lines.some((l) => l.length > MAX_LINE_CHARS || /\b\d+\.\d+\.\d+\b/.test(l))) return null;
  return lines;
}

// The answer for one update. `providers` are tried in order: [{ name, ask(prompt) -> text }].
// `saved` is a summary written before for the same jump; `save(lines, source)` keeps a new one.
/**
 * @param {{
 *   notes: Record<string, unknown[]>, from: string, to: string, device: string,
 *   providers?: { name: string, ask: (prompt: string) => Promise<string> }[],
 *   saved?: string[] | null,
 *   save?: (lines: string[], source: string) => Promise<void>,
 * }} args
 * @returns {Promise<{ lines: string[], source: string, fallback?: boolean }>}
 */
export async function whatsNew({ notes, from, to, device, providers = [], saved = null, save = async () => {} }) {
  const found = linesFor(notes, device, from, to);
  const plain = found.map(([, text]) => text);
  if (new Set(found.map(([v]) => v)).size <= 1) return { lines: plain, source: "notes" };
  if (Array.isArray(saved) && saved.length) return { lines: saved, source: "saved" };
  const ask = prompt(device, found);
  for (const provider of providers) {
    try {
      const lines = parseLines(await provider.ask(ask));
      if (!lines) continue; // an answer in the wrong shape: try the next one
      try {
        await save(lines, provider.name);
      } catch (_) {} // not saved this time: still answer
      return { lines, source: provider.name };
    } catch (_) {
      // busy, down, too slow or refused: the next one
    }
  }
  return { lines: plain, source: "notes", fallback: true };
}
