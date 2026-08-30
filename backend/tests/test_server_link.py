"""ServerLink: authentication, roster publishing, reconnect and revocation.

Everything runs against an in-process fake WebSocket — no Navide-Server has to
be running for these to pass, and none of them touches the real Keychain.
"""

from __future__ import annotations

import asyncio
import os
import json

import pytest

from agent_team_backend import agent_messaging, app, remote_roster, server_link
from agent_team_backend.credential_vault import CredentialVault, CredentialVaultError
from agent_team_backend.server_link import ServerLink, ServerLinkConfig

CONFIG = ServerLinkConfig(url="ws://localhost:8787/ws", token="tok-abc")


@pytest.fixture(autouse=True)
def _clean_registry():
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture(autouse=True)
def _fast_timers(monkeypatch):
    """Shrink every wait so the suite exercises the real loops, not the clock."""
    monkeypatch.setattr(server_link, "RECONNECT_BASE_S", 0.01)
    monkeypatch.setattr(server_link, "RECONNECT_MAX_S", 0.02)
    monkeypatch.setattr(server_link, "ROSTER_DEBOUNCE_S", 0.01)
    monkeypatch.setattr(server_link, "ROSTER_SWEEP_S", 0.05)


# ---- fake server ------------------------------------------------------------


def _ok(message: dict, payload: dict) -> dict:
    return {
        "id": message["id"],
        "type": f"{message.get('type')}.result",
        "ok": True,
        "payload": payload,
    }


def _bad_request(message: dict, text: str) -> dict:
    return {
        "id": message["id"],
        "type": f"{message.get('type')}.result",
        "ok": False,
        "error": {"code": "BAD_REQUEST", "message": text},
    }


#: The real server's enum. Enforced here because a fake that accepts anything
#: only ever proves the code agrees with itself: backend/scripts/verify_server_link.py
#: caught this module reporting the registry's own busy/idle/offline vocabulary,
#: which every sessions.sync and sessions.upsert was rejected for.
SESSION_STATUSES = ("running", "waiting", "exited", "disconnected")


def _reject_bad_status(message: dict, session: dict) -> dict | None:
    status = session.get("status")
    if status in (None, "") or status in SESSION_STATUSES:
        return None
    return _bad_request(message, f"status 必須是 {'|'.join(SESSION_STATUSES)}")


def default_responder(conn: "FakeConnection", message: dict) -> dict | None:
    kind = message.get("type")
    payload = message.get("payload") or {}
    if kind == "auth.hello":
        conn.hellos.append(payload)
        return _ok(
            message,
            {
                "memberId": "m1",
                "role": "member",
                "tenantId": "tn-test",
                "displayName": "Tester",
                "deviceId": payload.get("deviceId"),
                "deviceName": payload.get("deviceName"),
                "client": payload.get("client"),
            },
        )
    if kind == "sessions.sync":
        conn.syncs.append(payload)
        rows = []
        for index, session in enumerate(payload.get("sessions") or []):
            rejected = _reject_bad_status(message, session)
            if rejected is not None:
                return rejected
            row = dict(session)
            row.setdefault("sessionId", f"s{index + 1}")
            rows.append(row)
        return _ok(message, {"sessions": rows, "removed": []})
    if kind == "sessions.upsert":
        rejected = _reject_bad_status(message, payload)
        if rejected is not None:
            return rejected
        conn.upserts.append(payload)
        session_id = payload.get("sessionId") or f"u{len(conn.upserts)}"
        result = dict(payload)
        result.update({"sessionId": session_id, "hostMemberId": "m1", "hostOnline": True})
        return _ok(message, result)
    if kind == "sessions.remove":
        conn.removes.append(payload)
        return _ok(message, {"removed": True})
    if kind == "sessions.directory":
        conn.directories.append(payload)
        return _ok(message, {"sessions": conn.server.directory})
    if kind == "policy.get":
        conn.policy_gets.append(payload)
        return _ok(
            message,
            {
                "deviceId": payload.get("deviceId"),
                "policy": conn.server.policy,
                "revision": conn.server.policy_revision,
                "updatedAt": 0,
            },
        )
    if kind == "policy.set":
        conn.policy_sets.append(payload)
        conn.server.policy = payload.get("policy")
        conn.server.policy_revision += 1
        return _ok(
            message,
            {
                "deviceId": payload.get("deviceId"),
                "revision": conn.server.policy_revision,
                "updatedAt": 0,
            },
        )
    if kind == "team.members.list":
        conn.member_lists.append(payload)
        return _ok(message, {"members": conn.server.members})
    if kind in ("team.members.invite", "team.members.set_role", "team.members.revoke"):
        conn.member_writes.append((kind, payload))
        return conn.server.member_write(message, kind, payload)
    if kind == "messages.send":
        conn.sends.append(payload)
        return _ok(message, {"msgKey": payload.get("msgKey"), "state": "pending"})
    if kind == "messages.ack":
        conn.acks.append(payload)
        return _ok(message, {"msgKey": payload.get("msgKey")})
    return {
        "id": message["id"],
        "type": f"{kind}.result",
        "ok": False,
        "error": {"code": "BAD_REQUEST", "message": f"unknown type {kind}"},
    }


def _admin_responder(conn: "FakeConnection", message: dict) -> dict | None:
    """The default server, except auth.hello grants admin.

    The role is the whole difference between a pane that offers the management
    actions and one that only lists the team, so it has to come from the
    handshake in the tests too.
    """
    if message.get("type") == "auth.hello":
        reply = default_responder(conn, message)
        reply["payload"]["role"] = "admin"  # type: ignore[index]
        return reply
    return default_responder(conn, message)


def rejecting_responder(code: str, message_text: str = "nope"):
    def responder(conn: "FakeConnection", message: dict) -> dict:
        if message.get("type") == "auth.hello":
            conn.hellos.append(message.get("payload") or {})
            return {
                "id": message["id"],
                "type": "auth.hello.result",
                "ok": False,
                "error": {"code": code, "message": message_text},
            }
        return default_responder(conn, message)

    return responder


class FakeConnection:
    def __init__(self, responder, server: "FakeServer") -> None:
        self.responder = responder
        self.server = server
        self.sent: list[dict] = []
        self.hellos: list[dict] = []
        self.upserts: list[dict] = []
        self.syncs: list[dict] = []
        self.removes: list[dict] = []
        self.directories: list[dict] = []
        self.policy_gets: list[dict] = []
        self.policy_sets: list[dict] = []
        self.member_lists: list[dict] = []
        self.member_writes: list[tuple[str, dict]] = []
        self.sends: list[dict] = []
        self.acks: list[dict] = []
        self.closed = False
        self._inbox: asyncio.Queue = asyncio.Queue()

    async def send(self, raw: str) -> None:
        if self.closed:
            raise ConnectionError("fake connection is closed")
        message = json.loads(raw)
        self.sent.append(message)
        reply = self.responder(self, message)
        if reply is not None:
            await self._inbox.put(json.dumps(reply))

    async def push(self, frame: dict) -> None:
        """Server-initiated event (no id)."""
        await self._inbox.put(json.dumps(frame))

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            await self._inbox.put(None)

    def __aiter__(self) -> "FakeConnection":
        return self

    async def __anext__(self) -> str:
        item = await self._inbox.get()
        if item is None:
            raise StopAsyncIteration
        return item


#: Allows every sender, so a test that is not about the policy is not about the
#: policy. `is_allowed` denies anything it cannot read, including None.
ALLOW_ALL_POLICY = {
    "version": 1,
    "default": "deny",
    "rules": [
        {"from": {"memberId": "*", "deviceId": "*"},
         "to": {"workspace": "*", "paneName": "*"},
         "action": "allow"}
    ],
}


