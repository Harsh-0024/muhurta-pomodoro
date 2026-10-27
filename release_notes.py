"""What changed in each version, shown once after an update ("What's new").

Newest first. Write for the people using the timer, not for developers: a few
short lines per version, about what they will notice.

Each line is for every device unless wrapped in only(...): only(MAC, "...")
for the Mac app, only(PHONES, "...") for Android and iPhone, and so on. A
person only sees, and is only invited to update for, lines for their device.
Keep every line: this is the full record. The card makes it short: one
version's lines as they are, or, after skipping several, a summary written
from these lines (supabase/functions/whats-new), falling back to the lines.

Run `python release_notes.py` to write docs/release-notes.json, which the
apps read to decide whether a new version has anything for them (the
release build does this on every tag).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

MAC, WINDOWS, ANDROID, IPHONE = "mac", "windows", "android", "iphone"
DEVICES = (MAC, WINDOWS, ANDROID, IPHONE)
COMPUTERS = (MAC, WINDOWS)
PHONES = (ANDROID, IPHONE)


def only(devices, text: str) -> dict:
    """A line for some devices only (a name like MAC, or a group like PHONES)."""
    devices = (devices,) if isinstance(devices, str) else tuple(devices)
    assert all(d in DEVICES for d in devices), devices
    return {"text": text, "for": list(devices)}


NOTES = {
    "1.15.0": [
        'The dashboard now shows how long you usually focus, week by week. A gentle line you can watch rise, with a small next step to aim for. Tap the "i" beside it for a short explanation.',
        "A break under 5 minutes no longer splits your focus in two: it counts as one sitting, everywhere.",
    ],
    "1.14.0": [
        "The Timer's quick lengths now fit you: your usual focus length sits in the middle, with shorter and longer steps around it, taken from your own rhythms.",
        only(PHONES, "Phones show what's running in notifications, like the Mac menu bar. On Android a live clock, also on the lock screen; on iPhone a quiet note saying until when."),
        'Rhythm now says "Overtime" when you focus past a block, the same as the Timer.',
        only(COMPUTERS, "An update in progress keeps showing its progress when you switch tabs."),
        only(IPHONE, "iPhone: Settings shows your notification choice at once, and says if alerts with the app closed aren't set up yet."),
    ],
    "1.13.0": [
        "Sign in with Google or Microsoft: one tap on the sign-in screen, on the Mac, Windows, iPhone and Android. Use the same email as before and it opens your existing account, with all your history.",
        "New to the app? After Google or Microsoft you just pick a username, and you're in.",
        'Creating a password is calmer, with a "Suggest a strong password" button and the website to save it under in your password manager.',
    ],
    "1.12.1": [
        only(PHONES, "Phones now have Feedback in Settings too, like the computer."),
        only(PHONES, "Clearer icons in the phone's bottom bar: an hourglass for Rhythm, the infinity sign for Flow (as on the Mac) and a cog for Settings."),
    ],
    "1.12.0": [
        only(IPHONE, "iPhone: a bell and a notification now tell you when focus or rest ends, even with the phone locked. Add the app to your Home Screen, then turn it on in Settings > Notifications."),
    ],
    "1.11.2": [
        only(COMPUTERS, 'Updating no longer looks frozen: after "Update now" a line fills as the update downloads, with the percentage, then says when it is installing and reopening.'),
        only(COMPUTERS, "New in Settings: Feedback. Tell the maker what you like, what you don't, what could be better or what you'd like next, and see whether it was read."),
    ],
    "1.11.1": [
        'The "new version" notice is calmer: a short title, a small Download button, and on a phone one slim line that stays clear of the clock.',
        '"Time\'s up", "What\'s new" and "Please update" match it: same spacing, centred, no odd line breaks, and on a phone the buttons share the row evenly.',
    ],
    "1.11.0": [
        "A calmer Timer: one soft time in the ring. Tap it and type to change it (25, 5:30 or 1:30:00; Enter starts), or pick a quick length under the ring.",
        only(MAC, "Mac menu bar: a flame while you focus and a tea cup while you rest, so you can tell at a glance. Flow shows an infinity sign."),
        'Creating a password is calmer: one hint line, a strength bar, and "Copy website" next to "Copy password" for saving it in a password manager.',
        'This "What\'s new" card now scrolls inside, so a long list never runs off the screen.',
        only(COMPUTERS, "The keyboard shortcut list now says what Space really does."),
    ],
    "1.10.1": [
        only(WINDOWS, "Windows: the app now opens in its own window after unzipping with Extract All too. In 1.9.0 and 1.10.0 it opened in a browser window instead."),
    ],
    "1.10.0": [
        only(ANDROID, "New: Muhurta Pomodoro for Android. Get it from the website on your phone, sign in with the same account, and your history, combinations and settings are there too."),
        "Use the phone and the computer side by side: changes go both ways on their own, and time both of them timed at once counts only once on the dashboard.",
        only(ANDROID, "On the phone, a bell and a notification tell you when focus or rest ends, even with the app closed or the screen off."),
    ],
    "1.9.0": [
        only(WINDOWS, "On Windows the app now opens in its own window, like on a Mac, with its own icon in the taskbar. The time left shows on its taskbar button."),
        only(WINDOWS, "On Windows, notifications now always arrive as Windows notifications, with nothing to allow first."),
        only(WINDOWS, "On Windows, opening the app while it's already open brings its window back instead of opening another one."),
        only(COMPUTERS, "Everything fits any window size now, from a small corner of the screen to full screen."),
        only(COMPUTERS, "Fixed: the window's title no longer flickers while the Timer counts down."),
    ],
    "1.8.0": [
        "New: Timer. Type any length (or tap 5m to 1h), press Start, and it counts down. It counts as focus, like everything else.",
        "What the Timer does at zero is up to you in Settings > Timer: stop with one chime, keep ringing until you dismiss it, or keep counting the extra time.",
        "The cycles you know are now called Rhythm, so the tabs read Rhythm, Timer, Flow. Starting one pauses whichever other one is running.",
        "Sound is simpler: the two bells, and one volume slider that works smoothly all the way.",
    ],
    "1.7.2": [
        "If the app can't check for updates for a few days, it now tells you, so you never get stuck on an old version without knowing.",
        "The app now tells your account which version it runs, so updates can reach everyone. Nothing else is sent besides your own sessions and settings.",
    ],
    "1.7.1": [
        only(COMPUTERS, 'Update notices now work. Earlier versions could never tell that a new version was out; from now on you\'ll see "Update now" whenever there is one. Settings > About shows when it last checked.'),
        'Creating a password? "Suggest a strong password" makes one for you, with a button to copy it.',
        "Saving your password in Passwords? Use the website harsh-0024.github.io/muhurta-pomodoro with your email (also shown in Settings > Account).",
    ],
    "1.7.0": [
        "You now sign in with a free account: your name, a username, your email and a password. Your sessions, combinations and settings are kept in your account and appear on every computer you sign in on.",
        "The history already on this computer was added to your account the first time you signed in. Signing out saves everything to your account first, then clears it from this computer.",
        'Forgot your password? "Forgot password?" on the sign-in screen emails you a code to set a new one.',
        only(MAC, "On a Mac, the running timer or Flow now shows in the menu bar, like Apple's Clock. Click it to bring the window back."),
    ],
    "1.6.0": [
        only(MAC, "Muhurta Pomodoro is now a proper Mac app. Download it from the website, drag it into Applications, and it opens in its own window with its own Dock icon. No Terminal, no Chrome."),
        only(MAC, 'The Mac app updates itself: when a new version is out, click "Update now".'),
        "A new website to share: harsh-0024.github.io/muhurta-pomodoro",
    ],
    "1.5.3": [
        only(MAC, "On a Mac, the timer now opens even when Chrome is closed."),
    ],
    "1.5.2": [
        only(COMPUTERS, 'When a new version is out, a notice at the bottom of the window offers it. "Update now" installs it in a few seconds. Your timer and history are kept.'),
        "After an update, this card tells you what changed.",
    ],
    "1.5.1": [
        "The website has a new address: harsh-0024.github.io/muhurta-pomodoro",
    ],
    "1.5.0": [
        "The timer is now called Muhurta Pomodoro.",
        only(MAC, "On a Mac, the downloadable app opens in its own window with its own Dock icon, and installs like any other app: open the .dmg and drag it to Applications."),
        only(COMPUTERS, "Starting the app no longer stalls for half a minute on some networks."),
    ],
}


def _version(text) -> tuple:
    return tuple(int(p) for p in re.findall(r"\d+", str(text or ""))[:3])


def item_text(item) -> str:
    return item["text"] if isinstance(item, dict) else str(item)


def item_devices(item) -> list[str]:
    return list(item.get("for") or DEVICES) if isinstance(item, dict) else list(DEVICES)


def lines_for(device: str, after: str | None, upto: str, notes: dict | None = None) -> list[tuple[str, str]]:
    """(version, line) for this device, for versions after `after` up to and
    including `upto`, newest first. `after` None means only `upto` itself."""
    notes = NOTES if notes is None else notes
    top = _version(upto)
    low = _version(after) if after else None
    out = []
    for v, items in notes.items():
        mine = _version(v)
        if mine > top or (low is not None and mine <= low) or (low is None and mine != top):
            continue
        out.extend((v, item_text(i)) for i in items if device in item_devices(i))
    return sorted(out, key=lambda vl: _version(vl[0]), reverse=True)


def as_json() -> dict:
    """The record for the apps and the summary server: every line with its devices."""
    return {"versions": {v: [{"text": item_text(i), "for": item_devices(i)} for i in items]
                         for v, items in NOTES.items()}}


if __name__ == "__main__":
    path = Path(__file__).resolve().parent / "docs" / "release-notes.json"
    path.write_text(json.dumps(as_json(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(Path.cwd()) if path.is_relative_to(Path.cwd()) else path}")
