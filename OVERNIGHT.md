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

14. **"Last synced" says the right hour.** Settings' sync line rounded, so 59½ minutes read
    "60 min ago" and 23½ hours "24 h ago"; it now rounds down ("59 min ago", "1 h ago"), and a
    missing time no longer shows "Invalid Date". The admin page's "ago" got the same fix, and a
    day back reads "yesterday" instead of "1 days ago". Checked that Settings loads cleanly.

15. **History: Undo after deleting a session.** Deleting a session now shows "Session deleted"
    with an Undo button for 8 seconds; Undo saves the same session again (same kind, times,
    preset and details) through the clocks' own save, so it works on phones too and syncs as a
    new row. The question before deleting no longer says "This cannot be undone."
    Found on the way: the toast at the bottom of History and Settings sat under the page footer
    (the footer's text showed through it and it caught taps); the toast now sits above it.
    Checked on desktop and the iPhone simulator (deleted a test session, undid it, all its
    details came back); on the phone "Session deleted" wrapped onto two lines, now one.

16. **A phone turned sideways.** With the phone on its side, the clock (Rhythm, Timer and Flow)
    was pushed below the tab bar: only the top of the ring showed, and the time was hidden. Now
    the ring sits on the left with the times, buttons and today's total beside it, the top bar
    scrolls away, the tabs put their icon and name side by side, and the quote waits until the
    phone is upright. Only phones on their side (under 520 points tall) change. Checked on the
    iPhone simulator on its side (all three clocks) and upright (unchanged).

17. **Browsers always get the newest scripts and styles.** Pages ask for `app.css?v=…`, where the
    number changes when the files do, so a browser never keeps an old copy. The number only
    followed some files: changes to `mobile.css`, `timer.js`, `today.js` and a dozen others
    didn't move it, so after an update a browser could run an old Timer with new pages. It now
    follows every script and stylesheet. Found while checking item 16.

18. **Safari's bars match the page.** In dark mode on the iPhone, Safari's strip behind the clock
    and its bottom toolbar stayed light on some pages (History, for one), framing the dark page in
    white. The pages now say which colours they use (`color-scheme` and `theme-color`, light, dark
    or following the phone), and `theme-color.js` keeps that in step when the theme is changed in
    Settings. A side benefit: the calendar icons in date boxes now show on the dark pages.
    Checked on the iPhone simulator in dark mode, and switching themes on the computer.

19. **Keyboard focus shows on the top bar.** Tabbing through a page with the keyboard, the page
    links and the level button only got their hover tint, and on the current page's gold tab
    nothing changed at all, so you couldn't tell where you were. They now get the same soft gold
    ring as the other buttons. A check that focuses every control on every page and compares its
    look before and after found only these; all 143 controls now show focus. Checked on the
    computer with real Tab presses.

20. **Each page has its own title.** Every page already named itself (Timer, Dashboard, History…)
    but the shared layout never used it, so every browser tab, history entry and Windows window
    read "Muhurta Pomodoro". They now read "Dashboard · Muhurta Pomodoro" and so on (Rhythm,
    Timer and Flow still show the time while a clock runs). When a clock stops, the title goes
    back to the page's own name instead of the bare app name. Checked on the computer.

21. **Every page has a main heading for screen readers.** Rhythm, Timer, Flow and the Dashboard
    had no main heading (h1), so a screen reader's list of headings started at the dashboard's
    cards, or, on the clocks, held only the hidden dialogs' titles. Each now has one naming the
    page, read aloud but not shown. Liftbook's 21 screens were already right. Checked that
    nothing moves, on the computer and the iPhone simulator (upright and on its side).

22. **Pop-ups keep keyboard focus.** With a pop-up open (the shortcuts guide, "Are you sure?",
    a day on the Dashboard, a session in History, What's new), Tab walked straight out into the
    page behind it, and closing one could leave focus nowhere, so the next Tab started from the
    top of the page. Now Tab and Shift+Tab go round inside the open pop-up, and closing it
    returns focus to what you were on. One small script (`modal-focus.js`) covers every pop-up.
    Liftbook's use the browser's own dialogs, which already did this. Checked on the computer
    with real Tab, Shift+Tab and Escape presses on all five: the shortcuts guide, "Are you
    sure?", a Dashboard day, a History session (Tab steps through each date box's parts, then
    on round) and What's new (shown with a stand-in reply, so the real one stays unseen).

23. **Screen readers no longer read the clock aloud every second.** The row of figures above each
    clock (rest pool, work done, elapsed, productivity…) was marked to be announced whenever it
    changed, and while a clock runs some of those change every second, so a screen reader would
    keep talking through your focus. The row is now read only when you move to it. Messages that
    matter (saved, cancelled, time's up) keep their own announcements. Liftbook's announcements
    were already only on changes you cause.

24. **Easier to tap on a phone: the little "i" and the Timer's quick lengths.** Measuring every
    button on the phone pages found the "i" beside Rhythm profile (which opens its explanation)
    was an 18-point circle, and the Timer's quick lengths (6, 12, 24…) were 30 points tall. On
    touch screens each now answers to a finger-sized area around it; they look exactly as before
    and nothing moves. Checked on the iPhone simulator: a tap just outside the "i" opens it.

25. **Tapping a box on an iPhone no longer zooms the page in.** iPhone Safari zooms in on any
    text box or pick list smaller than 16px and doesn't zoom back out. Every box in Settings
    (combination name and lengths, bells, profile, two-step code, delete check, feedback) was 14 to 15px.
    On touch screens they are now 16px. The combination's Name box also offered to fill in your
    own name from your contact card; it no longer does. Checked on the iPhone simulator, and
    saving a combination still works.

26. **Usernames aren't autocorrected on a phone.** Username boxes (sign-up, finishing sign-up,
    and Settings) already skipped the capital letter, but the phone's autocorrect still ran, so
    "harshb" could turn into a real word as you typed. It's off on those boxes now. The other boxes
    already brought up the right keyboard (numbers for lengths and codes, the email keyboard for
    emails). The Timer's length box keeps the full keyboard, because the iPhone number pad has
    no ":" for "m:ss".

27. **A long combination name no longer pushes the page sideways on a phone.** A combination can
    have a name of up to 80 characters. Picked, it filled the level button in the top bar, which
    then ran off the right edge, so the whole page could be dragged sideways. The button now ends
    a long name in "…" (the menu still shows it in full), and the brand beside it keeps its size.
    Inside the ring, the "Session 1 of 4 · name" line now stays clear of the ring itself, two
    lines at most. Built-in names look as before. Found by putting long names into every
    screen of both apps (Liftbook had nothing to fix). Checked on the iPhone simulator with a
    real long-named combination, deleted afterwards.

28. **The Dashboard for someone who has just started.** With no focus yet this year, the page was
    a wall of zeros, and Consistency read "0 of 321 days", as if every day since 1 January had
    been missed (once you focus, it counts from your first day). Now a short welcome sits on top:
    what fills the page in, and a "Start a session" button. The consistency note says "No focus
    yet in 2026". Both go away with the first session. Found by running a copy of the app with an
    empty data folder and reading every page: Rhythm, Timer, Flow and Settings already read well.
    Checked on the iPhone simulator (empty) and on desktop with sessions.

29. **A chosen tab stays gold.** In two-way pickers (History's "By day / Unusually long" and the
    others built the same way), the chosen one is gold. But the pointer style outranked it, so on
    a phone the tab you had just tapped turned a faint white (a tapped button keeps the pointer
    look), and on a computer it did the same while the mouse rested on it. The chosen one now
    stays gold. Found while checking History with no sessions (its empty pages already read
    well). Checked on the iPhone simulator. A later sweep of both apps, comparing every chosen
    tab, chip and option with and without the pointer over it, found no other case (Liftbook's
    chips were already right).

## If you release this: lines for "What's new"

Drafts for `release_notes.py`, in the voice of the existing notes. Use, change or drop them.

```python
"The Dashboard shows more: today against your goal, the last 7 days, your average by weekday, each month's total, and when in the day you focus. Tap a day to see its sittings on a timeline.",
"Rhythm, Timer and Flow show today's focus under the clock, filling toward your daily goal.",
"Timer: add 1 or 5 minutes without cancelling (or press +). Cancelling part-way, and stopping Flow, now say how much focus was saved.",
"Fixes: a Rhythm block ending while the Flow page was open now chimes and moves on; keys no longer reach the timer behind an open dialog; Flow stopped in one window stops in the others; light mode on the Dashboard uses the light colours.",
"In History, entries shorter than a minute are tucked under each day; \"Show\" brings them back.",
only(COMPUTERS, "A mistyped address now shows the app's own page instead of a bare error."),
"Deleted a session in History by mistake? Tap Undo on the message that follows.",
only(PHONES, "Turn your phone on its side and the clock sits beside its buttons, all on one screen."),
```

## Good to know before merging

- The unmerged "Activities" branch (`ccr-fa74c739-y3z13x`) and this one both add styles at the
  end of `static/css/app.css` and both add to `dashboard.js`, `dashboard.html`, `history.js`
  and `base.html`. Git will ask for a hand where they meet (keep both sides each time; they
  don't change the same lines' meaning). That branch is also behind `main` in `db.py`,
  `release_notes.py` and the tests workflow, independent of anything here.
- No version bump or release note is in this branch: nothing ships until you choose.
- The three Python test files in `tests/` are scripts that each replace the sign-in service for
  the whole run, so run them one at a time (`python tests/test_sign_in.py`, and the same for
  `test_shared_time.py` and `test_devices.py`). All three pass that way. Running them together
  with `python -m unittest discover` makes them clash and fail, on `main` too.

## Ideas not done yet

(see the end of this file as the list grows)
