"""Regression tests for TerminalService input writes under back-pressure.

The PTY master fd is non-blocking, so a full kernel buffer raises EAGAIN. The
old write() dropped the chunk on EAGAIN — silent data loss that left the agent's
input box empty while the caller logged "✓ sent". These tests pin the fix: bytes
are buffered and drained via add_writer, never dropped, and stay in order.

A plain os.pipe() stands in for the PTY master: it is also non-blocking and
raises EAGAIN when full, without the line-discipline rewriting that a real pty
would apply to the bytes we assert on.
"""

import asyncio
import fcntl
import os
from types import SimpleNamespace

import pytest

from agent_team_backend.terminals import TerminalService


def _nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


async def _emit(_event):  # EventSink stub — never actually called on this path
    return None


async def test_small_write_completes_immediately():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(w)
    session = SimpleNamespace(id="t1", master_fd=w, closed=False, agent_key="claude")
    svc._sessions["t1"] = session
    try:
        svc.write("t1", "hello")
        # Fully accepted: nothing buffered, no writer registered.
        assert len(svc._in_buffers["t1"]) == 0
        assert os.read(r, 1024) == b"hello"
    finally:
        os.close(r)
        os.close(w)


async def test_write_survives_eagain_without_data_loss():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(w)
    _nonblocking(r)
    session = SimpleNamespace(id="t1", master_fd=w, closed=False, agent_key="claude")
    svc._sessions["t1"] = session
    try:
        payload = b"A" * 500_000  # far exceeds the pipe buffer → guaranteed EAGAIN
        svc.write("t1", payload.decode())

        # The remainder the kernel refused must be buffered, not dropped.
        assert len(svc._in_buffers["t1"]) > 0

        received = bytearray()
        for _ in range(100_000):
            if len(received) >= len(payload):
                break
            await asyncio.sleep(0)  # let the add_writer callback drain the buffer
            try:
                received.extend(os.read(r, 65536))
            except BlockingIOError:
                await asyncio.sleep(0.002)

        # Everything arrived, in order, and the buffer drained to empty.
        assert bytes(received) == payload
        assert len(svc._in_buffers["t1"]) == 0
    finally:
        svc._unwatch_writable(session)
        os.close(r)
        os.close(w)


async def test_closed_session_write_is_noop():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(w)
    session = SimpleNamespace(id="t1", master_fd=w, closed=True, agent_key="claude")
    svc._sessions["t1"] = session
    try:
        svc.write("t1", "ignored")
        # closed → nothing buffered, nothing written.
        assert "t1" not in svc._in_buffers or len(svc._in_buffers["t1"]) == 0
    finally:
        os.close(r)
        os.close(w)
