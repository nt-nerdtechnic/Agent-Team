"""force_redraw must deliver a SIGWINCH even when the size does not change.

Five of the CLI vendors we ship repaint on receiving SIGWINCH rather than on
observing a size delta, so this nudge is their only repaint path after a
resize settles. Measured against real PTYs on 2026-08-28, bytes emitted in
response to force_redraw's exact ioctl pair at an unchanged size:

    kilo 8437, copilot 6030, qwen 4446, aider 442, codex 144
    claude, opencode, droid, kimi, grok, cursor-agent: 0

The six that emit nothing compare the new winsize against the old one and skip
the repaint, which is what makes force_redraw look like dead code from a
claude pane. It is not: deleting it, or "simplifying" it to skip a resize to
the size the PTY already has, silently removes the post-resize repaint for the
other five. No other test covers this — the frontend gates around
requestResizeRedraw are pinned by useTerminalResize.test.ts, but nothing
checked that the backend end of that path still signals anything.
"""

from __future__ import annotations

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
from types import SimpleNamespace

import pytest

from agent_team_backend import app
from agent_team_backend.terminals import TerminalSession

ROWS, COLS = 24, 80
# Long enough for the child to be scheduled and run its handler, short enough
# that a genuine regression fails fast rather than hanging the suite.
SIGNAL_WAIT_S = 3.0


def _spawn_winch_counter() -> tuple[int, int]:
    """Fork a child on a real PTY that emits one byte per SIGWINCH received.

    pty.fork() is what gives the child a controlling terminal and puts it in
    the foreground process group; without that the kernel would not deliver
    SIGWINCH to it at all, and the test would pass for the wrong reason.
    """
    pid, master_fd = pty.fork()
    if pid == 0:  # child
        try:
            signal.signal(signal.SIGWINCH, lambda *_: os.write(1, b"W"))
            # Report readiness, then idle. SIGWINCH interrupts the sleep, so
            # loop rather than sleeping once.
            os.write(1, b"R")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                time.sleep(0.05)
        finally:
            os._exit(0)
    # drain_output() reads the master until EAGAIN; on a blocking fd with an
    # idle child that never returns.
    fcntl.fcntl(master_fd, fcntl.F_SETFL, os.O_NONBLOCK)
    return pid, master_fd


def _read_until(fd: int, marker: bytes, seconds: float) -> bytes:
    """Read until `marker` shows up, or the deadline passes. Returns as soon as
    it has what it came for so a passing test costs milliseconds, not the whole
    timeout."""
    out = b""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 1024)
            except (OSError, BlockingIOError):
                break
            if not chunk:
                break
            out += chunk
            if marker in out:
                return out
    return out


def _drain(fd: int) -> None:
    """Discard whatever is already buffered (e.g. the SIGWINCH from setup)."""
    while True:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            return
        try:
            if not os.read(fd, 4096):
                return
        except (OSError, BlockingIOError):
            return


def _await_ready(fd: int) -> None:
    if b"R" not in _read_until(fd, b"R", 5.0):
        pytest.fail("child never reported ready on the PTY")


def _register(session: app.Session, sid: str, master_fd: int, pid: int) -> None:
    session.terminals._sessions[sid] = TerminalSession(
        id=sid,
        pane_id="p1",
        agent_key=None,
        command=["x"],
        cwd="/",
        master_fd=master_fd,
        proc=SimpleNamespace(pid=pid, returncode=None),  # type: ignore[arg-type]
    )


def _set_size(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


@pytest.mark.skipif(sys.platform == "win32", reason="pty/SIGWINCH are POSIX-only")
def test_force_redraw_signals_even_at_an_unchanged_size() -> None:
    """The case the resize path actually uses: the PTY is already the right
    size, and the point of the call is the signal, not the size."""
    pid, master_fd = _spawn_winch_counter()
    session = app.Session(SimpleNamespace())  # type: ignore[arg-type]
    sid = "term-winch"
    _register(session, sid, master_fd, pid)
    try:
        _set_size(master_fd, ROWS, COLS)
        _await_ready(master_fd)
        _drain(master_fd)  # discard the SIGWINCH from the setup resize

        session.terminals.force_redraw(sid, COLS, ROWS)

        assert b"W" in _read_until(master_fd, b"W", SIGNAL_WAIT_S), (
            "force_redraw delivered no SIGWINCH at an unchanged size. Five "
            "shipped vendors (kilo, copilot, qwen, aider, codex) repaint on "
            "the signal alone, so this is their post-resize repaint path."
        )
    finally:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(master_fd)


@pytest.mark.skipif(sys.platform == "win32", reason="pty/SIGWINCH are POSIX-only")
def test_force_redraw_leaves_the_requested_size_in_place() -> None:
    """The transient off-by-one row must not be what the PTY is left at."""
    pid, master_fd = _spawn_winch_counter()
    session = app.Session(SimpleNamespace())  # type: ignore[arg-type]
    sid = "term-winch-size"
    _register(session, sid, master_fd, pid)
    try:
        _set_size(master_fd, ROWS, COLS)
        _await_ready(master_fd)

        session.terminals.force_redraw(sid, COLS, ROWS)

        packed = fcntl.ioctl(master_fd, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
        rows, cols, _, _ = struct.unpack("HHHH", packed)
        assert (rows, cols) == (ROWS, COLS)
    finally:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(master_fd)


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform == "win32", reason="pty/SIGWINCH are POSIX-only")
async def test_terminal_redraw_message_reaches_the_pty() -> None:
    """End of the wire: the frontend's terminal.redraw must still signal.

    useTerminalResize.test.ts pins that armResizeRedraw sends this message;
    this pins that receiving it does something to the terminal.
    """
    sent: list[dict] = []

    class RecordingWS:
        async def send_json(self, payload: dict) -> None:
            sent.append(payload)

        async def send_bytes(self, data: bytes) -> None:  # pragma: no cover
            pass

    pid, master_fd = _spawn_winch_counter()
    session = app.Session(RecordingWS())  # type: ignore[arg-type]
    sid = "term-winch-ws"
    _register(session, sid, master_fd, pid)
    try:
        _set_size(master_fd, ROWS, COLS)
        _await_ready(master_fd)
        _drain(master_fd)

        await app.handle_message(session, {
            "id": "d1",
            "type": "terminal.redraw",
            "payload": {"terminal_session_id": sid, "cols": COLS, "rows": ROWS},
        })

        assert b"W" in _read_until(master_fd, b"W", SIGNAL_WAIT_S), (
            "terminal.redraw no longer signals the PTY"
        )
    finally:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(master_fd)
