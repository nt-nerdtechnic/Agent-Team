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
_PUBLIC_GIT_COMMANDS = frozenset(
    {
        "add",
        "am",
        "apply",
        "bisect",
        "blame",
        "branch",
        "checkout",
        "cherry-pick",
        "clean",
        "clone",
        "commit",
        "describe",
        "diff",
        "fetch",
        "for-each-ref",
        "init",
        "log",
        "ls-files",
        "merge",
        "mv",
        "pull",
        "push",
        "rebase",
        "reflog",
        "remote",
        "reset",
        "restore",
        "revert",
        "rev-list",
        "rev-parse",
        "show",
        "stash",
        "status",
        "submodule",
        "switch",
        "tag",
        "worktree",
    }
)
_PUBLIC_GH_COMMANDS = frozenset(
    {
        "api",
        "browse",
        "cache",
        "gist",
        "issue",
        "label",
        "pr",
        "release",
        "repo",
        "run",
        "search",
        "status",
        "variable",
        "workflow",
    }
)
_PUBLIC_GLAB_COMMANDS = frozenset(
    {
        "api",
        "ci",
        "deploy-key",
        "incident",
        "issue",
        "label",
        "milestone",
        "mr",
        "release",
        "repo",
        "schedule",
        "snippet",
        "variable",
    }
)
_PUBLIC_GIT_OVERRIDE_OPTIONS = (
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--receive-pack",
    "--upload-pack",
    "--work-tree",
)


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


def _public_policy_error() -> ValueError:
    return ValueError("command is not permitted by the public shell policy")


def _option_matches(arg: str, option: str) -> bool:
    return arg == option or arg.startswith(f"{option}=")


def _unsafe_public_path_argument(arg: str) -> bool:
    value = arg.split("=", 1)[1] if arg.startswith("-") and "=" in arg else arg
    if "://" in value or re.match(r"^[^/@:]+@[^:]+:", value):
        return False
    return (
        value.startswith(("/", "\\"))
        or bool(re.match(r"^[A-Za-z]:[\\/]", value))
        or ".." in re.split(r"[\\/]", value)
    )


def _public_command_name(args: Sequence[str]) -> str:
    """Return the top-level tool command after a small set of safe global flags."""
    index = 1
    while index < len(args):
        arg = args[index]
        if arg == "--":
            index += 1
            break
        if arg in {"--no-pager", "--paginate", "--no-replace-objects", "--literal-pathspecs"}:
            index += 1
            continue
        if arg in {"-R", "--repo", "--hostname"}:
            index += 2
            continue
        if any(_option_matches(arg, option) for option in ("--repo", "--hostname")):
            index += 1
            continue
        if arg.startswith("-"):
            raise _public_policy_error()
        return arg
    raise _public_policy_error()


def validate_public_argv(args: Sequence[str]) -> list[str]:
    """Validate an argv supplied by a Manifest v2 public ``shell.run`` call.

    Internal Git and Issues services use :func:`validate_argv`; this stricter
    policy exists only for commands authored by an installed plugin.
    """
    argv = validate_argv(args)
    executable = argv[0]
    if any(_unsafe_public_path_argument(arg) for arg in argv[1:]):
        raise _public_policy_error()

    if executable == "git":
        for arg in argv[1:]:
            if arg == "-c" or arg.startswith("-c") or arg == "-C" or arg.startswith("-C"):
                raise _public_policy_error()
            if any(_option_matches(arg, option) for option in _PUBLIC_GIT_OVERRIDE_OPTIONS):
                raise _public_policy_error()
        command = _public_command_name(argv)
        if command not in _PUBLIC_GIT_COMMANDS:
            raise _public_policy_error()
        command_args = argv[argv.index(command) + 1 :]
        if command in {"credential", "config", "difftool", "filter-branch", "hook", "mergetool", "send-email"}:
            raise _public_policy_error()
        if command == "submodule" and command_args and command_args[0] == "foreach":
            raise _public_policy_error()
        if command == "bisect" and command_args and command_args[0] == "run":
            raise _public_policy_error()
        if command == "rebase" and any(arg == "--exec" or arg.startswith("--exec=") or arg == "-x" or arg.startswith("-x") for arg in command_args):
            raise _public_policy_error()
        return argv

    command = _public_command_name(argv)
    allowed = _PUBLIC_GH_COMMANDS if executable == "gh" else _PUBLIC_GLAB_COMMANDS
    if command not in allowed:
        raise _public_policy_error()
    return argv


def parse_public_allowlisted_command(command: str) -> list[str]:
    """Parse and validate one public plugin command without enabling a shell."""
    if not isinstance(command, str) or not command.strip() or _SHELL_SYNTAX.search(command):
        raise _public_policy_error()
    try:
        args = shlex.split(command, posix=True)
    except ValueError as exc:
        raise _public_policy_error() from exc
    return validate_public_argv(args)


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
