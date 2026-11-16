# Overnight work log (branch `improve/overnight-polish`)

Started 17 Nov 2026 from `main` at v1.18.0. Nothing here touched `main`, a tag, a release or
live data. No version bump and no release notes yet: add those when you decide what to keep.

To look at it: `python app.py` style preview (no account needed):

```bash
MUHURATA_SUPABASE_URL= MUHURATA_DATA_DIR=/tmp/muhurta-try .venv/bin/python -m flask --app app.py run --port 8140
```

Phone layout: add `MUHURATA_MOBILE_PREVIEW=1` in front.

## Done

1. **Dashboard: today, the last 7 days, weekdays and months.** A ring shows today's focus
   against the daily goal; bars show each of the last 7 days with the goal as a dashed line and
   a line comparing with the 7 days before. Two new panels at the bottom: average focus by
   weekday (strongest day marked) and total focus by month. All drawn from numbers the
   dashboard already loads, so computers and phones get it with no data change. On phones the
   "Recent days" list is hidden, since the bars show the same days.
   Checked: desktop browser (dark), iPhone simulator (light).

## Ideas not done yet

(see the end of this file as the list grows)
