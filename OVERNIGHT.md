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

2. **Dashboard: open a day.** Click (or tap) a square of the year, a bar of the last 7 days or
   a row of Recent days: a sheet shows that day's focus, rest and number of sittings, a strip
   of when in the day they happened, and each sitting with its times and which clock it was.
   Arrow buttons (and the left and right keys) step to the day before or after; Escape closes.
   Uses `/api/activity/day`, which computers and phones both already answer.
   Checked: desktop (dark and light), iPhone simulator.

3. **Fixes found on the way**
   - Keyboard focus ring: a stray `.choice-actions` in front of the rule meant the gold ring
     only showed on buttons inside a choice row. Now every button and dialog close shows it.
   - Light theme on the dashboard: the rule for the light green palette was written as
     `body[data-theme="light"] .page-dashboard` (the body *is* `.page-dashboard`), so it never
     matched and light mode drew with the dark palette. Fixed for "light" and "system".
   - "Are you sure?" dialog: Enter pressed while the Cancel button had focus chose Continue.
     Enter on Cancel now cancels.

4. **Clock fixes (Timer and Flow)**
   - Flow open in two windows: stopping it in one left it running in the other, and that
     window's next save brought the stopped flow back. The other window now stops too.
   - Pressing Start (or Space) twice quickly on Timer or Flow could start the clock twice while
     the other clocks were still being paused, resetting its start. The second press is ignored.
   - A Rhythm focus block that ended while the Flow page was open (Flow not started) gave no
     chime and did not move on to the break until you left the page; the Flow page was left
     out of the background check every other page has. It is covered now, and the window
     title shows the Rhythm countdown there too. A running Flow still owns its own title.
   Checked in the desktop browser.

5. **Timer: "+1 min" and "+5 min".** Under a running or paused Timer, where the quick lengths
   sit before you start, two small buttons add time without cancelling. On a ringing timer
   ("Ring until dismissed") they start it counting again for that long. "Set for" grows to
   match, and a timer can't pass 24 hours. Also: while paused, "left" could show one second
   less than the big clock (29:57 against 29:58); they now agree.
   Checked: desktop browser, iPhone simulator.

6. **Day view: "Edit in History" opens that day.** The link in the dashboard's day sheet used
   to open History at today. It now loads back to the day you were looking at, scrolls to it
   and outlines it for a moment (or says nothing was timed that day).
   Checked: desktop browser.

7. **A page for mistyped addresses (computers).** An address that doesn't exist (for example
   `/history`) showed the server's bare white "Not Found". It now shows the app's own page
   with links to Rhythm and the Dashboard. Data addresses (`/api/...`) still answer as before.
   Checked: desktop browser.

## Ideas not done yet

(see the end of this file as the list grows)