class FakeServer:
    def __init__(self, responder=default_responder, count: int = 8, policy=None) -> None:
        self.connections = [FakeConnection(responder, self) for _ in range(count)]
        self.opened: list[FakeConnection] = []
        self.urls: list[str] = []
        self.policy = ALLOW_ALL_POLICY if policy is None else policy
        self.policy_revision = 1
        #: What sessions.directory answers with — the whole team space, this
        #: device's own rows included, exactly as the real server sends it.
        self.directory: list[dict] = []
        #: The team roster, as team.members.list answers it. Never carries a
        #: token: the real server filters it out of every read, which is what
        #: makes the invite reply the only place one ever appears.
        self.members: list[dict] = [
            {"memberId": "m1", "displayName": "Tester", "role": "member", "disabled": False}
        ]

    def member_write(self, message: dict, kind: str, payload: dict) -> dict:
        """Apply one membership write to `members` and answer like the server."""
        if kind == "team.members.invite":
            member = {
                "memberId": f"m{len(self.members) + 1}",
                "displayName": payload.get("displayName") or "",
                "email": payload.get("email") or "",
                "role": payload.get("role") or "member",
                "disabled": False,
            }
            self.members.append(member)
            return _ok(message, {**member, "token": "one-time-token"})
        target = next(
            (m for m in self.members if m["memberId"] == payload.get("memberId")), None
        )
        if target is None:
            return {
                "id": message["id"],
                "type": f"{kind}.result",
                "ok": False,
                "error": {"code": "NOT_FOUND", "message": "no such member"},
            }
        if kind == "team.members.set_role":
            target["role"] = payload.get("role")
            return _ok(message, {"memberId": target["memberId"], "role": target["role"]})
        target["disabled"] = True
        return _ok(
            message,
            {"memberId": target["memberId"], "disabled": True, "droppedConnections": 2},
        )

    def connect(self, url: str):
        self.urls.append(url)
        server = self

        class _Dial:
            async def __aenter__(self) -> FakeConnection:
                conn = server.connections[len(server.opened)]
                server.opened.append(conn)
                return conn

            async def __aexit__(self, *_exc) -> bool:
                await server.opened[-1].close()
                return False

        return _Dial()


async def _until(predicate, timeout: float = 3.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never became true")


def make_link(server: FakeServer, *, config: ServerLinkConfig = CONFIG, cleared=None) -> ServerLink:
    return ServerLink(
        connect=server.connect,
        config_loader=lambda: config,
        token_clearer=(lambda: cleared.append(True)) if cleared is not None else (lambda: None),
        device_name="test-box",
    )


# ---- not configured ---------------------------------------------------------


async def test_unconfigured_link_never_connects():
    server = FakeServer()
    link = make_link(server, config=ServerLinkConfig())
    assert await link.start() is False
    await asyncio.sleep(0.1)
    assert server.opened == []
    assert link._task is None
    await link.stop()


async def test_url_without_token_is_not_configured():
    assert not ServerLinkConfig(url="ws://x/ws").configured
    assert not ServerLinkConfig(token="t").configured
    assert ServerLinkConfig(url="ws://x/ws", token="t").configured


# ---- authentication ---------------------------------------------------------


async def test_authenticates_and_publishes_the_roster():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    agent_messaging.register("p2", "builder", "/tmp/nest/proj-b", agent_key="codex")
    server = FakeServer()
    link = make_link(server)
    assert await link.start() is True
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        conn = server.opened[0]
        assert server.urls == [CONFIG.url]

        hello = conn.hellos[0]
        assert hello["credential"] == CONFIG.token
        assert hello["client"] == server_link.CLIENT_NAME
        assert hello["deviceName"] == "test-box"
        assert hello["deviceId"]
        assert link.member_id == "m1"

        # The first report on a connection is one flat sync, never per-pane
        # upserts — the server drops whatever is not in the list.
        assert len(conn.syncs) == 1
        assert conn.upserts == []
        by_pane = {u["paneId"]: u for u in conn.syncs[0]["sessions"]}
        assert by_pane["p1"] == {
            "title": "reviewer",
            "agentKey": "claude",
            "status": "waiting",
            "taskId": "",
            "workspacePath": "/tmp/proj-a",
            "workspace": "proj-a",
            "paneId": "p1",
        }
        # The workspace label is the folder basename even for a nested path,
        # and deviceId is never sent (the server takes it from the connection).
        assert by_pane["p2"]["workspace"] == "proj-b"
        assert by_pane["p2"]["workspacePath"] == "/tmp/nest/proj-b"
        assert "deviceId" not in by_pane["p2"]
    finally:
        await link.stop()


@pytest.mark.parametrize("code", ["AUTH_REJECTED", "BAD_REQUEST", "DEVICE_CONFLICT"])
async def test_auth_hello_rejection_stops_the_link(code):
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a")
    server = FakeServer(responder=rejecting_responder(code))
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(link.terminated_reason))
        assert code in link.terminated_reason
        # Terminal: no second dial, however long the backoff had to run.
        await asyncio.sleep(0.15)
        assert len(server.opened) == 1
        assert server.opened[0].syncs == []
        assert link._task is not None and link._task.done()
    finally:
        await link.stop()


async def test_transport_failure_reconnects():
    """A dial that raises is transient, unlike a rejected credential."""
    server = FakeServer()
    attempts = {"n": 0}
    real_connect = server.connect

    def flaky(url: str):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise OSError("connection refused")
        return real_connect(url)

    link = ServerLink(
        connect=flaky, config_loader=lambda: CONFIG, device_name="test-box"
    )
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].hellos))
        assert attempts["n"] >= 2
        assert not link.terminated_reason
    finally:
        await link.stop()


# ---- revocation -------------------------------------------------------------


async def test_auth_revoked_clears_the_token_and_stops_reconnecting():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a")
    server = FakeServer()
    cleared: list[bool] = []
    link = make_link(server, cleared=cleared)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        await server.opened[0].push(
            {"type": "auth.revoked", "payload": {"memberId": "m1", "reason": "disabled"}}
        )
        await _until(lambda: bool(link.terminated_reason))
        assert "disabled" in link.terminated_reason
        assert cleared == [True]
        # The whole point: a revoked account must not keep knocking.
        await asyncio.sleep(0.15)
        assert len(server.opened) == 1
        assert link._task is not None and link._task.done()
    finally:
        await link.stop()


# ---- reconnect --------------------------------------------------------------


async def test_reconnect_reauthenticates_and_republishes_the_roster():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        first = server.opened[0]
        assert first.syncs[0]["sessions"][0].get("sessionId") is None  # server issues it

        await first.close()

        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[1].syncs))
        second = server.opened[1]
        assert second.hellos[0]["credential"] == CONFIG.token
        # Reconnecting flattens the roster again rather than diffing against
        # what the previous connection was told, and carries the sessionId the
        # first connection was given so the server updates that row.
        sessions = second.syncs[0]["sessions"]
        assert [s["paneId"] for s in sessions] == ["p1"]
        assert sessions[0]["sessionId"] == "s1"
        assert second.upserts == []
    finally:
        await link.stop()


# ---- roster changes ---------------------------------------------------------


async def test_roster_additions_renames_and_removals_are_published():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        conn = None
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        conn = server.opened[0]

        agent_messaging.register("p2", "builder", "/tmp/proj-a", agent_key="codex")
        link.notify_roster_changed()
        await _until(lambda: any(u["paneId"] == "p2" for u in conn.upserts))

        # A rename is a re-register under the same pane id.
        agent_messaging.register("p1", "auditor", "/tmp/proj-a", agent_key="claude")
        link.notify_roster_changed()
        await _until(
            lambda: any(u["paneId"] == "p1" and u["title"] == "auditor" for u in conn.upserts)
        )

        agent_messaging.set_busy("p2", True)
        link.notify_roster_changed()
        await _until(
            lambda: any(u["paneId"] == "p2" and u["status"] == "running" for u in conn.upserts)
        )

        # A closed pane is deleted, not reported with a made-up status: the
        # contract's status enum is running|waiting|exited, and inventing a
        # "closed" value earned a BAD_REQUEST.
        agent_messaging.unregister("p2")
        link.notify_roster_changed()
        await _until(lambda: bool(conn.removes))
        assert conn.removes[0] == {"sessionId": "u1"}
        assert all(u["status"] != "closed" for u in conn.upserts)

        # An unchanged roster is not re-sent on every sweep.
        settled = (len(conn.upserts), len(conn.syncs), len(conn.removes))
        await asyncio.sleep(0.2)
        assert (len(conn.upserts), len(conn.syncs), len(conn.removes)) == settled
    finally:
        await link.stop()


