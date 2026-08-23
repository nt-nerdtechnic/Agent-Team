"""The slow-send probe: does a stalled frame blame the lock or the transport?

`pty reader suspended ... held=N` cannot tell the two apart, and they call for
opposite fixes (give heartbeats their own path vs. send less). These tests pin
the attribution and the throttle that keeps the probe from making a stall worse.

_note_send_timing takes all three timestamps, so these drive it with plain
numbers — no clock patching, which would derange the event loop that schedules
on the same clock. The tests are async only because constructing a Session
reaches TerminalService, which wants a running loop.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from agent_team_backend import app


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_fast_send_is_not_reported(caplog: pytest.LogCaptureFixture) -> None:
    session = _session()
    with caplog.at_level(logging.WARNING, logger="agent_team_backend"):
        session._note_send_timing(1000.0, 1000.0, 1000.05)  # 50ms total
    assert "slow ws send" not in caplog.text


@pytest.mark.asyncio
async def test_transport_backpressure_is_attributed_to_transport(
    caplog: pytest.LogCaptureFixture,
) -> None:
    session = _session()
    # Lock acquired instantly, then 1.2s inside the send: the peer is not
    # draining, so giving the heartbeat its own path would not have helped.
    with caplog.at_level(logging.WARNING, logger="agent_team_backend"):
        session._note_send_timing(1000.0, 1000.0, 1001.2)
    assert "slow ws send: total=1200ms lock_wait=0ms transport=1200ms" in caplog.text


@pytest.mark.asyncio
async def test_lock_contention_is_attributed_to_the_lock(
    caplog: pytest.LogCaptureFixture,
) -> None:
    session = _session()
    # 900ms waiting behind another producer, then a quick send — this is the
    # half a dedicated heartbeat path could skip.
    with caplog.at_level(logging.WARNING, logger="agent_team_backend"):
        session._note_send_timing(1000.0, 1000.9, 1000.9)
    assert "slow ws send: total=900ms lock_wait=900ms transport=0ms" in caplog.text


@pytest.mark.asyncio
async def test_bursts_are_throttled_and_counted(caplog: pytest.LogCaptureFixture) -> None:
    session = _session()
    with caplog.at_level(logging.WARNING, logger="agent_team_backend"):
        session._note_send_timing(1000.0, 1000.0, 1001.0)  # reported
        session._note_send_timing(1001.0, 1001.0, 1002.0)  # 1s later -> suppressed
        session._note_send_timing(1002.0, 1002.0, 1003.0)  # 2s later -> suppressed
        session._note_send_timing(1020.0, 1020.0, 1021.0)  # past the 10s floor -> reported

    lines = [line for line in caplog.text.splitlines() if "slow ws send" in line]
    assert len(lines) == 2, lines
    # Suppressed lines are surfaced by the next one through, so throttling
    # never makes the log understate the problem.
    assert "(+2 suppressed)" in lines[1]


@pytest.mark.asyncio
async def test_first_slow_send_reports_even_on_a_clock_near_zero(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A 0.0 throttle baseline would swallow this one."""
    session = _session()
    with caplog.at_level(logging.WARNING, logger="agent_team_backend"):
        session._note_send_timing(0.0, 0.0, 1.0)
    assert "slow ws send" in caplog.text


@pytest.mark.asyncio
async def test_probe_does_not_swallow_the_payload() -> None:
    ws = FakeWebSocket()
    session = app.Session(ws)  # type: ignore[arg-type]
    await session.send_json({"type": "terminal.output", "payload": {"x": 1}})
    assert ws.sent == [{"type": "terminal.output", "payload": {"x": 1}}]
