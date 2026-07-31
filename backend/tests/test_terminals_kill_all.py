"""kill_all() must terminate every PTY child on backend shutdown.

Children are spawned with start_new_session=True (own process group), so a
dying backend never propagates signals to them — without an explicit sweep
they outlive the app as orphans (observed: 30+ orphaned CLI processes driving
load average past 200).
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend.terminals import TerminalService


async def _noop_emit(event: dict[str, Any]) -> None:
    return None


@pytest.mark.asyncio
async def test_kill_all_terminates_children() -> None:
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    await svc.kill_all(grace=0.5)
    assert session.proc.poll() is not None
    assert svc._sessions == {}


@pytest.mark.asyncio
async def test_kill_all_terminates_many_children_with_one_snapshot() -> None:
    # The descendant sweep now takes ONE shared ps snapshot for all sessions
    # (a per-session snapshot pushed shutdown past Electron's SIGKILL
    # deadline). Every child must still die.
    svc = TerminalService(emit=_noop_emit)
    sessions = [
        svc.create(pane_id=f"p{i}", agent_key=None, command=["sleep", "30"], cwd="/")
        for i in range(3)
    ]
    await svc.kill_all(grace=0.5)
    for session in sessions:
        assert session.proc.poll() is not None
    assert svc._sessions == {}


@pytest.mark.asyncio
async def test_kill_all_escalates_to_sigkill() -> None:
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=["sh", "-c", 'trap "" TERM; sleep 30'],
        cwd="/",
    )
    # Give the shell a moment to install the TERM trap before signalling.
    await asyncio.sleep(0.3)
    await svc.kill_all(grace=0.3)
    # SIGKILL delivery is asynchronous; poll briefly until the child is reaped.
    for _ in range(20):
        if session.proc.poll() is not None:
            break
        await asyncio.sleep(0.05)
    assert session.proc.poll() is not None
    assert svc._sessions == {}
