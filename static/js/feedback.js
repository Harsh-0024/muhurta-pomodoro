// Settings -> Feedback: send the maker what you like, what you don't, what
// could be better, or an idea, and see what you've sent and whether it was read.
// Talks to /api/feedback (app.py on the computer, account.js on the phone).
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const KINDS = {
    like: { label: "Like", hint: "What do you enjoy? It helps to know what to keep." },
    dislike: { label: "Don't like", hint: "What gets in your way or annoys you?" },
    improve: { label: "Could be better", hint: "What could work better, and how?" },
    idea: { label: "Idea", hint: "What would you like Muhurta Pomodoro to do?" },
  };
  const STATES = { new: "Sent", seen: "Read", done: "Done" };
  const MAX = 2000;
  const NOTE = "Sent with your name and email, so you can be answered.";

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return `Today, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    }
    const opts = { day: "numeric", month: "short" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  async function api(path, opts) {
    const r = await fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }

  function renderSent(items) {
    const wrap = $("feedbackSentWrap");
    const list = $("feedbackSent");
    if (!wrap || !list) return;
    list.replaceChildren();
    wrap.hidden = !items.length;
    items.forEach((item) => {
      const row = el("div", "pref-row feedback-item");
      const text = el("div", "pref-text");
      text.append(el("span", "feedback-item-msg", item.message));
      text.append(el("span", "pref-desc", [KINDS[item.kind]?.label, when(item.created_at)].filter(Boolean).join(" · ")));
      const state = el("span", "feedback-state", STATES[item.status] || "Sent");
      state.dataset.state = item.status || "new";
      row.append(text, state);
      list.append(row);
    });
  }

  function setup() {
    const form = $("feedbackForm");
    if (!form) return;
    const group = $("feedbackKind");
    const buttons = [...group.querySelectorAll(".segment")];
    const text = $("feedbackMessage");
    const send = $("btnSendFeedback");
    const status = $("feedbackStatus");
    let kind = "idea";
    let sent = [];

    const pick = (value) => {
      kind = KINDS[value] ? value : "idea";
      buttons.forEach((b) => {
        const on = b.dataset.value === kind;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
      text.placeholder = KINDS[kind].hint;
    };
    buttons.forEach((b, i) => {
      b.addEventListener("click", () => {
        pick(b.dataset.value);
        text.focus();
      });
      b.addEventListener("keydown", (e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const next = buttons[(i + step + buttons.length) % buttons.length];
        next.focus();
        pick(next.dataset.value);
      });
    });

    const update = () => {
      const len = text.value.length;
      send.disabled = !text.value.trim();
      if (status.dataset.tone) return;  // keep a result on screen until they type again
      status.textContent = len > MAX * 0.8 ? `${MAX - len} characters left` : NOTE;
    };
    text.addEventListener("input", () => {
      delete status.dataset.tone;
      update();
    });

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const message = text.value.trim();
      if (!message) return;
      send.disabled = true;
      send.textContent = "Sending…";
      try {
        const item = await api("/api/feedback", { method: "POST", body: JSON.stringify({ kind, message }) });
        text.value = "";
        status.textContent = "Thank you. It went straight to the maker.";
        status.dataset.tone = "ok";
        sent = [item, ...sent];
        renderSent(sent);
      } catch (e) {
        status.textContent = e.message;
        status.dataset.tone = "error";
      } finally {
        send.textContent = "Send";
        update();
      }
    });

    pick("idea");
    update();
    api("/api/feedback")
      .then((data) => {
        sent = data.items || [];
        renderSent(sent);
      })
      .catch(() => {});  // offline or not set up: the form still says so when used
  }

  document.addEventListener("DOMContentLoaded", setup);
})();
