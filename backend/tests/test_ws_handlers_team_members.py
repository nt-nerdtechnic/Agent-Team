"""p2p.members.*: the Settings pane's view of team membership.

The link layer is covered in test_server_link.py against the in-process fake
server. These tests own the handler layer: what is allowed onto the wire, how a
server refusal is translated, and the shape the pane is answered with.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, server_link


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


async def _call(session: app.Session, msg_type: str, payload: dict) -> dict:
    await app.handle_message(session, {"id": "x1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


CONNECTED_ADMIN = {
    "state": "connected",
    "role": "admin",
    "memberId": "m-admin",
    "canManage": True,
    "members": [
        {"memberId": "m-admin", "displayName": "Ada", "role": "admin", "disabled": False},
        {"memberId": "m2", "displayName": "Bo", "role": "member", "disabled": False},
    ],
}


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict]]:
    """Record what reached the link, and answer as a connected admin would."""
    recorded: list[tuple[str, dict]] = []

    async def fake_members_request(msg_type: str, payload: dict) -> dict:
        recorded.append((msg_type, payload))
        return {"ok": True, "payload": {"memberId": "m9", "token": "one-time-token"}}

    async def fake_members_state() -> dict:
        return CONNECTED_ADMIN

    monkeypatch.setattr(server_link, "members_request", fake_members_request)
    monkeypatch.setattr(server_link, "members_state", fake_members_state)
    return recorded


# ---- list -------------------------------------------------------------------


async def test_list_answers_the_state_verbatim(calls: list) -> None:
    resp = await _call(_session(), "p2p.members.list", {})
    assert resp["ok"] is True
    assert resp["payload"] == CONNECTED_ADMIN
    # A read must not travel to the server on every poll: the cache is what the
    # pane is shown, refreshed by the push and once per connection.
    assert calls == []


async def test_list_with_no_server_says_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server_link, "_link", None)
    resp = await _call(_session(), "p2p.members.list", {})
    assert resp["payload"]["state"] == "unconfigured"
    assert resp["payload"]["canManage"] is False
    assert resp["payload"]["members"] == []


# ---- invite -----------------------------------------------------------------


async def test_invite_forwards_trimmed_fields_and_returns_the_token(calls: list) -> None:
    resp = await _call(
        _session(),
        "p2p.members.invite",
        {"email": "  bo@example.com ", "displayName": " Bo ", "role": "observer"},
    )
    assert calls == [
        (
            "team.members.invite",
            {"email": "bo@example.com", "displayName": "Bo", "role": "observer"},
        )
    ]
    assert resp["payload"]["result"]["token"] == "one-time-token"
    # The refreshed roster rides along so the pane needs no second request.
    assert resp["payload"]["state"] == CONNECTED_ADMIN


async def test_invite_omits_blank_fields(calls: list) -> None:
    await _call(_session(), "p2p.members.invite", {"email": "", "displayName": "   "})
    assert calls == [("team.members.invite", {})]


async def test_invite_rejects_an_unknown_role(calls: list) -> None:
    resp = await _call(_session(), "p2p.members.invite", {"role": "driver"})
    assert resp["ok"] is False
    assert resp["error"]["code"] == "BAD_REQUEST"
    assert calls == []


async def test_invite_rejects_a_non_string_email(calls: list) -> None:
    resp = await _call(_session(), "p2p.members.invite", {"email": 42})
    assert resp["ok"] is False
    assert resp["error"]["code"] == "BAD_REQUEST"
    assert calls == []


# ---- set_role ---------------------------------------------------------------


async def test_set_role_forwards_the_change(calls: list) -> None:
    resp = await _call(
        _session(), "p2p.members.set_role", {"memberId": " m2 ", "role": "admin"}
    )
    assert calls == [("team.members.set_role", {"memberId": "m2", "role": "admin"})]
    assert resp["ok"] is True


async def test_set_role_requires_a_member_id(calls: list) -> None:
    resp = await _call(_session(), "p2p.members.set_role", {"memberId": "  ", "role": "admin"})
    assert resp["error"]["code"] == "BAD_REQUEST"
    assert calls == []


async def test_set_role_rejects_a_session_role(calls: list) -> None:
    """`driver` is a session role, not a membership one — it must not reach the
    server as if it were."""
    resp = await _call(_session(), "p2p.members.set_role", {"memberId": "m2", "role": "driver"})
    assert resp["error"]["code"] == "BAD_REQUEST"
    assert calls == []


# ---- revoke -----------------------------------------------------------------


async def test_revoke_reports_the_connections_it_dropped(
    monkeypatch: pytest.MonkeyPatch, calls: list
) -> None:
    async def fake_members_request(msg_type: str, payload: dict) -> dict:
        calls.append((msg_type, payload))
        return {
            "ok": True,
            "payload": {"memberId": "m2", "disabled": True, "droppedConnections": 3},
        }

    monkeypatch.setattr(server_link, "members_request", fake_members_request)
    resp = await _call(_session(), "p2p.members.revoke", {"memberId": "m2"})
    assert calls == [("team.members.revoke", {"memberId": "m2"})]
    assert resp["payload"]["result"]["droppedConnections"] == 3


async def test_revoke_requires_a_member_id(calls: list) -> None:
    resp = await _call(_session(), "p2p.members.revoke", {})
    assert resp["error"]["code"] == "BAD_REQUEST"
    assert calls == []


# ---- failure translation ----------------------------------------------------


async def test_write_with_no_server_is_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """None from the link means this machine never had a server — a distinct
    answer from a server that refused, which sends the user somewhere else."""

    async def fake_members_request(msg_type: str, payload: dict) -> None:
        return None

    monkeypatch.setattr(server_link, "members_request", fake_members_request)
    resp = await _call(_session(), "p2p.members.revoke", {"memberId": "m2"})
    assert resp["ok"] is False
    assert resp["error"]["code"] == "P2P_NOT_CONFIGURED"


async def test_server_refusal_reaches_the_pane_intact(monkeypatch: pytest.MonkeyPatch) -> None:
    """A member who tries to invite gets the server's own refusal, not a code
    this side invented — the pane has to be able to say why."""

    async def fake_members_request(msg_type: str, payload: dict) -> dict:
        return {"ok": False, "error": {"code": "FORBIDDEN", "message": "admin only"}}

    monkeypatch.setattr(server_link, "members_request", fake_members_request)
    resp = await _call(_session(), "p2p.members.invite", {})
    assert resp["error"]["code"] == "FORBIDDEN"
    assert resp["error"]["message"] == "admin only"
