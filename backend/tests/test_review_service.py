"""Tests for review_service.py — stream_review behaviour without real CLI calls."""
from __future__ import annotations

import re
from typing import Any

import pytest

from agent_team_backend import review_service
from agent_team_backend import ai_chat_cli_engine


def _extract_review_json(text: str):
    """Mirror the extraction logic used in ws_handlers _run_review."""
    import json as _json
    mo = re.search(r"```json\s*", text)
    if not mo:
        return None
    try:
        raw, _ = _json.JSONDecoder().raw_decode(text[mo.end():].lstrip())
        return raw
    except _json.JSONDecodeError:
        return None


class TestReviewJsonExtraction:
    """Verify the raw_decode extraction used in ws_handlers _run_review."""

    def test_extracts_json_from_clean_block(self):
        text = '```json\n{"summary":"ok","findings":[],"verdict":"approve"}\n```'
        raw = _extract_review_json(text)
        assert raw is not None
        assert raw["summary"] == "ok"

    def test_picks_first_block_with_two_json_blocks(self):
        """With two ```json blocks, raw_decode stops at the first closing brace."""
        first = '{"summary":"first","findings":[],"verdict":"approve"}'
        second = '{"summary":"second","findings":[],"verdict":"request_changes"}'
        text = f"```json\n{first}\n```\n\nsome text\n\n```json\n{second}\n```"
        raw = _extract_review_json(text)
        assert raw is not None
        assert raw["summary"] == "first"

    def test_handles_embedded_code_fence_in_body(self):
        """Body fields containing ```fences``` must not truncate the JSON."""
        body_with_fence = "Fix this:\\n```python\\nx = 1\\n```"
        text = f'```json\n{{"summary":"ok","findings":[{{"body":"{body_with_fence}"}}],"verdict":"approve"}}\n```'
        raw = _extract_review_json(text)
        assert raw is not None
        assert raw["summary"] == "ok"
        assert len(raw["findings"]) == 1

    def test_no_match_without_block(self):
        text = '{"summary":"bare","findings":[],"verdict":"approve"}'
        assert _extract_review_json(text) is None


async def _collect(ait) -> str:
    chunks = []
    async for chunk in ait:
        chunks.append(chunk)
    return "".join(chunks)


def _capture_cli(monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any],
                 result: str = "review chunk") -> None:
    async def fake_run_cli_text(prompt: str, **kwargs: Any) -> str:
        captured["prompt"] = prompt
        captured.update(kwargs)
        return result

    monkeypatch.setattr(ai_chat_cli_engine, "run_cli_text", fake_run_cli_text)


class TestStreamReview:
    @pytest.mark.asyncio
    async def test_empty_diff_yields_no_changes_message(self):
        result = await _collect(review_service.stream_review(""))
        assert "no changes" in result.lower()

    @pytest.mark.asyncio
    async def test_whitespace_only_diff_is_treated_as_empty(self):
        result = await _collect(review_service.stream_review("   \n\t  "))
        assert "no changes" in result.lower()

    @pytest.mark.asyncio
    async def test_diff_forwarded_to_cli(self, monkeypatch):
        captured: dict[str, Any] = {}
        _capture_cli(monkeypatch, captured)

        diff = "diff --git a/foo.py b/foo.py\n+print('hello')\n"
        result = await _collect(
            review_service.stream_review(diff, workspace_path="/ws")
        )
        assert result == "review chunk"
        assert "foo.py" in captured["prompt"]
        assert captured["system_prompt"] == review_service.REVIEW_SYSTEM_PROMPT
        assert captured["workspace_path"] == "/ws"

    @pytest.mark.asyncio
    async def test_diff_truncated_in_prompt(self, monkeypatch):
        captured: dict[str, Any] = {}
        _capture_cli(monkeypatch, captured, result="ok")

        # Diff longer than _MAX_REVIEW_DIFF_CHARS
        big_diff = "+" + "x" * (review_service._MAX_REVIEW_DIFF_CHARS + 5_000)
        await _collect(review_service.stream_review(big_diff))
        # Prompt should contain the truncation note
        assert "truncated" in captured["prompt"]
        # Actual diff in prompt is capped
        assert len(captured["prompt"]) < len(big_diff)

    @pytest.mark.asyncio
    async def test_system_prompt_mentions_senior_engineer(self):
        assert "senior software engineer" in review_service.REVIEW_SYSTEM_PROMPT.lower()

    @pytest.mark.asyncio
    async def test_system_prompt_covers_security(self):
        assert "security" in review_service.REVIEW_SYSTEM_PROMPT.lower()

    @pytest.mark.asyncio
    async def test_truncated_flag_adds_note_for_short_diff(self, monkeypatch):
        """truncated=True must inject the truncation note even when diff is short."""
        captured: dict[str, Any] = {}
        _capture_cli(monkeypatch, captured, result="ok")

        short_diff = "+print('hello')\n"  # well under _MAX_REVIEW_DIFF_CHARS
        await _collect(review_service.stream_review(short_diff, truncated=True))
        assert "truncated" in captured["prompt"]

    @pytest.mark.asyncio
    async def test_no_truncation_note_without_flag_or_long_diff(self, monkeypatch):
        """Short diff without truncated=True must NOT include truncation note."""
        captured: dict[str, Any] = {}
        _capture_cli(monkeypatch, captured, result="ok")

        short_diff = "+print('hello')\n"
        await _collect(review_service.stream_review(short_diff, truncated=False))
        assert "truncated" not in captured["prompt"]
