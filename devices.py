"""Refresh one device, sync them all.

Every device signed in to an account keeps one small live connection to the
account's own channel (Supabase Realtime, private to the account: see the
"devices" section of supabase/schema.sql). Refreshing on one device:

  1. syncs that device (sync.run_once), as before;
  2. sends "sync" on the channel; every other device with the app open
     answers "heard" at once, syncs, and answers "synced";
  3. the refreshing device syncs once more (to get what they uploaded) and
     says how it went: which devices synced, and which have the app open but
     did not answer, which means they are not connected to the internet.

Which devices have the app open is kept in app_devices.app_open: set when a
device connects, cleared when its app closes (on a phone: when the app goes
to the background). Closed apps are not asked and not waited for; they catch
up by themselves when they open. A device that went offline with the app
open stays marked open, and that is the one we report as not connected.

On a computer this runs in the app's own process (not in the pages), so a
minimized or hidden window keeps answering. The phone apps do the same in
mobile/web/devices.js. Everything here is best effort: when the channel is
not set up on the server, or anything fails, refresh simply syncs this
device as it always did.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import socket
import ssl
import struct
import sys
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone

import cloud
import db

log = logging.getLogger("muhurata.devices")

TOPIC = "muhurta-devices:"  # + the account's user id (realtime.topic() in the policy)
EVENT = "muhurta"  # the one broadcast event; the payload's "kind" says what
HEARTBEAT = 25  # seconds; the server drops a socket that stays silent much longer
TOKEN_EVERY = 10 * 60  # hand the channel a fresh sign-in this often
OPEN_EVERY = 60 * 60  # say "still open" this often while connected
RECENT = timedelta(hours=24)  # an "open" mark older than this no longer counts
JOIN_WAIT = 3.0  # seconds a refresh waits for the channel to (re)connect
HEAR_WAIT = 4.0  # for every open device to say it heard
SYNC_WAIT = 12.0  # in all, for the devices that heard to finish syncing
DENIED_RETRY = 10 * 60  # not set up on the server: look again this much later

NAMES = {"darwin": "your Mac", "win32": "your Windows PC", "ios": "your iPhone", "android": "your Android phone"}


def name_for(platform: str) -> str:
    return NAMES.get(str(platform or ""), "your other device")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --------------------------------------------------------------------------- #
# a small WebSocket client (RFC 6455, text frames), so the app needs nothing new
# --------------------------------------------------------------------------- #
_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class _Closed(ConnectionError):
    pass


class WebSocket:
    def __init__(self, url: str, timeout: float = 10):
        u = urllib.parse.urlsplit(url)
        secure = u.scheme == "wss"
        host = u.hostname or ""
        sock = socket.create_connection((host, u.port or (443 if secure else 80)), timeout=timeout)
        try:
            if secure:
                sock = cloud._SSL.wrap_socket(sock, server_hostname=host)
            key = base64.b64encode(os.urandom(16)).decode()
            path = (u.path or "/") + (f"?{u.query}" if u.query else "")
            sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {u.netloc}\r\nUpgrade: websocket\r\n"
                          f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                          "Sec-WebSocket-Version: 13\r\n\r\n").encode())
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = sock.recv(4096)
                if not chunk or len(buf) > 65536:
                    raise _Closed("no WebSocket handshake")
                buf += chunk
            head, self._buf = buf.split(b"\r\n\r\n", 1)
            lines = head.decode("latin-1").split("\r\n")
            if " 101 " not in f"{lines[0]} ":
                raise _Closed(f"WebSocket refused: {lines[0]}")
            headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:])}
            want = base64.b64encode(hashlib.sha1(key.encode() + _GUID).digest()).decode()
            if headers.get("sec-websocket-accept") != want:
                raise _Closed("bad WebSocket handshake")
        except BaseException:
            sock.close()
            raise
        self._sock = sock
        self._send_lock = threading.Lock()
        self._parts: list[bytes] = []

    def _send_frame(self, opcode: int, data: bytes):
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        with self._send_lock:
            self._sock.sendall(head + mask + body)

    def send(self, text: str):
        self._send_frame(0x1, text.encode())

    def _frame(self):
        """One whole frame from the buffer, or None. Only takes it when whole,
        so a read that times out halfway loses nothing."""
        b = self._buf
        if len(b) < 2:
            return None
        n, at = b[1] & 0x7F, 2
        if n == 126:
            if len(b) < 4:
                return None
            n, at = struct.unpack("!H", b[2:4])[0], 4
        elif n == 127:
            if len(b) < 10:
                return None
            n, at = struct.unpack("!Q", b[2:10])[0], 10
        mask = None
        if b[1] & 0x80:
            if len(b) < at + 4:
                return None
            mask, at = b[at:at + 4], at + 4
        if len(b) < at + n:
            return None
        data = b[at:at + n]
        if mask:
            data = bytes(x ^ mask[i % 4] for i, x in enumerate(data))
        self._buf = b[at + n:]
        return bool(b[0] & 0x80), b[0] & 0x0F, data

    def recv(self, timeout: float) -> str | None:
        """The next text message, or None when nothing came within timeout."""
        self._sock.settimeout(timeout)
        while True:
            frame = self._frame()
            if frame is None:
                try:
                    chunk = self._sock.recv(65536)
                except (socket.timeout, TimeoutError):
                    return None
                except ssl.SSLWantReadError:
                    return None
                if not chunk:
                    raise _Closed("connection closed")
                self._buf += chunk
                continue
            fin, opcode, data = frame
            if opcode == 0x8:
                raise _Closed("closed by the server")
            if opcode == 0x9:
                self._send_frame(0xA, data)
                continue
            if opcode in (0x1, 0x2, 0x0):
                self._parts.append(data)
                if fin:
                    text = b"".join(self._parts).decode("utf-8", "replace")
                    self._parts = []
                    return text

    def close(self):
        try:
            self._send_frame(0x8, b"")
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# the account's channel
# --------------------------------------------------------------------------- #
class _Denied(Exception):
    """The server would not let us on the channel (not set up yet)."""


_lock = threading.Condition()
_thread: threading.Thread | None = None
_sock: WebSocket | None = None
_topic: str | None = None
_join_ref: str | None = None
_ref = 0
_joined = False
_ever_joined = [False]  # since the last connection attempt (resets the backoff)
_denied_until = 0.0
_stop = threading.Event()  # set while signed out / closing: stay off the channel
_requests: dict[str, dict] = {}  # refresh id -> {"heard": {device: name}, "synced": {...}}
_remote = {"seq": 0, "from": None, "done": True, "ok": True}  # the last refresh from elsewhere


def _next_ref() -> str:
    global _ref
    _ref += 1
    return str(_ref)


def _send(event: str, payload: dict, topic: str | None = None):
    sock = _sock
    if sock is None:
        raise _Closed("not connected")
    sock.send(json.dumps({"topic": topic or _topic, "event": event, "payload": payload,
                          "ref": _next_ref(), "join_ref": _join_ref if topic is None else None}))


def _broadcast(data: dict):
    _send("broadcast", {"type": "broadcast", "event": EVENT, "payload": data})


def _me() -> dict:
    return {"device": db.device_id(), "name": name_for(sys.platform)}


def realtime_url() -> str:
    base = cloud.SUPABASE_URL.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    return f"{base}/realtime/v1/websocket?" + urllib.parse.urlencode({"apikey": cloud.SUPABASE_KEY, "vsn": "1.0.0"})


def _signed_in() -> bool:
    if not cloud.configured():
        return False
    st = cloud.status()
    return bool(st.get("signed_in")) and not st.get("mfa_pending")


def _mark(token: str, uid: str, is_open: bool):
    """app_devices.app_open for this device. Quietly does nothing when the
    column is not on the server yet."""
    from version import __version__

    try:
        if is_open:
            cloud._request("POST", "/rest/v1/app_devices?on_conflict=user_id,device_id",
                           {"user_id": uid, "device_id": db.device_id(), "app_version": __version__,
                            "platform": sys.platform, "last_seen": _now_iso(), "app_open": True},
                           token=token, headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
        else:
            cloud._request("PATCH", "/rest/v1/app_devices?device_id=eq." + db.device_id(),
                           {"app_open": False, "last_seen": _now_iso()},
                           token=token, headers={"Prefer": "return=minimal"})
    except cloud.CloudError:
        pass


def _session(uid: str, token: str):
    """One connection: join, then answer until it drops or we sign out."""
    global _sock, _topic, _join_ref, _joined
    sock = WebSocket(realtime_url())
    topic = f"realtime:{TOPIC}{uid}"
    with _lock:
        _sock, _topic, _join_ref = sock, topic, _next_ref()
    try:
        sock.send(json.dumps({"topic": topic, "event": "phx_join", "ref": _join_ref, "join_ref": _join_ref, "payload": {
            "config": {"broadcast": {"self": False, "ack": False}, "presence": {"key": ""},
                       "postgres_changes": [], "private": True},
            "access_token": token}}))
        deadline = time.monotonic() + 10
        while True:
            text = sock.recv(max(0.1, deadline - time.monotonic()))
            if text is None:
                if time.monotonic() >= deadline:
                    raise _Closed("no answer to join")
                continue
            msg = json.loads(text)
            if msg.get("event") == "phx_reply" and msg.get("ref") == _join_ref:
                if (msg.get("payload") or {}).get("status") != "ok":
                    raise _Denied(json.dumps(msg.get("payload"))[:300])
                break
        with _lock:
            _joined = True
            _ever_joined[0] = True
            _lock.notify_all()
        _mark(token, uid, True)
        log.info("devices: on the account's channel")
        now = time.monotonic()
        beat_at, token_at, open_at = now + HEARTBEAT, now + TOKEN_EVERY, now + OPEN_EVERY
        last_heard = now
        while not _stop.is_set() and cloud.user_id() == uid:
            text = sock.recv(1.0)
            now = time.monotonic()
            if text is not None:
                last_heard = now
                _handle(json.loads(text), uid)
            if now >= beat_at:
                if now - last_heard > HEARTBEAT * 3:
                    raise _Closed("the server went quiet")
                _send("heartbeat", {}, topic="phoenix")
                beat_at = now + HEARTBEAT
            if now >= token_at:
                token_at = now + TOKEN_EVERY
                fresh = cloud.access_token()
                if fresh and fresh != token:
                    token = fresh
                    _send("access_token", {"access_token": token})
            if now >= open_at:
                open_at = now + OPEN_EVERY
                _mark(token, uid, True)
    finally:
        with _lock:
            _joined = False
            _sock = None
            _lock.notify_all()
        sock.close()


def _handle(msg: dict, uid: str):
    event = msg.get("event")
    if event in ("phx_error", "phx_close") and msg.get("topic") == _topic:
        raise _Closed(event)
    if event != "broadcast":
        return
    payload = msg.get("payload") or {}
    if payload.get("event") != EVENT:
        return
    data = payload.get("payload") or {}
    me = db.device_id()
    kind = data.get("kind")
    if kind == "sync" and data.get("device") != me:
        rid = str(data.get("id") or "")
        _broadcast({"kind": "heard", "id": rid, "to": data.get("device"), **_me()})
        threading.Thread(target=_answer, args=(rid, data), name="muhurata-remote-sync", daemon=True).start()
    elif kind in ("heard", "synced") and data.get("to") == me:
        with _lock:
            req = _requests.get(str(data.get("id") or ""))
            if req is not None:
                req[kind][str(data.get("device") or "")] = str(data.get("name") or name_for(""))
                _lock.notify_all()


def _answer(rid: str, data: dict):
    """Another device was refreshed: sync here too, then say so."""
    import sync

    seq = int(time.time() * 1000)
    with _lock:
        _remote.update(seq=seq, done=False, ok=True)
        _remote["from"] = str(data.get("name") or name_for(""))
    st = sync.run_once()
    ok = not st.get("error")
    with _lock:
        _remote.update(done=True, ok=ok)
    try:
        _broadcast({"kind": "synced", "id": rid, "to": data.get("device"), "ok": ok, **_me()})
    except OSError:
        pass


def _open_devices(uid: str, token: str) -> dict[str, str]:
    """The account's other devices with the app open: {device id: name}."""
    since = (datetime.now(timezone.utc) - RECENT).isoformat(timespec="seconds").replace("+00:00", "Z")
    query = urllib.parse.urlencode({"select": "device_id,platform", "app_open": "is.true",
                                    "last_seen": f"gte.{since}", "device_id": f"neq.{db.device_id()}"})
    try:
        code, rows = cloud._request("GET", f"/rest/v1/app_devices?{query}", token=token)
    except cloud.CloudError:
        return {}
    if code >= 400 or not isinstance(rows, list):
        return {}  # not set up on the server yet
    return {str(r.get("device_id")): name_for(r.get("platform")) for r in rows if r.get("device_id")}


