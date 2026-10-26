from __future__ import annotations

import os
import re
import json
import sys
import time
import random
import sqlite3
import threading
import urllib.error
import urllib.request
import webbrowser
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, redirect, render_template, request, url_for

import cloud
import db
import presence
import release_notes
import sync
from presets import BUILTINS
from version import __version__

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

BASE_DIR = Path(__file__).resolve().parent
ASSET_VERSION_PATHS = (
    BASE_DIR / "static" / "js" / "app.js",
    BASE_DIR / "static" / "js" / "flow.js",
    BASE_DIR / "static" / "js" / "session-monitor.js",
    BASE_DIR / "static" / "js" / "dashboard.js",
    BASE_DIR / "static" / "js" / "settings.js",
    BASE_DIR / "static" / "js" / "history.js",
    BASE_DIR / "static" / "js" / "sounds.js",
    BASE_DIR / "static" / "js" / "dialog.js",
    BASE_DIR / "static" / "js" / "shortcuts.js",
    BASE_DIR / "static" / "js" / "alive.js",
    BASE_DIR / "static" / "js" / "sign-in.js",
    BASE_DIR / "static" / "js" / "admin.js",
    BASE_DIR / "static" / "js" / "feedback.js",
    BASE_DIR / "static" / "css" / "app.css",
)
BUILTIN_QUOTES = [
    {"quote": "You have power over your mind, not outside events. Realize this, and you will find strength.", "author": "Marcus Aurelius"},
    {"quote": "The successful warrior is the average man, with laser-like focus.", "author": "Bruce Lee"},
    {"quote": "Concentrate all your thoughts upon the work in hand.", "author": "Alexander Graham Bell"},
]
QUOTE_FILES = (
    BASE_DIR / "quotes.json",
    BASE_DIR / "data" / "quotes.json",
    BASE_DIR / "static" / "quotes.json",
    BASE_DIR / "static" / "js" / "quotes.js",
)


@app.context_processor
def inject_asset_version():
    try:
        version = int(max(path.stat().st_mtime for path in ASSET_VERSION_PATHS if path.exists()))
    except ValueError:
        version = 1
    return {"asset_version": version, "app_version": __version__}


def _normalize_quote(item: dict) -> dict | None:
    quote = str(item.get("quote") or item.get("q") or "").strip()
    author = str(item.get("author") or item.get("a") or "").strip()
    if not quote or not author:
        return None
    return {"quote": quote, "author": author}


def _read_quote_file(path: Path) -> list[dict]:
    raw = path.read_text(encoding="utf-8")
    if path.suffix == ".js":
        match = re.search(r"const\s+FALLBACK_QUOTES\s*=\s*(\[.*\])\s*;?\s*$", raw, re.DOTALL)
        if not match:
            return []
        raw = match.group(1)
        raw = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', raw)
        raw = re.sub(r",\s*([}\]])", r"\1", raw)
    data = json.loads(raw)
    if not isinstance(data, list):
        return []
    return [quote for item in data if isinstance(item, dict) and (quote := _normalize_quote(item))]


def _load_offline_quotes() -> list[dict]:
    for path in QUOTE_FILES:
        if not path.exists():
            continue
        try:
            quotes = _read_quote_file(path)
        except (OSError, json.JSONDecodeError):
            continue
        if quotes:
            return quotes
    return BUILTIN_QUOTES


FALLBACK_QUOTES = _load_offline_quotes()
INITIAL_QUOTE = random.choice(FALLBACK_QUOTES)
SOUND_CHOICES = {
    "soothing-bell",
    "opening-bells",
}
SOUND_SETTING_KEYS = (
    "manual_sound_rest_end",
    "manual_sound_work_begin",
    "manual_sound_work_end",
    "manual_sound_action",
    "sound_rest_end",
    "sound_work_begin",
    "sound_work_end",
    "sound_action",
)


@app.before_request
def _ensure_db():
    db.init_db()


# What works before signing in: the sign-in page and what it needs, plus
# the launcher's and updater's own checks.
OPEN_ENDPOINTS = {
    "static", "sign_in_page", "api_cloud_status", "api_cloud_sign_in", "api_cloud_send_code",
    "api_cloud_verify", "api_cloud_set_password", "api_cloud_cancel", "api_cloud_username_available",
    "api_alive", "api_version", "api_update_restart", "api_update_progress", "api_window_show",
    "api_cloud_providers", "api_cloud_oauth_start", "auth_callback",
}


@app.before_request
def _require_sign_in():
    """The app is free, but it is used signed in: everything else waits for it."""
    if not cloud.configured() or request.endpoint in OPEN_ENDPOINTS or cloud.status()["signed_in"]:
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "Please sign in first."}), 401, {"X-Signed-Out": "1"}
    return redirect(url_for("sign_in_page"))


