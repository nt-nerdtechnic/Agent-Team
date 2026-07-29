"""LogWatcher backfill progress: force_rescan announces the file count and each
replayed file decrements it, so the UI can show a small "tidying token history"
status instead of the big historic backfill silently hogging CPU at startup."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.log_readers.watcher import LogWatcher


class _Reader(LogReader):
    def __init__(self, vendor: str, root: Path) -> None:
        self.vendor = vendor
        self.root = root

    def project_dirs(self) -> list[Path]:
        return [self.root]

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return []


class _FilesReader(_Reader):
    def __init__(self, vendor: str, root: Path, files: list[Path]) -> None:
        super().__init__(vendor, root)
        self._files = files

    def session_files(self) -> list[Path]:
        return list(self._files)


def _noop(_usage):  # pragma: no cover - unused token sink
    return None


def test_emit_backfill_counts_down_and_clears() -> None:
    events: list[tuple[str, int]] = []
    watcher = LogWatcher(sink=_noop, progress_sink=lambda ws, n: events.append((ws, n)))

    watcher._emit_backfill("/ws", 3)   # force_rescan announced 3 files
    watcher._emit_backfill("/ws", -1)  # each replayed file
    watcher._emit_backfill("/ws", -1)
    watcher._emit_backfill("/ws", -1)  # → 0 = done

    assert events == [("/ws", 3), ("/ws", 2), ("/ws", 1), ("/ws", 0)]
    # Cleared at zero so a later, unrelated event doesn't resurrect a stale count.
    assert "/ws" not in watcher._backfill_remaining


def test_emit_backfill_clamps_at_zero() -> None:
    events: list[tuple[str, int]] = []
    watcher = LogWatcher(sink=_noop, progress_sink=lambda ws, n: events.append((ws, n)))
    watcher._emit_backfill("/ws", -5)  # out-of-order decrement must not go negative
    assert events == [("/ws", 0)]


def test_emit_backfill_noop_without_sink() -> None:
    watcher = LogWatcher(sink=_noop)  # no progress_sink → silent
    watcher._emit_backfill("/ws", 3)
    assert watcher._backfill_remaining == {}


def test_emit_backfill_ignores_empty_workspace() -> None:
    events: list[tuple[str, int]] = []
    watcher = LogWatcher(sink=_noop, progress_sink=lambda ws, n: events.append((ws, n)))
    watcher._emit_backfill("", 3)  # legacy full rescan (no workspace) → not counted
    assert events == []


@pytest.mark.asyncio
async def test_drain_counts_down_even_when_processing_early_returns(tmp_path: Path) -> None:
    """The remaining count must reach 0 (indicator clears) even when a replayed
    file early-returns in _process_path (no reader / zero-token event / parse
    error). The decrement lives in _drain_loop's finally, not the happy path."""
    events: list[tuple[str, int]] = []
    watcher = LogWatcher(sink=_noop, progress_sink=lambda ws, n: events.append((ws, n)))
    watcher._loop = asyncio.get_running_loop()
    # No readers registered → _process_path returns immediately (never reaching
    # any inline decrement), exactly the path that used to strand the counter.
    watcher._emit_backfill("/ws", 2)  # force_rescan announced 2 files
    await watcher._queue.put((tmp_path / "a.jsonl", "/ws"))
    await watcher._queue.put((tmp_path / "b.jsonl", "/ws"))
    await watcher._queue.put((None, ""))  # startup token pass
    drain = asyncio.create_task(watcher._drain_loop())
    for _ in range(200):
        await asyncio.sleep(0)
        if watcher._queue.empty() and not watcher._backfill_remaining:
            break
    drain.cancel()
    assert events[-1] == ("/ws", 0)  # done fired
    assert "/ws" not in watcher._backfill_remaining


@pytest.mark.asyncio
async def test_force_rescan_queues_a_flush_sentinel_behind_its_batch(
    tmp_path: Path,
) -> None:
    """Opening a workspace fires force_rescan long after startup, so it can't
    rely on the startup sentinel. The count only decrements in
    _flush_pending_tokens, so without a sentinel of its own the indicator sticks
    for a whole _token_interval_s (5 min)."""
    watcher = LogWatcher(sink=_noop, progress_sink=lambda ws, n: None)
    watcher._loop = asyncio.get_running_loop()
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    watcher._readers = [_FilesReader("claude", tmp_path, [a, b])]

    watcher.force_rescan("/ws")
    await asyncio.sleep(0)  # let the call_soon_threadsafe callbacks land

    queued = []
    while not watcher._queue.empty():
        queued.append(watcher._queue.get_nowait())
    assert queued == [(a, "/ws"), (b, "/ws"), (None, "")]


@pytest.mark.asyncio
async def test_force_rescan_without_workspace_queues_no_sentinel(
    tmp_path: Path,
) -> None:
    """Legacy full rescans don't drive the indicator, so they get no sentinel —
    their token paths ride the normal interval instead of forcing a flush."""
    watcher = LogWatcher(sink=_noop, progress_sink=lambda ws, n: None)
    watcher._loop = asyncio.get_running_loop()
    a = tmp_path / "a.jsonl"
    watcher._readers = [_FilesReader("claude", tmp_path, [a])]

    watcher.force_rescan()
    await asyncio.sleep(0)

    queued = []
    while not watcher._queue.empty():
        queued.append(watcher._queue.get_nowait())
    assert queued == [(a, "")]
