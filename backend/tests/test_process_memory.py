"""The memory sweep behind the status-bar panel."""

from agent_team_backend import process_memory


class TestSyscallSweep:
    """The path every real sweep takes: `proc_pid_rusage`, no subprocess."""

    def test_reads_the_kernel_counter_without_spawning_anything(self, monkeypatch):
        monkeypatch.setattr(
            process_memory.proc_rusage, "sample", lambda pids: {1: (500, 2.5), 2: (700, 1.0)}
        )
        monkeypatch.setattr(process_memory.subprocess, "run", _must_not_run)
        assert process_memory.footprints([1, 2]) == {1: 500, 2: 700}

    # Every target died between the caller listing them and the sweep. That is
    # a real empty answer, not a reason to pay for the subprocess as well.
    def test_reports_nothing_when_the_syscall_answers_for_no_pid(self, monkeypatch):
        monkeypatch.setattr(process_memory.proc_rusage, "sample", lambda pids: {})
        monkeypatch.setattr(process_memory.proc_rusage, "available", lambda: True)
        monkeypatch.setattr(process_memory.subprocess, "run", _must_not_run)
        assert process_memory.footprints([1, 2]) == {}

    def test_still_applies_the_pid_cap(self, monkeypatch):
        monkeypatch.setattr(process_memory.proc_rusage, "sample", _must_not_run)
        assert process_memory.footprints(list(range(1, process_memory._MAX_PIDS + 50))) == {}


class TestFootprintParsing:
    """The `footprint(1)` fallback, for a build where the syscall will not resolve."""

    # footprint prints a per-target header carrying both the pid and the total,
    # then a long per-region table. Only the header matters, and parsing it is
    # what keeps a thirty-pane sweep to one subprocess.
    def test_reads_the_pid_and_total_from_each_header(self, monkeypatch):
        stdout = (
            "======================================================================\n"
            "claude [22751]: 64-bit    Footprint: 279692800 B (16384 bytes per page)\n"
            "======================================================================\n"
            "    0 B      96 KB          0 B          3    __LINKEDIT\n"
            "    phys_footprint: 279692800 B\n"
            "======================================================================\n"
            "node [23178]: 64-bit    Footprint: 120000000 B (16384 bytes per page)\n"
            "======================================================================\n"
        )
        _fake_run(monkeypatch, stdout)
        assert process_memory.footprints([22751, 23178]) == {
            22751: 279692800,
            23178: 120000000,
        }

    # Panes die while the sweep runs, and footprint exits non-zero when a target
    # is gone. The processes it did manage to read are still real.
    def test_keeps_what_was_measured_when_the_command_exits_non_zero(self, monkeypatch):
        _fake_run(
            monkeypatch,
            "claude [1]: 64-bit    Footprint: 500 B (16384 bytes per page)\n",
            returncode=1,
        )
        assert process_memory.footprints([1, 2]) == {1: 500}

    def test_deduplicates_and_ignores_impossible_pids(self, monkeypatch):
        seen: dict[str, list[str]] = {}
        _fake_run(monkeypatch, "", capture_argv=seen)
        process_memory.footprints([5, 5, 0, -1, 3])
        assert seen["argv"] == ["footprint", "-f", "bytes", "3", "5"]

    # A panel that cannot measure shows nothing. An exception here would take
    # down the request that asked, which is a worse answer than "unavailable".
    def test_survives_a_missing_or_failing_command(self, monkeypatch):
        def boom(*_args, **_kwargs):
            raise OSError("no footprint here")

        _force_fallback(monkeypatch)
        monkeypatch.setattr(process_memory.subprocess, "run", boom)
        assert process_memory.footprints([1]) == {}

    def test_measures_nothing_off_darwin(self, monkeypatch):
        monkeypatch.setattr(process_memory.sys, "platform", "linux")
        assert process_memory.available() is False
        assert process_memory.footprints([1]) == {}

    # The argv would be unwieldy and the panel is a summary, not an audit.
    def test_skips_a_sweep_beyond_the_pid_cap(self, monkeypatch):
        called = {"n": 0}

        def counting(*_args, **_kwargs):
            called["n"] += 1
            raise AssertionError("should not run")

        monkeypatch.setattr(process_memory.subprocess, "run", counting)
        assert process_memory.footprints(list(range(1, process_memory._MAX_PIDS + 50))) == {}
        assert called["n"] == 0


class TestGrouping:
    # A pane is a tree — the PTY child is a login shell and the CLI, its MCP
    # servers and anything else it spawned hang below it. The number shown next
    # to a pane name has to be the whole tree.
    def test_totals_every_pid_in_a_group(self):
        measured = {10: 100, 11: 250, 12: 50, 99: 7}
        groups = {"sess-a": [10, 11, 12], "sess-b": [99]}
        assert process_memory.sum_by_group(groups, measured) == {
            "sess-a": 400,
            "sess-b": 7,
        }

    def test_a_group_whose_pids_were_not_measured_totals_zero(self):
        assert process_memory.sum_by_group({"sess-a": [1, 2]}, {}) == {"sess-a": 0}


def _must_not_run(*_args, **_kwargs):
    raise AssertionError("the syscall path should have answered")


def _force_fallback(monkeypatch) -> None:
    """Pretend the syscall cannot be resolved, so the subprocess path runs."""
    monkeypatch.setattr(process_memory.proc_rusage, "available", lambda: False)
    monkeypatch.setattr(process_memory.proc_rusage, "sample", lambda pids: {})


def _fake_run(monkeypatch, stdout: str, returncode: int = 0, capture_argv=None):
    _force_fallback(monkeypatch)

    class Result:
        def __init__(self) -> None:
            self.stdout = stdout
            self.returncode = returncode

    def fake(argv, **_kwargs):
        if capture_argv is not None:
            capture_argv["argv"] = list(argv)
        return Result()

    monkeypatch.setattr(process_memory.subprocess, "run", fake)
