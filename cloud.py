"""Signing in to the Muhurata cloud account (Supabase Auth).

Creating an account: the person types their email, Supabase emails a code,
they type it back (proving the address is theirs), then choose a password.
After that they sign in with email and password; no code is needed. A
forgotten password is reset the same way an account is created: a code to
the email, then a new password.

Between the code and the password the account is signed in but not yet
usable (password_pending), so stopping halfway never leaves an account
without a password.

The resulting session (an access token that lasts an hour, and a refresh
token that renews it) is kept in cloud_session.json next to the database,
readable only by this user. Everything here talks to Supabase over HTTPS
with the project's publishable key; the own-rows-only rules in
supabase/schema.sql are what keep one person's data from another.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import db

# The project's address and publishable key are meant to ship inside the
# app: the publishable key only identifies the project, and the own-rows
# rules decide what anyone can read. Never put a "secret" or "service_role"
# key here. The environment variables exist for testing against another
# project.
SUPABASE_URL = os.environ.get("MUHURATA_SUPABASE_URL", "https://ybjyzvtilicsncuiujks.supabase.co").rstrip("/")
SUPABASE_KEY = os.environ.get("MUHURATA_SUPABASE_KEY", "sb_publishable_YDL_wTS1iPM9bKHpR6yP7g_o8pnFBDk")
# Who the sign-in codes come from (Supabase -> Authentication -> SMTP
# Settings). Shown on the code screen so people can find the email; keep
# the two in step.
EMAIL_FROM = os.environ.get("MUHURATA_EMAIL_FROM", "muhurata.pomodoro.timer@gmail.com")
# The app has no web address of its own (it runs at 127.0.0.1), so password
# managers can't tell what a saved password is for. This is the one address
# we tell everyone to file it under: the app's website.
PASSWORD_SITE = "harsh-0024.github.io/muhurta-pomodoro"

TIMEOUT = 15  # seconds; a slow connection should fail, not hang
REFRESH_EARLY = 120  # renew the access token this many seconds before it expires
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CODE_RE = re.compile(r"^\d{6,10}$")
# A username: 3-20 characters, starts with a letter, then letters, digits,
# "_" or "."; compared without regard to case.
USERNAME_RE = re.compile(r"^[a-z][a-z0-9_.]{2,19}$")
NAME_MAX = 50
PASSWORD_MIN = 8
PASSWORD_MAX = 72  # what Supabase (bcrypt) actually uses
PROFILE_KEYS = ("first_name", "last_name", "username")

# Our own list of trusted certificates, so HTTPS works however Python was
# installed. The python.org Mac installer and some frozen builds ship
# without one, and every secure connection then fails.
try:
    import certifi

    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # pragma: no cover - certifi is in requirements.txt
    _SSL = ssl.create_default_context()

_lock = threading.Lock()  # one refresh at a time (the sync thread and a page may race)


class CloudError(Exception):
    """Something the person should be told, in words they can act on."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class Offline(CloudError):
    def __init__(self):
        super().__init__("No internet connection right now. Try again when you are online.", 503)


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_KEY)


def _session_path() -> Path:
    return db.DB_PATH.parent / "cloud_session.json"


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _request(method: str, path: str, body=None, token: str | None = None, headers: dict | None = None):
    """Call Supabase (Auth or the data API). Returns (status, parsed JSON or None)."""
    if not configured():
        raise CloudError("Sync is not available in this version of the app.", 503)
    headers = {"apikey": SUPABASE_KEY, "Accept": "application/json", **(headers or {})}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{SUPABASE_URL}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=_SSL) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw) if raw else None
        except ValueError:
            return exc.code, None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLError):
            # Online, but the connection could not be verified as secure.
            raise CloudError("Couldn't make a secure connection to the sync service. "
                             "Check the date and time on this computer, then try again.", 502) from None
        raise Offline() from None
    except (TimeoutError, OSError):
        raise Offline() from None


def _error_text(payload) -> str:
    if not isinstance(payload, dict):
        return ""
    return " ".join(str(payload.get(k) or "") for k in ("error_code", "code", "error", "msg", "message", "error_description")).lower()