@app.context_processor
def _inject_account():
    st = cloud.status()
    if not st["signed_in"]:
        return {"account": None}
    profile = st["profile"] or {}
    name = profile.get("first_name") or (st["email"] or "").split("@")[0]
    return {"account": {"name": name, "initial": (name or "?")[0].upper(), "is_admin": st["is_admin"],
                        "title": f"@{profile['username']} · {st['email']}" if profile else st["email"]}}


@app.context_processor
def _inject_mobile():
    # The Android app's pages are built from these templates with mobile=True
    # (mobile/build_web.py); this lets the dev server show that layout too.
    return {"mobile": os.environ.get("MUHURATA_MOBILE_PREVIEW") == "1"}


@app.context_processor
def _inject_theme():
    theme = db.load_settings().get("theme", "system")
    if theme not in ("light", "dark", "system"):
        theme = "system"
    return {"theme": theme}


def _builtin_public(b: dict) -> dict:
    total = b.get("cycle_min") or (b.get("total_work_min", 0) + b.get("total_rest_min", 0))
    focus = round(100 * b.get("total_work_min", 0) / total, 1) if total else 0
    return {
        **b,
        "kind": "builtin",
        "focus_ratio_pct": focus,
    }


def _custom_public(row: dict) -> dict:
    w, s, l = row["work_min"], row["short_rest_min"], row["long_rest_min"]
    tw = 4 * w
    tr = 3 * s + l
    total = tw + tr
    fr = round(100 * tw / total, 2) if total else 0.0
    return {
        "id": f"custom-{row['id']}",
        "kind": "custom",
        "name": row["name"],
        "subtitle": "Your rhythm",
        "work_min": w,
        "short_rest_min": s,
        "long_rest_min": l,
        "total_work_min": tw,
        "total_rest_min": tr,
        "cycle_min": total,
        "focus_ratio_pct": fr,
        "created_at": row["created_at"],
    }


def _preset_exists(preset_id: str) -> bool:
    if preset_id.startswith("builtin-"):
        return any(b["id"] == preset_id for b in BUILTINS)
    m = re.fullmatch(r"custom-(\d+)", preset_id or "")
    if not m:
        return False
    pid = int(m.group(1))
    conn = sqlite3.connect(db.DB_PATH)
    try:
        row = conn.execute(
            "SELECT 1 FROM custom_presets WHERE id = ?", (pid,)
        ).fetchone()
        return row is not None
    finally:
        conn.close()


@app.route("/")
def index():
    return render_template("index.html", initial_quote=INITIAL_QUOTE)


@app.route("/sign-in")
def sign_in_page():
    st = cloud.status()
    # Signed in with a name: nothing to do here. Signed in without one (new
    # from Google / Microsoft): stay, to finish the profile.
    if not st["configured"] or (st["signed_in"] and st["profile"]):
        return redirect(url_for("index"))
    # Stopped after the code, before choosing a password: carry on from there.
    return render_template("sign_in.html", bare=True,
                           pending_email=st["email"] if st["password_pending"] else "",
                           pending_has_profile=bool(st["profile"]), email_from=cloud.EMAIL_FROM,
                           password_site=cloud.PASSWORD_SITE,
                           needs_profile=st["signed_in"] and not st["profile"],
                           signed_in_email=st["email"] if st["signed_in"] else "",
                           suggested_name=st.get("suggested_name") or "")


@app.route("/timer")
def timer_page():
    return render_template("timer.html", initial_quote=INITIAL_QUOTE)


def _admin_only():
    """The Admin tab exists only for admins. The server checks again on every
    data request, so this only hides the page from everyone else."""
    if not cloud.status()["is_admin"]:
        return jsonify({"error": "Not found"}), 404
    return None


@app.route("/admin")
def admin_page():
    if not cloud.status()["is_admin"]:
        return redirect(url_for("index"))
    return render_template("admin.html", app_latest=_update_info().get("latest"))


@app.get("/api/admin/overview")
def api_admin_overview():
    blocked = _admin_only()
    if blocked:
        return blocked
    try:
        data = cloud.admin_overview()
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    data["latest"] = _update_info().get("latest")
    data["this_version"] = __version__
    return jsonify(data)


@app.put("/api/admin/rules")
def api_admin_rules():
    blocked = _admin_only()
    if blocked:
        return blocked
    body = request.get_json(silent=True) or {}
    try:
        rules = cloud.save_update_rules(str(body.get("minimum_version") or ""), body.get("blocked_versions") or [],
                                        str(body.get("message") or ""))
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    _update_info(force=True)  # this copy follows the new rules straight away
    return jsonify(rules)


