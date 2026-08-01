"""CLI-driven AI chat engine.

Runs a headless coding CLI (v1: Claude Code) as a subprocess and translates
its ``--output-format stream-json`` events into the pre-existing ai.chat.*
event stream (``ai.chat.chunk`` / ``tool_call`` / ``tool_result`` / ``done``
/ ``error``), so the frontend consumes the exact same protocol it used with
the removed API engine. The CLI executes tools itself (``--permission-mode
acceptEdits``); the backend no longer runs any tool.

Observed stream-json shapes (spiked against claude CLI 2.1.220, 2026-08-01):

- ``{"type":"system","subtype":"init","session_id":...,...}`` — first event,
  carries the CLI session id (also present on every later event).
- ``{"type":"assistant","message":{"model":...,"content":[{"type":"text"|
  "thinking"|"tool_use",...}]},...}`` — one whole API turn per event (text is
  NOT delta-streamed without --include-partial-messages).
- ``{"type":"user","message":{"content":[{"type":"tool_result",
  "tool_use_id":...,"content":<str|blocks>}]},...}`` — tool results.
- ``{"type":"result","subtype":"success"|"error_*","is_error":bool,
  "usage":{...},"modelUsage":{...},"result":<text>,"errors":[...]}`` — final.
- Other types/subtypes (hook_*, rate_limit_event, ...) are noise — ignored.

Resuming with an unknown session id exits 1 with "No conversation found with
session ID: ..." on stderr; the engine falls back to a fresh session with the
full message history flattened into the prompt.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import signal
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import onboarding_deps

log = logging.getLogger("agent_team_backend.ai_chat_cli_engine")

Emit = Callable[[str, dict], Awaitable[None]]

# A single stream-json line can embed whole file contents (tool inputs and
# results), so the default 64 KB StreamReader limit is far too small.
_STREAM_LINE_LIMIT = 10 * 1024 * 1024
_STDERR_TAIL_CHARS = 1_000
_TEXT_TIMEOUT_DEFAULT = 120.0
# No stdout output for this long means the CLI is wedged — kill it.
_IDLE_TIMEOUT_S = 300.0
# SIGTERM → grace → SIGKILL window for the CLI's process group.
_KILL_GRACE_S = 3.0

# Marker on stderr when --resume points at a session the CLI does not know.
_RESUME_LOST_MARKER = "No conversation found"

# Session ids reach _claude_session_file (a path component) and --resume, so
# only UUID-shaped values are accepted; anything else starts a fresh session.
_SESSION_ID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")

# ── Engine registry ──────────────────────────────────────────────────────────
# v1 registers only Claude Code. Future engines add an entry here; agent_key
# must match onboarding_deps (cli_binary_overrides) and command is the PATH
# executable name.
ENGINES: dict[str, dict[str, str]] = {
    "claude": {"agent_key": "claude", "command": "claude"},
}


def resolve_cli_binary(engine: str = "claude") -> str:
    """Absolute path of the engine CLI ('' when not installed).

    The user's persisted binary choice (onboarding "multiple installs" picker)
    wins over plain PATH lookup — same policy as terminal agent spawns.
    """
    spec = ENGINES.get(engine)
    if spec is None:
        return ""
    override = onboarding_deps.cli_binary_override(spec["agent_key"])
    if override:
        return override
    return shutil.which(spec["command"]) or ""


# ── Prompt assembly ──────────────────────────────────────────────────────────

def _text_of(content: Any) -> str:
    """Plain text from a message content field (string or content blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p)
    return str(content or "")


def _last_user_text(messages: list[dict]) -> str:
    for msg in reversed(messages):
        if isinstance(msg, dict) and msg.get("role") == "user":
            text = _text_of(msg.get("content"))
            if text:
                return text
    return ""


def _flatten_history(messages: list[dict]) -> str:
    """Join the whole conversation into one prompt (fresh-session fallback)."""
    texts: list[tuple[str, str]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        text = _text_of(msg.get("content"))
        if text:
            texts.append((msg.get("role", "user"), text))
    if not texts:
        return ""
    if len(texts) == 1:
        return texts[0][1]
    lines = ["The conversation so far:"]
    for role, text in texts[:-1]:
        label = "Assistant" if role == "assistant" else "User"
        lines.append(f"{label}: {text}")
    lines.append("")
    lines.append(texts[-1][1])
    return "\n\n".join(lines)


def _resume_candidate(workspace_path: str, cli_session_id: str) -> str:
    """cli_session_id when it is UUID-shaped and its transcript exists, else ''."""
    if not cli_session_id:
        return ""
    if not _SESSION_ID_RE.fullmatch(cli_session_id):
        log.warning("rejecting malformed cli_session_id %r", cli_session_id[:80])
        return ""
    if workspace_path:
        from . import app  # lazy: avoid module-level circular import

        if not app._claude_session_file(workspace_path, cli_session_id).is_file():
            return ""
    return cli_session_id


def _tool_result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p)
    if content is None:
        return ""
    try:
        return json.dumps(content)
    except (TypeError, ValueError):
        return str(content)