# --------------------------------------------------------------------------- #
# session file
# --------------------------------------------------------------------------- #
def _load() -> dict | None:
    try:
        data = json.loads(_session_path().read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("refresh_token") else None


def _profile_from(user: dict) -> dict | None:
    meta = user.get("user_metadata") if isinstance(user, dict) else None
    if not isinstance(meta, dict) or not meta.get("username"):
        return None
    return {k: str(meta.get(k) or "") for k in PROFILE_KEYS}


def _name_from(user: dict) -> str:
    """The name Google or Microsoft gave us, to fill in the profile step."""
    meta = user.get("user_metadata") if isinstance(user, dict) else None
    if not isinstance(meta, dict):
        return ""
    return str(meta.get("full_name") or meta.get("name") or "").strip()[:100]


def _claims(token: str) -> dict:
    """What an access token says about itself (it is a JWT); {} if unreadable."""
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError, TypeError):
        return {}


def _verified_factors(user: dict) -> list[dict]:
    return [f for f in (user.get("factors") or []) if f.get("factor_type") == "totp" and f.get("status") == "verified"]


def _second_step_needed(payload: dict, before: bool = False) -> bool:
    """Signed in with a password, a code or Google / Microsoft, but the
    account has two-step sign-in on and the authenticator code isn't in yet.
    A refresh may leave out the user; then it stays as it was."""
    if _claims(payload.get("access_token") or "").get("aal") == "aal2":
        return False
    user = payload.get("user") or {}
    if "factors" not in user:
        return before
    return bool(_verified_factors(user))


def _save(payload: dict, password_pending: bool = False, profile: dict | None = None,
          mfa_before: bool = False) -> dict:
    user = payload.get("user") or {}
    expires_at = payload.get("expires_at") or (time.time() + int(payload.get("expires_in") or 3600))
    session = {
        "access_token": payload["access_token"],
        "refresh_token": payload["refresh_token"],
        "expires_at": int(expires_at),
        "user_id": user.get("id"),
        "email": user.get("email"),
        "password_pending": password_pending,
        # Two-step sign-in is on and its code is still to come (see mfa_*).
        "mfa_pending": _second_step_needed(payload, mfa_before),
        # Name and username, kept here so pages can show them offline.
        "profile": _profile_from(user) or profile,
        "suggested_name": _name_from(user),
    }
    return _write(session)


def _write(session: dict) -> dict:
    path = _session_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    # Created private (owner read/write only), then swapped in, so a crash
    # mid-write never leaves a half-written or world-readable file.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(session, fh)
    os.replace(tmp, path)
    return session


def _forget():
    _session_path().unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# public API
# --------------------------------------------------------------------------- #
def status() -> dict:
    """Whether the app may be used, and as whom. Never touches the network."""
    session = _load()
    pending = bool(session and session.get("password_pending"))
    mfa = bool(session and session.get("mfa_pending"))
    return {
        "configured": configured(),
        "signed_in": session is not None and not pending and not mfa,
        "password_pending": pending,
        "mfa_pending": mfa,
        "email": session.get("email") if session else None,
        "profile": (session.get("profile") if session else None) or None,
        "suggested_name": (session.get("suggested_name") if session else "") or "",
        # Only decides whether the Admin tab is shown; the data behind it is
        # checked by the server on every request (admin_overview()).
        "is_admin": bool(session and session.get("is_admin") and not pending and not mfa),
    }


# --------------------------------------------------------------------------- #
# what an account must look like (the sign-in page checks the same, as you type)
# --------------------------------------------------------------------------- #
def password_problems(password: str, email: str = "", username: str = "") -> list[str]:
    """Everything wrong with a password, in words; empty when it is fine."""
    problems = []
    if len(password) < PASSWORD_MIN:
        problems.append(f"at least {PASSWORD_MIN} characters")
    if len(password.encode()) > PASSWORD_MAX:
        problems.append(f"at most {PASSWORD_MAX} characters")
    if not re.search(r"[a-z]", password):
        problems.append("a lowercase letter")
    if not re.search(r"[A-Z]", password):
        problems.append("a capital letter")
    if not re.search(r"\d", password):
        problems.append("a number")
    if not re.search(r"[^A-Za-z0-9\s]", password):
        problems.append("a symbol, like ! ? # or @")
    lowered = password.lower()
    for part in (username, email.split("@")[0]):
        if part and len(part) >= 3 and part.lower() in lowered:
            problems.append("not your username or email")
            break
    return problems


