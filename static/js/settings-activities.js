// Settings → Activities: rename, recolor, add and remove what focus time goes
// to (the list the picker above Start shows; rules in activities.py). A
// removed activity leaves the picker; its sessions keep their name, and it
// can be brought back. Every change saves at once, like the other settings.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let state = null;
  let statusTimer = null;

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function say(text, error) {
    const el = $("activityStatus");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", !!error);
    clearTimeout(statusTimer);
    if (text && !error) statusTimer = setTimeout(() => (el.textContent = ""), 3000);
  }

  const listOf = () => state.all.map((a) => ({ id: a.id, name: a.name, color: a.color, removed: a.removed }));

  async function save(list, message) {
    try {
      state = await api("/api/activities", { method: "PUT", body: JSON.stringify({ activities: list }) });
      render();
      say(message);
      return true;
    } catch (err) {
      say(err.message || "Couldn't save. Try again.", true);
      render();
      return false;
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function render() {
    const ul = $("activityList");
    const removedBox = $("activityRemoved");
    if (!ul || !state) return;
    ul.replaceChildren();

    const focus = el("li", "act-manage-item is-focus");
    const fdot = el("span", "act-dot");
    fdot.style.background = state.focus.color;
    focus.append(fdot, el("span", "act-manage-fixed", "Focus"), el("span", "act-manage-note", "the default · can't be removed"));
    ul.append(focus);

    const live = state.all.filter((a) => !a.removed);
    live.forEach((a) => {
      const li = el("li", "act-manage-item");
      const color = el("input", "act-color");
      color.type = "color";
      color.value = a.color;
      color.setAttribute("aria-label", `Color for ${a.name}`);
      color.addEventListener("change", () => {
        const list = listOf();
        list.find((x) => x.id === a.id).color = color.value;
        save(list, `${a.name} recolored.`);
      });
      const name = el("input", "input act-name");
      name.type = "text";
      name.maxLength = 40;
      name.value = a.name;
      name.setAttribute("aria-label", `Name of ${a.name}`);
      const commit = () => {
        const v = name.value.trim().replace(/\s+/g, " ");
        if (v === a.name) return;
        if (!v) {
          name.value = a.name;
          return;
        }
        const list = listOf();
        list.find((x) => x.id === a.id).name = v;
        save(list, `Renamed to ${v}.`);
      };
      name.addEventListener("change", commit);
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          name.blur();
        } else if (e.key === "Escape") {
          name.value = a.name;
          name.blur();
        }
      });
      const remove = el("button", "btn btn-danger", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${a.name}`);
      remove.addEventListener("click", async () => {
        const ok = window.MuhurataDialog
          ? await window.MuhurataDialog.confirm({
              title: `Remove ${a.name}?`,
              message: "It leaves the picker. Sessions already spent on it keep its name on the dashboard, and you can bring it back here.",
              accept: "Remove",
            })
          : window.confirm(`Remove ${a.name}?`);
        if (!ok) return;
        const list = listOf();
        list.find((x) => x.id === a.id).removed = true;
        save(list, `${a.name} removed.`);
      });
      li.append(color, name, remove);
      ul.append(li);
    });

    const removed = state.all.filter((a) => a.removed);
    if (removedBox) {
      removedBox.replaceChildren();
      removedBox.classList.toggle("hidden", !removed.length);
      if (removed.length) {
        removedBox.append(el("p", "act-removed-title", "Removed"));
        removed.forEach((a) => {
          const row = el("div", "act-removed-item");
          const d = el("span", "act-dot");
          d.style.background = a.color;
          const back = el("button", "btn btn-ghost btn-small", "Bring back");
          back.type = "button";
          back.setAttribute("aria-label", `Bring back ${a.name}`);
          back.addEventListener("click", () => {
            const list = listOf();
            list.find((x) => x.id === a.id).removed = false;
            save(list, `${a.name} is back in the picker.`);
          });
          row.append(d, el("span", "act-removed-name", a.name), back);
          removedBox.append(row);
        });
      }
    }
  }

  async function init() {
    if (!$("activityList")) return;
    $("activityAddForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("activityNew");
      const v = input.value.trim().replace(/\s+/g, " ");
      if (!v || !state) return input.focus();
      const list = listOf();
      const have = list.find((x) => !x.removed && x.name.toLowerCase() === v.toLowerCase());
      if (have || ["focus", "all focus"].includes(v.toLowerCase())) {
        say(`You already have ${have ? have.name : "Focus"}.`, true);
        return input.focus();
      }
      const old = list.find((x) => x.removed && x.name.toLowerCase() === v.toLowerCase());
      if (old) old.removed = false;
      else list.push({ name: v });
      if (await save(list, `${v} added.`)) input.value = "";
    });
    try {
      state = await api("/api/activities");
      render();
    } catch (err) {
      say("Activities couldn't load.", true);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
