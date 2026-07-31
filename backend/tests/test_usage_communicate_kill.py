"""_communicate_or_kill must reap the child on timeout.

A bare wait_for(proc.communicate()) that times out leaves the spawned
`security`/`gh`/CLI child running (and never reaped) — each hung probe leaked
one process until app exit.
"""
from __future__ import annotations

import asyncio

import pytest

from agent_team_backend import usage_service


async def test_kills_and_reaps_on_timeout() -> None:
    proc = await asyncio.create_subprocess_exec(
        "sleep", "30", stdout=asyncio.subprocess.PIPE
    )
    with pytest.raises(asyncio.TimeoutError):
        await usage_service._communicate_or_kill(proc, timeout=0.1)
    assert proc.returncode is not None


async def test_returns_stdout_within_timeout() -> None:
    proc = await asyncio.create_subprocess_exec(
        "echo", "hello", stdout=asyncio.subprocess.PIPE
    )
    out = await usage_service._communicate_or_kill(proc, timeout=5.0)
    assert out.decode().strip() == "hello"
