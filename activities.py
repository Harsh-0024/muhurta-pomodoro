"""Activities: what a session was spent on ("Learning Python", "Work", ...).

The rules live here, with no database, so app.py and db.py share them and
mobile/web/local-api.js can follow them rule for rule.

- The list is kept in the settings (``activities``), so it reaches every
  device on the account. Each entry: ``{"id", "name", "color", "created"}``,
  plus ``"removed": true`` once taken out of the list (its sessions keep the
  name).
- Each session carries its activity in ``details["activity"]``
  (``{"id", "name", "color"}``). A session without one is plain **Focus**:
  every session from before activities existed, and every one where nothing
  else was picked.
- **All focus** is everything together; Focus is one slice of it.
- What a device picked last (``last_activity_id``) stays on that device, the
  way the volume does: the phone can be for meditation while the computer is
  for work.
- The picker lists what was used most in the last 30 days first. Anything not
  used for 60 days, and anything past the first six, waits under "More".
"""
from __future__ import annotations

import re
import secrets
from datetime import date, timedelta

FOCUS_ID = "focus"
FOCUS_NAME = "Focus"
ALL_NAME = "All focus"
FOCUS_COLOR = "#c9a962"
# Distinct on the dark and the light theme, and in lightness as well as hue.
PALETTE = ("#6fb3a8", "#8fa8e0", "#d9906f", "#b79be0", "#a5c47e", "#e0a3b8", "#7fc4d9", "#d6c36a",
           "#c98f8f", "#8fc9a0")
NAME_MAX = 40
MAX_ACTIVE = 30  # in the list at once
MAX_KEPT = 80  # including removed ones, which keep their sessions' names
MAIN_COUNT = 6  # shown before "More"
RECENT_DAYS = 30  # what "used lately" means for the order
OLDER_AFTER_DAYS = 60  # unused this long: moves under "More"
RESERVED = {FOCUS_NAME.lower(), ALL_NAME.lower()}

