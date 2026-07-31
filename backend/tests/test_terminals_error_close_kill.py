"""A PTY read error must not leak a still-running child.

_close(reason="error") pops the session from _sessions, after which the child
is unreachable (terminal.kill can't find it, kill_all won't sweep it) — yet
its tty is gone, so nobody can ever interact with it again. Observed as idle
CLI processes surviving until the next backend restart's reap_stale.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend.terminals import TerminalService


async def _noop_emit(event: dict[str, Any]) -> None:
    return None


async def _wait_dead(session: Any, timeout_s: float = 5.0) -> None:
    deadline = asyncio.get_event_loop().time() + timeout_s
    while session.proc.poll() is None and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_error_close_kills_surviving_child() -> None:
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    assert session.proc.poll() is None

    svc._close(session, reason="error")

    assert session.id not in svc._sessions
    await _wait_dead(session)
    assert session.proc.poll() is not None


@pytest.mark.asyncio
async def test_error_close_escalates_to_sigkill_for_term_trapping_child() -> None:
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=["sh", "-c", 'trap "" TERM; sleep 30'],
        cwd="/",
    )
    # Give the shell a moment to install the TERM trap before signalling.
    await asyncio.sleep(0.3)

    svc._close(session, reason="error")

    await _wait_dead(session)
    assert session.proc.poll() is not None


@pytest.mark.asyncio
async def test_exit_close_does_not_kill() -> None:
    # reason="exit" means the child died on its own — the error-survivor kill
    # must not fire there (poll() is already non-None, nothing to put down).
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "0.1"], cwd="/")
    await _wait_dead(session)
    svc._close(session, reason="exit")
    assert session.id not in svc._sessions
