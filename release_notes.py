"""What changed in each version, shown once after an update ("What's new").

Newest first. Write for the people using the timer, not for developers:
a few short lines per version, about what they will notice. Versions with
nothing worth telling can be left out.
"""
NOTES = {
    "1.12.1": [
        "Phones now have Feedback in Settings too, like the computer.",
        "Clearer icons in the phone's bottom bar: an hourglass for Rhythm, the infinity sign for Flow "
        "(as on the Mac) and a cog for Settings.",
    ],
    "1.12.0": [
        "iPhone: a bell and a notification now tell you when focus or rest ends, even with the phone "
        "locked. Add the app to your Home Screen, then turn it on in Settings > Notifications.",
    ],
    "1.11.2": [
        "Updating no longer looks frozen: after \"Update now\" a line fills as the update downloads, "
        "with the percentage, then says when it is installing and reopening.",
        "New in Settings: Feedback. Tell the maker what you like, what you don't, what could be better "
        "or what you'd like next, and see whether it was read.",
    ],
    "1.11.1": [
        "The \"new version\" notice is calmer: a short title, a small Download button, and on a phone "
        "one slim line that stays clear of the clock.",
        "\"Time's up\", \"What's new\" and \"Please update\" match it: same spacing, centred, no "
        "odd line breaks, and on a phone the buttons share the row evenly.",
    ],
    "1.11.0": [
        "A calmer Timer: one soft time in the ring. Tap it and type to change it (25, 5:30 or 1:30:00; "
        "Enter starts), or pick a quick length under the ring.",
        "Mac menu bar: a flame while you focus and a tea cup while you rest, so you can tell at a glance. "
        "Flow shows an infinity sign.",
        "Creating a password is calmer: one hint line, a strength bar, and \"Copy website\" next to "
        "\"Copy password\" for saving it in a password manager.",
        "This \"What's new\" card now scrolls inside, so a long list never runs off the screen.",
        "The keyboard shortcut list now says what Space really does.",
    ],
    "1.10.1": [
        "Windows: the app now opens in its own window after unzipping with Extract All too. "
        "In 1.9.0 and 1.10.0 it opened in a browser window instead.",
    ],
    "1.10.0": [
        "New: Muhurta Pomodoro for Android. Get it from the website on your phone, sign in with the same "
        "account, and your history, combinations and settings are there too.",
        "Use the phone and the computer side by side: changes go both ways on their own, and time both of "
        "them timed at once counts only once on the dashboard.",
        "On the phone, a bell and a notification tell you when focus or rest ends, even with the app "
        "closed or the screen off.",
    ],
    "1.9.0": [
        "On Windows the app now opens in its own window, like on a Mac, with its own icon in the taskbar. "
        "The time left shows on its taskbar button.",
        "On Windows, notifications now always arrive as Windows notifications, with nothing to allow first.",
        "On Windows, opening the app while it's already open brings its window back instead of opening another one.",
        "Everything fits any window size now, from a small corner of the screen to full screen.",
        "Fixed: the window's title no longer flickers while the Timer counts down.",
    ],
    "1.8.0": [
        "New: Timer. Type any length (or tap 5m to 1h), press Start, and it counts down. "
        "It counts as focus, like everything else.",
        "What the Timer does at zero is up to you in Settings > Timer: stop with one chime, "
        "keep ringing until you dismiss it, or keep counting the extra time.",
        "The cycles you know are now called Rhythm, so the tabs read Rhythm, Timer, Flow. "
        "Starting one pauses whichever other one is running.",
        "Sound is simpler: the two bells, and one volume slider that works smoothly all the way.",
    ],
    "1.7.2": [
        "If the app can't check for updates for a few days, it now tells you, so you never get stuck "
        "on an old version without knowing.",
        "The app now tells your account which version it runs, so updates can reach everyone. "
        "Nothing else is sent besides your own sessions and settings.",
    ],
    "1.7.1": [
        "Update notices now work. Earlier versions could never tell that a new version was out; "
        "from now on you'll see \"Update now\" whenever there is one. Settings > About shows when "
        "it last checked.",
        "Creating a password? \"Suggest a strong password\" makes one for you, with a button to copy it.",
        "Saving your password in Passwords? Use the website harsh-0024.github.io/muhurta-pomodoro "
        "with your email (also shown in Settings > Account).",
    ],
    "1.7.0": [
        "You now sign in with a free account: your name, a username, your email and a password. "
        "Your sessions, combinations and settings are kept in your account and appear on every "
        "computer you sign in on.",
        "The history already on this computer was added to your account the first time you signed in. "
        "Signing out saves everything to your account first, then clears it from this computer.",
        "Forgot your password? \"Forgot password?\" on the sign-in screen emails you a code to set a new one.",
        "On a Mac, the running timer or Flow now shows in the menu bar, like Apple's Clock. "
        "Click it to bring the window back.",
    ],
    "1.6.0": [
        "Muhurta Pomodoro is now a proper Mac app. Download it from the website, drag it "
        "into Applications, and it opens in its own window with its own Dock icon. "
        "No Terminal, no Chrome.",
        "The Mac app updates itself: when a new version is out, click \"Update now\".",
        "A new website to share: harsh-0024.github.io/muhurta-pomodoro",
    ],
    "1.5.3": [
        "On a Mac, the timer now opens even when Chrome is closed.",
    ],
    "1.5.2": [
        "When a new version is out, a notice at the bottom of the window offers it. "
        "\"Update now\" installs it in a few seconds. Your timer and history are kept.",
        "After an update, this card tells you what changed.",
    ],
    "1.5.1": [
        "The website has a new address: harsh-0024.github.io/muhurta-pomodoro",
    ],
    "1.5.0": [
        "The timer is now called Muhurta Pomodoro.",
        "On a Mac, the downloadable app opens in its own window with its own Dock icon, "
        "and installs like any other app: open the .dmg and drag it to Applications.",
        "Starting the app no longer stalls for half a minute on some networks.",
    ],
}
