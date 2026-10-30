"""Sign-in, accounts and "Continue with Google / Microsoft", end to end.

Runs the real app (Flask test client, real sync and database code) against
an in-memory stand-in for Supabase and Google, in a throwaway data folder.
Nothing leaves this computer.

    .venv/bin/python tests/test_sign_in.py

Prints PASS / FAIL per check and exits non-zero if anything failed.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, parse_qsl, unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
DATA = tempfile.mkdtemp(prefix="muhurta-test-")
Path(DATA, "focus_timer.db").touch()  # an empty database, not the repo's old data/ copy
os.environ["MUHURATA_DATA_DIR"] = DATA
os.environ["MUHURATA_NO_BROWSER_OPEN"] = "1"
sys.path.insert(0, str(ROOT))

import cloud  # noqa: E402

# --------------------------------------------------------------------------- #
# the stand-in Supabase (+ Google)
# --------------------------------------------------------------------------- #
USERS: dict[str, str] = {}       # email -> user id
PASSWORDS: dict[str, str] = {}   # user id -> password
META: dict[str, dict] = {}       # user id -> user_metadata
PROFILES: dict[str, dict] = {}   # user id -> profiles row
ROWS: dict[str, dict] = {}       # table -> {key: row}
PROVIDERS_ON: dict[str, bool] = {}
GOOGLE_CODES: dict[str, tuple] = {}  # issued code -> (code_challenge, email, full name)
CODES_EMAILED: list[str] = []
ERROR_REPORTS: list[dict] = []
FACTORS: dict[str, list] = {}    # user id -> authenticator apps (two-step sign-in)
APP_CODE = "654321"              # what the authenticator app shows
KEYS = {"activity_segments": ("uuid",), "custom_presets": ("uuid",), "app_settings": (),
        "focus_by_device": ("day", "device_id"), "app_devices": ("device_id",)}
clock = [datetime(2026, 1, 1, tzinfo=timezone.utc)]


def _stamp():
    clock[0] += timedelta(milliseconds=1)
    return clock[0].isoformat()


def _claims(token):
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (AttributeError, IndexError, ValueError):
        return {}


def _uid(token):
    return _claims(token).get("sub")


def _two_step_blocks(token):
    """Like the two_step rules: an account with an authenticator app needs aal2."""
    uid = _uid(token)
    return any(f["status"] == "verified" for f in FACTORS.get(uid, [])) and _claims(token).get("aal") != "aal2"


def _session_for(uid, email, aal="aal1"):
    body = base64.urlsafe_b64encode(json.dumps({"sub": uid, "aal": aal}).encode()).rstrip(b"=").decode()
    return 200, {"access_token": f"h.{body}.s", "refresh_token": f"ref:{uid}:{aal}", "expires_in": 3600,
                 "user": {"id": uid, "email": email, "user_metadata": dict(META.get(uid, {})),
                          "factors": [dict(f) for f in FACTORS.get(uid, [])]}}


def fake_request(method, path, body=None, token=None, headers=None):
    url = urlsplit(path)
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    p = url.path
    if p == "/auth/v1/settings":
        return 200, {"external": {"email": True, **PROVIDERS_ON}}
    if p == "/auth/v1/otp":
        if not body["create_user"] and body["email"] not in USERS:
            return 422, {"error_code": "otp_disabled", "msg": "Signups not allowed for otp"}
        CODES_EMAILED.append(body["email"])
        return 200, {}
    if p == "/auth/v1/verify":
        if body["token"] != "123456":
            return 400, {"msg": "bad code"}
        uid = USERS.setdefault(body["email"], str(uuid.uuid4()))
        return _session_for(uid, body["email"])
    if p == "/auth/v1/token" and q.get("grant_type") == "password":
        uid = USERS.get(body["email"])
        if not uid or PASSWORDS.get(uid) != body["password"]:
            return 400, {"error_code": "invalid_credentials"}
        return _session_for(uid, body["email"])
    if p == "/auth/v1/token" and q.get("grant_type") == "pkce":
        issued = GOOGLE_CODES.pop(body["auth_code"], None)
        if not issued:
            return 400, {"error_code": "flow_state_not_found"}
        challenge, email, name = issued
        digest = base64.urlsafe_b64encode(hashlib.sha256(body["code_verifier"].encode()).digest()).rstrip(b"=")
        if digest.decode() != challenge:
            return 400, {"error_code": "bad_code_verifier"}
        uid = USERS.setdefault(email, str(uuid.uuid4()))
        META[uid] = {**META.get(uid, {}), "full_name": name}
        return _session_for(uid, email)
    if p == "/auth/v1/token" and q.get("grant_type") == "refresh_token":
        _, uid, aal = body["refresh_token"].split(":")
        email = next(e for e, u in USERS.items() if u == uid)
        return _session_for(uid, email, aal)
    if p == "/auth/v1/user" and method == "GET":
        uid = _uid(token)
        return 200, {"id": uid, "factors": [dict(f) for f in FACTORS.get(uid, [])]}
    if p == "/auth/v1/factors" and method == "POST":
        if _two_step_blocks(token):
            return 403, {"error_code": "insufficient_aal"}
        factor = {"id": str(uuid.uuid4()), "factor_type": "totp", "status": "unverified"}
        FACTORS.setdefault(_uid(token), []).append(factor)
        return 200, {"id": factor["id"], "type": "totp",
                     "totp": {"qr_code": "data:image/svg+xml;utf-8,<svg/>", "secret": "JBSWY3DP", "uri": "otpauth://totp/x"}}
    if p.startswith("/auth/v1/factors/"):
        uid = _uid(token)
        fid, _, action = p[len("/auth/v1/factors/"):].partition("/")
        mine = [f for f in FACTORS.get(uid, []) if f["id"] == fid]
        if not mine:
            return 404, {"error_code": "mfa_factor_not_found"}
        if method == "DELETE":
            if mine[0]["status"] == "verified" and _claims(token).get("aal") != "aal2":
                return 403, {"error_code": "insufficient_aal"}
            FACTORS[uid].remove(mine[0])
            return 200, {"id": fid}
        if action == "challenge":
            return 200, {"id": "challenge-" + fid}
        if action == "verify":
            if body.get("challenge_id") != "challenge-" + fid or body.get("code") != APP_CODE:
                return 422, {"error_code": "mfa_verification_failed"}
            mine[0]["status"] = "verified"
            return _session_for(uid, next(e for e, u in USERS.items() if u == uid), "aal2")
    if p == "/auth/v1/user" and method == "PUT":
        uid = _uid(token)
        if "data" in body:
            META[uid] = {**META.get(uid, {}), **body["data"]}
            return 200, {}
        if PASSWORDS.get(uid) == body.get("password"):
            return 422, {"error_code": "same_password"}
        PASSWORDS[uid] = body["password"]
        return 200, {}
    if p == "/auth/v1/logout":
        return 204, None
    if p == "/rest/v1/rpc/username_available":
        me = _uid(token)
        return 200, not any(r["username"] == body["name"].lower() and u != me for u, r in PROFILES.items())
    if p == "/rest/v1/rpc/is_admin":
        return 200, False
    if p == "/rest/v1/rpc/delete_my_account":
        uid = _uid(token)  # auth.users "on delete cascade": the rows go with it
        for email in [e for e, u in USERS.items() if u == uid]:
            del USERS[email]
        for store in (PASSWORDS, META, PROFILES):
            store.pop(uid, None)
        for store in ROWS.values():
            for k in [k for k in store if k[0] == uid]:
                del store[k]
        return 204, None
    if p.startswith("/rest/v1/rpc/"):
        return 404, {"code": "PGRST202"}
    if p == "/rest/v1/profiles":
        uid = _uid(token)
        if any(r["username"] == body["username"] and u != uid for u, r in PROFILES.items()):
            return 409, {"code": "23505"}
        PROFILES[uid] = dict(body)
        return 201, None
    if p == "/rest/v1/error_reports":
        if token:
            return 400, {"message": "error notes are sent without the sign-in"}
        ERROR_REPORTS.extend(body)
        return 201, None
    if p == "/rest/v1/app_config":
        return 200, []
    table = p.rsplit("/", 1)[-1]
    if table not in KEYS:
        return 404, {"code": "PGRST205", "message": f"no table {table}"}
    if _two_step_blocks(token):
        return 403, {"code": "42501", "message": "new row violates row-level security policy"}
    uid = _uid(token)
    store = ROWS.setdefault(table, {})
    key = lambda r: (uid, *[r[k] for k in KEYS[table]])  # noqa: E731
    if method == "GET":
        rows = [r for (u, *_), r in store.items() if u == uid]
        if "server_updated_at" in q:
            since = datetime.fromisoformat(unquote(q["server_updated_at"])[3:])
            rows = [r for r in rows if datetime.fromisoformat(r["server_updated_at"]) > since]
        rows.sort(key=lambda r: r["server_updated_at"])
        off = int(q.get("offset", 0))
        return 200, [dict(r) for r in rows[off:off + int(q.get("limit", 1000))]]
    if method == "POST":
        for r in body if isinstance(body, list) else [body]:
            old = store.get(key(r))
            if old and r.get("updated_at") and r["updated_at"] <= old.get("updated_at", ""):
                continue  # newest wins, like keep_newest()
            store[key(r)] = {**(old or {}), **r, "server_updated_at": _stamp()}
        return 201, None
    if method == "PATCH":
        ids = q.get("uuid", "in.()")[4:-1].split(",")
        for (u, *_), r in store.items():
            if u == uid and r.get("uuid") in ids and body["updated_at"] > r["updated_at"]:
                r.update(body, server_updated_at=_stamp())
        return 204, None
    return 405, None


cloud._request = fake_request

import app as appmod  # noqa: E402
import sync  # noqa: E402

client = appmod.app.test_client()
phone = appmod.app.test_client()
phone.environ_base["REMOTE_ADDR"] = "192.168.1.50"  # a phone on the same Wi-Fi
failures: list[str] = []
GOOD = "Correct-horse9"


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


def profile_for(email):
    name = email.split("@")[0]
    return {"first_name": name.title(), "last_name": "Tester", "username": f"user_{name}"}


def create_account(email, password=GOOD):
    r = client.post("/api/cloud/send-code", json={"email": email, "purpose": "new", **profile_for(email)})
    assert r.status_code == 200, r.get_json()
    r = client.post("/api/cloud/verify", json={"email": email, "code": "123456"})
    assert r.status_code == 200 and r.get_json()["password_pending"], r.get_json()
    r = client.post("/api/cloud/set-password", json={"password": password, **profile_for(email)})
    assert r.status_code == 200, r.get_json()


def sign_out():
    return client.post("/api/cloud/sign-out", json={"force": True})


def local_count(table):
    conn = sync._connect()
    try:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    finally:
        conn.close()


def add_preset(name):
    r = client.post("/api/presets", json={"name": name, "work_min": 25, "short_rest_min": 5, "long_rest_min": 15})
    assert r.status_code in (200, 201), r.get_json()


# --------------------------------------------------------------------------- #
print("\n-- signed out")
r = client.get("/")
check(r.status_code == 302 and r.headers["Location"].endswith("/sign-in"), "pages lead to sign-in")
r = client.get("/api/settings")
check(r.status_code == 401 and r.headers.get("X-Signed-Out") == "1", "data is locked (401)")
check(client.get("/sign-in").status_code == 200, "sign-in page opens")
check(client.get("/api/cloud/providers").get_json()["providers"] == [], "no Google button while Google is off")

print("\n-- creating an account")
r = client.post("/api/cloud/send-code", json={"email": "asha@x.com", "purpose": "new"})
check(r.status_code == 400, "a name is needed before any email is sent")
r = client.post("/api/cloud/send-code", json={"email": "asha@x.com", "purpose": "new", "first_name": "A", "username": "9no"})
check(r.status_code == 400, "a bad username is refused before any email is sent")
r = client.post("/api/cloud/send-code", json={"email": "asha@x.com", "purpose": "new", "first_name": "Asha", "username": "asha"})
check(r.status_code == 200 and CODES_EMAILED[-1] == "asha@x.com", "details accepted, code emailed")
check(client.post("/api/cloud/verify", json={"email": "asha@x.com", "code": "999999"}).status_code == 400, "wrong code refused")
st = client.post("/api/cloud/verify", json={"email": "asha@x.com", "code": "123456"}).get_json()
check(st["password_pending"] and not st["signed_in"], "after the code: still locked until a password is chosen")
check(client.get("/").status_code == 302, "...the app stays closed meanwhile")
for weak, why in [("short", "too short"), ("estfastf", "letters only"), ("alllower9!", "no capital"),
                  ("NoNumber!!", "no number"), ("NoSymbol99", "no symbol"), ("Asha-Abc9!x", "contains the username")]:
    r = client.post("/api/cloud/set-password", json={"password": weak, "first_name": "Asha", "username": "asha"})
    check(r.status_code == 400, f"password refused: {why}")
r = client.post("/api/cloud/set-password", json={"password": GOOD, "first_name": "Asha", "username": "asha"})
st = r.get_json()
check(r.status_code == 200 and st["signed_in"] and st["profile"]["username"] == "asha", "strong password: signed in, profile saved")
check(client.get("/").status_code == 200, "the app opens")

print("\n-- data, sign-out, other accounts")
add_preset("Asha's rhythm")
sync.run_once()
check(local_count("custom_presets") == 1, "a rhythm saved")
check(any(r.get("name") == "Asha's rhythm" for r in ROWS.get("custom_presets", {}).values()), "...and uploaded to the account")
r = client.post("/api/cloud/sign-out", json={})
check(r.status_code == 200 and not r.get_json()["signed_in"], "sign out")
check(local_count("custom_presets") == 0, "signing out clears this computer")
r = client.post("/api/cloud/sign-in", json={"email": "asha@x.com", "password": "Wrong-pass9"})
check(r.status_code == 401, "wrong password refused")
emailed = len(CODES_EMAILED)
r = client.post("/api/cloud/sign-in", json={"email": "asha@x.com", "password": GOOD})
check(r.status_code == 200 and r.get_json()["signed_in"] and len(CODES_EMAILED) == emailed, "email + password: in, no code needed")
check(local_count("custom_presets") == 1, "...and the rhythm is back")
sign_out()
create_account("bea@x.com")
check(local_count("custom_presets") == 0, "another account sees none of the first one's data")
sign_out()

print("\n-- forgot password")
check(client.post("/api/cloud/send-code", json={"email": "nobody@x.com", "purpose": "reset"}).status_code == 404,
      "unknown email: says there's no account")
client.post("/api/cloud/send-code", json={"email": "asha@x.com", "purpose": "reset"})
client.post("/api/cloud/verify", json={"email": "asha@x.com", "code": "123456"})
check(client.post("/api/cloud/set-password", json={"password": "New-pass-77"}).get_json()["signed_in"], "new password set")
sign_out()
check(client.post("/api/cloud/sign-in", json={"email": "asha@x.com", "password": GOOD}).status_code == 401, "old password stops working")
check(client.post("/api/cloud/sign-in", json={"email": "asha@x.com", "password": "New-pass-77"}).status_code == 200, "new one works")
sign_out()

print("\n-- Continue with Google / Microsoft")
PROVIDERS_ON.update(google=True, azure=True, github=True)
ids = [p["id"] for p in client.get("/api/cloud/providers").get_json()["providers"]]
check(ids == ["google", "azure"], f"buttons once switched on: {ids}")
check(client.post("/api/cloud/oauth/start", json={"provider": "github"}).status_code == 400, "unknown provider refused")


def start(c, provider="google"):
    r = c.post("/api/cloud/oauth/start", json={"provider": provider})
    return r.get_json(), dict(parse_qsl(urlsplit(r.get_json()["url"]).query))


def google_says_yes(query, email, name):
    """What Google + Supabase do after the person picks an account."""
    code = f"code-{uuid.uuid4().hex[:8]}"
    GOOGLE_CODES[code] = (query["code_challenge"], email, name)
    return code


started, q = start(client)
check(q["provider"] == "google" and q["code_challenge_method"] == "s256"
      and q["redirect_to"].endswith("/auth/callback"), "start: off to Supabase / Google, coming back to this app")
check(started["opened"] is False, "tests never open a real browser")
code = google_says_yes(q, "gita@gmail.com", "Gita Rao")
check(client.get("/").status_code == 302, "still signed out while the browser is open")
r = client.get("/auth/callback?code=" + code)
check(r.status_code == 200 and b"signed in" in r.data, "on this computer: a 'You're signed in' page")
st = client.get("/api/cloud/status").get_json()
check(st["signed_in"] and st["profile"] is None and st["suggested_name"] == "Gita Rao",
      "new Google account: signed in, name suggested, profile still to finish")
page = client.get("/sign-in")
check(page.status_code == 200 and b'data-needs-profile="1"' in page.data, "sign-in page shows 'Finish your profile'")
r = client.put("/api/cloud/profile", json={"first_name": "Gita", "last_name": "Rao", "username": "gita.rao"})
check(r.status_code == 200 and client.get("/sign-in").status_code == 302, "profile finished: straight into the app")
check(client.get("/auth/callback?code=" + code).status_code == 200 and not GOOGLE_CODES, "a used code can't be used twice")
sign_out()

started, q = start(client, "azure")
check(q.get("scopes") == "email", "Microsoft asks for the email address")
code = google_says_yes(q, "gita@gmail.com", "Gita Rao")
GOOGLE_CODES[code] = ("not-the-real-challenge",) + GOOGLE_CODES[code][1:]
r = client.get("/auth/callback?code=" + code)
check(b"didn" in r.data and not cloud.status()["signed_in"], "a tampered security code is refused")
r = client.get("/auth/callback?error=access_denied&error_description=You+cancelled")
check(b"cancelled" in r.data and not cloud.status()["signed_in"], "cancelled at Google: says so, stays signed out")
cloud._oauth_pending = None
check(b"expired" in client.get("/auth/callback?code=whatever").data, "a callback nobody started is refused")

started, q = start(client)
code = google_says_yes(q, "asha@x.com", "Asha")
client.get("/auth/callback?code=" + code)
st = client.get("/api/cloud/status").get_json()
check(st["signed_in"] and st["profile"] and st["profile"]["username"] == "asha",
      "same email as an existing account: same account, profile kept")
check(local_count("custom_presets") == 1, "...with its data")
sign_out()

print("\n-- error reports")
client.post("/api/cloud/sign-in", json={"email": "asha@x.com", "password": "New-pass-77"})
check(client.post("/api/error-report", json={"message": "TypeError: x is undefined", "detail": "at timer.js:10",
                                             "page": "/timer"}).status_code == 204, "a page error is taken")
client.post("/api/error-report", json={"message": "TypeError: x is undefined", "detail": "at timer.js:10", "page": "/timer"})
sync.run_once()
check(len(ERROR_REPORTS) == 1 and ERROR_REPORTS[0]["times"] == 2 and ERROR_REPORTS[0]["source"] == "page"
      and "user_id" not in ERROR_REPORTS[0] and ERROR_REPORTS[0]["device_id"],
      "sent with the next sync: once, counted twice, no account attached")
sync.run_once()
check(len(ERROR_REPORTS) == 1, "...and not sent again")
check(client.get("/api/admin/errors").status_code == 404, "only admins see them")
sign_out()

print("\n-- two-step sign-in")
r = client.post("/api/cloud/sign-in", json={"email": "asha@x.com", "password": "New-pass-77"})
check(client.get("/api/cloud/two-step").get_json() == {"enabled": False}, "off to begin with")
started = client.post("/api/cloud/two-step/start").get_json()
check(started["qr_code"].startswith("data:image/svg") and started["secret"], "turning on: a QR code and a key")
r = client.post("/api/cloud/two-step/confirm", json={"factor_id": started["factor_id"], "code": "111111"})
check(r.status_code == 400 and client.get("/api/cloud/two-step").get_json() == {"enabled": False},
      "a wrong first code: still off")
r = client.post("/api/cloud/two-step/confirm", json={"factor_id": started["factor_id"], "code": APP_CODE})
check(r.status_code == 200 and client.get("/api/cloud/two-step").get_json() == {"enabled": True},
      "the right code: on")
add_preset("After two-step")
sync.run_once()
check(sync.status()["error"] is None and local_count("custom_presets") == 2, "...and this computer keeps syncing")
sign_out()
r = client.post("/api/cloud/sign-in", json={"email": "asha@x.com", "password": "New-pass-77"})
st = r.get_json()
check(r.status_code == 200 and st["mfa_pending"] and not st["signed_in"], "password alone: asks for the code")
check(client.get("/").status_code == 302 and local_count("custom_presets") == 0,
      "...the app stays closed and nothing is downloaded")
page = client.get("/sign-in")
check(b'data-mfa-pending="1"' in page.data, "...the sign-in page opens on the code step")
check(client.post("/api/cloud/mfa-verify", json={"code": "000000"}).status_code == 400, "a wrong code: refused")
st = client.post("/api/cloud/mfa-verify", json={"code": APP_CODE}).get_json()
check(st["signed_in"] and local_count("custom_presets") == 2, "the right code: in, with the data")
session = cloud._load()
session["expires_at"] = 0
cloud._write(session)
check(cloud.access_token() and cloud.status()["signed_in"], "a renewed session stays two-step")
check(client.post("/api/cloud/two-step/off", json={"code": "123"}).status_code == 400, "turning off needs a code")
r = client.post("/api/cloud/two-step/off", json={"code": APP_CODE})
check(r.status_code == 200 and client.get("/api/cloud/two-step").get_json() == {"enabled": False}, "turned off")
sign_out()
st = client.post("/api/cloud/sign-in", json={"email": "asha@x.com", "password": "New-pass-77"}).get_json()
check(st["signed_in"] and not st["mfa_pending"], "off again: the password is enough")
client.post("/api/cloud/two-step/confirm", json={
    "factor_id": client.post("/api/cloud/two-step/start").get_json()["factor_id"], "code": APP_CODE})
sign_out()
started, q = start(client)
code = google_says_yes(q, "asha@x.com", "Asha")
client.get("/auth/callback?code=" + code)
st = client.get("/api/cloud/status").get_json()
check(st["mfa_pending"] and not st["signed_in"], "with Google too: the code is still asked for")
check(client.post("/api/cloud/cancel").get_json()["signed_in"] is False and cloud._load() is None,
      "\"Use another account\" forgets the half sign-in")
FACTORS.pop(USERS["asha@x.com"])
cloud._oauth_pending = None

print("\n-- deleting the account")
create_account("dev@x.com")
add_preset("Dev's rhythm")
sync.run_once()
dev = USERS["dev@x.com"]
check(any(k[0] == dev for k in ROWS["custom_presets"]), "a second account's rhythm is in the cloud")
r = client.get("/api/backup")
saved = r.get_json(force=True)
check(r.status_code == 200 and "attachment" in r.headers["Content-Disposition"]
      and [p["name"] for p in saved["custom_presets"]] == ["Dev's rhythm"], "backup: a file with the rhythm in it")
check(client.get("/api/backup/sessions.csv").data.startswith(b"Date,Kind,Started"), "backup: sessions as CSV")
check(client.post("/api/backup/restore", json={"app": "other"}).status_code == 400, "restore: not a backup file, refused")
check(client.post("/api/backup/restore", json={**saved, "format": 99}).status_code == 400,
      "restore: a backup from a newer app, refused")
r = client.post("/api/backup/restore", json=saved)
check(r.status_code == 200 and r.get_json()["combinations"] == 0, "restore: nothing missing, nothing changed")
r = client.post("/api/cloud/delete-account", json={"confirm": "asha@x.com"})
check(r.status_code == 400 and cloud.status()["signed_in"] and "dev@x.com" in USERS,
      "someone else's email typed: nothing deleted")
r = client.post("/api/cloud/delete-account", json={"confirm": " DEV@x.com "})
check(r.status_code == 200 and not r.get_json()["signed_in"], "email typed: deleted and signed out")
check("dev@x.com" not in USERS and dev not in PROFILES and not any(k[0] == dev for k in ROWS["custom_presets"]),
      "...gone from the server with everything in it")
check(local_count("custom_presets") == 0, "...and from this computer")
check(client.post("/api/cloud/sign-in", json={"email": "dev@x.com", "password": GOOD}).status_code == 401,
      "...so signing in with it no longer works")
check(any(k[0] == USERS["asha@x.com"] for k in ROWS["custom_presets"]), "other accounts are untouched")
check(client.post("/api/cloud/delete-account", json={"confirm": "dev@x.com"}).status_code == 401,
      "signed out: nothing to delete")
create_account("dev@x.com")
r = client.post("/api/backup/restore", json=saved)
check(r.status_code == 200 and r.get_json()["combinations"] == 1 and local_count("custom_presets") == 1,
      "a new account restores the old backup")
sync.run_once()
check([r["name"] for k, r in ROWS["custom_presets"].items() if k[0] == USERS["dev@x.com"]] == ["Dev's rhythm"],
      "...and it reaches the account")
sign_out()

print("\n-- from a phone on the same Wi-Fi")
started, q = start(phone)
check(started["opened"] is False and "192.168.1.50" not in q["redirect_to"],
      "no browser opened on the computer; the phone's tab goes itself")
code = google_says_yes(q, "asha@x.com", "Asha")
r = phone.get("/auth/callback?code=" + code)
check(r.status_code == 302 and r.headers["Location"].endswith("/sign-in"),
      "after Google the phone lands straight back in the app")
sign_out()

print()
print("ALL PASSED" if not failures else f"{len(failures)} FAILED: " + "; ".join(failures))
sys.exit(1 if failures else 0)
