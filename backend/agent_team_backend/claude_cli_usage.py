"""Claude quota read from the CLI's own ``/usage`` panel.

Nothing here talks to Anthropic. Claude Code makes the request under its own
identity and prints the answer; this drives it the way a person would and reads
what it printed. It replaces an HTTP call this app used to make while sending
``User-Agent: claude-code/<version>`` to an endpoint that is not part of any
documented API — same numbers, but the client asking for them is now the client
entitled to ask.

``--ax-screen-reader`` is what makes it readable: the panel is otherwise a TUI
that repaints itself with cursor jumps, and scraping that needs a terminal
emulator. In screen-reader mode the same content arrives as flat lines.

Cost: a full Claude Code start — seconds, plus whatever MCP servers the user has
configured, plus a local session scan. This is not something to put on a short
poll; the caller decides the cadence.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import signal
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

log = logging.getLogger("agent_team_backend.claude_cli_usage")

PROBE_ARGS = ("--ax-screen-reader",)
# Typed first without the enter; the \r only goes in after the CLI echoes the
# text back (see read_usage_panel). On the screens where typing does not echo —
# the folder-trust dialog, the login wizard, the first-run theme picker — a
# blind \r would answer someone else's question with its default button.
SLASH_COMMAND_TEXT = b"/usage"
ENTER = b"\r"

# Boot, then the panel itself, both bounded. The panel repaints several times as
# it loads ("Scanning local sessions…" → final), so it is read until the output
# goes quiet rather than until any one marker appears.
BOOT_TIMEOUT_S = 25.0
PANEL_TIMEOUT_S = 25.0
QUIET_S = 1.5
ECHO_TIMEOUT_S = 5.0

_ENV_DROP = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR")

_ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Z0-9]|\r")
_CSI = re.compile(r"\x1b\[([0-9;?]*)([a-zA-Z])")
# "4% 4% used" — the label is rendered twice (once for the bar, once as text).
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)%\s+(?:\d+(?:\.\d+)?%\s+)?used", re.I)
_RESETS = re.compile(r"^Resets\s+(.+?)\s*$", re.I)
_SESSION_HEAD = re.compile(r"^Current session\s*$", re.I)
_WEEK_HEAD = re.compile(r"^Current week\s*\((.+?)\)\s*$", re.I)


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


def render_screen(raw: str) -> str:
    """Replay the output into a line buffer and return what is on screen.

    Reading the byte stream directly does not work: while the panel loads it
    repaints by moving the cursor up and erasing lines in place, so a corrected
    number arrives with no header attached to it — a stream reader keeps the
    first, already-superseded value. Applying the cursor movements is what makes
    the settled screen, and only the settled screen, readable.

    Deliberately partial: it handles the sequences this panel actually emits
    (cursor up/down, column moves, line erase) and drops the rest, which are
    colour and mode changes with no effect on layout."""
    lines: list[str] = [""]
    row = col = 0

    def put(text: str) -> None:
        nonlocal col
        while len(lines) <= row:
            lines.append("")
        line = lines[row].ljust(col)
        lines[row] = line[:col] + text + line[col + len(text):]
        col += len(text)

    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == "\x1b":
            match = _CSI.match(raw, i)
            if not match:
                nxt = raw[i + 1] if i + 1 < len(raw) else ""
                if nxt in "()":
                    i += 3  # charset select is ESC ( B — the B is not text
                elif nxt == "]":
                    # OSC (window title and friends): payload runs to BEL or ST
                    bel = raw.find("\x07", i)
                    st = raw.find("\x1b\\", i + 2)
                    ends = [e for e in (bel, st) if e != -1]
                    if not ends:
                        break  # unterminated OSC swallows the rest
                    stop = min(ends)
                    i = stop + (1 if raw[stop] == "\x07" else 2)
                else:
                    i += 2  # other two-byte escapes
                continue
            params, final = match.group(1), match.group(2)
            first = params.split(";")[0]
            count = int(first) if first.isdigit() else (0 if final == "K" else 1)
            if final == "A":
                row = max(0, row - max(1, count))
            elif final == "B":
                row += max(1, count)
            elif final == "G":
                col = max(0, count - 1)
            elif final == "K":
                while len(lines) <= row:
                    lines.append("")
                lines[row] = "" if count == 2 else lines[row][:col]
            i = match.end()
            continue
        if ch == "\n":
            row += 1
            col = 0
            while len(lines) <= row:
                lines.append("")
        elif ch == "\r":
            col = 0
        else:
            put(ch)
        i += 1
    return "\n".join(lines)


def _parse_reset(phrase: str, now: datetime) -> str | None:
    """"Aug 7 at 11:59am (Asia/Taipei)" / "5:59am (Asia/Taipei)" -> ISO 8601.

    Returns None whenever the phrase is not confidently understood — the UI
    drops the countdown for that window, which beats inventing a time. The
    wording is the CLI's own and localized, so this only claims to handle the
    English form it ships today."""
    tz_match = re.search(r"\(([A-Za-z_]+/[A-Za-z_+\-]+)\)", phrase)
    if not tz_match:
        return None
    try:
        tz = ZoneInfo(tz_match.group(1))
    except (ZoneInfoNotFoundError, ValueError):
        return None
    body = phrase[: tz_match.start()].strip().rstrip("·").strip()

    clock = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([ap]m)", body, re.I)
    if not clock:
        return None
    hour = int(clock.group(1)) % 12
    if clock.group(3).lower() == "pm":
        hour += 12
    minute = int(clock.group(2) or 0)

    local_now = now.astimezone(tz)
    dated = re.match(r"([A-Z][a-z]{2})\s+(\d{1,2})\b", body)
    if dated:
        months = ("jan", "feb", "mar", "apr", "may", "jun",
                  "jul", "aug", "sep", "oct", "nov", "dec")
        try:
            month = months.index(dated.group(1).lower()) + 1
        except ValueError:
            return None
        day = int(dated.group(2))
        year = local_now.year
        # The panel never dates the past; a month behind us means next year.
        if month < local_now.month - 6:
            year += 1
        try:
            when = local_now.replace(
                year=year, month=month, day=day,
                hour=hour, minute=minute, second=0, microsecond=0,
            )
        except ValueError:
            return None
    else:
        when = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if when <= local_now:  # a bare clock time means the next one
            when += timedelta(days=1)
    return when.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z")


def parse_usage_panel(raw: str, *, now: datetime | None = None) -> list[dict]:
    """Windows in the shape ``usage_service._window`` produces.

    The raw stream is replayed through ``render_screen`` first: the panel
    corrects itself in place while loading, and only the rendered screen shows
    the values it settled on."""
    from .usage_service import _window

    now = now or datetime.now().astimezone()
    lines = [line.strip() for line in render_screen(raw).splitlines()]
    found: dict[str, dict] = {}

    for idx, line in enumerate(lines):
        if _SESSION_HEAD.match(line):
            key, kind, label = "session", "session", "Session (5h)"
        else:
            week = _WEEK_HEAD.match(line)
            if not week:
                continue
            scope = week.group(1).strip()
            if scope.lower() == "all models":
                key, kind, label = "weekly", "weekly", "Weekly (all models)"
            else:
                key, kind, label = f"weekly:{scope}", "weekly-model", f"Weekly ({scope})"

        # The percent and the reset line follow the header within a few lines;
        # stop at the next header so blocks never borrow each other's numbers.
        pct: float | None = None
        resets: str | None = None
        for follow in lines[idx + 1: idx + 6]:
            if _SESSION_HEAD.match(follow) or _WEEK_HEAD.match(follow):
                break
            if pct is None:
                hit = _PERCENT.search(follow)
                if hit:
                    pct = float(hit.group(1))
                    continue
            reset_hit = _RESETS.match(follow)
            if reset_hit:
                resets = _parse_reset(reset_hit.group(1), now)
                break
        if pct is not None:
            found[key] = _window(kind, label, pct, resets)

    order = {"session": 0, "weekly": 1}
    return [found[k] for k in sorted(found, key=lambda k: (order.get(k, 2), k))]


def _probe_env() -> dict[str, str]:
    env = dict(os.environ)
    for key in _ENV_DROP:
        env.pop(key, None)
    env.update({"TERM": "xterm-256color", "COLUMNS": "100", "LINES": "40"})
    return env


async def _kill_group(pid: int) -> None:
    # Async on purpose: this runs on the backend's only event loop, and a
    # blocking sleep here freezes every WebSocket session for its duration.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            return
        await asyncio.sleep(0.2)


async def read_usage_panel(binary: str) -> str:
    """Drive the CLI to its ``/usage`` panel and return the raw screen text.

    Runs in a pty because the panel only renders for an interactive terminal.
    The process group is always taken down before returning."""
    import pty

    master, slave = pty.openpty()
    proc = await asyncio.create_subprocess_exec(
        binary, *PROBE_ARGS,
        stdin=slave, stdout=slave, stderr=slave,
        env=_probe_env(), start_new_session=True,
    )
    os.close(slave)
    loop = asyncio.get_running_loop()
    chunks: list[bytes] = []
    reader_ready = asyncio.Event()
    eof = False

    def _on_readable() -> None:
        nonlocal eof
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if data:
            chunks.append(data)
        else:
            # After EOF the fd stays readable forever; leaving the reader in
            # place turns the event loop into a busy spin until the deadline.
            eof = True
            loop.remove_reader(master)
        reader_ready.set()

    def _closed() -> bool:
        return eof

    loop.add_reader(master, _on_readable)
    try:
        await _wait_settled(reader_ready, chunks, BOOT_TIMEOUT_S, closed=_closed)
        chunks.clear()
        # Type the command, then require the CLI to echo it back before the
        # enter goes in. A select-style dialog (folder trust, login wizard,
        # theme picker) swallows typed text without echoing it, and a blind \r
        # there presses its default button — for the trust dialog that means
        # silently marking the cwd as trusted. No echo, no enter.
        await loop.run_in_executor(None, os.write, master, SLASH_COMMAND_TEXT)

        def _echoed() -> bool:
            return "/usage" in render_screen(b"".join(chunks).decode("utf-8", "replace"))

        end = time.monotonic() + ECHO_TIMEOUT_S
        while not _echoed() and not eof and time.monotonic() < end:
            reader_ready.clear()
            try:
                await asyncio.wait_for(reader_ready.wait(), timeout=0.3)
            except asyncio.TimeoutError:
                continue
        if not _echoed():
            raise RuntimeError(
                "the screen did not echo /usage back (dialog, login wizard, or "
                "unrecognized UI); refusing to press enter on it"
            )
        await loop.run_in_executor(None, os.write, master, ENTER)

        def _has_numbers() -> bool:
            return bool(parse_usage_panel(b"".join(chunks).decode("utf-8", "replace")))

        await _wait_settled(
            reader_ready, chunks, PANEL_TIMEOUT_S, ready=_has_numbers, closed=_closed,
        )
        return b"".join(chunks).decode("utf-8", "replace")
    finally:
        loop.remove_reader(master)  # no-op when the EOF path already removed it
        await _kill_group(proc.pid)
        try:
            await asyncio.wait_for(proc.wait(), timeout=3)
        except (asyncio.TimeoutError, ProcessLookupError):
            pass
        os.close(master)


async def _wait_settled(
    flag: asyncio.Event,
    chunks: list[bytes],
    deadline_s: float,
    ready=None,
    closed=None,
) -> None:
    """Wait for output to start, then for it to stop — and, when ``ready`` is
    given, for it to actually contain what the caller came for.

    Two failure modes make the obvious version wrong. A cold Claude Code takes
    seconds before its first byte, so silence-so-far would read as "finished"
    and the panel command would go to a CLI that has not drawn a prompt yet.
    And the panel pauses mid-render while it scans local sessions, so a pause
    longer than ``QUIET_S`` would end the read on a half-drawn screen with no
    numbers on it. ``ready`` turns quiet into a question rather than a verdict.
    Both phases share one deadline, so a panel that never fills still ends.
    ``closed`` reports the pty gone (the CLI exited); nothing further can
    arrive, so the wait ends instead of running out its deadline."""
    end = time.monotonic() + deadline_s
    while not chunks and time.monotonic() < end:
        if closed is not None and closed():
            return
        flag.clear()
        try:
            await asyncio.wait_for(flag.wait(), timeout=0.5)
        except asyncio.TimeoutError:
            continue
    while time.monotonic() < end:
        if closed is not None and closed():
            return
        flag.clear()
        try:
            await asyncio.wait_for(flag.wait(), timeout=QUIET_S)
        except asyncio.TimeoutError:
            if ready is None or ready():
                return


async def fetch_claude_usage_via_cli(home: Path) -> dict[str, Any] | None:
    """Snapshot for the usage badge, or None when there is no CLI to ask.

    A read that actually started a Claude Code but came back empty returns an
    ``unavailable`` snapshot carrying a transient ``costlyRead`` flag: the
    poller prices that retry like a success (a spawn is a spawn), instead of
    re-running a full CLI boot on the short failure cooldown, forever."""
    from .ai_chat_cli_engine import resolve_cli_binary
    from .usage_service import _snapshot, read_claude_credentials

    def _costly() -> dict[str, Any]:
        snap = _snapshot("claude", "unavailable")
        snap["costlyRead"] = True
        return snap

    # Logged out is knowable without a spawn. The CLI would only present its
    # login wizard — at a full boot's cost, on every retry, forever — and the
    # badge would say "unavailable" where it means "log in".
    if await read_claude_credentials(home) is None:
        return _snapshot("claude", "no-credentials")
    try:
        binary = resolve_cli_binary("claude")
    except Exception:  # noqa: BLE001
        binary = ""
    if not binary:
        return None
    try:
        raw = await read_usage_panel(binary)
    except Exception as err:  # noqa: BLE001 — a failed read is just "no data"
        log.warning("claude /usage read failed: %s", err)
        return _costly()
    windows = parse_usage_panel(raw)
    if not windows:
        log.info("claude /usage produced no readable windows")
        return _costly()
    return _snapshot("claude", "ok", windows=windows)