async def test_updates_reuse_the_session_id_the_server_issued():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a")
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        conn = server.opened[0]
        assert "sessionId" not in conn.syncs[0]["sessions"][0]
        agent_messaging.set_busy("p1", True)
        link.notify_roster_changed()
        await _until(lambda: bool(conn.upserts))
        assert conn.upserts[0]["sessionId"] == "s1"
    finally:
        await link.stop()


async def test_a_rejected_upsert_does_not_break_the_link():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a")

    def refuse_upserts(conn: FakeConnection, message: dict) -> dict:
        if message.get("type") == "sessions.upsert":
            conn.upserts.append(message.get("payload") or {})
            return {
                "id": message["id"],
                "type": "sessions.upsert.result",
                "ok": False,
                "error": {"code": "NOT_HOST", "message": "someone else owns it"},
            }
        return default_responder(conn, message)

    server = FakeServer(responder=refuse_upserts)
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        agent_messaging.set_busy("p1", True)
        link.notify_roster_changed()
        # Retried on the next sweep rather than treated as a lost connection.
        await _until(lambda: len(server.opened[0].upserts) >= 2)
        assert not link.terminated_reason
        assert len(server.opened) == 1
    finally:
        await link.stop()


async def test_a_restore_placeholder_is_published_as_disconnected_not_running():
    """A pane the window has restored but not opened has no CLI behind it.

    The window mirrors it anyway so it stays addressable, and reports it busy —
    that flag answers "would a message sent now wait", and for a placeholder it
    would. Publishing that as "running" told the network view eight unopened
    panes were working agents, which is what this test exists to stop.
    """
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude", realized=False)
    agent_messaging.set_busy("p1", True)
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        conn = server.opened[0]
        published = {s["paneId"]: s for s in conn.syncs[0]["sessions"]}
        assert published["p1"]["status"] == "disconnected"

        # Opening it is a re-register: the same busy flag now means a working
        # agent, and the status follows.
        agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
        agent_messaging.set_busy("p1", True)
        link.notify_roster_changed()
        await _until(
            lambda: any(u["paneId"] == "p1" and u["status"] == "running" for u in conn.upserts)
        )
    finally:
        await link.stop()


# ---- cross-device messages --------------------------------------------------


def _pending(
    msg_key: str = "pa:mcp:deadbeef", *, pane_id: str = "p1", member_id: str = "m1"
) -> dict:
    """A push from the server. ``member_id`` defaults to "m1", which is also the
    receiver's own member (see FakeServer's auth.hello) — i.e. another machine of
    the same person. Pass someone else's id to exercise the pane policy, which is
    only consulted for senders outside your own account."""
    return {
        "msgKey": msg_key,
        "text": "please review",
        "from": {
            "deviceId": "dev-a",
            "memberId": member_id,
            "workspace": "alpha",
            "paneName": "sender",
        },
        "to": {"workspace": "proj-a", "paneName": "reviewer", "paneId": pane_id},
    }


@pytest.fixture
def broadcasts(monkeypatch):
    """Every event the link hands to the on-machine delivery path."""
    events: list[dict] = []

    async def fake_broadcast(event: dict, **_kwargs) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


async def _connected(server: FakeServer, **kwargs) -> ServerLink:
    link = make_link(server, **kwargs)
    await link.start()
    await _until(lambda: bool(server.opened and server.opened[0].syncs))
    return link


async def test_outbound_send_goes_over_the_link():
    server = FakeServer()
    link = await _connected(server)
    try:
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender={"workspace": "alpha", "paneName": "sender", "paneId": "pa"},
            text="ship it",
            msg_key="pa:mcp:1",
        )
        assert reply["ok"] is True
        assert reply["payload"]["state"] == "pending"
        assert server.opened[0].sends == [
            {
                "to": {"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
                "text": "ship it",
                "msgKey": "pa:mcp:1",
                "from": {"workspace": "alpha", "paneName": "sender", "paneId": "pa"},
            }
        ]
    finally:
        await link.stop()


# ---- end-to-end encryption ---------------------------------------------------


def _seed_peer_key(device_id: str, public_key: str) -> None:
    """Put one keyed device in the roster, which is how keys are distributed."""
    remote_roster.replace(
        [
            {
                "sessionId": f"s-{device_id}",
                "deviceId": device_id,
                "deviceName": "far box",
                "workspace": "beta",
                "title": "builder",
                "paneId": "pb",
                "agentKey": "codex",
                "status": "running",
                "hostOnline": True,
                "devicePublicKey": public_key,
            }
        ],
        local_device_id="dev-local",
    )


@pytest.fixture
def peer_key(tmp_path, monkeypatch):
    """A second machine's keypair: its own data dir, so its own key file."""
    from agent_team_backend import device_crypto

    here = os.environ.get("AGENT_TEAM_DATA_DIR")
    peer_home = tmp_path / "peer"
    peer_home.mkdir(exist_ok=True)
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(peer_home))
    key = device_crypto.public_key()
    if here:
        monkeypatch.setenv("AGENT_TEAM_DATA_DIR", here)
    remote_roster._reset_for_test()
    yield key
    remote_roster._reset_for_test()


async def test_hello_publishes_this_devices_public_key():
    """Sent on every hello, not only the first: the server keeps the last key it
    was told, and a build that stopped sending one would leave peers encrypting
    to a key this machine no longer holds."""
    from agent_team_backend import device_crypto

    server = FakeServer()
    link = await _connected(server)
    try:
        hello = server.opened[0].hellos[0]
        assert hello["publicKey"] == device_crypto.public_key()
    finally:
        await link.stop()


async def test_a_message_to_a_keyed_device_leaves_as_ciphertext(peer_key):
    """The whole point of the change: the relay stores what it cannot read."""
    server = FakeServer()
    link = await _connected(server)
    try:
        _seed_peer_key("dev-b", peer_key)
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="deploy the payment fix",
            msg_key="pa:mcp:enc",
        )
        assert reply["ok"] is True
        sent = server.opened[0].sends[0]
        assert "text" not in sent, "a plaintext copy alongside the cipher is a downgrade"
        assert sent["cipher"]
        assert "deploy" not in sent["cipher"]
    finally:
        await link.stop()


async def test_a_device_with_no_published_key_still_gets_plaintext():
    """An un-upgraded peer can only read plaintext, and refusing to talk to it
    would break every existing pair the day this ships."""
    server = FakeServer()
    link = await _connected(server)
    try:
        remote_roster._reset_for_test()
        reply = await link.send_message(
            to={"deviceId": "dev-old", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="ship it",
            msg_key="pa:mcp:plain",
        )
        assert reply["ok"] is True
        assert server.opened[0].sends[0]["text"] == "ship it"
        assert "cipher" not in server.opened[0].sends[0]
    finally:
        await link.stop()


async def test_a_peer_that_had_a_key_never_falls_back_to_plaintext(peer_key):
    """Without this the encryption would be advisory: anything that made a key
    disappear — a stale roster, a server that dropped the field, a peer on an
    older build — would quietly turn ciphertext back into cleartext."""
    server = FakeServer()
    link = await _connected(server)
    try:
        _seed_peer_key("dev-b", peer_key)
        await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="first, encrypted",
            msg_key="pa:mcp:one",
        )
        # The key vanishes from the roster.
        remote_roster._reset_for_test()
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="second, must not go out in the clear",
            msg_key="pa:mcp:two",
        )
        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_ENCRYPTION_FAILED
        assert len(server.opened[0].sends) == 1, "nothing more may reach the wire"
    finally:
        await link.stop()


async def test_an_incoming_sealed_message_is_opened_and_delivered(broadcasts):
    """The receiving half: what the sender sealed for this device's key reaches
    the pane as ordinary text."""
    from agent_team_backend import device_crypto

    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        payload = _pending()
        payload.pop("text")
        payload["cipher"] = device_crypto.seal(
            "please review",
            recipient_public_key=device_crypto.public_key(),
            from_device="dev-a",
            to_device=link._device_id,
        )
        await server.opened[0].push({"type": "messages.pending", "payload": payload})
        await _until(lambda: any(e["type"] == "agent_msg.deliver" for e in broadcasts))
        delivered = next(e for e in broadcasts if e["type"] == "agent_msg.deliver")
        assert delivered["payload"]["content"] == "please review"
    finally:
        await link.stop()


