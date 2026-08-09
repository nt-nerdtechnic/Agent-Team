"""Tests for the LLM pane-namer.

The service is a best-effort upgrade over a title the renderer has already
applied, so the behaviour that matters most here is that every failure path
stays quiet and structured — an exception escaping would turn a cosmetic miss
into a dropped WS message.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import pane_name_prompt, pane_name_service


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    """Stands in for httpx.AsyncClient, mirroring test_git_service.py."""

    captured: dict[str, Any] = {}
    response: dict[str, Any] = {"response": "```text\nFix login redirect\n```"}
    raises: Exception | None = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        _FakeClient.captured["init"] = kwargs

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *args: Any) -> bool:
        return False

    async def post(self, url: str, json: dict[str, Any]) -> _FakeResponse:
        _FakeClient.captured["url"] = url
        _FakeClient.captured["body"] = json
        if _FakeClient.raises is not None:
            raise _FakeClient.raises
        return _FakeResponse(_FakeClient.response)


@pytest.fixture(autouse=True)
def _reset(monkeypatch) -> None:
    _FakeClient.captured = {}
    _FakeClient.response = {"response": "```text\nFix login redirect\n```"}
    _FakeClient.raises = None
    # Cooldown is module state shared across calls; a failure test would
    # otherwise silently short-circuit the tests that follow it.
    pane_name_service._cooldown.reset()
    monkeypatch.setattr(pane_name_service.httpx, "AsyncClient", _FakeClient)


async def test_generates_a_title_from_material() -> None:
    result = await pane_name_service.generate_pane_name(
        "Please fix the login redirect loop", "http://localhost:11434", "qwen2:latest"
    )
    assert result == {"ok": True, "name": "Fix login redirect"}

    body = _FakeClient.captured["body"]
    assert body["model"] == "qwen2:latest"
    assert body["stream"] is False
    assert "Fix the login redirect loop" not in body["prompt"]  # material, verbatim
    assert "Please fix the login redirect loop" in body["prompt"]
    assert body["system"] == pane_name_prompt.SYSTEM_PROMPT
    assert _FakeClient.captured["url"] == "/api/generate"


async def test_empty_material_never_calls_the_model() -> None:
    result = await pane_name_service.generate_pane_name(
        "   ", "http://localhost:11434", "qwen2:latest"
    )
    assert result["ok"] is False
    assert "body" not in _FakeClient.captured


async def test_transport_failure_returns_structured_error() -> None:
    _FakeClient.raises = RuntimeError("connection refused")
    result = await pane_name_service.generate_pane_name(
        "fix the bug", "http://localhost:11434", "qwen2:latest"
    )
    assert result["ok"] is False
    assert result["name"] == ""
    assert "connection refused" in result["error"]


async def test_unusable_answer_is_rejected_without_blaming_the_backend() -> None:
    """A refusal means "no title", not "backend down" — it must not count
    toward the cooldown, or a few vague prompts would disable naming."""
    _FakeClient.response = {"response": "```text\nUNCLEAR\n```"}
    for _ in range(pane_name_service._FAILURES_BEFORE_COOLDOWN + 1):
        result = await pane_name_service.generate_pane_name(
            "hmm", "http://localhost:11434", "qwen2:latest"
        )
        assert result["ok"] is False
    assert pane_name_service._cooldown.blocked() is False


async def test_repeated_transport_failure_trips_the_cooldown() -> None:
    _FakeClient.raises = RuntimeError("connection refused")
    for _ in range(pane_name_service._FAILURES_BEFORE_COOLDOWN):
        await pane_name_service.generate_pane_name(
            "fix the bug", "http://localhost:11434", "qwen2:latest"
        )
    assert pane_name_service._cooldown.blocked() is True

    # While cooling down the model is not called at all.
    _FakeClient.captured = {}
    result = await pane_name_service.generate_pane_name(
        "fix the bug", "http://localhost:11434", "qwen2:latest"
    )
    assert result["ok"] is False
    assert result["error"] == "cooling down"
    assert "body" not in _FakeClient.captured


async def test_success_resets_the_failure_count() -> None:
    _FakeClient.raises = RuntimeError("connection refused")
    for _ in range(pane_name_service._FAILURES_BEFORE_COOLDOWN - 1):
        await pane_name_service.generate_pane_name(
            "fix the bug", "http://localhost:11434", "qwen2:latest"
        )
    _FakeClient.raises = None
    assert (await pane_name_service.generate_pane_name(
        "fix the bug", "http://localhost:11434", "qwen2:latest"
    ))["ok"] is True

    # One more failure must not trip a cooldown that the success cleared.
    _FakeClient.raises = RuntimeError("connection refused")
    await pane_name_service.generate_pane_name(
        "fix the bug", "http://localhost:11434", "qwen2:latest"
    )
    assert pane_name_service._cooldown.blocked() is False


class TestParseTitle:
    def test_extracts_from_a_text_fence(self) -> None:
        assert pane_name_prompt.parse_title("```text\nAdd dark mode\n```") == "Add dark mode"

    def test_accepts_a_bare_answer_without_a_fence(self) -> None:
        assert pane_name_prompt.parse_title("Add dark mode") == "Add dark mode"

    def test_takes_the_first_line_when_the_model_explains_itself(self) -> None:
        raw = "```text\nAdd dark mode\n\nI chose this because it is short.\n```"
        assert pane_name_prompt.parse_title(raw) == "Add dark mode"

    def test_strips_wrapping_quotes_and_trailing_punctuation(self) -> None:
        assert pane_name_prompt.parse_title('"Add dark mode."') == "Add dark mode"
        assert pane_name_prompt.parse_title("修復登入導向。") == "修復登入導向"

    def test_refusal_and_empty_answers_yield_nothing(self) -> None:
        assert pane_name_prompt.parse_title("```text\nUNCLEAR\n```") == ""
        assert pane_name_prompt.parse_title("unclear") == ""
        assert pane_name_prompt.parse_title("") == ""
        assert pane_name_prompt.parse_title("```text\n\n```") == ""

    def test_caps_length(self) -> None:
        raw = "x" * 200
        assert len(pane_name_prompt.parse_title(raw)) == pane_name_prompt.MAX_TITLE_CHARS


def test_build_user_prompt_caps_material() -> None:
    prompt = pane_name_prompt.build_user_prompt("y" * 5000)
    assert prompt.startswith("# INSTRUCTION:\n")
    assert len(prompt) <= pane_name_prompt.MAX_MATERIAL_CHARS + len("# INSTRUCTION:\n")
