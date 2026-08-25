"""Host-owned execution broker for the small set of approved CLIs.

Git and the provider CLIs are intentionally executed here rather than from
feature services. The broker accepts argv, never a shell string, and rejects
path-qualified executables so callers cannot smuggle an alternate binary under
an allowlisted basename.
"""

from __future__ import annotations

import asyncio
import re
import shlex
from pathlib import Path
from typing import Mapping, Sequence

HOST_SHELL_EXECUTABLE_ALLOWLIST = frozenset({"git", "gh", "glab"})
_SHELL_SYNTAX = re.compile(r"[;&|<>`\n\r]")


def validate_argv(args: Sequence[str]) -> list[str]:
    """Validate and copy an argv intended for the Host shell broker."""
    if not args or any(not isinstance(arg, str) or "\x00" in arg for arg in args):
        raise ValueError("command arguments must be non-empty strings")
    executable = args[0]
    if executable != Path(executable).name or executable not in HOST_SHELL_EXECUTABLE_ALLOWLIST:
        raise ValueError("executable is not allowlisted")
    return list(args)


def parse_allowlisted_command(command: str) -> list[str]:
    """Parse a display-oriented command without enabling shell syntax."""
    if not isinstance(command, str) or not command.strip() or _SHELL_SYNTAX.search(command):
        raise ValueError("command must be one allowlisted executable invocation")
    try:
        args = shlex.split(command, posix=True)
    except ValueError as exc:
        raise ValueError("command quoting is invalid") from exc
    return validate_argv(args)


async def run_allowlisted(
    args: Sequence[str],
    cwd: str | None = None,
    *,
    timeout: float = 15.0,
    input_bytes: bytes | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[int, bytes, bytes]:
    """Run one allowlisted executable and return ``(rc, stdout, stderr)``.

    Validation errors are returned as a normal process-style failure so a
    malformed Host call cannot escape the WebSocket handler as an exception.
    Direct callers that need input validation before execution can still use
    ``validate_argv`` explicitly.
    """
    try:
        argv = validate_argv(args)
    except ValueError as exc:
        return 126, b"", str(exc).encode("utf-8")
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=dict(env) if env is not None else None,
            stdin=asyncio.subprocess.PIPE if input_bytes is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        communication = process.communicate() if input_bytes is None else process.communicate(input_bytes)
        stdout, stderr = await asyncio.wait_for(communication, timeout=timeout)
        return process.returncode or 0, stdout, stderr
    except asyncio.TimeoutError:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        return 128, b"", f"{argv[0]} timed out".encode()
    except FileNotFoundError:
        return 127, b"", f"{argv[0]} not found".encode()
    except Exception as exc:  # noqa: BLE001 - preserve service-level error envelope
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        return 128, b"", str(exc).encode()


async def run_allowlisted_text(
    args: Sequence[str],
    cwd: str | None = None,
    *,
    timeout: float = 15.0,
    input_text: str | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[int, str, str]:
    """Text-decoding wrapper used by Git and Issues services."""
    rc, stdout, stderr = await run_allowlisted(
        args,
        cwd,
        timeout=timeout,
        input_bytes=input_text.encode("utf-8") if input_text is not None else None,
        env=env,
    )
    return rc, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")
