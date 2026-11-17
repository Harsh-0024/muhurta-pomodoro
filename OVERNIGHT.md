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
   match, and a timer can't pass 24 hours. The "+" key adds a minute (listed under Keyboard). Also: while paused, "left" could show one second
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

8. **Dashboard: by time of day.** A third pattern panel under weekdays and months: 24 bars,
   one per hour, showing when your focus fell over the last 60 days, with the busiest hour
   marked and the best three hours in a row named ("Most between 9:00 AM and 12:00 PM").
   Uses `/api/activity/history`, which computers and phones already answer.
   Checked: desktop browser (dark), iPhone simulator (light).

9. **Rhythm fixes**
   - With a dialog open on Rhythm ("Reset session?", the shortcut list, What's new), the
     timer's keys still worked behind it: Space paused or resumed the timer instead of
     pressing the button it was on, and S, T, K, B acted too. Keys now belong to the dialog
     while it is open (Timer and Flow already did this).
   - Space no longer scrolls the Rhythm page in a short window.
   - With "Auto-start rest" on, the notification before the long break said "starting short
     rest". It now says "long rest".
   Checked: desktop browser (keys), by reading (notification text).

10. **Today's focus under the clock.** Rhythm, Timer and Flow show a quiet line under the
    clock: "Today 1h 12m of 2h", with a thin gold line filling toward your daily goal ("goal
    reached" once you pass it). It counts what is logged today plus the block running right
    now, so it moves while you work. A tap opens the Dashboard. New file `static/js/today.js`;
    it uses `/api/activity/day` and `/api/settings`, which phones already answer.
    Checked: desktop browser (dark), iPhone simulator (light).
    If you would rather keep the clock pages bare, removing the one `today.js` line in
    `templates/base.html` takes it away.

11. **Tests for the Timer.** `tests/clocks.test.mjs` runs the real `timer-core.js` in Node with
    a stand-in page and a clock it can move: adding time while running, paused and ringing,
    the 24-hour cap, and pausing when another clock starts. It also covers the quick
    lengths under the Timer (how blocks are counted and which six lengths show). It is added to the Tests workflow.

12. **Flow and Timer say what they saved.** Stopping Flow sent the clock back to 00:00 with no word on
    what happened to the time. It now shows "Saved: 42 min of focus." for a few seconds
    (only for a minute or more). The Timer does the same when you cancel part-way or stop
    its overtime: "Cancelled. 12 min of focus saved." Checked: desktop browser.

13. **History: moments under a minute are folded away.** A day's list was crowded with
    seconds-long entries (a pause tapped twice, a 3-second overtime): in the test copy of your
    data, 31 of 130 rows. Each day now lists only what lasted a minute or more, with a line
    under it: "9 moments under a minute · Show". Show brings them all back, and the choice is
    remembered. They still count in the totals and still show on the day's strip.
    Checked: desktop browser, iPhone simulator.

## If you release this: lines for "What's new"

Drafts for `release_notes.py`, in the voice of the existing notes. Use, change or drop them.

```python
"The Dashboard shows more: today against your goal, the last 7 days, your average by weekday, each month's total, and when in the day you focus. Tap a day to see its sittings on a timeline.",
"Rhythm, Timer and Flow show today's focus under the clock, filling toward your daily goal.",
"Timer: add 1 or 5 minutes without cancelling (or press +). Cancelling part-way, and stopping Flow, now say how much focus was saved.",
"Fixes: a Rhythm block ending while the Flow page was open now chimes and moves on; keys no longer reach the timer behind an open dialog; Flow stopped in one window stops in the others; light mode on the Dashboard uses the light colours.",
"In History, entries shorter than a minute are tucked under each day; \"Show\" brings them back.",
only(COMPUTERS, "A mistyped address now shows the app's own page instead of a bare error."),
```

## Good to know before merging

- The unmerged "Activities" branch (`ccr-fa74c739-y3z13x`) and this one both add styles at the
  end of `static/css/app.css` and both add to `dashboard.js`, `dashboard.html`, `history.js`
  and `base.html`. Git will ask for a hand where they meet (keep both sides each time; they
  don't change the same lines' meaning). That branch is also behind `main` in `db.py`,
  `release_notes.py` and the tests workflow, independent of anything here.
- No version bump or release note is in this branch: nothing ships until you choose.

## Ideas not done yet

(see the end of this file as the list grows)
