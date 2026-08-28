"""external_access.get / .set / .regenerate: the Settings UI's WS face of
plan_mcp_auth (the /plan-mcp external-client credential store)."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.mcp_server import auth as plan_mcp_auth, wiring as plan_mcp_wiring


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_get_reports_the_current_config() -> None:
    session = _session()
    await app.handle_message(
        session, {"id": "g1", "type": "external_access.get", "payload": {}}
    )
    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["enabled"] is False
    assert payload["token"] == plan_mcp_auth.external_token()
    assert payload["port"] == (plan_mcp_wiring.backend_port() or 0)


@pytest.mark.asyncio
async def test_set_persists_the_enabled_flag_and_echoes_it_back() -> None:
    session = _session()
    await app.handle_message(
        session, {"id": "s1", "type": "external_access.set", "payload": {"enabled": True}}
    )
    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["enabled"] is True
    assert plan_mcp_auth.external_enabled() is True

    session2 = _session()
    await app.handle_message(
        session2, {"id": "s2", "type": "external_access.set", "payload": {"enabled": False}}
    )
    assert session2.websocket.sent[0]["payload"]["enabled"] is False  # type: ignore[attr-defined]
    assert plan_mcp_auth.external_enabled() is False


@pytest.mark.asyncio
async def test_regenerate_mints_a_new_token() -> None:
    before = plan_mcp_auth.external_token()
    session = _session()
    await app.handle_message(
        session, {"id": "r1", "type": "external_access.regenerate", "payload": {}}
    )
    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["token"] != before
    assert plan_mcp_auth.external_token() == payload["token"]
