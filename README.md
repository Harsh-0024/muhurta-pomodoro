# Muhurta Pomodoro

A calm focus timer for your Mac, built on the old Indian units of time:
**1 Muhurta = 48 min · 1 Ghadi = 24 min**. Rhythm runs eight levels of focus
and rest, Timer counts down any time you set, Flow is a no-countdown
stopwatch, and there's a rest pool and a dashboard of your focus over the year. It is free
but needs a (free) account: you confirm your email with a code once, choose a
password, and from then on sign in with email and password. Your history,
combinations and settings are kept in your account and appear on every computer
you sign in on. After signing in it works offline and syncs when back online.

## Get the app

**https://harsh-0024.github.io/muhurta-pomodoro/** — that is the one link to
share. It downloads the right file and shows each step.

- **Mac (Apple Silicon):** open `Muhurta-Pomodoro-macos-arm64.dmg` and drag
  **Muhurta Pomodoro** onto **Applications**. The first time you open it, macOS
  says it could not check the app: click **Done**, then **System Settings →
  Privacy & Security → Open Anyway**. After that it opens like any other app,
  in its own window with its own Dock icon. (The warning is only because the
  app isn't registered with Apple, which costs $99 a year.)
- **Windows (64-bit):** unzip `Muhurta-Pomodoro-windows-x64.zip` and
  double-click `Muhurta Pomodoro.exe`. SmartScreen says *Windows protected your
  PC*: click **More info → Run anyway** (first time only). On Windows the timer
  still opens in an Edge or Chrome window.

- **iPhone and iPad:** open
  **https://harsh-0024.github.io/muhurta-pomodoro/app/** in Safari, tap
  **Share → Add to Home Screen**, then open Muhurta from the Home Screen and sign
  in. It's a web app, not an App Store app (so it costs nothing to publish): it
  opens full screen like an app, works fully offline after the first visit, and
  uses the network only to sign in, sync and update. With notifications allowed
  (Settings → Notifications, iOS 16.4+), the end of a block arrives as a
  notification even with the phone locked; without them, the screen stays on
  while a timer runs. The notifications need a one-time server setup:
  [`supabase/PUSH.md`](supabase/PUSH.md).

**Updates:** when a new version is out, the app shows a notice. On a Mac,
**Update now** downloads it, swaps it in and reopens; on Windows, **Download**
opens the download page. Either way your history is kept, and afterwards a
card shows what changed.

## Where's my data?

| | Path |
|---|---|
| macOS | `~/Library/Application Support/MuhurataTimer/` |
| Windows | `%LOCALAPPDATA%\MuhurataTimer\` |

Your data lives in your account (Supabase); this folder holds the copy for
whoever is signed in on this computer. Signing out uploads anything left and
then clears it, so the next person to sign in sees only their own. The first
time someone signs in after upgrading, the history already on the computer is
added to their account.

Inside: `focus_timer.db` (everything), `cloud_session.json` (the sign-in),
`backups/` (automatic copies taken
before any database upgrade, newest 3 kept), `launcher.log` (send it along if
something goes wrong). Replacing or updating the app never touches this folder.

---

## The Terminal edition (retired)

Before v1.6.0 the main way to install was a one-line Terminal command that
cloned this repository, set up Python and opened the timer in a Chrome window.
It is no longer offered on the website, but it is **kept, not removed**:

- The last version built around it is tagged
  [`terminal-edition`](https://github.com/Harsh-0024/muhurta-pomodoro/tree/terminal-edition).
- `install.sh`, `install.ps1` and `packaging/make_macos_app.sh` stay in place,
  because installs made that way still update themselves from this repository
  on every start. Since v1.6.0 those installs suggest the Mac app once (same
  data, so nothing is lost).

For reference, the old commands were:

```bash
curl -fsSL https://raw.githubusercontent.com/Harsh-0024/muhurta-pomodoro/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/Harsh-0024/muhurta-pomodoro/main/install.ps1 | iex
```

Diagnostics for such an install: `~/MuhurataTimer/.venv/bin/python
~/MuhurataTimer/run.py --doctor` (macOS / Linux). For the app, run
`"Muhurta Pomodoro.app/Contents/MacOS/Muhurta Pomodoro" --doctor`.

---

## Development

```bash
git clone https://github.com/Harsh-0024/muhurta-pomodoro.git && cd muhurta-pomodoro
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
.venv/bin/python run.py --no-update      # or: python app.py (debug server on :8000)
```

**Phones** — `mobile/` holds the Android app (Capacitor) and the iPhone web
app. Both are the same screens with the Python side rewritten in JavaScript
(`mobile/web/local-api.js`, `account.js`), keeping the data in the phone's
IndexedDB and syncing with the account. `python mobile/build_web.py` builds the
Android pages into `mobile/www`; `python mobile/build_web.py --iphone` builds the
iPhone app into `docs/app` (service worker, manifest and icons included). The
release workflow rebuilds `docs/app` for each tag and commits it to `main`.

`run.py` is the launcher for every kind of copy: it migrates the database,
starts the local server and opens the window (the app's own window in the Mac
bundle, a browser window otherwise). The website is in `docs/` (GitHub Pages).

**Schema changes** — edit `schema.py`, then generate a migration and review it
before committing (autogenerate can turn a rename into drop + add):

```bash
.venv/bin/python -m alembic revision --autogenerate -m "describe change"
```

Migrations apply automatically on the next start (a backup is taken first).

**Releases** — bump `version.py`, add a few plain lines for users to
`release_notes.py` (the "What's new" card), then:

```bash
git tag v1.6.1 && git push origin main v1.6.1
```

GitHub Actions builds the Mac `.dmg`/`.zip` and the Windows `.zip` and attaches
them to a release; installed apps pick it up from there. Local build:
`pip install -r requirements-dev.txt && python -m PyInstaller muhurata.spec`.
