"""One-shot Claude CLI runner for AI review and Monaco inline AI.

Runs a headless coding CLI (v1: Claude Code) as a subprocess for plain-text
one-shot prompts: ``run_cli_text`` backs ai.review.* (review_service) and the
editor.rewrite / editor.complete handlers; ``resolve_cli_binary`` is the
shared binary lookup. The streaming AI chat engine that used to live here was
removed together with the AI chat feature.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
import signal
from pathlib import Path
from typing import Any

from . import onboarding_deps

log = logging.getLogger("agent_team_backend.ai_chat_cli_engine")

# CLI output can embed whole file contents, so the default 64 KB
# StreamReader limit is far too small.
_STREAM_LINE_LIMIT = 10 * 1024 * 1024
_STDERR_TAIL_CHARS = 1_000
_TEXT_TIMEOUT_DEFAULT = 120.0
# SIGTERM → grace → SIGKILL window for the CLI's process group.
_KILL_GRACE_S = 3.0

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


# ── Plain-text helper (review / rewrite) ─────────────────────────────────────

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
