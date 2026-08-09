"""Tests for the input-latency probes.

A CLI pane has no local echo, so every keystroke is a full round-trip and any
stall on that path is directly visible as "typing lags". The path used to log
nothing at all, which left a lag report with no way to tell a slow echo apart
from a stalled WS drain apart from a CLI that stopped reading its stdin. These
probes are silent on a healthy session and name the guilty segment on a sick
one.
"""

import asyncio
import fcntl
import logging
import os
from types import SimpleNamespace

import pytest

from agent_team_backend.terminals import (
    _ECHO_LAG_MAX_MS,
    _ECHO_LAG_WARN_MS,
    _ECHO_PROBE_MAX_INPUT_CHARS,
    _READER_SUSPEND_WARN_MS,
    TerminalService,
)


def _nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


async def _emit(_event):
    return None


def _make_session(session_id: str, master_fd: int) -> SimpleNamespace:
    return SimpleNamespace(
        id=session_id,
        master_fd=master_fd,
        closed=False,
        pane_id="pane-1",
        sequence=0,
        output_log_fp=None,
        agent_key="claude",
    )


def _detach(svc: TerminalService, fd: int) -> None:
    """Drop the reader the drain task re-adds, before the fd is closed."""
    try:
        svc._loop.remove_reader(fd)
    except (ValueError, KeyError):
        pass


@pytest.mark.asyncio
async def test_keystroke_arms_the_echo_probe():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(w)
    session = _make_session("t-arm", w)
    svc._sessions["t-arm"] = session
    try:
        svc.write("t-arm", "a")
        assert "t-arm" in svc._echo_probe
    finally:
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_bulk_write_does_not_arm_the_probe():
    """Role injection and pastes are bulk writes whose echo is legitimately
    slower — timing them would report lag the user never felt."""
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(w)
    session = _make_session("t-bulk", w)
    svc._sessions["t-bulk"] = session
    try:
        svc.write("t-bulk", "x" * (_ECHO_PROBE_MAX_INPUT_CHARS + 1))
        assert "t-bulk" not in svc._echo_probe
    finally:
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_only_the_first_keystroke_of_a_burst_is_timed():
    """A fast typist must not keep resetting the clock, or the lag they are
    feeling would never cross the threshold."""
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(w)
    session = _make_session("t-burst", w)
    svc._sessions["t-burst"] = session
    try:
        svc.write("t-burst", "a")
        first = svc._echo_probe["t-burst"]
        await asyncio.sleep(0.01)
        svc.write("t-burst", "b")
        assert svc._echo_probe["t-burst"] == first
    finally:
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_slow_echo_is_reported(caplog):
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-lag", r)
    svc._sessions["t-lag"] = session
    try:
        svc._echo_probe["t-lag"] = svc._loop.time() - (_ECHO_LAG_WARN_MS + 50) / 1000
        svc._out_buffers["t-lag"] = ["echo"]
        with caplog.at_level(logging.WARNING):
            svc._flush_output(session)
        assert "input echo lag" in caplog.text
        assert "agent=claude" in caplog.text
        # Consumed, so the next flush does not re-report the same keystroke.
        assert "t-lag" not in svc._echo_probe
    finally:
        await asyncio.sleep(0)
        _detach(svc, r)
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_prompt_echo_is_silent(caplog):
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-quick", r)
    svc._sessions["t-quick"] = session
    try:
        svc._echo_probe["t-quick"] = svc._loop.time()
        svc._out_buffers["t-quick"] = ["echo"]
        with caplog.at_level(logging.WARNING):
            svc._flush_output(session)
        assert "input echo lag" not in caplog.text
    finally:
        await asyncio.sleep(0)
        _detach(svc, r)
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_output_long_after_the_keystroke_is_not_called_an_echo(caplog):
    """Past the ceiling the CLI was simply busy; blaming the keystroke would
    fill the log with lag numbers nobody can act on."""
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-busy", r)
    svc._sessions["t-busy"] = session
    try:
        svc._echo_probe["t-busy"] = svc._loop.time() - (_ECHO_LAG_MAX_MS + 1000) / 1000
        svc._out_buffers["t-busy"] = ["late output"]
        with caplog.at_level(logging.WARNING):
            svc._flush_output(session)
        assert "input echo lag" not in caplog.text
    finally:
        await asyncio.sleep(0)
        _detach(svc, r)
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_a_resize_drain_does_not_masquerade_as_an_echo(caplog):
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-resize", r)
    svc._sessions["t-resize"] = session
    try:
        svc._echo_probe["t-resize"] = svc._loop.time() - (_ECHO_LAG_WARN_MS + 50) / 1000
        with caplog.at_level(logging.WARNING):
            await svc.drain_output("t-resize")
        assert "t-resize" not in svc._echo_probe
        assert "input echo lag" not in caplog.text
    finally:
        _detach(svc, r)
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_long_reader_suspension_is_reported(caplog):
    """Nothing is read from the PTY while the WS drains, so a long drain is
    the backpressure that eventually blocks the CLI's own writes."""
    hold = (_READER_SUSPEND_WARN_MS + 60) / 1000

    async def slow_emit(_event):
        await asyncio.sleep(hold)

    svc = TerminalService(slow_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-held", r)
    svc._sessions["t-held"] = session
    try:
        svc._out_buffers["t-held"] = ["payload"]
        with caplog.at_level(logging.WARNING):
            svc._flush_output(session)
            await asyncio.sleep(hold + 0.05)
        assert "pty reader suspended" in caplog.text
    finally:
        _detach(svc, r)
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_fast_drain_is_silent(caplog):
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-fastdrain", r)
    svc._sessions["t-fastdrain"] = session
    try:
        svc._out_buffers["t-fastdrain"] = ["payload"]
        with caplog.at_level(logging.WARNING):
            svc._flush_output(session)
            await asyncio.sleep(0.02)
        assert "pty reader suspended" not in caplog.text
    finally:
        _detach(svc, r)
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_blocked_pty_input_is_reported_once(caplog):
    """A full kernel buffer means the CLI stopped reading stdin — the user sees
    typed characters simply not appear. Logged on the transition only, so a
    stuck session cannot flood the log from the writable retries."""
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(w)
    session = _make_session("t-blocked", w)
    svc._sessions["t-blocked"] = session
    try:
        with caplog.at_level(logging.WARNING):
            # Fill the pipe until the kernel refuses the rest.
            for _ in range(64):
                svc.write("t-blocked", "x" * 8192)
                if "t-blocked" in svc._input_blocked:
                    break
            assert "t-blocked" in svc._input_blocked, "pipe never filled"
            first = caplog.text.count("pty input blocked")
            svc._flush_input(session)  # the add_writer retry
            assert caplog.text.count("pty input blocked") == first == 1
    finally:
        svc._unwatch_writable(session)
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_input_unblocks_and_can_report_again(caplog):
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(w)
    session = _make_session("t-unblock", w)
    svc._sessions["t-unblock"] = session
    try:
        with caplog.at_level(logging.WARNING):
            for _ in range(64):
                svc.write("t-unblock", "x" * 8192)
                if "t-unblock" in svc._input_blocked:
                    break
            assert "t-unblock" in svc._input_blocked, "pipe never filled"
            # Drain the reader end so the PTY accepts the backlog again.
            while True:
                try:
                    if not os.read(r, 65536):
                        break
                except BlockingIOError:
                    break
                svc._flush_input(session)
                if "t-unblock" not in svc._input_blocked:
                    break
            assert "t-unblock" not in svc._input_blocked
    finally:
        svc._unwatch_writable(session)
        os.close(r)
        os.close(w)
