"""End-to-end cross-workspace messaging over two simulated renderer windows.

Exercises the real broadcast fan-out (not a monkeypatched one) so the full loop
is covered: window A registers a pane, window B registers a pane in another
workspace, A routes a message, both windows see the deliver event, B reports the
outcome, and only A sees the delivery result.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app


@pytest.fixture(autouse=True)
def _clean_state() -> Any:
    agent_messaging._reset_for_test()
    app._SESSIONS.clear()
    yield
    agent_messaging._reset_for_test()
    app._SESSIONS.clear()


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _window() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    app._SESSIONS.add(session)
    return session


def _events(session: app.Session, event_type: str) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = session.websocket.sent  # type: ignore[attr-defined]
    return [m for m in sent if m.get("type") == event_type]


@pytest.mark.asyncio
async def test_full_cross_workspace_round_trip() -> None:
    window_a = _window()
    window_b = _window()

    await app.handle_message(window_a, {
        "id": "1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "pa",
            "name": "sender",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
        },
    })
    await app.handle_message(window_b, {
        "id": "2",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "pb",
            "name": "reviewer",
            "workspace_path": "/ws/beta",
            "agent_key": "codex",
        },
    })

    await app.handle_message(window_a, {
        "id": "3",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "pa",
            "to": "beta/reviewer",
            "content": "please run pnpm test:run",
            "msg_key": "pa:1",
        },
    })
    await asyncio.sleep(0)

    # Every window receives the broadcast; the frontend filters on target_pane_id.
    for window in (window_a, window_b):
        delivered = _events(window, "agent_msg.deliver")
        assert len(delivered) == 1
        payload = delivered[0]["payload"]
        assert payload["target_pane_id"] == "pb"
        assert payload["from_display"] == "alpha/sender"
        assert payload["cross_workspace"] is True
        assert payload["content"] == "please run pnpm test:run"

    # Window B injected it and reports back.
    await app.handle_message(window_b, {
        "id": "4",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": "pa:1", "ok": True},
    })
    await asyncio.sleep(0)

    assert len(_events(window_a, "agent_msg.delivery_result")) == 1
    assert _events(window_a, "agent_msg.delivery_result")[0]["payload"]["ok"] is True


@pytest.mark.asyncio
async def test_closing_a_window_removes_its_targets() -> None:
    window_a = _window()
    window_b = _window()

    await app.handle_message(window_b, {
        "id": "1",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pb", "name": "reviewer", "workspace_path": "/ws/beta"},
    })
    await app.handle_message(window_a, {
        "id": "2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pa", "name": "sender", "workspace_path": "/ws/alpha"},
    })

    # Window B goes away (what the /ws finally block does on disconnect).
    agent_messaging.drop_owner(window_b)

    await app.handle_message(window_a, {
        "id": "3",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "pa",
            "to": "beta/reviewer",
            "content": "hi",
            "msg_key": "pa:1",
        },
    })
    await asyncio.sleep(0)

    resp = [m for m in window_a.websocket.sent if m.get("id") == "3"][0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is False
    assert "unknown workspace" in resp["payload"]["error"]
    assert _events(window_a, "agent_msg.deliver") == []


@pytest.mark.asyncio
async def test_same_workspace_target_is_not_flagged_cross_workspace() -> None:
    window = _window()
    for pane_id, name in (("p1", "a"), ("p2", "b")):
        await app.handle_message(window, {
            "id": f"reg-{pane_id}",
            "type": "agent_msg.register",
            "payload": {"pane_id": pane_id, "name": name, "workspace_path": "/ws/alpha"},
        })

    await app.handle_message(window, {
        "id": "r",
        "type": "agent_msg.route",
        "payload": {"from_pane_id": "p1", "to": "alpha/b", "content": "hi", "msg_key": "k"},
    })
    await asyncio.sleep(0)

    payload = _events(window, "agent_msg.deliver")[0]["payload"]
    assert payload["cross_workspace"] is False
    assert payload["target_pane_id"] == "p2"


@pytest.mark.asyncio
async def test_single_window_qualified_target_gets_its_own_delivery_result() -> None:
    """A `<own folder>/<pane>` address resolves inside the sending window, so the
    reporter and the sender are the same connection."""
    window = _window()
    for pane_id, name in (("p1", "a"), ("p2", "b")):
        await app.handle_message(window, {
            "id": f"reg-{pane_id}",
            "type": "agent_msg.register",
            "payload": {"pane_id": pane_id, "name": name, "workspace_path": "/ws/alpha"},
        })

    await app.handle_message(window, {
        "id": "r",
        "type": "agent_msg.route",
        "payload": {"from_pane_id": "p1", "to": "alpha/b", "content": "hi", "msg_key": "p1:1"},
    })
    await asyncio.sleep(0)
    await app.handle_message(window, {
        "id": "d",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": "p1:1", "ok": True},
    })
    await asyncio.sleep(0)

    results = _events(window, "agent_msg.delivery_result")
    assert len(results) == 1
    assert results[0]["payload"] == {"msg_key": "p1:1", "ok": True, "reason": ""}


@pytest.mark.asyncio
async def test_detach_race_keeps_the_pane_addressable() -> None:
    """Detaching a pane to another window re-registers it there before the parent
    window unregisters it; the late unregister must not delete the new claim."""
    parent = _window()
    child = _window()

    await app.handle_message(parent, {
        "id": "1",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pd", "name": "worker", "workspace_path": "/ws/alpha"},
    })
    # Child window claims the same pane id (detach handoff).
    await app.handle_message(child, {
        "id": "2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pd", "name": "worker", "workspace_path": "/ws/alpha"},
    })
    # Parent's unregister arrives afterwards.
    await app.handle_message(parent, {
        "id": "3",
        "type": "agent_msg.unregister",
        "payload": {"pane_id": "pd"},
    })

    resp = [m for m in parent.websocket.sent if m.get("id") == "3"][0]  # type: ignore[attr-defined]
    assert resp["payload"]["removed"] is False
    assert agent_messaging.get("pd") is not None


@pytest.mark.asyncio
async def test_registry_survives_a_rename_and_readdresses() -> None:
    window = _window()
    await app.handle_message(window, {
        "id": "1",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pb", "name": "reviewer", "workspace_path": "/ws/beta"},
    })
    await app.handle_message(window, {
        "id": "2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pb", "name": "qa", "workspace_path": "/ws/beta"},
    })
    await app.handle_message(window, {
        "id": "3",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pa", "name": "sender", "workspace_path": "/ws/alpha"},
    })

    stale = agent_messaging.resolve("pa", "beta/reviewer")
    fresh = agent_messaging.resolve("pa", "beta/qa")
    assert stale.pane is None
    assert fresh.pane is not None and fresh.pane.pane_id == "pb"
