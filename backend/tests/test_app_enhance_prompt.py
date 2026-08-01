from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend import ai_chat_cli_engine


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def _no_path_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    async def noop(agent_key: str) -> None:
        return None

    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", noop)


def _fake_run_cli_text(captured: list[dict[str, Any]], result: str):
    async def fake_run_cli_text(prompt: str, **kwargs: Any) -> str:
        captured.append({"prompt": prompt, **kwargs})
        return result

    return fake_run_cli_text


@pytest.mark.asyncio
async def test_enhance_prompt_happy_path_returns_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict[str, Any]] = []
    monkeypatch.setattr(
        ai_chat_cli_engine, "run_cli_text",
        _fake_run_cli_text(captured, "Enhanced prompt text"),
    )
    session = _session()

    await app.handle_message(session, {
        "id": "ep-1",
        "type": "ai.enhance_prompt",
        "payload": {"prompt": "make this better", "system": "You enhance prompts."},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["type"] == "ai.enhance_prompt.result"
    assert response["ok"] is True
    assert response["payload"] == {"ok": True, "content": "Enhanced prompt text"}
    assert captured[0]["prompt"] == "make this better"
    assert captured[0]["system_prompt"] == "You enhance prompts."


@pytest.mark.asyncio
async def test_enhance_prompt_missing_prompt_is_bad_request() -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "ep-2",
        "type": "ai.enhance_prompt",
        "payload": {"prompt": "   "},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["error"]["code"] == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_enhance_prompt_cli_failure_returns_ok_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def failing_run_cli_text(prompt: str, **kwargs: Any) -> str:
        raise RuntimeError("claude CLI not found")

    monkeypatch.setattr(ai_chat_cli_engine, "run_cli_text", failing_run_cli_text)
    session = _session()

    await app.handle_message(session, {
        "id": "ep-3",
        "type": "ai.enhance_prompt",
        "payload": {"prompt": "hello"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["payload"]["ok"] is False
    assert "not found" in response["payload"]["error"]
