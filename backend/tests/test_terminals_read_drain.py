"""Regression tests for draining the PTY inside one readable callback.

On macOS a PTY master read returns at most 1024 bytes however much is asked
for, so reading once per callback turned a single 20 KB TUI repaint into ~20
event-loop round trips — each paying a decode and a flush-scheduling round.
_on_readable now drains until EAGAIN. These tests pin that behaviour, its
bound, and the buffered-size bookkeeping that replaced a per-append re-sum.
"""

import fcntl
import os
from types import SimpleNamespace

import pytest

from agent_team_backend import terminals as terminals_mod
from agent_team_backend.terminals import TerminalService


def _nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


async def _emit(_event):  # EventSink stub — never actually called on this path
    return None


def _cancel_pending_flush(svc: TerminalService, session_id: str) -> None:
    handle = svc._out_handles.pop(session_id, None)
    if handle:
        handle.cancel()


def _cap_reads_at_1024(monkeypatch) -> list[int]:
    """Make os.read behave like a macOS PTY master; return the call log."""
    real_read = os.read
    calls: list[int] = []

    def capped(fd: int, n: int) -> bytes:
        calls.append(n)
        return real_read(fd, min(n, 1024))

    monkeypatch.setattr(os, "read", capped)
    return calls


@pytest.mark.asyncio
async def test_one_callback_drains_a_whole_repaint(monkeypatch):
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = SimpleNamespace(id="t-drain", master_fd=r, closed=False)
    svc._sessions["t-drain"] = session
    try:
        payload = b"x" * 20480  # 20 KB — one full-screen TUI repaint
        os.write(w, payload)
        reads = _cap_reads_at_1024(monkeypatch)

        svc._on_readable(session)  # exactly one callback

        assert "".join(svc._out_buffers["t-drain"]) == "x" * 20480
        # It took many reads (1 KB cap) but only the one callback above.
        assert len(reads) >= 20
    finally:
        _cancel_pending_flush(svc, "t-drain")
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_drain_is_bounded_so_a_flood_yields_to_the_loop(monkeypatch):
    """An unbounded drain would starve every other session during a flood."""
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = SimpleNamespace(id="t-flood", master_fd=r, closed=False)
    svc._sessions["t-flood"] = session
    try:
        monkeypatch.setattr(terminals_mod, "_READ_DRAIN_MAX_BYTES", 4096)
        os.write(w, b"y" * 20480)
        _cap_reads_at_1024(monkeypatch)

        svc._on_readable(session)

        taken = len("".join(svc._out_buffers["t-flood"]))
        assert taken == 4096, "one callback must stop at the drain bound"
    finally:
        _cancel_pending_flush(svc, "t-flood")
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_bytes_read_before_eof_are_not_lost(monkeypatch):
    """The drain can hit EOF mid-batch; what it already read must still ship."""
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = SimpleNamespace(id="t-eof", master_fd=r, closed=False)
    svc._sessions["t-eof"] = session
    closed: list[str] = []
    monkeypatch.setattr(svc, "_close", lambda s, *, reason: closed.append(reason))
    try:
        os.write(w, b"final output")
        os.close(w)  # EOF arrives in the same drain as the payload

        svc._on_readable(session)

        assert "".join(svc._out_buffers["t-eof"]) == "final output"
        assert closed == ["exit"]
    finally:
        _cancel_pending_flush(svc, "t-eof")
        os.close(r)


@pytest.mark.asyncio
async def test_buffered_size_counter_tracks_the_buffer():
    """The OOM guard reads this counter instead of re-summing the buffer."""
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = SimpleNamespace(id="t-count", master_fd=r, closed=False)
    svc._sessions["t-count"] = session
    try:
        for _ in range(3):
            os.write(w, b"chunk")
            svc._on_readable(session)

        assert svc._out_buf_bytes["t-count"] == sum(
            len(s) for s in svc._out_buffers["t-count"]
        )
        assert svc._out_buf_bytes["t-count"] == 15
    finally:
        _cancel_pending_flush(svc, "t-count")
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_flush_resets_the_size_counter():
    """A stale counter would trip the OOM guard on an empty buffer."""
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = SimpleNamespace(
        id="t-reset", master_fd=r, closed=False, output_log_fp=None
    )
    svc._sessions["t-reset"] = session
    try:
        os.write(w, b"data")
        svc._on_readable(session)
        assert svc._out_buf_bytes["t-reset"] == 4

        svc._flush_output(session)

        assert "t-reset" not in svc._out_buf_bytes
        assert "t-reset" not in svc._out_buffers
    finally:
        _cancel_pending_flush(svc, "t-reset")
        os.close(r)
        os.close(w)