def sync_everywhere() -> dict:
    """Ask every other open device to sync; call after syncing this one.

    Returns {"asked", "synced": [names], "missing": [names], "unreachable"}:
    missing are devices with the app open that did not answer (not connected
    to the internet); unreachable means the channel itself was not available,
    so nothing could be said about the others.
    """
    out = {"asked": 0, "synced": [], "missing": [], "unreachable": False}
    token, uid = cloud.access_token(), cloud.user_id()
    if not token or not uid:
        return out
    expected = _open_devices(uid, token)
    with _lock:
        _lock.wait_for(lambda: _joined, timeout=JOIN_WAIT)
        joined = _joined
    if not joined:
        # Off the channel: either not set up on the server (say nothing), or
        # this device just lost it (say we could not reach the others).
        out["unreachable"] = bool(expected) and time.time() >= _denied_until
        return out
    rid = uuid.uuid4().hex
    req = {"heard": {}, "synced": {}}
    with _lock:
        _requests[rid] = req
    try:
        _broadcast({"kind": "sync", "id": rid, **_me()})
        start = time.monotonic()
        with _lock:
            # Everyone expected says they heard (or a short wait when nobody is expected).
            _lock.wait_for(lambda: set(expected) <= set(req["heard"]), timeout=HEAR_WAIT if expected else 1.5)
            # Then everyone who heard finishes their sync.
            _lock.wait_for(lambda: set(req["heard"]) <= set(req["synced"]),
                           timeout=max(0.0, SYNC_WAIT - (time.monotonic() - start)))
            heard, synced = dict(req["heard"]), dict(req["synced"])
    except OSError:
        out["unreachable"] = bool(expected)
        return out
    finally:
        with _lock:
            _requests.pop(rid, None)
    out["asked"] = len(set(expected) | set(heard))
    out["synced"] = sorted(synced.values())
    out["missing"] = sorted(name for dev, name in expected.items() if dev not in heard)
    out["slow"] = sorted(name for dev, name in heard.items() if dev not in synced)
    return out


