"""Background sync between this computer's database and the cloud account.

The local database is always the one the timer uses; this only copies
changes in both directions when signed in and online:

  upload    rows whose synced_version differs from updated_at (see migration
            0002), deletes recorded in sync_tombstones, this computer's daily
            totals, and settings (minus the ones that belong to one computer)
  download  everything the server stamped since the last download, minus a
            few minutes of overlap; applying a row twice is harmless

Newest change wins, on the server (keep_newest in supabase/schema.sql) and
here. The data on this computer always belongs to the account signed in:
signing in to a different account clears it first, and signing out uploads
what is left and then clears it (see enter_account / leave_account). A sync runs a few seconds after any change, every few minutes, and
when asked from Settings. Failures are remembered and retried; they never
reach the timer.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

import cloud
import db
import errors

log = logging.getLogger("muhurata.sync")

INTERVAL = 300  # seconds between syncs when nothing changes
DEBOUNCE = 5  # after a change, wait this long so a burst of edits syncs once
PULL_OVERLAP = timedelta(minutes=5)  # re-read a little, in case of late commits
PAGE = 1000  # Supabase returns at most 1000 rows per request
PUSH_CHUNK = 500

# Each computer keeps its own: volume and notification permission are
# about this machine, and custom-preset ids differ between computers.
LOCAL_ONLY_SETTINGS = ("sound_volume", "notifications_enabled", "default_preset_id")

ROW_TABLES = {
    "activity_segments": (
        "day", "kind", "started_at", "ended_at", "duration_sec", "productive_sec", "rest_sec",
        "preset_id", "preset_name", "phase_index", "details_json", "created_at", "device_id",
    ),
    "custom_presets": ("name", "work_min", "short_rest_min", "long_rest_min", "created_at"),
}

_run_lock = threading.Lock()
_wake = threading.Event()
_thread: threading.Thread | None = None
_running = False


class SyncError(cloud.CloudError):
    pass


# --------------------------------------------------------------------------- #
# state (cursors, last result) lives in a small file next to the database
# --------------------------------------------------------------------------- #
def _state_path():
    return db.DB_PATH.parent / "sync_state.json"


def _load_state() -> dict:
    try:
        state = json.loads(_state_path().read_text())
        if isinstance(state, dict):
            return state
    except (OSError, ValueError):
        pass
    return {}


def _save_state(state: dict):
    tmp = _state_path().with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    tmp.replace(_state_path())


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _api(method: str, path: str, token: str, body=None, prefer: str | None = None):
    headers = {"Prefer": prefer} if prefer else None
    code, payload = cloud._request(method, f"/rest/v1/{path}", body, token=token, headers=headers)
    if code >= 400:
        log.warning("sync %s %s -> %s %s", method, path.split("?")[0], code, payload)
        if code in (401, 403):
            raise SyncError("Your sign-in needs renewing. It will retry shortly.", 502)
        raise SyncError("The sync service refused a change. It will retry later.", 502)
    return payload


def _upsert(table: str, conflict: str, rows: list[dict], token: str):
    for i in range(0, len(rows), PUSH_CHUNK):
        _api("POST", f"{table}?on_conflict={conflict}", token, rows[i:i + PUSH_CHUNK],
             prefer="resolution=merge-duplicates,return=minimal")


# --------------------------------------------------------------------------- #
# upload
# --------------------------------------------------------------------------- #
def _push_rows(conn, table: str, cols: tuple, uid: str, token: str) -> int:
    rows = conn.execute(
        f"SELECT uuid, updated_at, {', '.join(cols)} FROM {table} "
        "WHERE uuid IS NOT NULL AND synced_version IS NOT updated_at"
    ).fetchall()
    if not rows:
        return 0
    body = [{"user_id": uid, "deleted_at": None, **dict(r)} for r in rows]
    _upsert(table, "user_id,uuid", body, token)
    # Only rows not edited while uploading are marked done; the rest go next time.
    conn.executemany(
        f"UPDATE {table} SET synced_version = updated_at WHERE uuid = ? AND updated_at = ?",
        [(r["uuid"], r["updated_at"]) for r in rows],
    )
    conn.commit()
    return len(rows)


def _push_deletes(conn, table: str, token: str) -> int:
    uuids = [r[0] for r in conn.execute(
        "SELECT uuid FROM sync_tombstones WHERE table_name = ?", (table,))]
    for i in range(0, len(uuids), 100):
        chunk = uuids[i:i + 100]
        stamp = _now_iso()
        # An update, not an upsert: a row deleted before it ever reached the
        # server has nothing there to delete, and that is fine.
        _api("PATCH", f"{table}?uuid=in.({','.join(chunk)})", token,
             {"deleted_at": stamp, "updated_at": stamp}, prefer="return=minimal")
        conn.executemany("DELETE FROM sync_tombstones WHERE table_name = ? AND uuid = ?",
                         [(table, u) for u in chunk])
        conn.commit()
    return len(uuids)


def _push_settings(conn, uid: str, token: str) -> int:
    row = conn.execute("SELECT json, updated_at FROM app_settings WHERE id = 1 "
                       "AND synced_version IS NOT updated_at").fetchone()
    if row is None:
        return 0
    shared = {k: v for k, v in json.loads(row["json"] or "{}").items() if k not in LOCAL_ONLY_SETTINGS}
    _upsert("app_settings", "user_id",
            [{"user_id": uid, "json": json.dumps(shared), "updated_at": row["updated_at"], "deleted_at": None}], token)
    conn.execute("UPDATE app_settings SET synced_version = updated_at WHERE id = 1 AND updated_at = ?",
                 (row["updated_at"],))
    conn.commit()
    return 1


def _push_focus(conn, uid: str, token: str) -> int:
    rows = conn.execute("SELECT day, device_id, minutes, updated_at FROM focus_by_device "
                        "WHERE synced_version IS NOT updated_at").fetchall()
    if not rows:
        return 0
    _upsert("focus_by_device", "user_id,day,device_id",
            [{"user_id": uid, "deleted_at": None, **dict(r)} for r in rows], token)
    conn.executemany(
        "UPDATE focus_by_device SET synced_version = updated_at WHERE day = ? AND device_id = ? AND updated_at = ?",
        [(r["day"], r["device_id"], r["updated_at"]) for r in rows],
    )
    conn.commit()
    return len(rows)


# --------------------------------------------------------------------------- #
# download
# --------------------------------------------------------------------------- #
def _pull(table: str, cursor: str | None, token: str) -> tuple[list[dict], str | None]:
    query = f"select=*&order=server_updated_at.asc&limit={PAGE}"
    if cursor:
        since = datetime.fromisoformat(cursor) - PULL_OVERLAP
        query += "&server_updated_at=gt." + urllib.parse.quote(since.isoformat())
    rows, offset = [], 0
    while True:
        page = _api("GET", f"{table}?{query}&offset={offset}", token) or []
        rows.extend(page)
        if len(page) < PAGE:
            break
        offset += PAGE
    newest = max((r["server_updated_at"] for r in rows), default=cursor)
    return rows, newest


def _apply_rows(conn, table: str, cols: tuple, rows: list[dict]) -> int:
    changed = 0
    for r in rows:
        if r.get("deleted_at"):
            cur = conn.execute(f"DELETE FROM {table} WHERE uuid = ?", (r["uuid"],))
            # The delete trigger just wrote a delete marker; this delete came
            # from the server, so there is nothing to send back.
            conn.execute("DELETE FROM sync_tombstones WHERE table_name = ? AND uuid = ?", (table, r["uuid"]))
            changed += cur.rowcount
            continue
        local = conn.execute(f"SELECT updated_at FROM {table} WHERE uuid = ?", (r["uuid"],)).fetchone()
        if local is None:
            if conn.execute("SELECT 1 FROM sync_tombstones WHERE table_name = ? AND uuid = ?",
                            (table, r["uuid"])).fetchone():
                continue  # deleted here; the delete is still on its way up
            conn.execute(
                f"INSERT INTO {table} (uuid, {', '.join(cols)}, updated_at, synced_version) "
                f"VALUES ({', '.join('?' * (len(cols) + 3))})",
                (r["uuid"], *[r.get(c) for c in cols], r["updated_at"], r["updated_at"]),
            )
            changed += 1
        elif r["updated_at"] > local["updated_at"]:
            conn.execute(
                f"UPDATE {table} SET {', '.join(f'{c} = ?' for c in cols)}, updated_at = ?, synced_version = ? "
                "WHERE uuid = ?",
                (*[r.get(c) for c in cols], r["updated_at"], r["updated_at"], r["uuid"]),
            )
            changed += 1
        elif r["updated_at"] == local["updated_at"]:
            conn.execute(f"UPDATE {table} SET synced_version = updated_at "
                         "WHERE uuid = ? AND synced_version IS NOT updated_at", (r["uuid"],))
        # else: the copy here is newer and goes up on the next upload
    conn.commit()
    return changed


def _apply_settings(conn, rows: list[dict]) -> int:
    if not rows:
        return 0
    r = rows[-1]
    local = conn.execute("SELECT json, updated_at FROM app_settings WHERE id = 1").fetchone()
    if local is None or r["updated_at"] < (local["updated_at"] or ""):
        return 0
    if r["updated_at"] == local["updated_at"]:
        # Only when it actually changes: rewriting the same value would look
        # like an edit to the update trigger.
        conn.execute("UPDATE app_settings SET synced_version = updated_at "
                     "WHERE id = 1 AND synced_version IS NOT updated_at")
        conn.commit()
        return 0
    mine = json.loads(local["json"] or "{}")
    merged = {k: v for k, v in json.loads(r["json"] or "{}").items() if k not in LOCAL_ONLY_SETTINGS}
    merged.update({k: mine[k] for k in LOCAL_ONLY_SETTINGS if k in mine})
    conn.execute("UPDATE app_settings SET json = ?, updated_at = ?, synced_version = ? WHERE id = 1",
                 (json.dumps(merged), r["updated_at"], r["updated_at"]))
    conn.commit()
    return 1


def _apply_focus(conn, rows: list[dict]) -> int:
    changed = 0
    for r in rows:
        local = conn.execute("SELECT updated_at FROM focus_by_device WHERE day = ? AND device_id = ?",
                             (r["day"], r["device_id"])).fetchone()
        if local is not None and r["updated_at"] <= local["updated_at"]:
            if r["updated_at"] == local["updated_at"]:
                conn.execute("UPDATE focus_by_device SET synced_version = updated_at "
                             "WHERE day = ? AND device_id = ? AND synced_version IS NOT updated_at",
                             (r["day"], r["device_id"]))
            continue
        conn.execute(
            "INSERT INTO focus_by_device (day, device_id, minutes, updated_at, synced_version) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (day, device_id) DO UPDATE SET minutes = excluded.minutes, "
            "updated_at = excluded.updated_at, synced_version = excluded.synced_version",
            (r["day"], r["device_id"], r["minutes"], r["updated_at"], r["updated_at"]),
        )
        changed += 1
    conn.commit()
    return changed


# --------------------------------------------------------------------------- #
# one full sync
# --------------------------------------------------------------------------- #
def _connect():
    conn = sqlite3.connect(db.DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


# A change time older than anything real: settings stamped with it lose to
# whatever the account already has, instead of overwriting it.
NEVER = "1970-01-01T00:00:00.000Z"
SYNCED_TABLES = ("activity_segments", "custom_presets", "app_settings", "focus_by_device")


def _settings_lose_to_account(conn):
    """Mark this computer's settings as older than any the account has."""
    conn.execute("UPDATE app_settings SET updated_at = ?, synced_version = ? WHERE id = 1", (NEVER, NEVER))
    # If both already held NEVER the edit trigger saw "no change" and stamped
    # the row with the current time; set it back (this second update changes
    # updated_at, so the trigger leaves it alone).
    conn.execute("UPDATE app_settings SET updated_at = ?, synced_version = ? "
                 "WHERE id = 1 AND updated_at IS NOT ?", (NEVER, NEVER, NEVER))