_ID_RE = re.compile(r"^[a-z0-9-]{1,40}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class ActivityError(ValueError):
    pass


def new_id() -> str:
    return "a-" + secrets.token_hex(4)


def clean_name(value) -> str:
    return " ".join(str(value or "").split())[:NAME_MAX]


def color_for(index: int) -> str:
    return PALETTE[index % len(PALETTE)]


def key_of(details) -> str:
    """The activity a session counts for: its id, or "focus"."""
    act = details.get("activity") if isinstance(details, dict) else None
    if isinstance(act, dict) and isinstance(act.get("id"), str) and _ID_RE.match(act["id"]):
        return act["id"]
    return FOCUS_ID


def stamp(act: dict) -> dict:
    """What a session keeps of its activity: enough to show it even if the list is lost."""
    return {"id": act["id"], "name": act["name"], "color": act["color"]}


def clean_list(raw, stored: list[dict], today: date) -> list[dict]:
    """Check a whole list sent by the Settings page or the picker.

    Ids the account already has keep their created day; new entries get an id
    and a color. Raises ActivityError with a message for people."""
    if not isinstance(raw, list):
        raise ActivityError("Invalid activities")
    known = {a["id"]: a for a in stored if isinstance(a, dict) and a.get("id")}
    out: list[dict] = []
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    used_colors = {a.get("color") for a in stored}
    for item in raw:
        if not isinstance(item, dict):
            raise ActivityError("Invalid activities")
        name = clean_name(item.get("name"))
        removed = bool(item.get("removed"))
        if not name:
            raise ActivityError("Each activity needs a name")
        if name.lower() in RESERVED:
            raise ActivityError(f"“{name}” is already there: it's the default")
        aid = str(item.get("id") or "")
        if aid and (not _ID_RE.match(aid) or aid == FOCUS_ID):
            raise ActivityError("Invalid activity id")
        if not aid or aid in seen_ids:
            aid = new_id()
        if not removed:
            if name.lower() in seen_names:
                raise ActivityError(f"“{name}” is in the list twice")
            seen_names.add(name.lower())
        color = str(item.get("color") or "")
        if not _COLOR_RE.match(color):
            color = (known.get(aid) or {}).get("color") or next(
                (c for c in PALETTE if c not in used_colors), color_for(len(out)))
        used_colors.add(color)
        entry = {
            "id": aid,
            "name": name,
            "color": color.lower(),
            "created": (known.get(aid) or {}).get("created") or today.isoformat(),
        }
        if removed:
            entry["removed"] = True
        seen_ids.add(aid)
        out.append(entry)
    if sum(1 for a in out if not a.get("removed")) > MAX_ACTIVE:
        raise ActivityError(f"At most {MAX_ACTIVE} activities at once")
    if len(out) > MAX_KEPT:
        # Drop the oldest removed ones first; their sessions keep their names.
        removed = [a for a in out if a.get("removed")]
        drop = {a["id"] for a in removed[: len(out) - MAX_KEPT]}
        out = [a for a in out if a["id"] not in drop]
    return out


def known_list(stored, seen: dict[str, dict]) -> list[dict]:
    """The account's list, plus any activity its sessions name that the list
    lost (an older app version on another device can save the settings
    without it). Removed ones stay removed."""
    out = [dict(a) for a in (stored or []) if isinstance(a, dict) and a.get("id") and a.get("name")]
    have = {a["id"] for a in out}
    for aid, act in seen.items():
        if aid in have or aid == FOCUS_ID:
            continue
        name = clean_name(act.get("name"))
        if not name or name.lower() in RESERVED:
            continue
        color = act.get("color") if _COLOR_RE.match(str(act.get("color") or "")) else color_for(len(out))
        out.append({"id": aid, "name": name, "color": color, "created": act.get("day") or ""})
        have.add(aid)
    return out


def usage(rows, today: date) -> tuple[dict[str, dict], dict[str, dict]]:
    """From sessions (dicts with day, productive_sec, details): per activity,
    focus in the last RECENT_DAYS and the last day used; and what each
    activity's sessions call it (for known_list)."""
    recent_from = (today - timedelta(days=RECENT_DAYS - 1)).isoformat()
    stats: dict[str, dict] = {}
    seen: dict[str, dict] = {}
    for r in rows:
        if float(r.get("productive_sec") or 0) <= 0:
            continue
        details = r.get("details") or {}
        key = key_of(details)
        day = str(r.get("day") or "")
        s = stats.setdefault(key, {"recent_sec": 0.0, "last_day": None})
        if day >= recent_from:
            s["recent_sec"] += float(r["productive_sec"])
        if not s["last_day"] or day > s["last_day"]:
            s["last_day"] = day
            if key != FOCUS_ID:
                seen[key] = {**details["activity"], "day": day}
    return stats, seen


def picker(stored, rows, current_id: str, today: date) -> dict:
    """GET /api/activities: the list in the picker's order, and what is picked."""
    stats, seen = usage(rows, today)
    everything = known_list(stored, seen)
    older_from = (today - timedelta(days=OLDER_AFTER_DAYS)).isoformat()
    active = []
    for a in everything:
        if a.get("removed"):
            continue
        s = stats.get(a["id"], {})
        last = s.get("last_day")
        active.append({
            "id": a["id"], "name": a["name"], "color": a["color"],
            "recent_min": round(s.get("recent_sec", 0) / 60, 1),
            "last_day": last,
            "older": (last or a.get("created") or "") < older_from,
        })
    active.sort(key=lambda a: (a["older"], -a["recent_min"], a["last_day"] is None,
                               "" if a["last_day"] is None else _desc(a["last_day"]), a["name"].lower()))
    main = [a for a in active if not a["older"]][:MAIN_COUNT]
    main_ids = {a["id"] for a in main}
    for a in active:
        a["group"] = "main" if a["id"] in main_ids else "more"
    current = next((a for a in active if a["id"] == current_id), None)
    return {
        "focus": {"id": FOCUS_ID, "name": FOCUS_NAME, "color": FOCUS_COLOR},
        "activities": active,
        "all": [{"id": a["id"], "name": a["name"], "color": a["color"], "removed": bool(a.get("removed"))}
                for a in everything],
        "current": {"id": current["id"], "name": current["name"], "color": current["color"]} if current else None,
    }


def _desc(day: str) -> str:
    # Sort newest first inside an ascending sort: invert each digit.
    return day.translate(str.maketrans("0123456789", "9876543210"))


def find(stored, aid: str) -> dict | None:
    for a in stored or []:
        if isinstance(a, dict) and a.get("id") == aid and not a.get("removed"):
            return a
    return None
