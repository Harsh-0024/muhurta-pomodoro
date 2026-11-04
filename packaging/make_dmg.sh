#!/usr/bin/env bash
# Pack the PyInstaller-built "Muhurta Pomodoro.app" into a .dmg - the usual Mac
# download: double-click it, drag the app onto the Applications folder next
# to it. Called by the release workflow after the build.
#
#   packaging/make_dmg.sh <path to Muhurta Pomodoro.app> <output .dmg>
set -euo pipefail

APP="${1:?path to Muhurta Pomodoro.app required}"
OUT="${2:?output .dmg path required}"
[ -d "$APP" ] || { echo "no app at $APP" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# What the window shows: the app, and a shortcut to Applications to drop it on.
# ditto keeps the app's signature and symlinks intact (cp -R can break them).
NAME="$(basename "$APP" .app)"  # "Muhurta Pomodoro", or "Muhurta Pomodoro Test"
ditto "$APP" "$STAGE/$NAME.app"
ln -s /Applications "$STAGE/Applications"

rm -f "$OUT"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" \
  -fs HFS+ -format UDZO -ov "$OUT" >/dev/null
echo "Made $OUT ($(du -h "$OUT" | cut -f1))"
