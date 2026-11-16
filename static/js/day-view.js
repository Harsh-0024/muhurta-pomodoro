// One day on the dashboard: when the focus and the rest happened, and the
// sittings they made. Opened from a square of the year, a bar of the last 7
// days or a row of Recent days (dashboard.js calls MuhurtaDayView.open).
(function () {
  "use strict";

  const FOCUS_KINDS = new Set(["work", "extend", "flow", "timer"]);
  const SITTING_GAP_MS = 5 * 60 * 1000; // a shorter break doesn't end a sitting
  const MIN_SPAN_HOURS = 6;
  const HOUR = 60 * 60 * 1000;
  const kickerFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  const titleFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

  let current = null; // the day shown, "YYYY-MM-DD"
  let loadId = 0;
  let opener = null;

  const $ = (id) => document.getElementById(id);

  function parseDay(day) {
    return new Date(`${day}T00:00:00`);
  }

  function dayKey(date) {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${m}-${d}`;
  }

  function shiftDay(day, by) {
    const date = parseDay(day);
    date.setDate(date.getDate() + by);
    return dayKey(date);
  }

  function formatMinutes(sec) {
    const n = Math.round(Number(sec || 0) / 60);
    if (n < 60) return `${n}m`;
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function clockName(seg) {
    if (seg.kind === "timer") return "Timer";
    if (seg.kind === "flow") return "Flow";
    return seg.preset_name || "Rhythm";
  }

  // [{ start, end, focus, kind: "focus" | "rest", name }] in local time.
  function spans(segments) {
    return segments
      .map((seg) => {
        const start = new Date(seg.started_at).getTime();
        const end = new Date(seg.ended_at).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        const focus = FOCUS_KINDS.has(seg.kind);
        return { start, end, focus, sec: Number(focus ? seg.productive_sec : seg.rest_sec) || 0, name: clockName(seg) };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  // Focus spans joined into sittings: a break under 5 minutes doesn't end one.
  function sittings(all) {
    const out = [];
    all.filter((s) => s.focus).forEach((s) => {
      const last = out[out.length - 1];
      if (last && s.start - last.end < SITTING_GAP_MS) {
        last.end = Math.max(last.end, s.end);
        last.sec += s.sec;
        if (!last.names.includes(s.name)) last.names.push(s.name);
      } else {
        out.push({ start: s.start, end: s.end, sec: s.sec, names: [s.name] });
      }
    });
    // Seconds-long starts and stops are not sittings.
    return out.filter((s) => s.sec >= 60);
  }

  function drawStrip(all) {
    const strip = $("dayStrip");
    const hours = $("dayHours");
    strip.innerHTML = "";
    hours.innerHTML = "";
    if (!all.length) return;
    // From the local hour the day's first clock started in (a plain division
    // would be half an hour off in a time zone like India's).
    const first = new Date(all[0].start);
    first.setMinutes(0, 0, 0);
    let lo = first.getTime();
    let hi = lo + Math.max(1, Math.ceil((Math.max(...all.map((s) => s.end)) - lo) / HOUR)) * HOUR;
    while (hi - lo < MIN_SPAN_HOURS * HOUR) {
      // Widen evenly, earlier side first.
      if ((hi - lo) / HOUR % 2 === 0) lo -= HOUR;
      else hi += HOUR;
    }
    const span = hi - lo;
    const at = (t) => `${(((t - lo) / span) * 100).toFixed(3)}%`;

    // Rest first, so focus draws over a rest another device recorded.
    [...all.filter((s) => !s.focus), ...all.filter((s) => s.focus)].forEach((s) => {
      const bar = document.createElement("span");
      bar.className = s.focus ? "is-focus" : "is-rest";
      bar.style.left = at(s.start);
      bar.style.width = `${(((s.end - s.start) / span) * 100).toFixed(3)}%`;
      bar.title = `${timeFormat.format(s.start)} – ${timeFormat.format(s.end)} · ${s.focus ? s.name : "Rest"}`;
      strip.appendChild(bar);
    });

    const total = Math.round(span / HOUR);
    const step = Math.max(1, Math.ceil(total / 4));
    for (let h = 0; h <= total; h += step) {
      // Leave out a label that would crowd the last one.
      if (h !== total && total - h < step * 0.6) continue;
      const label = document.createElement("span");
      label.textContent = hourFormat.format(lo + h * HOUR);
      label.style.left = `${((h / total) * 100).toFixed(3)}%`;
      hours.appendChild(label);
    }
    if (total % step !== 0) {
      const label = document.createElement("span");
      label.textContent = hourFormat.format(hi);
      label.style.left = "100%";
      hours.appendChild(label);
    }
  }

  function draw(day, data) {
    const all = spans(data.segments || []);
    const sat = sittings(all);
    const totals = data.totals || {};
    $("dayFocus").textContent = formatMinutes(totals.productive_sec);
    $("dayRest").textContent = formatMinutes(totals.rest_sec);
    $("daySittings").textContent = String(sat.length);

    const empty = !all.length;
    $("dayBody").classList.toggle("hidden", empty);
    $("dayEmpty").classList.toggle("hidden", !empty);
    drawStrip(all);
    $("dayStrip").setAttribute(
      "aria-label",
      empty ? "" : `Focus and rest through the day, from ${timeFormat.format(all[0].start)} to ${timeFormat.format(Math.max(...all.map((s) => s.end)))}`
    );

    const list = $("dayList");
    list.innerHTML = "";
    sat.forEach((s) => {
      const row = document.createElement("li");
      const when = document.createElement("span");
      when.className = "day-when";
      when.textContent = `${timeFormat.format(s.start)} – ${timeFormat.format(s.end)}`;
      const what = document.createElement("span");
      what.className = "day-what";
      const strong = document.createElement("b");
      strong.textContent = formatMinutes(s.sec);
      what.append(strong, ` · ${s.names.join(", ")}`);
      row.append(when, what);
      list.appendChild(row);
    });
  }

  async function show(day) {
    current = day;
    const id = ++loadId;
    const date = parseDay(day);
    $("dayKicker").textContent = kickerFormat.format(date);
    $("dayTitle").textContent = titleFormat.format(date);
    $("dayNext").disabled = day >= dayKey(new Date());
    try {
      const res = await fetch(`/api/activity/day?day=${day}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      if (id === loadId) draw(day, data);
    } catch (_) {
      if (id !== loadId) return;
      draw(day, { segments: [], totals: {} });
      $("dayEmpty").textContent = "This day could not be loaded.";
    }
  }

  function open(day) {
    const modal = $("dayModal");
    if (!modal || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return;
    opener = document.activeElement;
    $("dayEmpty").textContent = "Nothing was timed on this day.";
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    $("dayClose").focus();
    show(day);
  }

  function close() {
    const modal = $("dayModal");
    if (!modal || modal.classList.contains("hidden")) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    loadId += 1;
    if (opener && document.contains(opener)) opener.focus?.();
    opener = null;
  }

  function wire() {
    const modal = $("dayModal");
    if (!modal) return;
    // Out of the page's own layer, so the sheet covers the phone's tab bar.
    document.body.appendChild(modal);
    $("dayClose").addEventListener("click", close);
    modal.querySelector(".modal-backdrop").addEventListener("click", close);
    $("dayPrev").addEventListener("click", () => show(shiftDay(current, -1)));
    $("dayNext").addEventListener("click", () => {
      if (current < dayKey(new Date())) show(shiftDay(current, 1));
    });
    document.addEventListener("keydown", (e) => {
      if (modal.classList.contains("hidden")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") $("dayPrev").click();
      else if (e.key === "ArrowRight") $("dayNext").click();
      else return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  document.addEventListener("DOMContentLoaded", wire);
  window.MuhurtaDayView = { open };
})();