def _clear_account_data(conn):
    """Empty this computer of everything that belongs to an account.

    Kept: the settings that belong to the computer (volume, notification
    permission). Everything else comes back from the account on sign-in.
    """
    for table in ("activity_segments", "custom_presets", "focus_by_device"):
        conn.execute(f"DELETE FROM {table}")
    conn.execute("DELETE FROM sync_tombstones")  # the deletes above are not edits to upload
    row = conn.execute("SELECT json FROM app_settings WHERE id = 1").fetchone()
    mine = json.loads((row["json"] if row else None) or "{}")
    kept = {k: mine[k] for k in LOCAL_ONLY_SETTINGS if k in mine and k != "default_preset_id"}
    conn.execute("UPDATE app_settings SET json = ? WHERE id = 1", (json.dumps(kept),))
    _settings_lose_to_account(conn)
    conn.commit()


def _has_own_settings(conn) -> bool:
    row = conn.execute("SELECT json FROM app_settings WHERE id = 1").fetchone()
    data = json.loads((row["json"] if row else None) or "{}")
    return any(k not in LOCAL_ONLY_SETTINGS for k in data)


def _switch_account(conn, state: dict, uid: str):
    """An account signed in that this computer has not synced with yet.

    If the data here belongs to another account (an older version signed
    out without clearing it), it is cleared. If it belongs to nobody - this
    computer's history from before accounts were required - it is added to
    the account. Either way the account's data is then downloaded from the
    beginning.
    """
    if state.get("user_id"):
        _clear_account_data(conn)
    else:
        for table in SYNCED_TABLES:
            # Only rows where the value actually changes, so the edit trigger
            # does not take this for an edit.
            conn.execute(f"UPDATE {table} SET synced_version = NULL WHERE synced_version IS NOT NULL")
        if not _has_own_settings(conn):
            # Never changed here: the account's settings win, rather than
            # this computer's defaults overwriting them.
            _settings_lose_to_account(conn)
        conn.commit()
    state.clear()
    state["user_id"] = uid


