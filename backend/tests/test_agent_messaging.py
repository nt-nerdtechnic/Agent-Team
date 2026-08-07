"""Cross-workspace inter-CLI messaging: registry, target resolution, handlers."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, ws_handlers
from agent_team_backend.agent_message_log import AgentMessageLog
from agent_team_backend.db import Database


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def _seed_two_workspaces() -> None:
    agent_messaging.register("p1", "claude-1", "/ws/alpha", agent_key="claude")
    agent_messaging.register("p2", "reviewer", "/ws/alpha", agent_key="claude")
    agent_messaging.register("p3", "reviewer", "/ws/beta", agent_key="codex")


# ── Registry ───────────────────────────────────────────────────────────────
def test_register_exposes_workspace_label_and_qualified_name() -> None:
    entry = agent_messaging.register("p1", "reviewer", "/Users/me/Agent-Team")
    assert entry.workspace_label == "Agent-Team"
    assert entry.qualified_name == "Agent-Team/reviewer"


def test_register_replaces_existing_entry_so_renames_propagate() -> None:
    agent_messaging.register("p1", "old", "/ws/alpha")
    agent_messaging.register("p1", "new", "/ws/alpha")
    entry = agent_messaging.get("p1")
    assert entry is not None and entry.name == "new"
    assert len(agent_messaging.list_panes()) == 1


def test_same_name_allowed_in_different_workspaces() -> None:
    _seed_two_workspaces()
    names = [(e.workspace_path, e.name) for e in agent_messaging.list_panes()]
    assert ("/ws/alpha", "reviewer") in names
    assert ("/ws/beta", "reviewer") in names


def test_list_panes_filters_by_workspace() -> None:
    _seed_two_workspaces()
    only_beta = agent_messaging.list_panes("/ws/beta")
    assert [e.pane_id for e in only_beta] == ["p3"]


def test_trailing_slash_workspace_is_normalized() -> None:
    agent_messaging.register("p1", "a", "/ws/alpha/")
    assert agent_messaging.list_panes("/ws/alpha")[0].pane_id == "p1"


def test_drop_owner_forgets_only_that_windows_panes() -> None:
    win_a, win_b = object(), object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=win_a)
    agent_messaging.register("p2", "b", "/ws/beta", owner=win_b)
    dropped = agent_messaging.drop_owner(win_a)
    assert dropped == ["p1"]
    assert [e.pane_id for e in agent_messaging.list_panes()] == ["p2"]


# ── Resolution ─────────────────────────────────────────────────────────────
def test_bare_name_resolves_only_within_sender_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is not None and result.pane.pane_id == "p2"
    assert result.cross_workspace is False


def test_bare_name_never_reaches_another_workspace() -> None:
    agent_messaging.register("p1", "claude-1", "/ws/alpha")
    agent_messaging.register("p3", "reviewer", "/ws/beta")
    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is None
    assert result.error is not None and "unknown target" in result.error


def test_qualified_name_reaches_another_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "beta/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p3"
    assert result.cross_workspace is True


def test_qualified_name_within_own_workspace_is_not_cross_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "alpha/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p2"
    assert result.cross_workspace is False


def test_absolute_workspace_path_addressing() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "/ws/beta/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p3"


def test_unknown_workspace_is_an_error_not_a_fallback() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "gamma/reviewer")
    assert result.pane is None
    assert result.error is not None and "unknown workspace" in result.error


def test_ambiguous_workspace_basename_refuses_to_guess() -> None:
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    agent_messaging.register("p3", "target", "/three/proj")
    result = agent_messaging.resolve("p1", "proj/target")
    assert result.pane is None
    assert result.error is not None and "ambiguous workspace" in result.error


def test_ambiguity_resolved_by_longer_path_suffix() -> None:
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    result = agent_messaging.resolve("p1", "two/proj/target")
    assert result.pane is not None and result.pane.pane_id == "p2"


def test_duplicate_name_in_one_workspace_refuses_to_guess() -> None:
    """Two windows can hold the same workspace (a detached run group) and each
    derives handles locally, so the same name can appear twice."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "claude-2", "/ws/beta")
    agent_messaging.register("p3", "claude-2", "/ws/beta")
    result = agent_messaging.resolve("p1", "beta/claude-2")
    assert result.pane is None
    assert result.error is not None and "ambiguous target" in result.error


def test_unknown_pane_in_known_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "beta/nobody")
    assert result.pane is None
    assert result.error is not None and "unknown target" in result.error


def test_empty_and_malformed_targets() -> None:
    _seed_two_workspaces()
    assert agent_messaging.resolve("p1", "").error == "empty target"
    assert agent_messaging.resolve("p1", "beta/").error is not None


def test_sender_display_is_always_qualified() -> None:
    _seed_two_workspaces()
    assert agent_messaging.sender_display("p1", "fallback") == "alpha/claude-1"
    assert agent_messaging.sender_display("nope", "fallback") == "fallback"