@app.get("/api/feedback")
def api_feedback_mine():
    try:
        return jsonify({"items": cloud.my_feedback()})
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status


@app.post("/api/feedback")
def api_feedback_send():
    body = request.get_json(silent=True) or {}
    try:
        item = cloud.send_feedback(str(body.get("kind") or ""), str(body.get("message") or ""),
                                   __version__, sys.platform)
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    return jsonify(item), 201


@app.get("/api/admin/feedback")
def api_admin_feedback():
    blocked = _admin_only()
    if blocked:
        return blocked
    try:
        items = cloud.admin_feedback()
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    # Shown once as new; from now on the sender sees it was read.
    try:
        cloud.admin_mark_feedback_seen([i["id"] for i in items if i.get("status") == "new"])
    except cloud.CloudError:
        pass
    return jsonify({"items": items})


@app.patch("/api/admin/feedback/<int:feedback_id>")
def api_admin_feedback_status(feedback_id: int):
    blocked = _admin_only()
    if blocked:
        return blocked
    body = request.get_json(silent=True) or {}
    try:
        cloud.admin_set_feedback_status(feedback_id, str(body.get("status") or ""))
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    return jsonify({"id": feedback_id, "status": body.get("status")})


@app.delete("/api/admin/feedback/<int:feedback_id>")
def api_admin_feedback_delete(feedback_id: int):
    blocked = _admin_only()
    if blocked:
        return blocked
    try:
        cloud.admin_delete_feedback(feedback_id)
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    return "", 204


@app.route("/flow")
def flow_page():
    return render_template("flow.html", initial_quote=INITIAL_QUOTE)


@app.route("/settings")
def settings_page():
    return render_template("settings.html", password_site=cloud.PASSWORD_SITE)


@app.route("/settings/history")
def history_page():
    return render_template("history.html")


@app.route("/dashboard")
def dashboard_page():
    return render_template("dashboard.html")


@app.get("/api/presets")
def api_presets():
    custom = [_custom_public(r) for r in db.list_custom_presets()]
    builtins = [_builtin_public(b) for b in BUILTINS]
    return jsonify({"builtins": builtins, "custom": custom})


def _parse_preset_body(data: dict):
    """(name, work, short, long), or an error message."""
    name = str(data.get("name") or "").strip()
    try:
        w = int(data.get("work_min"))
        s = int(data.get("short_rest_min"))
        l = int(data.get("long_rest_min"))
    except (TypeError, ValueError):
        return "Invalid durations"
    if not name or len(name) > 80:
        return "Name must be 1–80 characters"
    if not (1 <= w <= 180 and 1 <= s <= 60 and 1 <= l <= 120):
        return "Durations out of allowed range"
    return name, w, s, l


@app.post("/api/presets")
def api_create_preset():
    parsed = _parse_preset_body(request.get_json(silent=True) or {})
    if isinstance(parsed, str):
        return jsonify({"error": parsed}), 400
    row = db.create_custom_preset(*parsed)
    return jsonify(_custom_public(row)), 201


@app.put("/api/presets/<int:preset_id>")
def api_update_preset(preset_id: int):
    parsed = _parse_preset_body(request.get_json(silent=True) or {})
    if isinstance(parsed, str):
        return jsonify({"error": parsed}), 400
    row = db.update_custom_preset(preset_id, *parsed)
    if row is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(_custom_public(row))


@app.delete("/api/presets/<int:preset_id>")
def api_delete_preset(preset_id: int):
    if not db.delete_custom_preset(preset_id):
        return jsonify({"error": "Not found"}), 404
    settings = db.load_settings()
    if settings.get("default_preset_id") == f"custom-{preset_id}":
        db.save_settings({"default_preset_id": "builtin-shishya"})
    return "", 204


@app.get("/api/settings")
def api_get_settings():
    return jsonify(db.load_settings())


@app.post("/api/settings/reset")
def api_reset_settings():
    return jsonify(db.reset_settings())


SEGMENT_CLOCK_SLACK_SEC = 5


def _cloud_call(fn, *args):
    try:
        return jsonify(fn(*args))
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status


@app.after_request
def _sync_after_change(response):
    # Any saved change (a session, an edit, a preset, a setting) syncs a few
    # seconds later. Cheap when signed out: the sync thread just looks and stops.
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.path.startswith("/api/") \
            and not request.path.startswith(("/api/cloud/", "/api/alive")) and response.status_code < 400:
        sync.nudge()
    return response


@app.post("/api/alive")
def api_alive():
    """A window checking in, or saying goodbye (see presence.py)."""
    page = str(request.args.get("page") or "")[:64]
    if page:
        if request.args.get("event") == "closed":
            presence.closed(page)
        else:
            presence.checked_in(page)
    return "", 204


