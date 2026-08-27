"""Loop-stall watchdog: does it name a stall the loop itself cannot report.

The point of the split design (issue #24) is that the reporter must not live on
the loop it watches, so every test here blocks the loop for real with
``time.sleep`` inside a coroutine and asserts the daemon thread still spoke.
"""

from __future__ import annotations

import asyncio
import logging
import time

import pytest

from agent_team_backend import loop_watchdog


@pytest.fixture()
def fast_watchdog(monkeypatch: pytest.MonkeyPatch):
    """Same behaviour, test-scale timings."""
    monkeypatch.setattr(loop_watchdog, "TICK_INTERVAL_S", 0.02)
    monkeypatch.setattr(loop_watchdog, "STALL_THRESHOLD_S", 0.1)
    return loop_watchdog


def _messages(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]


def _stalls(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [m for m in _messages(caplog) if "stalled for" in m]


def _recoveries(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [m for m in _messages(caplog) if "recovered" in m]


async def _stall_loop(seconds: float) -> None:
    """Block the event-loop thread, then let it turn again."""
    time.sleep(seconds)
    await asyncio.sleep(0.15)


@pytest.mark.asyncio
async def test_stall_is_reported_with_the_loop_thread_stack(
    fast_watchdog, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    fast_watchdog.start(asyncio.get_running_loop())
    try:
        await asyncio.sleep(0.05)  # let the ticker stamp at least once
        await _stall_loop(0.4)
    finally:
        await fast_watchdog.stop()

    stalls = _stalls(caplog)
    assert len(stalls) == 1
    # The stack must be the *loop* thread's, i.e. the frame that is blocking.
    assert "test_loop_watchdog.py" in stalls[0]
    assert "_stall_loop" in stalls[0]


@pytest.mark.asyncio
async def test_one_stall_logs_once_and_reports_recovery(
    fast_watchdog, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    fast_watchdog.start(asyncio.get_running_loop())
    try:
        await asyncio.sleep(0.05)
        # Long enough for the watcher thread to poll many times over one stall.
        await _stall_loop(0.5)
    finally:
        await fast_watchdog.stop()

    assert len(_stalls(caplog)) == 1
    assert len(_recoveries(caplog)) == 1


@pytest.mark.asyncio
async def test_rearms_after_recovery(
    fast_watchdog, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    fast_watchdog.start(asyncio.get_running_loop())
    try:
        await asyncio.sleep(0.05)
        await _stall_loop(0.3)
        await _stall_loop(0.3)
    finally:
        await fast_watchdog.stop()

    assert len(_stalls(caplog)) == 2
    assert len(_recoveries(caplog)) == 2


@pytest.mark.asyncio
async def test_healthy_loop_stays_silent(
    fast_watchdog, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    fast_watchdog.start(asyncio.get_running_loop())
    try:
        await asyncio.sleep(0.3)
    finally:
        await fast_watchdog.stop()

    assert _messages(caplog) == []


@pytest.mark.asyncio
async def test_stop_joins_the_watcher_thread(fast_watchdog) -> None:
    fast_watchdog.start(asyncio.get_running_loop())
    thread = fast_watchdog._watchdog._thread
    assert thread is not None and thread.daemon
    await fast_watchdog.stop()
    assert not thread.is_alive()
    assert fast_watchdog._watchdog._thread is None