def check_password(password: str, email: str = "", username: str = "") -> None:
    problems = password_problems(password, email, username)
    if problems:
        raise CloudError("Your password needs " + ", ".join(problems) + ".")


def clean_profile(first_name: str, last_name: str, username: str) -> dict:
    first = " ".join((first_name or "").split())
    last = " ".join((last_name or "").split())
    user = (username or "").strip().lower().lstrip("@")
    if not first:
        raise CloudError("Enter your first name.")
    if len(first) > NAME_MAX or len(last) > NAME_MAX:
        raise CloudError(f"Names can be at most {NAME_MAX} characters.")
    if not USERNAME_RE.match(user):
        raise CloudError("A username is 3 to 20 characters: letters, numbers, _ or ., starting with a letter.")
    return {"first_name": first, "last_name": last, "username": user}


def username_available(username: str) -> bool:
    """Whether nobody else has this username. Needs the profiles part of
    supabase/schema.sql; before that is set up, every name counts as free."""
    username = (username or "").strip().lower()
    if not USERNAME_RE.match(username):
        return False
    session = _load()
    token = session["access_token"] if session and session["expires_at"] > time.time() else None
    code, payload = _request("POST", "/rest/v1/rpc/username_available", {"name": username}, token=token)
    if code == 200 and isinstance(payload, bool):
        return payload
    if code == 404:
        return True  # not set up on the server yet
    raise CloudError("Couldn't check that username right now. Try again.", 502)