@app.post("/api/window/show")
def api_window_show():
    """Starting the app again while it runs brings its own window forward (run.py)."""
    show = app.config.get("MUHURATA_SHOW_WINDOW")
    # A web page elsewhere can't send this header without asking first (a CORS
    # preflight this server never grants), so only the app itself gets here.
    if not show or request.headers.get("X-Muhurta") != "1":
        return "", 404
    show()
    return "", 204


def _cloud_status() -> dict:
    st = cloud.status()
    st["sync"] = sync.status() if st["signed_in"] else None
    return st


@app.get("/api/cloud/status")
def api_cloud_status():
    return jsonify(_cloud_status())


@app.post("/api/cloud/sync-now")
def api_cloud_sync_now():
    sync.run_once()
    return jsonify(_cloud_status())


@app.post("/api/cloud/sign-in")
def api_cloud_sign_in():
    body = request.get_json(silent=True) or {}
    try:
        cloud.sign_in_password(str(body.get("email") or ""), str(body.get("password") or ""))
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    # Fetch the account's data now, so the timer opens with it.
    sync.enter_account()
    return jsonify(_cloud_status())


@app.get("/api/cloud/providers")
def api_cloud_providers():
    """Which "Continue with ..." buttons to show: only providers switched on
    in Supabase."""
    return jsonify({"providers": cloud.providers()})


@app.post("/api/cloud/oauth/start")
def api_cloud_oauth_start():
    """Open Google / Microsoft sign-in in the person's own browser, where
    their saved passwords and passkeys work. The browser comes back to
    /auth/callback on this app's own address."""
    body = request.get_json(silent=True) or {}
    try:
        url = cloud.oauth_start(str(body.get("provider") or ""), request.host_url + "auth/callback")
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    opened = False
    # Opening a browser only makes sense on this computer. From a phone on
    # the same Wi-Fi the page carries on in its own tab instead.
    on_this_computer = request.remote_addr in ("127.0.0.1", "::1")
    if on_this_computer and not os.environ.get("MUHURATA_NO_BROWSER_OPEN"):  # tests
        try:
            opened = webbrowser.open(url)
        except Exception:
            opened = False
    return jsonify({"url": url, "opened": opened})


@app.get("/auth/callback")
def auth_callback():
    """Where the browser lands after Google / Microsoft. Finishes signing in;
    the app's own window notices and carries on by itself."""
    if request.args.get("error"):
        message = request.args.get("error_description") or "The sign-in was cancelled."
        return render_template("auth_done.html", bare=True, ok=False, message=message[:200])
    try:
        cloud.oauth_finish(str(request.args.get("code") or ""))
    except cloud.CloudError as exc:
        return render_template("auth_done.html", bare=True, ok=False, message=str(exc))
    sync.enter_account()  # fetch the account's data now, like a password sign-in
    return render_template("auth_done.html", bare=True, ok=True, message="")


@app.post("/api/cloud/send-code")
def api_cloud_send_code():
    """A code to create an account, or (reset) to choose a new password."""
    body = request.get_json(silent=True) or {}
    new_account = body.get("purpose") != "reset"
    try:
        if new_account:
            # Check the details before emailing, so a mistake shows now and
            # not after the code.
            profile = _profile_from(body)
            if not cloud.username_available(profile["username"]):
                return jsonify({"error": "That username is taken. Choose another.", "field": "username"}), 409
        cloud.send_code(str(body.get("email") or ""), new_account)
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    return jsonify({"sent": True})


def _profile_from(body: dict) -> dict:
    return cloud.clean_profile(str(body.get("first_name") or ""), str(body.get("last_name") or ""),
                               str(body.get("username") or ""))


@app.get("/api/cloud/username-available")
def api_cloud_username_available():
    name = str(request.args.get("name") or "")
    try:
        return jsonify({"available": cloud.username_available(name)})
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status


@app.put("/api/cloud/profile")
def api_cloud_profile():
    body = request.get_json(silent=True) or {}
    return _cloud_call(cloud.update_profile, str(body.get("first_name") or ""), str(body.get("last_name") or ""),
                       str(body.get("username") or ""))


@app.post("/api/cloud/verify")
def api_cloud_verify():
    body = request.get_json(silent=True) or {}
    return _cloud_call(cloud.verify_code, str(body.get("email") or ""), str(body.get("code") or ""))


@app.post("/api/cloud/set-password")
def api_cloud_set_password():
    body = request.get_json(silent=True) or {}
    try:
        # A new account brings its name and username; a password reset doesn't.
        profile = _profile_from(body) if body.get("username") else None
        cloud.set_password(str(body.get("password") or ""), profile)
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status
    sync.enter_account()
    return jsonify(_cloud_status())


