"""The ownerless-PTY janitor kills PTYs whose owning WebSocket never returned.

PTYs deliberately survive a WS disconnect (reattach after reload), but a
renderer that never reclaims one leaves it running detached forever — observed
as hours-idle `claude --resume` processes at 200-400MB each. The janitor kills
only after a full ownerless grace period, and forgets a PTY the moment it is
reclaimed or dies.
"""
from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app


class FakeTerminals:
    def __init__(self, live: list[str]) -> None:
        self.live = list(live)
        self.killed: list[tuple[str, bool]] = []

    def list_session_ids(self) -> list[str]:
        return list(self.live)

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append((session_id, force))
        self.live = [tid for tid in self.live if tid != session_id]


@pytest.fixture()
def janitor_env(monkeypatch: pytest.MonkeyPatch) -> FakeTerminals:
    fake = FakeTerminals(live=[])
    monkeypatch.setattr(app, "_TERMINALS", fake)
    monkeypatch.setattr(app, "_PTY_OWNERS", {})
    monkeypatch.setattr(app, "_OWNERLESS_SINCE", {})
    return fake


async def test_owned_ptys_are_never_candidates(janitor_env: FakeTerminals) -> None:
    janitor_env.live = ["t-owned"]
    app._PTY_OWNERS["t-owned"] = object()
    assert await app._sweep_ownerless_ptys_once(now=0.0) == []
    assert await app._sweep_ownerless_ptys_once(now=app._OWNERLESS_GRACE_SEC * 2) == []
    assert janitor_env.killed == []
    assert app._OWNERLESS_SINCE == {}


async def test_ownerless_pty_killed_only_after_grace(janitor_env: FakeTerminals) -> None:
    janitor_env.live = ["t-orphan"]
    # First sighting records the timestamp, no kill.
    assert await app._sweep_ownerless_ptys_once(now=100.0) == []
    assert "t-orphan" in app._OWNERLESS_SINCE
    # Still within grace: no kill.
    assert await app._sweep_ownerless_ptys_once(
        now=100.0 + app._OWNERLESS_GRACE_SEC - 1.0
    ) == []
    assert janitor_env.killed == []
    # Grace elapsed: killed (force) and no longer tracked.
    assert await app._sweep_ownerless_ptys_once(
        now=100.0 + app._OWNERLESS_GRACE_SEC
    ) == ["t-orphan"]
    assert janitor_env.killed == [("t-orphan", True)]
    assert app._OWNERLESS_SINCE == {}


async def test_reclaimed_pty_resets_its_clock(janitor_env: FakeTerminals) -> None:
    janitor_env.live = ["t1"]
    await app._sweep_ownerless_ptys_once(now=100.0)
    # A window reattaches before the grace elapses — candidate forgotten.
    app._PTY_OWNERS["t1"] = object()
    assert await app._sweep_ownerless_ptys_once(
        now=100.0 + app._OWNERLESS_GRACE_SEC
    ) == []
    assert "t1" not in app._OWNERLESS_SINCE
    # Ownerless again later: the clock starts over from the new sighting.
    del app._PTY_OWNERS["t1"]
    now2 = 100.0 + app._OWNERLESS_GRACE_SEC + 50.0
    assert await app._sweep_ownerless_ptys_once(now=now2) == []
    assert app._OWNERLESS_SINCE["t1"] == now2
    assert janitor_env.killed == []


async def test_dead_pty_dropped_from_tracking(janitor_env: FakeTerminals) -> None:
    janitor_env.live = ["t1"]
    await app._sweep_ownerless_ptys_once(now=100.0)
    janitor_env.live = []
    assert await app._sweep_ownerless_ptys_once(
        now=100.0 + app._OWNERLESS_GRACE_SEC
    ) == []
    assert app._OWNERLESS_SINCE == {}
    assert janitor_env.killed == []


async def test_sweep_noop_without_terminal_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "_TERMINALS", None)
    assert await app._sweep_ownerless_ptys_once(now=0.0) == []