# ── WS handlers ────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_register_handler_mirrors_pane() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "p1",
            "name": "reviewer",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
        },
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["qualified_name"] == "alpha/reviewer"
    assert agent_messaging.get("p1") is not None


@pytest.mark.asyncio
async def test_register_handler_rejects_missing_fields() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "p1"},
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["error"]["code"] == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_unregister_handler_removes_pane() -> None:
    agent_messaging.register("p1", "a", "/ws/alpha")
    session = _session()
    await app.handle_message(session, {
        "id": "u1",
        "type": "agent_msg.unregister",
        "payload": {"pane_id": "p1"},
    })
    assert agent_messaging.get("p1") is None


@pytest.mark.asyncio
async def test_list_handler_returns_all_workspaces_when_unfiltered() -> None:
    _seed_two_workspaces()
    session = _session()
    await app.handle_message(session, {
        "id": "l1",
        "type": "agent_msg.list",
        "payload": {},
    })
    panes = session.websocket.sent[0]["payload"]["panes"]  # type: ignore[attr-defined]
    assert {p["pane_id"] for p in panes} == {"p1", "p2", "p3"}


@pytest.mark.asyncio
async def test_list_pairs_pane_id_with_its_address() -> None:
    """The drag-to-mention path resolves a dropped pane id to its address
    straight from this listing, so the pairing has to be exact."""
    _seed_two_workspaces()
    session = _session()
    await app.handle_message(session, {
        "id": "l2",
        "type": "agent_msg.list",
        "payload": {},
    })
    panes = session.websocket.sent[0]["payload"]["panes"]  # type: ignore[attr-defined]
    by_id = {p["pane_id"]: p["qualified_name"] for p in panes}
    assert by_id == {
        "p1": "alpha/claude-1",
        "p2": "alpha/reviewer",
        "p3": "beta/reviewer",
    }


@pytest.mark.asyncio
async def test_route_handler_broadcasts_deliver_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_two_workspaces()
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "d1",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": "beta/reviewer",
            "content": "run the tests",
            "msg_key": "k1",
        },
    })
    await asyncio.sleep(0)

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is True
    assert resp["payload"]["target_pane_id"] == "p3"
    assert resp["payload"]["cross_workspace"] is True

    assert len(events) == 1
    payload = events[0]["payload"]
    assert events[0]["type"] == "agent_msg.deliver"
    assert payload["target_pane_id"] == "p3"
    assert payload["from_display"] == "alpha/claude-1"
    assert payload["content"] == "run the tests"
    assert payload["msg_key"] == "k1"


@pytest.mark.asyncio
async def test_route_handler_reports_unresolved_without_broadcasting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_two_workspaces()
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "d2",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": "gamma/reviewer",
            "content": "hi",
            "msg_key": "k2",
        },
    })
    await asyncio.sleep(0)

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is False
    assert "unknown workspace" in resp["payload"]["error"]
    assert events == []


@pytest.mark.asyncio
async def test_route_handler_refuses_self_send(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_two_workspaces()
    monkeypatch.setattr(app, "broadcast", lambda *a, **k: asyncio.sleep(0))
    session = _session()
    await app.handle_message(session, {
        "id": "d3",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": "alpha/claude-1",
            "content": "hi",
            "msg_key": "k3",
        },
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is False
    assert "same pane" in resp["payload"]["error"]


@pytest.mark.asyncio
async def test_delivered_handler_broadcasts_result_to_every_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Including the reporter — a qualified target can resolve inside the same
    window, and excluding it would strand that message in `queued`."""
    captured: list[tuple[dict[str, Any], Any]] = []

    async def fake_broadcast(event: dict[str, Any], **kwargs: Any) -> None:
        captured.append((event, kwargs.get("exclude")))

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "x1",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": "k1", "ok": True},
    })
    await asyncio.sleep(0)

    event, exclude = captured[0]
    assert event["type"] == "agent_msg.delivery_result"
    assert event["payload"] == {"msg_key": "k1", "ok": True, "reason": ""}
    assert exclude is None


# ── Message-log persistence handlers ───────────────────────────────────────
@pytest.fixture
def message_log(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Swap the app-wide log for one rooted in tmp, like the vault fixture."""
    log = AgentMessageLog(db=Database(tmp_path / "navide.db"))
    monkeypatch.setattr(app, "agent_message_log", log)
    return log


def _log_row(uid: str, created_at: int, **over: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "uid": uid,
        "created_at": created_at,
        "status": "delivered",
        "sender": "alpha/claude-1",
        "recipient": "beta/reviewer",
        "content": f"hello {uid}",
    }
    row.update(over)
    return row


@pytest.mark.asyncio
async def test_log_append_then_snapshot_round_trip(message_log: Any) -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "la1",
        "type": "agent_msg.log_append",
        "payload": {"rows": [_log_row("a:1", 100), _log_row("a:2", 200)]},
    })
    assert session.websocket.sent[0]["payload"] == {"written": 2}  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "ls1",
        "type": "agent_msg.log_snapshot",
        "payload": {},
    })
    rows = session.websocket.sent[1]["payload"]["rows"]  # type: ignore[attr-defined]
    assert [r["uid"] for r in rows] == ["a:1", "a:2"]


