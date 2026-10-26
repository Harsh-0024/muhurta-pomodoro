// The sign-in page.
//   Sign in:         email + password.
//   Create account:  name, username, email -> emailed code -> password.
//   Forgot password: email -> emailed code -> new password.
// The password and username rules match cloud.py, which checks them again.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const USERNAME_RE = /^[a-z][a-z0-9_.]{2,19}$/;
  const DRAFT_KEY = "muhurata.signup.draft"; // name/username between the code and the password

  let mode = "signin"; // "signin", "new" or "reset"
  let email = "";
  let profile = null; // { first_name, last_name, username } while creating an account

  /* ---------- helpers ---------- */

  async function api(path, body, method) {
    const r = await fetch(path, {
      method: method || "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await r.json();
    } catch (_) {}
    if (!r.ok) {
      const err = new Error((data && data.error) || "Something went wrong. Try again.");
      err.field = data && data.field;
      throw err;
    }
    return data;
  }

  function say(text, tone) {
    const el = $("signinMessage");
    el.hidden = !text;
    el.textContent = text || "";
    el.dataset.tone = tone || "";
  }

  async function busy(button, label, work) {
    const before = button.textContent;
    button.disabled = true;
    button.textContent = label;
    say("");
    try {
      return await work();
    } catch (e) {
      say(e.message, "error");
      if (e.field === "username") flagUsername(currentUsernameInput(), "taken");
      return null;
    } finally {
      button.disabled = false;
      button.textContent = before;
    }
  }

  function saveDraft() {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ email, profile }));
    } catch (_) {}
  }
  function loadDraft() {
    try {
      return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
    } catch (_) {
      return null;
    }
  }
  function clearDraft() {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch (_) {}
  }

  /* ---------- steps ---------- */

  const STEPS = ["stepSignin", "stepDetails", "stepResetEmail", "stepCode", "stepPassword", "stepBrowser", "stepProfile"];
  let providerName = "";

  function copyFor(step) {
    const flow = mode === "reset" ? "Reset password" : "Create account";
    switch (step) {
      case "stepDetails":
        return [`${flow} · step 1 of 3`, "Create your account", "Free. Tell us a little about you to get started.", 1];
      case "stepResetEmail":
        return [`${flow} · step 1 of 3`, "Forgot your password?", "No problem. We'll email you a code, then you can choose a new one.", 1];
      case "stepCode":
        return [`${flow} · step 2 of 3`, "Check your email", `We sent a code to ${email}. It can take a minute.`, 2];
      case "stepPassword":
        return mode === "reset"
          ? [`${flow} · step 3 of 3`, "Choose a new password", "You'll use it with your email to sign in.", 3]
          : [`${flow} · step 3 of 3`, "Choose a password", "Last step. You'll use it with your email to sign in.", 3];
      case "stepBrowser":
        return ["Continue in your browser", `Signing in with ${providerName}`,
          "Your browser opened. Finish signing in there, and this window carries on by itself.", 0];
      case "stepProfile":
        return ["Almost done", "Finish your profile", `Signed in as ${email}. Choose how you appear in the app.`, 0];
      default:
        return ["Free · your own account", "Welcome back",
          "Sign in to pick up where you left off. Your sessions, combinations and settings follow you to every device you sign in on.", 0];
    }
  }

  function show(step) {
    STEPS.forEach((id) => ($(id).hidden = id !== step));
    const [kicker, title, lede, dot] = copyFor(step);
    $("signinKicker").textContent = kicker;
    $("signinTitle").textContent = title;
    $("signinLede").textContent = lede;
    $("signinProgress").hidden = !dot;
    document.querySelectorAll(".signin-dot").forEach((d) => {
      d.classList.toggle("is-done", Number(d.dataset.dot) < dot);
      d.classList.toggle("is-current", Number(d.dataset.dot) === dot);
    });

    if (step === "stepSignin") {
      if (email) $("signinEmail").value = email;
      ($("signinEmail").value ? $("signinPassword") : $("signinEmail")).focus();
    } else if (step === "stepDetails") {
      if (email && !$("signupEmail").value) $("signupEmail").value = email;
      $("firstName").focus();
    } else if (step === "stepResetEmail") {
      $("resetEmail").value = email || $("signinEmail").value.trim();
      $("resetEmail").focus();
    } else if (step === "stepCode") {
      const from = $("signin").dataset.emailFrom;
      $("codeFrom").textContent = from
        ? `It comes from ${from}. Not there? Look in Spam and mark it "Not spam" so the next one arrives in your inbox.`
        : "Not there? Look in your Spam folder.";
      $("signinCode").value = "";
      $("signinCode").focus();
    } else if (step === "stepProfile") {
      $("profileFirstName").focus();
    } else if (step === "stepPassword") {
      $("passwordUsername").value = email; // lets password managers file it under this email
      $("newPasswordLabel").textContent = mode === "reset" ? "New password" : "Password";
      $("btnSavePassword").textContent = mode === "reset" ? "Save new password" : "Create account";
      $("newPassword").value = "";
      $("newPassword2").value = "";
      $("btnCopyPassword").hidden = true;
      renderPassword();
      ($("lateDetails").hidden ? $("newPassword") : $("lateFirstName")).focus();
    }
  }

  /* ---------- username ---------- */

  function currentUsernameInput() {
    return $("lateDetails").hidden ? $("username") : $("lateUsername");
  }

  function flagUsername(input, state, name) {
    const note = $(input.getAttribute("aria-describedby"));
    const msgs = {
      format: "3–20 letters, numbers, _ or . — starting with a letter.",
      checking: "Checking…",
      free: `@${name} is available.`,
      taken: "That username is taken. Try another.",
      bad: "Use 3–20 letters, numbers, _ or ., starting with a letter.",
      unknown: "Couldn't check right now; we'll check again when you continue.",
    };
    note.textContent = msgs[state];
    note.dataset.tone = state === "free" ? "ok" : state === "taken" || state === "bad" ? "error" : "";
    input.setAttribute("aria-invalid", String(state === "taken" || state === "bad"));
  }

  function wireUsername(input) {
    let timer = null;
    let seq = 0;
    input.addEventListener("input", () => {
      const cleaned = input.value.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_.]/g, "");
      if (cleaned !== input.value) input.value = cleaned;
      clearTimeout(timer);
      if (!cleaned) return flagUsername(input, "format");
      if (!USERNAME_RE.test(cleaned)) return flagUsername(input, cleaned.length < 3 ? "format" : "bad");
      flagUsername(input, "checking");
      const mine = ++seq;
      timer = setTimeout(async () => {
        try {
          const r = await fetch(`/api/cloud/username-available?name=${encodeURIComponent(cleaned)}`);
          const data = await r.json();
          if (mine !== seq) return; // typed again since
          if (!r.ok) return flagUsername(input, "unknown");
          flagUsername(input, data.available ? "free" : "taken", cleaned);
        } catch (_) {
          if (mine === seq) flagUsername(input, "unknown");
        }
      }, 400);
    });
  }

  function readProfile(first, last, user) {
    const p = {
      first_name: first.value.trim().replace(/\s+/g, " "),
      last_name: last.value.trim().replace(/\s+/g, " "),
      username: user.value.trim().toLowerCase(),
    };
    if (!p.first_name) {
      say("Enter your first name.", "error");
      first.focus();
      return null;
    }
    if (!USERNAME_RE.test(p.username)) {
      flagUsername(user, "bad");
      say("Choose a username: 3–20 letters, numbers, _ or ., starting with a letter.", "error");
      user.focus();
      return null;
    }
    if (user.getAttribute("aria-invalid") === "true") {
      say("That username is taken. Try another.", "error");
      user.focus();
      return null;
    }
    return p;
  }

  /* ---------- password ---------- */

  function passwordChecks(pw) {
    const lowered = pw.toLowerCase();
    const personal = [profile && profile.username, (email || "").split("@")[0]]
      .filter((part) => part && part.length >= 3)
      .every((part) => !lowered.includes(part.toLowerCase()));
    return {
      length: pw.length >= 8,
      lower: /[a-z]/.test(pw),
      upper: /[A-Z]/.test(pw),
      number: /\d/.test(pw),
      symbol: /[^A-Za-z0-9\s]/.test(pw),
      personal: personal && pw.length > 0,
    };
  }

  // One quiet line under the password: the rules before typing, then only
  // what is still missing, then how strong it is. The same rules as before,
  // without a checklist to read.
  const GUIDE_IDLE = "8 or more characters, with a capital letter, a number and a symbol.";
  const MISSING = {
    length: "more characters",
    lower: "a lowercase letter",
    upper: "a capital letter",
    number: "a number",
    symbol: "a symbol",
  };

  function listWords(items) {
    return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }

  function renderPassword() {
    const pw = $("newPassword").value;
    const checks = passwordChecks(pw);
    const allMet = Object.values(checks).every(Boolean);
    const missing = Object.keys(MISSING).filter((k) => !checks[k]).map((k) => MISSING[k]);
    const guide = $("passwordRules");
    let level = 0;
    let text = GUIDE_IDLE;
    let tone = "";
    if (pw) {
      if (missing.length) {
        level = missing.length >= 3 ? 1 : 2;
        text = `Add ${listWords(missing)}.`;
      } else if (!checks.personal) {
        level = 2;
        text = "Don't use your username or email in it.";
        tone = "error";
      } else if (pw.length >= 16) {
        level = 5;
        text = "Very strong.";
        tone = "ok";
      } else if (pw.length >= 12) {
        level = 4;
        text = "Strong.";
        tone = "ok";
      } else {
        level = 3;
        text = "Good. Longer is even better.";
        tone = "ok";
      }
    }
    $("strengthBar").style.width = `${level * 20}%`;
    $("strengthBar").dataset.level = String(level);
    guide.textContent = text;
    guide.dataset.tone = tone;
    renderMatch();
    return allMet;
  }

  function renderMatch() {
    const a = $("newPassword").value;
    const b = $("newPassword2").value;
    const note = $("matchNote");
    if (!b) {
      note.textContent = "";
      note.dataset.tone = "";
    } else if (a === b) {
      note.textContent = "Passwords match.";
      note.dataset.tone = "ok";
    } else {
      note.textContent = "Passwords don't match yet.";
      note.dataset.tone = "error";
    }
  }

  // A strong password, in the style Apple suggests: three groups of six
  // easy-to-read characters with dashes, e.g. "kdxmfa-Pqrv7e-hwzbtn". About
  // 90 bits of randomness, and it always meets the rules above.
  const LOWER = "abcdefghijkmnpqrstuvwxyz"; // no l or o: easily misread
  const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
  const DIGITS = "23456789"; // no 0 or 1

  function randomIndex(n) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n; // avoid bias
    do crypto.getRandomValues(buf);
    while (buf[0] >= limit);
    return buf[0] % n;
  }

  function suggestPassword() {
    for (;;) {
      const chars = Array.from({ length: 18 }, () => LOWER[randomIndex(LOWER.length)]);
      const upperAt = randomIndex(18);
      let digitAt = randomIndex(18);
      while (digitAt === upperAt) digitAt = randomIndex(18);
      chars[upperAt] = UPPER[randomIndex(UPPER.length)];
      chars[digitAt] = DIGITS[randomIndex(DIGITS.length)];
      const pw = [0, 6, 12].map((i) => chars.slice(i, i + 6).join("")).join("-");
      if (Object.values(passwordChecks(pw)).every(Boolean)) return pw;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Older web views: copy through a hidden text box instead.
      const box = document.createElement("textarea");
      box.value = text;
      box.setAttribute("readonly", "");
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (_) {}
      box.remove();
      return ok;
    }
  }

  function setVisible(input, visible) {
    input.type = visible ? "text" : "password";
    const btn = document.querySelector(`.password-toggle[data-toggle="${input.id}"]`);
    if (btn) {
      btn.textContent = visible ? "Hide" : "Show";
      btn.setAttribute("aria-label", visible ? "Hide password" : "Show password");
    }
  }

  $("btnSuggest").addEventListener("click", () => {
    const pw = suggestPassword();
    $("newPassword").value = pw;
    $("newPassword2").value = pw;
    // Shown, so it can be read or copied into a password manager.
    setVisible($("newPassword"), true);
    setVisible($("newPassword2"), true);
    renderPassword();
    $("btnCopyPassword").hidden = false;
    $("saveHint").open = true; // the moment it's needed: right after a suggestion
    say("Strong password filled in. Copy it into your password manager before you continue.", "ok");
  });

  $("btnCopyPassword").addEventListener("click", async () => {
    const pw = $("newPassword").value;
    if (!pw) return;
    say((await copyText(pw)) ? "Password copied." : "Couldn't copy. Select it and copy it by hand.",
      undefined);
  });

  $("btnCopySite").addEventListener("click", async (ev) => {
    const site = ev.currentTarget.dataset.site;
    say((await copyText(site)) ? "Website copied. Paste it into your password manager." :
      `Couldn't copy. The website is ${site}`, undefined);
  });

  // Typing your own: the Copy button is still handy once there is something to copy.
  $("newPassword").addEventListener("input", () => {
    $("btnCopyPassword").hidden = !$("newPassword").value;
  });

  /* ---------- small comforts ---------- */

  document.querySelectorAll(".password-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.toggle);
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
      btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      input.focus();
    });
  });

  document.querySelectorAll("[data-caps-for]").forEach((note) => {
    const input = $(note.dataset.capsFor);
    const check = (ev) => {
      if (ev.getModifierState) note.hidden = !ev.getModifierState("CapsLock");
    };
    input.addEventListener("keydown", check);
    input.addEventListener("keyup", check);
    input.addEventListener("blur", () => (note.hidden = true));
  });

  wireUsername($("username"));
  wireUsername($("lateUsername"));
  $("newPassword").addEventListener("input", renderPassword);
  $("newPassword2").addEventListener("input", renderMatch);
  $("lateUsername").addEventListener("input", renderPassword);

  /* ---------- sign in ---------- */

  function enterApp(st) {
    if (st && st.signed_in) {
      clearDraft();
      window.location.replace("/");
    }
  }

  $("stepSignin").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    email = $("signinEmail").value.trim();
    const password = $("signinPassword").value;
    if (!email) {
      say("Enter your email.", "error");
      return $("signinEmail").focus();
    }
    if (!password) {
      say("Enter your password.", "error");
      return $("signinPassword").focus();
    }
    // Signing in also fetches the account's data, which can take a moment.
    enterApp(await busy($("btnSignin"), "Signing in…", () => api("/api/cloud/sign-in", { email, password })));
  });

  $("btnCreate").addEventListener("click", () => {
    mode = "new";
    email = $("signinEmail").value.trim();
    say("");
    show("stepDetails");
  });
  $("btnForgot").addEventListener("click", () => {
    mode = "reset";
    email = $("signinEmail").value.trim();
    say("");
    show("stepResetEmail");
  });
  document.querySelectorAll("[data-back]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = "signin";
      say("");
      show("stepSignin");
    })
  );

  /* ---------- create account / reset ---------- */

  async function sendCode(button) {
    const body = mode === "new" ? { email, purpose: "new", ...profile } : { email, purpose: "reset" };
    const sent = await busy(button, "Sending…", () => api("/api/cloud/send-code", body));
    if (sent) {
      saveDraft();
      show("stepCode");
      say("Code sent.", "ok");
    }
    return sent;
  }

  $("stepDetails").addEventListener("submit", (ev) => {
    ev.preventDefault();
    say("");
    const p = readProfile($("firstName"), $("lastName"), $("username"));
    if (!p) return;
    email = $("signupEmail").value.trim();
    if (!email) {
      say("Enter your email.", "error");
      return $("signupEmail").focus();
    }
    profile = p;
    $("lateDetails").hidden = true;
    sendCode($("btnDetails"));
  });

  $("stepResetEmail").addEventListener("submit", (ev) => {
    ev.preventDefault();
    email = $("resetEmail").value.trim();
    if (!email) {
      say("Enter your email.", "error");
      return $("resetEmail").focus();
    }
    profile = null;
    $("lateDetails").hidden = true;
    sendCode($("btnResetSend"));
  });

  $("stepCode").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = $("signinCode").value.replace(/\s+/g, "");
    if (!code) {
      say("Enter the code from the email.", "error");
      return $("signinCode").focus();
    }
    const st = await busy($("btnVerify"), "Checking…", () => api("/api/cloud/verify", { email, code }));
    if (st) {
      show("stepPassword");
      say("Email confirmed.", "ok");
    }
  });
  $("btnResend").addEventListener("click", (ev) => sendCode(ev.currentTarget));
  $("btnCodeBack").addEventListener("click", () => {
    say("");
    show(mode === "reset" ? "stepResetEmail" : "stepDetails");
  });

  $("stepPassword").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    say("");
    if (!$("lateDetails").hidden) {
      const p = readProfile($("lateFirstName"), $("lateLastName"), $("lateUsername"));
      if (!p) return;
      profile = p;
    }
    if (!renderPassword()) {
      say("Your password doesn't meet all the requirements yet.", "error");
      return $("newPassword").focus();
    }
    const password = $("newPassword").value;
    if (password !== $("newPassword2").value) {
      say("The passwords don't match.", "error");
      return $("newPassword2").focus();
    }
    const body = profile ? { password, ...profile } : { password };
    const label = mode === "reset" ? "Saving…" : "Creating your account…";
    const st = await busy($("btnSavePassword"), label, () => api("/api/cloud/set-password", body));
    if (st) return enterApp(st);
    // Someone took the username in the meantime: let it be changed right here.
    if (profile && currentUsernameInput().getAttribute("aria-invalid") === "true" && $("lateDetails").hidden) {
      $("lateFirstName").value = profile.first_name;
      $("lateLastName").value = profile.last_name;
      $("lateUsername").value = profile.username;
      $("lateDetails").hidden = false;
      flagUsername($("lateUsername"), "taken");
      $("lateUsername").focus();
    }
  });

  $("btnCancelPending").addEventListener("click", async (ev) => {
    if (await busy(ev.currentTarget, "…", () => api("/api/cloud/cancel"))) {
      clearDraft();
      email = "";
      profile = null;
      mode = "signin";
      $("signinEmail").value = "";
      show("stepSignin");
    }
  });

  /* ---------- Google / Microsoft ---------- */

  const ICONS = {
    google: '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>',
    azure: '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#F25022" d="M0 0h8.5v8.5H0z"/><path fill="#7FBA00" d="M9.5 0H18v8.5H9.5z"/><path fill="#00A4EF" d="M0 9.5h8.5V18H0z"/><path fill="#FFB900" d="M9.5 9.5H18V18H9.5z"/></svg>',
  };

  let waiting = null; // the poll while the browser sign-in is open
  let stepBeforeBrowser = "stepSignin";

  async function loadProviders() {
    let list = [];
    try {
      const r = await fetch("/api/cloud/providers", { headers: { Accept: "application/json" } });
      list = (await r.json()).providers || [];
    } catch (_) {}
    if (!list.length) return; // email only
    document.querySelectorAll("[data-providers]").forEach((box) => {
      const buttons = box.querySelector(".provider-buttons");
      buttons.replaceChildren();
      list.forEach((p) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-quiet provider-button";
        b.innerHTML = ICONS[p.id] || "";
        b.append(document.createTextNode(`Continue with ${p.name}`));
        b.addEventListener("click", () => startProvider(p, b));
        buttons.append(b);
      });
      box.hidden = false;
    });
  }

  async function startProvider(p, button) {
    const started = await busy(button, "Opening your browser…", () => api("/api/cloud/oauth/start", { provider: p.id }));
    if (!started) return;
    providerName = p.name;
    stepBeforeBrowser = STEPS.find((id) => !$(id).hidden) || "stepSignin";
    if (!started.opened) {
      // Not opened on this computer (a phone, or no default browser):
      // continue in this tab; Google / Microsoft send it back here.
      window.location.href = started.url;
      return;
    }
    $("browserLink").href = started.url;
    show("stepBrowser");
    const until = Date.now() + 10 * 60 * 1000;
    clearInterval(waiting);
    waiting = setInterval(async () => {
      if (Date.now() > until) {
        clearInterval(waiting);
        say("That took too long. Try again.", "error");
        show(stepBeforeBrowser);
        return;
      }
      try {
        const r = await fetch("/api/cloud/status", { cache: "no-store" });
        const st = await r.json();
        if (!st.signed_in) return;
        clearInterval(waiting);
        if (st.profile) return enterApp(st);
        askProfile(st.email, st.suggested_name);
      } catch (_) {}
    }, 1500);
  }

  $("btnBrowserCancel").addEventListener("click", () => {
    clearInterval(waiting);
    say("");
    show(stepBeforeBrowser);
  });

  // A starting username from the name or email: lowercase, allowed
  // characters only, starting with a letter. Checked live like any other.
  function suggestUsername(first, last, mail) {
    const base = [first, last].filter(Boolean).join(".") || (mail || "").split("@")[0];
    let u = base.toLowerCase().normalize("NFKD").replace(/[^a-z0-9_.]/g, "").replace(/^[^a-z]+/, "");
    if (u.length < 3) u = (u + "user").slice(0, 8);
    return u.slice(0, 20);
  }

  function askProfile(mail, suggestedName) {
    email = mail || email;
    const parts = (suggestedName || "").trim().split(/\s+/).filter(Boolean);
    const first = parts[0] || "";
    const last = parts.slice(1).join(" ");
    if (!$("profileFirstName").value) $("profileFirstName").value = first;
    if (!$("profileLastName").value) $("profileLastName").value = last;
    if (!$("profileUsername").value) {
      $("profileUsername").value = suggestUsername(first, last, email);
      $("profileUsername").dispatchEvent(new Event("input")); // live availability check
    }
    say("");
    show("stepProfile");
  }

  wireUsername($("profileUsername"));

  $("stepProfile").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    say("");
    const p = readProfile($("profileFirstName"), $("profileLastName"), $("profileUsername"));
    if (!p) return;
    const st = await busy($("btnProfileSave"), "Saving…", () => api("/api/cloud/profile", p, "PUT"));
    if (st) window.location.replace("/");
  });

  loadProviders();

  /* ---------- start ---------- */

  // Came back after the code but before choosing a password: pick up there.
  const root = $("signin");
  const pendingEmail = root.dataset.pendingEmail;
  if (pendingEmail) {
    email = pendingEmail;
    const draft = loadDraft();
    if (draft && draft.email === pendingEmail && draft.profile) {
      mode = "new";
      profile = draft.profile;
    } else {
      // No details to hand: a reset (the account has them) or a new account
      // whose details were lost when the window closed (ask again).
      mode = root.dataset.pendingProfile ? "reset" : "new";
      $("lateDetails").hidden = Boolean(root.dataset.pendingProfile);
    }
    show("stepPassword");
    $("signinKicker").textContent = "Almost done";
    $("signinLede").textContent = `${pendingEmail} is confirmed. Choose a password to finish.`;
  } else if (root.dataset.needsProfile) {
    // Signed in (Google / Microsoft, or an older account) but no name yet.
    askProfile(root.dataset.signedInEmail, root.dataset.suggestedName);
  } else {
    show("stepSignin");
  }
})();
