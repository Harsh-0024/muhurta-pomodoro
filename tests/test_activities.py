"""Activities, end to end on the computer: the picker's list, labelling each
session with what the picker shows, relabelling from History, the dashboard's
"Where your time went" and its filter, and the CSV. The same checks run on the
phones' copy in tests/phone (activities test).

Runs the real app (Flask test client, real database) in a throwaway data
folder, without an account.

    .venv/bin/python tests/test_activities.py

Prints PASS / FAIL per check and exits non-zero if anything failed.
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ["MUHURATA_DATA_DIR"] = tempfile.mkdtemp(prefix="muhurta-test-")
os.environ["MUHURATA_SUPABASE_URL"] = ""  # no account: every page is open
os.environ["MUHURATA_NO_BROWSER_OPEN"] = "1"
sys.path.insert(0, str(ROOT))

import activities as acts  # noqa: E402
import app  # noqa: E402
import db  # noqa: E402
import sync  # noqa: E402

failures = 0


def check(ok, what):
    global failures
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        failures += 1


c = app.app.test_client()
now = datetime.now(timezone.utc)
today = datetime.now().date().isoformat()


def iso(d: datetime) -> str:
    return d.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def seg(kind, ago_min, minutes, details=None):
    start = now - timedelta(minutes=ago_min)
    body = {"kind": kind, "day": today, "started_at": iso(start),
            "ended_at": iso(start + timedelta(minutes=minutes)), "duration_sec": minutes * 60}
    if details is not None:
        body["details"] = details
    r = c.post("/api/activity/segment", json=body)
    assert r.status_code == 201, r.json
    return r.json


def pick(aid):
    return c.put("/api/activities/current", json={"id": aid})


print("-- the list")
r = c.get("/api/activities")
check(r.json["activities"] == [] and r.json["current"] is None and r.json["intro_done"] is False, "nothing at first")
r = c.put("/api/activities", json={"activities": [{"name": "Work"}, {"name": " Learning   Python "}], "intro_done": True})
ids = {a["name"]: a["id"] for a in r.json["activities"]}
check(r.status_code == 200 and set(ids) == {"Work", "Learning Python"}, "names are tidied and get ids")
check(r.json["intro_done"] is True, "the first-run card is done")
check(c.put("/api/activities", json={"activities": [{"name": "focus"}]}).status_code == 400, "Focus is taken")
check(c.put("/api/activities", json={"activities": [{"name": "All Focus"}]}).status_code == 400, "All focus is taken")
check(c.put("/api/activities", json={"activities": [{"name": "A"}, {"name": "a"}]}).status_code == 400, "no twins")
check(c.put("/api/activities", json={"activities": [{"name": ""}]}).status_code == 400, "a name is needed")
check(pick("a-nothere").status_code == 400, "only a known activity can be picked")
colors = {a["color"] for a in c.get("/api/activities").json["activities"]}
check(len(colors) == 2, "each gets its own color")

print("-- sessions")
pick(ids["Learning Python"])
check(seg("work", 300, 48)["details"]["activity"]["name"] == "Learning Python", "a rhythm block counts for what is picked")
pick(ids["Work"])
work = seg("timer", 200, 24)
check(work["details"]["activity"]["id"] == ids["Work"], "so does a timer")
pick("focus")
plain = seg("flow", 100, 30)
check("activity" not in plain["details"], "Focus: no activity on the session")
check("activity" not in seg("timer", 50, 10, {"activity": None})["details"], "a clock can say plain Focus")
check(seg("timer", 20, 5, {"activity": "Work"})["details"] == {}, "a malformed activity is dropped")

r = c.put(f"/api/activity/segment/{plain['id']}/activity", json={"id": ids["Work"]})
check(r.status_code == 200 and r.json["details"]["activity"]["name"] == "Work", "History: relabel a session")
r = c.put(f"/api/activity/segment/{plain['id']}/activity", json={"id": "focus"})
check("activity" not in r.json["details"], "History: back to Focus")
check(c.put(f"/api/activity/segment/{plain['id']}/activity", json={"id": "a-nothere"}).status_code == 400,
      "History: only known activities")
check(c.put("/api/activity/segment/999999/activity", json={"id": "focus"}).status_code == 404, "History: no such session")

print("-- the picker's order")
r = c.get("/api/activities").json
check([(a["name"], a["recent_min"], a["group"]) for a in r["activities"]]
      == [("Learning Python", 48.0, "main"), ("Work", 24.0, "main")], "most used lately first")
d = date.today()
state = acts.picker([{"id": f"a-{i}", "name": f"N{i}", "color": "#000000", "created": d.isoformat()} for i in range(8)]
                    + [{"id": "a-old", "name": "Old", "color": "#000000", "created": "2020-01-01"}], [], "", d)
check([a["group"] for a in state["activities"]].count("main") == acts.MAIN_COUNT, "six before More")
check(state["activities"][-1]["name"] == "Old" and state["activities"][-1]["older"], "unused for 60 days: under More")

print("-- the dashboard")
year = datetime.now().year


def dash(only=None):
    return c.get(f"/api/dashboard?year={year}" + (f"&activity={only}" if only else "")).json


every = dash()
check(every["summary"]["total_focus_minutes"] == 117.0 and every["activity"] is None, "All focus counts everything")
check([(i["name"], i["minutes"]) for i in every["activities"]["week"]["items"]]
      == [("Learning Python", 48.0), ("Focus", 45.0), ("Work", 24.0)], "where your time went, biggest first")
check(every["activities"]["week"]["total_minutes"] == 117.0, "the slices add up to All focus")
check(dash(ids["Work"])["summary"]["total_focus_minutes"] == 24.0, "one activity alone")
check(dash(ids["Work"])["activity"]["name"] == "Work", "and which one it is")
check(dash("focus")["summary"]["total_focus_minutes"] == 45.0, "Focus alone: the sessions without one")
check(c.get("/api/dashboard?activity=Bad!").status_code == 400, "a bad filter is refused")

print("-- the CSV")
csv = c.get("/api/backup/sessions.csv").get_data(as_text=True)
check(csv.splitlines()[0].endswith(",Activity"), "an Activity column")
check(",Learning Python\r\n" in csv and ",Focus\r\n" in csv, "focus sessions are named")

print("-- renaming")
lst = [dict(a, name="Python") if a["id"] == ids["Learning Python"] else a for a in c.get("/api/activities").json["all"]]
check(c.put("/api/activities", json={"activities": lst}).status_code == 200, "rename")
check(any(i["name"] == "Python" for i in dash()["activities"]["week"]["items"]), "the dashboard shows the new name")
csv = c.get("/api/backup/sessions.csv").get_data(as_text=True)
check(",Python\r\n" in csv and "Learning Python" not in csv, "so does the CSV")

print("-- removing, and a lost list")
pick(ids["Work"])
lst = [dict(a, removed=a["id"] == ids["Work"]) for a in c.get("/api/activities").json["all"]]
r = c.put("/api/activities", json={"activities": lst}).json
check([a["name"] for a in r["activities"]] == ["Python"], "removed: gone from the picker")
check(r["current"] is None, "and no longer picked")
check(any(i["name"] == "Work" for i in dash()["activities"]["week"]["items"]), "its sessions keep the name")
db.save_settings({"activities": []})  # what an older version on another device can do
# The rename was in the lost list too, so the sessions' own name comes back.
check({a["name"] for a in c.get("/api/activities").json["activities"]} == {"Learning Python", "Work"},
      "a lost list comes back from the sessions")
check("last_activity_id" in sync.LOCAL_ONLY_SETTINGS, "what was picked stays on this computer")

print()
print("ALL PASSED" if not failures else f"{failures} FAILED")
sys.exit(1 if failures else 0)