def remote_sync() -> dict:
    """The last refresh that came from another device (pages show it)."""
    with _lock:
        return dict(_remote)


# --------------------------------------------------------------------------- #
# the background thread
# --------------------------------------------------------------------------- #
def _loop():
    global _denied_until
    backoff = 2.0
    while True:
        if _stop.is_set() or not _signed_in() or time.time() < _denied_until:
            time.sleep(2)
            continue
        _ever_joined[0] = False
        try:
            token, uid = cloud.access_token(), cloud.user_id()
            if token and uid:
                _session(uid, token)
        except _Denied as exc:
            log.info("devices: the account channel is not set up on the server (%s)", exc)
            _denied_until = time.time() + DENIED_RETRY
        except (cloud.CloudError, OSError, ValueError, ssl.SSLError):
            pass  # offline or dropped: try again shortly
        except Exception:  # never let this take the app down
            log.exception("devices: channel failed")
        if _ever_joined[0]:
            backoff = 2.0  # it was working: come back quickly
        time.sleep(backoff)
        backoff = min(backoff * 2, 60.0)


def start():
    """Join the account's channel in the background, once per process."""
    global _thread
    _stop.clear()
    if _thread is None:
        _thread = threading.Thread(target=_loop, name="muhurata-devices", daemon=True)
        _thread.start()


def leaving():
    """Signing out: this device is no longer open on the account. The
    channel thread joins again by itself after the next sign-in."""
    try:
        token, uid = cloud.access_token(), cloud.user_id()
        if token and uid:
            _mark(token, uid, False)
    except cloud.CloudError:
        pass
    sock = _sock
    if sock is not None:
        sock.close()


def closing():
    """The app is closing: leave the channel for good."""
    _stop.set()
    leaving()