def _cwd_for(workspace_path: str) -> str | None:
    return workspace_path if workspace_path and Path(workspace_path).is_dir() else None


async def _terminate_proc_tree(proc: Any, grace: float = _KILL_GRACE_S) -> None:
    """SIGTERM the CLI's whole process group, escalate to SIGKILL after *grace*.

    The CLI is spawned with start_new_session=True, so killing its process
    group also takes down running Bash tool commands and MCP servers instead
    of orphaning them (same breakaway-kill policy as PTY terminals).
    """
    pgid: int | None = None
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        pgid = os.getpgid(proc.pid)
    if pgid is not None:
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            os.killpg(pgid, signal.SIGTERM)
    else:
        with contextlib.suppress(ProcessLookupError):
            proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout=grace)
        return
    except asyncio.TimeoutError:
        pass
    if pgid is not None:
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            os.killpg(pgid, signal.SIGKILL)
    with contextlib.suppress(ProcessLookupError):
        proc.kill()
    with contextlib.suppress(Exception):
        await proc.wait()


# ── Chat run ─────────────────────────────────────────────────────────────────

async def run_cli_chat(
    *,
    session_id: str,
    messages: list[dict],
    workspace_path: str,
    system_prompt: str = "",
    cli_session_id: str = "",
    emit: Emit,
    engine: str = "claude",
) -> None:
    """Run one chat turn through the CLI and emit ai.chat.* events.

    ``cli_session_id`` (from a previous turn's done payload) resumes the CLI's
    own conversation; only the latest user message is sent then. Without it —
    or when the resumed session is gone — a fresh session is started with the
    flattened history as prompt.
    """
    binary = resolve_cli_binary(engine)
    if not binary:
        await emit("ai.chat.error", {
            "session_id": session_id,
            "message": f"{engine} CLI not found — install it or select a binary in onboarding.",
        })
        return

    resume_id = _resume_candidate(workspace_path, cli_session_id)
    if resume_id:
        prompt = _last_user_text(messages) or _flatten_history(messages)
        ok, error = await _run_cli_once(
            binary=binary,
            prompt=prompt,
            resume_id=resume_id,
            session_id=session_id,
            workspace_path=workspace_path,
            system_prompt=system_prompt,
            emit=emit,
        )
        if ok:
            return
        if _RESUME_LOST_MARKER not in error:
            await emit("ai.chat.error", {"session_id": session_id, "message": error})
            return
        log.info("CLI resume %s lost; falling back to a fresh session", resume_id)

    ok, error = await _run_cli_once(
        binary=binary,
        prompt=_flatten_history(messages),
        resume_id="",
        session_id=session_id,
        workspace_path=workspace_path,
        system_prompt=system_prompt,
        emit=emit,
    )
    if not ok:
        await emit("ai.chat.error", {"session_id": session_id, "message": error})


async def _run_cli_once(
    *,
    binary: str,
    prompt: str,
    resume_id: str,
    session_id: str,
    workspace_path: str,
    system_prompt: str,
    emit: Emit,
) -> tuple[bool, str]:
    """One CLI invocation. Returns (True, '') after emitting ai.chat.done,
    or (False, <error message>) without emitting any terminal event."""
    if not prompt.strip():
        return False, "empty prompt — nothing to send to the CLI"

    args = [
        binary, "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
    ]
    if system_prompt:
        args += ["--append-system-prompt", system_prompt]
    if resume_id:
        args += ["--resume", resume_id]

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=_cwd_for(workspace_path),
            limit=_STREAM_LINE_LIMIT,
            start_new_session=True,
        )
    except (FileNotFoundError, OSError) as exc:
        return False, f"failed to launch CLI: {exc}"

    state: dict[str, Any] = {
        "cli_session_id": resume_id,
        "model": "",
        "tool_names": {},  # tool_use id → name, for tool_result events
        "result": None,
    }
    stderr_task = asyncio.create_task(proc.stderr.read())
    try:
        while True:
            try:
                line = await asyncio.wait_for(
                    proc.stdout.readline(), timeout=_IDLE_TIMEOUT_S
                )
            except asyncio.TimeoutError:
                # CLI wedged — no output at all for the whole idle window.
                stderr_task.cancel()
                await _terminate_proc_tree(proc)
                return False, (
                    f"CLI produced no output for {int(_IDLE_TIMEOUT_S)}s"
                    " — killed (idle timeout)"
                )
            except ValueError:
                # single line exceeded _STREAM_LINE_LIMIT — unrecoverable
                stderr_task.cancel()
                await _terminate_proc_tree(proc)
                return False, "CLI emitted an oversized stream-json line"
            if not line:
                break
            raw = line.strip()
            if not raw:
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                await _translate_event(event, state, session_id, emit)
        # Bound the post-EOF wait: a CLI that closes stdout but never exits
        # would otherwise hang this turn forever (idle timeout only covers
        # the readline loop above).
        try:
            returncode = await asyncio.wait_for(proc.wait(), timeout=_KILL_GRACE_S * 10)
        except asyncio.TimeoutError:
            await _terminate_proc_tree(proc)
            returncode = await proc.wait()
        stderr_text = (await stderr_task).decode(errors="replace")
    except asyncio.CancelledError:
        # ai.chat.stop cancelled the task — take the subprocess down with us.
        stderr_task.cancel()
        with contextlib.suppress(Exception):
            await _terminate_proc_tree(proc)
        raise

    result = state["result"]
    if result is not None and not result.get("is_error"):
        usage = result.get("usage") or {}
        input_tokens = (
            (usage.get("input_tokens") or 0)
            + (usage.get("cache_creation_input_tokens") or 0)
            + (usage.get("cache_read_input_tokens") or 0)
        )
        model = state["model"]
        if not model:
            model_usage = result.get("modelUsage") or {}
            model = next(iter(model_usage), "")
        await emit("ai.chat.done", {
            "session_id": session_id,
            "model": model or None,
            "input_tokens": input_tokens or None,
            "output_tokens": usage.get("output_tokens") or None,
            "cli_session_id": state["cli_session_id"] or result.get("session_id") or "",
        })
        return True, ""

    # Failure: prefer the CLI's structured errors, then stderr, then exit code.
    detail = ""
    if result is not None:
        errors = result.get("errors") or []
        detail = "; ".join(str(e) for e in errors if e) or str(result.get("result") or "")
    if not detail:
        detail = stderr_text.strip()[-_STDERR_TAIL_CHARS:]
    if not detail:
        detail = f"CLI exited with code {returncode}"
    return False, detail


