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

30. **A double tap on "Save combination" saves it once.** Two quick taps sent the form twice
    and left two copies of the same combination. The button now waits for the first save to
    finish. Every other save in both apps already did this (Liftbook's through one shared
    helper), and a double tap on Flow's Stop records one session. Checked on the computer: three
    quick clicks made one combination, and a later save still worked (test data removed).

31. **The Dashboard moves on to the new day.** It loaded its figures once. The phone app reopens
    on the page it was left on, so a Dashboard looked at last night still showed yesterday as
    "Today" (and the last 7 days ending yesterday) the next morning. It now loads again when
    you come back to it on a new day, or within a minute if it stays open past midnight; on
    31 December it moves on to the new year unless you were looking at an older one. The today
    line under the clocks already did this, and Liftbook redraws each screen as you open it.
    Checked on the computer by moving the page's clock a day ahead.
32. **Feedback words are kept until sent.** Every Muhurta page is its own page load, so a tap
    on Rhythm or Timer while writing feedback threw the words away. They're now kept on the
    device with the kind you picked, and come back when you return to Settings; Send or an
    emptied box clears them, and sign-out clears them with the running clocks. Checked on the
    computer: typed, reloaded, the words and "Could be better" came back.
33. **Every control shows keyboard focus.** Went through each page on the computer, focusing
    every link, button and field in turn. Two showed nothing: the name in the top bar (a link
    home) and the Recent days rows on the Dashboard (only their date underlined, as on hover).
    Both now get the gold ring the buttons and page links use. The big time on Timer has no ring
    on purpose: focusing it selects the time and its hint changes to "Minutes, or h:mm:ss".
    The phone build still hides rings on buttons (no keyboard there). Checked by rerunning the
    same sweep: nothing left.
34. **Small grey text is readable in light mode.** Measured every piece of text on each page
    against its background, light and dark, by the usual standard (4.5:1, or 3:1 for large
    text). Dark passed. In light, nearly all secondary text (descriptions, labels, the other page
    links, Dashboard captions, Settings hints) sat at about 4:1, the quote's author at 3:1 and
    the version in the footer at 2:1. The light grey is now 66% ink instead of 58% (4.9:1 even
    where the page's background is darkest), the author line matches it, and the version is no
    longer faded on top of the grey. Rerun after the change: nothing below the standard in either
    mode; on the iPhone the descriptions still read as grey, just easier. Not measured: words on
    the gold gradient buttons (dark on gold, clearly readable).
35. **The phone's small clock labels and quote are readable.** The same measuring on the phone
    build found its own fading: the labels under the clocks ("rest pool", "work done", "ends
    at", 9px) were faded to 75% and the quote to 80%, on top of their grey, so they read at about
    3.1 to 3.6:1 in both light and dark. The fading is gone (the grey keeps them quiet), and the
    labels are 10px instead of 9. Rerun: Rhythm, Timer and Flow pass in both modes (the rest of
    the phone pages already did). On the iPhone the labels still fit on one line and the quote
    still sits quietly under the clock.
36. **Pop-ups measured too.** The level menu, keyboard shortcuts, confirm, the Dashboard's day
    view and Rhythm info, the default-combination menu and Add a session, on the computer and the
    phone build, light and dark: all pass but one. The small gold weekday over the day view's
    title ("Tuesday") was 3.4:1 in light; it's now a deeper shade of the same gold (5.2:1), which
    also fixes the "Nothing here" page's kicker.
37. **Checked: every control has a name for screen readers (no change needed).** Every link,
    button, field and menu option on each page (the level and default-combination menus opened),
    on the computer and the phone build, has a name a screen reader can say: its text, its label,
    or an aria-label for the icon-only ones.
38. **The name in the top bar and History's back link are easier to tap on the phone.** Measured
    every tap target on the phone build against the 24pt minimum: the name (a link home) was 19pt
    tall and History's "← Settings" 18pt. Each now has an invisible area around it, about 44pt
    tall, without anything moving. Left as they are: the Dashboard's heatmap squares (13pt) and
    History's thin timeline blocks, small by nature, with full-size ways to the same thing (the
    Recent days rows, the Edit buttons); the "i" buttons already had their touch area (item 24).
39. **Nothing scrolls sideways at 320px wide.** A small phone, or a computer zoomed to 400%, shows
    the computer build 320px wide. There, Settings scrolled sideways by 41px (the row of section
    links stretched the whole column) and the clock ring on Rhythm, Timer and Flow stuck out by
    7px. The column can now shrink (the link row scrolls on its own, as it was meant to) and the
    ring is never wider than its panel. Measured again: every page fits at 320px, and nothing
    changed at full width. The phone build already fitted.
40. **Reduce Motion stops the scripted scrolling.** With Reduce Motion on (iPhone: Settings >
    Accessibility > Motion), the CSS animations were already calm, but the two smooth scrolls
    started from Settings' script (to the combination form when you edit one, and the section
    links' row following the page) still glided: browsers don't apply the setting to a script's
    smooth scroll. They now jump straight there when it's on. The ring's slow breathing stays:
    it only fades, nothing moves.
41. **Checked: page titles and headings; one fix on the phone.** Every page (Rhythm, Timer, Flow,
    Settings, History, Dashboard, on the computer and the phone) has its own title and one main
    heading, with sections under it in order. One gap: on the phone, opening a Settings section
    (Sound, say) hid the page's main heading, so the screen started at "Sound" with nothing above
    it. The heading is now only hidden from sight there (`mobile.css`), so a screen reader still
    finds "Refine the ritual." first. Looks the same on the iPhone.
42. **Field notes are read with their fields.** Checked every box and list for the right phone
    keyboard and autofill: already right (number pads, name and one-time-code autofill). But some
    notes under a field weren't tied to it, so a screen reader skipped them when the field got
    focus: the username rules and the "Sent with your name and email" note in Settings, the
    two-step "Type the 6-digit code" step, the delete-account warning, the "We'll send a code"
    notes on sign-up and reset, and "Passwords match" under Confirm password. Each is now read with
    its field (`aria-describedby`, templates only). The other sign-in fields already were.
43. **Keyboard focus stays on a button after it works.** Checked how messages reach a screen
    reader: the timer notice, the feedback status, sign-in errors and the pop-ups were already
    announced. One gap: buttons that switch off while they work (Send feedback, Save a
    combination, the History fixes, sign-in steps, the admin page: about a dozen places) dropped
    keyboard focus to the top of the page, so the next Tab started over. Focus now comes back to
    the button when it switches on again, unless you've moved on. Done once for every page in
    `modal-focus.js` (browsers send no event for this, so it watches the switch itself).
44. **After sending feedback, focus waits in the box.** The one place item 43 couldn't help: once
    a note is sent the box is empty, so Send stays off and keyboard focus had nowhere to return.
    On a computer it now goes to the message box, ready for the next note; on a phone it doesn't
    (that would pop the keyboard up), and the "Thank you" is read out either way. Tested with the
    server's reply stood in for, so nothing was really sent.
45. **Checked: extra text spacing fits (no change needed).** With the spacing some readers and
    reading tools add (line height 1.5, wider letters and words, more room after paragraphs),
    nothing on Rhythm, Timer, Flow, Settings, History or Dashboard was cut off or spilled over
    anything, and no page grew sideways. Checked at computer width only (the simulator's Safari
    can't take the test styles).
46. **Checked: no errors in the console (no change needed).** Every page (and an unknown one)
    opened with no script errors or failed promises. The only red lines were the server saying
    "not signed in" to the feedback list and two-step status, which happens only on a copy run
    without an account (with one, Settings sends you to sign in first), and is handled quietly.
    The sync check every 3 seconds per open page is by design: it asks this app, not the network.
47. **Checked: image sizes (no change needed).** The app's own icons are already small (45 KB at
    most). The largest images are the website screenshots in `docs/img` (about 330 KB each for
    the dashboard ones); making those smaller means re-compressing photos, which changes how they
    look, so they were left for you to decide.
48. **Checked: page basics (no change needed).** Every page says it's in English (so a screen
    reader pronounces it right), allows pinch zoom, and gives the browser bar colours for dark,
    light and automatic, kept in step with the theme by `theme-color.js`.