@app.post("/api/cloud/cancel")
def api_cloud_cancel():
    return _cloud_call(cloud.cancel_pending)


@app.post("/api/cloud/sign-out")
def api_cloud_sign_out():
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(sync.leave_account(force=bool(body.get("force"))))
    except sync.UnsyncedChanges as exc:
        return jsonify({"error": str(exc), "pending": exc.pending}), exc.status
    except cloud.CloudError as exc:
        return jsonify({"error": str(exc)}), exc.status


@app.get("/api/quote")
def api_quote():
    fallback = random.choice(FALLBACK_QUOTES)
    try:
        req = urllib.request.Request(
            "https://zenquotes.io/api/random",
            headers={"User-Agent": "MuhurataTimer/1.0"},
        )
        with urllib.request.urlopen(req, timeout=4, context=cloud._SSL) as res:
            payload = res.read().decode("utf-8")
        data = json.loads(payload)
        item = data[0] if isinstance(data, list) and data else {}
        quote = str(item.get("q") or "").strip()
        author = str(item.get("a") or "").strip()
        if quote and author:
            return jsonify({"quote": quote, "author": author, "source": "zenquotes"})
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, TypeError):
        pass
    return jsonify({**fallback, "source": "fallback"})


# Every copy checks, because an install only updates when it starts and the
# app can stay open for days. Where run.py can update in place (a git install,
# or the Mac app) it sets RESTART_KEY; other downloads link to the website.
IS_BUNDLED = getattr(sys, "frozen", False)
RESTART_KEY = "MUHURATA_RESTART"
RELEASES_API = os.environ.get("MUHURATA_RELEASES_API",
                              "https://api.github.com/repos/Harsh-0024/muhurta-pomodoro/releases/latest")
# The owner's say over old versions (docs/update-policy.json, on the website):
# a minimum version, versions that may no longer be used, and a message.
# Older or blocked copies must update before they can be used again.
UPDATE_POLICY_URL = os.environ.get("MUHURATA_UPDATE_POLICY_URL",
                                   "https://harsh-0024.github.io/muhurta-pomodoro/update-policy.json")
# The download page picks the right file for the computer and shows the steps.
DOWNLOAD_PAGE = "https://harsh-0024.github.io/muhurta-pomodoro/download.html"
UPDATE_CHECK_INTERVAL = 60 * 60  # hourly; GitHub allows 60 unsigned requests an hour
UPDATE_RETRY_INTERVAL = 10 * 60  # after a failed check, try again this soon
_update_lock = threading.Lock()


def _version_tuple(text: str):
    return tuple(int(part) for part in re.findall(r"\d+", str(text or ""))[:3])


def _fetch_json(url: str, headers: dict | None = None):
    """GET a JSON document over HTTPS, with the app's own list of trusted
    certificates: a built app has no system list to fall back on, and
    without this every check failed silently (versions up to 1.7.0)."""
    req = urllib.request.Request(url, headers={"User-Agent": "MuhurataTimer", **(headers or {})})
    with urllib.request.urlopen(req, timeout=5, context=cloud._SSL) as res:
        return json.loads(res.read().decode("utf-8"))


def _describe_failure(exc: Exception) -> str:
    text = str(getattr(exc, "reason", exc))
    if "CERTIFICATE" in text.upper() or "SSL" in text.upper():
        return "couldn't make a secure connection"
    if isinstance(exc, urllib.error.HTTPError):
        return f"the update server answered {exc.code}"
    return "no internet connection"


