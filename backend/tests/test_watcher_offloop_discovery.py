"""Rescan discovery must not run on the event loop.

Regression test for the 2026-08-24 typing-latency freeze: every rescan cycle
enumerated vendor session files (tree walks + per-file header reads + one
stat per candidate) synchronously on the asyncio loop. On a cold page cache
one sweep took 15-22s, and for that whole window PTY readers and WebSocket
sends were suspended. The sweep now runs in a worker thread via
asyncio.to_thread; only the enqueue returns to the loop.
"""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path

from agent_team_backend.log_readers.base import TokenUsage
from agent_team_backend.log_readers.watcher import LogWatcher


async def _noop(_usage: TokenUsage) -> None:
    return None


async def test_rescan_discovery_runs_off_the_event_loop(tmp_path: Path) -> None:
    watcher = LogWatcher(sink=_noop, rescan_interval_s=0.02)
    loop_thread = threading.current_thread()
    sweep_threads: list[threading.Thread] = []
    orig = watcher._files_to_scan  # noqa: SLF001

    def spy() -> list[Path]:
        sweep_threads.append(threading.current_thread())
        return orig()

    watcher._files_to_scan = spy  # type: ignore[method-assign]  # noqa: SLF001
    watcher.start()
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and not sweep_threads:
            await asyncio.sleep(0.02)
        assert sweep_threads, "rescan sweep never ran"
        assert all(t is not loop_thread for t in sweep_threads)
    finally:
        watcher.stop()
