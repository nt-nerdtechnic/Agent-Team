"""Read and manage the machine's registered background executions.

Two sources are covered: the current user's Unix ``crontab`` entries, and (on
macOS only) the LaunchAgents installed under ``~/Library/LaunchAgents``.

This module is a pure service layer — it knows nothing about WebSocket sessions
and never touches app state. Every external command runs through
:func:`_run`, which uses ``create_subprocess_exec`` (never a shell) and always
enforces a timeout, so a hung ``crontab``/``launchctl`` cannot pin a request
open forever.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import plistlib
import re
import shlex
import sys
import tempfile
import time
from pathlib import Path


class ExecutionsError(Exception):
    """An execution-management operation failed for an operational reason.

    Callers surface the message to the user verbatim (it usually carries the
    failing command's stderr), so keep messages human-readable.
    """


# ─── subprocess helper ────────────────────────────────────────────────────────

# Cap concurrent helper processes. A rescan spawns crontab + launchctl, and
# multiple windows can rescan at once after an executions.changed broadcast.
_PROC_LIMIT = 4
# Keyed per event loop: asyncio.Semaphore binds to the loop it is first awaited
# on, and tests run each case on a fresh loop.
_proc_semaphores: dict[asyncio.AbstractEventLoop, asyncio.Semaphore] = {}


def _proc_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _proc_semaphores.get(loop)
    if sem is None:
        sem = asyncio.Semaphore(_PROC_LIMIT)
        _proc_semaphores[loop] = sem
    return sem


async def _run(
    argv: list[str], *, timeout: float = 10.0, stdin: str | None = None
) -> tuple[int, str, str]:
    """Run ``argv`` without a shell; return ``(returncode, stdout, stderr)``.

    A timeout kills the child and reports returncode ``-1`` so callers can never
    mistake a hang for success.
    """
    proc = None
    try:
        async with _proc_semaphore():
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            payload = stdin.encode("utf-8") if stdin is not None else None
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(payload), timeout=timeout
            )
        return (
            proc.returncode or 0,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )
    except asyncio.TimeoutError:
        if proc is not None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        return -1, "", f"{argv[0]} timed out after {timeout:g}s"
    except FileNotFoundError:
        return -1, "", f"{argv[0]} executable not found"
    except Exception as exc:  # noqa: BLE001 - reported to the UI verbatim
        return -1, "", str(exc)


# ─── crontab ──────────────────────────────────────────────────────────────────

DISABLED_PREFIX = "# [NAVIDE-DISABLED] "
# Recognised with a regex rather than startswith so hand-edited spacing
# ("#[NAVIDE-DISABLED] …") still round-trips.
_DISABLED_RE = re.compile(r"^#\s*\[NAVIDE-DISABLED\]\s?")
# Environment assignments (PATH=…, MAILTO="") are crontab syntax, not jobs.
_ENV_LINE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\s*=")
_SPECIAL_SCHEDULES = frozenset(
    {
        "@reboot",
        "@yearly",
        "@annually",
        "@monthly",
        "@weekly",
        "@daily",
        "@midnight",
        "@hourly",
    }
)


def _split_schedule(line: str) -> tuple[str, str, str] | None:
    """Split a job line into ``(schedule, schedule_kind, command)``.

    Returns None when the line does not look like a job at all.
    """
    head = line.split(maxsplit=1)
    if not head:
        return None
    if head[0].lower() in _SPECIAL_SCHEDULES:
        if len(head) < 2 or not head[1]:
            return None
        return head[0], "special", head[1]
    # maxsplit keeps the command's own spacing intact.
    parts = line.split(maxsplit=5)
    if len(parts) < 6:
        return None
    return " ".join(parts[:5]), "standard", parts[5]


_INTERPRETERS = frozenset(
    {
        "sh", "bash", "zsh", "dash", "ksh", "fish",
        "python", "python2", "python3", "ruby", "perl", "php", "node", "deno", "bun",
        "env", "nice", "nohup", "time", "sudo", "caffeinate",
    }
)


def _entry_name(command: str) -> str:
    """Human-readable label for a cron job.

    Interpreter-aware: ``/usr/bin/php "/srv/app/artisan" schedule:run`` is named
    after ``artisan``, not ``php`` — every job a user runs through the same
    interpreter would otherwise share one meaningless name.
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    for token in tokens:
        if token.startswith("-"):
            continue
        base = os.path.basename(token)
        if base.endswith(".sh"):
            base = base[:-3]
        # "=" catches `env FOO=bar cmd` prefixes.
        if not base or "=" in base or base.lower() in _INTERPRETERS:
            continue
        return base
    return command[:40]


def parse_crontab(text: str) -> tuple[list[dict], int]:
    """Parse ``crontab -l`` output into entries plus an unparsed-line count."""
    entries: list[dict] = []
    unparsed = 0
    for source in text.splitlines():
        raw = source.strip()
        if not raw:
            continue
        line = raw
        enabled = True
        marker = _DISABLED_RE.match(line)
        if marker is not None:
            enabled = False
            line = line[marker.end() :].strip()
            if not line:
                continue
        elif line.startswith("#"):
            continue
        if _ENV_LINE_RE.match(line):
            continue
        parsed = _split_schedule(line)
        if parsed is None:
            unparsed += 1
            continue
        schedule, kind, command = parsed
        entries.append(
            {
                # Position-qualified: duplicate crontab lines are legal, and a
                # bare content hash would collide into one list key.
                "id": f"{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:12]}-{len(entries)}",
                "name": _entry_name(command),
                "schedule": schedule,
                "schedule_kind": kind,
                "command": command,
                "raw": raw,
                "enabled": enabled,
            }
        )
    return entries, unparsed


async def list_crontab() -> dict:
    """List the current user's crontab entries.

    "No crontab installed" is an empty list, not an error.
    """
    if os.name != "posix":
        return {"supported": False, "entries": [], "unparsed": 0, "error": None}
    code, out, err = await _run(["crontab", "-l"])
    if code != 0:
        if "no crontab" in err.lower():
            return {"supported": True, "entries": [], "unparsed": 0, "error": None}
        return {
            "supported": True,
            "entries": [],
            "unparsed": 0,
            "error": err.strip() or f"crontab -l failed with exit code {code}",
        }
    entries, unparsed = parse_crontab(out)
    return {"supported": True, "entries": entries, "unparsed": unparsed, "error": None}


async def _read_crontab_lines() -> list[str]:
    """Re-read the crontab for a read-modify-write cycle.

    Unlike the listing path, a non-zero exit is always fatal here: writing back
    on top of a failed read is how a whole crontab gets wiped.
    """
    code, out, err = await _run(["crontab", "-l"])
    if code != 0:
        raise ExecutionsError(
            err.strip() or f"could not read the crontab (exit code {code})"
        )
    return out.splitlines()


def _find_line_index(lines: list[str], raw: str) -> int:
    """Index of the first line equal to ``raw``; raise if it is gone."""
    target = raw.strip()
    for index, line in enumerate(lines):
        if line.strip() == target:
            return index
    raise ExecutionsError(
        "the crontab was modified by another program; please rescan"
    )


async def _write_crontab(lines: list[str], expect: list[str]) -> None:
    """Install ``lines`` as the crontab via a 0600 temp file.

    ``expect`` is the listing this edit was computed from. Re-reading and
    comparing right before the install closes most of the read-modify-write
    window: if another program (or the user's own ``crontab -e``) changed the
    file meanwhile, installing our snapshot would silently drop their edit.
    """
    if await _read_crontab_lines() != expect:
        raise ExecutionsError(
            "the crontab changed while it was being edited; please rescan"
        )
    body = "\n".join(lines) + "\n" if lines else ""
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".crontab", delete=False
    )
    tmp_path = handle.name
    try:
        os.chmod(tmp_path, 0o600)
        handle.write(body)
        handle.close()
        code, _out, err = await _run(["crontab", tmp_path])
        if code != 0:
            raise ExecutionsError(
                err.strip() or f"crontab install failed with exit code {code}"
            )
    finally:
        try:
            handle.close()
        except Exception:
            pass
        try:
            os.remove(tmp_path)
        except OSError:
            pass


