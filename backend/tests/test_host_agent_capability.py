"""Authenticated Host handoff for agent-initiated plugin capabilities."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server.server import _Caller, request_host_agent_capability, request_host_agent_workspace_backend


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_host_register_requires_the_backend_host_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", "host-secret")
    monkeypatch.setenv("NAVIDE_BACKEND_HOST_TOKEN", "wrong-child-visible-token")
    session = _session()

    await app.handle_message(session, {
        "id": "bad-host",
        "type": "host.register",
        "payload": {"token": "wrong"},
    })
    assert session.host_authenticated is False
    assert session.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "good-host",
        "type": "host.register",
        "payload": {"token": "host-secret"},
    })
    assert session.host_authenticated is True
    assert session.websocket.sent[-1]["payload"] == {"registered": True}  # type: ignore[attr-defined]


def test_host_token_matching_uses_the_private_copy_not_child_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", "host-secret")
    monkeypatch.setenv("NAVIDE_BACKEND_HOST_TOKEN", "wrong-child-visible-token")

    assert app.host_session_token_matches("host-secret") is True
    assert app.host_session_token_matches("wrong-child-visible-token") is False


@pytest.mark.asyncio
async def test_unicast_host_skips_unauthenticated_sessions() -> None:
    unauthenticated = _session()
    authenticated = _session()
    authenticated.host_authenticated = True
    previous = set(app._SESSIONS)
    app._SESSIONS.clear()
    app._SESSIONS.update({unauthenticated, authenticated})
    try:
        assert await app.unicast_host({"type": "agent.capability.request"}) is True
        assert unauthenticated.websocket.sent == []  # type: ignore[attr-defined]
        assert authenticated.websocket.sent == [{"type": "agent.capability.request"}]  # type: ignore[attr-defined]
    finally:
        app._SESSIONS.clear()
        app._SESSIONS.update(previous)


@pytest.mark.asyncio
async def test_mcp_handoff_registers_before_host_notification_and_keeps_identity_host_owned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []

    async def fake_unicast_host(event: dict[str, Any]) -> bool:
        events.append(event)
        request = event["payload"]
        assert "initiator" not in request
        assert request["instance_id"] == "view-1"
        assert plan_mcp.resolve_agent_capability(request["request_id"], {"ok": True, "result": "done"})
        return True

    monkeypatch.setattr(app, "unicast_host", fake_unicast_host)
    result = await request_host_agent_capability(
        "view-1",
        "capability",
        {"reqId": "agent-1", "ns": "fs", "method": "readFile", "args": {"path": "a"}},
        caller=_Caller(kind="external"),
    )

    assert result == {"ok": True, "result": "done"}
    assert len(events) == 1
    assert set(events[0]["payload"]) == {"request_id", "instance_id", "operation", "payload"}
    assert plan_mcp._agent_capability_pending.pending == {}


@pytest.mark.parametrize("response", [
    {"ok": True, "result": {"rel_path": ".agent-team/plans/example.html", "name": "Example"}},
    {"ok": False, "error": {"code": "PERMISSION_DENIED", "message": "Agent filesystem access denied"}},
])
async def test_new_core_workspace_handoff_uses_the_single_authenticated_host_channel(
    monkeypatch: pytest.MonkeyPatch, response: dict[str, Any],
) -> None:
    events: list[dict[str, Any]] = []
    call = {"reqId": "plans-1", "name": "plans.read", "args": {"rel_path": ".agent-team/plans/example.html"}}

    async def host_reply(event: dict[str, Any]) -> bool:
        events.append(event)
        payload = event["payload"]
        assert payload["target"] == {"plugin_id": "navide.plans", "workspace_path": "/workspace"}
        assert payload["operation"] == "backend"
        assert payload["payload"] == call
        assert set(payload) == {"request_id", "target", "operation", "payload"}
        assert plan_mcp.resolve_agent_capability(payload["request_id"], response)
        return True

    monkeypatch.setattr(app, "unicast_host", host_reply)
    result = await request_host_agent_workspace_backend(
        "navide.plans", "/workspace", call, caller=_Caller(kind="external"),
    )
    assert result == response
    assert len(events) == 1
    assert plan_mcp._agent_capability_pending.pending == {}


@pytest.mark.asyncio
async def test_agent_capability_result_requires_an_authenticated_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _session()
    resolved: list[tuple[str, dict[str, Any]]] = []

    def resolve(request_id: str, result: dict[str, Any]) -> bool:
        resolved.append((request_id, result))
        return True

    monkeypatch.setattr(plan_mcp, "resolve_agent_capability", resolve)
    await app.handle_message(session, {
        "id": "unauth-result",
        "type": "agent.capability.result",
        "payload": {"request_id": "mcp:1", "response": {"ok": True}},
    })
    assert resolved == []
    assert session.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"  # type: ignore[attr-defined]

    session.host_authenticated = True
    await app.handle_message(session, {
        "id": "extra-result",
        "type": "agent.capability.result",
        "payload": {"request_id": "mcp:1", "response": {"ok": True}, "initiator": "forged"},
    })
    assert resolved == []
    assert session.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "auth-result",
        "type": "agent.capability.result",
        "payload": {"request_id": "mcp:1", "response": {"ok": True}},
    })
    assert resolved == [("mcp:1", {"ok": True})]
    assert session.websocket.sent[-1]["payload"] == {"ok": True, "delivered": True}  # type: ignore[attr-defined]