def _clean_policy(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    blocked = raw.get("blocked_versions")
    return {
        "minimum_version": str(raw.get("minimum_version") or "").lstrip("v"),
        "blocked_versions": [str(v).lstrip("v") for v in blocked] if isinstance(blocked, list) else [],
        "message": str(raw.get("message") or "")[:500],
    }


def _update_info(force: bool = False) -> dict:
    """What we know about updates: the latest release, the owner's policy,
    when we last asked and whether it worked. Never raises; offline keeps
    whatever was known before, including a "you must update"."""
    cache = db.DB_PATH.parent / "update-check.json"
    try:
        data = json.loads(cache.read_text())
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    age = time.time() - float(data.get("checked_at") or 0)
    wait = UPDATE_CHECK_INTERVAL if not data.get("error") else UPDATE_RETRY_INTERVAL
    if not force and age < wait:
        return data
    with _update_lock:
        error = None
        try:
            release = _fetch_json(RELEASES_API, {"Accept": "application/vnd.github+json"})
            data["latest"] = str(release.get("tag_name") or "").lstrip("v") or data.get("latest")
        except Exception as exc:
            error = _describe_failure(exc)
        # The rules set in the Admin tab (Supabase app_config) come first; the
        # website's update-policy.json is the fallback when that can't be read.
        rules = None
        try:
            rules = cloud.public_update_rules()
        except cloud.CloudError:
            pass
        if rules is not None:
            data["policy"] = _clean_policy(rules)
        else:
            try:
                data["policy"] = _clean_policy(_fetch_json(UPDATE_POLICY_URL))
            except Exception as exc:
                # A missing policy file just means no rules; anything else is a failure.
                if not (isinstance(exc, urllib.error.HTTPError) and exc.code == 404):
                    error = error or _describe_failure(exc)
        now = time.time()
        # When checks started failing, so a check that keeps failing (a
        # network that blocks GitHub, say) is eventually said out loud.
        failing_since = (data.get("failing_since") or now) if error else None
        data.update(checked_at=now, error=error, failing_since=failing_since)
        try:
            cache.write_text(json.dumps(data))
        except OSError:
            pass
    return data


@app.get("/api/version")
def api_version():
    payload = {"current": __version__, "bundled": IS_BUNDLED, "update_available": False, "required": False}
    # A git checkout started some other way (app.py in development) cannot
    # restart itself, so it gets no notice.
    how = "restart" if app.config.get(RESTART_KEY) else "download" if IS_BUNDLED else None
    info = _update_info(force=request.args.get("refresh") == "1")
    payload.update(checked_at=info.get("checked_at"), check_error=info.get("error"))
    if info.get("error") and info.get("failing_since"):
        payload["check_failing_days"] = int((time.time() - float(info["failing_since"])) // 86400)
        payload["url"] = DOWNLOAD_PAGE
    if app.config.get("MUHURATA_UPDATE_ERROR"):
        payload["update_error"] = app.config["MUHURATA_UPDATE_ERROR"]
    latest = info.get("latest")
    if not how or not latest or _version_tuple(latest) <= _version_tuple(__version__):
        return jsonify(payload)
    policy = _clean_policy(info.get("policy"))
    mine = _version_tuple(__version__)
    required = (bool(policy["minimum_version"]) and mine < _version_tuple(policy["minimum_version"])) \
        or any(_version_tuple(v) == mine for v in policy["blocked_versions"])
    payload.update(update_available=True, latest=latest, how=how, url=DOWNLOAD_PAGE,
                   required=required, message=policy["message"])
    return jsonify(payload)


def _seen_version_file():
    return db.DB_PATH.parent / "seen-version.txt"


@app.get("/api/whats-new")
def api_whats_new():
    """Release notes for the versions since this computer last saw the app."""
    try:
        seen = _seen_version_file().read_text().strip()
    except OSError:
        # Never recorded: a new install has nothing to catch up on, but an
        # existing one updated from before this existed should hear about it.
        seen = None if db.earliest_activity_day() else __version__
    current = _version_tuple(__version__)
    notes = [{"version": v, "items": items} for v, items in release_notes.NOTES.items()
             if _version_tuple(v) <= current and (seen is None or _version_tuple(v) > _version_tuple(seen))]
    if seen is None:
        notes = notes[:1]  # updated from an unknown version: just the latest
    if not notes:
        _mark_seen()
    payload = {"current": __version__, "notes": notes}
    if sys.platform == "darwin" and not IS_BUNDLED:
        payload["get_app_url"] = DOWNLOAD_PAGE  # a Terminal install: offer the real app
    return jsonify(payload)


def _mark_seen():
    try:
        _seen_version_file().write_text(__version__)
    except OSError:
        pass


@app.post("/api/whats-new/seen")
def api_whats_new_seen():
    _mark_seen()
    return "", 204


@app.get("/api/update/progress")
def api_update_progress():
    """How far an update has got, for the notice while it runs. Cheap: no
    network, so the page can ask a few times a second."""
    return jsonify({"current": __version__,
                     "progress": app.config.get("MUHURATA_UPDATE_PROGRESS"),
                     "error": app.config.get("MUHURATA_UPDATE_ERROR")})


@app.post("/api/update/restart")
def api_update_restart():
    """Stop and start again; starting is when a git install updates itself."""
    restart = app.config.get(RESTART_KEY)
    if not restart:
        return jsonify({"error": "This copy cannot restart itself."}), 409
    restart()
    return "", 202


@app.put("/api/settings")
def api_put_settings():
    body = request.get_json(silent=True) or {}
    patch: dict = {}
    if "auto_start_work" in body:
        patch["auto_start_work"] = bool(body["auto_start_work"])
    if "auto_start_break" in body:
        patch["auto_start_break"] = bool(body["auto_start_break"])
    if "sound_enabled" in body:
        patch["sound_enabled"] = bool(body["sound_enabled"])
    if "tick_sound_enabled" in body:
        patch["tick_sound_enabled"] = bool(body["tick_sound_enabled"])
    if "chime_work_end" in body:
        patch["chime_work_end"] = bool(body["chime_work_end"])
    if "chime_break_end" in body:
        patch["chime_break_end"] = bool(body["chime_break_end"])
    if "chime_session_start" in body:
        patch["chime_session_start"] = bool(body["chime_session_start"])
    if "chime_pool_add" in body:
        patch["chime_pool_add"] = bool(body["chime_pool_add"])
    if "chime_choice" in body:
        patch["chime_choice"] = bool(body["chime_choice"])
    if "chime_skip" in body:
        patch["chime_skip"] = bool(body["chime_skip"])
    if "sound_volume" in body:
        try:
            vol = int(body["sound_volume"])
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid volume"}), 400
        if not (0 <= vol <= 100):
            return jsonify({"error": "Volume must be 0–100"}), 400
        patch["sound_volume"] = vol
    for key in SOUND_SETTING_KEYS:
        if key in body:
            sound = str(body[key])
            if sound not in SOUND_CHOICES:
                return jsonify({"error": "Invalid sound choice"}), 400
            patch[key] = sound
    if "theme" in body:
        theme = str(body["theme"])
        if theme not in ("light", "dark", "system"):
            return jsonify({"error": "Invalid theme"}), 400
        patch["theme"] = theme
    if "timer_end" in body:
        timer_end = str(body["timer_end"])
        if timer_end not in ("stop", "ring", "overtime"):
            return jsonify({"error": "Invalid timer ending"}), 400
        patch["timer_end"] = timer_end
    if "notifications_enabled" in body:
        patch["notifications_enabled"] = bool(body["notifications_enabled"])
    if "default_preset_id" in body:
        pid = str(body["default_preset_id"])
        if not _preset_exists(pid):
            return jsonify({"error": "Unknown default preset"}), 400
        patch["default_preset_id"] = pid
    if "daily_focus_goal_minutes" in body:
        try:
            goal = int(body["daily_focus_goal_minutes"])
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid daily goal"}), 400
        if not (15 <= goal <= 960):
            return jsonify({"error": "Daily goal must be 15–960 minutes"}), 400
        patch["daily_focus_goal_minutes"] = goal
    if not patch:
        return jsonify(db.load_settings())
    saved = db.save_settings(patch)
    return jsonify(saved)


@app.get("/api/focus/today")
def api_focus_today():
    day = request.args.get("day")
    if not day or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        day = datetime.now().date().isoformat()
    minutes = db.get_focus_minutes(day)
    return jsonify({"day": day, "minutes": minutes})


@app.post("/api/focus/log")
def api_focus_log():
    data = request.get_json(silent=True) or {}
    try:
        minutes = int(data.get("minutes", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid minutes"}), 400
    day = data.get("day")
    if not day or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(day)):
        return jsonify({"error": "Invalid day"}), 400
    if not (1 <= minutes <= 240):
        return jsonify({"error": "Minutes out of range"}), 400
    total = db.add_focus_minutes(str(day), minutes)
    return jsonify({"day": day, "minutes": total})


@app.post("/api/activity/segment")
def api_activity_segment():
    data = request.get_json(silent=True) or {}
    kind = str(data.get("kind") or "")
    if kind not in ("work", "extend", "flow", "timer", "rest", "cumulative", "pause"):
        return jsonify({"error": "Invalid activity kind"}), 400
    day = str(data.get("day") or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return jsonify({"error": "Invalid day"}), 400
    started_at = str(data.get("started_at") or "")
    ended_at = str(data.get("ended_at") or "")
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        end = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
        duration_sec = float(data.get("duration_sec"))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid activity timing"}), 400
    # Safety net: the timer only saves sessions that have finished, so one
    # cannot end in the future. Cap it at now and shorten it to match.
    # (A start in the future means this browser's clock is off; leave it.)
    now = datetime.now(timezone.utc)
    if start.tzinfo and end > now + timedelta(seconds=SEGMENT_CLOCK_SLACK_SEC) and start < now:
        end = now
        ended_at = end.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        duration_sec = (end - start).total_seconds()
    if not (0.5 <= duration_sec <= 24 * 60 * 60):
        return jsonify({"error": "Activity duration out of range"}), 400
    phase_index = data.get("phase_index")
    if phase_index is not None:
        try:
            phase_index = int(phase_index)
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid phase index"}), 400
    details = data.get("details")
    if details is not None and not isinstance(details, dict):
        return jsonify({"error": "Invalid details"}), 400
    segment = db.add_activity_segment(
        {
            "day": day,
            "kind": kind,
            "started_at": started_at,
            "ended_at": ended_at,
            "duration_sec": duration_sec,
            "preset_id": str(data.get("preset_id") or ""),
            "preset_name": str(data.get("preset_name") or ""),
            "phase_index": phase_index,
            "details": details or {},
        }
    )
    return jsonify(segment), 201


@app.get("/api/activity/day")
def api_activity_day():
    day = request.args.get("day")
    if not day or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        day = datetime.now().date().isoformat()
    return jsonify(db.activity_for_day(str(day)))


HISTORY_MIN_SEC = 60
HISTORY_MAX_SEC = 24 * 60 * 60
# Clocks on the same machine agree, but leave room for a page that has been
# open across a few seconds of drift.
HISTORY_FUTURE_SLACK_SEC = 5 * 60


def _parse_history_body(data: dict):
    """(day, started_at, ended_at, duration_sec) in canonical UTC ISO, or an
    error message. The browser sends the local day so it matches the timer's
    own records."""
    day = str(data.get("day") or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return "Invalid day"
    try:
        start = datetime.fromisoformat(str(data.get("started_at") or "").replace("Z", "+00:00"))
        end = datetime.fromisoformat(str(data.get("ended_at") or "").replace("Z", "+00:00"))
    except ValueError:
        return "Invalid start or end time"
    if start.tzinfo is None or end.tzinfo is None:
        return "Times need a timezone"
    duration = (end - start).total_seconds()
    if duration <= 0:
        return "The end has to come after the start"
    if duration < HISTORY_MIN_SEC:
        return "A session has to be at least a minute long"
    if duration > HISTORY_MAX_SEC:
        return "A session can be at most 24 hours long"
    if (end - datetime.now(timezone.utc)).total_seconds() > HISTORY_FUTURE_SLACK_SEC:
        return "That session would end in the future"
    to_iso = lambda d: d.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return day, to_iso(start), to_iso(end), duration


def _conflict_response(err: db.SegmentConflict):
    return jsonify({"error": str(err), "conflict": getattr(err, "segment", None)}), 409


@app.get("/api/activity/history")
def api_activity_history():
    earliest = db.earliest_activity_day()
    if request.args.get("long"):
        return jsonify(
            {
                "segments": db.list_long_segments(),
                "long_threshold_sec": db.LONG_SEGMENT_SEC,
                "earliest_day": earliest,
            }
        )
    end = request.args.get("end") or ""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end):
        end = datetime.now().date().isoformat()
    try:
        days = max(1, min(int(request.args.get("days", 7)), 62))
        end_day = date.fromisoformat(end)
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid range"}), 400
    start = (end_day - timedelta(days=days - 1)).isoformat()
    return jsonify(
        {
            "start": start,
            "end": end,
            "segments": db.list_activity_history(start, end),
            "long_threshold_sec": db.LONG_SEGMENT_SEC,
            "earliest_day": earliest,
        }
    )


@app.post("/api/activity/manual")
def api_activity_manual():
    data = request.get_json(silent=True) or {}
    kind = str(data.get("kind") or "")
    if kind not in ("work", "rest"):
        return jsonify({"error": "Choose focus or rest"}), 400
    parsed = _parse_history_body(data)
    if isinstance(parsed, str):
        return jsonify({"error": parsed}), 400
    try:
        segment = db.create_manual_segment(kind, *parsed)
    except db.SegmentConflict as err:
        return _conflict_response(err)
    return jsonify(segment), 201


@app.put("/api/activity/segment/<int:segment_id>")
def api_activity_update(segment_id: int):
    parsed = _parse_history_body(request.get_json(silent=True) or {})
    if isinstance(parsed, str):
        return jsonify({"error": parsed}), 400
    try:
        segment = db.update_activity_segment(segment_id, *parsed)
    except db.SegmentConflict as err:
        return _conflict_response(err)
    if segment is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(segment)


@app.delete("/api/activity/segment/<int:segment_id>")
def api_activity_delete(segment_id: int):
    if not db.delete_activity_segment(segment_id):
        return jsonify({"error": "Not found"}), 404
    return "", 204


@app.get("/api/dashboard")
def api_dashboard():
    day = request.args.get("day")
    if day and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return jsonify({"error": "Invalid day"}), 400
    year = request.args.get("year")
    parsed_year = None
    if year:
        try:
            parsed_year = int(year)
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid year"}), 400
    try:
        days = int(request.args.get("days", 365))
    except (TypeError, ValueError):
        days = 365
    timezone_name = request.args.get("tz")
    return jsonify(db.dashboard_summary(day, days, parsed_year, timezone_name))



if __name__ == "__main__":
    # With the debug reloader, only the child process that serves requests syncs.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        sync.start()
    app.run(port=8000, debug=True)