async def test_a_message_that_will_not_open_is_refused_not_typed_in(broadcasts):
    """Delivering the ciphertext as if it were text would type a wall of base64
    into somebody's CLI. Rejected, not failed: a retry fails identically."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        payload = _pending()
        payload.pop("text")
        payload["cipher"] = "bm90LWEtcmVhbC1zZWFsZWQtYm94"
        await conn.push({"type": "messages.pending", "payload": payload})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["state"] == "rejected"
        assert conn.acks[0]["reason"] == "undecryptable"
        assert [e for e in broadcasts if e["type"] == "agent_msg.deliver"] == []
    finally:
        await link.stop()


# ---- degraded link ----------------------------------------------------------
# A configured server that is unreachable must not be reported as an unknown
# device: the address may be perfectly correct and only the link is down.


async def test_a_disconnected_link_fails_fast_and_recovers_on_its_own():
    server = FakeServer()
    link = await _connected(server)
    try:
        await server.opened[0].close()
        await _until(lambda: link._ws is None)

        # Fast, not a REQUEST_TIMEOUT_S stall: nothing can answer a socket that
        # is not there, so waiting on it only makes the error slower.
        reply = await asyncio.wait_for(
            link.send_message(
                to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
                sender=None,
                text="ship it",
                msg_key="pa:mcp:while-down",
            ),
            timeout=1.0,
        )
        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_OFFLINE
        assert "not connected" in reply["error"]["message"]

        # The reconnect loop is what changes the answer, and it does so without
        # anything reaching in to restart it.
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[1].syncs))
        resumed = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="ship it",
            msg_key="pa:mcp:after-recovery",
        )
        assert resumed["ok"] is True
        assert server.opened[1].sends[0]["msgKey"] == "pa:mcp:after-recovery"
    finally:
        await link.stop()


async def test_a_socket_that_has_not_authenticated_yet_is_offline_not_a_refusal():
    """auth.hello lands between "the socket is up" and "requests work". A send
    written into that gap comes back AUTH_REQUIRED, which reads as the server
    refusing the message rather than the link not being ready."""
    server = FakeServer()
    link = make_link(server)
    link._ws = object()  # dialled, auth.hello not yet accepted
    reply = await link.send_message(
        to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
        sender=None,
        text="ship it",
        msg_key="pa:mcp:mid-auth",
    )
    assert reply["error"]["code"] == server_link.LINK_OFFLINE


async def test_a_revoked_credential_says_so_instead_of_promising_a_retry():
    """LINK_OFFLINE invites a retry; this one never resolves by retrying."""
    server = FakeServer(responder=rejecting_responder("AUTH_REJECTED"))
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(link.terminated_reason))
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="ship it",
            msg_key="pa:mcp:revoked",
        )
        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_UNAUTHORIZED
        assert "AUTH_REJECTED" in reply["error"]["message"]
    finally:
        await link.stop()


async def test_the_policy_cache_outlives_the_connection_that_fetched_it():
    """The receiver-side gate must not depend on the control plane being
    reachable at the moment a message lands (t6/t12)."""
    server = FakeServer()
    link = await _connected(server)
    try:
        await _until(lambda: link._policy_revision == 1)
        cached = link._policy

        await server.opened[0].close()
        await _until(lambda: link._ws is None)
        assert link._policy == cached
        assert link._policy_revision == 1

        # And a reconnect re-reads it, because policy.changed pushed while this
        # device was away was missed.
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[1].policy_gets))
    finally:
        await link.stop()


async def test_inbound_message_is_delivered_on_the_existing_path_and_then_acked(broadcasts):
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))

        assert len(broadcasts) == 1
        assert broadcasts[0]["type"] == "agent_msg.deliver"
        payload = broadcasts[0]["payload"]
        assert payload["msg_key"] == "pa:mcp:deadbeef"
        assert payload["target_pane_id"] == "p1"
        assert payload["target_workspace_path"] == "/tmp/proj-a"
        assert payload["content"] == "please review"
        # Addressable straight back, and rate-limited by the receiving window
        # because nothing applied the per-pair limit on the way in.
        assert payload["from_display"] == "dev-a/alpha/sender"
        assert payload["from_pane_id"] == ""
        assert payload["cross_workspace"] is True
        assert payload["rate_limit"] is True
        # Nothing is acked until the window that owns the pane reports back.
        assert conn.acks == []

        # An on-machine message's key is not this link's business.
        assert link.note_delivery_result("someone-elses-key", True, "") is False

        assert link.note_delivery_result("pa:mcp:deadbeef", True, "") is True
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0] == {
            "msgKey": "pa:mcp:deadbeef",
            "state": "delivered",
            "paneId": "p1",
        }
        # A second report cannot ack twice.
        assert link.note_delivery_result("pa:mcp:deadbeef", True, "") is False
    finally:
        await link.stop()


async def test_a_refused_delivery_is_acked_as_failed(broadcasts):
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))
        # The renderer's reason is JSON; the ack carries the key alone.
        link.note_delivery_result("pa:mcp:deadbeef", False, '{"key": "rate-limit"}')
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0] == {
            "msgKey": "pa:mcp:deadbeef",
            "state": "failed",
            "reason": "rate-limit",
            "paneId": "p1",
        }
    finally:
        await link.stop()


async def test_an_unresolvable_target_is_acked_as_failed_without_delivering(broadcasts):
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["state"] == "failed"
        assert "paneId" not in conn.acks[0]
        assert broadcasts == []
    finally:
        await link.stop()


async def test_the_same_msg_key_pushed_twice_is_injected_once(broadcasts):
    """A backend restart can leave the old socket open while the new one is up,
    and the server pushes to every connection it holds for this device."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))
        await asyncio.sleep(0.1)
        assert len(broadcasts) == 1
        assert conn.acks == []
    finally:
        await link.stop()


async def test_policy_denial_acks_rejected_and_never_reaches_the_renderer(broadcasts):
    """A member you invited is subject to the policy; the empty one denies."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "messages.pending", "payload": _pending(member_id="m2")}
        )
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0] == {
            "msgKey": "pa:mcp:deadbeef",
            "state": "rejected",
            "reason": "policy-denied",
        }
        # rejected, not failed: the sender must not retry a permission refusal.
        # The refusal is announced to this machine's own windows (the knock
        # list), which is the point of that surface — but the message itself
        # must never reach the delivery path.
        assert [e for e in broadcasts if e["type"] == "agent_msg.deliver"] == []
        assert [e["type"] for e in broadcasts] == ["p2p.access_requests.changed"]
    finally:
        await link.stop()


async def test_a_blocked_device_is_refused_even_when_it_is_your_own(broadcasts):
    """The ordering that makes a block worth having.

    Every other mechanism here grants: rules grant, and sharing your member id
    grants unconditionally. A laptop of yours that walked off can only be shut
    out by something that runs ahead of that grant, which is why the block list
    is consulted before the own-device shortcut and not after it.
    """
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(
        policy={
            "version": 1,
            "default": "allow",
            "rules": [],
            "blocked": [{"deviceId": "dev-a", "reason": "stolen"}],
        }
    )
    link = await _connected(server)
    try:
        conn = server.opened[0]
        # member_id defaults to m1 — the receiver's own member. Even that, and
        # even under default:allow, does not get past a block.
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["state"] == "rejected"
        assert broadcasts == []
        # A blocked sender leaves no knock: the point of a block is that this
        # machine stops being asked about that device.
        assert link.access_requests() == []
    finally:
        await link.stop()


async def test_a_blocked_sender_is_told_the_same_thing_an_unauthorized_one_is(broadcasts):
    """Naming the block on the wire would hand the sender an oracle — the same
    reason authorization runs before pane resolution in this path."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(
        policy={"version": 1, "default": "deny", "rules": [], "blocked": [{"memberId": "m2"}]}
    )
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending(member_id="m2")})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["reason"] == "policy-denied"
    finally:
        await link.stop()