def _store_profile(profile: dict, token: str) -> None:
    """Save the name and username to the account: in the sign-in record (what
    every computer reads) and in the profiles table (what keeps usernames
    unique)."""
    code, payload = _request("POST", "/rest/v1/profiles?on_conflict=user_id",
                             {**profile, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                             token=token, headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
    if code == 409 or "23505" in _error_text(payload):
        raise CloudError("Someone just took that username. Choose another.", 409)
    if code >= 400 and code != 404:  # 404: profiles not set up on the server yet
        raise CloudError("Your name couldn't be saved. Try again.", 502)
    code, payload = _request("PUT", "/auth/v1/user", {"data": profile}, token=token)
    if code >= 400:
        raise CloudError("Your name couldn't be saved. Try again.", 502)
    with _lock:
        session = _load()
        if session:
            session["profile"] = profile
            _write(session)


def update_profile(first_name: str, last_name: str, username: str) -> dict:
    """Change the name or username from Settings."""
    profile = clean_profile(first_name, last_name, username)
    current = (status().get("profile") or {}).get("username")
    if profile["username"] != current and not username_available(profile["username"]):
        raise CloudError("That username is taken. Choose another.", 409)
    token = access_token()
    if token is None:
        raise CloudError("Please sign in first.", 401)
    _store_profile(profile, token)
    return status()


def _clean_email(email: str) -> str:
    email = (email or "").strip().lower()
    if not EMAIL_RE.match(email):
        raise CloudError("That doesn't look like an email address.")
    return email


def send_code(email: str, new_account: bool = True) -> None:
    """Email a code: to create an account, or (new_account=False) to reset
    the password of one that exists."""
    email = _clean_email(email)
    code, payload = _request("POST", "/auth/v1/otp", {"email": email, "create_user": new_account})
    if code == 429 or "rate" in _error_text(payload):
        raise CloudError("Too many codes asked for. Wait a minute, then try again.", 429)
    if code >= 400 and not new_account and ("signup" in _error_text(payload) or "not found" in _error_text(payload)
                                            or "otp_disabled" in _error_text(payload)):
        raise CloudError("There's no account with that email. Create one instead.", 404)
    if code >= 400:
        raise CloudError("The code could not be sent. Check the address and try again.", 502)


def sign_in_password(email: str, password: str) -> dict:
    email = _clean_email(email)
    if not password:
        raise CloudError("Enter your password.")
    code, payload = _request("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password})
    if code == 429:
        raise CloudError("Too many tries. Wait a minute, then try again.", 429)
    if code >= 400 or not isinstance(payload, dict) or "access_token" not in payload:
        if "email_not_confirmed" in _error_text(payload):
            raise CloudError("This email isn't confirmed yet. Use Create an account to get a code.")
        raise CloudError("Wrong email or password. Forgot it? Reset it with a code.", 401)
    with _lock:
        _save(payload)
    return status()


def set_password(password: str, profile: dict | None = None) -> dict:
    """Finish creating the account (with its name and username) or resetting
    the password, after the code."""
    password = password or ""
    session = _load() or {}
    check_password(password, session.get("email") or "", (profile or {}).get("username") or "")
    token = access_token()
    if token is None:
        raise CloudError("That took too long. Start again with a new code.", 401)
    if profile:
        # First, so a taken username is found before the password is set.
        _store_profile(profile, token)
    code, payload = _request("PUT", "/auth/v1/user", {"password": password}, token=token)
    text = _error_text(payload)
    if code == 429:
        raise CloudError("Too many tries. Wait a minute, then try again.", 429)
    if code >= 400 and "same_password" not in text:  # resetting to the old one is fine
        if "weak" in text or "password" in text:
            reason = payload.get("msg") or payload.get("message") if isinstance(payload, dict) else None
            raise CloudError(reason or "Choose a stronger password.")
        raise CloudError("The password could not be saved. Try again.", 502)
    with _lock:
        session = _load()
        if session:
            session["password_pending"] = False
            _write(session)
    return status()


def cancel_pending() -> dict:
    """Stopped between the code and the password, or before the two-step
    code: forget that half sign-in."""
    st = status()
    if st["password_pending"] or st["mfa_pending"]:
        sign_out()
    return status()


def verify_code(email: str, code: str) -> dict:
    email = (email or "").strip().lower()
    code = re.sub(r"\s+", "", code or "")
    if not CODE_RE.match(code):
        raise CloudError("The code is the number in the email, 6 digits or more.")
    status_code, payload = _request("POST", "/auth/v1/verify", {"type": "email", "email": email, "token": code})
    if status_code == 429:
        raise CloudError("Too many tries. Wait a minute, then try again.", 429)
    if status_code >= 400 or not isinstance(payload, dict) or "access_token" not in payload:
        raise CloudError("That code is wrong or has expired. Ask for a new one if it is over an hour old.")
    with _lock:
        _save(payload, password_pending=True)  # usable once a password is chosen
    return status()


def access_token() -> str | None:
    """A valid access token, renewed if needed. None when signed out.

    Raises Offline when the token needs renewing but there is no connection;
    the caller (sync) simply tries again later.
    """
    with _lock:
        session = _load()
        if session is None:
            return None
        if session["expires_at"] - REFRESH_EARLY > time.time():
            return session["access_token"]
        code, payload = _request("POST", "/auth/v1/token?grant_type=refresh_token",
                                 {"refresh_token": session["refresh_token"]})
        if code < 400 and isinstance(payload, dict) and "access_token" in payload:
            # Supabase may leave out the user on refresh; keep what we know.
            payload.setdefault("user", {"id": session["user_id"], "email": session["email"]})
            return _save(payload, session.get("password_pending", False), session.get("profile"),
                         session.get("mfa_pending", False))["access_token"]
        if code in (400, 401, 403):
            # The refresh token was revoked or expired (signed out elsewhere,
            # account deleted). Sign out here too, rather than retrying forever.
            _forget()
            return None
        raise CloudError("The sync service is having trouble. It will try again later.", 502)


def user_id() -> str | None:
    session = _load()
    return session.get("user_id") if session else None


def sign_out() -> dict:
    with _lock:
        session = _load()
        if session:
            try:
                # scope=local: sign out this computer only. Supabase's default
                # signs out every computer on the account.
                _request("POST", "/auth/v1/logout?scope=local", {}, token=session["access_token"])
            except CloudError:
                pass  # offline or already invalid: forgetting locally is what matters
        _forget()
    return status()


def delete_account(confirm: str) -> None:
    """Delete the account and everything in it on the server (see the
    "deleting your own account" section of supabase/schema.sql), then forget
    the sign-in here. The caller clears this computer's copy."""
    session = _load()
    if not session or session.get("password_pending"):
        raise CloudError("Please sign in first.", 401)
    if (confirm or "").strip().lower() != (session.get("email") or "").lower():
        raise CloudError("Type your email exactly as shown to confirm.")
    token = access_token()
    if token is None:
        raise CloudError("Please sign in first.", 401)
    code, payload = _request("POST", "/rest/v1/rpc/delete_my_account", {}, token=token)
    if code == 404:
        raise CloudError("Deleting accounts isn't set up on the server yet (run the \"deleting your own "
                         "account\" section of supabase/schema.sql).", 404)
    if "two-step" in _error_text(payload):
        raise CloudError("Sign out and sign in again with your authenticator code, then delete the account.", 403)
    if code >= 400:
        raise CloudError("Your account couldn't be deleted just now. Try again.", 502)
    with _lock:
        _forget()


# --------------------------------------------------------------------------- #
# two-step sign-in (Supabase MFA, an authenticator app's 6-digit code)
# --------------------------------------------------------------------------- #
# Turned on in Settings -> Account. From then on, signing in (any way) ends
# with the code from the authenticator app, and the server's data rules (the
# "two-step sign-in" section of supabase/schema.sql) refuse a session that
# hasn't given it, so a stolen password alone opens nothing.
MFA_ISSUER = "Muhurta Pomodoro"
TOTP_RE = re.compile(r"^\d{6}$")


def _mfa_token(allow_pending: bool = False) -> str:
    session = _load()
    if not session or session.get("password_pending") or (session.get("mfa_pending") and not allow_pending):
        raise CloudError("Please sign in first.", 401)
    token = access_token()
    if token is None:
        raise CloudError("Please sign in first.", 401)
    return token


def _clean_totp(code: str) -> str:
    code = re.sub(r"\s+", "", code or "")
    if not TOTP_RE.match(code):
        raise CloudError("The code is the 6 digits your authenticator app shows now.")
    return code


def _factors(token: str) -> list[dict]:
    code, payload = _request("GET", "/auth/v1/user", token=token)
    if code >= 400 or not isinstance(payload, dict):
        raise CloudError("The sync service is having trouble. Try again.", 502)
    return [f for f in (payload.get("factors") or []) if f.get("factor_type") == "totp"]


def _prove(token: str, factor_id: str, code: str) -> dict:
    """One challenge and its answer; the reply is a new, two-step session."""
    status_code, challenge = _request("POST", f"/auth/v1/factors/{factor_id}/challenge", {}, token=token)
    if status_code == 429:
        raise CloudError("Too many tries. Wait a minute, then try again.", 429)
    if status_code >= 400 or not isinstance(challenge, dict) or not challenge.get("id"):
        raise CloudError("The code couldn't be checked just now. Try again.", 502)
    status_code, payload = _request("POST", f"/auth/v1/factors/{factor_id}/verify",
                                    {"challenge_id": challenge["id"], "code": code}, token=token)
    if status_code == 429:
        raise CloudError("Too many tries. Wait a minute, then try again.", 429)
    if status_code >= 400 or not isinstance(payload, dict) or "access_token" not in payload:
        raise CloudError("That code is wrong. Codes change every 30 seconds; use the one showing now.")
    return payload


def mfa_status() -> dict:
    """Whether two-step sign-in is on for this account."""
    return {"enabled": any(f.get("status") == "verified" for f in _factors(_mfa_token()))}


def mfa_enroll() -> dict:
    """Start turning it on: a QR code (and the same key as text) for the
    authenticator app. Nothing changes until mfa_confirm()."""
    token = _mfa_token()
    factors = _factors(token)
    if any(f.get("status") == "verified" for f in factors):
        raise CloudError("Two-step sign-in is already on.", 409)
    for f in factors:  # an earlier attempt that wasn't finished
        _request("DELETE", f"/auth/v1/factors/{f['id']}", token=token)
    code, payload = _request("POST", "/auth/v1/factors", {"factor_type": "totp", "issuer": MFA_ISSUER}, token=token)
    totp = payload.get("totp") if isinstance(payload, dict) else None
    if code == 404 or "mfa" in _error_text(payload) and "disabled" in _error_text(payload):
        raise CloudError("Two-step sign-in isn't switched on for this app's server yet.", 404)
    if code >= 400 or not isinstance(totp, dict):
        raise CloudError("Two-step sign-in couldn't be started. Try again.", 502)
    return {"factor_id": payload["id"], "qr_code": totp.get("qr_code") or "", "secret": totp.get("secret") or "",
            "uri": totp.get("uri") or ""}


def mfa_confirm(factor_id: str, code: str) -> dict:
    """Finish turning it on with the first code the app shows."""
    if not re.match(r"^[0-9a-f-]{36}$", factor_id or ""):
        raise CloudError("Start again: turn on two-step sign-in.")
    payload = _prove(_mfa_token(), factor_id, _clean_totp(code))
    with _lock:
        session = _load()
        _save(payload, profile=session.get("profile") if session else None)
    return {"enabled": True}


def mfa_verify(code: str) -> dict:
    """The second step of signing in: the authenticator code."""
    code = _clean_totp(code)
    if not status()["mfa_pending"]:
        raise CloudError("Please sign in first.", 401)
    token = _mfa_token(allow_pending=True)
    verified = [f for f in _factors(token) if f.get("status") == "verified"]
    if not verified:  # turned off on another device meanwhile
        payload = None
    else:
        payload = _prove(token, verified[0]["id"], code)
    with _lock:
        session = _load()
        if session is None:
            raise CloudError("Please sign in first.", 401)
        if payload is None:
            session["mfa_pending"] = False
            _write(session)
        else:
            _save(payload, session.get("password_pending", False), session.get("profile"))
    return status()


def mfa_disable(code: str) -> dict:
    """Turn it off; asks for a current code, so an unattended computer
    can't be used to switch it off."""
    code = _clean_totp(code)
    token = _mfa_token()
    verified = [f for f in _factors(token) if f.get("status") == "verified"]
    if not verified:
        return {"enabled": False}
    payload = _prove(token, verified[0]["id"], code)
    token = payload["access_token"]
    for f in verified:
        status_code, _ = _request("DELETE", f"/auth/v1/factors/{f['id']}", token=token)
        if status_code >= 400:
            raise CloudError("Two-step sign-in couldn't be turned off. Try again.", 502)
    with _lock:
        session = _load()
        _save(payload, profile=session.get("profile") if session else None)
    return {"enabled": False}


# --------------------------------------------------------------------------- #
# sign in with Google / Microsoft (Supabase OAuth, PKCE flow)
# --------------------------------------------------------------------------- #
# The person signs in in their own browser; Supabase sends the browser back
# to this app's local address (/auth/callback) with a one-time code, which
# only this app can exchange, because only it knows the code_verifier.
# Supabase -> Authentication -> URL Configuration must allow that address:
# http://127.0.0.1:*/auth/callback and http://localhost:*/auth/callback.
PROVIDERS = {"google": "Google", "azure": "Microsoft"}  # Supabase name -> button label
OAUTH_TIMEOUT = 10 * 60  # seconds a started sign-in stays valid

_oauth_pending: dict | None = None


def providers() -> list[dict]:
    """The sign-in providers switched on in Supabase, for the buttons. Empty
    when offline or none are set up, so the screen shows email only."""
    try:
        code, payload = _request("GET", "/auth/v1/settings")
    except CloudError:
        return []
    external = payload.get("external") if code == 200 and isinstance(payload, dict) else None
    if not isinstance(external, dict):
        return []
    return [{"id": pid, "name": name} for pid, name in PROVIDERS.items() if external.get(pid)]


def oauth_start(provider: str, redirect_to: str) -> str:
    """Begin signing in with a provider; returns the address to open in the
    browser."""
    global _oauth_pending
    if provider not in PROVIDERS:
        raise CloudError("That sign-in option isn't available.")
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    _oauth_pending = {"verifier": verifier, "provider": provider, "at": time.time()}
    query = {"provider": provider, "redirect_to": redirect_to,
             "code_challenge": challenge, "code_challenge_method": "s256"}
    if provider == "azure":
        query["scopes"] = "email"  # Microsoft leaves the email out otherwise
    return f"{SUPABASE_URL}/auth/v1/authorize?{urllib.parse.urlencode(query)}"


def oauth_finish(code: str) -> dict:
    """The browser came back with a code: swap it for a session."""
    global _oauth_pending
    pending = _oauth_pending
    if not pending or time.time() - pending["at"] > OAUTH_TIMEOUT:
        raise CloudError("This sign-in has expired. Go back to the app and try again.")
    if not code:
        raise CloudError("The sign-in didn't finish. Go back to the app and try again.")
    status_code, payload = _request("POST", "/auth/v1/token?grant_type=pkce",
                                    {"auth_code": code, "code_verifier": pending["verifier"]})
    if status_code >= 400 or not isinstance(payload, dict) or "access_token" not in payload:
        raise CloudError("The sign-in couldn't be completed. Go back to the app and try again.")
    _oauth_pending = None  # a code works once
    with _lock:
        _save(payload)
    return status()


# --------------------------------------------------------------------------- #
# admin (the Admin tab; see the admin section of supabase/schema.sql)
# --------------------------------------------------------------------------- #
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


def refresh_admin() -> bool:
    """Ask the server whether this account is an admin, and remember it.
    Called by the background sync, so it never slows a page down."""
    token = access_token()
    if token is None:
        return False
    code, payload = _request("POST", "/rest/v1/rpc/is_admin", {}, token=token)
    admin = code == 200 and payload is True  # 404: not set up yet -> not an admin
    with _lock:
        session = _load()
        if session and session.get("is_admin") != admin:
            session["is_admin"] = admin
            _write(session)
    return admin


def _admin_call(method: str, path: str, body=None, prefer: str | None = None):
    token = access_token()
    if token is None:
        raise CloudError("Please sign in first.", 401)
    code, payload = _request(method, path, body, token=token, headers={"Prefer": prefer} if prefer else None)
    if code in (401, 403) or "42501" in _error_text(payload) or "admins only" in _error_text(payload):
        raise CloudError("This is for the app's admin only.", 403)
    if code == 404:
        raise CloudError("The admin part isn't set up on the server yet (run the admin section of "
                         "supabase/schema.sql).", 404)
    if code >= 400:
        raise CloudError("The server couldn't answer just now. Try again.", 502)
    return payload


def admin_overview() -> dict:
    data = _admin_call("POST", "/rest/v1/rpc/admin_overview", {})
    return data if isinstance(data, dict) else {}


def save_update_rules(minimum_version: str, blocked_versions, message: str) -> dict:
    minimum = (minimum_version or "").strip().lstrip("v")
    if minimum and not VERSION_RE.match(minimum):
        raise CloudError("Write versions like 1.7.2.")
    if isinstance(blocked_versions, str):
        blocked_versions = blocked_versions.replace(",", " ").split()
    blocked = []
    for v in blocked_versions or []:
        v = str(v).strip().lstrip("v")
        if not VERSION_RE.match(v):
            raise CloudError(f"\"{v}\" isn't a version. Write versions like 1.7.2.")
        if v not in blocked:
            blocked.append(v)
    message = " ".join((message or "").split())
    if len(message) > 500:
        raise CloudError("Keep the message under 500 characters.")
    rows = _admin_call("PATCH", "/rest/v1/app_config?id=eq.1",
                       {"minimum_version": minimum, "blocked_versions": blocked, "message": message,
                        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                       prefer="return=representation")
    if not rows:  # the update rule let nothing through: not an admin
        raise CloudError("This is for the app's admin only.", 403)
    return rows[0]


def public_update_rules() -> dict | None:
    """The update rules every copy follows (app_config), read without signing
    in. None when unreachable or not set up; the caller falls back to the
    website's update-policy.json."""
    code, payload = _request("GET", "/rest/v1/app_config?id=eq.1&select=minimum_version,blocked_versions,message")
    if code == 200 and isinstance(payload, list) and payload:
        return payload[0]
    return None


# --------------------------------------------------------------------------- #
# feedback (Settings -> Feedback, and the Admin tab; see the feedback
# section of supabase/schema.sql)
# --------------------------------------------------------------------------- #
FEEDBACK_KINDS = ("like", "dislike", "improve", "idea")
FEEDBACK_STATUSES = ("new", "seen", "done")
FEEDBACK_MAX = 2000
_FEEDBACK_COLS = "id,kind,message,status,created_at"


def _feedback_call(method: str, path: str, body=None, prefer: str | None = None):
    token = access_token()
    if token is None:
        raise CloudError("Please sign in first.", 401)
    code, payload = _request(method, path, body, token=token, headers={"Prefer": prefer} if prefer else None)
    if code == 404 or "42p01" in _error_text(payload):
        raise CloudError("Feedback isn't set up on the server yet (run the feedback section of "
                         "supabase/schema.sql).", 404)
    if code >= 400:
        raise CloudError("The server couldn't take that just now. Try again.", 502)
    return payload


def send_feedback(kind: str, message: str, app_version: str, platform: str) -> dict:
    kind = (kind or "").strip().lower()
    message = (message or "").strip()
    if kind not in FEEDBACK_KINDS:
        raise CloudError("Choose what kind of feedback this is.")
    if not message:
        raise CloudError("Write a few words first.")
    if len(message) > FEEDBACK_MAX:
        raise CloudError(f"Keep it under {FEEDBACK_MAX} characters.")
    rows = _feedback_call("POST", f"/rest/v1/feedback?select={_FEEDBACK_COLS}",
                          {"kind": kind, "message": message, "app_version": app_version[:20],
                           "platform": platform[:20]},
                          prefer="return=representation")
    return rows[0] if isinstance(rows, list) and rows else {}


def my_feedback(limit: int = 20) -> list:
    rows = _feedback_call("GET", f"/rest/v1/feedback?select={_FEEDBACK_COLS}&order=created_at.desc&limit={int(limit)}")
    return rows if isinstance(rows, list) else []


def admin_feedback() -> list:
    rows = _admin_call("POST", "/rest/v1/rpc/admin_feedback", {})
    return rows if isinstance(rows, list) else []


def admin_mark_feedback_seen(ids) -> None:
    ids = [int(i) for i in ids or []]
    if ids:
        _admin_call("POST", "/rest/v1/rpc/admin_mark_feedback_seen", {"feedback_ids": ids})


def admin_set_feedback_status(feedback_id: int, status: str) -> None:
    if status not in FEEDBACK_STATUSES:
        raise CloudError("Unknown status.")
    found = _admin_call("POST", "/rest/v1/rpc/admin_set_feedback_status",
                        {"feedback_id": int(feedback_id), "new_status": status})
    if found is False:
        raise CloudError("That feedback no longer exists.", 404)


def admin_error_reports() -> list:
    rows = _admin_call("POST", "/rest/v1/rpc/admin_error_reports", {})
    return rows if isinstance(rows, list) else []


def admin_clear_error_reports() -> None:
    _admin_call("POST", "/rest/v1/rpc/admin_clear_error_reports", {})


def admin_delete_feedback(feedback_id: int) -> None:
    found = _admin_call("POST", "/rest/v1/rpc/admin_delete_feedback", {"feedback_id": int(feedback_id)})
    if found is False:
        raise CloudError("That feedback no longer exists.", 404)