async def set_crontab_enabled(raw: str, enabled: bool) -> None:
    """Add or strip the disabled marker on the first line matching ``raw``."""
    original = await _read_crontab_lines()
    lines = list(original)
    index = _find_line_index(lines, raw)
    line = lines[index].strip()
    marker = _DISABLED_RE.match(line)
    if enabled:
        if marker is None:
            return
        lines[index] = line[marker.end() :].strip()
    else:
        if marker is not None:
            return
        lines[index] = DISABLED_PREFIX + line
    await _write_crontab(lines, original)


async def remove_crontab_entry(raw: str) -> None:
    """Delete the first line matching ``raw``."""
    original = await _read_crontab_lines()
    lines = list(original)
    index = _find_line_index(lines, raw)
    del lines[index]
    await _write_crontab(lines, original)


# ─── LaunchAgents (macOS) ─────────────────────────────────────────────────────

_LABEL_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_CALENDAR_KEYS = ("Hour", "Minute", "Weekday", "Day", "Month")
# bootout reports these when the service simply is not loaded, which is the
# state the caller wanted anyway.
# "could not find" (not "...service") so both launchctl wordings match:
# "Could not find service" and "Could not find specified service".
_NOT_LOADED_MARKERS = ("no such process", "could not find")


def _launch_agents_dir() -> Path:
    return Path(os.path.expanduser("~")) / "Library" / "LaunchAgents"


