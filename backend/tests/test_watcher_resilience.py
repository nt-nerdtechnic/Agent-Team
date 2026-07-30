"""LogWatcher delivery resilience.

Regression tests for a fresh-install freeze: with no CLI home dirs existing at
backend startup, watchdog observed nothing and the rescan loop was the sole
delivery path — and a single reader exception killed that loop permanently,
freezing pipeline.log/history ingestion while PTY transcripts kept writing.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.log_readers.watcher import LogWatcher


async def _noop(_usage: TokenUsage) -> None:
    return None


class _FlakyReader(LogReader):
    """Raises on the first session_files() sweep, then behaves normally."""

    def __init__(self, vendor: str, root: Path) -> None:
        self.vendor = vendor
        self.root = root
        self.calls = 0

    def project_dirs(self) -> list[Path]:
        return [self.root]

    def session_files(self) -> list[Path]:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("boom")
        return sorted(self.root.glob("*.jsonl"))

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return []


class _LateHomeReader(LogReader):
    """watch_dirs() advertises a root that may not exist yet (fresh install)."""

    def __init__(self, vendor: str, watch_root: Path) -> None:
        self.vendor = vendor
        self.watch_root = watch_root

    def project_dirs(self) -> list[Path]:
        return []

    def watch_dirs(self) -> list[Path]:
        return [self.watch_root]

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return []


async def test_rescan_loop_survives_reader_exception(tmp_path: Path) -> None:
    root = tmp_path / "codex"
    root.mkdir()
    f = root / "rollout-a.jsonl"
    f.write_text("{}\n", encoding="utf-8")
    reader = _FlakyReader("codex", root)
    watcher = LogWatcher(sink=_noop, rescan_interval_s=0.02)
    watcher.add_reader(reader)
    watcher.start()
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and str(f) not in watcher._scan_mtimes:  # noqa: SLF001
            await asyncio.sleep(0.02)
        # First sweep raised; later sweeps still ran and picked the file up.
        assert reader.calls >= 2
        assert str(f) in watcher._scan_mtimes  # noqa: SLF001
        assert watcher._rescan_task is not None  # noqa: SLF001
        assert not watcher._rescan_task.done()  # noqa: SLF001
    finally:
        watcher.stop()


async def test_rescan_cycle_subscribes_late_created_watch_dirs(tmp_path: Path) -> None:
    home = tmp_path / "cli-home"  # does not exist when start() runs
    watcher = LogWatcher(sink=_noop, rescan_interval_s=0.02)
    watcher.add_reader(_LateHomeReader("codex", home))
    watcher.start()
    try:
        assert home not in watcher._watched_dirs  # noqa: SLF001
        home.mkdir()
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and home not in watcher._watched_dirs:  # noqa: SLF001
            await asyncio.sleep(0.02)
        assert home in watcher._watched_dirs  # noqa: SLF001
    finally:
        watcher.stop()


async def test_start_subscribes_existing_watch_dirs(tmp_path: Path) -> None:
    home = tmp_path / "cli-home"
    home.mkdir()
    watcher = LogWatcher(sink=_noop, rescan_interval_s=30.0)
    watcher.add_reader(_LateHomeReader("codex", home))
    watcher.start()
    try:
        assert home in watcher._watched_dirs  # noqa: SLF001
    finally:
        watcher.stop()