async def _translate_event(
    event: dict,
    state: dict[str, Any],
    session_id: str,
    emit: Emit,
) -> None:
    """Translate one stream-json event into ai.chat.* broadcasts."""
    etype = event.get("type")

    if etype == "system":
        if event.get("subtype") == "init" and event.get("session_id"):
            state["cli_session_id"] = str(event["session_id"])
        return

    if etype == "assistant":
        message = event.get("message") or {}
        if message.get("model"):
            state["model"] = str(message["model"])
        if event.get("session_id"):
            state["cli_session_id"] = str(event["session_id"])
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text" and block.get("text"):
                # Strip leading NULs so model output can never spoof the
                # frontend's \x00-sentinel protocol.
                text = block["text"].lstrip("\x00")
                if text:
                    await emit("ai.chat.chunk", {
                        "session_id": session_id,
                        "text": text,
                    })
            elif btype == "thinking" and block.get("thinking"):
                await emit("ai.chat.chunk", {
                    "session_id": session_id,
                    "text": "\x00THINKING:" + block["thinking"],
                })
            elif btype == "tool_use":
                tool_id = str(block.get("id") or "")
                tool_name = str(block.get("name") or "")
                state["tool_names"][tool_id] = tool_name
                await emit("ai.chat.tool_call", {
                    "session_id": session_id,
                    "tool_name": tool_name,
                    "tool_input": block.get("input") or {},
                    "tool_id": tool_id,
                })
        return

    if etype == "user":
        message = event.get("message") or {}
        content = message.get("content")
        if not isinstance(content, list):
            return
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            tool_id = str(block.get("tool_use_id") or "")
            await emit("ai.chat.tool_result", {
                "session_id": session_id,
                "tool_id": tool_id,
                "tool_name": state["tool_names"].get(tool_id, ""),
                "result": _tool_result_text(block.get("content")),
            })
        return

    if etype == "result":
        state["result"] = event
        return
    # anything else (hook noise, rate_limit_event, ...) is ignored


# ── Plain-text helper (review / rewrite / enhance-prompt) ────────────────────

async def run_cli_text(
    prompt: str,
    *,
    system_prompt: str = "",
    workspace_path: str = "",
    timeout: float = _TEXT_TIMEOUT_DEFAULT,
    engine: str = "claude",
) -> str:
    """Run a one-shot non-streaming prompt and return the result text.

    Raises RuntimeError when the CLI is missing, times out, or exits non-zero.
    """
    binary = resolve_cli_binary(engine)
    if not binary:
        raise RuntimeError(
            f"{engine} CLI not found — install it or select a binary in onboarding."
        )
    args = [binary, "-p", prompt, "--output-format", "text"]
    if system_prompt:
        args += ["--append-system-prompt", system_prompt]
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=_cwd_for(workspace_path),
            limit=_STREAM_LINE_LIMIT,
            start_new_session=True,
        )
    except (FileNotFoundError, OSError) as exc:
        raise RuntimeError(f"failed to launch CLI: {exc}") from exc
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        await _terminate_proc_tree(proc)
        raise RuntimeError(f"CLI timed out after {int(timeout)}s")
    except asyncio.CancelledError:
        with contextlib.suppress(Exception):
            await _terminate_proc_tree(proc)
        raise
    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip()[-_STDERR_TAIL_CHARS:]
        raise RuntimeError(detail or f"CLI exited with code {proc.returncode}")
    return stdout.decode(errors="replace").strip()
