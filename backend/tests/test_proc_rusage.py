"""The kernel counters behind the resource panel.

These run against the live syscall rather than a stub: the whole point of the
module is that the numbers match what `footprint(1)` and `ps` report, and a
mock cannot tell us that. Off darwin the module reports itself unavailable and
the callers use their subprocess paths, so there is nothing here to check.
"""

import os
import subprocess
import sys

import pytest

from agent_team_backend import proc_rusage

darwin_only = pytest.mark.skipif(sys.platform != "darwin", reason="darwin-only syscall")


class TestAvailability:
    def test_reports_unavailable_off_darwin(self):
        if sys.platform == "darwin":
            assert proc_rusage.available() is True
        else:
            assert proc_rusage.available() is False
            assert proc_rusage.sample([os.getpid()]) == {}


@darwin_only
class TestSampling:
    def test_measures_this_very_process(self):
        sampled = proc_rusage.sample([os.getpid()])
        footprint, cpu = sampled[os.getpid()]
        # A live Python interpreter is worth more than a megabyte and has
        # burned some CPU getting here; the exact figures are the kernel's.
        assert footprint > 1_000_000
        assert cpu > 0.0

    # The counter is what `footprint(1)` prints — that equivalence is the
    # reason the subprocess could be dropped, so it is worth asserting rather
    # than trusting.
    def test_agrees_with_the_footprint_command(self):
        pid = os.getpid()
        proc = subprocess.run(
            ["footprint", "-f", "bytes", str(pid)],
            capture_output=True,
            text=True,
            timeout=20,
        )
        expected = None
        for line in proc.stdout.splitlines():
            if f"[{pid}]" in line and "Footprint:" in line:
                expected = int(line.split("Footprint:")[1].split("B")[0].strip())
        if expected is None:
            pytest.skip("footprint(1) did not report this process")
        measured = proc_rusage.sample([pid])[pid][0]
        # Both read a counter that moves while the test runs, so they agree on
        # the scale, not to the byte.
        assert measured == pytest.approx(expected, rel=0.15)

    def test_omits_pids_that_do_not_exist(self):
        # Never allocated: pids are capped well below this.
        assert proc_rusage.sample([2_000_000_000]) == {}

    def test_ignores_impossible_pids(self):
        assert proc_rusage.sample([0, -1]) == {}

    def test_measures_nothing_for_an_empty_list(self):
        assert proc_rusage.sample([]) == {}

    # The failure this replaced was a sweep that timed out at twenty seconds on
    # a hundred and fifty pids. There is no subprocess left to time out, and a
    # sweep of every process this user owns has to stay far below the old cost.
    def test_sweeps_every_visible_process_quickly(self):
        import time

        listing = subprocess.run(
            ["ps", "-Ao", "pid=", "-u", str(os.getuid())],
            capture_output=True,
            text=True,
            timeout=20,
        )
        pids = [int(line) for line in listing.stdout.split()]
        assert len(pids) > 1
        started = time.monotonic()
        sampled = proc_rusage.sample(pids)
        elapsed = time.monotonic() - started
        assert sampled
        assert elapsed < 1.0
