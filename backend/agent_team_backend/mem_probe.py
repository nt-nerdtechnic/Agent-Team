"""Periodic pymalloc arena probe.

Background (issue #23): the backend's steady-state footprint is dominated by
retained pymalloc arenas — 1 MB anonymous mappings CPython only returns to the
OS once an arena becomes *completely* empty. One surviving object pins a whole
megabyte, so a long-lived process settles at a high-water mark it never gives
back: 4012 arenas (3.9 GB) after 19 h in the field, 580 after 46 min locally.

Measurement showed the count is flat while idle and only steps up at discrete
events. So the useful instrument is not a gauge, it is a *jump detector*: a
cheap periodic sample that stays quiet until the water rises, which is what
turns "4 GB after 19 h" into "these events did it". With NAVIDE_MEM_TRACE=1 a
jump also dumps the top allocators, answering *what* and not just *when*.

Stdlib only — no new dependency to carry through PyInstaller.
"""

from __future__ import annotations

import asyncio
import logging
import os
import resource
import sys
import tempfile
import threading
import tracemalloc
from dataclasses import dataclass

log = logging.getLogger("agent_team_backend.mem_probe")

#: pymalloc's arena size, fixed at 1 MB since CPython 3.10.
ARENA_BYTES = 1024 * 1024

#: How often to sample. The probe is cheap (one _debugmallocstats call), but it
#: briefly redirects fd 2 (see _capture_malloc_stats), so it stays infrequent.
SAMPLE_INTERVAL_S = 60.0

#: Growth since the last reported level that counts as a step worth naming.
#: Large enough that ordinary churn stays silent, small enough that the ~500 MB
#: an idle-to-busy session accumulates gets attributed to several distinct
#: events rather than one shrug.
JUMP_BYTES = 32 * 1024 * 1024

#: Opt-in deep diagnosis. tracemalloc roughly doubles allocation cost, so it is
#: never on by default — set NAVIDE_MEM_TRACE=1 to trade speed for the answer.
#:
#: It also costs the arena numbers: tracemalloc installs its own allocator, and
#: sys._debugmallocstats() then emits no arena section at all. That is why peak
#: RSS, not the arena count, is the signal this loop watches — the arena detail
#: is a bonus when available, never the thing the probe depends on.
TRACE_ENV = "NAVIDE_MEM_TRACE"

#: How many allocation sites to name when a jump is traced.
_TRACE_TOP_N = 10

# _debugmallocstats writes to fd 2, so reading it means redirecting fd 2 for
# the duration. That is process-global: this lock keeps two probes from
# interleaving their redirects and stealing each other's output.
_capture_lock = threading.Lock()


@dataclass(frozen=True)
class ArenaStats:
    """What pymalloc is holding, and how much of it is actually in use."""

    current: int
    highwater: int
    reclaimed: int
    allocated_bytes: int

    @property
    def arena_bytes(self) -> int:
        return self.current * ARENA_BYTES

    @property
    def waste_bytes(self) -> int:
        """Retained but not holding anything — the cost issue #23 is about."""
        return max(0, self.arena_bytes - self.allocated_bytes)

    @property
    def waste_ratio(self) -> float:
        """0.0 = every retained megabyte is working; ~0.99 = issue #23's shape."""
        return self.waste_bytes / self.arena_bytes if self.arena_bytes else 0.0


def _capture_malloc_stats() -> str:
    """sys._debugmallocstats() output, captured off fd 2.

    The redirect is why this is not called on a tight loop. It cannot lose
    backend.log lines — that goes through a RotatingFileHandler writing the
    file directly — but it can swallow whatever basicConfig's stderr handler
    emits during the few milliseconds it is held.
    """
    with _capture_lock, tempfile.TemporaryFile() as tf:
        saved = os.dup(2)
        try:
            os.dup2(tf.fileno(), 2)
            sys._debugmallocstats()
        finally:
            os.dup2(saved, 2)
            os.close(saved)
        tf.seek(0)
        return tf.read().decode("utf-8", "replace")


