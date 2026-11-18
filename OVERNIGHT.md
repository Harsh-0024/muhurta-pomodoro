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

Checked and clean (no change needed): the not-found page; History (Settings → History) by day and
"Unusually long" with its empty state, both tabs readable; Flow, Timer and Rhythm on the iPhone;
the Dashboard's charts label values on their bars, so they have no odd side scales.

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