49. **The chosen button in a row of choices is readable in light mode.** Looked at what a new
    person sees with no sessions yet (Dashboard and History, on the iPhone): both explain
    themselves well. But there, in the light theme, the chosen half of "By day / Unusually long"
    (and every row of choices like it: theme, level, timer end) had near-black words on the
    light theme's dark gold, about 2:1 at its darker end. It now uses the light gold of the Start
    buttons, about 8:1; the dark theme is unchanged. The earlier contrast check missed it because
    it couldn't measure text on a gradient. Checked on the iPhone in light mode.
50. **Every gold-filled label is readable in light mode.** Item 49 fixed one; a sweep of all
    words on a gradient, on every page in both themes, found the same 2.1:1 in three more places
    in the light theme: the current page in the top menu ("Rhythm", "Timer"...), the chosen level
    in the level menu, and the round account initial in Settings (and the admin page's "new"
    badge). All six now share one gold, `--gold-fill` in `app.css`: unchanged in the dark theme,
    the light gold of the Start buttons in the light one, so the light-theme patch from item 49
    is folded into it. The sweep is now clean on all six pages in both themes; checked on the
    iPhone in its own light mode too.
51. **Off switches show in the light theme.** Measured how controls stand out from the page
    (3:1 is the bar for a control's shape). In the light theme a switch that was off had a pale
    track and a white knob at about 1.2:1 and 1.1:1 against the page, so Auto-start rest, Minute
    pulse and the like were nearly invisible when off. The off track is now a warm grey
    (`#857e73`): 3.5-3.9:1 against the page, the white knob 4:1 on it, like the iPhone's own
    switches. On (gold) and the dark theme already passed and are unchanged. Checked on the iPhone.
52. **Boxes you type into have a visible edge.** Their outlines were about 1.2:1 against the
    page in both themes, so a box was hard to find. They now use a warm line from the app's own
    palette (`--field-line`: `#6e6452` dark, `#8f826b` light), about 3:1, still one thin pixel,
    not grey. Covers text boxes, the settings selects and the level picker. Checked on the
    iPhone in light mode; Liftbook got the same treatment.
53. **Keyboard focus shows clearly.** Where Tab lands is now always marked with a 2px ring or edge
    in the theme's full gold. Before, the main ring was gold faded to 70% (about 2.3:1 in the
    light theme), a focused select or level picker got a pale edge fainter than the new resting
    outline, two rings were 1px, and the Settings menu links and History's back link only changed
    colour. Hover is unchanged apart from pickers now turning gold. Checked with Tab in the light
    theme on desktop; Liftbook's ring got the same fix.
54. **Small controls are easier to hit.** A sweep for click targets under 24px found two. The
    "i" buttons on the Dashboard were an 18px circle; they look the same but an unseen ring makes
    them about 26px to click (on touch they already had a bigger one). The Volume slider was a 6px
    line, so a click just above or below it missed; the line still looks 6px and rounded, but the
    control is now 24px tall (a click 9px above the line's centre now moves it). Left as is: the
    13px heatmap squares, which are the chart itself. Checked on desktop; on the iPhone the slider
    looks the same (Safari moves a slider only by dragging the knob, so taps prove nothing there).
55. **Focus shows in Windows high-contrast mode.** That mode removes shadows and custom colours, so
    every focus mark drawn as a soft shadow or a gold edge (the segments, the steppers, the pickers,
    the text boxes) showed nothing there. A rule that only applies in that mode now gives every
    keyboard focus a ring in the system's own highlight colour. The normal look is untouched (the
    rule is off unless that mode is on). The browser here can't switch the mode on, so I checked
    that the rule loads and stays off normally; Liftbook got the same rule.
