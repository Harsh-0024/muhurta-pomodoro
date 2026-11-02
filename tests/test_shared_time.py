"""Time two devices both recorded is counted once, and work beats rest.

Puts the sessions of each case in tests/shared_time_cases.json into a
throwaway data folder (through a backup restore, the way synced sessions
from other devices arrive) and checks the day's totals and the dashboard.

    .venv/bin/python tests/test_shared_time.py

Prints PASS / FAIL per check and exits non-zero if anything failed.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = tempfile.mkdtemp(prefix="muhurta-test-")
Path(DATA, "focus_timer.db").touch()  # an empty database, not the repo's old data/ copy
os.environ["MUHURATA_DATA_DIR"] = DATA
os.environ["MUHURATA_NO_BROWSER_OPEN"] = "1"
sys.path.insert(0, str(ROOT))

import backup  # noqa: E402
import db  # noqa: E402

CASES = json.loads((ROOT / "tests" / "shared_time_cases.json").read_text())["cases"]
DEVICES = {}  # device name in the cases -> a real-looking device id
failures: list[str] = []


def check(ok, label):
    print(("PASS " if ok else "FAIL ") + label)
    if not ok:
        failures.append(label)


def segment(day, kind, device, start, end):
    started_at, ended_at = f"{day}T{start}:00Z", f"{day}T{end}:00Z"
    h1, m1 = map(int, start.split(":"))
    h2, m2 = map(int, end.split(":"))
    seconds = ((h2 * 60 + m2) - (h1 * 60 + m1)) * 60
    work = kind in db.PRODUCTIVE_KINDS
    return {
        "uuid": str(uuid.uuid4()), "day": day, "kind": kind, "started_at": started_at, "ended_at": ended_at,
        "duration_sec": seconds, "productive_sec": seconds if work else 0, "rest_sec": 0 if work else seconds,
        "preset_id": "", "preset_name": "", "phase_index": None, "details_json": "{}",
        "created_at": f"{day} {end}:00", "device_id": DEVICES.setdefault(device, str(uuid.uuid4())),
    }


for case in CASES:
    day = case["day"]
    data = {"app": "muhurta-pomodoro", "kind": "backup", "format": 1, "custom_presets": [],
            "focus_by_device": [], "settings": {},
            "activity_segments": [segment(day, *s) for s in case["sessions"]]}
    check(backup.restore(data)["sessions"] == len(case["sessions"]), f"{case['name']}: sessions restored")

    body = db.activity_for_day(day)
    totals = body["totals"]
    focus, rest = round(totals["productive_sec"] / 60, 1), round(totals["rest_sec"] / 60, 1)
    check((focus, rest) == (case["focus"], case["rest"]),
          f"{case['name']}: day counts {focus} focus, {rest} rest (want {case['focus']}, {case['rest']})")
    check(len(body["segments"]) == len(case["sessions"]), f"{case['name']}: every session still listed")

    summary = db.dashboard_summary(end_day_iso=day, days=7, timezone_name="UTC")
    record = next(d for d in summary["days"] if d["day"] == day)
    check((record["focus_minutes"], record["rest_minutes"]) == (case["focus"], case["rest"]),
          f"{case['name']}: dashboard counts {record['focus_minutes']} focus, {record['rest_minutes']} rest")

print()
print("ALL PASSED" if not failures else f"{len(failures)} FAILED: " + "; ".join(failures))
sys.exit(1 if failures else 0)
