"""Muhurta Pomodoro launcher: update, install, migrate, serve, open the app window.

Double-clicked via the Desktop app/shortcut the installer writes, which
starts it in the background with no Terminal window, or run directly with
``python run.py``. Closing the timer's last window stops it; starting it
while it already runs just opens the window again. Everything is logged to
<data dir>/launcher.log so problems on a friend's machine can be diagnosed;
without a Terminal, problems are shown in a pop-up instead.

Flags:
  --no-update   skip the git self-update (used after re-exec, and handy in dev)
  --no-browser  don't open the app window
  --doctor      print environment / database diagnostics and exit
  --background  (internal) the Mac app's copy that keeps running
  --restarted   (internal) restarted for an update; the window is already open
  --port=N      (internal) the address to use if it is free
"""
from __future__ import annotations

import hashlib
import importlib
import json
import logging
import logging.handlers
import os
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
FROZEN = getattr(sys, "frozen", False)  # running from a PyInstaller bundle
REMOTE_BRANCH = "origin/main"
# A normal update takes under a second. This is the ceiling for a slow or
# half-dead connection: past it we give up and start the app, and the update
# lands on the next launch instead. Waiting is never the user's problem.
UPDATE_BUDGET = 6.0
UV_DIR = Path.home() / ".muhurata" / "bin"
REPAIR_FLAG = "MUHURATA_REPAIRED"  # set across a repair restart, so it happens once
FIRST_PORT = 8000
HOST = "127.0.0.1"
# Started from a Terminal (developer, installer) rather than double-clicked.
INTERACTIVE = bool(sys.stdin and sys.stdin.isatty())
# The downloaded Mac and Windows apps draw their own window (macOS's web view
# or Windows' WebView2, through pywebview), so they have their own Dock or
# taskbar icon. Everything else opens the timer in a browser's app window.
NATIVE_WINDOW = FROZEN and sys.platform in ("darwin", "win32")
# Windows groups windows and notifications under this name (the app's own,
# rather than "Python" or the browser that showed the timer before).
WINDOWS_APP_ID = "Muhurta.Pomodoro"
# Programs run from a no-console app on Windows would each flash a black
# console window; this keeps them hidden.
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
# Bump when the Desktop launcher changes; installs older than this get theirs
# rewritten on the next start. Keep in step with packaging/make_macos_app.sh.
LAUNCHER_VERSION = "3"
SITE = "https://harsh-0024.github.io/muhurta-pomodoro/"
REPO_URL = "https://github.com/Harsh-0024/muhurta-pomodoro.git"
OLD_REPO_URLS = ("https://github.com/harsh-0024/pomodoro-timer.git",
                 "https://github.com/harsh-0024/pomodoro-timer")  # the name before v1.5.1

log = logging.getLogger("muhurata.launcher")


# --------------------------------------------------------------------------- #
# setup
# --------------------------------------------------------------------------- #
def _data_dir() -> Path:
    if os.environ.get("MUHURATA_DATA_DIR"):  # tests and side-by-side copies
        return Path(os.environ["MUHURATA_DATA_DIR"])
    # Same locations platformdirs.user_data_dir("MuhurataTimer", appauthor=False)
    # resolves to, computed by hand because platformdirs isn't installed yet on
    # the very first run.
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "MuhurataTimer"
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "MuhurataTimer"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "MuhurataTimer"


def _setup_logging(data_dir: Path):
    data_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-5s %(message)s", "%Y-%m-%d %H:%M:%S")
    file_h = logging.handlers.RotatingFileHandler(
        data_dir / "launcher.log", maxBytes=512_000, backupCount=2, encoding="utf-8"
    )
    file_h.setFormatter(fmt)
    file_h.setLevel(logging.DEBUG)      # the log keeps everything
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    root.addHandler(file_h)
    if sys.stderr is not None:  # None in a no-console app (pythonw, windowed build)
        console = logging.StreamHandler(sys.stderr)
        console.setFormatter(logging.Formatter("%(message)s"))
        console.setLevel(logging.INFO)      # the screen keeps only plain sentences
        # Per-request lines and tracebacks belong in the file, not in front of
        # someone who is not a programmer.
        console.addFilter(lambda r: not r.name.startswith("werkzeug") and not r.exc_info)
        root.addHandler(console)
    logging.getLogger("alembic").setLevel(logging.WARNING)
    logging.getLogger("werkzeug").setLevel(logging.INFO)


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    log.debug("$ %s", " ".join(cmd))
    return subprocess.run(cmd, cwd=PROJECT_ROOT, capture_output=True, text=True, **NO_WINDOW, **kw)