56. **Password managers file your login under your email.** On sign-up, the @username box was
    marked as the account's login name, though you sign in with your email. So Safari and password
    managers offered saved login emails in the @username box and could file the new password under
    the handle, which the sign-in box (email only) won't take. It's now marked as an ordinary box,
    like the two other username boxes in the app; the password step already tells password managers
    the email. (Liftbook's sign-in takes email or username, so its sign-up was fine as it is.)
57. **Your streak doesn't drop to 0 in the morning.** The Dashboard's "Current streak" counted
    today as a missed day until you focused, so after a focus day yesterday it read "0 days" all
    morning. Today now only counts once it's over: until you focus it shows the run up to
    yesterday (1 day here), a focus block today adds one, and a whole missed day still resets it.
    Same in both builds (`db.py` on the computer, `mobile/web/local-api.js` on the phone). Checked
    on the iPhone (0 → 1 day) and in the computer's numbers. Left as is: Consistency ("3.5/wk"
    from 1 of 2 days) is high early on, but its note shows the days it comes from.
    (Fixed in round 58: this fix first went into the built copy `docs/app/local-api.js`, which the
    next phone build would have overwritten; it is now in the source and the built copy is back.)
58. **The year chart shows where today is.** In "Yearly consistency" the rest of the year (late
    November, December) looked exactly like days that passed without focus. Days still to come now
    fade, and today has a thin green ring, so an empty square means a missed day and you can see
    where you are in the year. Past years are unchanged. Checked on the iPhone in light mode.
