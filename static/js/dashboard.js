(function () {
  "use strict";

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const fullDayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  let selectedYear = Number(new URLSearchParams(window.location.search).get("year")) || new Date().getFullYear();
  let currentDashboardData = null;
  const cardStates = {
    streakCard: 0,
    averageCard: 0,
  };

  async function api(path) {
    const r = await fetch(path, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = byId(id);
    if (el) el.textContent = value;
  }

  function parseDay(day) {
    return new Date(`${day}T00:00:00`);
  }

  function formatMinutes(minutes) {
    const n = Math.round(Number(minutes || 0));
    if (n < 60) return `${n}m`;
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function formatDays(n) {
    const count = Number(n || 0);
    return `${count} ${count === 1 ? "day" : "days"}`;
  }

  function formatDayRate(n) {
    const value = Number(n || 0);
    return `${value.toFixed(value >= 10 ? 0 : 1)}/wk`;
  }

  function updateToggleCard(cardId, states) {
    const card = byId(cardId);
    if (!card || !states.length) return;
    const index = cardStates[cardId] % states.length;
    const state = states[index];
    setText(state.labelId, state.label);
    setText(state.valueId, state.value);
    setText(state.noteId, state.note);
    card.setAttribute("aria-label", `${state.label}: ${state.value}. ${state.note}`);
    card.dataset.state = String(index);
    card.dataset.stateCount = String(states.length);
  }

  function cycleToggleCard(cardId, states) {
    if (!states.length) return;
    cardStates[cardId] = (cardStates[cardId] + 1) % states.length;
    updateToggleCard(cardId, states);
  }

  function summaryCardStates(data) {
    const s = data.summary || {};
    const year = data.range?.year || selectedYear;
    const elapsedDays = Number(s.days_elapsed || 0);
    const averageAllDays = elapsedDays ? Number(s.total_focus_minutes || 0) / elapsedDays : 0;
    return {
      streakCard: [
        {
          labelId: "streakLabel",
          valueId: "currentStreak",
          noteId: "longestStreak",
          label: "Current streak",
          value: formatDays(s.current_streak),
          note: `Best this year: ${formatDays(s.longest_streak)}`,
        },
      ],
      averageCard: [
        {
          labelId: "averageLabel",
          valueId: "averageFocus",
          noteId: "averageNote",
          label: "Avg / active day",
          value: formatMinutes(s.average_focus_active_day),
          note: `in ${year}`,
        },
        {
          labelId: "averageLabel",
          valueId: "averageFocus",
          noteId: "averageNote",
          label: "Avg / all days",
          value: formatMinutes(averageAllDays),
          note: `in ${year}`,
        },
      ],
    };
  }

  const heatStops = [
    [207, 227, 197],
    [135, 187, 120],
    [63, 138, 80],
    [20, 83, 52],
  ];

  function levelFor(day, goal) {
    const minutes = Number(day.focus_minutes || 0);
    if (minutes <= 0) return 0;
    if (minutes >= goal) return 4;
    if (minutes >= goal * 0.66) return 3;
    if (minutes >= goal * 0.33) return 2;
    return 1;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function heatColor(ratio) {
    const value = clamp(Number(ratio || 0), 0, 1);
    if (value <= 0) return "";
    const scaled = value * (heatStops.length - 1);
    const index = Math.min(heatStops.length - 2, Math.floor(scaled));
    const local = scaled - index;
    const from = heatStops[index];
    const to = heatStops[index + 1];
    const rgb = from.map((channel, i) => Math.round(channel + (to[i] - channel) * local));
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function renderSummary(data) {
    const s = data.summary || {};
    const goal = Number(data.goal_minutes || 0);
    const year = data.range?.year || selectedYear;
    const states = summaryCardStates(data);
    setText("goalValue", formatMinutes(goal));
    setText("totalFocusLabel", `Focus in ${year}`);
    setText("totalFocus", formatMinutes(s.total_focus_minutes));
    setText("activeDays", `${formatDays(s.active_days)} active`);
    updateToggleCard("streakCard", states.streakCard);
    updateToggleCard("averageCard", states.averageCard);
    setText("consistencyRate", formatDayRate(s.consistency_days_per_week));
    setText("consistencyNote", `${s.active_days || 0} of ${s.days_elapsed || 0} days`);
    setText(
      "heatmapSubtitle",
      `${formatMinutes(s.total_focus_minutes)} across ${formatDays(s.active_days)} in ${year}.`
    );
  }

  function renderYears(data) {
    const list = byId("yearList");
    if (!list) return;
    const years = data.range?.years || [selectedYear];
    const current = Number(data.range?.year || selectedYear);
    list.innerHTML = "";
    years.forEach((year) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `?year=${year}`;
      link.className = "year-filter-item";
      link.textContent = String(year);
      link.setAttribute("aria-label", `Focus activity in ${year}`);
      if (year === current) {
        link.classList.add("is-active");
        link.setAttribute("aria-current", "true");
      }
      link.addEventListener("click", (event) => {
        event.preventDefault();
        if (selectedYear === year) return;
        selectedYear = year;
        const url = new URL(window.location.href);
        url.searchParams.set("year", String(year));
        window.history.pushState({ year }, "", url);
        loadDashboard(year);
      });
      item.appendChild(link);
      list.appendChild(item);
    });
  }

  function tooltipText(day, date) {
    const focus = formatMinutes(day.focus_minutes);
    const rest = formatMinutes(day.rest_minutes);
    const status = Number(day.focus_minutes || 0) > 0 ? `${focus} focus` : "No focus";
    return `${fullDayFormatter.format(date)} · ${status} · ${rest} rest`;
  }

  function showTooltip(event, text) {
    const tip = byId("heatmapTooltip");
    if (!tip) return;
    tip.textContent = text;
    tip.classList.remove("hidden");
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      moveTooltip(event);
      return;
    }
    const panel = document.querySelector(".heatmap-panel");
    const panelRect = panel?.getBoundingClientRect();
    const cellRect = event.currentTarget?.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const x = (cellRect?.left || 0) - (panelRect?.left || 0) + 12;
    const y = (cellRect?.top || 0) - (panelRect?.top || 0) - tipRect.height - 12;
    const maxX = Math.max(0, (panelRect?.width || window.innerWidth) - tipRect.width - 8);
    tip.style.left = `${clamp(x, 8, maxX)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function moveTooltip(event) {
    const tip = byId("heatmapTooltip");
    if (!tip || tip.classList.contains("hidden")) return;
    const panel = document.querySelector(".heatmap-panel");
    const panelRect = panel?.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const x = event.clientX - (panelRect?.left || 0) + 12;
    const y = event.clientY - (panelRect?.top || 0) - tipRect.height - 12;
    const maxX = Math.max(0, (panelRect?.width || window.innerWidth) - tipRect.width - 8);
    tip.style.left = `${clamp(x, 8, maxX)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function hideTooltip() {
    const tip = byId("heatmapTooltip");
    if (!tip) return;
    tip.classList.add("hidden");
  }

  function renderHeatmap(data) {
    const grid = byId("heatmapGrid");
    const months = byId("heatmapMonths");
    if (!grid || !months) return;
    const days = data.days || [];
    const firstDate = days[0] ? parseDay(days[0].day) : new Date();
    const leading = firstDate.getDay();
    const columns = Math.ceil((days.length + leading) / 7);
    const goal = Math.max(1, Number(data.goal_minutes || 1));
    const maxFocus = Math.max(...days.map((day) => Number(day.focus_minutes || 0)), goal);
    grid.setAttribute("aria-label", `Daily focus activity for ${data.range?.year || selectedYear}`);

    grid.innerHTML = "";
    months.innerHTML = "";
    grid.style.setProperty("--heat-cols", String(columns));
    months.style.setProperty("--heat-cols", String(columns));

    for (let i = 0; i < leading; i += 1) {
      const blank = document.createElement("span");
      blank.className = "heat-cell heat-empty";
      blank.setAttribute("aria-hidden", "true");
      grid.appendChild(blank);
    }

    let lastMonth = "";
    days.forEach((day, index) => {
      const date = parseDay(day.day);
      const week = Math.floor((index + leading) / 7) + 1;
      const month = monthNames[date.getMonth()];
      if (month !== lastMonth && (date.getDate() <= 7 || index === 0)) {
        const label = document.createElement("span");
        label.textContent = month;
        label.style.gridColumn = `${week} / span 4`;
        months.appendChild(label);
        lastMonth = month;
      }

      const cell = document.createElement("span");
      const level = levelFor(day, goal);
      cell.className = `heat-cell heat-level-${level} ${level > 0 ? "heat-active" : "heat-inactive"}`;
      cell.dataset.day = day.day;
      if (level > 0) {
        cell.style.background = heatColor(Number(day.focus_minutes || 0) / maxFocus);
        const details = tooltipText(day, date);
        cell.tabIndex = 0;
        cell.setAttribute("aria-label", details);
        cell.addEventListener("mouseenter", (event) => showTooltip(event, details));
        cell.addEventListener("mouseover", (event) => showTooltip(event, details));
        cell.addEventListener("pointerover", (event) => showTooltip(event, details));
        cell.addEventListener("mousemove", moveTooltip);
        cell.addEventListener("mouseleave", hideTooltip);
        cell.addEventListener("pointerleave", hideTooltip);
        cell.addEventListener("click", (event) => showTooltip(event, details));
        cell.addEventListener("focus", (event) => showTooltip(event, details));
        cell.addEventListener("blur", hideTooltip);
      } else {
        cell.setAttribute("aria-hidden", "true");
      }
      grid.appendChild(cell);
    });
  }

  function renderRecent(data) {
    const list = byId("recentList");
    if (!list) return;
    const recent = data.recent_days || [];
    const max = Math.max(...recent.map((d) => Number(d.focus_minutes || 0)), Number(data.goal_minutes || 1));
    list.innerHTML = "";
    recent.forEach((day) => {
      const row = document.createElement("div");
      row.className = "recent-row";
      const width = Math.max(0, Math.min(100, (Number(day.focus_minutes || 0) / max) * 100));
      row.innerHTML = `
        <div class="recent-date">
          <strong>${dayFormatter.format(parseDay(day.day))}</strong>
          <span>${day.goal_met ? "Goal met" : Number(day.focus_minutes || 0) > 0 ? "Focus day" : "No focus"}</span>
        </div>
        <div class="recent-bar" aria-hidden="true"><span style="width: ${width}%"></span></div>
        <div class="recent-minutes">
          <strong>${formatMinutes(day.focus_minutes)}</strong>
          <span>${formatMinutes(day.rest_minutes)} rest</span>
        </div>
      `;
      list.appendChild(row);
    });
  }

  // ── Rhythm profile: the usual sitting, week by week ──────────────


  // Readable step sizes for a time axis, in minutes. Unbounded at the top so a
  // wide range never falls back to cramming 30-minute ticks edge to edge.
  const TIME_STEPS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720];

  function niceTimeStep(raw) {
    for (const step of TIME_STEPS) {
      if (step >= raw) return step;
    }
    return Math.ceil(raw / 720) * 720;
  }

  function formatAxisMinutes(value) {
    const n = Math.round(value);
    if (n < 60) return `${n}m`;
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // Rough advance width for DM Sans; good enough to decide whether a label fits.
  function estimateTextWidth(text, fontSize) {
    return text.length * fontSize * 0.56;
  }

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, String(v)));
    if (text != null) el.textContent = text;
    return el;
  }

  let bellData = null;
  let bellObserver = null;
  let bellLastSize = "";
  let bellFrame = 0;

  function renderBellCurve(data) {
    bellData = data;
    bellLastSize = "";
    drawBellCurve();

    const container = byId("bellCurveContainer");
    if (container && !bellObserver && typeof ResizeObserver !== "undefined") {
      bellObserver = new ResizeObserver(() => {
        cancelAnimationFrame(bellFrame);
        bellFrame = requestAnimationFrame(drawBellCurve);
      });
      bellObserver.observe(container);
    }
  }

  // A calm curve through points [[x, y], ...] (monotone cubic, the same idea
  // as d3's curveMonotoneX): smooth, but it never overshoots, so it can't
  // invent a peak or dip the data doesn't have. Returns path commands without
  // the leading "M", so callers can join pieces.
  function monotoneCurve(pts) {
    const n = pts.length;
    if (n < 3) return pts.map(([x, y], i) => `${i ? "L " : ""}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const dx = [], slope = [];
    for (let i = 0; i < n - 1; i++) {
      dx.push(pts[i + 1][0] - pts[i][0]);
      slope.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
    }
    const tangent = [slope[0]];
    for (let i = 1; i < n - 1; i++) {
      if (slope[i - 1] * slope[i] <= 0) tangent.push(0);
      else {
        const w1 = 2 * dx[i] + dx[i - 1];
        const w2 = dx[i] + 2 * dx[i - 1];
        tangent.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]));
      }
    }
    tangent.push(slope[n - 2]);
    let d = `${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      const c1 = [pts[i][0] + h, pts[i][1] + tangent[i] * h];
      const c2 = [pts[i + 1][0] - h, pts[i + 1][1] - tangent[i + 1] * h];
      d += ` C ${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
    }
    return d;
  }

  // How long someone usually sits, week by week (db.py _compute_sitting_trend).
  // Each point is the middle sitting of the four weeks up to it, so the line
  // moves gradually with effort; the band is the middle half of those sittings.
  // Returns false when there isn't enough to draw yet.
  function drawSittingTrend(container, statsEl, bc) {
    const tr = bellData.sitting_trend;
    const weeks = (tr && tr.weeks) || [];
    const points = weeks.map((w, i) => ({ ...w, i })).filter((w) => w.usual_min != null);
    if (points.length < 2) return false;

    const W = Math.max(300, Math.round(container.clientWidth || 560));
    const H = Math.max(170, Math.min(Math.round(container.clientHeight || 240), 320));
    const sizeKey = `trend:${W}x${H}:${weeks.length}:${tr.usual_min}`;
    if (sizeKey === bellLastSize) return true;
    bellLastSize = sizeKey;
    container.innerHTML = "";

    // Scaled to the usual line, not the band: one unusually wide week would
    // otherwise squeeze the line into the bottom. The band is clipped instead.
    const top = Math.max(Math.max(...points.map((w) => w.usual_min)) * 1.35, (tr.next_min || 0) * 1.15);
    const yStep = niceTimeStep(top / 4);
    const yMax = Math.ceil(top / yStep) * yStep;
    const pad = { top: 18, right: 54, bottom: 26, left: 40 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const baseY = pad.top + plotH;
    const n = weeks.length;
    const sx = (i) => pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const sy = (m) => baseY - (m / yMax) * plotH;

    const weekLabel = (iso) => parseDay(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const svg = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "bell-curve-svg", role: "img",
      "aria-label": `Usual sitting by week: now ${formatMinutes(tr.usual_min)}, from ${weekLabel(weeks[0].start)}`,
    });
    svg.innerHTML = `
      <defs>
        <clipPath id="trendPlot"><rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" /></clipPath>
      </defs>`;

    // Recessive grid and minute labels
    for (let m = yStep; m <= yMax + 1e-6; m += yStep) {
      svg.appendChild(svgEl("line", { x1: pad.left, y1: sy(m), x2: W - pad.right, y2: sy(m), class: "trend-grid" }));
      svg.appendChild(svgEl("text", { x: pad.left - 8, y: sy(m) + 3.5, class: "bell-axis-label", "text-anchor": "end" }, formatAxisMinutes(m)));
    }
    svg.appendChild(svgEl("line", { x1: pad.left, y1: baseY, x2: W - pad.right, y2: baseY, class: "bell-axis" }));

    // Months along the bottom, at the first week of each
    let lastMonth = -1;
    let lastLabelX = -Infinity;
    weeks.forEach((w, i) => {
      const d = parseDay(w.start);
      if (d.getMonth() === lastMonth) return;
      lastMonth = d.getMonth();
      const x = sx(i);
      if (x - lastLabelX < 34) return;
      lastLabelX = x;
      svg.appendChild(svgEl("text", { x, y: baseY + 16, class: "bell-axis-label", "text-anchor": "middle" },
        d.toLocaleDateString(undefined, { month: "short" }).slice(0, 3)));
    });

    // Typical band and the usual line, broken where a stretch has too few sittings
    const runs = [];
    let run = [];
    weeks.forEach((w, i) => {
      if (w.usual_min == null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push({ ...w, i });
    });
    if (run.length) runs.push(run);
    // For the picture only, each week is eased toward its neighbours (a
    // 1-2-1 average), so a single unusual week reads as a soft swell, not a
    // spike. Headline numbers and the hover read-out stay exact.
    const eased = (r, key) => r.map((w, k) => {
      const prev = r[k - 1] ? r[k - 1][key] : w[key];
      const next = r[k + 1] ? r[k + 1][key] : w[key];
      return (prev + 2 * w[key] + next) / 4;
    });
    for (const r of runs) {
      if (r.length > 1) {
        const hi = eased(r, "p75_min");
        const lo = eased(r, "p25_min");
        const mid = eased(r, "usual_min");
        r.forEach((w, k) => { w.drawn = mid[k]; });
        const upper = monotoneCurve(r.map((w, k) => [sx(w.i), sy(hi[k])]));
        const lower = monotoneCurve(r.map((w, k) => [sx(w.i), sy(lo[k])]).reverse());
        svg.appendChild(svgEl("path", { d: `M ${upper} L ${lower} Z`, class: "trend-band", "clip-path": "url(#trendPlot)" }));
        svg.appendChild(svgEl("path", { d: `M ${monotoneCurve(r.map((w, k) => [sx(w.i), sy(mid[k])]))}`, class: "trend-line" }));
      } else {
        svg.appendChild(svgEl("circle", { cx: sx(r[0].i), cy: sy(r[0].usual_min), r: 2.5, class: "trend-point" }));
      }
    }

    // The next small step, faint, labelled on the right
    if (tr.next_min) {
      const y = sy(tr.next_min);
      svg.appendChild(svgEl("line", { x1: pad.left, y1: y, x2: W - pad.right, y2: y, class: "trend-next" }));
      svg.appendChild(svgEl("text", { x: W - pad.right + 6, y: y + 3.5, class: "bell-p95-label" }, `Next ${formatMinutes(tr.next_min)}`));
    }

    // Now: the last point, labelled with the headline value
    const drawnAt = (w) => {
      for (const r of runs) for (const x of r) if (x.i === w.i) return x.drawn ?? x.usual_min;
      return w.usual_min;
    };
    const last = points[points.length - 1];
    svg.appendChild(svgEl("circle", { cx: sx(last.i), cy: sy(drawnAt(last)), r: 3.6, class: "trend-now" }));
    const nowY = sy(drawnAt(last));
    const nextY = tr.next_min ? sy(tr.next_min) : -100;
    if (Math.abs(nowY - nextY) > 12) {
      svg.appendChild(svgEl("text", { x: sx(last.i) + 6, y: nowY + 3.5, class: "bell-peak-label" }, formatMinutes(last.usual_min)));
    }

    // Hover: the nearest week
    const crosshair = svgEl("line", { x1: 0, y1: pad.top, x2: 0, y2: baseY, class: "bell-crosshair", style: "display:none" });
    const dot = svgEl("circle", { cx: 0, cy: 0, r: 3.2, class: "bell-curve-dot", style: "display:none" });
    svg.appendChild(crosshair);
    svg.appendChild(dot);
    container.appendChild(svg);

    const tooltip = document.createElement("div");
    tooltip.className = "bell-tooltip hidden";
    tooltip.setAttribute("role", "status");
    tooltip.setAttribute("aria-live", "polite");
    container.appendChild(tooltip);

    function readAt(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * W;
      if (px < pad.left - 6 || px > W - pad.right + 6) return hideRead();
      const target = points.reduce((best, w) => (Math.abs(sx(w.i) - px) < Math.abs(sx(best.i) - px) ? w : best), points[0]);
      const cx = sx(target.i);
      const cy = sy(drawnAt(target));
      crosshair.setAttribute("x1", cx);
      crosshair.setAttribute("x2", cx);
      crosshair.setAttribute("y1", cy);
      crosshair.style.display = "";
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      dot.style.display = "";
      tooltip.textContent = `Week of ${weekLabel(target.start)} · usually ${formatMinutes(target.usual_min)} · typical ${formatMinutes(target.p25_min)}–${formatMinutes(target.p75_min)}`;
      tooltip.classList.remove("hidden");
      const cRect = container.getBoundingClientRect();
      const tipW = tooltip.offsetWidth;
      tooltip.style.left = `${Math.max(4, Math.min(clientX - cRect.left + 12, cRect.width - tipW - 4))}px`;
      tooltip.style.top = `${Math.max(4, clientY - cRect.top - 34)}px`;
    }
    function hideRead() {
      crosshair.style.display = "none";
      dot.style.display = "none";
      tooltip.classList.add("hidden");
    }
    svg.addEventListener("mousemove", (e) => readAt(e.clientX, e.clientY));
    svg.addEventListener("mouseleave", hideRead);
    svg.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1) readAt(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    svg.addEventListener("touchend", hideRead);

    if (statsEl) {
      const change = tr.change_min;
      const changeText = change == null ? ""
        : Math.abs(change) < 1 ? "about the same as last month"
        : `${formatMinutes(Math.abs(change))} ${change > 0 ? "longer" : "shorter"} than last month`;
      const sep = '<span class="bell-stats-sep" aria-hidden="true">·</span>';
      statsEl.innerHTML = [
        tr.usual_min != null ? `<span>Usually <strong>${formatMinutes(tr.usual_min)}</strong></span>` : "",
        changeText ? `<span>${changeText}</span>` : "",
        tr.next_min ? `<span>Next <strong>${formatMinutes(tr.next_min)}</strong></span>` : "",
        `<span>Best <strong>${formatMinutes(bc.p95_min)}</strong></span>`,
      ].filter(Boolean).join(sep);
    }

    container.classList.add("bell-curve-enter");
    requestAnimationFrame(() => requestAnimationFrame(() => container.classList.add("bell-curve-visible")));
    return true;
  }

  function drawBellCurve() {
    const container = byId("bellCurveContainer");
    const statsEl = byId("bellCurveStats");
    if (!container || !bellData) return;

    const bc = bellData.bell_curve;

    if (!bc) {
      container.innerHTML = '<p class="empty-note">No rhythm data yet.</p>';
      if (statsEl) statsEl.innerHTML = "";
      bellLastSize = "";
      return;
    }

    if (!bc.ready) {
      const required = bc.min_required || 15;
      const done = bc.bout_count || 0;
      const remaining = Math.max(0, required - done);
      container.innerHTML = `<div class="bell-curve-threshold">
        <p class="bell-curve-threshold-count">${done} / ${required}</p>
        <p class="bell-curve-threshold-text">${remaining} more session${remaining !== 1 ? "s" : ""} to reveal your rhythm</p>
      </div>`;
      if (statsEl) statsEl.innerHTML = "";
      bellLastSize = "";
      return;
    }

    if (drawSittingTrend(container, statsEl, bc)) return;

    // Every sitting so far falls in one week: nothing to show as a line yet.
    container.innerHTML = `<div class="bell-curve-threshold">
      <p class="bell-curve-threshold-text">Your usual sitting shows here after a second week of focus.</p>
    </div>`;
    if (statsEl) statsEl.innerHTML = "";
    bellLastSize = "";
  }

  // The "i" beside the title: what the graph shows, in a few words.
  function wireTrendInfo() {
    const button = byId("trendInfoButton");
    const pop = byId("trendInfo");
    if (!button || !pop) return;
    const setOpen = (open) => {
      pop.classList.toggle("hidden", !open);
      button.setAttribute("aria-expanded", open ? "true" : "false");
    };
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(pop.classList.contains("hidden"));
    });
    document.addEventListener("click", (e) => {
      if (!pop.classList.contains("hidden") && !pop.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });
  }

  async function loadDashboard(year) {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      const params = new URLSearchParams({ year: String(year) });
      if (tz) params.set("tz", tz);
      const data = await api(`/api/dashboard?${params.toString()}`);
      currentDashboardData = data;
      selectedYear = Number(data.range?.year || year);
      renderSummary(data);
      renderYears(data);
      renderHeatmap(data);
      renderRecent(data);
      renderBellCurve(data);
    } catch (e) {
      setText("heatmapSubtitle", "Dashboard data could not be loaded.");
      console.error(e);
    }
  }

  async function init() {
    if (window.__PAGE__ !== "dashboard") return;
    wireTrendInfo();
    ["streakCard", "averageCard"].forEach((cardId) => {
      const card = byId(cardId);
      if (!card) return;
      const activate = () => {
        if (!currentDashboardData) return;
        cycleToggleCard(cardId, summaryCardStates(currentDashboardData)[cardId] || []);
      };
      card.addEventListener("click", activate);
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activate();
      });
    });
    window.addEventListener("popstate", () => {
      selectedYear = Number(new URLSearchParams(window.location.search).get("year")) || new Date().getFullYear();
      loadDashboard(selectedYear);
    });
    loadDashboard(selectedYear);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