async def test_a_refused_member_leaves_a_knock_the_receiver_can_see(broadcasts):
    """Before this, a denied message told the sender and told the person whose
    machine refused it nothing at all."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending(member_id="m2")})
        await _until(lambda: bool(link.access_requests()))
        knock = link.access_requests()[0]
        assert knock["memberId"] == "m2"
        assert knock["deviceId"] == "dev-a"
        assert (knock["workspace"], knock["paneName"]) == ("proj-a", "reviewer")
        assert knock["attempts"] == 1

        # A second attempt refreshes the row rather than adding one.
        await conn.push(
            {"type": "messages.pending", "payload": _pending("pa:mcp:second", member_id="m2")}
        )
        await _until(lambda: link.access_requests()[0]["attempts"] == 2)
        assert len(link.access_requests()) == 1
    finally:
        await link.stop()


async def test_your_own_machine_leaves_no_knock(broadcasts):
    """It was never refused, so there is nothing to decide about it."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))
        assert link.access_requests() == []
    finally:
        await link.stop()


async def test_your_own_other_machine_is_not_subject_to_the_pane_policy(broadcasts):
    """Signing the same account in on a second device is itself the grant.

    The deny-everything policy below would refuse anyone else, and does (see the
    test above); it must not stand between two machines of the same person, or
    adding a laptop would mean editing a policy before it could reach anything.
    """
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "messages.pending", "payload": _pending(member_id="m1")}
        )
        await _until(lambda: bool(broadcasts))
        assert conn.acks == []  # delivered, not rejected
    finally:
        await link.stop()


async def test_a_message_with_no_sender_member_is_still_policed(broadcasts):
    """The exemption keys on an equal, non-empty member id.

    A payload that arrives without one must fall through to the policy rather
    than compare empty-to-empty and let itself in.
    """
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        payload = _pending(member_id="m1")
        payload["from"]["memberId"] = ""
        await conn.push({"type": "messages.pending", "payload": payload})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["state"] == "rejected"
        assert conn.acks[0]["reason"] == "policy-denied"
        assert [e for e in broadcasts if e["type"] == "agent_msg.deliver"] == []
    finally:
        await link.stop()