59. **The Timer's quick lengths say what they are.** Under the dial, "6 12 24 36 48 60" were bare
    numbers, so it wasn't clear they're minutes to tap. A quiet "MIN" now follows them, in the same
    small capitals as "SET FOR" and "ENDS AT" above. It's added by the stylesheet, so it stays when
    the row is rebuilt with your own lengths, and screen readers skip it (they already hear "Quick
    lengths in minutes"). Checked on the iPhone.
60. **In the dark theme, more focus is brighter on the year chart.** Its greens ran pale to deep in
    both themes, so on a dark page "More" was a deep green that almost vanished: your best days
    were the hardest to see, and the squares used the light theme's greens. Each theme now has its
    own four year-chart colours (`--heat-1..4` in app.css): unchanged in light, dim to bright sage
    in dark, and dashboard.js takes the squares' colours from them, so squares and legend match.
    Other charts keep their greens. Checked on the iPhone in dark and light. The squares also
    repaint at once if the look changes while the Dashboard is open (the system turning dark with
    the theme set to follow it); checked on the computer by flipping the theme.
61. **Recent days doesn't write today off.** The Dashboard's "Recent days" list labelled today "No
    focus" until you focused, like a day already lost. Today's row now reads "Today", with
    "Nothing yet" (or "So far" once you've focused, or "Goal met"), and its screen-reader label
    says "No focus yet" / "… focus so far". Past days are unchanged. Same spirit as the streak
    (item 57) and the year chart's ring (item 58). Checked on the computer.
62. **A test guards the streak.** The phone tests (`tests/phone/phone.test.mjs`) now check it: with
    focus yesterday and the day before and none yet today the streak is 2, a block today makes it
    3, and a day that ended without focus ends the run. Taking item 57's fix out makes it fail
    ("nothing yet today: the run up to yesterday still shows"), so the morning-zero can't come
    back unnoticed. Phone tests: 8 pass. The computer's copy of the rule (`db.py`) has the same
    check in a new script, `tests/test_streak.py` (its own empty database; taking the fix out makes
    it fail "got 0, want 2"), added to the tests workflow on GitHub.
63. **Consistency isn't guessed from a day or two.** The Dashboard's Consistency card turned the
    days so far into a weekly rate, so one session on the year's first day read "7/wk" and one of
    two days "3.5/wk". Under a week of history it now shows the days themselves ("1 of 2", "days
    so far"); from a week on, the weekly rate as before. Checked on the computer (8140).
64. **Recent days folds empty stretches.** The Dashboard's Recent days listed every day without
    focus on its own row, so a quiet fortnight was a dozen identical "No focus 0m 0m rest" rows.
    Three or more past days in a row with no focus and no rest now read as one row ("5 – 16 Nov",
    "No focus", "12 days"); one or two such days, and today, keep their own rows and still open
    the day. Checked on the computer (8140); on the phone this panel isn't shown.
65. **"Strongest day" waits for two weeks.** By weekday said "Tuesday is your strongest day" after a
    single Tuesday. Until there are two weeks of days (each weekday seen twice) it now says "Your
    strongest day shows after two weeks."; the chart and its highlighted bar are unchanged. Checked
    on the computer (8140) and the phone build (8141).
66. **Screen readers hear the charts' numbers.** By weekday, By month and By time of day are read as
    one picture, and their label was only the chart's name ("Average focus by weekday in 2026"),
    so the numbers were lost. The label now goes on with the bars that have focus ("Tuesdays: 25m
    on average"; "15:00 to 16:00: 16m; 16:00 to 17:00: 9m"), or "No focus yet". The Last 7 days
    chart, whose days are buttons, already read each day. Checked on the computer (8140).
67. **The year heatmap's days reach screen readers.** The heatmap was marked as one picture, yet the
    days with focus inside it are buttons you can Tab to; a picture's insides are hidden from a
    screen reader, so those buttons were reached by keyboard but said nothing useful. It is now a
    group named "Daily focus activity for 2026: 1 day with focus", and each day says its date and
    minutes and opens the day. Checked on the computer (8140): the day shows in the page's
    accessibility tree as a button.
68. **Today's goal, said once.** Before any focus, the Dashboard's Today card read "2h to your 2h
    goal". With nothing yet it now says "Daily goal: 2h"; once you start it counts down as before
    ("1h 35m to your 2h goal"), then "Daily goal of 2h met". Checked on the computer (8140) and the
    phone build (8141).
69. **Timer: "Click" with a mouse, "Tap" on a phone.** The hint under the Timer's time said "Tap
    the time to change it" on the computer too. With a mouse or trackpad it now says "Click the time
    to change it"; touch screens keep "Tap". Checked on the computer (8140) and the iPhone simulator.
70. **Two-step setup reads right on a computer.** Its first step said "scan this code, or tap Add to
    authenticator on this device"; it now says "or use Add to authenticator", which fits a mouse and
    a phone alike. That was the last "tap" left on the computer pages (checked by searching them).
    Checked that the computer page (8140) serves the new words.
71. **"/history" finds History.** History lives at /settings/history, so typing /history gave
    "This page doesn't exist". It now goes to History (computer app; the phone app has its own
    pages). Also looked over the phone's Settings in the simulator: nothing to change. Checked:
    /history answers with a redirect to /settings/history; all four Python scripts and the phone
    tests pass.
72. **Last 7 days only compares with a week you used the app.** Two days after the first session it
    said "25m of focus · 25m more than the 7 days before", though there was nothing before. The
    comparison now appears only when the week before reaches your first logged day; until then it
    reads "25m of focus." Checked on the computer (8140); the phone app gives the same first day
    (`calc_start` in `mobile/web/local-api.js`).
73. **The day view knows today isn't over.** Opening today (or stepping to it with →) with no
    focus yet said "Nothing was timed on this day." It now says "Nothing timed yet today."; past
    days keep the old words. Checked on the computer (8140): 17 Nov shows its sitting, → to today
    gives the new line, ← ← to 16 Nov the old one.
74. **The Timer's quick lengths say which is chosen.** The 6 / 12 / 24 / 36 / 48 / 60 buttons showed
    the chosen one only by its look. Each is now "24 minutes" to a screen reader and says pressed
    when it is the length set. Checked on the computer (8140): choosing 24 marks only 24 pressed
    (the test account's length was set back to 25 afterwards). Also checked: Flow's buttons are
    named, and the Timer's "ends at" keeps up with the clock while idle.
75. **Rhythm's level menu works from the keyboard.** Opening it left the focus on the button, the
    arrow keys did nothing, and Escape closed it with the focus lost. Now the chosen level takes the
    focus when it opens, ↑ ↓ (and Home / End) move through the levels, Enter chooses one, and
    Escape closes it and puts you back on the button. Space on the picker also stopped reaching
    the page's Space shortcut, so it opens the menu instead of starting the clock. Checked on the
    computer (8140) with real key presses: Enter opens on Sparsha, ↓ moves to Sthiti, Escape returns
    to the button with Sparsha still chosen and the clock idle; Space opens the menu, clock idle.
76. **History's choices answer the arrow keys.** In History's session editor, Focus / Rest and
    Start & end / Start & duration are radio-style choices, but each option was its own Tab stop
    and ← → did nothing (Settings' choices already worked that way). Each group is now one Tab
    stop, and the arrows move the choice. The admin page's Open / Done / All filter got the same.
    Checked on the computer (8140): in Add a session, → on Focus chooses Rest; Escape closed the
    editor without saving. The admin filter wasn't tried live (same code).
77. **History's two views work as tabs.** By day / Unusually long were marked as tabs but each was
    a Tab stop and ← → did nothing. They are now one Tab stop, ← → and Home / End switch the view
    with the focus following, and each tab names the list it controls. That leaves every choice
    group on the computer pages answering the arrow keys (Settings', History's, the admin filter).
    Checked on the computer (8140) with real key presses: → shows Unusually long ("Nothing looks out
    of place"), Home goes back to By day.
78. **The same message twice is read out twice.** Settings and History share one message strip
    that screen readers watch. Saving two settings in a row put "Saved" in it twice, and the second
    time nothing changed, so nothing was read out. When the words are the same, the strip now empties
    and fills again a moment later (History keeps its Undo button). Checked on the computer (8140):
    turning Auto-start breaks on and off logs "Saved", "", "Saved"; the setting is back to off.
79. **Rhythm's tab only counts down when something is running.** With nothing started, the tab
    read "24:00 focus", the same as a running session. Flow and Timer show the page's name when
    idle; Rhythm now does too ("Rhythm · Muhurta Pomodoro"), and every running, paused, rest and
    done title is as before. Checked on the computer (8140) after a reload.
80. **The Dashboard's average card is spoken in words.** A screen reader heard "Avg / active day:
    25m. in 2026", and nothing said a press switches it. It now says "Average per active day: 25m
    in 2026. Press for average over all days" (and the other way round once pressed). The card
    looks the same. Checked on the computer (8140): pressing twice goes over and back.
81. **The streak card no longer acts like a button.** It was a Tab stop, a "button" to screen
    readers, and lit up on hover, but it has one view only, so pressing did nothing. It is now a
    plain card like Focus this year and Consistency; the average card, which does switch, keeps
    all of that. Checked on the computer (8140).
    Also checked and clean: Flow and Timer controls all named (quick lengths say pressed);
    Timer's "ends at" matches the clock; History's timeline blocks are named by their hover text
    and kept out of the Tab order, with Edit / Delete buttons named per session.
82. **No stuck ring on the phone's average card.** On the iPhone the Dashboard's cards have no
    border or padding, and a touch (or the page loading under a finger) left the card's hover ring
    on, pressed against "AVG / ACTIVE DAY" and "in 2026". The hover ring now shows only with a
    mouse; the keyboard focus ring is unchanged. Checked on the iPhone simulator (8141): a tap
    switches to Avg / all days with no ring; tapped again to switch back.
83. **No stuck highlights after a tap, anywhere.** Item 82 fixed one card; the other 31 hover
    looks (nav links, buttons, level options, list rows) could also stay lit after a tap on the
    phone. Each now applies only where there is a mouse; focus, chosen and open states are kept
    outside and still show. Done by a small script that kept every rule in its place. Checked on
    the computer (8140): hovering a nav link still lights it; on the iPhone simulator (8141) the
    Timer page renders as before and says "Tap the time to change it".
84. **Rings hold still for Reduce Motion.** Flow's ring, and Rhythm's in overtime, fade in and out
    without end for the whole sitting, even with the device set to reduce motion. With that
    setting on they now stay still at full strength; the alarm's quicker pulse is kept, as it is a
    call to look. Checked on the computer (8140): a flowing ring breathes as before, and with the
    reduce-motion rule applied it holds still at full strength. Also checked and clean: the
    quick lengths and the "i" already get a finger-sized tap area on touch screens.
    Also checked and clean for Reduce Motion: the update bar and alarm slide-ins and the level
    menu stop, the update and sync spinners slow down, and the rest (Preview pulse, History's row
    flash, the message strip's short rise) are brief fades that move nothing.
    Also checked and clean for contrast: every piece of visible text on Rhythm, Timer, Flow,
    Dashboard, Settings and History, in dark and light, measured against what is really behind
    it, is at least 4.5:1 (3:1 for large text); the gold buttons and chosen segments are 8:1 or
    better on both ends of their gradient.
85. **Combinations says which length is out of range.** Typing Focus 300 left the line under the
    form at "Fill in the durations to see the full cycle.", and the real reason showed only in the
    message strip after Save, which fades after a few seconds. The line now says "Focus must be
    1–180 min." (or Short rest 1–60, Long rest 1–120) while the number is out of range, and goes
    back to the cycle summary once it is fixed. Checked on the computer (8140) without saving:
    300 → the Focus message, 50/10/20 → "One cycle: 4h 10m …", Short rest 0 → its message.
    Also checked and clean: History's add/edit form shows its problem as an alert and keeps it.

Checked and clean (no change needed): the not-found page; History (Settings → History) by day and
"Unusually long" with its empty state, both tabs readable; Flow, Timer and Rhythm on the iPhone;
the Dashboard's charts label values on their bars, so they have no odd side scales.

## Round 2 (24 Nov, branch improve/round-2-polish)

1. **Consistency without the ".0".** With no focus yet the Dashboard's Consistency tile read
   "0.0/wk"; whole numbers now read "0/wk", "3/wk", and other rates keep one decimal under ten.
2. **Dashboard zeros read as numbers.** Cormorant's old-style zero is a small round "o", so the big
   figures read "om", "o/wk" and "o days". The Dashboard's tiles, today's ring and the Rhythm
   profile count now use lining figures. Checked in light and dark.

### Branch `design/dashboard-empty` (from `improve/round-2-polish`)

From here on each kind of work has its own branch (design/, fix/, feature/, improve/ + topic).

1. **Recent days and Rhythm profile, before there's a rhythm.** The pair kept a fixed 20-23rem for
   a curve that isn't drawn until 15 sessions, so "0 / 15" sat in a tall empty box beside a
   two-line Recent days (368px each). While the placeholder shows, the pair is only as tall as it
   needs (176px here) and never taller than before; once the curve appears nothing changes.
   Browsers without `:has()` keep the old height.
2. **Empty charts say they're empty.** With no focus yet, By weekday, By month and By time of day
   showed full-height grey tracks that read like bars of data. They now fade back with "No focus
   yet" across them, until there's focus to show. (Last 7 days is left as it is: it already says
   "0m of focus" and has its goal line.)
### Branch `fix/settings-shortcut-wrap` (from `improve/round-2-polish`)

1. **Keyboard list keeps "/" with its key.** In Settings → Keyboard, "⌘R / Ctrl+R / F5" wrapped
   so that "/ F5" started its own line. Each key choice now keeps its "/" beside it, so a wrapped
   line never starts with a separator. Checked on desktop; the phone check waits on the simulator.
### Branch `improve/timer-default` (from `improve/round-2-polish`)

1. **Timer starts at one ghadi.** On a first visit the Timer read 25:00, the classic Pomodoro,
   while everything else counts in 24-minute ghadis (Sparsha, the length chips 6 · 12 · 24 · 36 ·
   48 · 60, the footer). It now starts at 24:00, so its chip lights up. A length you've used
   before is still remembered. Easy to undo: three numbers in `static/js/timer.js` and one in
   `templates/timer.html`.
### Branch `fix/active-day-minute` (from `improve/round-2-polish`)

1. **A few seconds of focus no longer makes a day "active".** A timer started by mistake and
   stopped seconds later counted the whole day as active: it lengthened the streak, raised
   Consistency and halved "Avg / active day" (found by adding a 1h session the day after an
   18-second one: "2 days active, 30m average"). History already treats under a minute as a
   stray moment and won't add a session that short, so a day now counts as active from one
   minute of focus, on the computer (`db.ACTIVE_DAY_MIN`) and in the phone app
   (`mobile/web/local-api.js`), plus the year chart's count. The seconds still show in the day's
   own total. Tests added to `tests/test_streak.py` and `tests/phone/phone.test.mjs`; all pass.
   To undo, set `ACTIVE_DAY_MIN` back to a tiny value and the two `>= 1` checks to `> 0`.
2. **The recent days list says so too.** A past day with only a few seconds of focus was
   labelled "Focus day"; it now reads "Under a minute" (today still says "So far"). JS tests pass.
### Branch `fix/combination-names` (from `improve/round-2-polish`)

- **No two levels with one name.** A combination named like a built-in level ("Sparsha", "tapas")
  or like another of your combinations, ignoring case, showed twice in the level menu. Saving now
  refuses it with a clear message ("“Sparsha” is already a built-in level. Pick another name").
  Editing a combination without renaming it still saves. Checked in the browser on throwaway data.
- **Whole minutes only.** "25.5" in a length box saved silently as 25. It is now refused, in the
  preview and on Save, with "Focus must be whole minutes"; out-of-range values keep "1–180 min".
### Branch `fix/time-of-day-range` (from `improve/round-2-polish`)

- **"Most between" names the right hours.** The By time of day caption always named a three-hour
  window, so 40 minutes all at 22:00 plus a few seconds after midnight read "Most between 22:00
  and 1:00". Hours at either end that hold under a tenth of the window are now dropped: it reads
  "22:00 and 23:00", and focus spread over three hours still reads as three. Checked in the browser.
### Branch `design/dashboard-empty-cards` (from `improve/round-2-polish`)

- **No tall blank cards while the Rhythm profile is waiting.** Recent days and Rhythm profile sat at
  a fixed ~23rem even when they held "1 / 15" and two rows, so most of both cards was empty. Until
  the profile has its sessions, both now fit their content (at least 12rem, at most the old height,
  with Recent days scrolling inside). Once the curve shows, nothing changes. Desktop only; phones
  keep mobile.css's sizing (phone check is on the Waiting list with the rest).
- **The "i" buttons show as buttons.** Their ring used the divider colour, 8% white in dark mode,
  so Rhythm profile's "i" read as a stray letter. The ring now follows the "i" at half strength:
  visible in dark and light, gold on hover as before. Checked in both themes.
- **Stacked cards match on a phone.** Under 720px Recent days and Rhythm profile stack into the
  same column as By weekday and By month, but kept their compact side-by-side inset (0.85rem) and
  smaller title, so Rhythm profile's heading sat smaller and further left than the card below it.
  They now use the same 1.25rem inset and 1.35rem title there. Checked on the iPhone simulator;
  the rest of the Dashboard on the phone looked right (tiles, today ring, last 7 days, bars).
  The Timer page on the phone also looked right (summary strip, ring, minute marks, Start).
  Flow, Rhythm and Settings checked too. Settings' section tabs follow the scroll correctly (a
  section stays lit while it still fills the band 15-45% down the screen).
### Branch `design/level-menu` (from `improve/round-2-polish`)

- **The level menu is solid.** On the phone the Rhythm page's level list (Agaman ... Ekagra) let the
  timer behind it show through ("24:00", "DEEP WORK", Start), which looked messy and made the level
  names harder to read. Its tinted background now sits on the solid page colour, so it is opaque in
  both themes and keeps its tint. Checked on the iPhone simulator in dark mode. Choosing Sthiti set
  the clock to 36:00, and choosing Sparsha set it back to 24:00.
### Branch `fix/font-blocking` (from `improve/round-2-polish`)

- **Pages draw without waiting on Google.** The Google Fonts stylesheet was a normal stylesheet in
  the head, so the page stayed blank until Google answered. On the iPhone simulator, Dashboard and
  Timer sat on a blank screen for about 10 s while the server replied in 7 ms. It now loads with
  `media="print"` and switches itself on when it arrives (a `<noscript>` copy covers no-JS). With
  `display=swap` the page draws straight away and the fonts swap in. After the change, Flow drew
  fully in under 2 s (the fonts may already have been cached, so this is not a clean
  before/after). The phone build already bundles its own fonts. Its swap in build_web.py now
  matches the new tag and drops the `<noscript>` copy. Checked on the served page: no Google link
  is left, and the local fonts.css link is in. Phone tests pass (16).

- Measured on the iPhone simulator (25 Nov): before this branch, app.css was requested ~2 s after the page HTML (Safari waited on the Google Fonts stylesheet first); on this branch HTML and app.css arrive in the same second, twice in a row, and the Timer page looks the same with its fonts. This settles the "slow first paint" Waiting-list item noted on `design/level-menu`.
### Branch `design/numerals` (from `improve/round-2-polish`)

- Timer numbers use lining figures, as the Dashboard's already did: Cormorant's old-style "1" looks like a capital I (the length scale read "I2") and "0" a small "o" (FOCUSED read "o:oo"). The big time, the set-for/ends-at/focused strip and the length buttons now set `lining-nums tabular-nums` (tabular so the countdown doesn't jitter). Checked on the iPhone (light; Safari needed a reload to drop its cached CSS) and on the computer.
### Branch `design/topnav-phone` (from `improve/round-2-polish`)

- On a phone the tab bar changed shape between pages: Rhythm (level picker + five tabs) was a
  neat 3 + 3 grid, but Timer, Flow, Dashboard and Settings wrapped as four tabs and a lone
  Settings on its own row. Now every page uses even rows of three equal pills, centred, in a
  17rem-wide bar: Rhythm 3 + 3, the others 3 + 2. Checked on the iPhone simulator on Flow and
  Rhythm, and the Sparsha level menu still drops under the bar.
- Safari offers "Translation available" on some pages. The page already says `lang="en"`;
  most likely Safari reacting to the Sanskrit words. Left as is.
### Branch `design/dashboard-recent-phone` (from `improve/round-2-polish`)

- Dashboard on the iPhone: Recent days stacked each row as date, bar, then minutes, so a day's
  "40m / 0m rest" sat under its bar and read like the start of the next day. On phones each row is
  now the day and status on the left, minutes and rest on the right, and the bar under both.
  Checked on the iPhone simulator.
- Also checked on the phone: Timer (its old-style "12" quick lengths are fixed on
  `design/numerals`) and the Today card ("Daily goal: 2h" before any focus, after a reload).
- Recent days and Rhythm profile kept their desktop fixed height (20-23rem, set so the two
  side-by-side cards match) when stacked on a phone, leaving half-empty cards under three recent
  days and under "1 / 15". On phones they now fit their content (Recent days still scrolls past
  30rem; the rhythm chart keeps 15rem to draw in). Checked on the iPhone simulator.
- Stacked on a phone, those two cards also wore their compact desktop look (0.85rem edge, a
  1-1.15rem title) between cards with a 1.25rem edge and a 1.35rem title. On phones they now match
  the rest. Checked on the iPhone: Recent days and Rhythm profile line up with Yearly consistency.
### Branch `fix/year-chart-latest` (from `improve/round-2-polish`)

- On a phone's browser the Dashboard's year chart opened at January to April, all empty, with the
  focus out of sight in November. Only the Android app (mobile.js) jumped to the latest weeks.
  That jump now lives in dashboard.js, runs after each redraw (year change too) and only when the
  grid is wider than its box, so wide screens are untouched; mobile.js no longer has its own copy.
  Checked on the iPhone 18 Pro: it opens at Sep to Dec with today in view. 16 tests pass.
- iPhone check of round 2 (was on the Waiting list): the Dashboard's figures are lining ("40m",
  "20m", "2 of 2"), not old-style. Done.
## design/gold-edges (25 Nov)
- On the phone, every gold-gradient control (Add a session, the chosen segment, the active nav pill and others) showed a thin dark-gold sliver down its left edge: the gradient was laid out inside the border and repeated underneath it.
- All eight gold fills now use `background-origin: border-box`. Checked on the iPhone simulator (Settings > History).
## design/sound-cues (25 Nov)

- Settings > Sound on a phone: the Sound and Minute pulse switches sat on the right, but each cue's
  switch (Focus begins, Focus ends, ...) started its row on the left. On a phone the cue switches
  now sit on the right too, so every switch on the page is in one column. On wider screens nothing
  changes (there the switch sits beside its sound picker). Checked on the iPhone.
## design/timer-controls (25 Nov)

- The timer's main button changes label (Start, Pause, Resume) and its width changed with it, so
  "Reset" beside it shifted sideways each time. It now keeps one width for all three. Checked on
  the iPhone through Start, Pause and Resume.
### Branch `fix/under-a-minute` (from `improve/round-2-polish`)

- Under half a minute of focus today: the bars and ring rightly showed a sliver, but every number
  rounded it to "0m" ("Today · So far · 0m", a lone "0m" over Wednesday in By weekday), and the
  Today card said "2h to your 2h goal" since its test was `<= 0`. Now it reads "<1m", and the
  Today card names the goal ("Daily goal: 2h") until half a minute is in. Checked on the iPhone.
- History: a few seconds inside one minute read "12:13 AM – 12:13 AM". Now one time, "12:13 AM"
  (the list, the edit dialog's "Recorded …" line and Undo sentences). Checked on the iPhone; 16 tests pass.
- Today card past half a minute: the ring said "1m" but the note said "2h to your 2h goal"
  (it took ceil of the unrounded 119.4 m). It now counts from the minutes the ring shows:
  "1h 59m to your 2h goal". Checked on the iPhone; 16 tests pass.
### Branch `design/settings` (from `improve/round-2-polish`)

- **The daily-goal stepper's − and + match.** Typed in the body font, the minus was about half the
  plus's width and sat low, so the pair looked lopsided. Both are now drawn as equal 0.8rem strokes
  (the plus adds an upright one); the buttons keep their "Lower/Raise daily goal" names for screen
  readers. Checked on the iPhone simulator in dark mode: + took the goal from 2h to 2h 30m with
  "Saved", and − set it back.
- Dark-mode pass on the phone: Dashboard and Settings read well. On 127.0.0.1 Safari kept a light
  bar tint from an earlier light-mode visit; on a fresh origin (the Mac's address) the bars are dark
  as the theme-color tags ask, so that was Safari's cache, not the app.

## design/settings: checked on the iPhone (25 Nov)

- The daily-goal stepper's drawn minus and plus match on the iPhone too (the font's own minus was
  shorter than its plus). Nothing more to change on the Rhythm part of Settings.
- Sound: the cue pickers (Opening bells, Soothing bell...) had a small filled triangle, the
  Default level picker a thin chevron. They now share the chevron, in each theme's muted ink.
  Checked on the iPhone (light theme).
## fix/today-minutes (25 Nov)

1. **Today's focus agrees everywhere.** With 1.6 minutes done, the "Today" line under the clocks
   said "1m of 2h" while the Dashboard's ring and Today bar said "2m", next to "1h 59m to your 2h
   goal" (2m + 1h 59m is more than the goal). The Dashboard now counts today, and this month's
   bar, in whole minutes done, like the clocks: "1m" in all three places. Checked on the iPhone.
2. **The same for Recent days and the day pop-up.** Today's row in Recent days and its pop-up
   ("… · 2m focus so far") also count whole minutes now. Past days are unchanged.
## improve/heatmap-today (25 Nov)

1. **The year's grid opens on recent weeks.** On a phone the Yearly consistency grid is wider
   than the screen and opened at January, so in November all you saw was Jan–Apr, empty. It now
   opens with today's week near the right edge (Sep–Dec in late November), one faded week after
   it; a past year opens at its end. Wide screens show the whole year and do not scroll. Checked
   on the iPhone.
2. **Mon / Wed / Fri stay at the left edge** while the year scrolls sideways. The day names now
   sit outside the scrolling part, beside it, so nothing has to cover the squares (a backing in
   the card's colour showed as a lighter band, since the card is see-through). Checked on the
   iPhone in light and dark.

## Waiting list

- ~~**Slow first paint on the iPhone simulator**~~ **Solved 25 Nov by `fix/font-blocking`**: the ~2 s gap was Safari waiting on the render-blocking Google Fonts stylesheet; on that branch HTML and app.css arrive in the same second. Original note (cause not pinned down): pages sometimes sit blank
  for 3-10 s. The server log shows the HTML served at once, then a ~2 s gap before the phone asks
  for app.css, then everything else at once. Google's font CSS no longer blocks (branch
  `fix/font-blocking`). The rest may be the simulator's DNS for fonts.googleapis.com, or several
  Safari tabs of the app polling `/api/cloud/remote-sync` every 3 s. To check on a real iPhone.

Tasks skipped because something they need isn't there yet; the work moved on meanwhile.

- **iPhone check of round 2: half done (25 Nov).** Lining figures checked on iPhone 18 Pro: "20m",
  "41m", "1m" and "2 of 2" all sit at full height, so "0m" no longer reads "om". Still waiting:
  "0/wk" on a phone (waits on: an account with a year of no focus; the demo has only 2026, and
  ?year=2025 falls back to it). The formatting itself is covered by the code path above.
- **iPhone check of round 2** (waits on: the iOS Simulator working again): the Dashboard's "0/wk"
  and its lining figures ("0m", not "om") on a phone, and the shorter Recent days / Rhythm profile
  pair before 15 sessions (branch `design/dashboard-empty`).
- ~~**iPhone check of round 2**~~ Done 25 Nov on the iPhone 18 Pro simulator: the Dashboard's
  figures are lining ("0m", "40m"), and Rhythm, Timer, Flow, Dashboard and Settings all lay out right.

## design/stepper-glyphs (25 Nov)

1. Settings, Daily focus goal: the stepper's minus came out as a short dash next to a full-size
   plus (the font draws − smaller than +). Both are now drawn as matching icons, same size and
   stroke. Checked on the iPhone: they match and still change the goal (it saves). 16 tests pass.

## design/timer-end-choice (26 Nov)

1. Settings > Timer, "When it reaches zero": on a phone the three equal columns broke "Keep
   ringing" and "Count overtime" over two lines next to a one-line "Stop". On phones each choice
   now takes the width its words need, so all three sit on one line (they still wrap on the very
   narrowest screens rather than spill). Checked on the iPhone; 16 tests pass.

## Checked in the real apps (19 Nov)

- **Android app:** built from this branch (`mobile/`, debug build) and installed on a Pixel 8
  emulator. It opens on the sign-in page with no start-up errors; Timer, Flow and the Dashboard
  send you to sign in first, as they should. Phones get no hover effects (checked: no mouse).
- **iPhone home-screen app:** built from this branch with `build_web.py --iphone` into a scratch
  folder (`docs/app` was not touched) and served from this Mac. In Safari the "Use it as an app"
  hint shows; Add to Home Screen names it "Muhurta" with the gold icon and "Open as Web App" on.
  Opened from the home screen it has no Safari bar, the hint hides itself, the header clears the
  camera cut-out and the whole sign-in form fits on one screen.
- **Not checked:** anything after sign-in in either app. Both sign in to the live service, and I
  did not sign in there. Those screens were checked in the browser instead (items above).

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
"Your streak no longer drops to 0 in the morning: today counts once it's over, and until you focus the Dashboard shows the run up to yesterday.",
"The year chart marks today and fades the days still to come; in the dark theme, more focus now shows brighter.",
"Clearer to use: boxes you type into have a visible edge, keyboard focus always shows a gold ring, and small buttons are easier to hit.",
```

## Good to know before merging

- The unmerged "Activities" branch (`ccr-fa74c739-y3z13x`) and this one both add styles at the
  end of `static/css/app.css` and both add to `dashboard.js`, `dashboard.html`, `history.js`
  and `base.html`. Git will ask for a hand where they meet (keep both sides each time; they
  don't change the same lines' meaning). That branch is also behind `main` in `db.py`,
  `release_notes.py` and the tests workflow, independent of anything here.
- No version bump or release note is in this branch: nothing ships until you choose.
- The four Python test files in `tests/` are scripts that each replace the sign-in service or the
  data folder for the whole run, so run them one at a time (`python tests/test_sign_in.py`, and
  the same for `test_shared_time.py`, `test_devices.py` and `test_streak.py`). All four pass. Running them together
  with `python -m unittest discover` makes them clash and fail, on `main` too.

## Ideas not done yet

(see the end of this file as the list grows)

## Even line breaks (branch `design/text-wrap`)
- Headings use `text-wrap: balance`; paragraphs, list items, labels and small notes use `text-wrap: pretty`.
- No single short word alone on a last line (Settings > Rhythm: "…what a good day looks like." used to leave "like." by itself).
- Checked on the iPhone 18 Pro simulator. Browsers without support wrap as before.
## Time left to the daily goal (branch `fix/goal-remaining`)
- With 1m of focus today the Dashboard said "2h to your 2h goal": the ring shows rounded minutes (0.6 → "1m") but the note rounded 120 − 0.6 = 119.4 up to 120.
- The note now subtracts the same rounded minutes the ring shows: "1h 59m to your 2h goal".
## Dashboard figures two by two on a phone (branch `design/dashboard-grid`)
- Under 720px the four figures (Focus, Streak, Avg / active day, Consistency) stacked one per row, each short number filling a whole card and pushing Today's ring off the first screen.
- They now stay in a 2×2 grid down to 340px wide (the installed app's `is-mobile` layout already did this). Only narrower screens stack them.
- Checked on the iPhone 18 Pro simulator.
- Settings on a phone browser: the section strip (Rhythm, Timer, Sound, Appearance, Notif…) ended in a
  hard cut mid-word. The side with more tabs past it now fades out over 2.5rem (settings.js sets
  `more-before` / `more-after` as it scrolls), so the cut reads as "more this way".
- Timer's "When it reaches zero" choice gave each option a third of the width, so "Keep ringing" and
  "Count overtime" wrapped to two lines beside a one-line "Stop". On a phone the three now share the
  width by their words, one line each. The theme switch (Dark / Light / System) keeps equal thirds.
  Checked on the iPhone 18 Pro simulator; 16 tests pass.
- Settings goal stepper: on a touch screen the − and + buttons are now 44px (were 36px), easier to hit with a thumb. Checked on the iPhone.
## improve/notify-wording (from improve/round-2-polish)
- Settings → Notifications on a phone said "Desktop notifications" and "This browser can't show desktop notifications." Now "Browser notifications", and the unsupported note adds that bells still ring if sound is on. No "add to Home Screen" hint: Muhurta has no web manifest, so that wouldn't work yet. Checked on the iPhone.
## fix/overtime-hours (from improve/round-2-polish)
- Rhythm's overtime clock (and the tab title) counted minutes past 60: "+513:58". Now hours lead past an hour, "+8:33:58", as the Timer page already did. Checked on the iPhone.
## improve/whole-percent (from improve/round-2-polish)
- Productivity on Rhythm and Flow read "100.0%"; whole numbers now drop the ".0" ("100%", "87.5%"), like the Dashboard's "3/wk". Checked on the iPhone (Rhythm). Flow on the iPhone, 25 Nov: a running session reads "100%" with this branch and "100.0%" without it.
