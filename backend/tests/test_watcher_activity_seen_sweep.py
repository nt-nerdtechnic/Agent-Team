"""LogWatcher activity-dedup sweep policy.

`_activity_seen` holds one dedup bag per transcript. The bag is bounded by the
readers' high-water marks (see log_readers.base and test_activity_high_water),
so the sweep's job is narrow: forget the bags of files that no longer exist.

It deliberately does NOT drop the bag of a file that still exists, however old
that file looks. Resuming an old session is a first-class flow here: the
transcript's mtime is weeks old, and the moment the user types, the file is
appended to and re-enqueued. With its bag dropped the reader starts at line 1
and re-emits every historical `agent_active` / `turn_complete` — turn text and
MSG blocks included — at a pane that is registered and attributed by then. A
restart replays too, but a restart also resets the frontend; this does not.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

from agent_team_backend.log_readers.base import LogReader, activity_high_water

from agent_team_backend.log_readers.watcher import (
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


def test_cold_file_keeps_its_set(tmp_path: Path) -> None:
    """A transcript nothing has appended to in a month is still resumable, so
    its dedup state must survive the sweep."""
    cold = tmp_path / "cold.jsonl"
    cold.write_text("{}\n")
    _age(cold, 30 * 24 * 3600.0)

    w = _watcher()
    w._activity_seen[str(cold)] = {"act_hw::1200", "qwen_text::hello"}
    w._scan_mtimes[str(cold)] = cold.stat().st_mtime

    w._sweep_activity_seen(_ACTIVITY_SEEN_SWEEP_S)

    assert w._activity_seen[str(cold)] == {"act_hw::1200", "qwen_text::hello"}
    assert str(cold) in w._scan_mtimes


def test_cold_file_keeps_the_position_a_resume_reads(tmp_path: Path) -> None:
    """The property that actually prevents the replay: the high-water mark a
    resumed reader consults is still there after the sweep."""
    cold = tmp_path / "resumed.jsonl"
    cold.write_text("{}\n")
    _age(cold, 30 * 24 * 3600.0)

    w = _watcher()
    w._activity_seen[str(cold)] = {"act_hw::1200"}

    w._sweep_activity_seen(_ACTIVITY_SEEN_SWEEP_S)

    assert activity_high_water(w._activity_seen[str(cold)]) == 1200


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


def test_first_sweep_runs_before_monotonic_uptime_window(tmp_path: Path) -> None:
    """The first sweep must not depend on how long the runner has been up."""
    gone = str(tmp_path / "gone.jsonl")

    w = _watcher()
    w._activity_seen[gone] = {"act:1"}

    w._sweep_activity_seen(1.0)

    assert gone not in w._activity_seen


def test_sweep_is_rate_limited(tmp_path: Path) -> None:
    """Stat'ing every tracked transcript is not a per-rescan-cycle cost."""
    gone = str(tmp_path / "gone.jsonl")

    w = _watcher()
    w._activity_seen[gone] = {"act:1"}

    first_sweep_at = 1.0
    w._sweep_activity_seen(first_sweep_at)
    assert gone not in w._activity_seen

    w._activity_seen[gone] = {"act:2"}
    w._sweep_activity_seen(first_sweep_at + _ACTIVITY_SEEN_SWEEP_S / 2)
    assert gone in w._activity_seen

    w._sweep_activity_seen(first_sweep_at + _ACTIVITY_SEEN_SWEEP_S)
    assert gone not in w._activity_seen


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
    """End to end: a real rescan cycle must forget a deleted file's set.

    Asserting the call appears in the source would pass even if the loop
    never reached it, so this drives the loop the running backend drives.
    """
    gone = str(tmp_path / "gone.jsonl")

    watcher = LogWatcher(sink=_noop, rescan_interval_s=0.02)  # type: ignore[arg-type]
    watcher.add_reader(_IdleReader())
    watcher._activity_seen[gone] = {f"act:{i}" for i in range(500)}
    watcher.start()
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and gone in watcher._activity_seen:
            await asyncio.sleep(0.02)
        assert gone not in watcher._activity_seen, "rescan loop never swept"
    finally:
        watcher.stop()


async def test_rescan_loop_leaves_an_old_transcript_alone(tmp_path: Path) -> None:
    """The counterpart: the loop must not evict a transcript that still
    exists, however cold, because resuming it would replay the whole file."""
    old = tmp_path / "old.jsonl"
    old.write_text("{}\n")
    _age(old, 30 * 24 * 3600.0)

    watcher = LogWatcher(sink=_noop, rescan_interval_s=0.02)  # type: ignore[arg-type]
    watcher.add_reader(_IdleReader())
    watcher._activity_seen[str(old)] = {"act_hw::9"}
    watcher.start()
    try:
        await asyncio.sleep(0.3)  # many rescan cycles
        assert watcher._activity_seen[str(old)] == {"act_hw::9"}
    finally:
        watcher.stop()
