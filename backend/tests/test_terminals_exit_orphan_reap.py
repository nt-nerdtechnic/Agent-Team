"""Tests for reaping orphans after a PTY child dies on its own.

kill() (pane close) snapshots the descendant tree while the child is alive and
sweeps breakaway grandchildren. But when the child dies by itself — crash,
external SIGKILL — the EOF path runs _close with no sweep, and grandchildren
that live in their own process group (e.g. MCP servers a CLI spawns detached)
leak as orphans (observed: `npm exec @upstash/context7-mcp` pairs reparented to
the backend, surviving for days). The fix: a rolling per-session descendant
snapshot (pid -> lstart) plus a batch sweeper that kills snapshot pids now
orphaned (reparented to launchd or this process), identity-checked via lstart
to defeat pid recycling, along with their current subtrees. Detached
descendants are also persisted to pty_registry for the backend-crash path.

The setsid-grandchild harness and ps stubs are shared with
test_terminals_breakaway_kill.py via conftest fixtures.
"""
from __future__ import annotations

import asyncio
import os
import signal
import time
from typing import Any

import pytest

from agent_team_backend import terminals
from agent_team_backend.terminals import (
    TerminalService,
    _children_map,
    _ps_snapshot,
    _walk_descendants,
)


async def _noop_emit(event: dict[str, Any]) -> None:
    return None


# ---- _ps_snapshot: parsing ----

def test_ps_snapshot_parses_fields_and_skips_garbage(monkeypatch, fake_ps):
    table = (
        "100 1 100 Thu Jul 24 10:05:00 2026\n"
        "200 100 200 Thu Jul 24 10:05:03 2026\n"
        "BAD\n\n"
        "300 200 100\n"
    )
    monkeypatch.setattr(terminals.subprocess, "run", fake_ps(table))
    assert _ps_snapshot() == {
        100: (1, 100, "Thu Jul 24 10:05:00 2026"),
        200: (100, 200, "Thu Jul 24 10:05:03 2026"),
        300: (200, 100, ""),
    }


def test_ps_snapshot_empty_on_failure(monkeypatch):
    def boom(*a, **k):
        raise OSError("no ps")
    monkeypatch.setattr(terminals.subprocess, "run", boom)
    assert _ps_snapshot() == {}


# ---- _refresh_descendants: rolling snapshot + registry payload ----

async def test_refresh_updates_sessions_and_returns_detached_only_payload():
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    try:
        pid = session.proc.pid
        # tree: child -> 900 (detached, own group) -> 901 (900's group),
        # child -> 902 (same group as child: transient helper), unrelated 999
        snap = {
            pid: (os.getpid(), pid, "L-child"),
            900: (pid, 900, "L900"),
            901: (900, 900, "L901"),
            902: (pid, pid, "L902"),
            999: (1, 999, "L999"),
        }
        payload = svc._refresh_descendants(snap)
        # In-memory snapshot keeps the whole tree (runtime reaper needs it)…
        assert session.descendants == {900: "L900", 901: "L901", 902: "L902"}
        # …but only descendants outside the root's group are registry-worthy.
        assert payload == {pid: {900: "L900", 901: "L901"}}
    finally:
        await svc.kill_all(grace=0.3)


async def test_refresh_keeps_last_snapshot_on_ps_failure_or_missing_root():
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    try:
        pid = session.proc.pid
        svc._refresh_descendants({pid: (os.getpid(), pid, "L"), 900: (pid, 900, "L900")})
        assert session.descendants == {900: "L900"}
        # ps failure ({}) must not wipe the good snapshot.
        assert svc._refresh_descendants({}) == {}
        assert session.descendants == {900: "L900"}
        # Child absent from the table (death racing EOF) — keep the snapshot.
        svc._refresh_descendants({999: (1, 999, "L999")})
        assert session.descendants == {900: "L900"}
    finally:
        await svc.kill_all(grace=0.3)


# ---- _reap_exit_orphans: orphan check + lstart identity + subtree kill ----

async def test_snapshot_loop_persists_descendants_to_registry(monkeypatch):
    # The rolling snapshot must reach the crash-recovery registry so a
    # SIGKILLed backend leaves the next start enough to reap detached
    # grandchildren (backend-crash path of the same leak).
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    pid = session.proc.pid
    persisted: list[dict[int, dict[int, str]]] = []
    monkeypatch.setattr(
        terminals.pty_registry, "update_descendants", persisted.append
    )
    monkeypatch.setattr(
        terminals, "_ps_snapshot",
        lambda: {pid: (os.getpid(), pid, "L-child"), 900: (pid, 900, "L900")},
    )
    try:
        await asyncio.sleep(0.2)  # first snapshot tick runs on the fake table
        assert persisted and persisted[-1] == {pid: {900: "L900"}}
    finally:
        await svc.kill_all(grace=0.3)


async def test_reap_kills_orphaned_snapshot_pids_and_their_subtree(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    me = os.getpid()
    # Snapshot was {200, 300, 400}. Now: 200 reparented to launchd with a
    # fresh child 250; 300 reparented to this backend; 400 still has a live
    # parent (555) — must be spared, as must unrelated 999.
    snap = {
        200: (1, 200, "L200"),
        250: (200, 200, "L250"),
        300: (me, 300, "L300"),
        400: (555, 400, "L400"),
        555: (1, 555, "L555"),
        999: (1, 999, "L999"),
    }
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: snap)
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "L200", 300: "L300", 400: "L400"})
    assert sorted(killed) == [200, 250, 300]


