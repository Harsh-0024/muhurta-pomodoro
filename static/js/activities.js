// Activities on the clocks: the "● Learning Python ▾" picker above Start on
// Rhythm, Timer and Flow, and the one-time "What do you usually spend focus
// time on?" card.
//
// The server labels each session it saves with what this picker shows
// (app.py api_activity_segment), so the clocks themselves need nothing:
// switching while a clock runs counts from the part that is running now on.
// Focus is the default: a session with no activity is plain Focus, and All
// focus on the dashboard is everything together. Rules: activities.py.
(function () {
  "use strict";

  const STARTERS = ["Work", "Study", "Reading", "Writing", "Coding", "Meditation", "Editing", "Exercise"];
  const INTRO_MAX = 8;
  const PAGE_CLOCK = { home: ["muhurat_timer_session_v1", "rhythm"], timer: ["muhurat_countdown_session_v1", "countdown"], flow: ["muhurat_flow_session_v1", "flow"] };

  let state = null;
  let loading = null;
  const pickers = [];

  function api(path, opts) {
    return fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    });
  }

  function load(force) {
    if (state && !force) return Promise.resolve(state);
    if (!loading) {
      loading = api("/api/activities")
        .then((s) => {
          state = s;
          return s;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  function setState(s) {
    state = s;
    pickers.forEach((p) => p.render());
    document.dispatchEvent(new CustomEvent("muhurta:activities", { detail: s }));
  }

  const current = () => (state && state.current) || (state && state.focus) || { id: "focus", name: "Focus", color: "#c9a962" };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function dot(color) {
    const d = el("span", "act-dot");
    d.style.background = color;
    d.setAttribute("aria-hidden", "true");
    return d;
  }

  // Is this page's clock going (running, paused or waiting)? Then a switch
  // counts from now on, and the picker says so.
  function clockGoing() {
    const entry = PAGE_CLOCK[window.__PAGE__];
    if (!entry) return false;
    let d = null;
    try {
      d = JSON.parse(localStorage.getItem(entry[0]) || "null");
    } catch (_) {}
    if (!d || !d.mode) return false;
    if (entry[1] === "rhythm") return !["idle", "complete"].includes(d.mode);
    return ["running", "paused", "overtime", "ringing"].includes(d.mode);
  }

  async function addActivity(name) {
    name = String(name || "").trim().replace(/\s+/g, " ");
    if (!name) return null;
    const s = await load();
    const same = s.activities.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (same) return same;
    if (["focus", "all focus"].includes(name.toLowerCase())) return s.focus;
    const list = s.all.map((a) => ({ id: a.id, name: a.name, color: a.color, removed: a.removed }));
    // Bringing back one that was taken out of the list keeps its id and sessions.
    const old = list.find((a) => a.removed && a.name.toLowerCase() === name.toLowerCase());
    if (old) old.removed = false;
    else list.push({ name });
    const next = await api("/api/activities", { method: "PUT", body: JSON.stringify({ activities: list }) });
    setState(next);
    return next.activities.find((a) => a.name.toLowerCase() === name.toLowerCase()) || null;
  }

  async function choose(id) {
    const next = await api("/api/activities/current", { method: "PUT", body: JSON.stringify({ id }) });
    setState(next);
    return next;
  }

  /* ------------------------------------------------------------------ */
  /* the picker                                                          */
  /* ------------------------------------------------------------------ */

  function mount(root) {
    root.classList.add("act-picker");
    const pill = el("button", "act-pill");
    pill.type = "button";
    pill.setAttribute("aria-haspopup", "listbox");
    pill.setAttribute("aria-expanded", "false");
    const pillDot = dot(current().color);
    const pillName = el("span", "act-pill-name", current().name);
    const caret = el("span", "act-caret");
    caret.setAttribute("aria-hidden", "true");
    pill.append(pillDot, pillName, caret);

    const menu = el("div", "act-menu hidden");
    const notice = el("p", "act-notice hidden");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    root.append(pill, notice);
    // On a phone the list is a sheet over the whole page (and its tab bar),
    // so it lives at the top level of the page, with a dimmed backdrop.
    const sheet = document.body.classList.contains("is-mobile");
    const backdrop = el("div", "act-backdrop hidden");
    backdrop.setAttribute("aria-hidden", "true");
    if (sheet) document.body.append(backdrop, menu);
    else root.insertBefore(menu, notice);

    let open = false;
    let showMore = false;
    let adding = false;
    let noticeTimer = null;

    function say(text) {
      notice.textContent = text;
      notice.classList.toggle("hidden", !text);
      clearTimeout(noticeTimer);
      if (text) noticeTimer = setTimeout(() => notice.classList.add("hidden"), 6000);
    }

    function row(a, selected, extraCls) {
      const b = el("button", "act-row" + (extraCls ? " " + extraCls : ""));
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) b.classList.add("is-selected");
      b.append(dot(a.color), el("span", "act-row-name", a.name));
      if (a.meta) b.append(el("span", "act-row-meta", a.meta));
      if (selected) b.append(el("span", "act-check"));
      b.addEventListener("click", async () => {
        const was = current().id;
        close();
        if (a.id === was) return;
        try {
          await choose(a.id);
          if (clockGoing()) say(`Now counting as ${a.name}.`);
        } catch (err) {
          say(err.message || "Couldn't switch. Try again.");
        }
      });
      return b;
    }

    function meta(a) {
      if (a.older && a.last_day) {
        const days = Math.round((Date.now() - new Date(a.last_day + "T12:00:00").getTime()) / 86400000);
        return days > 1 ? `${days} days ago` : "";
      }
      return "";
    }

    function renderMenu() {
      menu.replaceChildren();
      const s = state;
      if (!s) return;
      const going = clockGoing();
      menu.append(el("p", "act-menu-title", going ? "Switch what this counts as" : "What are you working on?"));
      const list = el("div", "act-list");
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "Activity");
      const cur = current().id;
      list.append(row(s.focus, cur === "focus" || !s.current));
      const main = s.activities.filter((a) => a.group === "main");
      const more = s.activities.filter((a) => a.group === "more");
      main.forEach((a) => list.append(row(a, a.id === cur)));
      menu.append(list);
      if (more.length) {
        const toggle = el("button", "act-more", `More (${more.length})`);
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", showMore ? "true" : "false");
        toggle.append(el("span", "act-more-sign", showMore ? "−" : "+"));
        toggle.addEventListener("click", () => {
          showMore = !showMore;
          renderMenu();
          menu.querySelector(".act-more")?.focus();
        });
        menu.append(toggle);
        if (showMore) {
          const extra = el("div", "act-list act-list-more");
          extra.setAttribute("role", "listbox");
          extra.setAttribute("aria-label", "More activities");
          more.forEach((a) => extra.append(row({ ...a, meta: meta(a) }, a.id === cur, "act-row-more")));
          menu.append(extra);
        }
      }
      menu.append(el("div", "act-rule"));
      if (!adding) {
        const add = el("button", "act-add", "Add new…");
        add.type = "button";
        add.addEventListener("click", () => {
          adding = true;
          renderMenu();
          menu.querySelector(".act-input")?.focus();
        });
        menu.append(add);
      } else {
        const form = el("form", "act-add-form");
        const label = el("label", "visually-hidden", "New activity name");
        const input = el("input", "act-input");
        input.id = `actNew-${Math.random().toString(36).slice(2, 8)}`;
        label.htmlFor = input.id;
        input.type = "text";
        input.maxLength = 40;
        input.placeholder = "e.g. Learning Spanish";
        input.autocomplete = "off";
        input.setAttribute("enterkeyhint", "done");
        const ok = el("button", "btn btn-primary act-add-ok", "Add");
        ok.type = "submit";
        form.append(label, input, ok);
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const name = input.value;
          if (!name.trim()) return input.focus();
          ok.disabled = true;
          try {
            const made = await addActivity(name);
            adding = false;
            close();
            if (made && made.id !== current().id) {
              await choose(made.id);
              if (clockGoing()) say(`Now counting as ${made.name}.`);
            }
          } catch (err) {
            ok.disabled = false;
            say(err.message || "Couldn't add it. Try again.");
          }
        });
        menu.append(form);
      }
    }

    function render() {
      const c = current();
      pillDot.style.background = c.color;
      pillName.textContent = c.name;
      pill.setAttribute("aria-label", `Working on: ${c.name}. Change`);
      if (open) renderMenu();
    }

    function setOpen(v) {
      open = v;
      if (!v) {
        showMore = false;
        adding = false;
      }
      menu.classList.toggle("hidden", !v);
      backdrop.classList.toggle("hidden", !v);
      root.classList.toggle("is-open", v);
      pill.setAttribute("aria-expanded", v ? "true" : "false");
      if (v) {
        renderMenu();
        (menu.querySelector(".act-row.is-selected") || menu.querySelector(".act-row"))?.focus();
      }
    }

    function close() {
      if (!open) return;
      setOpen(false);
      pill.focus();
    }

    pill.addEventListener("click", () => {
      if (open) return close();
      load().then(() => setOpen(true)).catch(() => say("Activities couldn't load. Try again."));
    });
    // The path, not contains(): a click inside can redraw the menu, taking
    // its own button out of the page before this runs.
    document.addEventListener("click", (e) => {
      const path = e.composedPath();
      if (open && !path.includes(root) && !path.includes(menu)) setOpen(false);
    });
    const onKeyDown = (e) => {
      if (e.key === "Escape" && open) {
        e.stopPropagation();
        close();
        return;
      }
      if (e.code === "Space" || e.key === " " || e.key === "Enter") e.stopPropagation();
      if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const items = [...menu.querySelectorAll(".act-row, .act-more, .act-add, .act-input")];
        const i = items.indexOf(document.activeElement);
        const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }
    };
    // The clocks start and pause on Space when it comes up; keep that for the
    // clock, not for a picker row that has focus.
    const onKeyUp = (e) => {
      if (e.code === "Space" || e.key === " " || e.key === "Enter") e.stopPropagation();
    };
    for (const node of sheet ? [root, menu] : [root]) {
      node.addEventListener("keydown", onKeyDown);
      node.addEventListener("keyup", onKeyUp);
    }

    const picker = { render };
    pickers.push(picker);
    render();
  }

  /* ------------------------------------------------------------------ */
  /* the first-run card                                                  */
  /* ------------------------------------------------------------------ */

  function intro() {
    if (document.getElementById("activityIntro")) return;
    const picked = new Set(["Work", "Study"]);
    const names = [...STARTERS];

    const modal = el("div", "modal act-intro");
    modal.id = "activityIntro";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "activityIntroTitle");
    const backdrop = el("div", "modal-backdrop");
    backdrop.setAttribute("aria-hidden", "true");
    const sheet = el("div", "modal-sheet act-intro-sheet");
    const kicker = el("p", "modal-kicker", "New");
    const title = el("h2", "modal-title", "What do you usually spend focus time on?");
    title.id = "activityIntroTitle";
    const copy = el("p", "modal-copy");
    copy.append("Pick a few. Each session you start can be tagged with one, so the dashboard shows where your hours go. ");
    copy.append(el("strong", null, "Focus"), " is always there as the default.");
    const chips = el("div", "act-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Activities");
    const form = el("form", "act-add-form act-intro-add");
    const label = el("label", "visually-hidden", "Add your own activity");
    const input = el("input", "act-input");
    input.id = "activityIntroNew";
    label.htmlFor = input.id;
    input.type = "text";
    input.maxLength = 40;
    input.placeholder = "Add your own, e.g. Learning Python";
    input.autocomplete = "off";
    const addBtn = el("button", "btn btn-quiet", "Add");
    addBtn.type = "submit";
    form.append(label, input, addBtn);
    const count = el("p", "act-count");
    const err = el("p", "act-error hidden");
    err.setAttribute("role", "alert");
    const actions = el("div", "modal-actions act-intro-actions");
    const skip = el("button", "btn btn-ghost", "Skip for now");
    skip.type = "button";
    const save = el("button", "btn btn-primary");
    save.type = "button";
    actions.append(skip, save);
    sheet.append(kicker, title, copy, chips, form, count, err, actions);
    modal.append(backdrop, sheet);

    function draw() {
      chips.replaceChildren();
      const full = picked.size >= INTRO_MAX;
      names.forEach((n, i) => {
        const on = picked.has(n);
        const b = el("button", "act-chip" + (on ? " is-on" : ""));
        b.type = "button";
        b.setAttribute("aria-pressed", on ? "true" : "false");
        const mark = el("span", "act-chip-mark");
        mark.setAttribute("aria-hidden", "true");
        b.append(mark, n);
        b.disabled = !on && full;
        b.addEventListener("click", () => {
          if (on) picked.delete(n);
          else if (picked.size < INTRO_MAX) picked.add(n);
          draw();
          chips.querySelectorAll(".act-chip")[i]?.focus();
        });
        chips.append(b);
      });
      count.textContent = full
        ? "That's 8, the most for now. Add more any time from the picker above Start."
        : `${picked.size} of ${INTRO_MAX} picked · plus Focus`;
      count.classList.toggle("is-full", full);
      save.textContent = picked.size ? `Save ${picked.size} ${picked.size === 1 ? "activity" : "activities"}` : "Just use Focus";
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim().replace(/\s+/g, " ").slice(0, 40);
      if (!name) return input.focus();
      if (["focus", "all focus"].includes(name.toLowerCase())) {
        input.value = "";
        return;
      }
      const existing = names.find((n) => n.toLowerCase() === name.toLowerCase());
      if (!existing) names.push(name);
      if (picked.size < INTRO_MAX) picked.add(existing || name);
      input.value = "";
      draw();
    });

    function finish(list) {
      const keep = state ? state.all.map((a) => ({ id: a.id, name: a.name, color: a.color, removed: a.removed })) : [];
      const have = new Set(keep.filter((a) => !a.removed).map((a) => a.name.toLowerCase()));
      list.forEach((n) => {
        if (!have.has(n.toLowerCase())) keep.push({ name: n });
      });
      save.disabled = skip.disabled = true;
      api("/api/activities", { method: "PUT", body: JSON.stringify({ activities: keep, intro_done: true }) })
        .then((s) => {
          setState(s);
          shut();
        })
        .catch((e) => {
          save.disabled = skip.disabled = false;
          err.textContent = e.message || "Couldn't save. Try again.";
          err.classList.remove("hidden");
        });
    }

    function shut() {
      modal.remove();
      document.body.classList.remove("modal-open");
      document.querySelector(".act-pill")?.focus();
    }

    skip.addEventListener("click", () => finish([]));
    save.addEventListener("click", () => finish(names.filter((n) => picked.has(n))));
    modal.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") finish([]);
    });
    modal.addEventListener("keyup", (e) => e.stopPropagation());

    draw();
    document.body.append(modal);
    document.body.classList.add("modal-open");
    chips.querySelector(".act-chip")?.focus();
  }

  function start() {
    const roots = document.querySelectorAll("[data-activity-picker]");
    if (!roots.length) return;
    roots.forEach(mount);
    load()
      .then((s) => {
        pickers.forEach((p) => p.render());
        // Once per account, on a clock page with nothing going on.
        if (!s.intro_done && !clockGoing() && !document.body.classList.contains("modal-open")) intro();
      })
      .catch(() => {});
    // Another window or device changed the list: pick it up on return.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") load(true).then(setState).catch(() => {});
    });
  }

  window.MuhurtaActivities = { load, add: addActivity, choose, current, intro };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
