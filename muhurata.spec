# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec: ONE-FOLDER build (one-file re-extracts on every launch,
# is slow and trips antivirus). No console window: the timer opens in its own
# window, closing that window stops it, and problems appear in a pop-up.
#
#   python -m PyInstaller muhurata.spec        ->  dist/Muhurta Pomodoro/
#                                                  (+ dist/Muhurta Pomodoro.app on a Mac)
import re
import sys

from PyInstaller.utils.hooks import collect_submodules

datas = [
    ("templates", "templates"),
    ("static", "static"),
    ("migrations", "migrations"),  # alembic loads env.py/versions from disk
    ("packaging/icon.png", "packaging"),  # the app's icon on Windows notifications
]

hiddenimports = (
    collect_submodules("sqlalchemy.dialects.sqlite")
    + ["schema", "logging.config", "logging.handlers"]  # schema: only imported by migrations/env.py (a data file)
)

a = Analysis(
    ["run.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pytest", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Muhurta Pomodoro",
    debug=False,
    strip=False,
    upx=False,
    console=False,
    # The .exe's icon is also its window's and taskbar button's on Windows.
    icon="packaging/icon.icns" if sys.platform == "darwin" else "packaging/icon.ico",
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Muhurta Pomodoro",
)

if sys.platform == "win32":
    import os

    # Unzipping with Explorer's "Extract All" marks every file as downloaded
    # from the internet, and .NET then refuses to load the window's parts
    # (pythonnet, WebView2): the app fell back to a browser window (1.9.0).
    # This file next to the .exe lets .NET load the app's own files anyway.
    with open(os.path.join(DISTPATH, "Muhurta Pomodoro", "Muhurta Pomodoro.exe.config"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                "<configuration>\n"
                "  <runtime>\n"
                '    <loadFromRemoteSources enabled="true"/>\n'
                "  </runtime>\n"
                "</configuration>\n")

if sys.platform == "darwin":
    VERSION = re.search(r'"(.+)"', open("version.py").read()).group(1)
    app = BUNDLE(
        coll,
        name="Muhurta Pomodoro.app",
        icon="packaging/icon.icns",
        bundle_identifier="com.muhurata.timer",
        version=VERSION,
        info_plist={
            "CFBundleDisplayName": "Muhurta Pomodoro",
            "NSHighResolutionCapable": True,
            # The app draws the timer's window itself (pywebview), so it gets
            # a Dock icon and a menu bar like any other app.
        },
    )