# --------------------------------------------------------------------------- #
# talking to someone who has no Terminal window
# --------------------------------------------------------------------------- #
def _notice(text: str):
    """A passing note (an update is installing). Terminal users read the log line."""
    if INTERACTIVE:
        return
    if sys.platform == "darwin":
        script = f'display notification {json.dumps(text)} with title "Muhurta Pomodoro"'
        subprocess.Popen(["osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _alert(message: str, copyable: str | None = None):
    """A pop-up that waits for OK. `copyable` goes in a box the person can copy from."""
    if os.environ.get("CI"):
        return  # nobody would click OK on a build machine; the log has it all
    try:
        if sys.platform == "darwin":
            script = f'display alert "Muhurta Pomodoro could not start" message {json.dumps(message)} as critical'
            if copyable:
                script = (f'display dialog {json.dumps(message)} default answer {json.dumps(copyable)} '
                          'with title "Muhurta Pomodoro could not start" with icon caution buttons {"OK"} default button 1')
            subprocess.run(["osascript", "-e", script], capture_output=True, timeout=3600)
        elif sys.platform == "win32":
            import ctypes
            # Ctrl+C in a Windows message box copies all of its text.
            text = message + (f"\n\n{copyable}\n\n(Press Ctrl+C to copy this message.)" if copyable else "")
            ctypes.windll.user32.MessageBoxW(None, text, "Muhurta Pomodoro could not start", 0x10)
        elif shutil.which("zenity"):
            subprocess.run(["zenity", "--error", "--title=Muhurta Pomodoro", f"--text={message}\n\n{copyable or ''}"],
                           capture_output=True, timeout=3600)
    except Exception:  # a pop-up that fails must not hide the real problem
        log.debug("could not show a pop-up", exc_info=True)


# --------------------------------------------------------------------------- #
# steps
# --------------------------------------------------------------------------- #
def _online(timeout: float = 3.0) -> bool:
    try:
        socket.create_connection(("github.com", 443), timeout=timeout).close()
        return True
    except OSError:
        return False


def _follow_repo_rename():
    """Point an install made under the repository's old name at the new one.

    GitHub forwards the old name for now, but only until something else
    takes that name, so do not rely on it."""
    current = _run(["git", "remote", "get-url", "origin"]).stdout.strip()
    if current.lower() in OLD_REPO_URLS:
        _run(["git", "remote", "set-url", "origin", REPO_URL])
        log.debug("origin: %s -> %s", current, REPO_URL)


def self_update() -> bool:
    """Fast-forward the checkout to origin/main. Returns True if code changed.

    Uses fetch + reset --hard rather than pull so a friend's copy can never
    end up in a merge conflict. Skipped when the tree has local edits or
    unpushed commits, which protects a developer checkout from being wiped.
    Every step is time-boxed: a slow connection must not delay startup.
    """
    if FROZEN or not (PROJECT_ROOT / ".git").is_dir():
        log.debug("Not a git checkout; skipping update.")
        return False
    if _run(["git", "--version"]).returncode != 0:
        log.warning("git not found; skipping update check.")
        return False
    if _run(["git", "status", "--porcelain", "--untracked-files=no"]).stdout.strip():
        log.warning("This copy has local changes; skipping update.")
        return False

    deadline = time.monotonic() + UPDATE_BUDGET
    if not _online(timeout=2.0):
        log.info("No internet just now - starting your installed version.")
        return False

    log.info("Checking for updates...")
    _follow_repo_rename()
    before = _run(["git", "rev-parse", "HEAD"]).stdout.strip()
    try:
        fetch = _run(["git", "fetch", "--quiet", "origin"],
                     timeout=max(1.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        log.info("Slow connection - starting now, I will update next time.")
        return False
    if fetch.returncode != 0:
        log.info("Could not reach GitHub - starting now, I will update next time.")
        return False

    remote = _run(["git", "rev-parse", REMOTE_BRANCH]).stdout.strip()
    if _run(["git", "rev-list", "--count", f"{REMOTE_BRANCH}..HEAD"]).stdout.strip() not in ("", "0"):
        log.warning("This copy is ahead of %s; skipping update.", REMOTE_BRANCH)
        return False
    if before == remote:
        log.info("Already the newest version.")
        return False
    if _run(["git", "reset", "--hard", "--quiet", REMOTE_BRANCH]).returncode != 0:
        log.info("Update did not apply - starting your installed version.")
        return False
    log.info("Updated to the newest version. Restarting...")
    log.debug("%s -> %s", before[:7], remote[:7])
    return True


def _uv() -> str | None:
    local = UV_DIR / ("uv.exe" if sys.platform == "win32" else "uv")
    if local.exists():
        return str(local)
    return shutil.which("uv")


def _wanted_python() -> str | None:
    pin = PROJECT_ROOT / ".python-version"
    try:
        return pin.read_text().strip() or None
    except OSError:
        return None


def ensure_python_version() -> bool:
    """Rebuild the virtualenv when the pinned Python version has changed.

    Lets a new Python version ship like any other change: bump
    .python-version, and each install fetches it on the next launch.
    Returns True if the venv was rebuilt (the caller must then re-exec).
    """
    if FROZEN:
        return False
    want = _wanted_python()
    if not want:
        return False
    have = "%d.%d" % sys.version_info[:2]
    if have == want:
        return False

    uv = _uv()
    if not uv:
        log.warning("This copy needs Python %s (running %s), but the toolchain is missing. "
                    "Re-run the install command to fix it.", want, have)
        return False

    venv = PROJECT_ROOT / ".venv"
    if not venv.exists():
        return False
    # The new environment is built next to the old one and only swapped in
    # once it is complete. Rebuilding in place meant a failure halfway left
    # no environment at all, and the app could not start until reinstalled.
    new, old = venv.with_name(".venv.new"), venv.with_name(".venv.old")
    for leftover in (new, old):  # from an earlier attempt that was cut short
        shutil.rmtree(leftover, ignore_errors=True)
    log.info("Switching to Python %s - one moment...", want)
    _notice("Installing an update - this takes a minute, only this once.")
    try:
        subprocess.run([uv, "python", "install", want], cwd=PROJECT_ROOT,
                       capture_output=True, timeout=600, **NO_WINDOW)
        # --seed keeps pip inside it for install_requirements(); --relocatable
        # so nothing in it remembers the .venv.new path after the rename.
        done = subprocess.run([uv, "venv", "--seed", "--relocatable", "--python", want, str(new)],
                              cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=600, **NO_WINDOW)
    except (subprocess.TimeoutExpired, OSError) as exc:
        shutil.rmtree(new, ignore_errors=True)
        log.warning("Could not switch Python version; continuing on %s.", have)
        log.debug(exc)
        return False
    if done.returncode != 0 or not _venv_python(new).exists():
        shutil.rmtree(new, ignore_errors=True)
        log.warning("Could not switch Python version; continuing on %s.", have)
        log.debug(done.stderr)
        return False
    # Two renames, so .venv is only ever the old environment or the new one.
    # This process keeps running from the renamed old one until the re-exec.
    try:
        venv.rename(old)
    except OSError as exc:  # e.g. Windows, where the running python.exe is locked
        shutil.rmtree(new, ignore_errors=True)
        log.warning("Could not switch Python version; continuing on %s.", have)
        log.debug(exc)
        return False
    try:
        new.rename(venv)
    except OSError as exc:
        old.rename(venv)
        shutil.rmtree(new, ignore_errors=True)
        log.warning("Could not switch Python version; continuing on %s.", have)
        log.debug(exc)
        return False
    shutil.rmtree(old, ignore_errors=True)  # anything left is retried next time
    # The new venv is empty, so the packages must be installed again. Its own
    # marker starts out missing; this clears the fallback one in the data dir.
    (_data_dir() / "requirements.sha256").unlink(missing_ok=True)
    log.info("Now on Python %s.", want)
    return True


def _venv_python(venv: Path) -> Path:
    return venv / ("Scripts" if sys.platform == "win32" else "bin") / (
        "python.exe" if sys.platform == "win32" else "python")


def _requirements_marker(data_dir: Path) -> Path:
    """Where we record which requirements this environment has.

    It lives *inside* the virtualenv on purpose. A marker in the data dir
    outlives the environment it describes, so rebuilding the venv (a new
    Python version, a repair) left a stale "already installed" note behind
    and the app started with no packages at all.
    """
    try:
        venv = Path(sys.prefix)
        if os.access(venv, os.W_OK):
            return venv / ".muhurata-requirements"
    except OSError:
        pass
    return data_dir / "requirements.sha256"


def install_requirements(data_dir: Path, force: bool = False):
    if FROZEN:
        return  # everything is baked into the bundle
    req = PROJECT_ROOT / "requirements.txt"
    digest = hashlib.sha256(req.read_bytes()).hexdigest()
    marker = _requirements_marker(data_dir)
    if not force and marker.exists() and marker.read_text().strip() == digest:
        return
    log.info("Installing new components - this can take a minute, only this once...")
    _notice("Installing an update - this takes a minute, only this once.")
    uv = _uv()
    # A repair must not trust the existing install: a package whose files are
    # damaged still leaves its metadata behind, and a plain install would call
    # that "already satisfied" and change nothing.
    cmds = []
    if uv:
        cmds.append([uv, "pip", "install", "--python", sys.executable, "-q"]
                    + (["--reinstall"] if force else []) + ["-r", str(req)])
    cmds.append([sys.executable, "-m", "pip", "install", "--quiet",
                 "--disable-pip-version-check"]
                + (["--force-reinstall"] if force else []) + ["-r", str(req)])
    last = None
    for cmd in cmds:
        # Captured, not streamed: pip's failure output is frightening and
        # useless to a friend. It goes to launcher.log, which is what gets
        # sent back when something really is wrong.
        last = subprocess.run(cmd, cwd=PROJECT_ROOT, capture_output=True, text=True, **NO_WINDOW)
        if last.returncode == 0:
            break
        log.debug("%s failed:\n%s\n%s", cmd[0], last.stdout, last.stderr)
    else:
        log.debug("Could not install components. Installer said:\n%s\n%s",
                  (last.stdout or "").strip(), (last.stderr or "").strip())
        raise RuntimeError("Could not install the required components.")
    try:
        marker.write_text(digest)
    except OSError:
        pass  # worst case we reinstall next time; not worth failing over
    log.info("Done.")


def free_port(start: int = FIRST_PORT, attempts: int = 50) -> int:
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in {start}-{start + attempts}")


def _app_browsers() -> list[Path]:
    """Chromium-family browsers that can show a page as its own app window."""
    if sys.platform == "darwin":
        names = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"]
        roots = [Path("/Applications"), Path.home() / "Applications"]
        return [r / f"{n}.app" / "Contents" / "MacOS" / n for n in names for r in roots]
    if sys.platform == "win32":
        exes = [r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe",
                r"BraveSoftware\Brave-Browser\Application\brave.exe"]
        roots = [os.environ.get(v) for v in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        return [Path(r) / e for e in exes for r in roots if r]
    names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
             "microsoft-edge", "brave-browser"]
    return [Path(p) for p in map(shutil.which, names) if p]


def open_app_window(url: str):
    """Open the timer in its own window (no tabs, no address bar).

    Chrome/Edge's --app mode makes the page look like a standalone program.
    Without one of those browsers, a normal tab in the default browser.
    """
    for exe in _app_browsers():
        if not exe.is_file():
            continue
        if sys.platform == "darwin":
            # Through LaunchServices, as the Dock would. Started directly, a
            # browser that is not already running counts as ours, and newer
            # macOS then blocks it from its own profile folder, so it quits
            # at once and no window appears.
            app_bundle = exe.parents[2]
            done = _run(["open", "-na", str(app_bundle), "--args", f"--app={url}"])
            if done.returncode == 0:
                log.debug("Opened app window with %s", app_bundle)
                return
            log.debug("Could not open %s: %s", app_bundle, done.stderr)
            continue
        try:
            # A session of its own, so the browser survives the launcher
            # window being closed (which kills everything it started).
            kw = ({"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
                  if sys.platform == "win32" else {"start_new_session": True})
            subprocess.Popen([str(exe), f"--app={url}"], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)
            log.debug("Opened app window with %s", exe)
            return
        except OSError as exc:
            log.debug("Could not start %s: %s", exe, exc)
    log.debug("No app-mode browser found; opening a normal tab.")
    webbrowser.open(url)


def _open_when_ready(url: str, open_browser: bool):
    for _ in range(100):  # ~20s
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if resp.status == 200:
                    break
        except Exception:
            time.sleep(0.2)
    else:
        log.warning("Server did not respond in time; open %s manually.", url)
        return
    log.info("Muhurta Pomodoro is running at %s  (close the timer window to stop it)", url)
    if open_browser:
        open_app_window(url)


# --------------------------------------------------------------------------- #
# one copy at a time, and quitting when the last window closes
# --------------------------------------------------------------------------- #
def _running_file(data_dir: Path) -> Path:
    return data_dir / "running.json"


def _already_running(data_dir: Path) -> str | None:
    """The address of a copy of the timer that is already running, if any."""
    try:
        url = json.loads(_running_file(data_dir).read_text())["url"]
        with urllib.request.urlopen(url + "api/version", timeout=2) as resp:
            if resp.status == 200:
                return url
    except Exception:
        pass
    return None


_INSTANCE_LOCK = None


def _first_copy(data_dir: Path) -> bool:
    """Whether this is the only copy starting for this data folder (Windows).

    running.json is written only once a copy is ready, which takes a few
    seconds, so a quick second double-click used to start a second copy
    beside the first. A named lock that Windows frees when the process ends
    closes that gap.
    """
    global _INSTANCE_LOCK
    if sys.platform != "win32":
        return True
    import ctypes

    name = "Local\\MuhurtaPomodoro-" + hashlib.sha1(str(data_dir).lower().encode()).hexdigest()[:16]
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    _INSTANCE_LOCK = kernel32.CreateMutexW(None, False, name)
    return not (_INSTANCE_LOCK and kernel32.GetLastError() == 183)  # ERROR_ALREADY_EXISTS


def _release_first_copy():
    """Before restarting in place (os.exec*), so the new process can take the lock."""
    global _INSTANCE_LOCK
    if _INSTANCE_LOCK:
        import ctypes

        ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(_INSTANCE_LOCK))
        _INSTANCE_LOCK = None


def _wait_for_other_copy(data_dir: Path, seconds: float = 45) -> str | None:
    """The address of the copy that is starting at the same moment, once it is ready."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        running = _already_running(data_dir)
        if running:
            return running
        time.sleep(0.5)
    return None


def _final_sync():
    """One last sync so a session finished just before closing is not left
    waiting for the next start. Bounded: closing must never hang."""
    import sync

    final = threading.Thread(target=sync.run_once, daemon=True)
    final.start()
    final.join(timeout=20)


def _quit_when_closed(server, data_dir: Path):
    """Stop the server once every timer window has been closed (see presence.py)."""
    import presence

    while True:
        time.sleep(5)
        if presence.should_quit():
            break
    log.info("The timer window was closed - stopping.")
    _final_sync()
    server.shutdown()


# --------------------------------------------------------------------------- #
# the downloaded Mac app updating itself
# --------------------------------------------------------------------------- #
UPDATE_DMG_URL = os.environ.get(  # overridable for tests
    "MUHURATA_UPDATE_URL",
    "https://github.com/Harsh-0024/muhurta-pomodoro/releases/latest/download/Muhurta-Pomodoro-macos-arm64.dmg",
)


def _this_app() -> Path | None:
    """The .app this copy runs from, if it can be replaced where it is."""
    if not NATIVE_WINDOW:
        return None
    app = Path(sys.executable).resolve().parents[2]
    if app.suffix != ".app":
        return None
    # Opened straight from the disk image, or from the read-only copy macOS
    # makes of an app that was never moved out of Downloads: nothing to replace.
    if str(app).startswith("/Volumes/") or "AppTranslocation" in str(app):
        return None
    return app if os.access(app.parent, os.W_OK) else None


def _old_app(app: Path) -> Path:
    return app.with_name(f".{app.name}.old")


def _install_app_update(app: Path, data_dir: Path, progress=lambda stage, percent=None: None):
    """Download the newest .dmg and swap its app in for this one.

    The running copy keeps working after the swap (its files stay open), so
    it can finish up, quit and reopen as the new version. A download made
    by the app itself carries no "downloaded from the internet" mark, so the
    new version opens without the first-launch warning.
    """
    import ssl

    import certifi

    work = data_dir / "update"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    dmg, mount = work / "update.dmg", work / "disk"
    context = ssl.create_default_context(cafile=certifi.where())
    progress("download", 0)
    with urllib.request.urlopen(UPDATE_DMG_URL, timeout=60, context=context) as res, open(dmg, "wb") as out:
        # In pieces, so the window can show how far along it is.
        total = int(res.headers.get("Content-Length") or 0)
        done = 0
        while chunk := res.read(256 * 1024):
            out.write(chunk)
            done += len(chunk)
            progress("download", min(99, done * 100 // total) if total else None)
    progress("install")
    mount.mkdir()
    attach = _run(["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", str(mount), str(dmg)])
    if attach.returncode != 0:
        raise RuntimeError(f"could not open the update: {attach.stderr.strip()}")
    staged = app.with_name(f".{app.name}.new")
    try:
        source = next(mount.glob("*.app"))
        shutil.rmtree(staged, ignore_errors=True)
        copy = _run(["ditto", str(source), str(staged)])
        if copy.returncode != 0:
            raise RuntimeError(f"could not copy the update: {copy.stderr.strip()}")
    finally:
        _run(["hdiutil", "detach", "-quiet", str(mount)])
    old = _old_app(app)
    shutil.rmtree(old, ignore_errors=True)
    app.rename(old)
    try:
        staged.rename(app)
    except OSError:
        old.rename(app)  # put it back: never leave the app missing
        raise
    shutil.rmtree(work, ignore_errors=True)


def _tidy_after_app_update():
    app = _this_app()
    if app:
        shutil.rmtree(_old_app(app), ignore_errors=True)


class _WindowApi:
    """What the page in the app's own window can ask of the app (static/js/native.js)."""

    def notify(self, title: str, body: str = ""):
        # The web view has no web notifications of its own.
        if sys.platform == "win32":
            _windows_notification(str(title), str(body))
            return
        script = f"display notification {json.dumps(str(body))} with title {json.dumps(str(title))}"
        subprocess.Popen(["osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def menu_bar(self, state=None):
        # What is running, for the time in the menu bar (static/js/menubar.js).
        if _MENU_BAR is not None:
            _MENU_BAR.update(state if isinstance(state, dict) else None)

    def title(self, text: str = ""):
        # Windows: the page's title (the time left) on the window and in the
        # taskbar, as a browser's window showed it.
        if _WINDOW is not None:
            _WINDOW.set_title(str(text)[:200] or APP_NAME)


_MENU_BAR = None
_WINDOW = None


def _native_window_works() -> bool:
    """Whether this computer can draw the app's own window.

    Windows draws it with Edge's WebView2 (part of Windows 11, and of Windows
    10 once Edge has updated). Without it pywebview would quietly fall back to
    Internet Explorer's engine, which cannot run the timer, so a browser's app
    window is the better home then.
    """
    if sys.platform != "win32":
        return True
    try:
        from webview.platforms import winforms
    except Exception:
        log.warning("Could not load the app's window - opening the timer in a browser instead.", exc_info=True)
        return False
    if not winforms.is_chromium:
        log.warning("WebView2 is missing - opening the timer in a browser instead.")
    return bool(winforms.is_chromium)


def _register_windows_app():
    """Tell Windows the app's name and icon, for its notifications and taskbar button."""
    import ctypes
    import winreg

    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(WINDOWS_APP_ID)
        # Notifications from a program without an installer need this entry
        # to show its name and icon (otherwise Windows drops them).
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\AppUserModelId\{WINDOWS_APP_ID}") as key:
            winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, APP_NAME)
            icon = PROJECT_ROOT / "packaging" / "icon.png"
            if icon.exists():
                winreg.SetValueEx(key, "IconUri", 0, winreg.REG_SZ, str(icon))
    except OSError:
        log.debug("could not register the app with Windows", exc_info=True)


# Windows' own notification, through PowerShell's access to the Windows API,
# so no extra component has to ship with the app. The text arrives in
# environment variables, never inside the script.
_TOAST_SCRIPT = (
    "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime];"
    "$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime];"
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml($env:MUHURTA_TOAST);"
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:MUHURTA_APP_ID)"
    ".Show([Windows.UI.Notifications.ToastNotification]::new($x))"
)


def _windows_notification(title: str, body: str):
    from xml.sax.saxutils import escape

    # Silent: the timer rings its own bell.
    xml = ('<toast><visual><binding template="ToastGeneric">'
           f"<text>{escape(title)}</text>" + (f"<text>{escape(body)}</text>" if body else "")
           + '</binding></visual><audio silent="true"/></toast>')
    try:
        subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command", _TOAST_SCRIPT],
                         env={**os.environ, "MUHURTA_TOAST": xml, "MUHURTA_APP_ID": WINDOWS_APP_ID},
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **NO_WINDOW)
    except OSError:
        log.debug("could not show a notification", exc_info=True)


def _show_running_window(url: str, data_dir: Path) -> bool:
    """Ask the copy that is already running to bring its own window forward.

    False when it can't (it shows the timer in a browser instead), and the
    caller then opens a browser window as before.
    """
    if not NATIVE_WINDOW:
        return False
    if sys.platform == "win32":
        try:
            import ctypes

            # Windows lets only the program the person just started come to
            # the front; this hands that on to the copy already running.
            pid = int(json.loads(_running_file(data_dir).read_text())["pid"])
            ctypes.windll.user32.AllowSetForegroundWindow(pid)
        except Exception:
            log.debug("could not pass the foreground on", exc_info=True)
    req = urllib.request.Request(url + "api/window/show", data=b"", method="POST", headers={"X-Muhurta": "1"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 204
    except Exception:
        return False


def _fit_on_screen(width: int, height: int) -> dict:
    """Where the window opens: centred in the screen's free area and made
    smaller where the screen is (a 1440x900 laptop, say), so no part of it
    starts behind the taskbar. Windows' own centring missed that."""
    import ctypes
    from ctypes import wintypes

    try:
        area = wintypes.RECT()
        ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(area), 0)  # SPI_GETWORKAREA
        # In the same units as the window's size (96 per inch), whatever the scaling.
        scale = ctypes.windll.user32.GetDpiForSystem() / 96 or 1
        left, top = area.left / scale, area.top / scale
        room_w, room_h = (area.right - area.left) / scale, (area.bottom - area.top) / scale
    except Exception:
        return {"width": width, "height": height}
    margin = 48
    width = max(420, min(width, int(room_w - margin)))
    height = max(560, min(height, int(room_h - margin)))
    return {"width": width, "height": height,
            "x": int(left + max(0, room_w - width) / 2), "y": int(top + max(0, room_h - height) / 2)}


def _native_window(url: str, data_dir: Path, flask_app):
    """Show the timer in the app's own window; returns once it is closed."""
    import webview

    global _WINDOW
    place = {"width": 1180, "height": 820}
    if sys.platform == "win32":
        _register_windows_app()  # before the window exists, so its taskbar button is ours
        place = _fit_on_screen(place["width"], place["height"])
    window = _WINDOW = webview.create_window(APP_NAME, url, **place, min_size=(420, 560),
                                             background_color="#070605", js_api=_WindowApi())

    def closing():
        # Runs before the window closes, for the close button and for ⌘Q
        # alike; ⌘Q ends the process straight after, so finish up here.
        log.info("The timer window was closed - stopping.")
        _final_sync()
        _running_file(data_dir).unlink(missing_ok=True)

    window.events.closing += closing

    def loaded():
        if not loaded.seen:  # every page loads; once is enough to say it works
            loaded.seen = True
            log.info("The app's window has opened the timer.")

    loaded.seen = False
    window.events.loaded += loaded

    def bring_to_front():
        if sys.platform == "win32":
            from webview.platforms.winforms import Func, Type, WinForms

            form = window.native
            if form is None:
                return

            def show():
                # Un-minimize, but leave a maximized window maximized
                # (window.restore() would shrink it).
                if form.WindowState == WinForms.FormWindowState.Minimized:
                    form.WindowState = WinForms.FormWindowState.Normal
                form.Show()
                form.Activate()

            form.Invoke(Func[Type](show))
            return
        import AppKit

        AppKit.NSApp.activateIgnoringOtherApps_(True)
        window.restore()
        window.show()

    if sys.platform == "win32":
        # Starting the app again while it runs shows this window (main()).
        flask_app.config["MUHURATA_SHOW_WINDOW"] = bring_to_front

    global _MENU_BAR
    if sys.platform == "darwin":
        try:
            from menubar import MenuBar

            _MENU_BAR = MenuBar(on_click=bring_to_front)
        except Exception:
            log.exception("No menu bar timer this time")
    # Not private: the page keeps a running session in localStorage, which
    # has to survive closing the window.
    webview.start(private_mode=False, storage_path=str(data_dir / "window"))


# --------------------------------------------------------------------------- #
# the Desktop launcher
# --------------------------------------------------------------------------- #
APP_NAME = "Muhurta Pomodoro"
OLD_APP_NAME = "Muhurata Timer"  # before v1.5.0; renamed on the next start


def _mac_apps() -> list[Path]:
    folders = (Path.home() / "Desktop", Path("/Applications"), Path.home() / "Applications")
    return [d / f"{n}.app" for d in folders for n in (APP_NAME, OLD_APP_NAME)]


def refresh_launcher():
    """Bring the Desktop launcher up to date after an update.

    The installer writes it once, so without this an existing install would
    keep starting the old way (in a Terminal window) forever.
    """
    if FROZEN:
        return  # the downloaded app is its own launcher
    try:
        if sys.platform == "darwin":
            for app in _mac_apps():
                plist = app / "Contents" / "Info.plist"
                marker = app / "Contents" / "Resources" / "launcher-version"
                if not plist.exists() or "com.muhurata.timer.launcher" not in plist.read_text(errors="ignore"):
                    continue  # not one we made
                exe = app / "Contents" / "MacOS" / "muhurata"
                if not exe.exists() or f'"{PROJECT_ROOT}' not in exe.read_text(errors="ignore"):
                    # Made for another copy of the timer (say, a developer's
                    # checkout next to a normal install): that copy's job, not ours.
                    continue
                renamed = app.name == f"{OLD_APP_NAME}.app"
                if not renamed and marker.exists() and marker.read_text().strip() == LAUNCHER_VERSION:
                    continue
                done = _run(["bash", str(PROJECT_ROOT / "packaging" / "make_macos_app.sh"),
                             str(PROJECT_ROOT), str(app.parent)])
                if done.returncode != 0:
                    log.debug("make_macos_app.sh failed: %s", done.stderr)
                    continue
                if renamed:  # the script made the new-name app beside it
                    shutil.rmtree(app, ignore_errors=True)
                log.info("Updated the %s app in %s.", APP_NAME, app.parent)
        elif sys.platform == "win32":
            marker = _data_dir() / "launcher-version"
            if marker.exists() and marker.read_text().strip() == LAUNCHER_VERSION:
                return
            pythonw = PROJECT_ROOT / ".venv" / "Scripts" / "pythonw.exe"
            if not pythonw.exists():
                return
            script = (
                "$d = [Environment]::GetFolderPath('Desktop'); $p = Join-Path $d 'Muhurta Pomodoro.lnk';"
                f"$o = Join-Path $d '{OLD_APP_NAME}.lnk'; if (Test-Path $o) {{ Move-Item -Force $o $p }};"
                "if (Test-Path $p) { $l = (New-Object -ComObject WScript.Shell).CreateShortcut($p);"
                f"$l.TargetPath = '{pythonw}'; $l.Arguments = 'run.py'; $l.WorkingDirectory = '{PROJECT_ROOT}';"
                "$l.Save() }"
            )
            done = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script])
            if done.returncode == 0:
                marker.write_text(LAUNCHER_VERSION)
                log.info("Updated the Desktop shortcut: it now starts without a console window.")
            else:
                log.debug("shortcut update failed: %s", done.stderr)
    except Exception:  # an old launcher still works; never fail the start over it
        log.debug("could not refresh the launcher", exc_info=True)


def _load_app():
    """Import the app, leaving nothing half-imported if a package is missing."""
    for name in ("db", "app", "schema", "presets"):
        sys.modules.pop(name, None)
    importlib.invalidate_caches()
    import db  # noqa: E402
    from app import app  # noqa: E402
    from werkzeug.serving import make_server  # noqa: E402

    return db, app, make_server


def _skip_host_lookup():
    """Starting a server makes http.server look up this computer's network
    name. Nothing here uses it, and on some networks it stalls for ~30 s."""
    import http.server
    import socketserver

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    http.server.HTTPServer.server_bind = server_bind


def doctor(data_dir: Path) -> int:
    """Print what a friend would need to paste into a bug report."""
    import platform
    import sqlite3

    from version import __version__

    print(f"Muhurta Pomodoro {__version__}{' (bundled)' if FROZEN else ''}")
    print(f"Python    : {sys.version.split()[0]}  ({sys.executable})")
    print(f"OS        : {platform.platform()}")
    print(f"Code dir  : {PROJECT_ROOT}")
    if not FROZEN and (PROJECT_ROOT / ".git").is_dir():
        print(f"Git       : {_run(['git', 'rev-parse', '--short', 'HEAD']).stdout.strip() or '?'}"
              f"{'  (local changes)' if _run(['git', 'status', '--porcelain', '-uno']).stdout.strip() else ''}")
    print(f"Data dir  : {data_dir}")
    print(f"Log file  : {data_dir / 'launcher.log'}")
    print(f"Internet  : {'yes' if _online() else 'no'}")

    db_path = data_dir / "focus_timer.db"
    print(f"Database  : {db_path}")
    if not db_path.exists():
        print("            (not created yet - run the app once)")
        return 0
    print(f"            {db_path.stat().st_size / 1024:.0f} KB")
    conn = sqlite3.connect(db_path)
    try:
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for t in tables:
            n = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            extra = ""
            if t == "alembic_version":
                extra = "  rev " + (conn.execute("SELECT version_num FROM alembic_version").fetchone() or ["?"])[0]
            elif t == "activity_segments" and n:
                lo, hi = conn.execute("SELECT MIN(day), MAX(day) FROM activity_segments").fetchone()
                extra = f"  {lo} .. {hi}"
            print(f"            {t:<20}{n:>7} rows{extra}")
        print(f"            integrity: {conn.execute('PRAGMA integrity_check').fetchone()[0]}")
    finally:
        conn.close()
    backups = sorted((data_dir / "backups").glob("focus_timer-*.db")) if (data_dir / "backups").exists() else []
    print(f"Backups   : {len(backups)}" + (f"  (latest {backups[-1].name})" if backups else ""))
    print("Last sync : n/a (cloud sync not set up)")
    return 0


# --------------------------------------------------------------------------- #
def main(argv: list[str]) -> int:
    no_update = "--no-update" in argv
    open_browser = "--no-browser" not in argv

    data_dir = _data_dir()
    if "--doctor" in argv:
        return doctor(data_dir)
    _setup_logging(data_dir)
    from version import __version__  # noqa: E402

    log.info("---- Muhurta Pomodoro %s start (python %s%s) ----", __version__, sys.version.split()[0], ", bundled" if FROZEN else "")

    running = _already_running(data_dir)
    if not running and not _first_copy(data_dir):
        log.info("Another copy is starting - waiting for it.")
        running = _wait_for_other_copy(data_dir)
    if running:
        log.info("Muhurta Pomodoro is already running at %s - opening its window.", running)
        if open_browser and not _show_running_window(running, data_dir):
            open_app_window(running)
        return 0

    if sys.platform == "darwin" and not INTERACTIVE and not NATIVE_WINDOW and "--background" not in argv:
        # Started by double-clicking the app. Carry on in a separate process
        # and let this one end at once: while the app's own process lives,
        # macOS treats the app as open, and double-clicking it again would only
        # bring it to the front instead of reopening the timer's window.
        cmd = [sys.executable] if FROZEN else [sys.executable, str(PROJECT_ROOT / "run.py")]
        subprocess.Popen([*cmd, *argv[1:], "--background"], cwd=PROJECT_ROOT, start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 0

    if not no_update and self_update():
        # Re-exec so the freshly pulled launcher/app code is what actually runs.
        _release_first_copy()
        os.execv(sys.executable, [sys.executable, str(PROJECT_ROOT / "run.py"), "--no-update", *argv[1:]])

    if ensure_python_version():
        new_python = _venv_python(PROJECT_ROOT / ".venv")
        _release_first_copy()
        os.execv(str(new_python), [str(new_python), str(PROJECT_ROOT / "run.py"), "--no-update", *argv[1:]])

    install_requirements(data_dir)
    refresh_launcher()

    sys.path.insert(0, str(PROJECT_ROOT))
    try:
        db, app, make_server = _load_app()
    except ModuleNotFoundError as missing:
        # The environment is not in the state the marker claimed. Rather than
        # dying with a traceback nobody can act on, put it right and carry on.
        # REPAIR_FLAG stops this becoming a loop if the repair cannot help.
        if os.environ.get(REPAIR_FLAG):
            raise
        log.info("Some components are missing (%s) - repairing...", missing.name)
        install_requirements(data_dir, force=True)
        # Restart rather than re-import: this interpreter built its view of the
        # installed packages at startup and will not see the new ones.
        _release_first_copy()
        os.execve(
            sys.executable,
            [sys.executable, str(PROJECT_ROOT / "run.py"), "--no-update", *argv[1:]],
            {**os.environ, REPAIR_FLAG: "1"},
        )

    db.init_db()  # applies any pending migrations (with backup)
    import sync  # noqa: E402  (after the requirements check, like the app itself)

    sync.start()  # background cloud sync; does nothing until signed in

    # --port: a restart for an update asks for the address it had, so the
    # open window (and what it keeps in localStorage) carries on there.
    wanted = next((int(a.split("=", 1)[1]) for a in argv if a.startswith("--port=")), FIRST_PORT)
    port = free_port(wanted)
    url = f"http://{HOST}:{port}/"
    # make_server rather than app.run: no "development server" banner, and
    # the request log goes through logging (file) instead of raw stderr.
    _skip_host_lookup()
    server = make_server(HOST, port, app, threaded=True)
    _running_file(data_dir).write_text(json.dumps({"url": url, "pid": os.getpid()}))
    if NATIVE_WINDOW and open_browser and _native_window_works():
        # The window needs this (main) thread, so the server runs beside it.
        threading.Thread(target=server.serve_forever, daemon=True).start()
        log.info("Muhurta Pomodoro is running at %s  (close the timer window to stop it)", url)
        _tidy_after_app_update()
        this_app = _this_app()
        if this_app:
            updating = threading.Event()

            def update_and_reopen():
                if updating.is_set():
                    return
                updating.set()
                app.config.pop("MUHURATA_UPDATE_ERROR", None)

                def progress(stage, percent=None):
                    # Read by /api/update/progress: the notice shows it as it goes.
                    app.config["MUHURATA_UPDATE_PROGRESS"] = {"stage": stage, "percent": percent}

                def work():
                    import webview

                    log.info("Updating the app...")
                    try:
                        _install_app_update(this_app, data_dir, progress)
                    except Exception as exc:
                        log.warning("Update failed: %s", exc, exc_info=True)
                        app.config.pop("MUHURATA_UPDATE_PROGRESS", None)
                        app.config["MUHURATA_UPDATE_ERROR"] = "Could not download the update just now. Try again later."
                        updating.clear()
                        return
                    progress("reopen")
                    time.sleep(1.2)  # long enough to read "Reopening" before the window closes
                    _final_sync()
                    # Reopen once this copy has quit (open would only bring
                    # a still-running copy to the front). A test copy keeps
                    # its own data folder and update source.
                    env_args = [f"--env {k}={shlex.quote(os.environ[k])}" for k in
                                ("MUHURATA_DATA_DIR", "MUHURATA_UPDATE_URL") if os.environ.get(k)]
                    subprocess.Popen(
                        ["/bin/sh", "-c",
                         'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; open ' + " ".join(env_args) + ' "$2"',
                         "sh", str(os.getpid()), str(this_app)],
                        start_new_session=True, stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    log.info("Updated - reopening.")
                    for window in list(webview.windows):
                        window.destroy()

                threading.Thread(target=work, daemon=True).start()

            app.config["MUHURATA_RESTART"] = update_and_reopen
        try:
            _native_window(url, data_dir, app)
        finally:
            server.shutdown()
            server.server_close()
            _running_file(data_dir).unlink(missing_ok=True)
        log.info("Stopped.")
        return 0
    # After a restart the window is already open and reloads by itself.
    reopen = open_browser and "--restarted" not in argv
    threading.Thread(target=_open_when_ready, args=(url, reopen), daemon=True).start()
    if open_browser:
        threading.Thread(target=_quit_when_closed, args=(server, data_dir), daemon=True).start()
    restarting = threading.Event()

    def restart():
        if restarting.is_set():
            return
        restarting.set()
        app.config["MUHURATA_UPDATE_PROGRESS"] = {"stage": "restart", "percent": None}

        def stop():
            time.sleep(0.5)  # let the answer reach the page first
            log.info("Restarting to install an update...")
            _final_sync()
            server.shutdown()

        threading.Thread(target=stop, daemon=True).start()

    app.config["MUHURATA_RESTART"] = restart
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        _running_file(data_dir).unlink(missing_ok=True)
    if restarting.is_set():
        # Start from the top: that is where the update happens.
        logging.shutdown()
        args = [a for a in argv[1:] if a not in ("--no-update", "--restarted") and not a.startswith("--port=")]
        _release_first_copy()
        os.execv(sys.executable, [sys.executable, str(PROJECT_ROOT / "run.py"), *args,
                                  "--restarted", f"--port={port}"])
    log.info("Stopped.")
    return 0


REPAIR_CMD = (
    "irm https://raw.githubusercontent.com/Harsh-0024/muhurta-pomodoro/main/install.ps1 | iex"
    if sys.platform == "win32"
    else "curl -fsSL https://raw.githubusercontent.com/Harsh-0024/muhurta-pomodoro/main/install.sh | bash"
)


def _explain_failure():
    """A dead end for the user is worse than the bug. Give them one action."""
    log.exception("Launcher failed")  # full traceback -> launcher.log only
    logfile = _data_dir() / "launcher.log"
    if not INTERACTIVE:
        if FROZEN:
            _alert("Something went wrong while starting. Downloading the app again from the "
                   f"website almost always fixes it:\n\n{SITE}\n\nIf it still will not start, send "
                   f"this file to Harsh:\n{logfile}")
        else:
            _alert("Something went wrong while starting. This almost always fixes it: open "
                   + ("PowerShell" if sys.platform == "win32" else "Terminal")
                   + ", paste the line below and press Enter.\n\nIf it still will not start, send "
                   f"this file to Harsh:\n{logfile}", copyable=REPAIR_CMD)
        return
    line = "-" * 64
    print(
        f"\n{line}\n"
        "  Muhurta Pomodoro could not start.\n\n"
        "  This almost always fixes it - copy the line below, paste it\n"
        "  into this window and press Enter:\n\n"
        f"    {REPAIR_CMD}\n\n"
        "  If it still will not start, send this file to Harsh:\n"
        f"    {_data_dir() / 'launcher.log'}\n"
        f"{line}\n",
        file=sys.stderr,
    )
    if sys.stdin and sys.stdin.isatty():
        input("Press Enter to close...")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception:
        _explain_failure()
        sys.exit(1)
