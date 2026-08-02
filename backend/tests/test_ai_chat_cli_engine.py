"""Tests for ai_chat_cli_engine — run_cli_text without a real CLI."""

from __future__ import annotations

import asyncio
import os
from typing import Any

import pytest

from agent_team_backend import ai_chat_cli_engine as eng


# ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeTextProc:
    def __init__(self, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0) -> None:
        self._stdout = stdout
        self._stderr = stderr
        self.returncode = returncode
        self.killed = False

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, self._stderr

    def kill(self) -> None:
        self.killed = True


def _spawner(monkeypatch: pytest.MonkeyPatch, procs: list[Any]) -> list[list[str]]:
    """Patch subprocess creation; returns the list of captured argv lists."""
    calls: list[list[str]] = []
    queue = list(procs)

    async def fake_exec(*args: str, **kwargs: Any) -> Any:
        calls.append(list(args))
        return queue.pop(0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return calls


@pytest.fixture(autouse=True)
def _fake_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(eng, "resolve_cli_binary", lambda engine="claude": "/fake/claude")


@pytest.fixture(autouse=True)
def killpg_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, int]]:
    """Never let _terminate_proc_tree touch real process groups in tests.

    getpgid raises by default (→ per-proc terminate()/kill() fallback);
    killpg records instead of signalling. Tests that want the killpg path
    override getpgid and read the recorded calls.
    """
    calls: list[tuple[int, int]] = []

    def fake_getpgid(pid: int) -> int:
        raise ProcessLookupError(pid)

    monkeypatch.setattr(os, "getpgid", fake_getpgid)
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: calls.append((pgid, sig)))
    return calls


# ── run_cli_text ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_cli_text_returns_stdout(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _spawner(monkeypatch, [FakeTextProc(stdout=b"plain answer\n")])

    result = await eng.run_cli_text("question", system_prompt="sys")

    assert result == "plain answer"
    args = calls[0]
    assert args[args.index("-p") + 1] == "question"
    assert "--output-format" in args and "text" in args
    assert "--append-system-prompt" in args and "sys" in args


@pytest.mark.asyncio
async def test_run_cli_text_raises_on_nonzero_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    _spawner(monkeypatch, [FakeTextProc(stderr=b"broken pipes", returncode=2)])

    with pytest.raises(RuntimeError, match="broken pipes"):
        await eng.run_cli_text("question")


@pytest.mark.asyncio
async def test_run_cli_text_raises_when_binary_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(eng, "resolve_cli_binary", lambda engine="claude": "")

    with pytest.raises(RuntimeError, match="not found"):
        await eng.run_cli_text("question")
