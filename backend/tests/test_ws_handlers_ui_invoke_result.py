"""ui.invoke.result handler: forwards a renderer window's reply — including
its optional `warnings` field — to the waiting ui_invoke/ui_snapshot/
ui_list_actions MCP call via plan_mcp.resolve_ui_invoke.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.mcp_server import server as plan_mcp


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_forwards_warnings_when_the_renderer_included_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_resolve(request_id: str, result: dict[str, Any]) -> bool:
        captured["request_id"] = request_id
        captured["result"] = result
        return True

    monkeypatch.setattr(plan_mcp, "resolve_ui_invoke", fake_resolve)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "ui.invoke.result",
        "payload": {
            "request_id": "req-1",
            "ok": True,
            "result": "done",
            "error": None,
            "warnings": ["[inject.resend] content not echoed — resending"],
        },
    })

    assert captured["result"]["warnings"] == ["[inject.resend] content not echoed — resending"]


@pytest.mark.asyncio
async def test_omits_warnings_key_when_the_renderer_sent_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_resolve(request_id: str, result: dict[str, Any]) -> bool:
        captured["result"] = result
        return True

    monkeypatch.setattr(plan_mcp, "resolve_ui_invoke", fake_resolve)
    session = _session()

    await app.handle_message(session, {
        "id": "m2",
        "type": "ui.invoke.result",
        "payload": {"request_id": "req-2", "ok": True, "result": None, "error": None},
    })

    assert "warnings" not in captured["result"]


@pytest.mark.asyncio
async def test_omits_warnings_key_when_the_renderer_sent_an_empty_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty list is falsy in the same sense as absent — no diagnostics
    happened, so the key should not appear at all (mirrors the renderer side,
    which never sends an empty warnings array either)."""
    captured: dict[str, Any] = {}

    def fake_resolve(request_id: str, result: dict[str, Any]) -> bool:
        captured["result"] = result
        return True

    monkeypatch.setattr(plan_mcp, "resolve_ui_invoke", fake_resolve)
    session = _session()

    await app.handle_message(session, {
        "id": "m3",
        "type": "ui.invoke.result",
        "payload": {"request_id": "req-3", "ok": True, "result": None, "error": None, "warnings": []},
    })

    assert "warnings" not in captured["result"]
