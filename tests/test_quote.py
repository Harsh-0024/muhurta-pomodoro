"""/api/quote: an online quote credited to "Unknown" falls back to our checked list.

    python -m unittest tests/test_quote.py
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
DATA = tempfile.mkdtemp(prefix="muhurta-test-")
Path(DATA, "focus_timer.db").touch()
os.environ["MUHURATA_DATA_DIR"] = DATA
os.environ["MUHURATA_NO_BROWSER_OPEN"] = "1"
sys.path.insert(0, str(ROOT))

import app as muhurta  # noqa: E402


class _Res(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def online(author: str):
    body = json.dumps([{"q": "Online words.", "a": author}]).encode()
    return mock.patch("urllib.request.urlopen", side_effect=lambda *a, **k: _Res(body))


class QuoteTest(unittest.TestCase):
    def get(self):
        # The view itself: the sign-in gate runs before it and isn't what's tested here.
        with muhurta.app.test_request_context("/api/quote"):
            return muhurta.api_quote().get_json()

    def test_credited_online_quote_is_used(self):
        with online("Seneca"):
            self.assertEqual(self.get()["source"], "zenquotes")

    def test_unknown_author_falls_back(self):
        for who in ("Unknown", "anonymous", "zenquotes.io"):
            with online(who):
                got = self.get()
            self.assertEqual(got["source"], "fallback", who)
            self.assertNotIn(got["author"].lower(), muhurta.UNCREDITED_AUTHORS)


if __name__ == "__main__":
    unittest.main()
