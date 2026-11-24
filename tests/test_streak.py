"""The Dashboard's current streak on the computer (db.dashboard_summary).

Today isn't over, so with no focus yet it neither adds to the run nor breaks it: the streak shows
the run up to yesterday until you focus. A whole day that ended without focus still ends it, and
so does a day with under a minute of it.
(The phone app's copy of this rule is checked in tests/phone/phone.test.mjs.)

    python tests/test_streak.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = tempfile.mkdtemp(prefix="muhurta-test-")
Path(DATA, "focus_timer.db").touch()  # an empty database of its own
os.environ["MUHURATA_DATA_DIR"] = DATA
os.environ["MUHURATA_NO_BROWSER_OPEN"] = "1"
sys.path.insert(0, str(ROOT))

import backup  # noqa: E402
import db  # noqa: E402

failures: list[str] = []


def check(ok, label):
    print(("PASS " if ok else "FAIL ") + label)
    if not ok:
        failures.append(label)


TODAY = datetime.now(timezone.utc).date()


def day(back: int) -> str:
    return (TODAY - timedelta(days=back)).isoformat()


def focus_on(d: str) -> dict:
    return {
        "uuid": str(uuid.uuid4()), "day": d, "kind": "work", "started_at": f"{d}T09:00:00Z",
        "ended_at": f"{d}T09:25:00Z", "duration_sec": 1500, "productive_sec": 1500, "rest_sec": 0,
        "preset_id": "", "preset_name": "", "phase_index": None, "details_json": "{}",
        "created_at": f"{d} 09:25:00", "device_id": "",
    }


def restore(days: list[str]) -> None:
    backup.restore({"app": "muhurta-pomodoro", "kind": "backup", "format": 1, "custom_presets": [],
                    "focus_by_device": [], "settings": {}, "activity_segments": [focus_on(d) for d in days]})


def streak(end_back: int = 0) -> int:
    return db.dashboard_summary(end_day_iso=day(end_back), days=30, timezone_name="UTC")["summary"]["current_streak"]


restore([day(2), day(1)])
s = streak()
check(s == 2, f"nothing yet today: the run up to yesterday still shows (got {s}, want 2)")

restore([day(0)])
s = streak()
check(s == 3, f"a focus block today adds to it (got {s}, want 3)")

s = streak(3)
check(s == 0, f"a day that is over without focus (3 days ago) ends the run there (got {s}, want 0)")

# A few seconds (a timer started by mistake) isn't a day of focus: under a minute doesn't count.
blip = focus_on(day(3))
blip.update({"ended_at": f"{day(3)}T09:00:20Z", "duration_sec": 20, "productive_sec": 20})
backup.restore({"app": "muhurta-pomodoro", "kind": "backup", "format": 1, "custom_presets": [],
                "focus_by_device": [], "settings": {}, "activity_segments": [blip]})
s = streak(3)
check(s == 0, f"20 seconds of focus doesn't make a day active (got {s}, want 0)")
summary = db.dashboard_summary(end_day_iso=day(0), days=30, timezone_name="UTC")["summary"]
check(summary["active_days"] == 3, f"nor count among the active days (got {summary['active_days']}, want 3)")

print()
print("ALL PASSED" if not failures else f"{len(failures)} FAILED: " + "; ".join(failures))
sys.exit(1 if failures else 0)
