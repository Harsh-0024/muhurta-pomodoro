"""Refresh one device, sync them all (devices.py), end to end.

Runs the computer's real channel code against a stand-in for Supabase
Realtime: a real WebSocket server on this computer that speaks the same
join / broadcast messages and lets only an account's own devices on its
channel. The other devices are played by this test, through the same
WebSocket client. Nothing leaves this computer.

    .venv/bin/python tests/test_devices.py

Prints PASS / FAIL per check and exits non-zero if anything failed.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = tempfile.mkdtemp(prefix="muhurta-devices-test-")
Path(DATA, "focus_timer.db").touch()
os.environ["MUHURATA_DATA_DIR"] = DATA
os.environ["MUHURATA_NO_BROWSER_OPEN"] = "1"
sys.path.insert(0, str(ROOT))

import cloud  # noqa: E402
import db  # noqa: E402
import devices  # noqa: E402
import sync  # noqa: E402

FAILED: list[str] = []


def check(name: str, ok: bool, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  ({detail})"))
    if not ok:
        FAILED.append(name)


def wait(test, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if test():
            return True
        time.sleep(0.02)
    return test()


# --------------------------------------------------------------------------- #
# the stand-in Realtime server
# --------------------------------------------------------------------------- #
UID = "11111111-1111-4111-8111-111111111111"
OTHER_UID = "22222222-2222-4222-8222-222222222222"


def token_for(uid: str) -> str:
    claims = base64.urlsafe_b64encode(json.dumps({"sub": uid}).encode()).decode().rstrip("=")
    return f"h.{claims}.s"


def sub_of(token: str) -> str:
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))["sub"]
    except Exception:
        return ""


class Hub:
    def __init__(self):
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen()
        self.port = self.srv.getsockname()[1]
        self.members: list[tuple[socket.socket, str]] = []  # (connection, topic)
        self.lock = threading.Lock()
        self.deny = False
        self.joins = 0
        self.seen: list[dict] = []
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            conn, _ = self.srv.accept()
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    @staticmethod
    def _send(conn, obj):
        data = json.dumps(obj).encode()
        n = len(data)
        head = bytes([0x81]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack("!H", n) if n < 65536
                                else bytes([127]) + struct.pack("!Q", n))
        try:
            conn.sendall(head + data)
        except OSError:
            pass

    def _serve(self, conn):
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                return
            buf += chunk
        head, buf = buf.split(b"\r\n\r\n", 1)
        key = next(ln.split(":", 1)[1].strip() for ln in head.decode().split("\r\n")
                   if ln.lower().startswith("sec-websocket-key"))
        accept = base64.b64encode(hashlib.sha1(key.encode() + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest()).decode()
        conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        try:
            while True:
                while len(buf) < 2:
                    chunk = conn.recv(65536)
                    if not chunk:
                        raise OSError
                    buf += chunk
                n, at = buf[1] & 0x7F, 2
                need = {126: 4, 127: 10}.get(n, 2) + 4
                while len(buf) < need:
                    buf += conn.recv(65536)
                if n == 126:
                    n, at = struct.unpack("!H", buf[2:4])[0], 4
                elif n == 127:
                    n, at = struct.unpack("!Q", buf[2:10])[0], 10
                assert buf[1] & 0x80, "client frames must be masked"
                mask, at = buf[at:at + 4], at + 4
                while len(buf) < at + n:
                    chunk = conn.recv(65536)
                    if not chunk:
                        raise OSError
                    buf += chunk
                opcode = buf[0] & 0x0F
                data = bytes(x ^ mask[i % 4] for i, x in enumerate(buf[at:at + n]))
                buf = buf[at + n:]
                if opcode == 0x8:
                    raise OSError
                if opcode == 0x1:
                    self._message(conn, json.loads(data))
        except (OSError, AssertionError, ValueError):
            pass
        finally:
            with self.lock:
                self.members = [(c, t) for c, t in self.members if c is not conn]
            conn.close()

    def _message(self, conn, msg):
        event, topic = msg.get("event"), msg.get("topic")
        if event == "heartbeat":
            self._send(conn, {"topic": "phoenix", "event": "phx_reply", "ref": msg["ref"], "payload": {"status": "ok", "response": {}}})
        elif event == "phx_join":
            self.joins += 1
            p = msg["payload"]
            allowed = (not self.deny and p["config"].get("private") is True
                       and topic == f"realtime:{devices.TOPIC}{sub_of(p.get('access_token', ''))}")
            status = "ok" if allowed else "error"
            self._send(conn, {"topic": topic, "event": "phx_reply", "ref": msg["ref"],
                              "payload": {"status": status, "response": {} if allowed else {"reason": "Unauthorized"}}})
            if allowed:
                with self.lock:
                    self.members.append((conn, topic))
        elif event == "broadcast":
            self.seen.append(msg["payload"].get("payload"))
            with self.lock:
                others = [c for c, t in self.members if t == topic and c is not conn]  # broadcast.self is off
            for c in others:
                self._send(c, {"topic": topic, "event": "broadcast", "ref": None, "payload": msg["payload"]})

    def kick_all(self):
        with self.lock:
            conns = [c for c, _ in self.members]
        for c in conns:
            try:
                c.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


HUB = Hub()


# --------------------------------------------------------------------------- #
# the stand-in account (cloud.*) and sync
# --------------------------------------------------------------------------- #
APP_DEVICES: dict[str, dict] = {}  # device id -> row
SYNCS: list[float] = []
SIGNED_IN = [True]
NO_COLUMN = [False]  # the server without the new app_open column


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fake_request(method, path, body=None, token=None, headers=None):
    from urllib.parse import parse_qs, urlsplit

    u = urlsplit(path)
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    assert u.path == "/rest/v1/app_devices", path
    assert sub_of(token or "") == UID
    if NO_COLUMN[0] and ("app_open" in (body or {}) or "app_open" in q):
        return 400, {"code": "PGRST204", "message": "Could not find the 'app_open' column"}
    if method == "POST":
        row = APP_DEVICES.setdefault(body["device_id"], {})
        row.update(body)
        return 201, None
    if method == "PATCH":
        dev = q["device_id"].removeprefix("eq.")
        if dev in APP_DEVICES:
            APP_DEVICES[dev].update(body)
        return 204, None
    if method == "GET":
        since = q["last_seen"].removeprefix("gte.")
        mine = q["device_id"].removeprefix("neq.")
        rows = [{"device_id": d, "platform": r["platform"]} for d, r in APP_DEVICES.items()
                if r.get("app_open") and r["last_seen"] >= since and d != mine]
        return 200, rows
    return 405, None


def fake_run_once():
    SYNCS.append(time.monotonic())
    return {"running": False, "last_sync": iso(datetime.now(timezone.utc)), "error": None, "pending": 0}


cloud.SUPABASE_URL = f"http://127.0.0.1:{HUB.port}"
cloud.SUPABASE_KEY = "test-key"
cloud._request = fake_request
cloud.access_token = lambda: token_for(UID) if SIGNED_IN[0] else None
cloud.user_id = lambda: UID if SIGNED_IN[0] else None
cloud.status = lambda: {"signed_in": SIGNED_IN[0], "mfa_pending": False, "email": "a@x.com"}
cloud.configured = lambda: True
sync.run_once = fake_run_once
sync.status = lambda: {"running": False, "last_sync": None, "error": None, "pending": 0}
devices.HEAR_WAIT = 1.5
devices.SYNC_WAIT = 4.0


class Peer:
    """Another device of the account: the phone, say. Answers like devices.js."""

    def __init__(self, device: str, name: str, uid: str = UID, sync_sec: float = 0.2):
        self.device, self.name, self.sync_sec = device, name, sync_sec
        self.got: list[dict] = []
        self.ws = devices.WebSocket(devices.realtime_url())
        self.topic = f"realtime:{devices.TOPIC}{uid}"
        self.ws.send(json.dumps({"topic": self.topic, "event": "phx_join", "ref": "1", "join_ref": "1", "payload": {
            "config": {"broadcast": {"self": False}, "private": True}, "access_token": token_for(uid)}}))
        reply = None
        while reply is None:
            text = self.ws.recv(5)
            assert text is not None, "no join reply"
            msg = json.loads(text)
            if msg["event"] == "phx_reply":
                reply = msg
        self.joined = reply["payload"]["status"] == "ok"
        self.alive = True
        threading.Thread(target=self._run, daemon=True).start()

    def send(self, data):
        self.ws.send(json.dumps({"topic": self.topic, "event": "broadcast", "ref": "2", "join_ref": "1",
                                 "payload": {"type": "broadcast", "event": devices.EVENT, "payload": data}}))

    def _run(self):
        try:
            while self.alive:
                text = self.ws.recv(0.5)
                if text is None:
                    continue
                msg = json.loads(text)
                if msg["event"] != "broadcast":
                    continue
                data = msg["payload"]["payload"]
                self.got.append(data)
                if data.get("kind") == "sync":
                    me = {"device": self.device, "name": self.name}
                    self.send({"kind": "heard", "id": data["id"], "to": data["device"], **me})
                    time.sleep(self.sync_sec)
                    self.send({"kind": "synced", "id": data["id"], "to": data["device"], "ok": True, **me})
        except OSError:
            pass

    def close(self):
        self.alive = False
        self.ws.close()


def mark_open(device, platform, is_open=True, age=timedelta(0)):
    APP_DEVICES[device] = {"user_id": UID, "device_id": device, "platform": platform, "app_version": "1.0.0",
                           "app_open": is_open, "last_seen": iso(datetime.now(timezone.utc) - age)}


# --------------------------------------------------------------------------- #
# the checks
# --------------------------------------------------------------------------- #
def main():
    me = db.device_id()

    # The WebSocket client itself: messages of every length arrive whole.
    w = devices.WebSocket(f"ws://127.0.0.1:{HUB.port}/realtime/v1/websocket")
    for n in (5, 300, 70000):
        w.send(json.dumps({"event": "heartbeat", "topic": "phoenix", "ref": str(n), "payload": {"pad": "x" * n}}))
        reply = json.loads(w.recv(5) or "{}")
        check(f"websocket: a {n}-byte message goes and its answer comes back", reply.get("ref") == str(n), reply)
    check("websocket: nothing to read is not an error", w.recv(0.1) is None)
    w.close()

    devices.start()
    check("the computer joins its account's channel", wait(lambda: devices._joined), HUB.joins)
    check("and marks itself open", wait(lambda: APP_DEVICES.get(me, {}).get("app_open") is True), APP_DEVICES.get(me))

    # Another account cannot get on this one's channel.
    stranger = Peer("stranger", "your iPhone", uid=OTHER_UID)
    stranger.topic = f"realtime:{devices.TOPIC}{UID}"
    stranger.ws.send(json.dumps({"topic": stranger.topic, "event": "phx_join", "ref": "9", "join_ref": "9", "payload": {
        "config": {"private": True}, "access_token": token_for(OTHER_UID)}}))
    time.sleep(0.2)
    stranger.close()

    # Nobody else open: a refresh syncs here and says just "Synced".
    out = devices.sync_everywhere()
    check("alone: nothing asked, nothing missing", out["asked"] == 0 and not out["missing"] and not out["unreachable"], out)

    # The phone is open and online; the Android phone is open but offline
    # (marked open, not on the channel); the old laptop's app is closed.
    phone = Peer("phone-1", "your iPhone")
    mark_open("phone-1", "ios")
    mark_open("android-1", "android")
    mark_open("laptop-old", "win32", is_open=False)
    mark_open("tablet-stale", "android", age=timedelta(days=3))  # open long ago, never closed
    check("a device of the account joins", phone.joined)
    t0 = time.monotonic()
    out = devices.sync_everywhere()
    took = time.monotonic() - t0
    check("the online phone was asked, heard and synced", out["synced"] == ["your iPhone"], out)
    check("the open phone without internet is reported", out["missing"] == ["your Android phone"], out)
    check("closed apps and stale marks are not waited for", out["asked"] == 2, out)
    check("it waits only as long as it must", took < devices.HEAR_WAIT + 1.5, took)
    sync_msg = next((m for m in phone.got if m.get("kind") == "sync"), {})
    check("the request names this computer", sync_msg.get("device") == me and sync_msg.get("name") == devices.name_for(sys.platform), sync_msg)

    # All online: nothing missing, and it waits for a slow sync to finish.
    mark_open("android-1", "android", is_open=False)
    slow = Peer("mac-2", "your Mac", sync_sec=1.0)
    mark_open("mac-2", "darwin")
    out = devices.sync_everywhere()
    check("every open device synced", out["synced"] == ["your Mac", "your iPhone"] and not out["missing"], out)
    slow.close()
    APP_DEVICES.pop("mac-2")

    # Through the app: the page's refresh asks with everywhere, syncs here
    # twice (before, and after the others uploaded) and gets the report.
    import app as flask_app

    client = flask_app.app.test_client()
    SYNCS.clear()
    r = client.post("/api/cloud/sync-now", json={"everywhere": True})
    body = r.get_json()
    check("/api/cloud/sync-now everywhere: the report comes back", body.get("devices", {}).get("synced") == ["your iPhone"], body)
    check("and this device synced again after the others", len(SYNCS) == 2, SYNCS)
    SYNCS.clear()
    body = client.post("/api/cloud/sync-now").get_json()
    check("Settings' Sync now stays this device only", "devices" not in body and len(SYNCS) == 1, body)

    # This device offline: no asking around.
    sync.run_once = lambda: (SYNCS.append(1), {"error": "offline"})[1]
    sync.status = lambda: {"running": False, "last_sync": None, "error": "offline", "pending": 0}
    phone.got.clear()
    body = client.post("/api/cloud/sync-now", json={"everywhere": True}).get_json()
    check("offline here: says so, does not ask the others", body["sync"]["error"] == "offline" and "devices" not in body
          and not any(m.get("kind") == "sync" for m in phone.got), body)
    sync.run_once = fake_run_once
    sync.status = lambda: {"running": False, "last_sync": None, "error": None, "pending": 0}

    # The other way round: the phone is refreshed, this computer syncs.
    SYNCS.clear()
    before = devices.remote_sync()["seq"]
    phone.got.clear()
    phone.send({"kind": "sync", "id": "r1", "device": "phone-1", "name": "your iPhone"})
    check("asked by the phone: this computer heard", wait(lambda: any(m.get("kind") == "heard" and m.get("id") == "r1" for m in phone.got)))
    check("synced", wait(lambda: any(m.get("kind") == "synced" and m.get("id") == "r1" and m.get("ok") for m in phone.got)))
    check("by running a real sync", len(SYNCS) == 1, SYNCS)
    rs = client.get("/api/cloud/remote-sync").get_json()
    check("the pages hear who it came from", rs["seq"] > before and rs["done"] and rs["from"] == "your iPhone", rs)
    phone.send({"kind": "sync", "id": "r2", "device": me, "name": "x"})
    time.sleep(0.4)
    check("its own requests are not answered", not any(m.get("id") == "r2" for m in phone.got if m.get("kind") == "heard"))

    # The connection drops (Wi-Fi off and on): it comes back by itself.
    joins = HUB.joins
    HUB.kick_all()
    check("a dropped connection is noticed", wait(lambda: not devices._joined))
    check("after a drop it joins again", wait(lambda: HUB.joins > joins and devices._joined, 15), HUB.joins)
    phone.close()

    # Signing out (app.py calls leaving() first, while still signed in):
    # marked closed, off the channel; signing in again: back on.
    devices.leaving()
    SIGNED_IN[0] = False
    check("signing out marks this device closed", APP_DEVICES[me].get("app_open") is False, APP_DEVICES[me])
    check("and leaves the channel", wait(lambda: not devices._joined))
    time.sleep(2.5)
    check("and stays off while signed out", not devices._joined)
    SIGNED_IN[0] = True
    check("signing in again joins again", wait(lambda: devices._joined, 15))
    check("and marks it open again", wait(lambda: APP_DEVICES[me].get("app_open") is True), APP_DEVICES[me])

    # The server without the new column / without the channel: refresh just
    # syncs here, with no warnings.
    NO_COLUMN[0] = True
    mark_open("android-1", "android")
    out = devices.sync_everywhere()
    check("server not updated yet: no one reported missing", not out["missing"] and not out["unreachable"], out)
    NO_COLUMN[0] = False
    HUB.deny = True
    HUB.kick_all()
    wait(lambda: not devices._joined)
    check("channel not set up: the app stops asking for a while", wait(lambda: devices._denied_until > time.time(), 15))
    out = devices.sync_everywhere()
    check("channel not set up: no warnings", not out["missing"] and not out["unreachable"], out)
    HUB.deny = False

    # Closing the app: marked closed, so others don't wait for it.
    devices._denied_until = 0
    check("back on once it is set up", wait(lambda: devices._joined, 15))
    devices.closing()
    check("closing the app marks it closed", APP_DEVICES[me].get("app_open") is False, APP_DEVICES[me])
    check("and leaves the channel for good", wait(lambda: not devices._joined) and not wait(lambda: devices._joined, 3))

    print()
    if FAILED:
        print(f"{len(FAILED)} FAILED")
        sys.exit(1)
    print("ALL PASSED")


if __name__ == "__main__":
    main()