def _coerce_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _normalize_calendar(value: object) -> list[dict]:
    """StartCalendarInterval is a dict or a list of dicts; always return a list."""
    if isinstance(value, dict):
        items: list = [value]
    elif isinstance(value, list):
        items = value
    else:
        return []
    out: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        entry = {
            key: item[key]
            for key in _CALENDAR_KEYS
            if _coerce_int(item.get(key)) is not None
        }
        if entry:
            out.append(entry)
    return out


def _humanize_label(label: str) -> str:
    """``com.syncthing.syncthing`` -> ``syncthing``."""
    tail = label.rsplit(".", 1)[-1].strip()
    return tail or label


def _scan_plists() -> tuple[dict[str, dict], int]:
    """Read ``~/Library/LaunchAgents/*.plist``; return ``({label: info}, bad)``."""
    directory = _launch_agents_dir()
    try:
        paths = sorted(directory.glob("*.plist"))
    except OSError:
        return {}, 0
    found: dict[str, dict] = {}
    unreadable = 0
    for path in paths:
        try:
            with open(path, "rb") as fh:
                data = plistlib.load(fh)
        except Exception:  # noqa: BLE001 - corrupt plists are skipped, not fatal
            unreadable += 1
            continue
        if not isinstance(data, dict):
            unreadable += 1
            continue
        label = data.get("Label")
        if not isinstance(label, str) or not label.strip():
            label = path.stem
        keep_alive_raw = data.get("KeepAlive")
        if isinstance(keep_alive_raw, dict):
            keep_alive: bool | None = True
        elif isinstance(keep_alive_raw, bool):
            keep_alive = keep_alive_raw
        else:
            keep_alive = None
        run_at_load = data.get("RunAtLoad")
        comment = data.get("Comment")
        found[label] = {
            "plist_path": str(path),
            "keep_alive": keep_alive,
            "run_at_load": run_at_load if isinstance(run_at_load, bool) else None,
            "start_interval": _coerce_int(data.get("StartInterval")),
            "start_calendar": _normalize_calendar(data.get("StartCalendarInterval")),
            "comment": comment.strip() if isinstance(comment, str) and comment.strip() else None,
        }
    return found, unreadable


def _parse_column_int(token: str) -> int | None:
    """``launchctl list`` writes ``-`` for "no pid" / "no exit code"."""
    try:
        return int(token)
    except ValueError:
        return None


def parse_launchctl_list(text: str) -> dict[str, tuple[int | None, int | None]]:
    """Map label -> ``(pid, last_exit_code)`` from ``launchctl list`` output.

    The third column must match exactly: substring matching lets ``com.foo``
    pick up ``com.foo.bar``'s PID.
    """
    result: dict[str, tuple[int | None, int | None]] = {}
    for line in text.splitlines():
        parts = line.split(maxsplit=2)
        if len(parts) < 3:
            continue
        if parts[0] == "PID" and parts[1] == "Status":
            continue
        label = parts[2].strip()
        if not label:
            continue
        result[label] = (_parse_column_int(parts[0]), _parse_column_int(parts[1]))
    return result


async def list_launch_agents() -> dict:
    """List LaunchAgents: the union of installed plists and loaded services."""
    if sys.platform != "darwin":
        return {"supported": False, "entries": [], "unreadable": 0, "error": None}
    plists, unreadable = await asyncio.to_thread(_scan_plists)
    code, out, err = await _run(["launchctl", "list"])
    error: str | None = None
    loaded: dict[str, tuple[int | None, int | None]] = {}
    if code != 0:
        error = err.strip() or f"launchctl list failed with exit code {code}"
    else:
        loaded = parse_launchctl_list(out)

    # Only plist-backed agents. launchctl also reports hundreds of transient
    # `application.com.apple.*` GUI registrations that have no plist here and
    # therefore no action the user can take — listing them buries the ~dozen
    # agents the Tasker panel exists to manage.
    entries: list[dict] = []
    for label in sorted(plists):
        info = plists[label]
        pid, last_exit_code = loaded.get(label, (None, None))
        comment = info.get("comment")
        entries.append(
            {
                "label": label,
                "name": comment or _humanize_label(label),
                "plist_path": info["plist_path"],
                "plist_exists": True,
                "loaded": label in loaded,
                "running": pid is not None,
                "pid": pid,
                "last_exit_code": last_exit_code,
                "keep_alive": info["keep_alive"],
                "run_at_load": info["run_at_load"],
                "start_interval": info["start_interval"],
                "start_calendar": info["start_calendar"],
                "comment": comment,
            }
        )
    return {
        "supported": True,
        "entries": entries,
        "unreadable": unreadable,
        "error": error,
    }


