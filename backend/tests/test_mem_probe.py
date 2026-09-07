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
    peaks: list[int],
    monkeypatch: pytest.MonkeyPatch,
    arenas: bool = True,
    footprints: list[int] | None = None,
    arena_counts: list[int | None] | None = None,
    traces: list[str] | None = None,
) -> list[str]:
    """Drive probe_loop over a scripted signal sequence; return the INFO lines.

    `footprints` defaults to "no reading at all", which is what the probe sees
    off Darwin — and what every peak-RSS test below is about, so they must not
    depend on this machine's real footprint drifting during the run.
    """
    reported: list[str] = []
    remaining = list(peaks)
    remaining_fp = None if footprints is None else list(footprints)
    remaining_ar = None if arena_counts is None else list(arena_counts)

    def fake_peak() -> int:
        if not remaining:
            raise asyncio.CancelledError
        return remaining.pop(0)

    def fake_footprint() -> int | None:
        if remaining_fp is None:
            return None
        return remaining_fp.pop(0) if remaining_fp else None

    def fake_arenas() -> mem_probe.ArenaStats | None:
        if remaining_ar is not None:
            count = remaining_ar.pop(0) if remaining_ar else None
            if count is None:
                return None
            return mem_probe.ArenaStats(
                current=count, highwater=count, reclaimed=0, allocated_bytes=1024
            )
        if not arenas:
            return None
        return mem_probe.ArenaStats(
            current=7, highwater=7, reclaimed=0, allocated_bytes=1024
        )

    def fake_trace(previous: object) -> object:
        if traces is not None:
            traces.append("dumped")
        return previous

    monkeypatch.setattr(mem_probe, "peak_rss_bytes", fake_peak)
    monkeypatch.setattr(mem_probe, "phys_footprint_bytes", fake_footprint)
    monkeypatch.setattr(mem_probe, "read_arena_stats", fake_arenas)
    monkeypatch.setattr(mem_probe, "_trace_top", fake_trace)
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


# ── The blind spot this probe used to have ───────────────────────────────────
#
# Peak RSS is the only signal that survives every configuration, which is why
# the loop was driven off it. But on macOS it goes blind in the one situation
# the probe exists for: a page that cools is compressed out of the resident set
# while still counting toward the process footprint, so growth that has already
# cooled moves the footprint and leaves ru_maxrss flat. Measured in the field,
# a backend grew 585 arenas over 42 hours without tripping the threshold once.


