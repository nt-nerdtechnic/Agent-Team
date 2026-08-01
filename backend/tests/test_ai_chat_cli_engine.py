"""Tests for ai_chat_cli_engine — stream-json translation without a real CLI."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import ai_chat_cli_engine as eng


# ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeStream:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)

    async def readline(self) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""

    async def read(self) -> bytes:
        data = b"".join(self._chunks)
        self._chunks = []
        return data


class BlockingStream:
    """readline() never returns — used to test kill-on-cancel."""

    async def readline(self) -> bytes:
        await asyncio.Event().wait()
        return b""

    async def read(self) -> bytes:
        await asyncio.Event().wait()
        return b""


class FakeProc:
    def __init__(self, stdout_lines: list[bytes], stderr: bytes = b"",
                 returncode: int = 0, blocking: bool = False) -> None:
        self.stdout: Any = BlockingStream() if blocking else FakeStream(stdout_lines)
        self.stderr: Any = FakeStream([stderr])
        self.returncode = returncode
        self.killed = False

    async def wait(self) -> int:
        return self.returncode

    def kill(self) -> None:
        self.killed = True


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


def _collector() -> tuple[list[tuple[str, dict]], Any]:
    events: list[tuple[str, dict]] = []

    async def emit(event_type: str, data: dict) -> None:
        events.append((event_type, data))

    return events, emit


def _line(obj: dict) -> bytes:
    return json.dumps(obj).encode() + b"\n"


_INIT = _line({"type": "system", "subtype": "init", "session_id": "cli-sid-1"})
_RESULT_OK = _line({
    "type": "result", "subtype": "success", "is_error": False,
    "session_id": "cli-sid-1",
    "usage": {
        "input_tokens": 2,
        "cache_creation_input_tokens": 100,
        "cache_read_input_tokens": 300,
        "output_tokens": 40,
    },
    "modelUsage": {"claude-opus-5": {}},
    "result": "done",
})


@pytest.fixture(autouse=True)
def _fake_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(eng, "resolve_cli_binary", lambda engine="claude": "/fake/claude")


# ── run_cli_chat: translation ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_translates_stream_json_to_events(monkeypatch: pytest.MonkeyPatch) -> None:
    lines = [
        _INIT,
        _line({"type": "assistant", "session_id": "cli-sid-1", "message": {
            "model": "claude-opus-5",
            "content": [
                {"type": "thinking", "thinking": "pondering"},
                {"type": "text", "text": "hello"},
                {"type": "tool_use", "id": "t1", "name": "Write",
                 "input": {"file_path": "a.txt"}},
            ],
        }}),
        _line({"type": "rate_limit_event", "rate_limit_info": {}}),
        _line({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "File created"},
        ]}}),
        _RESULT_OK,
    ]
    calls = _spawner(monkeypatch, [FakeProc(lines)])
    events, emit = _collector()

    await eng.run_cli_chat(
        session_id="s1",
        messages=[{"role": "user", "content": "hi"}],
        workspace_path="",
        system_prompt="extra rules",
        cli_session_id="",
        emit=emit,
    )

    assert [e[0] for e in events] == [
        "ai.chat.chunk", "ai.chat.chunk", "ai.chat.tool_call",
        "ai.chat.tool_result", "ai.chat.done",
    ]
    thinking, text = events[0][1], events[1][1]
    assert thinking["text"] == "\x00THINKING:pondering"
    assert text == {"session_id": "s1", "text": "hello"}
    assert events[2][1] == {
        "session_id": "s1", "tool_name": "Write",
        "tool_input": {"file_path": "a.txt"}, "tool_id": "t1",
    }
    assert events[3][1] == {
        "session_id": "s1", "tool_id": "t1", "tool_name": "Write",
        "result": "File created",
    }
    done = events[4][1]
    assert done["model"] == "claude-opus-5"
    assert done["input_tokens"] == 2 + 100 + 300
    assert done["output_tokens"] == 40
    assert done["cli_session_id"] == "cli-sid-1"

    args = calls[0]
    assert args[0] == "/fake/claude"
    assert args[1:3] == ["-p", "hi"]
    assert "--output-format" in args and "stream-json" in args
    assert "--permission-mode" in args and "acceptEdits" in args
    assert "--append-system-prompt" in args and "extra rules" in args
    assert "--resume" not in args


# ── run_cli_chat: resume handling ────────────────────────────────────────────

def _patch_session_file(monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
    from agent_team_backend import app

    monkeypatch.setattr(app, "_claude_session_file", lambda ws, sid: path)


_HISTORY = [
    {"role": "user", "content": "first question"},
    {"role": "assistant", "content": "first answer"},
    {"role": "user", "content": "second question"},
]


@pytest.mark.asyncio
async def test_resume_sends_only_last_user_message(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    session_file = tmp_path / "cli-sid-1.jsonl"
    session_file.write_text("{}", encoding="utf-8")
    _patch_session_file(monkeypatch, session_file)
    calls = _spawner(monkeypatch, [FakeProc([_INIT, _RESULT_OK])])
    events, emit = _collector()

    await eng.run_cli_chat(
        session_id="s1", messages=_HISTORY, workspace_path=str(tmp_path),
        cli_session_id="cli-sid-1", emit=emit,
    )

    args = calls[0]
    assert args[args.index("--resume") + 1] == "cli-sid-1"
    assert args[args.index("-p") + 1] == "second question"
    assert events[-1][0] == "ai.chat.done"


@pytest.mark.asyncio
async def test_missing_session_file_falls_back_to_full_history(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _patch_session_file(monkeypatch, tmp_path / "gone.jsonl")
    calls = _spawner(monkeypatch, [FakeProc([_INIT, _RESULT_OK])])
    events, emit = _collector()

    await eng.run_cli_chat(
        session_id="s1", messages=_HISTORY, workspace_path=str(tmp_path),
        cli_session_id="cli-sid-1", emit=emit,
    )

    args = calls[0]
    assert "--resume" not in args
    prompt = args[args.index("-p") + 1]
    assert "first question" in prompt
    assert "Assistant: first answer" in prompt
    assert prompt.rstrip().endswith("second question")
    assert events[-1][0] == "ai.chat.done"


@pytest.mark.asyncio
async def test_resume_lost_at_runtime_retries_fresh(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    session_file = tmp_path / "cli-sid-1.jsonl"
    session_file.write_text("{}", encoding="utf-8")
    _patch_session_file(monkeypatch, session_file)
    failed = FakeProc(
        [], stderr=b"No conversation found with session ID: cli-sid-1", returncode=1,
    )
    calls = _spawner(monkeypatch, [failed, FakeProc([_INIT, _RESULT_OK])])
    events, emit = _collector()

    await eng.run_cli_chat(
        session_id="s1", messages=_HISTORY, workspace_path=str(tmp_path),
        cli_session_id="cli-sid-1", emit=emit,
    )

    assert len(calls) == 2
    assert "--resume" in calls[0]
    assert "--resume" not in calls[1]
    assert [e[0] for e in events] == ["ai.chat.done"]


# ── run_cli_chat: errors and stop ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_nonzero_exit_emits_error_with_stderr(monkeypatch: pytest.MonkeyPatch) -> None:
    _spawner(monkeypatch, [FakeProc([], stderr=b"something exploded", returncode=1)])
    events, emit = _collector()

    await eng.run_cli_chat(
        session_id="s1", messages=[{"role": "user", "content": "hi"}],
        workspace_path="", emit=emit,
    )

    assert [e[0] for e in events] == ["ai.chat.error"]
    assert "something exploded" in events[0][1]["message"]


@pytest.mark.asyncio
async def test_missing_binary_emits_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(eng, "resolve_cli_binary", lambda engine="claude": "")
    events, emit = _collector()

    await eng.run_cli_chat(
        session_id="s1", messages=[{"role": "user", "content": "hi"}],
        workspace_path="", emit=emit,
    )

    assert [e[0] for e in events] == ["ai.chat.error"]
    assert "not found" in events[0][1]["message"]


@pytest.mark.asyncio
async def test_cancel_kills_subprocess(monkeypatch: pytest.MonkeyPatch) -> None:
    proc = FakeProc([], blocking=True)
    _spawner(monkeypatch, [proc])
    events, emit = _collector()

    task = asyncio.ensure_future(eng.run_cli_chat(
        session_id="s1", messages=[{"role": "user", "content": "hi"}],
        workspace_path="", emit=emit,
    ))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert proc.killed
    assert events == []


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
