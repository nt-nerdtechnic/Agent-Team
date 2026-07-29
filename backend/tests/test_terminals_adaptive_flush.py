"""Tests for the adaptive output-flush fast path.

Keystroke echo used to wait the full 50ms batch window before reaching the
renderer, making typing feel laggy (worst for IME input, where the wait lands
on the commit). Low-rate output now flushes on the next loop tick; sustained
streams still fall back to 50ms batching so the Electron flood protection
holds.
"""

import asyncio
import fcntl
import os
from types import SimpleNamespace

import pytest

from agent_team_backend.terminals import (
    _FAST_PATH_MAX_CHUNKS,
    _FAST_PATH_WINDOW_S,
    _OUTPUT_BATCH_MS,
    _READ_CHUNK_BYTES,
    TerminalService,
)


def _nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


async def _emit(_event):  # EventSink stub for tests that never flush
    return None


def _make_session(session_id: str, master_fd: int) -> SimpleNamespace:
    return SimpleNamespace(
        id=session_id,
        master_fd=master_fd,
        closed=False,
        pane_id="pane-1",
        sequence=0,
        output_log_fp=None,
    )


def _pending_delay(svc: TerminalService, session_id: str) -> float:
    handle = svc._out_handles[session_id]
    return handle.when() - svc._loop.time()


def _cancel_pending_flush(svc: TerminalService, session_id: str) -> None:
    handle = svc._out_handles.pop(session_id, None)
    if handle:
        handle.cancel()


@pytest.mark.asyncio
async def test_single_chunk_schedules_immediate_flush():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-fast", r)
    svc._sessions["t-fast"] = session
    try:
        os.write(w, b"x")
        svc._on_readable(session)
        # Interactive rate: flush is scheduled for the next loop tick, not
        # the 50ms batch window.
        assert _pending_delay(svc, "t-fast") < _OUTPUT_BATCH_MS / 1000 / 2
    finally:
        _cancel_pending_flush(svc, "t-fast")
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_sustained_stream_falls_back_to_batching_end_to_end():
    """A burst that saturates the window makes the NEXT flush cycle batch,
    exercising the real production path with NO manual timer surgery.

    Intra-burst, chunks 2..N hit the `session.id in self._out_handles` guard
    and only accumulate timestamps — they do not re-evaluate the delay. So
    batching can only take effect on the flush cycle *after* the window fills.
    This test lets the real delay-0 timer fire, then checks the following
    chunk is batched — the behaviour the old, cancel-happy version masked.
    """
    emitted: list[dict] = []

    async def collect(event):
        emitted.append(event)

    svc = TerminalService(collect)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-stream", r)
    svc._sessions["t-stream"] = session
    try:
        # Burst: first chunk schedules a delay-0 flush; the rest are swallowed
        # by the pending-timer guard and just record arrival times.
        for _ in range(_FAST_PATH_MAX_CHUNKS):
            os.write(w, b"y")
            svc._on_readable(session)
        # Exactly one pending flush, and it is the interactive fast path.
        assert _pending_delay(svc, "t-stream") < _OUTPUT_BATCH_MS / 1000 / 2

        # Let the fast flush fire. The window is now full of recent timestamps.
        await asyncio.sleep(0.01)

        # The next chunk re-evaluates _flush_delay and now sees a saturated
        # window → batches at _OUTPUT_BATCH_MS.
        os.write(w, b"z")
        svc._on_readable(session)
        assert _pending_delay(svc, "t-stream") > _OUTPUT_BATCH_MS / 1000 / 2
    finally:
        _cancel_pending_flush(svc, "t-stream")
        try:
            svc._loop.remove_reader(r)  # re-added by the first flush's drain task
        except (ValueError, KeyError):
            pass
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_one_viewport_repaint_stays_on_the_fast_path():
    """A full-screen CLI rewrites its whole viewport on every keystroke — tens
    of KB at once. Read 4 KB at a time that became enough chunks to saturate
    the window, so a typist's echo paid the 50ms batch delay on every key and
    the window never cooled down while they kept typing."""
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    _nonblocking(w)  # a repaint must not block on the pipe's capacity
    session = _make_session("t-repaint", r)
    svc._sessions["t-repaint"] = session
    try:
        written = os.write(w, b"x" * (_READ_CHUNK_BYTES // 2))
        if written <= _FAST_PATH_MAX_CHUNKS * 4096:
            pytest.skip(f"pipe capacity {written}B too small to model a repaint")
        # The loop's reader callback is level-triggered: it keeps firing until
        # the fd is drained, which is what turned one repaint into many chunks.
        for _ in range(_FAST_PATH_MAX_CHUNKS + 2):
            svc._on_readable(session)

        # One repaint = one chunk, so the next flush stays interactive.
        assert len(svc._chunk_times["t-repaint"]) == 1
        assert svc._flush_delay("t-repaint") == 0.0
        assert _pending_delay(svc, "t-repaint") < _OUTPUT_BATCH_MS / 1000 / 2
    finally:
        _cancel_pending_flush(svc, "t-repaint")
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_quiet_period_restores_fast_path():
    svc = TerminalService(_emit)
    now = svc._loop.time()
    from collections import deque

    stale = now - _FAST_PATH_WINDOW_S * 10
    svc._chunk_times["t-idle"] = deque(
        [stale] * _FAST_PATH_MAX_CHUNKS, maxlen=_FAST_PATH_MAX_CHUNKS
    )
    assert svc._flush_delay("t-idle") == 0.0
    # And a saturated recent window batches.
    svc._chunk_times["t-busy"] = deque(
        [now] * _FAST_PATH_MAX_CHUNKS, maxlen=_FAST_PATH_MAX_CHUNKS
    )
    assert svc._flush_delay("t-busy") == _OUTPUT_BATCH_MS / 1000


@pytest.mark.asyncio
async def test_fast_path_emits_within_a_tick():
    emitted: list[dict] = []

    async def collect(event):
        emitted.append(event)

    svc = TerminalService(collect)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-emit", r)
    svc._sessions["t-emit"] = session
    try:
        os.write(w, "中".encode("utf-8"))
        svc._on_readable(session)
        # A couple of loop ticks — far less than the 50ms batch window.
        await asyncio.sleep(0.01)
        assert len(emitted) == 1
        assert emitted[0]["payload"]["data"] == "中"
    finally:
        _cancel_pending_flush(svc, "t-emit")
        try:
            svc._loop.remove_reader(r)  # re-added by _flush_output's drain task
        except (ValueError, KeyError):
            pass
        os.close(r)
        os.close(w)