@pytest.mark.asyncio
async def test_log_snapshot_clamps_the_limit(message_log: Any) -> None:
    message_log.append([_log_row(f"a:{i}", i) for i in range(1, 4)])
    session = _session()
    await app.handle_message(session, {
        "id": "ls2",
        "type": "agent_msg.log_snapshot",
        "payload": {"limit": 9000},
    })
    assert len(session.websocket.sent[0]["payload"]["rows"]) == 3  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "ls3",
        "type": "agent_msg.log_snapshot",
        "payload": {"limit": 0},
    })
    rows = session.websocket.sent[1]["payload"]["rows"]  # type: ignore[attr-defined]
    assert [r["uid"] for r in rows] == ["a:3"]


@pytest.mark.asyncio
async def test_log_update_handler_patches_status(message_log: Any) -> None:
    message_log.append([_log_row("a:1", 100, status="queued")])
    session = _session()
    await app.handle_message(session, {
        "id": "lu1",
        "type": "agent_msg.log_update",
        "payload": {
            "updates": [
                {"uid": "a:1", "status": "delivered", "delivered_at": 900},
                {"uid": "unknown:1", "status": "failed"},
            ]
        },
    })
    assert session.websocket.sent[0]["payload"] == {"updated": 1}  # type: ignore[attr-defined]
    assert message_log.tail()[0]["status"] == "delivered"


@pytest.mark.asyncio
async def test_log_clear_handler_keeps_in_flight_messages(message_log: Any) -> None:
    message_log.append([
        _log_row("a:1", 100, status="queued"),
        _log_row("a:2", 200, status="delivered"),
    ])
    session = _session()
    await app.handle_message(session, {
        "id": "lc1",
        "type": "agent_msg.log_clear",
        "payload": {},
    })
    assert session.websocket.sent[0]["payload"] == {"deleted": 1}  # type: ignore[attr-defined]
    assert [r["uid"] for r in message_log.tail()] == ["a:1"]


@pytest.mark.asyncio
async def test_log_clear_handler_honors_explicit_keep_statuses(message_log: Any) -> None:
    message_log.append([
        _log_row("a:1", 100, status="queued"),
        _log_row("a:2", 200, status="failed"),
    ])
    session = _session()
    await app.handle_message(session, {
        "id": "lc2",
        "type": "agent_msg.log_clear",
        "payload": {"keep_statuses": ["failed"]},
    })
    assert session.websocket.sent[0]["payload"] == {"deleted": 1}  # type: ignore[attr-defined]
    assert [r["uid"] for r in message_log.tail()] == ["a:2"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("msg_type", "payload"),
    [
        ("agent_msg.log_append", {"rows": "not a list"}),
        ("agent_msg.log_update", {}),
        ("agent_msg.log_clear", {"keep_statuses": "delivered"}),
        ("agent_msg.log_snapshot", {"limit": None}),
        ("agent_msg.log_snapshot", {"limit": "abc"}),
        ("agent_msg.log_snapshot", {"limit": float("inf")}),
    ],
)
async def test_log_handlers_answer_bad_request_for_malformed_payloads(
    message_log: Any, msg_type: str, payload: dict[str, Any]
) -> None:
    session = _session()
    await app.handle_message(session, {"id": "lm1", "type": msg_type, "payload": payload})
    frame = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert frame["ok"] is False
    assert frame["error"]["code"] == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_log_handlers_never_broadcast(
    message_log: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Per-window queries: unlike route/delivered, nothing fans out."""
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    for msg_id, msg_type, payload in (
        ("nb1", "agent_msg.log_append", {"rows": [_log_row("a:1", 100)]}),
        ("nb2", "agent_msg.log_update", {"updates": [{"uid": "a:1", "status": "failed"}]}),
        ("nb3", "agent_msg.log_snapshot", {}),
        ("nb4", "agent_msg.log_clear", {}),
    ):
        await app.handle_message(session, {"id": msg_id, "type": msg_type, "payload": payload})
    await asyncio.sleep(0)

    assert all(frame["ok"] is True for frame in session.websocket.sent)  # type: ignore[attr-defined]
    assert events == []


def test_handlers_are_registered() -> None:
    for msg_type in (
        "agent_msg.register",
        "agent_msg.unregister",
        "agent_msg.list",
        "agent_msg.route",
        "agent_msg.delivered",
        "agent_msg.log_snapshot",
        "agent_msg.log_append",
        "agent_msg.log_update",
        "agent_msg.log_clear",
    ):
        assert ws_handlers.lookup(msg_type) is not None
