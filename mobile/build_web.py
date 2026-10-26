"""Build the phone apps' web folders from the desktop app's screens.

The desktop app renders templates/ with Flask on every request. A phone has
no Python, so this renders each page once, ahead of time, into plain .html
files, and copies static/ next to them. Anything that changes at run time
(theme, account chip, quotes) is filled in by the page's own JavaScript.

Two copies come out of the same screens:

- Android (mobile/www): the Capacitor app, served from the app's own root.
- iPhone (docs/app): an installable web app on the website (GitHub Pages),
  served from /muhurta-pomodoro/app/. A service worker keeps every file on
  the phone, so after the first visit it opens and works with no connection;
  the network is only used to sign in, sync and fetch updates.

Run from anywhere:  python mobile/build_web.py            (Android)
                    python mobile/build_web.py --iphone   (iPhone web app)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

from jinja2 import Environment, FileSystemLoader

ROOT = Path(__file__).resolve().parent.parent
MOBILE = ROOT / "mobile"
sys.path.insert(0, str(ROOT))

from version import __version__  # noqa: E402

# Flask endpoint -> (template, file in www/). index.html doubles as the router.
PAGES = {
    "index": ("index.html", "index.html"),
    "sign_in_page": ("sign_in.html", "sign-in.html"),
    "timer_page": ("timer.html", "timer.html"),
    "flow_page": ("flow.html", "flow.html"),
    "settings_page": ("settings.html", "settings.html"),
    "history_page": ("history.html", "history.html"),
    "dashboard_page": ("dashboard.html", "dashboard.html"),
}

# Paths the desktop app's JavaScript navigates to, and the file each one is here.
ROUTES = {"/sign-in": "/sign-in.html", "/timer": "/timer.html", "/flow": "/flow.html", "/settings": "/settings.html",
          "/settings/history": "/history.html", "/dashboard": "/dashboard.html"}

PASSWORD_SITE = "harsh-0024.github.io/muhurta-pomodoro"
EMAIL_FROM = "muhurata.pomodoro.timer@gmail.com"


class Target:
    """Where one copy is built, and the address it is served from."""

    def __init__(self, name: str, out: Path, base: str, platform: str):
        self.name, self.out, self.base, self.platform = name, out, base, platform

    @property
    def web(self) -> bool:
        return self.name == "iphone"


ANDROID = Target("android", MOBILE / "www", "/", "android")
IPHONE = Target("iphone", ROOT / "docs" / "app", "/muhurta-pomodoro/app/", "ios")

# Runs first on every page: an address like /settings (from the desktop app's
# JavaScript) lands on index.html, so send it on to the page's own file.
ROUTER = """<script>
  (function () {
    var routes = %s;
    var to = routes[location.pathname.replace(/\\/+$/, "")];
    if (to) location.replace(to + location.search + location.hash);
  })();
</script>"""


LOCAL_API = """
  <script src="{base}mobile-data.js"></script>
  <script src="{base}local-api.js"></script>
  <script src="{base}account.js"></script>
  <script src="{base}{alerts}"></script>"""

# The iPhone copy: installable from Safari (Share > Add to Home Screen), opens
# full screen like an app, and draws under the status bar (the pages already
# leave room for it: mobile.css --safe-top).
WEB_HEAD = """
  <link rel="manifest" href="{base}manifest.webmanifest" />
  <meta name="theme-color" content="#0d0b08" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Muhurta" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="apple-touch-icon" href="{base}icons/apple-touch-icon.png" />
  <script src="{base}pwa.js"></script>"""


def page_path(target: Target, endpoint: str) -> str:
    return target.base + PAGES[endpoint][1].replace("index.html", "")


def web_paths(text: str, target: Target) -> str:
    """The desktop app's JavaScript goes to /timer, /sign-in, /static/...: on
    the website everything lives under target.base, as a file of its own."""
    base = target.base
    text = re.sub(r"""(["'])/static/""", lambda m: f"{m.group(1)}{base}static/", text)
    for route, file in ROUTES.items():
        text = re.sub(rf"""(["']){re.escape(route)}(["'#?])""", lambda m: f"{m.group(1)}{base}{file[1:]}{m.group(2)}", text)
    # location.replace("/") after signing in: the app's home page.
    return text.replace('location.replace("/")', f'location.replace("{base}")')


def render_pages(target: Target) -> None:
    import os
    import tempfile

    def url_for(endpoint: str, filename: str | None = None, **_):
        if endpoint == "static":
            return f"{target.base}static/{filename}"
        return page_path(target, endpoint)

    # app.py is imported only for its quote list; keep it away from real data.
    os.environ["MUHURATA_DATA_DIR"] = tempfile.mkdtemp(prefix="muhurta-build-")
    from app import FALLBACK_QUOTES  # noqa: E402

    env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=True)
    quote = random.choice(FALLBACK_QUOTES)
    for endpoint, (template, out) in PAGES.items():
        html = env.get_template(template).render(
            url_for=url_for,
            request=SimpleNamespace(endpoint=endpoint),
            asset_version=__version__,
            app_version=__version__,
            theme="system",
            account=None,
            bare=endpoint == "sign_in_page",
            initial_quote=quote,
            mobile=True,
            password_site=PASSWORD_SITE,
            email_from=EMAIL_FROM,
            pending_email="",
            pending_has_profile=False,
        )
        # The fonts ship inside the app (mobile/web/fonts): no waiting on Google
        # before the page draws, and the same look offline.
        html = re.sub(r'\s*<link rel="preconnect" href="https://fonts\.(googleapis|gstatic)\.com"[^>]*/>', "", html)
        html = re.sub(r'<link href="https://fonts\.googleapis\.com/css2[^"]*" rel="stylesheet" />',
                      f'<link href="{target.base}fonts/fonts.css" rel="stylesheet" />', html)
        # First in <head>: the router, then the phone's own /api (local-api.js).
        alerts = "web-alerts.js" if target.web else "alerts.js"
        head = LOCAL_API.format(base=target.base, alerts=alerts)
        if target.web:
            html = web_paths(html, target)
            head = WEB_HEAD.format(base=target.base) + head
        else:
            head = ROUTER % json.dumps(ROUTES) + head
        if target.web:
            # After the charset, which must come early; nothing there needs the router.
            html = html.replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />' + head, 1)
        else:
            html = html.replace("<head>", "<head>\n  " + head, 1)
        (target.out / out).write_text(html, encoding="utf-8")