async def _resolve_plist_path(label: str) -> tuple[Path, bool]:
    """Validate ``label`` and locate its plist; return ``(path, exists)``."""
    if sys.platform != "darwin":
        raise ExecutionsError("LaunchAgents are only available on macOS")
    if not _LABEL_RE.match(label or ""):
        raise ExecutionsError(f"invalid LaunchAgent label: {label!r}")
    # Scanning reads and parses every plist; keep it off the event loop.
    plists, _unreadable = await asyncio.to_thread(_scan_plists)
    info = plists.get(label)
    path = Path(info["plist_path"]) if info else _launch_agents_dir() / f"{label}.plist"
    directory = os.path.realpath(_launch_agents_dir())
    resolved = os.path.realpath(path)
    if os.path.dirname(resolved) != directory:
        raise ExecutionsError(
            f"refusing to touch a plist outside {directory}: {resolved}"
        )
    return path, path.is_file()


async def _bootout(label: str) -> None:
    """Unload a LaunchAgent; "not loaded" counts as success."""
    code, out, err = await _run(
        ["launchctl", "bootout", f"gui/{os.getuid()}/{label}"]
    )
    if code == 0:
        return
    combined = f"{err} {out}".lower()
    if any(marker in combined for marker in _NOT_LOADED_MARKERS):
        return
    raise ExecutionsError(
        err.strip() or f"launchctl bootout failed with exit code {code}"
    )


async def _set_launchd_override(label: str, enabled: bool) -> None:
    """Persist the on/off decision in launchd's override database.

    ``bootout`` alone only unloads until the next login, so without this the
    disable button would silently undo itself — unlike the crontab side, whose
    marker survives a reboot.
    """
    verb = "enable" if enabled else "disable"
    code, out, err = await _run(["launchctl", verb, f"gui/{os.getuid()}/{label}"])
    if code == 0:
        return
    # An override for a service launchd has never seen is not a failure: the
    # bootout/bootstrap that follows is what the user actually asked for.
    combined = f"{err} {out}".lower()
    if any(marker in combined for marker in _NOT_LOADED_MARKERS):
        return
    raise ExecutionsError(
        err.strip() or f"launchctl {verb} failed with exit code {code}"
    )


async def set_launch_agent_enabled(label: str, enabled: bool) -> None:
    """Bootstrap or boot out the LaunchAgent named ``label``, persistently."""
    path, exists = await _resolve_plist_path(label)
    if not enabled:
        # Disable first: otherwise launchd may relaunch between the two calls.
        await _set_launchd_override(label, False)
        await _bootout(label)
        return
    if not exists:
        raise ExecutionsError(f"plist not found: {path}")
    # bootstrap refuses a disabled service, so lift the override first.
    await _set_launchd_override(label, True)
    code, _out, err = await _run(
        ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)]
    )
    if code != 0:
        raise ExecutionsError(
            err.strip() or f"launchctl bootstrap failed with exit code {code}"
        )


async def remove_launch_agent(label: str) -> None:
    """Unload then delete a LaunchAgent's plist. A failed unload keeps the file."""
    path, exists = await _resolve_plist_path(label)
    if not exists:
        raise ExecutionsError(f"plist not found: {path}")
    await _bootout(label)
    try:
        os.remove(path)
    except OSError as err:
        raise ExecutionsError(f"could not delete {path}: {err}") from err


# ─── top-level API ────────────────────────────────────────────────────────────


async def list_executions() -> dict:
    """Full scan of both sources for the Tasker panel."""
    crontab, launch_agents = await asyncio.gather(list_crontab(), list_launch_agents())
    return {
        "platform": sys.platform,
        "scanned_at": time.time(),
        "crontab": crontab,
        # The panel contract names this list "agents"; the scanner returns "entries".
        "launch_agents": {
            "supported": launch_agents["supported"],
            "error": launch_agents["error"],
            "unreadable": launch_agents["unreadable"],
            "agents": launch_agents["entries"],
        },
    }
