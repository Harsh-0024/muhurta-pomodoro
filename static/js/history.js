(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const DAY_MS = 24 * 60 * 60 * 1000;
  const PAGE_DAYS = 7;
  const MIN_SEC = 60;
  const MAX_SEC = 24 * 60 * 60;
  const FUTURE_SLACK_MS = 5 * 60 * 1000;
  const MODE_KEY = "muhurata.history.mode";

  const KINDS = {
    work: { label: "Focus", focus: true },
    extend: { label: "Overtime", focus: true },
    flow: { label: "Flow", focus: true },
    timer: { label: "Timer", focus: true },
    rest: { label: "Rest", focus: false },
    cumulative: { label: "Pooled rest", focus: false },
    pause: { label: "Pause", focus: false },
  };

  let view = "recent";
  let recent = []; // segments loaded for the "By day" view, newest first
  let oldestLoaded = null; // earliest day the "By day" view has fetched
  let earliestDay = null; // earliest day anything was ever logged
  let longList = [];
  let longThresholdSec = 3 * 60 * 60;

  // The open editor: { segment } when editing, { segment: null } when adding.
  let editing = null;
  let lastFocus = null;

  /* ---------- helpers ---------- */

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $("settingsToast");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("is-error", kind === "error");
    el.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), kind === "error" ? 4000 : 1800);
  }

  function askConfirm(options) {
    if (window.MuhurataDialog?.confirm) return window.MuhurataDialog.confirm(options);
    return Promise.resolve(window.confirm(options?.message || options?.title || "Continue?"));
  }

  async function api(path, opts) {
    const r = await fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    });
    if (!r.ok) {
      let err = r.statusText;
      let body = null;
      try {
        body = await r.json();
        if (body.error) err = body.error;
      } catch (_) {}
      const e = new Error(err);
      e.body = body;
      throw e;
    }
    if (r.status === 204) return null;
    return r.json();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const pad = (n) => String(n).padStart(2, "0");

  function localDayISO(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function dayStartMs(dayIso) {
    const [y, m, d] = dayIso.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  }

  function shiftDay(dayIso, delta) {
    const [y, m, d] = dayIso.split("-").map(Number);
    return localDayISO(new Date(y, m - 1, d + delta).getTime());
  }

  // Value for <input type="datetime-local">, in this computer's time.
  function toLocalInput(ms) {
    const d = new Date(ms);
    return `${localDayISO(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fromLocalInput(value) {
    if (!value) return NaN;
    const [day, clock] = value.split("T");
    const [y, m, d] = day.split("-").map(Number);
    const [hh, mm] = (clock || "").split(":").map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0).getTime();
  }

  function formatDuration(sec) {
    const exact = Math.max(0, Number(sec || 0));
    if (exact > 0 && exact < 60) return `${Math.max(1, Math.round(exact))}s`;
    const total = Math.round(exact / 60);
    if (total < 60) return `${total}m`;
    const h = Math.floor(total / 60);
    const r = total % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }

  function formatClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatDayHeading(dayIso) {
    const today = localDayISO(Date.now());
    if (dayIso === today) return "Today";
    if (dayIso === shiftDay(today, -1)) return "Yesterday";
    const d = new Date(dayStartMs(dayIso));
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString([], {
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  }

  function formatRange(startMs, endMs) {
    const extraDays = Math.round((dayStartMs(localDayISO(endMs)) - dayStartMs(localDayISO(startMs))) / DAY_MS);
    const next = extraDays > 0 ? ` <span class="history-next-day">+${extraDays}d</span>` : "";
    return `${formatClock(startMs)} – ${formatClock(endMs)}${next}`;
  }

  // For sentences: "yesterday" / "on Friday 9 October", and a range without markup.
  function dayPhrase(dayIso) {
    const h = formatDayHeading(dayIso);
    return h === "Today" || h === "Yesterday" ? h.toLowerCase() : `on ${h}`;
  }

  function plainRange(seg) {
    return formatRange(startOf(seg), endOf(seg)).replace(/<[^>]+>\+(\d+)d<\/span>/, " (next day)").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }

  const startOf = (seg) => Date.parse(seg.started_at);
  const endOf = (seg) => Date.parse(seg.ended_at);
  const kindOf = (seg) => KINDS[seg.kind] || { label: seg.kind, focus: Number(seg.productive_sec) > 0 };
  const isLong = (seg) => Number(seg.duration_sec) >= longThresholdSec;

  function readMode() {
    try {
      const v = localStorage.getItem(MODE_KEY);
      if (v === "end" || v === "duration") return v;
    } catch (_) {}
    return "end";
  }

  function writeMode(v) {
    try {
      localStorage.setItem(MODE_KEY, v);
    } catch (_) {}
  }

  /* ---------- loading ---------- */

  async function loadRecent(endDay) {
    const data = await api(`/api/activity/history?end=${endDay}&days=${PAGE_DAYS}`);
    earliestDay = data.earliest_day;
    longThresholdSec = Number(data.long_threshold_sec || longThresholdSec);
    oldestLoaded = data.start;
    return data.segments || [];
  }

  async function loadEarlier() {
    const btn = $("btnEarlier");
    if (btn) btn.disabled = true;
    try {
      // Skip quiet weeks so one click always shows something new.
      for (let i = 0; i < 26; i += 1) {
        if (!hasEarlier()) break;
        const segs = await loadRecent(shiftDay(oldestLoaded, -1));
        mergeRecent(segs);
        if (segs.length) break;
      }
      render();
    } catch (e) {
      toast(e.message || "Could not load earlier days", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function loadLong() {
    const data = await api("/api/activity/history?long=1");
    longList = data.segments || [];
    longThresholdSec = Number(data.long_threshold_sec || longThresholdSec);
    renderLongCount();
  }

  function mergeRecent(segs) {
    const byId = new Map(recent.map((s) => [s.id, s]));
    segs.forEach((s) => byId.set(s.id, s));
    recent = [...byId.values()].sort((a, b) => startOf(b) - startOf(a) || b.id - a.id);
  }

  const hasEarlier = () => Boolean(earliestDay && oldestLoaded && earliestDay < oldestLoaded);

  /* ---------- rendering ---------- */

  function renderLongCount() {
    const el = $("longCount");
    if (!el) return;
    el.textContent = String(longList.length);
    el.classList.toggle("hidden", longList.length === 0);
  }

  function segmentRow(seg) {
    const kind = kindOf(seg);
    const edit = seg.details?.edit;
    const manual = seg.details?.source === "manual";
    const badges = [
      isLong(seg) ? `<span class="badge badge-warn">Unusually long</span>` : "",
      edit ? `<span class="badge">Edited</span>` : "",
      manual ? `<span class="badge">Added</span>` : "",
    ].join("");
    const was = edit?.original
      ? `<span class="history-was">was ${formatDuration(edit.original.duration_sec)}</span>`
      : "";
    const preset = seg.preset_name && !manual && seg.preset_name !== kind.label ? ` · ${escapeHtml(seg.preset_name)}` : "";
    return `
      <li class="history-item${isLong(seg) ? " is-long" : ""}" data-id="${seg.id}">
        <span class="history-kind ${kind.focus ? "is-focus" : "is-rest"}" aria-hidden="true"></span>
        <div class="history-main">
          <div class="history-line">
            <strong class="history-range">${formatRange(startOf(seg), endOf(seg))}</strong>
            ${badges}
          </div>
          <span class="history-meta">${escapeHtml(kind.label)}${preset}</span>
        </div>
        <div class="history-length">
          <strong>${formatDuration(seg.duration_sec)}</strong>
          ${was}
        </div>
        <div class="custom-actions">
          <button type="button" class="btn btn-quiet btn-small" data-action="edit" aria-label="Edit ${escapeHtml(kind.label)} at ${formatClock(startOf(seg))}">Edit</button>
          <button type="button" class="btn btn-danger" data-action="delete" aria-label="Delete ${escapeHtml(kind.label)} at ${formatClock(startOf(seg))}">Delete</button>
        </div>
      </li>`;
  }

  // A 24-hour strip for the day, so a session that swallowed the night is
  // obvious at a glance.
  function dayTimeline(dayIso, segs) {
    const start = dayStartMs(dayIso);
    const end = dayStartMs(shiftDay(dayIso, 1));
    const span = end - start;
    const blocks = segs
      .map((seg) => {
        const a = Math.max(start, startOf(seg));
        const b = Math.min(end, endOf(seg));
        if (b <= a) return "";
        const left = ((a - start) / span) * 100;
        const width = Math.max(0.35, ((b - a) / span) * 100);
        const cls = `${kindOf(seg).focus ? "is-focus" : "is-rest"}${isLong(seg) ? " is-long" : ""}`;
        return `<button type="button" class="history-block ${cls}" data-id="${seg.id}" data-action="edit" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${kindOf(seg).label} · ${formatClock(startOf(seg))} – ${formatClock(endOf(seg))} · ${formatDuration(seg.duration_sec)}" tabindex="-1"></button>`;
      })
      .join("");
    return `
      <div class="history-timeline" aria-hidden="true">
        <div class="history-track">${blocks}</div>
        <div class="history-hours"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      </div>`;
  }

  function dayTotals(segs) {
    let focus = 0;
    let rest = 0;
    segs.forEach((s) => {
      focus += Number(s.productive_sec || 0);
      rest += Number(s.rest_sec || 0);
    });
    return { focus, rest };
  }

  function renderRecent() {
    const groups = new Map();
    recent.forEach((seg) => {
      if (!groups.has(seg.day)) groups.set(seg.day, []);
      groups.get(seg.day).push(seg);
    });
    const days = [...groups.keys()].sort().reverse();
    if (!days.length) {
      return emptyState(
        hasEarlier() ? "Nothing logged this week." : "Nothing logged yet.",
        hasEarlier() ? "Earlier days are below." : "Sessions appear here as soon as the timer records them."
      );
    }
    return days
      .map((day) => {
        const segs = groups.get(day);
        const t = dayTotals(segs);
        return `
          <section class="pref-group history-day">
            <header class="history-day-head">
              <h2 class="history-day-title">${escapeHtml(formatDayHeading(day))}</h2>
              <p class="history-day-sum"><b>${formatDuration(t.focus)}</b> focus${t.rest ? ` · ${formatDuration(t.rest)} rest` : ""}</p>
            </header>
            ${dayTimeline(day, segs.slice().sort((a, b) => startOf(a) - startOf(b)))}
            <ul class="custom-list history-items">${segs.map(segmentRow).join("")}</ul>
          </section>`;
      })
      .join("");
  }

  function renderLong() {
    if (!longList.length) {
      return emptyState("Nothing looks out of place.", `No session runs longer than ${formatDuration(longThresholdSec)}.`);
    }
    return `
      <section class="pref-group history-day">
        <ul class="custom-list history-items history-items-flat">${longList
          .map((seg) => segmentRow(seg).replace('<div class="history-main">', `<div class="history-main"><span class="history-on">${escapeHtml(formatDayHeading(seg.day))}</span>`))
          .join("")}</ul>
      </section>`;
  }

  function emptyState(title, body) {
    return `<div class="pref-group history-empty"><p><strong>${escapeHtml(title)}</strong>${escapeHtml(body)}</p></div>`;
  }

  function render() {
    const list = $("historyList");
    if (!list) return;
    list.innerHTML = view === "long" ? renderLong() : renderRecent();
    $("btnEarlier")?.classList.toggle("hidden", view !== "recent" || !hasEarlier());
    const hint = $("longHint");
    if (hint) {
      hint.textContent = `Sessions over ${formatDuration(longThresholdSec)}. Most are a timer left running; trim them to the time you actually worked.`;
      hint.classList.toggle("hidden", view !== "long" || !longList.length);
    }
  }

  function findSegment(id) {
    return recent.find((s) => s.id === id) || longList.find((s) => s.id === id) || null;
  }

  function flash(id) {
    requestAnimationFrame(() => {
      document.querySelectorAll(`.history-item[data-id="${id}"]`).forEach((el) => {
        el.classList.add("is-flash");
        setTimeout(() => el.classList.remove("is-flash"), 1600);
      });
    });
  }

  /* ---------- editor ---------- */

  function setSegmented(groupId, value) {
    $(groupId)
      ?.querySelectorAll(".segment")
      .forEach((b) => {
        const on = b.dataset.value === value;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", String(on));
      });
  }

  const segmentedValue = (groupId) => $(groupId)?.querySelector(".segment.is-active")?.dataset.value;

  function setMode(mode) {
    setSegmented("modePicker", mode);
    $("endField")?.classList.toggle("hidden", mode !== "end");
    $("durationField")?.classList.toggle("hidden", mode !== "duration");
  }

  function setDurationFields(sec) {
    const totalMin = Math.max(0, Math.round(sec / 60));
    $("fieldHours").value = String(Math.floor(totalMin / 60));
    $("fieldMinutes").value = String(totalMin % 60);
  }

  function openEditor(seg) {
    editing = { segment: seg };
    lastFocus = document.activeElement;
    const now = Date.now();
    let startMs;
    let endMs;
    if (seg) {
      startMs = startOf(seg);
      endMs = endOf(seg);
    } else {
      // A fresh entry defaults to the hour that just passed, on a 5-minute grid.
      endMs = Math.floor(now / 300000) * 300000;
      startMs = endMs - 60 * 60 * 1000;
    }
    editing.initial = { startInput: toLocalInput(startMs), endInput: toLocalInput(endMs), startMs, endMs };

    $("sessionKicker").textContent = seg ? "Edit session" : "Add a session";
    $("sessionTitle").textContent = seg
      ? `${kindOf(seg).label} · ${formatDayHeading(seg.day)}`
      : "Something the timer missed";
    $("kindField").classList.toggle("hidden", Boolean(seg));
    setSegmented("kindPicker", "work");

    const recorded = $("sessionRecorded");
    const original = seg?.details?.edit?.original;
    if (seg) {
      const src = original || seg;
      const a = Date.parse(src.started_at);
      const b = Date.parse(src.ended_at);
      recorded.innerHTML = `${original ? "Originally recorded" : "Recorded"} ${formatRange(a, b)} · <b>${formatDuration(src.duration_sec)}</b>`;
      recorded.classList.remove("hidden");
    } else {
      recorded.classList.add("hidden");
    }
    $("btnRevert").classList.toggle("hidden", !original);

    $("fieldStart").value = editing.initial.startInput;
    $("fieldEnd").value = editing.initial.endInput;
    $("fieldStart").max = toLocalInput(now);
    $("fieldEnd").max = toLocalInput(now + FUTURE_SLACK_MS);
    setDurationFields((endMs - startMs) / 1000);
    setMode(readMode());
    showError("");
    updatePreview();

    const modal = $("sessionModal");
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    $("fieldStart").focus();
  }

  function closeEditor() {
    const modal = $("sessionModal");
    if (!modal || modal.classList.contains("hidden")) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    editing = null;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  // Inputs only hold whole minutes; keep the recorded seconds for any field
  // left untouched so saving an end-time fix does not nudge the start.
  function readTimes() {
    const init = editing.initial;
    const startInput = $("fieldStart").value;
    const startMs = startInput === init.startInput ? init.startMs : fromLocalInput(startInput);
    let endMs;
    if (segmentedValue("modePicker") === "duration") {
      const h = Number($("fieldHours").value || 0);
      const m = Number($("fieldMinutes").value || 0);
      if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) return { startMs, endMs: NaN };
      const sec = Math.round(h * 3600 + m * 60);
      const untouched = startInput === init.startInput && sec === Math.round((init.endMs - init.startMs) / 60000) * 60;
      endMs = untouched ? init.endMs : startMs + sec * 1000;
    } else {
      const endInput = $("fieldEnd").value;
      endMs = endInput === init.endInput ? init.endMs : fromLocalInput(endInput);
    }
    return { startMs, endMs };
  }

  function validate({ startMs, endMs }) {
    if (!Number.isFinite(startMs)) return "Pick when it started.";
    if (!Number.isFinite(endMs)) return "Pick when it ended, or how long it lasted.";
    const sec = (endMs - startMs) / 1000;
    if (sec <= 0) return "The end has to come after the start.";
    if (sec < MIN_SEC) return "A session has to be at least a minute long.";
    if (sec > MAX_SEC) return "A session can be at most 24 hours long.";
    if (endMs - Date.now() > FUTURE_SLACK_MS) return "That would end in the future.";
    return "";
  }

  function updatePreview() {
    if (!editing) return;
    const times = readTimes();
    const problem = validate(times);
    const el = $("sessionPreview");
    if (problem) {
      el.innerHTML = "";
      return;
    }
    const sec = (times.endMs - times.startMs) / 1000;
    const seg = editing.segment;
    const focus = seg ? kindOf(seg).focus : segmentedValue("kindPicker") === "work";
    let line = `${formatRange(times.startMs, times.endMs)} · counts as <b>${formatDuration(sec)}</b> of ${focus ? "focus" : "rest"}`;
    if (seg) {
      const diff = Math.round((sec - Number(seg.duration_sec)) / 60) * 60;
      if (diff) line += ` <span class="history-diff ${diff < 0 ? "is-less" : "is-more"}">${diff < 0 ? "−" : "+"}${formatDuration(Math.abs(diff))}</span>`;
    }
    el.innerHTML = line;
    showError("");
  }

  function showError(msg) {
    const el = $("sessionError");
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  }

  async function submitEditor(e) {
    e.preventDefault();
    if (!editing) return;
    const times = readTimes();
    const problem = validate(times);
    if (problem) return showError(problem);
    const seg = editing.segment;
    const body = {
      day: localDayISO(times.startMs),
      started_at: new Date(times.startMs).toISOString(),
      ended_at: new Date(times.endMs).toISOString(),
    };
    await persist(seg, body, seg ? "Session updated" : "Session added");
  }

  async function revertEditor() {
    const original = editing?.segment?.details?.edit?.original;
    if (!original) return;
    await persist(
      editing.segment,
      { day: original.day, started_at: original.started_at, ended_at: original.ended_at },
      "Recorded times restored"
    );
  }

  async function persist(seg, body, message) {
    const btn = $("sessionSave");
    btn.disabled = true;
    try {
      const saved = seg
        ? await api(`/api/activity/segment/${seg.id}`, { method: "PUT", body: JSON.stringify(body) })
        : await api("/api/activity/manual", {
            method: "POST",
            body: JSON.stringify({ ...body, kind: segmentedValue("kindPicker") }),
          });
      closeEditor();
      await afterChange(saved);
      toast(message);
      flash(saved.id);
    } catch (err) {
      const c = err.body?.conflict;
      showError(
        c
          ? `That overlaps the ${kindOf(c).label.toLowerCase()} session ${dayPhrase(c.day)}, ${plainRange(c)}. Trim that one first, or pick other times.`
          : err.message || "Could not save"
      );
    } finally {
      btn.disabled = false;
    }
  }

  async function afterChange(saved) {
    if (saved) {
      recent = recent.filter((s) => s.id !== saved.id);
      if (!oldestLoaded || saved.day >= oldestLoaded) mergeRecent([saved]);
    }
    try {
      await loadLong();
    } catch (_) {}
    render();
  }

  async function deleteSegment(seg) {
    const kind = kindOf(seg);
    const ok = await askConfirm({
      title: "Delete this session?",
      message: `${kind.label} ${dayPhrase(seg.day)}, ${plainRange(seg)} (${formatDuration(seg.duration_sec)}). It will disappear from the dashboard. This cannot be undone.`,
      accept: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/activity/segment/${seg.id}`, { method: "DELETE" });
      recent = recent.filter((s) => s.id !== seg.id);
      await afterChange(null);
      toast("Session deleted");
    } catch (e) {
      toast(e.message || "Could not delete", "error");
    }
  }

  /* ---------- wiring ---------- */

  function setView(next) {
    view = next;
    $("historyTabs")
      ?.querySelectorAll(".segment")
      .forEach((b) => {
        const on = b.dataset.view === next;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", String(on));
      });
    render();
  }

  function wire() {
    $("historyTabs")?.addEventListener("click", (e) => {
      const b = e.target.closest(".segment");
      if (b) setView(b.dataset.view);
    });
    $("btnAddSession")?.addEventListener("click", () => openEditor(null));
    $("btnEarlier")?.addEventListener("click", loadEarlier);

    $("historyList")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const host = btn.closest("[data-id]");
      const seg = host && findSegment(Number(host.dataset.id));
      if (!seg) return;
      if (btn.dataset.action === "edit") openEditor(seg);
      if (btn.dataset.action === "delete") deleteSegment(seg);
    });

    $("modePicker")?.addEventListener("click", (e) => {
      const b = e.target.closest(".segment");
      if (!b || !editing) return;
      // Carry the current answer across, so switching mode never loses it.
      const times = readTimes();
      if (b.dataset.value === "duration" && Number.isFinite(times.endMs) && times.endMs > times.startMs) {
        setDurationFields((times.endMs - times.startMs) / 1000);
      } else if (b.dataset.value === "end" && Number.isFinite(times.endMs)) {
        $("fieldEnd").value = toLocalInput(times.endMs);
      }
      setMode(b.dataset.value);
      writeMode(b.dataset.value);
      updatePreview();
    });
    $("kindPicker")?.addEventListener("click", (e) => {
      const b = e.target.closest(".segment");
      if (!b) return;
      setSegmented("kindPicker", b.dataset.value);
      updatePreview();
    });
    $("quickDurations")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-min]");
      if (!b) return;
      setDurationFields(Number(b.dataset.min) * 60);
      updatePreview();
    });
    ["fieldStart", "fieldEnd", "fieldHours", "fieldMinutes"].forEach((id) => $(id)?.addEventListener("input", updatePreview));

    $("sessionForm")?.addEventListener("submit", submitEditor);
    $("btnRevert")?.addEventListener("click", revertEditor);
    $("sessionCancel")?.addEventListener("click", closeEditor);
    $("sessionClose")?.addEventListener("click", closeEditor);
    document.querySelector("#sessionModal .modal-backdrop")?.addEventListener("click", closeEditor);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && editing && $("confirmModal")?.classList.contains("hidden")) closeEditor();
    });
  }

  async function init() {
    if (window.__PAGE__ !== "history") return;
    wire();
    const list = $("historyList");
    if (list) list.innerHTML = `<p class="history-loading">Gathering your sessions…</p>`;
    try {
      const [segs] = await Promise.all([loadRecent(localDayISO(Date.now())), loadLong()]);
      mergeRecent(segs);
      if (new URLSearchParams(location.search).get("view") === "long" || location.hash === "#long") view = "long";
      setView(view);
    } catch (e) {
      if (list) list.innerHTML = "";
      toast(e.message || "Could not load history", "error");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