def write_data(target: Target) -> None:
    """mobile-data.js: the fixed data local-api.js needs, taken from the Python
    files so there is only one copy of each."""
    import cloud
    import db
    import release_notes
    from app import DOWNLOAD_PAGE, FALLBACK_QUOTES, RELEASES_API, SOUND_CHOICES, SOUND_SETTING_KEYS, UPDATE_POLICY_URL
    from presets import BUILTINS

    data = {
        "version": __version__,
        "builtins": BUILTINS,
        "default_settings": db.DEFAULT_SETTINGS,
        "sound_choices": sorted(SOUND_CHOICES),
        "sound_setting_keys": list(SOUND_SETTING_KEYS),
        "long_segment_sec": db.LONG_SEGMENT_SEC,
        "productive_kinds": list(db.PRODUCTIVE_KINDS),
        "rest_kinds": list(db.REST_KINDS),
        "notes": release_notes.NOTES,
        "quotes": FALLBACK_QUOTES,
        # Where the phone hears about updates (app.py), and where it gets them.
        "releases_api": RELEASES_API,
        "update_policy_url": UPDATE_POLICY_URL,
        "download_page": DOWNLOAD_PAGE + ("?os=iphone" if target.web else "?os=android"),
        "platform": target.platform,
        # The iPhone copy updates itself from the website: version.json there
        # says which version the website has now.
        "base": target.base,
        # MUHURATA_SUPABASE_URL / _KEY build a copy for a test server.
        "supabase_url": cloud.SUPABASE_URL,
        "supabase_key": cloud.SUPABASE_KEY,
        # The iPhone app's end-of-block notifications (supabase/functions/push).
        "push_url": f"{cloud.SUPABASE_URL}/functions/v1/push" if target.web else "",
    }
    (target.out / "mobile-data.js").write_text(
        "// Built by mobile/build_web.py from the Python files. Do not edit.\n"
        f"window.__MUHURTA__ = {json.dumps(data, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    names = ["local-api.js", "account.js"] + (["web-alerts.js", "pwa.js"] if target.web else ["alerts.js"])
    for name in names:
        shutil.copy2(MOBILE / "web" / name, target.out / name)
    shutil.copytree(MOBILE / "web" / "fonts", target.out / "fonts")


def write_web_app(target: Target) -> None:
    """The iPhone copy's install details (manifest, icons), the service worker
    that keeps it working offline, and version.json for updates."""
    out = target.out
    for path in (out / "static" / "js").glob("*.js"):
        path.write_text(web_paths(path.read_text(encoding="utf-8"), target), encoding="utf-8")
    shutil.copytree(MOBILE / "web" / "icons", out / "icons")

    manifest = {
        "name": "Muhurta Pomodoro",
        "short_name": "Muhurta",
        "description": "A calm focus timer built on the old Indian units of time.",
        "id": target.base,
        "start_url": target.base,
        "scope": target.base,
        "display": "standalone",
        "orientation": "portrait",
        "background_color": "#0d0b08",
        "theme_color": "#0d0b08",
        "icons": [
            {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    (out / "manifest.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (out / "version.json").write_text(json.dumps({"version": __version__}) + "\n", encoding="utf-8")

    # Everything the app needs, kept on the phone. The cache's name changes
    # with any file, so a new build replaces the old copy as a whole.
    files = sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file() and p.name != "version.json")
    digest = hashlib.sha256()
    for name in files:
        digest.update(name.encode() + b"\0" + (out / name).read_bytes())
    sw = (MOBILE / "web" / "sw.js").read_text(encoding="utf-8")
    sw = sw.replace("__CACHE__", json.dumps(f"muhurta-{__version__}-{digest.hexdigest()[:10]}"))
    sw = sw.replace("__FILES__", json.dumps(["./"] + files))
    (out / "sw.js").write_text(sw, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--iphone", action="store_true", help="build the iPhone web app into docs/app")
    target = IPHONE if parser.parse_args().iphone else ANDROID
    if target.out.exists():
        shutil.rmtree(target.out)
    target.out.mkdir(parents=True)
    shutil.copytree(ROOT / "static", target.out / "static")
    render_pages(target)
    write_data(target)
    if target.web:
        write_web_app(target)
    print(f"Built {target.out.relative_to(ROOT)} (v{__version__}, {len(PAGES)} pages)")


if __name__ == "__main__":
    main()