def _parse_int(text: str, label: str) -> int | None:
    """Pull `# <label> = <n>` out of the stats dump (values carry commas)."""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith(f"# {label}"):
            continue
        _, _, value = stripped.partition("=")
        digits = value.strip().replace(",", "")
        if digits.isdigit():
            return int(digits)
    return None


def read_arena_stats() -> ArenaStats | None:
    """Current pymalloc arena accounting, or None when pymalloc is not in use.

    Returns None under PYTHONMALLOC=malloc: the dump has no arena section at
    all there, which is the point of that setting rather than a failure.
    """
    try:
        text = _capture_malloc_stats()
    except OSError:
        # Redirecting fd 2 can fail in a stripped-down environment. Losing the
        # probe must never take the backend with it.
        log.debug("arena probe unavailable", exc_info=True)
        return None
    current = _parse_int(text, "arenas allocated current")
    if current is None:
        return None
    return ArenaStats(
        current=current,
        highwater=_parse_int(text, "arenas highwater mark") or current,
        reclaimed=_parse_int(text, "arenas reclaimed") or 0,
        allocated_bytes=_parse_int(text, "bytes in allocated blocks") or 0,
    )


def peak_rss_bytes() -> int:
    """Process peak RSS. Darwin reports bytes, Linux kilobytes."""
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak if sys.platform == "darwin" else peak * 1024


def _mb(value: int) -> float:
    return round(value / 1024 / 1024, 1)


def _describe(peak: int, stats: ArenaStats | None) -> str:
    """One line: always the peak, plus arena detail when pymalloc reports it."""
    line = f"peak_rss={_mb(peak)}MB"
    if stats is None:
        # PYTHONMALLOC=malloc, or tracemalloc has taken over the allocator.
        return line + " arenas=n/a"
    return (
        f"{line} arenas={stats.current} ({_mb(stats.arena_bytes)}MB) "
        f"live={_mb(stats.allocated_bytes)}MB "
        f"waste={_mb(stats.waste_bytes)}MB ({stats.waste_ratio:.0%}) "
        f"highwater={stats.highwater} reclaimed={stats.reclaimed}"
    )


def _trace_top(previous: tracemalloc.Snapshot | None) -> tracemalloc.Snapshot | None:
    """Log the biggest allocation sites, as a diff when we have a baseline."""
    if not tracemalloc.is_tracing():
        return None
    snapshot = tracemalloc.take_snapshot()
    if previous is None:
        entries = snapshot.statistics("lineno")
        header = "top allocators"
    else:
        entries = snapshot.compare_to(previous, "lineno")
        header = "top allocation growth"
    for entry in entries[:_TRACE_TOP_N]:
        log.info("  %s: %s", header, entry)
    return snapshot


async def probe_loop() -> None:
    """Sample the footprint forever, staying quiet until the water rises.

    Driven by peak RSS rather than the arena count, because peak RSS survives
    both of the configurations where arenas disappear (PYTHONMALLOC=malloc and
    tracemalloc) — and losing observability exactly when someone turns on the
    deeper tool would defeat the purpose.
    """
    if os.environ.get(TRACE_ENV):
        tracemalloc.start(1)
        log.info(
            "memory probe: tracemalloc enabled by %s — arena counts unavailable "
            "while it runs", TRACE_ENV,
        )
    baseline: int | None = None
    traced: tracemalloc.Snapshot | None = None
    while True:
        await asyncio.sleep(SAMPLE_INTERVAL_S)
        peak = peak_rss_bytes()
        stats = await asyncio.to_thread(read_arena_stats)
        log.debug("memory probe: %s", _describe(peak, stats))
        if baseline is None:
            baseline = peak
            traced = await asyncio.to_thread(_trace_top, None)
            continue
        if peak - baseline >= JUMP_BYTES:
            log.info(
                "memory probe: peak_rss +%sMB (%sMB -> %sMB) — %s",
                _mb(peak - baseline), _mb(baseline), _mb(peak),
                _describe(peak, stats),
            )
            traced = await asyncio.to_thread(_trace_top, traced)
            baseline = peak
        elif peak < baseline:
            # ru_maxrss is monotonic in practice, but never let a stale high
            # baseline hide a later climb if the platform ever reports lower.
            baseline = peak