def _sync(conn, state: dict, uid: str, token: str) -> tuple[int, int]:
    if state.get("user_id") != uid:
        _switch_account(conn, state, uid)
    # Deletes go first, so a download cannot bring back a row deleted here.
    up = sum(_push_deletes(conn, t, token) for t in ROW_TABLES)
    up += sum(_push_rows(conn, t, cols, uid, token) for t, cols in ROW_TABLES.items())
    up += _push_settings(conn, uid, token) + _push_focus(conn, uid, token)

    cursors = state.setdefault("cursors", {})
    down = 0
    for table, cols in ROW_TABLES.items():
        rows, cursors[table] = _pull(table, cursors.get(table), token)
        down += _apply_rows(conn, table, cols, rows)
    rows, cursors["app_settings"] = _pull("app_settings", cursors.get("app_settings"), token)
    down += _apply_settings(conn, rows)
    rows, cursors["focus_by_device"] = _pull("focus_by_device", cursors.get("focus_by_device"), token)
    down += _apply_focus(conn, rows)
    _report_version(state, uid, token)
    return up, down


DEVICE_REPORT_EVERY = 6 * 60 * 60  # seconds; sooner when the version changes


def _report_version(state: dict, uid: str, token: str) -> None:
    """Tell the owner which version this computer runs and when it was last
    online (the app_devices table; see supabase/schema.sql). Only the
    version, the platform and the time; never fails a sync."""
    from version import __version__

    last = state.get("device_report") or {}
    if last.get("version") == __version__ and time.time() - float(last.get("at") or 0) < DEVICE_REPORT_EVERY:
        return
    try:
        code, payload = cloud._request(
            "POST", "/rest/v1/app_devices?on_conflict=user_id,device_id",
            {"user_id": uid, "device_id": db.device_id(), "app_version": __version__,
             "platform": sys.platform, "last_seen": _now_iso()},
            token=token, headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
    except cloud.CloudError:
        return  # offline: next sync
    if code < 400 or code == 404:  # 404: not set up on the server; don't keep asking
        state["device_report"] = {"version": __version__, "at": time.time()}
    else:
        log.warning("version report -> %s %s", code, payload)


def run_once() -> dict:
    """Upload, then download. Returns status(). Safe to call from any thread."""
    global _running
    with _run_lock:
        _running = True
        state = _load_state()
        try:
            db.init_db()
            token = cloud.access_token()
            uid = cloud.user_id()
            # Before the two-step code the server refuses the data anyway.
            if token and uid and not cloud.status()["mfa_pending"]:
                conn = _connect()
                try:
                    up, down = _sync(conn, state, uid, token)
                finally:
                    conn.close()
                state.update(last_sync=_now_iso(), last_error=None)
                if up or down:
                    log.info("sync: %d up, %d down", up, down)
                try:
                    cloud.refresh_admin()  # whether to show the Admin tab
                    errors.upload()
                except cloud.CloudError:
                    pass
        except cloud.Offline:
            state["last_error"] = "offline"
        except cloud.CloudError as exc:
            state["last_error"] = str(exc)
        except Exception as exc:  # never let sync take the timer down
            log.exception("sync failed")
            errors.record_exception(exc, page="sync")
            state["last_error"] = "Something went wrong while syncing. It will retry later."
        finally:
            _running = False
            _save_state(state)
    return status()


def pending_changes() -> int:
    conn = _connect()
    try:
        n = sum(conn.execute(f"SELECT COUNT(*) FROM {t} WHERE synced_version IS NOT updated_at").fetchone()[0]
                for t in SYNCED_TABLES)
        return n + conn.execute("SELECT COUNT(*) FROM sync_tombstones").fetchone()[0]
    finally:
        conn.close()


def status() -> dict:
    state = _load_state()
    return {
        "running": _running,
        "last_sync": state.get("last_sync"),
        "error": state.get("last_error"),
        "pending": pending_changes(),
    }


# --------------------------------------------------------------------------- #
# signing in and out
# --------------------------------------------------------------------------- #
class UnsyncedChanges(cloud.CloudError):
    def __init__(self, pending: int):
        noun = "change has" if pending == 1 else "changes have"
        super().__init__(f"{pending} {noun} not reached your account yet (no connection?). "
                         "Signing out now removes them from this computer for good.", 409)
        self.pending = pending


def enter_account() -> dict:
    """Right after signing in: get this computer onto the account and fetch
    its data, so the timer opens with it. Offline, it fetches later."""
    uid = cloud.user_id()
    if uid:
        with _run_lock:
            db.init_db()
            state = _load_state()
            if state.get("user_id") != uid:
                conn = _connect()
                try:
                    _switch_account(conn, state, uid)
                finally:
                    conn.close()
                _save_state(state)
    return run_once()


def leave_account(force: bool = False) -> dict:
    """Upload what is left, sign out, and clear the account's data from this
    computer, so the next person to sign in here sees only their own.

    Raises UnsyncedChanges when something could not be uploaded, unless
    force is set.
    """
    if cloud.status()["signed_in"]:
        run_once()
    with _run_lock:
        db.init_db()
        if cloud.status()["signed_in"] and not force:
            pending = pending_changes()
            if pending:
                raise UnsyncedChanges(pending)
        result = cloud.sign_out()
        conn = _connect()
        try:
            _clear_account_data(conn)
        finally:
            conn.close()
        _save_state({})
    return result


def delete_account(confirm: str) -> dict:
    """Delete the account on the server, then clear its data from this
    computer. Changes not uploaded yet go too: they belonged to the account."""
    with _run_lock:
        cloud.delete_account(confirm)
        db.init_db()
        conn = _connect()
        try:
            _clear_account_data(conn)
        finally:
            conn.close()
        _save_state({})
    return cloud.status()


# --------------------------------------------------------------------------- #
# background thread
# --------------------------------------------------------------------------- #
def nudge():
    """Something changed: sync soon."""
    _wake.set()


def _loop():
    time.sleep(3)  # let the app finish starting
    while True:
        if cloud.configured() and cloud.status()["signed_in"]:
            run_once()
        woke = _wake.wait(INTERVAL)
        if woke:
            time.sleep(DEBOUNCE)
            _wake.clear()


def start():
    """Start the background sync once per process."""
    global _thread
    if _thread is None:
        _thread = threading.Thread(target=_loop, name="muhurata-sync", daemon=True)
        _thread.start()
