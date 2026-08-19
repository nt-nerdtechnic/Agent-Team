"""Arena probe: does it read pymalloc honestly, and stay quiet until it matters.

The probe exists to attribute a retained-memory high-water mark to the events
that caused it (issue #23). Two things decide whether it earns its place: the
numbers must come from pymalloc rather than from a guess, and the jump detector
must not cry wolf — a probe that logs every sample is the per-keystroke WARNING
problem all over again.
"""

from __future__ import annotations

import asyncio

import pytest

from agent_team_backend import mem_probe


REAL_DUMP = """\
Small block threshold = 512, in 32 size classes.

# arenas allocated total           =                4,012
# arenas reclaimed                 =                  318
# arenas highwater mark            =                4,100
# arenas allocated current         =                4,012
4012 arenas * 1048576 bytes/arena  =        4,206,886,912

# bytes in allocated blocks        =           41,943,040
# bytes lost to arena alignment    =                    0
"""

# PYTHONMALLOC=malloc: the dump still exists, but has no arena section at all.
NO_PYMALLOC_DUMP = """\
            1 free PyDictObjects * 48 bytes each =                   48
           5 free PyFloatObjects * 24 bytes each =                  120
"""


def test_parses_comma_separated_counts() -> None:
    assert mem_probe._parse_int(REAL_DUMP, "arenas allocated current") == 4012
    assert mem_probe._parse_int(REAL_DUMP, "arenas reclaimed") == 318
    assert mem_probe._parse_int(REAL_DUMP, "bytes in allocated blocks") == 41943040


def test_parse_returns_none_for_absent_label() -> None:
    assert mem_probe._parse_int(NO_PYMALLOC_DUMP, "arenas allocated current") is None


def test_reads_the_field_report_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """The reported 4012 arenas holding 40 MB — 99% retained but unused."""
    monkeypatch.setattr(mem_probe, "_capture_malloc_stats", lambda: REAL_DUMP)
    stats = mem_probe.read_arena_stats()
    assert stats is not None
    assert stats.current == 4012
    assert stats.highwater == 4100
    assert stats.arena_bytes == 4012 * mem_probe.ARENA_BYTES
    # This ratio is the whole point: retained megabytes that hold nothing.
    assert stats.waste_ratio == pytest.approx(0.99, abs=0.01)


def test_none_when_pymalloc_is_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Under PYTHONMALLOC=malloc there are no arenas — absence, not failure."""
    monkeypatch.setattr(mem_probe, "_capture_malloc_stats", lambda: NO_PYMALLOC_DUMP)
    assert mem_probe.read_arena_stats() is None


def test_probe_survives_a_failed_capture(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> str:
        raise OSError("no fd 2 here")

    monkeypatch.setattr(mem_probe, "_capture_malloc_stats", boom)
    assert mem_probe.read_arena_stats() is None


def test_reads_the_live_interpreter() -> None:
    """Not a mock: the real capture must come back with plausible numbers.

    Skipped rather than failed when pymalloc is off, so the suite still passes
    under PYTHONMALLOC=malloc.
    """
    stats = mem_probe.read_arena_stats()
    if stats is None:
        pytest.skip("pymalloc not in use in this interpreter")
    assert stats.current > 0
    assert stats.highwater >= stats.current
    assert 0 < stats.allocated_bytes <= stats.arena_bytes


def test_peak_rss_is_plausible() -> None:
    assert mem_probe.peak_rss_bytes() > 1024 * 1024


async def _run_probe(
    peaks: list[int], monkeypatch: pytest.MonkeyPatch, arenas: bool = True
) -> list[str]:
    """Drive probe_loop over a scripted peak-RSS sequence; return the INFO lines."""
    reported: list[str] = []
    remaining = list(peaks)

    def fake_peak() -> int:
        if not remaining:
            raise asyncio.CancelledError
        return remaining.pop(0)

    def fake_arenas() -> mem_probe.ArenaStats | None:
        if not arenas:
            return None
        return mem_probe.ArenaStats(
            current=7, highwater=7, reclaimed=0, allocated_bytes=1024
        )

    monkeypatch.setattr(mem_probe, "peak_rss_bytes", fake_peak)
    monkeypatch.setattr(mem_probe, "read_arena_stats", fake_arenas)
    monkeypatch.setattr(mem_probe, "SAMPLE_INTERVAL_S", 0)
    monkeypatch.setattr(mem_probe.log, "info", lambda msg, *a: reported.append(msg % a))
    with pytest.raises(asyncio.CancelledError):
        await mem_probe.probe_loop()
    return reported


MB = 1024 * 1024


@pytest.mark.asyncio
async def test_stays_silent_while_the_water_is_flat(monkeypatch: pytest.MonkeyPatch) -> None:
    """Idle is the common case; it must produce no INFO noise at all."""
    reported = await _run_probe([200 * MB, 200 * MB, 201 * MB, 200 * MB], monkeypatch)
    assert reported == []


@pytest.mark.asyncio
async def test_reports_a_step_up(monkeypatch: pytest.MonkeyPatch) -> None:
    reported = await _run_probe([200 * MB, 200 * MB + mem_probe.JUMP_BYTES], monkeypatch)
    assert len(reported) == 1
    assert "peak_rss +32.0MB" in reported[0]
    assert "200.0MB -> 232.0MB" in reported[0]


@pytest.mark.asyncio
async def test_rebaselines_so_one_climb_is_not_reported_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two separate steps are two events, not one event and one echo."""
    j = mem_probe.JUMP_BYTES
    reported = await _run_probe(
        [200 * MB, 200 * MB + j, 200 * MB + j + MB, 200 * MB + 2 * j], monkeypatch
    )
    assert len(reported) == 2
    assert "200.0MB -> 232.0MB" in reported[0]
    assert "232.0MB -> 264.0MB" in reported[1]


@pytest.mark.asyncio
async def test_keeps_watching_when_arenas_are_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: the probe must NOT go blind under PYTHONMALLOC=malloc.

    An earlier revision drove the loop off the arena count and returned as soon
    as it was None — which silently disabled the probe in exactly the two
    configurations someone reaches for when investigating memory.
    """
    reported = await _run_probe(
        [200 * MB, 200 * MB + mem_probe.JUMP_BYTES], monkeypatch, arenas=False
    )
    assert len(reported) == 1
    assert "arenas=n/a" in reported[0]


@pytest.mark.asyncio
async def test_tracemalloc_does_not_blind_the_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression, the reason for the above: tracemalloc removes the arena
    section from sys._debugmallocstats(), so the deep tool used to switch the
    basic one off. Real tracemalloc here, not a mock — that is the whole point.
    """
    import tracemalloc

    assert mem_probe.read_arena_stats() is not None, "expected pymalloc baseline"
    tracemalloc.start(1)
    try:
        assert mem_probe.read_arena_stats() is None
        # The line the loop logs must still be produced, just without arenas.
        line = mem_probe._describe(mem_probe.peak_rss_bytes(), None)
        assert "peak_rss=" in line and "arenas=n/a" in line
    finally:
        tracemalloc.stop()
    assert mem_probe.read_arena_stats() is not None


def test_describe_includes_arena_detail_when_available() -> None:
    stats = mem_probe.ArenaStats(
        current=4012, highwater=4100, reclaimed=318, allocated_bytes=41943040
    )
    line = mem_probe._describe(500 * MB, stats)
    assert "peak_rss=500.0MB" in line
    assert "arenas=4012" in line
    assert "(99%)" in line
