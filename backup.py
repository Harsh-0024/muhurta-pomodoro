"""A backup file of the account's data, and putting one back (Settings -> History).

The file holds the rows the account holds on the server, in the same shape
(see ROW_TABLES in sync.py), so a backup made on any device - computer or
phone - restores on any other. mobile/web/local-api.js does the same, rule
for rule; when one changes, change the other.

Restoring adds back what is missing (sessions, combinations, a day's focus
total per device) and never changes anything still here, so restoring an old
backup can't undo later edits. What it adds is stamped as a change made now,
so it uploads and reaches every device, even if it had been deleted. The
settings come back only where none were ever chosen here.

The CSV is for spreadsheets: one line per session, in this computer's time.
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
from datetime import datetime, timezone

import cloud
import db
import sync
from version import __version__

FORMAT = 1
KIND_NAMES = {"work": "Focus", "extend": "Overtime", "timer": "Timer", "flow": "Flow",
              "rest": "Rest", "cumulative": "Rest pool", "pause": "Pause"}
MAX_ROWS = 200_000  # far beyond any real history; refuses a wrong or hostile file


class BadBackup(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def export() -> dict:
    db.init_db()
    conn = sync._connect()
    try:
        data = {"app": "muhurta-pomodoro", "kind": "backup", "format": FORMAT,
                "exported_at": _now(), "app_version": __version__, "email": cloud.status().get("email")}
        for table, cols in sync.ROW_TABLES.items():
            rows = conn.execute(f"SELECT uuid, updated_at, {', '.join(cols)} FROM {table} "
                                "WHERE uuid IS NOT NULL ORDER BY id").fetchall()
            data[table] = [dict(r) for r in rows]
        data["focus_by_device"] = [dict(r) for r in conn.execute(
            "SELECT day, device_id, minutes, updated_at FROM focus_by_device ORDER BY day, device_id")]
        row = conn.execute("SELECT json FROM app_settings WHERE id = 1").fetchone()
        mine = json.loads((row["json"] if row else None) or "{}")
        data["settings"] = {k: v for k, v in mine.items() if k not in sync.LOCAL_ONLY_SETTINGS}
    finally:
        conn.close()
    return data


def sessions_csv() -> str:
    data = export()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Date", "Kind", "Started", "Ended", "Minutes", "Focus minutes", "Rest minutes", "Combination"])
    for r in sorted(data["activity_segments"], key=lambda r: r["started_at"] or ""):
        w.writerow([r["day"], KIND_NAMES.get(r["kind"], r["kind"]), _local(r["started_at"]), _local(r["ended_at"]),
                    _minutes(r["duration_sec"]), _minutes(r["productive_sec"]), _minutes(r["rest_sec"]),
                    r["preset_name"] or ""])
    return out.getvalue()


def _local(iso: str | None) -> str:
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return iso or ""


def _minutes(sec) -> str:
    return f"{(sec or 0) / 60:.1f}"


def _rows(data: dict, key: str) -> list[dict]:
    rows = data.get(key) or []
    if not isinstance(rows, list) or len(rows) > MAX_ROWS or not all(isinstance(r, dict) for r in rows):
        raise BadBackup("This backup file is damaged.")
    return rows


def restore(data) -> dict:
    """Put back what is missing from a backup (see the top of this file).
    Returns how much came back."""
    if not isinstance(data, dict) or data.get("app") != "muhurta-pomodoro" or data.get("kind") != "backup":
        raise BadBackup("That isn't a Muhurta backup file.")
    if not isinstance(data.get("format"), int) or data["format"] > FORMAT:
        raise BadBackup("This backup comes from a newer version of the app. Update first, then restore it.")
    added = {"sessions": 0, "combinations": 0, "days": 0, "settings": False}
    stamp = _now()
    db.init_db()
    with sync._run_lock:
        conn = sync._connect()
        try:
            for table, label in (("activity_segments", "sessions"), ("custom_presets", "combinations")):
                cols = sync.ROW_TABLES[table]
                for r in _rows(data, table):
                    uid = r.get("uuid")
                    if not isinstance(uid, str) or not uid or \
                            conn.execute(f"SELECT 1 FROM {table} WHERE uuid = ?", (uid,)).fetchone():
                        continue
                    try:
                        conn.execute(
                            f"INSERT INTO {table} (uuid, {', '.join(cols)}, updated_at, synced_version) "
                            f"VALUES ({', '.join('?' * (len(cols) + 3))})",
                            (uid, *[r.get(c) for c in cols], stamp, None))
                    except sqlite3.Error:  # a row the database refuses (missing fields)
                        continue
                    conn.execute("DELETE FROM sync_tombstones WHERE table_name = ? AND uuid = ?", (table, uid))
                    added[label] += 1
            for r in _rows(data, "focus_by_device"):
                try:
                    cur = conn.execute(
                        "INSERT INTO focus_by_device (day, device_id, minutes, updated_at, synced_version) "
                        "VALUES (?, ?, ?, ?, NULL) ON CONFLICT (day, device_id) DO NOTHING",
                        (str(r["day"]), str(r["device_id"]), int(r["minutes"]), stamp))
                except (KeyError, TypeError, ValueError, sqlite3.Error):
                    continue
                added["days"] += cur.rowcount
            settings = data.get("settings")
            if isinstance(settings, dict) and settings and not sync._has_own_settings(conn):
                row = conn.execute("SELECT json FROM app_settings WHERE id = 1").fetchone()
                mine = json.loads((row["json"] if row else None) or "{}")
                merged = {k: v for k, v in settings.items() if k not in sync.LOCAL_ONLY_SETTINGS}
                merged.update({k: mine[k] for k in sync.LOCAL_ONLY_SETTINGS if k in mine})
                conn.execute("UPDATE app_settings SET json = ? WHERE id = 1", (json.dumps(merged),))
                added["settings"] = True
            conn.commit()
        finally:
            conn.close()
    sync.nudge()
    return added