@pytest.mark.asyncio
async def test_reports_growth_that_rss_cannot_see(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: footprint climbs 585 MB, peak RSS never moves.

    The field shape. Before the fix this produced no output at all — the probe
    was silent for the entire window it existed to describe.
    """
    flat = 200 * MB
    reported = await _run_probe(
        [flat, flat, flat],
        monkeypatch,
        footprints=[1610 * MB, 1900 * MB, 2195 * MB],
    )
    assert [r.split()[2] for r in reported] == ["footprint", "footprint"]
    assert "footprint +290.0MB (1610.0MB -> 1900.0MB)" in reported[0]
    assert "footprint +295.0MB (1900.0MB -> 2195.0MB)" in reported[1]


@pytest.mark.asyncio
async def test_reports_arena_growth_that_rss_cannot_see(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The arena count is the signal compression cannot touch at all."""
    flat = 200 * MB
    reported = await _run_probe(
        [flat, flat], monkeypatch, arena_counts=[1610, 1700]
    )
    assert len(reported) == 1
    assert "arenas +90.0MB (1610.0MB -> 1700.0MB)" in reported[0]


@pytest.mark.asyncio
async def test_peak_rss_line_is_unchanged_by_the_extra_signals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The old line must stay byte-identical — field logs are parsed by eye and
    by grep, and four rotated files of history are worth keeping readable."""
    reported = await _run_probe(
        [200 * MB, 200 * MB + mem_probe.JUMP_BYTES], monkeypatch
    )
    assert len(reported) == 1
    assert reported[0].startswith("memory probe: peak_rss +32.0MB (200.0MB -> 232.0MB) — ")


@pytest.mark.asyncio
async def test_one_dump_per_sample_however_many_signals_moved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two signals describing one climb is one event, not two allocator dumps."""
    traces: list[str] = []
    reported = await _run_probe(
        [200 * MB, 400 * MB],
        monkeypatch,
        footprints=[200 * MB, 400 * MB],
        traces=traces,
    )
    assert len(reported) == 2, "both signals should be named"
    # One baseline dump at startup, then exactly one for the shared jump.
    assert len(traces) == 2


@pytest.mark.asyncio
async def test_a_signal_that_goes_away_keeps_its_level(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """tracemalloc removes the arena section for as long as it runs.

    The level has to survive that gap. Re-baselining on the signal's return
    would swallow everything that grew while it was gone, so turning on the
    deep tool would create a blind spot instead of removing one — which is the
    same failure this whole change exists to fix, one level up.
    """
    flat = 200 * MB
    reported = await _run_probe(
        [flat, flat, flat],
        monkeypatch,
        arena_counts=[1610, None, 1800],
    )
    assert len(reported) == 1, "growth across the gap must still be reported"
    assert "arenas +190.0MB (1610.0MB -> 1800.0MB)" in reported[0]


@pytest.mark.asyncio
async def test_a_returning_signal_at_the_same_level_is_not_a_jump(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half: coming back where it left off is not an event."""
    flat = 200 * MB
    reported = await _run_probe(
        [flat, flat, flat, flat],
        monkeypatch,
        arena_counts=[1610, None, 1610, 1615],
    )
    assert reported == []


@pytest.mark.asyncio
async def test_a_falling_footprint_lowers_the_baseline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unlike ru_maxrss the footprint genuinely falls; a stale high level would
    hide the next climb."""
    flat = 200 * MB
    reported = await _run_probe(
        [flat, flat, flat],
        monkeypatch,
        footprints=[2000 * MB, 100 * MB, 100 * MB + mem_probe.JUMP_BYTES],
    )
    assert len(reported) == 1, "the drop is not an event, the climb after it is"
    assert "footprint +32.0MB (100.0MB -> 132.0MB)" in reported[0]


@pytest.mark.asyncio
async def test_no_footprint_reading_leaves_peak_rss_in_charge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Off Darwin there is no footprint. The probe must behave exactly as it
    did before this signal existed, not fall silent waiting for it."""
    reported = await _run_probe(
        [200 * MB, 200 * MB + mem_probe.JUMP_BYTES], monkeypatch, footprints=None
    )
    assert len(reported) == 1
    assert "peak_rss +32.0MB" in reported[0]


def test_signals_omits_what_it_cannot_read(monkeypatch: pytest.MonkeyPatch) -> None:
    """Absent, never zero — a zero would look like a collapse and re-baseline
    the detector down to nothing."""
    monkeypatch.setattr(mem_probe, "phys_footprint_bytes", lambda: None)
    assert mem_probe._signals(500 * MB, None) == {"peak_rss": 500 * MB}

    monkeypatch.setattr(mem_probe, "phys_footprint_bytes", lambda: 900 * MB)
    stats = mem_probe.ArenaStats(
        current=10, highwater=10, reclaimed=0, allocated_bytes=1024
    )
    assert mem_probe._signals(500 * MB, stats) == {
        "peak_rss": 500 * MB,
        "footprint": 900 * MB,
        "arenas": 10 * mem_probe.ARENA_BYTES,
    }


def test_reads_this_process_footprint() -> None:
    """Not a mock: on Darwin the syscall must answer for our own pid.

    It is also the cross-check that matters — the footprint has to exceed the
    resident set for the counter to be the one that sees compressed pages.
    """
    from agent_team_backend import proc_rusage

    if not proc_rusage.available():
        pytest.skip("proc_pid_rusage not available on this platform")
    footprint = mem_probe.phys_footprint_bytes()
    assert footprint is not None
    assert footprint > 1024 * 1024
