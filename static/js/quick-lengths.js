// The Timer's quick lengths, from each person's own rhythms and history.
//
// The lengths come from a ladder: the focus lengths of the Rhythm levels
// (12, 24, 36 ... 96) and of the person's own combinations, with 6 as a short
// step below. Their usual length (where most of their focused minutes went in
// the last 30 days) sits third, with the two steps below it and the three
// above; near either end the six shift so there are always six.
//
// Focus counts in blocks, not in the pieces the history stores: a break
// shorter than 5 minutes (a pause, a stop and start, or a rest cut short)
// doesn't end a block, and the minutes away aren't counted. A break of 5
// minutes or more ends it, and so does a scheduled Rhythm rest taken in full,
// however short. Mode doesn't matter: Timer then Flow is one block.
//
// Used by timer.js in the browser; also loadable in Node for tests.
(function (root) {
  "use strict";

  const SHORT_BREAK_SEC = 5 * 60;
  const FOCUS_KINDS = new Set(["work", "extend", "timer", "flow"]);
  const SHORTEST = 6; // a step below the shortest level (12)
  const SHOWN = 6;
  const USUAL_AT = 2; // third place

  const time = (iso) => Date.parse(iso);

  // A scheduled rest that ran to its planned end (a second of slack).
  function restTakenInFull(seg) {
    const planned = Number(seg.details && seg.details.duration_sec);
    return seg.kind === "rest" && planned > 0 && Number(seg.duration_sec) >= planned - 1;
  }

  // Focused seconds per block, oldest first.
  function blocks(segments) {
    const sorted = [...segments].filter((s) => Number.isFinite(time(s.started_at))).sort((a, b) => time(a.started_at) - time(b.started_at));
    const out = [];
    let cur = null; // { sec, end, closed }
    for (const seg of sorted) {
      if (FOCUS_KINDS.has(seg.kind)) {
        const start = time(seg.started_at);
        const end = time(seg.ended_at);
        const joins = cur && !cur.closed && (start - cur.end) / 1000 < SHORT_BREAK_SEC;
        if (!joins) {
          if (cur) out.push(cur.sec);
          cur = { sec: 0, end, closed: false };
        }
        cur.sec += Math.max(0, Number(seg.duration_sec) || 0);
        cur.end = Math.max(cur.end, end);
      } else if (cur && restTakenInFull(seg)) {
        cur.closed = true; // the rhythm's own rest, taken as planned
      }
      // Pauses, pool rests and rests cut short: judged by the gap alone.
    }
    if (cur) out.push(cur.sec);
    return out.filter((sec) => sec >= 60);
  }

  // Minutes, smallest first, no repeats.
  function ladder(presets) {
    const set = new Set([SHORTEST]);
    for (const p of presets || []) {
      const m = Math.round(Number(p.work_min));
      if (m > 0) set.add(m);
    }
    return [...set].sort((a, b) => a - b);
  }

  const nearest = (steps, minutes) => steps.reduce((best, m) => (Math.abs(m - minutes) < Math.abs(best - minutes) ? m : best), steps[0]);

  // The step with the most focused minutes; `fallback` with no history.
  function usual(blockSecs, steps, fallback) {
    const minutes = new Map();
    for (const sec of blockSecs) {
      const step = nearest(steps, sec / 60);
      minutes.set(step, (minutes.get(step) || 0) + sec / 60);
    }
    if (!minutes.size) return nearest(steps, fallback);
    let best = null;
    for (const [step, total] of minutes) if (best === null || total > minutes.get(best)) best = step;
    return best;
  }

  function lengths(steps, usualMin) {
    const i = Math.max(0, steps.indexOf(usualMin));
    const from = Math.max(0, Math.min(i - USUAL_AT, steps.length - SHOWN));
    return steps.slice(from, from + SHOWN);
  }

  // Everything at once: { lengths, usual }.
  function pick({ segments, presets, fallbackMin }) {
    const steps = ladder(presets);
    const u = usual(blocks(segments || []), steps, fallbackMin || 24);
    return { lengths: lengths(steps, u), usual: u };
  }

  const api = { blocks, ladder, usual, lengths, pick, SHORT_BREAK_SEC };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MuhurtaQuickLengths = api;
})(this);
