"""Error reports: when something breaks, the app's admin hears about it.

A page error (static/js/error-report.js) or a crash on the computer side
(below) is kept as a short note in error_reports.json next to the database,
and sync.py sends the notes with its next run. Notes carry no account, only
this computer's random id, the version, the platform, the page and the error
(see the "error reports" section of supabase/schema.sql). The same error
again only counts up; a handful a day at most, so a loop can't flood anything.
mobile/web/local-api.js does the same on phones.
"""
from __future__ import annotations

import json
import logging
import sys
import threading
import traceback
from datetime import datetime, timezone

import cloud
import db
from version import __version__

log = logging.getLogger("muhurata.errors")

MAX_KEPT = 30  # different errors waiting to be sent
MAX_NEW_PER_DAY = 20
SOURCES = ("page", "app")
_lock = threading.Lock()


def _path():
    return db.DB_PATH.parent / "error_reports.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load() -> dict:
    try:
        data = json.loads(_path().read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict):
    try:
        _path().parent.mkdir(parents=True, exist_ok=True)
        _path().write_text(json.dumps(data))
    except OSError:
        pass


def record(source: str, message: str, detail: str = "", page: str = "") -> None:
    """Keep a note of an error. Never raises: reporting must not break anything."""
    try:
        message = " ".join(str(message or "").split())[:500]
        if source not in SOURCES or not message:
            return
        detail = str(detail or "")[:4000]
        key = f"{source}|{message}|{detail.splitlines()[0] if detail else ''}"
        today = datetime.now().date().isoformat()
        with _lock:
            data = _load()
            notes = data.setdefault("notes", {})
            if data.get("day") != today:
                data["day"], data["new_today"] = today, 0
            if key in notes:
                notes[key]["times"] = min(notes[key]["times"] + 1, 10000)
                notes[key]["last_seen"] = _now()
            elif len(notes) < MAX_KEPT and data["new_today"] < MAX_NEW_PER_DAY:
                data["new_today"] += 1
                notes[key] = {"source": source, "message": message, "detail": detail, "page": str(page or "")[:200],
                              "times": 1, "first_seen": _now(), "last_seen": _now()}
            _save(data)
    except Exception:  # noqa: BLE001
        log.debug("couldn't keep an error note", exc_info=True)


def record_exception(exc: BaseException, page: str = "") -> None:
    detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    record("app", f"{type(exc).__name__}: {exc}", detail, page)


def pending() -> int:
    return len(_load().get("notes") or {})


def upload() -> int:
    """Send the waiting notes; called by sync. Raises cloud.Offline offline."""
    with _lock:
        notes = list((_load().get("notes") or {}).values())
    if not notes:
        return 0
    rows = [{**n, "device_id": db.device_id(), "app_version": __version__, "platform": sys.platform[:20]} for n in notes]
    # Without the sign-in on purpose: notes are not tied to an account.
    code, payload = cloud._request("POST", "/rest/v1/error_reports", rows, headers={"Prefer": "return=minimal"})
    if code >= 400 and code != 404:  # 404: not set up on the server yet; drop them rather than pile up
        log.warning("error reports -> %s %s", code, payload)
        return 0
    with _lock:
        data = _load()
        kept = data.get("notes") or {}
        for n in notes:  # only what was sent; a note that counted up meanwhile goes next time
            for k, v in list(kept.items()):
                if v == n:
                    del kept[k]
        _save(data)
    return len(notes) if code < 400 else 0


def install_hooks() -> None:
    """Crashes in the computer side's own threads become notes too."""
    before = threading.excepthook

    def hook(args):
        if args.exc_value is not None and not isinstance(args.exc_value, SystemExit):
            record_exception(args.exc_value, page=f"thread {getattr(args.thread, 'name', '')}")
        before(args)

    threading.excepthook = hook
