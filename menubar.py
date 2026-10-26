"""The running Rhythm, Timer or Flow in the Mac menu bar, like Apple's Clock app.

Only the downloaded Mac app uses this (run.py NATIVE_WINDOW). The page tells
us what is running (static/js/menubar.js); from then on the time is worked out
here, once a second, from clock times, so it keeps going while the window is
hidden or showing another page.

Rhythm shows a flame while focusing and a tea cup while resting; Timer
shows a timer. Both count down (then up, with a "+", past zero). Flow shows
an infinity sign and counts up. Nothing is shown while none of them is
running or paused.

The page's kinds are older than the names: "timer" is Rhythm's focus,
"rest" its rest, "countdown" the simple Timer.
"""
from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger("muhurata.menubar")

# SF Symbols, all in macOS 11. Chosen to look nothing like system status
# icons (no warning triangle, no Do Not Disturb moon).
ICONS = {"timer": "flame", "rest": "cup.and.saucer", "countdown": "timer", "flow": "infinity"}
NAMES = {"timer": "Rhythm", "rest": "Rest", "countdown": "Timer", "flow": "Flow"}


def _clock(sec: float) -> str:
    sec = max(0, int(sec))
    h, rest = divmod(sec, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def text_for(state: dict | None, now_ms: float) -> str | None:
    """What the menu bar should say for the page's state, or None to hide it.

    state = {kind: "timer"|"rest"|"countdown"|"flow", up: bool, sec: float, since: ms|None,
             until: ms|None, paused: bool}. A running countdown ends at
    `until`; a running count-up is sec plus the time since `since`. Paused,
    it is just sec.
    """
    if not state or state.get("kind") not in ICONS:
        return None
    sec = float(state.get("sec") or 0)
    if state.get("until"):
        sec = (float(state["until"]) - now_ms) / 1000
    elif state.get("since"):
        sec += max(0.0, (now_ms - float(state["since"])) / 1000)
    text = _clock(sec)
    return f"+{text}" if state.get("up") and state.get("kind") != "flow" else text


class MenuBar:
    """One status item; every AppKit call happens on the main thread."""

    def __init__(self, on_click=None):
        self._state: dict | None = None
        self._lock = threading.Lock()
        self._item = None
        self._target = None
        self._shown: tuple | None = None
        self._on_click = on_click
        self._started = False

    def update(self, state: dict | None):
        with self._lock:
            self._state = state or None
        if not self._started:
            self._started = True
            threading.Thread(target=self._loop, name="menubar", daemon=True).start()
        self._refresh()

    def _loop(self):
        while True:
            # Wake just after each whole second so the digits tick evenly.
            time.sleep(1 - (time.time() % 1) + 0.02)
            self._refresh()

    def _refresh(self):
        with self._lock:
            state = self._state
        text = text_for(state, time.time() * 1000)
        shown = (state.get("kind"), text, bool(state.get("paused"))) if text else None
        if shown == self._shown:
            return
        self._shown = shown
        from PyObjCTools import AppHelper

        AppHelper.callAfter(self._draw, shown)

    def _draw(self, shown):
        try:
            import AppKit

            if shown is None:
                if self._item is not None:
                    AppKit.NSStatusBar.systemStatusBar().removeStatusItem_(self._item)
                    self._item = None
                return
            kind, text, paused = shown
            if self._item is None:
                self._item = AppKit.NSStatusBar.systemStatusBar().statusItemWithLength_(
                    AppKit.NSVariableStatusItemLength)
                button = self._item.button()
                button.setImagePosition_(AppKit.NSImageLeft)
                if self._on_click:
                    self._target = _click_target(self._on_click)
                    button.setTarget_(self._target)
                    button.setAction_("clicked:")
            button = self._item.button()
            image = AppKit.NSImage.imageWithSystemSymbolName_accessibilityDescription_(
                ICONS[kind], NAMES[kind])
            if image is not None:
                image.setTemplate_(True)
                button.setImage_(image)
            # Even-width digits so the item doesn't jiggle as it counts.
            font = AppKit.NSFont.monospacedDigitSystemFontOfSize_weight_(
                AppKit.NSFont.systemFontSize(), AppKit.NSFontWeightRegular)
            color = AppKit.NSColor.secondaryLabelColor() if paused else AppKit.NSColor.labelColor()
            title = AppKit.NSAttributedString.alloc().initWithString_attributes_(
                " " + text, {AppKit.NSFontAttributeName: font,
                             AppKit.NSForegroundColorAttributeName: color})
            button.setAttributedTitle_(title)
            button.setToolTip_(NAMES[kind] + (" (paused)" if paused else ""))
        except Exception:
            log.exception("Could not draw the menu bar item")


_TARGET_CLASS = None


def _click_target(callback):
    global _TARGET_CLASS
    if _TARGET_CLASS is None:
        import Foundation
        import objc

        class MuhurtaMenuBarTarget(Foundation.NSObject):
            @objc.python_method
            def set_callback(self, cb):
                self._cb = cb

            def clicked_(self, _sender):
                try:
                    self._cb()
                except Exception:
                    log.exception("Menu bar click failed")

        _TARGET_CLASS = MuhurtaMenuBarTarget
    target = _TARGET_CLASS.alloc().init()
    target.set_callback(callback)
    return target