async def test_the_policy_still_admits_an_invited_member_it_allows(broadcasts):
    """The exemption does not replace the policy: an explicit allow still works."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(
        policy={
            "version": 1,
            "default": "deny",
            "rules": [
                {
                    "from": {"memberId": "m2", "deviceId": "*"},
                    "to": {"workspace": "*", "paneName": "*"},
                    "action": "allow",
                }
            ],
        }
    )
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "messages.pending", "payload": _pending(member_id="m2")}
        )
        await _until(lambda: bool(broadcasts))
        assert conn.acks == []
    finally:
        await link.stop()


async def test_the_policy_is_fetched_once_and_refetched_only_on_a_new_revision(broadcasts):
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _until(lambda: bool(conn.policy_gets))
        assert len(conn.policy_gets) == 1

        for index in range(3):
            await conn.push({"type": "messages.pending", "payload": _pending(f"k{index}")})
        await _until(lambda: len(conn.acks) >= 3)
        # The control plane is not in the path of a message.
        assert len(conn.policy_gets) == 1

        # A nudge at the revision already cached is not worth a round trip.
        await conn.push({"type": "policy.changed", "payload": {"revision": 1}})
        await asyncio.sleep(0.05)
        assert len(conn.policy_gets) == 1

        server.policy_revision = 2
        await conn.push({"type": "policy.changed", "payload": {"revision": 2}})
        await _until(lambda: len(conn.policy_gets) == 2)
    finally:
        await link.stop()


# ---- writing the policy (the Settings editor) --------------------------------


def _allow_own_devices(member_id: str = "m1") -> dict:
    return {
        "version": 1,
        "default": "deny",
        "rules": [
            {
                "from": {"memberId": member_id, "deviceId": "*"},
                "to": {"workspace": "*", "paneName": "*"},
                "action": "allow",
            }
        ],
    }


async def test_writing_the_policy_publishes_it_and_adopts_the_new_revision():
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _until(lambda: bool(conn.policy_gets))
        document = _allow_own_devices()

        reply = await link.set_policy(document)

        assert reply["ok"] is True
        assert conn.policy_sets[0]["deviceId"] == link._device_id
        assert conn.policy_sets[0]["policy"] == document
        # Adopted locally, so the editor re-reading right after the save is not
        # shown the policy it just replaced.
        assert link.policy_snapshot() == {"policy": document, "revision": 2}
        # And the push that follows the write is a no-op, since the cache is
        # already at that revision.
        await conn.push({"type": "policy.changed", "payload": {"revision": 2}})
        await asyncio.sleep(0.05)
        assert len(conn.policy_gets) == 1
    finally:
        await link.stop()


async def test_a_write_the_server_does_not_number_is_re_read_rather_than_guessed():
    def unnumbered(conn: FakeConnection, message: dict) -> dict | None:
        if message.get("type") == "policy.set":
            conn.policy_sets.append(message.get("payload") or {})
            conn.server.policy = (message.get("payload") or {}).get("policy")
            conn.server.policy_revision += 1
            return _ok(message, {"deviceId": "d1"})
        return default_responder(conn, message)

    server = FakeServer(responder=unnumbered)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _until(lambda: bool(conn.policy_gets))

        assert (await link.set_policy(_allow_own_devices()))["ok"] is True

        assert len(conn.policy_gets) == 2
        assert link.policy_snapshot()["revision"] == 2
    finally:
        await link.stop()


async def test_a_disconnected_link_refuses_the_write_instead_of_dropping_it():
    """The policy lives on the server, so an offline editor must be told the
    rule was not saved rather than shown it in a list that will vanish."""
    server = FakeServer()
    link = await _connected(server)
    try:
        await server.opened[0].close()
        await _until(lambda: link._ws is None)

        reply = await link.set_policy(_allow_own_devices())

        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_OFFLINE
    finally:
        await link.stop()


async def test_the_editor_reads_the_cached_policy_while_the_link_is_down(monkeypatch):
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    monkeypatch.setattr(server_link, "_link", link)
    try:
        await _until(lambda: link._policy_revision == 1)
        assert (await server_link.policy_state())["editable"] is True

        await server.opened[0].close()
        await _until(lambda: link._ws is None)

        state = await server_link.policy_state()
        # Readable, and honest about not being writable.
        assert state["policy"] == ALLOW_ALL_POLICY
        assert state["revision"] == 1
        assert state["editable"] is False
        assert state["memberId"] == "m1"
    finally:
        await link.stop()


async def test_with_no_server_there_is_no_policy_to_read_or_write(monkeypatch):
    monkeypatch.setattr(server_link, "_link", None)
    state = await server_link.policy_state()
    assert state == {
        "state": server_link.STATE_UNCONFIGURED,
        "editable": False,
        "policy": None,
        "revision": None,
        "deviceId": "",
        "memberId": "",
    }
    assert await server_link.set_policy(_allow_own_devices()) is None


# ---- team members (the Settings pane) ---------------------------------------
# The roster and the role live on the server. This side stores the role because
# it decides whether the pane may offer the management actions at all, and
# caches the roster so the pane can show the team while the link is down.


async def test_the_role_from_auth_hello_is_kept(monkeypatch):
    """A UI that guessed at the role would show buttons every request refuses,
    so the role has to come from the handshake and be readable afterwards."""
    server = FakeServer()
    link = await _connected(server)
    monkeypatch.setattr(server_link, "_link", link)
    try:
        assert link.member_role == "member"
        state = await server_link.members_state()
        assert state["role"] == "member"
        assert state["memberId"] == "m1"
        # Connected, but not an admin: no management actions.
        assert state["canManage"] is False
    finally:
        await link.stop()


async def test_an_admin_on_a_live_link_may_manage(monkeypatch):
    server = FakeServer(responder=_admin_responder)
    link = await _connected(server)
    monkeypatch.setattr(server_link, "_link", link)
    try:
        await _until(lambda: link.members_snapshot() is not None)
        assert (await server_link.members_state())["canManage"] is True
    finally:
        await link.stop()


async def test_the_roster_is_fetched_once_per_connection(monkeypatch):
    server = FakeServer()
    link = await _connected(server)
    monkeypatch.setattr(server_link, "_link", link)
    try:
        await _until(lambda: bool(server.opened[0].member_lists))
        assert len(server.opened[0].member_lists) == 1
        state = await server_link.members_state()
        assert [m["memberId"] for m in state["members"]] == ["m1"]
    finally:
        await link.stop()


async def test_a_members_changed_push_replaces_the_cache(monkeypatch):
    """The push carries the whole roster, so subscribing to it is what saves the
    pane from polling the server."""
    server = FakeServer()
    link = await _connected(server)
    monkeypatch.setattr(server_link, "_link", link)
    try:
        await _until(lambda: link.members_snapshot() is not None)
        await server.opened[0].push(
            {
                "type": "team.members.changed",
                "payload": {
                    "members": [
                        {"memberId": "m1", "role": "member", "disabled": False},
                        {"memberId": "m2", "role": "observer", "disabled": False},
                    ]
                },
            }
        )
        await _until(lambda: len(link.members_snapshot() or []) == 2)
        state = await server_link.members_state()
        assert [m["memberId"] for m in state["members"]] == ["m1", "m2"]
        # No second read: the push *is* the update.
        assert len(server.opened[0].member_lists) == 1
    finally:
        await link.stop()


async def test_a_write_re_reads_the_roster_without_waiting_for_the_push(monkeypatch):
    server = FakeServer(responder=_admin_responder)
    link = await _connected(server)
    monkeypatch.setattr(server_link, "_link", link)
    try:
        await _until(lambda: link.members_snapshot() is not None)
        reply = await server_link.members_request(
            "team.members.invite", {"displayName": "Bo", "role": "observer"}
        )
        assert reply["ok"] is True
        # The one-time token is in the invite reply and nowhere else.
        assert reply["payload"]["token"] == "one-time-token"
        state = await server_link.members_state()
        assert [m["memberId"] for m in state["members"]] == ["m1", "m2"]
        assert all("token" not in m for m in state["members"])
    finally:
        await link.stop()


async def test_revoke_reports_the_connections_it_dropped(monkeypatch):
    server = FakeServer(responder=_admin_responder)
    link = await _connected(server)
    monkeypatch.setattr(server_link, "_link", link)
    try:
        await _until(lambda: link.members_snapshot() is not None)
        reply = await server_link.members_request("team.members.revoke", {"memberId": "m1"})
        assert reply["payload"]["droppedConnections"] == 2
        assert (await server_link.members_state())["members"][0]["disabled"] is True
    finally:
        await link.stop()


async def test_the_roster_survives_the_connection_that_fetched_it(monkeypatch):
    """An admin whose server just went down still has to see who is on the team
    — with the actions off, which is what canManage says."""
    server = FakeServer(responder=_admin_responder)
    link = await _connected(server)
    monkeypatch.setattr(server_link, "_link", link)
    try:
        await _until(lambda: link.members_snapshot() is not None)
        await server.opened[0].close()
        await _until(lambda: link._ws is None)

        state = await server_link.members_state()
        assert [m["memberId"] for m in state["members"]] == ["m1"]
        assert state["canManage"] is False
        # And a write refuses at once rather than blocking on a socket that is
        # not there.
        reply = await server_link.members_request("team.members.revoke", {"memberId": "m1"})
        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_OFFLINE
    finally:
        await link.stop()


async def test_with_no_server_there_is_no_team(monkeypatch):
    monkeypatch.setattr(server_link, "_link", None)
    assert await server_link.members_state() == {
        "state": server_link.STATE_UNCONFIGURED,
        "role": "",
        "memberId": "",
        "canManage": False,
        "members": [],
    }
    assert await server_link.members_request("team.members.revoke", {"memberId": "m1"}) is None


async def test_a_stale_pane_id_hint_is_re_resolved_and_the_new_id_acked(broadcasts):
    """A detach or reattach mints a new pane id, so the sender's cached hint
    goes stale; (workspace, paneName) is the stable identity."""
    agent_messaging.register("p9", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending(pane_id="p1")})
        await _until(lambda: bool(broadcasts))
        assert broadcasts[0]["payload"]["target_pane_id"] == "p9"

        link.note_delivery_result("pa:mcp:deadbeef", True, "")
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["paneId"] == "p9"
    finally:
        await link.stop()


# ---- remote roster ----------------------------------------------------------
# The other direction of the roster: what the *server* says about other
# machines' panes. server_link is the only writer of remote_roster, so these
# cover the wiring — one full read per connection, then the push — while
# test_remote_roster.py covers the cache's own rules.


def _row(session_id: str, device_id: str, **overrides) -> dict:
    row = {
        "sessionId": session_id,
        "deviceId": device_id,
        "workspace": "proj-b",
        "workspacePath": "/home/other/proj-b",
        "title": "builder",
        "paneId": f"pane-{session_id}",
        "agentKey": "codex",
        "status": "waiting",
        "hostOnline": True,
    }
    row.update(overrides)
    return row


async def test_the_directory_is_read_once_per_connection_without_our_own_rows():
    from agent_team_backend import remote_roster

    from agent_team_backend import device_identity

    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    # The directory the server sends back always includes this device's own
    # rows; keeping them would give one pane two answers, the server's copy
    # being the stale one.
    server.directory = [
        _row("s-far", "dev-far"),
        _row("s-mine", device_identity.device_id(), workspace="proj-a", title="reviewer"),
    ]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _until(lambda: bool(conn.directories))
        assert len(conn.directories) == 1
        assert [p.device_id for p in remote_roster.list_panes()] == ["dev-far"]
        assert remote_roster.list_panes()[0].address == "dev-far/proj-b/builder"
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_a_sessions_changed_push_replaces_the_roster():
    from agent_team_backend import remote_roster

    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "sessions.changed", "payload": {"sessions": [_row("s1", "dev-far")]}}
        )
        await _until(lambda: len(remote_roster.list_panes()) == 1)

        await conn.push(
            {
                "type": "sessions.changed",
                "payload": {"sessions": [_row("s2", "dev-far", title="other")]},
            }
        )
        await _until(lambda: remote_roster.list_panes()[0].pane_name == "other")
        assert len(remote_roster.list_panes()) == 1
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_presence_changed_marks_a_departed_device_offline():
    """A device leaving changes no session row, so sessions.changed never fires
    for it; without presence.changed the roster would keep calling it online."""
    from agent_team_backend import remote_roster

    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "sessions.changed", "payload": {"sessions": [_row("s1", "dev-far")]}}
        )
        await _until(lambda: len(remote_roster.list_panes()) == 1)
        assert remote_roster.list_panes()[0].offline is False

        await conn.push({"type": "presence.changed", "payload": {"devices": []}})
        await _until(lambda: remote_roster.list_panes()[0].offline is True)
        assert remote_roster.list_panes()[0].host_online is False

        await conn.push(
            {"type": "presence.changed", "payload": {"devices": [{"deviceId": "dev-far"}]}}
        )
        await _until(lambda: remote_roster.list_panes()[0].host_online is True)
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_the_remote_roster_outlives_the_connection_that_fetched_it():
    """Same call as the policy cache: a link that dropped a second ago does not
    make the panes it knew about stop existing."""
    from agent_team_backend import remote_roster

    server = FakeServer()
    server.directory = [_row("s1", "dev-far")]
    link = await _connected(server)
    try:
        await _until(lambda: len(remote_roster.list_panes()) == 1)
        await server.opened[0].close()
        await _until(lambda: link._ws is None)
        assert len(remote_roster.list_panes()) == 1

        # And the reconnect re-reads it, because pushes sent while this device
        # was away were missed.
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[1].directories))
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_a_rejected_directory_read_leaves_the_previous_cache_in_force():
    from agent_team_backend import remote_roster

    def no_directory(conn: FakeConnection, message: dict):
        if message.get("type") == "sessions.directory":
            conn.directories.append(message.get("payload") or {})
            return _bad_request(message, "nope")
        return default_responder(conn, message)

    remote_roster.replace([_row("s1", "dev-far")], local_device_id="whoever")
    server = FakeServer(responder=no_directory)
    link = await _connected(server)
    try:
        await _until(lambda: bool(server.opened[0].directories))
        await asyncio.sleep(0.05)
        assert len(remote_roster.list_panes()) == 1
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_an_unconfigured_link_never_touches_the_remote_roster():
    """The no-server guarantee, at this module's edge: nothing is dialled, so
    nothing can ever land in the cache."""
    from agent_team_backend import remote_roster

    server = FakeServer()
    link = make_link(server, config=ServerLinkConfig())
    assert await link.start() is False
    await asyncio.sleep(0.05)
    assert remote_roster.list_panes() == []
    await link.stop()


# ---- configuration ----------------------------------------------------------


def test_config_round_trips_through_settings_and_the_vault(tmp_path, monkeypatch):
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )
    monkeypatch.setattr(app, "credential_vault", vault)
    try:
        monkeypatch.setenv(server_link.SERVER_URL_ENV, "  ws://localhost:8787/ws  ")
        server_link.set_access_token("  tok-abc  ")
        assert server_link.load_config() == CONFIG
        assert server_link.load_config().configured

        # Only the token half can be missing now: the address always resolves.
        server_link.set_access_token(None)
        assert server_link.load_config() == ServerLinkConfig(url=CONFIG.url)
        assert not server_link.load_config().configured
    finally:
        pass


def test_app_secret_file_backend_is_private(tmp_path):
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )
    assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) is None
    vault.write_app_secret(server_link.ACCESS_TOKEN_SECRET, "tok-abc")
    path = vault.app_secret_path(server_link.ACCESS_TOKEN_SECRET)
    assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) == "tok-abc"
    assert path.stat().st_mode & 0o777 == 0o600
    vault.write_app_secret(server_link.ACCESS_TOKEN_SECRET, None)
    assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) is None


def test_app_secret_keychain_refuses_a_multiline_payload(tmp_path):
    """`security -i` parses one command per line, so a newline truncates the
    item. The guard has to fire before the Keychain is touched."""
    calls: list[list[str]] = []

    def runner(args: list[str], input_text: str | None = None) -> tuple[int, str]:
        calls.append(list(args))
        return 44, ""

    vault = CredentialVault(
        root=tmp_path / "vault",
        real_home=tmp_path / "home",
        security_runner=runner,
        platform="darwin",
    )
    with pytest.raises(CredentialVaultError):
        vault.write_app_secret(server_link.ACCESS_TOKEN_SECRET, '{\n"token": "x"\n}')
    assert calls == []


# ---- module-level link ------------------------------------------------------


async def test_module_helpers_do_nothing_without_a_link():
    """The regression line that matters most: a machine with no server
    configured must behave exactly as it did before any of this existed."""
    assert server_link._link is None
    server_link.roster_changed()  # must not raise
    assert (
        await server_link.send_message(to={}, sender=None, text="hi", msg_key="k") is None
    )
    assert server_link.note_delivery_result("k", True, "") is False
    await server_link.stop()

# ---- reconfiguring without a backend restart --------------------------------


@pytest.fixture
def module_link(monkeypatch):
    """Drive the process-wide link (start/stop/reconfigure/status) against the
    fake server, with the configuration under the test's control.

    Both ``ServerLink`` and ``load_config`` are swapped: ``start()`` constructs
    the class by name and ``status()`` reads the module function, so patching
    one without the other would leave half the path talking to the real
    Keychain. The factory deliberately passes no ``config_loader`` so the
    instance picks up whatever ``load_config`` is patched to at the moment it
    is built — which is how a test can hand the link the real config path.
    """
    state = {"config": ServerLinkConfig()}
    server = FakeServer(count=16)

    def factory() -> ServerLink:
        return ServerLink(
            connect=server.connect,
            token_clearer=lambda: None,
            device_name="test-box",
        )

    monkeypatch.setattr(server_link, "ServerLink", factory)
    monkeypatch.setattr(server_link, "load_config", lambda: state["config"])
    yield state, server


async def test_reconfigure_dials_once_the_settings_are_filled_in(module_link, monkeypatch):
    """The gap signing in walks straight into: start() runs at boot, so a
    credential stored afterwards has to be picked up without a restart."""
    state, server = module_link
    await server_link.start()
    try:
        assert server_link._link is None
        assert server.opened == []
        assert (await server_link.status())["state"] == server_link.STATE_UNCONFIGURED

        # The URL a connected link reports comes from the build (or the dev
        # override), never from a user-entered setting.
        monkeypatch.setenv(server_link.SERVER_URL_ENV, CONFIG.url)
        state["config"] = CONFIG
        await server_link.reconfigure()
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        assert server.urls == [CONFIG.url]
        status = await server_link.status()
        assert status["state"] == server_link.STATE_CONNECTED
        assert status["serverUrl"] == CONFIG.url
        assert status["hasToken"] is True
    finally:
        await server_link.stop()


async def test_reconfigure_replaces_the_link_rather_than_adding_one(module_link):
    """Two links for one device would both publish the roster and both take
    delivery of the same relayed message."""
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        first = server_link._link
        await _until(lambda: bool(server.opened and server.opened[0].syncs))

        state["config"] = ServerLinkConfig(url="ws://elsewhere/ws", token="tok-2")
        await server_link.reconfigure()
        await _until(lambda: len(server.opened) == 2 and bool(server.opened[1].syncs))

        assert server_link._link is not first
        assert first is not None and first._task is None
        assert server.urls == [CONFIG.url, "ws://elsewhere/ws"]
    finally:
        await server_link.stop()


async def test_clearing_the_settings_takes_the_link_back_to_inert(module_link):
    """The regression line: erasing the configuration must restore exactly the
    behaviour of a machine that never had a server."""
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))

        state["config"] = ServerLinkConfig()
        await server_link.reconfigure()

        assert server_link._link is None
        assert len(server.opened) == 1
        assert (await server_link.status())["state"] == server_link.STATE_UNCONFIGURED
        assert (
            await server_link.send_message(to={}, sender=None, text="hi", msg_key="k")
            is None
        )
        server_link.roster_changed()  # must not raise
    finally:
        await server_link.stop()


async def test_status_reports_a_rejected_token_as_unauthorized(module_link):
    state, server = module_link
    state["config"] = CONFIG
    server.connections = [
        FakeConnection(rejecting_responder("AUTH_REJECTED"), server) for _ in range(4)
    ]
    await server_link.start()
    try:
        await _until(
            lambda: server_link._link is not None
            and server_link._link.state() == server_link.STATE_UNAUTHORIZED
        )
        status = await server_link.status()
        assert status["state"] == server_link.STATE_UNAUTHORIZED
        assert "AUTH_REJECTED" in status["detail"]
        assert status["hasToken"] is True
    finally:
        await server_link.stop()


async def test_status_never_carries_the_access_token(module_link):
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        status = await server_link.status()
        assert CONFIG.token not in json.dumps(status)
        assert "token" not in status
    finally:
        await server_link.stop()


async def test_state_is_unreachable_after_a_failed_dial():
    """A server that is merely down must not read the same as a rejected
    credential: one of the two is worth retyping the token for."""

    def refuse(url: str):
        raise ConnectionError("connection refused")

    link = ServerLink(
        connect=refuse, config_loader=lambda: CONFIG, device_name="test-box"
    )
    assert await link.start() is True
    try:
        assert link.state() == server_link.STATE_CONNECTING
        await _until(lambda: link.state() == server_link.STATE_UNREACHABLE)
        assert "connection refused" in link.last_error
    finally:
        await link.stop()


async def test_a_reconnect_clears_the_stale_error():
    """last_error is what tells "cannot reach" from "not tried yet", so a link
    that comes back must stop reporting the failure that preceded it."""
    server = FakeServer()
    dials = {"n": 0}

    def flaky(url: str):
        dials["n"] += 1
        if dials["n"] == 1:
            raise ConnectionError("connection refused")
        return server.connect(url)

    link = ServerLink(
        connect=flaky, config_loader=lambda: CONFIG, device_name="test-box"
    )
    await link.start()
    try:
        await _until(lambda: link.state() == server_link.STATE_UNREACHABLE)
        await _until(lambda: link.state() == server_link.STATE_CONNECTED)
        assert link.last_error == ""
    finally:
        await link.stop()


# ---- ws handlers ------------------------------------------------------------


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


def _ws_session() -> "app.Session":
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


async def test_configure_handler_stores_the_token_and_reconnects(
    module_link, tmp_path, monkeypatch
):
    """One call lands the token in the vault and leaves a dialling link. The URL
    half is gone: it is built in, so there is nothing for the caller to set."""
    state, server = module_link
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )
    monkeypatch.setattr(app, "credential_vault", vault)
    # The handler writes through the real config path; the link reads the
    # fixture's, so `state` is followed along by hand.
    monkeypatch.setenv(server_link.SERVER_URL_ENV, CONFIG.url)
    monkeypatch.setattr(
        server_link,
        "load_config",
        lambda: ServerLinkConfig(url=server_link.server_url(), token=server_link.access_token()),
    )
    session = _ws_session()
    try:
        await app.handle_message(
            session,
            {
                "id": "c1",
                "type": "p2p.link.configure",
                # serverUrl from an older renderer is accepted and ignored.
                "payload": {"serverUrl": "  ws://typo/ws  ", "token": "tok-abc"},
            },
        )
        reply = session.websocket.sent[0]
        assert reply["type"] == "p2p.link.configure.result"
        assert reply["ok"] is True
        assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) == "tok-abc"
        # The typo'd address was ignored; the build's own value is in effect.
        assert server_link.server_url() == CONFIG.url
        await _until(lambda: bool(server.opened and server.opened[0].syncs))

        session2 = _ws_session()
        await app.handle_message(session2, {"id": "s1", "type": "p2p.link.status", "payload": {}})
        status = session2.websocket.sent[0]["payload"]["status"]
        assert status["state"] == server_link.STATE_CONNECTED
        assert status["hasToken"] is True
        assert "token" not in status
    finally:
        await server_link.stop()
        app.ui_settings_store.set({server_link.SERVER_URL_SETTING: None})


async def test_configure_handler_leaves_the_token_alone_when_absent(
    module_link, tmp_path, monkeypatch
):
    """The UI never shows the stored token, so saving a new URL must not wipe
    the credential the user could not have retyped."""
    module_link  # the link is patched so nothing dials the real network
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )
    monkeypatch.setattr(app, "credential_vault", vault)
    vault.write_app_secret(server_link.ACCESS_TOKEN_SECRET, "tok-abc")
    session = _ws_session()
    try:
        await app.handle_message(
            session,
            {"id": "c1", "type": "p2p.link.configure", "payload": {}},
        )
        assert session.websocket.sent[0]["ok"] is True
        assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) == "tok-abc"

        # An explicit empty string is how the user erases it.
        await app.handle_message(
            session,
            {"id": "c2", "type": "p2p.link.configure", "payload": {"token": ""}},
        )
        assert session.websocket.sent[1]["ok"] is True
        assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) is None
    finally:
        await server_link.stop()
        app.ui_settings_store.set({server_link.SERVER_URL_SETTING: None})


async def test_configure_handler_ignores_a_serverurl_from_an_older_renderer():
    """A stale window still sends the field. Rejecting would make every save
    from that window fail over a value that no longer has any effect."""
    session = _ws_session()
    await app.handle_message(
        session,
        {"id": "c1", "type": "p2p.link.configure", "payload": {"serverUrl": 42}},
    )
    assert session.websocket.sent[0]["ok"] is True


async def test_configure_handler_rejects_a_non_string_token():
    session = _ws_session()
    await app.handle_message(
        session,
        {"id": "c1", "type": "p2p.link.configure", "payload": {"token": 42}},
    )
    reply = session.websocket.sent[0]
    assert reply["ok"] is False
    assert reply["error"]["code"] == "BAD_REQUEST"


# ---- the address is the build's ---------------------------------------------


def test_server_url_is_built_in(monkeypatch):
    monkeypatch.delenv(server_link.SERVER_URL_ENV, raising=False)
    assert server_link.server_url() == server_link.DEFAULT_SERVER_URL
    assert server_link.DEFAULT_SERVER_URL.startswith("wss://")


def test_env_overrides_the_built_in_address(monkeypatch):
    """The escape hatch development and the verify scripts run through."""
    monkeypatch.setenv(server_link.SERVER_URL_ENV, "  ws://localhost:8787/ws  ")
    assert server_link.server_url() == "ws://localhost:8787/ws"


def test_a_stored_user_entered_address_is_ignored(monkeypatch):
    """An install upgrading from the configurable era carries whatever its user
    typed. It must move to the real service, not keep dialling that value."""
    monkeypatch.delenv(server_link.SERVER_URL_ENV, raising=False)
    app.ui_settings_store.set({server_link.SERVER_URL_SETTING: "ws://stale-typo/ws"})
    try:
        assert server_link.server_url() == server_link.DEFAULT_SERVER_URL
    finally:
        app.ui_settings_store.set({server_link.SERVER_URL_SETTING: None})


# ---- the policy editor's handlers -------------------------------------------


async def test_policy_get_answers_with_no_server_configured():
    """The whole section is hidden for a machine with no server, so this answer
    is what tells the UI to hide it — it must never fail or block."""
    session = _ws_session()
    await app.handle_message(session, {"id": "g1", "type": "p2p.policy.get", "payload": {}})
    payload = session.websocket.sent[0]["payload"]
    assert payload["state"] == server_link.STATE_UNCONFIGURED
    assert payload["editable"] is False
    assert payload["policy"] is None
    assert payload["devices"] == []


async def test_policy_get_and_set_round_trip_through_the_handlers(module_link):
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        remote_roster.replace(
            [
                {
                    "sessionId": "s1",
                    "deviceId": "far-1",
                    "deviceName": "Laptop",
                    "workspace": "proj",
                    "title": "reviewer",
                    "status": "waiting",
                    "hostOnline": True,
                }
            ],
            local_device_id="local",
        )

        session = _ws_session()
        await app.handle_message(session, {"id": "g1", "type": "p2p.policy.get", "payload": {}})
        before = session.websocket.sent[0]["payload"]
        assert before["editable"] is True
        assert before["memberId"] == "m1"
        # The picker's device list rides along with the policy.
        assert before["devices"] == [
            {"deviceId": "far-1", "deviceName": "Laptop", "paneCount": 1}
        ]

        document = _allow_own_devices()
        await app.handle_message(
            session,
            {"id": "s1", "type": "p2p.policy.set", "payload": {"policy": document}},
        )
        reply = session.websocket.sent[1]
        assert reply["ok"] is True
        # The write answers with the state the editor should now show, so no
        # second round trip can show it the policy it just replaced.
        assert reply["payload"]["policy"] == document
        assert reply["payload"]["revision"] == 2
        assert server.opened[0].policy_sets[0]["policy"] == document
    finally:
        await server_link.stop()
        remote_roster._reset_for_test()


async def test_a_policy_this_build_would_not_honour_never_reaches_the_server(module_link):
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs))
        session = _ws_session()

        await app.handle_message(
            session,
            {
                "id": "s1",
                "type": "p2p.policy.set",
                # An empty deviceId is exactly what a rule the delivery path
                # would silently skip looks like.
                "payload": {
                    "policy": {
                        "version": 1,
                        "default": "deny",
                        "rules": [
                            {
                                "from": {"memberId": "m1", "deviceId": ""},
                                "to": {"workspace": "*", "paneName": "*"},
                                "action": "allow",
                            }
                        ],
                    }
                },
            },
        )
        reply = session.websocket.sent[0]
        assert reply["ok"] is False
        assert reply["error"]["code"] == "BAD_REQUEST"
        assert server.opened[0].policy_sets == []
    finally:
        await server_link.stop()


async def test_writing_a_policy_with_no_server_says_so_instead_of_failing_silently():
    session = _ws_session()
    await app.handle_message(
        session,
        {"id": "s1", "type": "p2p.policy.set", "payload": {"policy": _allow_own_devices()}},
    )
    reply = session.websocket.sent[0]
    assert reply["ok"] is False
    assert reply["error"]["code"] == "P2P_NOT_CONFIGURED"