async def test_reap_spares_recycled_pid_via_lstart_mismatch(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    # pid 200 was recycled: same number, launchd-parented, different lstart.
    snap = {200: (1, 200, "L-new-process")}
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: snap)
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "L-original"})
    assert killed == []


async def test_reap_noop_when_ps_fails(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: {})
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "L200"})
    assert killed == []


# ---- batch sweeper wiring ----

async def test_close_schedules_reap_on_exit_but_not_on_kill(monkeypatch):
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 0.01)
    reaped: list[list[int]] = []

    async def fake_reap(self, descendants):
        reaped.append(sorted(descendants))

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", fake_reap)

    svc = TerminalService(emit=_noop_emit)
    # Natural exit: short-lived child, snapshot pre-seeded.
    s1 = svc.create(pane_id="p1", agent_key=None, command=["sh", "-c", "exit 0"], cwd="/")
    s1.descendants = {111: ""}
    for _ in range(100):
        if s1.closed:
            break
        await asyncio.sleep(0.05)
    assert s1.closed
    await asyncio.sleep(0.1)  # let the batch sweeper's grace elapse and run
    assert reaped == [[111]]

    # kill() path: must NOT queue for the exit reaper (it sweeps on its own).
    s2 = svc.create(pane_id="p2", agent_key=None, command=["sleep", "30"], cwd="/")
    s2.descendants = {222: ""}
    await svc.kill(s2.id, force=True)
    await asyncio.sleep(0.2)
    assert reaped == [[111]]
    await svc.kill_all(grace=0.3)


async def test_queued_deaths_share_one_sweep(monkeypatch):
    # Everything queued before the sweeper's drain is merged into ONE
    # _reap_exit_orphans call (one ps for the whole batch).
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 0.05)
    reaped: list[list[int]] = []

    async def fake_reap(self, descendants):
        reaped.append(sorted(descendants))

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", fake_reap)

    svc = TerminalService(emit=_noop_emit)
    svc._pending_reaps.update({111: "", 222: ""})
    await svc._reap_pending_orphans()
    assert reaped == [[111, 222]]


async def test_death_during_grace_waits_for_next_full_grace(monkeypatch):
    # A death landing while a batch sleeps its grace must NOT ride that batch
    # with a truncated grace — it is swept in the next round.
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 0.2)
    reaped: list[list[int]] = []

    async def fake_reap(self, descendants):
        reaped.append(sorted(descendants))

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", fake_reap)

    svc = TerminalService(emit=_noop_emit)
    svc._pending_reaps.update({111: ""})
    task = asyncio.get_running_loop().create_task(svc._reap_pending_orphans())
    await asyncio.sleep(0.05)  # batch 1 is mid-grace
    svc._pending_reaps.update({222: ""})
    await task
    assert reaped == [[111], [222]]


async def test_sweeper_survives_reap_exception(monkeypatch):
    # One failing sweep must not kill the sweeper: later batches still run.
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 0.05)
    calls: list[list[int]] = []

    async def flaky_reap(self, descendants):
        calls.append(sorted(descendants))
        if len(calls) == 1:
            raise RuntimeError("executor shutting down")

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", flaky_reap)

    svc = TerminalService(emit=_noop_emit)
    svc._pending_reaps.update({111: ""})
    task = asyncio.get_running_loop().create_task(svc._reap_pending_orphans())
    await asyncio.sleep(0.02)  # batch 1 is mid-grace; queue a second death
    svc._pending_reaps.update({222: ""})
    await task  # batch 1's reap raises, batch 2 must still be swept
    assert calls == [[111], [222]]


# ---- integration: a real detached grandchild orphaned by parent death ----

@pytest.mark.skipif(not hasattr(os, "setsid"), reason="needs POSIX setsid")
async def test_exit_orphan_reaped_end_to_end(
    setsid_grandchild, pid_alive, wait_pid_dead
):
    # SIGKILL the parent (simulating a CLI crash — no kill() sweep runs): the
    # setsid grandchild is orphaned. _reap_exit_orphans with the pre-death
    # snapshot must take it down (real lstart identities match).
    parent, grand_pid = setsid_grandchild

    # Rolling snapshot (with real lstart) taken while the parent lives.
    snap = _ps_snapshot()
    pids = _walk_descendants(_children_map(snap), parent.pid)
    descendants = {pid: snap[pid][2] for pid in pids}
    assert grand_pid in descendants

    # Parent dies ungracefully; grandchild survives as an orphan.
    os.killpg(os.getpgid(parent.pid), signal.SIGKILL)
    parent.wait(timeout=2)
    time.sleep(0.1)
    assert pid_alive(grand_pid), "grandchild should survive the parent's death"

    svc = TerminalService(emit=_noop_emit)
    await svc._reap_exit_orphans(descendants)
    assert wait_pid_dead(grand_pid), "orphan must be reaped by _reap_exit_orphans"
