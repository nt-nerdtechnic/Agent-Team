"""LogWatcher activity-dedup memory bound.

Regression tests for the backend's largest retained structure. `_activity_seen`
holds one dedup key per transcript line ever parsed, per file, and used to hold
them for the whole process lifetime. Measured 2026-08-18 on a zero-pane startup
scan of 5209 Claude transcripts: 452,693 retained keys two minutes in, holding
481 MB of pymalloc arenas that CPython can never return (an arena is only
munmap'd once completely empty, and these keys are allocated interleaved with
the transient json.loads garbage of the same scan, so they land in every one).
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

from agent_team_backend.log_readers.base import LogReader

from agent_team_backend.log_readers.watcher import (
    _ACTIVITY_SEEN_COLD_S,
    _ACTIVITY_SEEN_SWEEP_S,
    LogWatcher,
)


async def _noop(_usage: object) -> None:
    return None


def _watcher() -> LogWatcher:
    return LogWatcher(_noop)  # type: ignore[arg-type]


def _age(path: Path, seconds: float) -> None:
    """Backdate a file's mtime by `seconds`."""
    old = time.time() - seconds
    os.utime(path, (old, old))


def test_cold_file_set_is_dropped(tmp_path: Path) -> None:
    """A file nothing has appended to in a week loses its dedup set."""
    cold = tmp_path / "cold.jsonl"
    cold.write_text("{}\n")
    _age(cold, _ACTIVITY_SEEN_COLD_S + 60)

    w = _watcher()
    w._activity_seen[str(cold)] = {f"act:{i}" for i in range(1000)}
    w._scan_mtimes[str(cold)] = cold.stat().st_mtime

    w._sweep_activity_seen(_ACTIVITY_SEEN_SWEEP_S)

    assert str(cold) not in w._activity_seen
    # The file still exists, so its mtime entry must survive — otherwise the
    # next _files_to_scan re-enqueues it and rebuilds the set we just dropped.
    assert str(cold) in w._scan_mtimes


def test_warm_file_set_is_kept(tmp_path: Path) -> None:
    """An actively-written transcript keeps its dedup set; dropping it would
    replay every line of a live session back at the frontend."""
    warm = tmp_path / "warm.jsonl"
    warm.write_text("{}\n")

    w = _watcher()
    w._activity_seen[str(warm)] = {"act:1", "act:2"}

    w._sweep_activity_seen(_ACTIVITY_SEEN_SWEEP_S)

    assert w._activity_seen[str(warm)] == {"act:1", "act:2"}


def test_deleted_file_forgets_both_maps(tmp_path: Path) -> None:
    """A file that is gone can never be re-enqueued, so its mtime goes too."""
    gone = str(tmp_path / "gone.jsonl")

    w = _watcher()
    w._activity_seen[gone] = {"act:1"}
    w._scan_mtimes[gone] = 123.0

    w._sweep_activity_seen(_ACTIVITY_SEEN_SWEEP_S)

    assert gone not in w._activity_seen
    assert gone not in w._scan_mtimes


def test_sweep_is_rate_limited(tmp_path: Path) -> None:
    """Stat'ing every tracked transcript is not a per-rescan-cycle cost."""
    cold = tmp_path / "cold.jsonl"
    cold.write_text("{}\n")
    _age(cold, _ACTIVITY_SEEN_COLD_S + 60)

    w = _watcher()
    w._activity_seen[str(cold)] = {"act:1"}

    # First call lands inside the initial window and must not sweep.
    w._sweep_activity_seen(_ACTIVITY_SEEN_SWEEP_S / 2)
    assert str(cold) in w._activity_seen

    w._sweep_activity_seen(_ACTIVITY_SEEN_SWEEP_S)
    assert str(cold) not in w._activity_seen


class _IdleReader(LogReader):
    """Advertises nothing — the sweep is what we are watching, not delivery."""

    vendor = "claude"

    def project_dirs(self) -> list[Path]:
        return []

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[str]:
        return []


async def test_rescan_loop_actually_evicts(tmp_path: Path) -> None:
    """End to end: a real rescan cycle must drop a cold file's set.

    Asserting the call appears in the source would pass even if the loop
    never reached it, so this drives the loop the running backend drives.
    """
    cold = tmp_path / "cold.jsonl"
    cold.write_text("{}\n")
    _age(cold, _ACTIVITY_SEEN_COLD_S + 60)

    watcher = LogWatcher(sink=_noop, rescan_interval_s=0.02)  # type: ignore[arg-type]
    watcher.add_reader(_IdleReader())
    watcher._activity_seen[str(cold)] = {f"act:{i}" for i in range(500)}
    watcher.start()
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and str(cold) in watcher._activity_seen:
            await asyncio.sleep(0.02)
        assert str(cold) not in watcher._activity_seen, "rescan loop never swept"
    finally:
        watcher.stop()


async def test_rescan_loop_leaves_a_warm_file_alone(tmp_path: Path) -> None:
    """The counterpart: the loop must not evict a transcript still in use."""
    warm = tmp_path / "warm.jsonl"
    warm.write_text("{}\n")

    watcher = LogWatcher(sink=_noop, rescan_interval_s=0.02)  # type: ignore[arg-type]
    watcher.add_reader(_IdleReader())
    watcher._activity_seen[str(warm)] = {"act:1"}
    watcher.start()
    try:
        await asyncio.sleep(0.3)  # many rescan cycles
        assert watcher._activity_seen[str(warm)] == {"act:1"}
    finally:
        watcher.stop()
