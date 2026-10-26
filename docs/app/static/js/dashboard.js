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

  // ── Bell curve: session-length distribution ───────────────────────

  const PRESET_ZONES = [
    { name: "Agaman",   start: 0,  end: 18 },
    { name: "Sparsha",  start: 18, end: 30 },
    { name: "Sthiti",   start: 30, end: 42 },
    { name: "Abhyasi",  start: 42, end: 54 },
    { name: "Tapas",    start: 54, end: 66 },
    { name: "Samadhan", start: 66, end: 78 },
    { name: "Tanmaya",  start: 78, end: 90 },
    { name: "Ekagra",   start: 90, end: Infinity },
  ];

  // Readable step sizes for a time axis, in minutes. Unbounded at the top so a
  // wide range never falls back to cramming 30-minute ticks edge to edge.
  const TIME_STEPS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720];

  function niceTimeStep(raw) {
    for (const step of TIME_STEPS) {
      if (step >= raw) return step;
    }
    return Math.ceil(raw / 720) * 720;
  }

  function nearestTimeStep(raw) {
    return TIME_STEPS.reduce((best, step) =>
      Math.abs(step - raw) < Math.abs(best - raw) ? step : best, TIME_STEPS[0]);
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

    const curve = bc.curve || [];
    const durations = bc.durations || [];
    const xMin = Number(bc.x_min);
    const xMax = Number(bc.x_max);
    const yMax = curve.reduce((m, p) => Math.max(m, p[1]), 0);
    if (curve.length < 2 || !(xMax > xMin) || yMax <= 0) {
      container.innerHTML = '<p class="empty-note">No rhythm data yet.</p>';
      return;
    }

    // The SVG is drawn at real pixel size (1 unit = 1 px) so label sizes and
    // stroke weights stay true no matter how wide the panel gets.
    const W = Math.max(300, Math.round(container.clientWidth || 560));
    const H = Math.max(170, Math.min(Math.round(container.clientHeight || 240), 320));
    const sizeKey = `${W}x${H}:${bc.bout_count}:${xMin}:${xMax}`;
    if (sizeKey === bellLastSize) return;
    bellLastSize = sizeKey;

    container.innerHTML = "";

    const pad = { top: 24, right: 14, bottom: 56, left: 14 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const baseY = pad.top + plotH;
    const span = xMax - xMin;

    const sx = (x) => pad.left + ((x - xMin) / span) * plotW;
    const sy = (y) => baseY - (y / yMax) * plotH;
    const clampLabel = (x, half) => Math.max(pad.left + half, Math.min(x, W - pad.right - half));

    const svg = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      class: "bell-curve-svg",
      role: "img",
      "aria-label": `Session length distribution: most common ${formatMinutes(bc.peak_min)}, typical ${formatMinutes(bc.p25_min)} to ${formatMinutes(bc.p75_min)}, best ${formatMinutes(bc.p95_min)}, from ${bc.bout_count} sessions`,
    });

    svg.innerHTML = `
      <defs>
        <linearGradient id="bellGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#9a7b4f" />
          <stop offset="45%" stop-color="#d4bc7c" />
          <stop offset="100%" stop-color="#9a7b4f" />
        </linearGradient>
        <linearGradient id="bellFillGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#d4bc7c" stop-opacity="0.2" />
          <stop offset="100%" stop-color="#d4bc7c" stop-opacity="0.02" />
        </linearGradient>
      </defs>
    `;

    // Typical range band (p25–p75)
    const p25x = sx(Math.max(xMin, bc.p25_min));
    const p75x = sx(Math.min(xMax, bc.p75_min));
    svg.appendChild(svgEl("rect", {
      x: p25x, y: pad.top, width: Math.max(1, p75x - p25x), height: plotH, class: "bell-range-band",
    }));

    // Curve + fill
    let d = `M ${sx(curve[0][0]).toFixed(2)} ${sy(curve[0][1]).toFixed(2)}`;
    for (let i = 1; i < curve.length; i++) {
      d += ` L ${sx(curve[i][0]).toFixed(2)} ${sy(curve[i][1]).toFixed(2)}`;
    }
    svg.appendChild(svgEl("path", {
      d: `${d} L ${sx(curve[curve.length - 1][0]).toFixed(2)} ${baseY} L ${sx(curve[0][0]).toFixed(2)} ${baseY} Z`,
      fill: "url(#bellFillGrad)",
    }));
    svg.appendChild(svgEl("path", { d, class: "bell-curve-line" }));

    // Peak marker
    const peakX = sx(Math.min(Math.max(bc.peak_min, xMin), xMax));
    svg.appendChild(svgEl("line", {
      x1: peakX, y1: sy(yMax) - 4, x2: peakX, y2: baseY, class: "bell-peak-line",
    }));
    const peakText = `Most often ${formatMinutes(bc.peak_min)}`;
    const peakHalf = estimateTextWidth(peakText, 10.5) / 2;
    const peakLabelX = clampLabel(peakX, peakHalf);
    svg.appendChild(svgEl("text", {
      x: peakLabelX, y: pad.top - 9, class: "bell-peak-label", "text-anchor": "middle",
    }, peakText));

    // Sessions past the right edge of the chart, when the axis was capped
    const clipText = bc.clipped_count > 0
      ? `${bc.clipped_count} longer, up to ${formatMinutes(bc.max_min)}`
      : "";
    const clipLeft = clipText ? W - pad.right - estimateTextWidth(clipText, 9.5) : W;

    // Best (95th percentile) marker. Its label sits beside the peak label when
    // there is room and drops to the row below otherwise, so the marker line is
    // never left unexplained — and the line starts below whatever shares that row.
    const p95x = sx(Math.min(Math.max(bc.p95_min, xMin), xMax));
    const bestText = `Best ${formatMinutes(bc.p95_min)}`;
    const bestHalf = estimateTextWidth(bestText, 9.5) / 2;
    const bestLabelX = clampLabel(p95x, bestHalf);
    const clearOfPeak = Math.abs(bestLabelX - peakLabelX) > peakHalf + bestHalf + 8;
    const clearOfClip = bestLabelX + bestHalf < clipLeft - 8;
    const bestBelow = !clearOfPeak && clearOfClip;
    svg.appendChild(svgEl("line", {
      x1: p95x,
      y1: (bestBelow || p95x > clipLeft - 6) ? pad.top + 20 : pad.top + 4,
      x2: p95x, y2: baseY, class: "bell-p95-line",
    }));
    if (clearOfPeak || bestBelow) {
      svg.appendChild(svgEl("text", {
        x: bestLabelX, y: clearOfPeak ? pad.top - 9 : pad.top + 11,
        class: "bell-p95-label", "text-anchor": "middle",
      }, bestText));
    }

    // Baseline
    svg.appendChild(svgEl("line", {
      x1: pad.left, y1: baseY, x2: W - pad.right, y2: baseY, class: "bell-axis",
    }));

    // X-axis ticks — spacing driven by how much room the panel actually has
    const maxTicks = Math.max(2, Math.floor(plotW / 62));
    const tickStep = niceTimeStep(span / maxTicks);
    for (let t = Math.ceil(xMin / tickStep) * tickStep; t <= xMax + 1e-6; t += tickStep) {
      const tx = sx(t);
      svg.appendChild(svgEl("line", { x1: tx, y1: baseY, x2: tx, y2: baseY + 4, class: "bell-axis-tick" }));
      svg.appendChild(svgEl("text", {
        x: tx, y: baseY + 15, class: "bell-axis-label", "text-anchor": "middle",
      }, formatAxisMinutes(t)));
    }

    // Preset zones below the axis. A name is drawn only where its slice of the
    // axis is genuinely wide enough, and when they get tight the names stagger
    // onto two rows rather than piling on top of each other.
    const visibleZones = PRESET_ZONES
      .map((zone) => {
        const zStart = Math.max(zone.start, xMin);
        const zEnd = Math.min(zone.end === Infinity ? xMax : zone.end, xMax);
        return { zone, zStart, zEnd, width: sx(zEnd) - sx(zStart), mid: (sx(zStart) + sx(zEnd)) / 2 };
      })
      .filter((z) => z.zEnd > z.zStart);

    const fitsSingleRow = visibleZones.every(
      (z) => z.width >= estimateTextWidth(z.zone.name, 9.5) + 8
    );

    visibleZones.forEach((z, i) => {
      if (z.zone.start > xMin && z.zone.start < xMax) {
        svg.appendChild(svgEl("line", {
          x1: sx(z.zone.start), y1: baseY + 21, x2: sx(z.zone.start), y2: baseY + 45, class: "bell-zone-sep",
        }));
      }
      const room = fitsSingleRow ? z.width : z.width * 2;
      if (room < estimateTextWidth(z.zone.name, 9.5) + 8) return;
      const row = fitsSingleRow ? 0 : i % 2;
      svg.appendChild(svgEl("text", {
        x: z.mid, y: baseY + 30 + row * 11, class: "bell-zone-label", "text-anchor": "middle",
      }, z.zone.name));
    });

    if (clipText) {
      svg.appendChild(svgEl("text", {
        x: W - pad.right, y: pad.top + 11, class: "bell-clip-note", "text-anchor": "end",
      }, clipText));
    }

    // Crosshair + read-out dot
    const crosshair = svgEl("line", {
      x1: 0, y1: pad.top, x2: 0, y2: baseY, class: "bell-crosshair", style: "display:none",
    });
    const dot = svgEl("circle", { cx: 0, cy: 0, r: 3.2, class: "bell-curve-dot", style: "display:none" });
    svg.appendChild(crosshair);
    svg.appendChild(dot);

    container.appendChild(svg);

    const tooltip = document.createElement("div");
    tooltip.className = "bell-tooltip hidden";
    tooltip.setAttribute("role", "status");
    tooltip.setAttribute("aria-live", "polite");
    container.appendChild(tooltip);

    // The hover bucket scales with the axis, so it always covers a comparable
    // slice of the chart whether the range is 20 minutes or 4 hours.
    const bucket = Math.max(0.5, nearestTimeStep(span / 20));
    const total = durations.length || 1;

    function readAt(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const ratio = (clientX - rect.left) / rect.width;
      const px = ratio * W;
      if (px < pad.left || px > W - pad.right) return hideRead();

      const dataX = xMin + ((px - pad.left) / plotW) * span;
      const idx = Math.max(0, Math.min(curve.length - 1,
        Math.round(((dataX - xMin) / span) * (curve.length - 1))));
      const cx = sx(curve[idx][0]);
      const cy = sy(curve[idx][1]);

      crosshair.setAttribute("x1", cx);
      crosshair.setAttribute("x2", cx);
      crosshair.setAttribute("y1", cy);
      crosshair.style.display = "";
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      dot.style.display = "";

      const lo = dataX - bucket / 2;
      const hi = dataX + bucket / 2;
      const count = durations.reduce((acc, v) => acc + (v >= lo && v < hi ? 1 : 0), 0);
      const pct = (count / total) * 100;
      const pctText = count === 0 ? "under 1%" : `~${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`;

      const zone = PRESET_ZONES.find((z) => dataX >= z.start && dataX < z.end);
      tooltip.textContent = `${formatMinutes(dataX)} · ${pctText} of sessions${zone ? ` · ${zone.name}` : ""}`;
      tooltip.classList.remove("hidden");

      const cRect = container.getBoundingClientRect();
      const tipW = tooltip.offsetWidth;
      const left = Math.max(4, Math.min(clientX - cRect.left + 12, cRect.width - tipW - 4));
      tooltip.style.left = `${left}px`;
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
      statsEl.innerHTML = `
        <span>Most often <strong>${formatMinutes(bc.peak_min)}</strong></span>
        <span class="bell-stats-sep" aria-hidden="true">·</span>
        <span>Typical <strong>${formatMinutes(bc.p25_min)}–${formatMinutes(bc.p75_min)}</strong></span>
        <span class="bell-stats-sep" aria-hidden="true">·</span>
        <span>Best <strong>${formatMinutes(bc.p95_min)}</strong></span>
        <span class="bell-stats-sep" aria-hidden="true">·</span>
        <span>${bc.bout_count} sessions</span>
      `;
    }

    container.classList.add("bell-curve-enter");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      container.classList.add("bell-curve-visible");
    }));
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
