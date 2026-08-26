"""The CPU sweep behind the resource panel."""

from agent_team_backend import process_cpu


class TestTimeParsing:
    # `ps` widens the TIME field as the number grows, and a CLI left running
    # overnight reaches every one of these forms.
    def test_reads_minutes_seconds_and_hundredths(self):
        assert process_cpu.parse_cpu_time("1:02.34") == 62.34

    def test_reads_hours(self):
        assert process_cpu.parse_cpu_time("12:34:56") == 45296.0

    def test_reads_days(self):
        assert process_cpu.parse_cpu_time("2-03:04:05") == 183845.0

    def test_reads_bare_seconds(self):
        assert process_cpu.parse_cpu_time("7.5") == 7.5

    # A dash is what `ps` prints for a process that vanished mid-sweep, and a
    # header line is what slips through when the `=` suffixes are dropped.
    def test_rejects_what_is_not_a_time(self):
        assert process_cpu.parse_cpu_time("-") is None
        assert process_cpu.parse_cpu_time("TIME") is None
        assert process_cpu.parse_cpu_time("") is None
        assert process_cpu.parse_cpu_time("1:2:3:4") is None


class TestSweep:
    def test_reads_the_pid_and_time_from_each_row(self, monkeypatch):
        _fake_run(monkeypatch, "  22751   1:02.34\n  23178  10:00.00\n")
        measured, _ = process_cpu.cpu_times([22751, 23178])
        assert measured == {22751: 62.34, 23178: 600.0}

    # Panes die while the sweep runs and `ps` exits non-zero once every target
    # is gone. Whatever printed is still real.
    def test_keeps_what_was_measured_when_the_command_exits_non_zero(self, monkeypatch):
        _fake_run(monkeypatch, "  1   0:01.00\n", returncode=1)
        measured, _ = process_cpu.cpu_times([1, 2])
        assert measured == {1: 1.0}

    def test_skips_rows_that_do_not_parse(self, monkeypatch):
        _fake_run(monkeypatch, "  PID TIME\n  5   -\n  6   0:02.00\n")
        measured, _ = process_cpu.cpu_times([5, 6])
        assert measured == {6: 2.0}

    def test_deduplicates_and_ignores_impossible_pids(self, monkeypatch):
        seen: dict[str, list[str]] = {}
        _fake_run(monkeypatch, "", capture_argv=seen)
        process_cpu.cpu_times([5, 5, 0, -1, 3])
        assert seen["argv"] == ["ps", "-o", "pid=,time=", "-p", "3,5"]

    # A panel that cannot measure shows nothing. An exception here would take
    # down the request that asked, which is a worse answer than "unavailable".
    def test_survives_a_missing_or_failing_command(self, monkeypatch):
        def boom(*_args, **_kwargs):
            raise OSError("no ps here")

        monkeypatch.setattr(process_cpu.subprocess, "run", boom)
        measured, taken_at = process_cpu.cpu_times([1])
        assert measured == {}
        assert taken_at > 0

    def test_measures_nothing_on_windows(self, monkeypatch):
        monkeypatch.setattr(process_cpu.sys, "platform", "win32")
        assert process_cpu.available() is False
        assert process_cpu.cpu_times([1])[0] == {}

    def test_skips_a_sweep_beyond_the_pid_cap(self, monkeypatch):
        def counting(*_args, **_kwargs):
            raise AssertionError("should not run")

        monkeypatch.setattr(process_cpu.subprocess, "run", counting)
        assert process_cpu.cpu_times(list(range(1, process_cpu._MAX_PIDS + 50)))[0] == {}

    # The caller divides by the interval between two readings, so the clock has
    # to be read after the subprocess returns — charging its duration to the
    # interval would understate every percentage.
    def test_timestamps_the_reading_after_the_command_returns(self, monkeypatch):
        clock = {"t": 100.0}
        monkeypatch.setattr(process_cpu.time, "time", lambda: clock["t"])

        class Result:
            stdout = "  1   0:01.00\n"
            returncode = 0

        def slow(*_args, **_kwargs):
            clock["t"] = 105.0
            return Result()

        monkeypatch.setattr(process_cpu.subprocess, "run", slow)
        _, taken_at = process_cpu.cpu_times([1])
        assert taken_at == 105.0


class TestGrouping:
    # A pane is a tree — the CLI, its MCP servers and anything else it spawned
    # hang below the PTY child, and all of it burns the user's CPU.
    def test_totals_every_pid_in_a_group(self):
        measured = {10: 1.5, 11: 2.5, 12: 0.5, 99: 7.0}
        groups = {"sess-a": [10, 11, 12], "sess-b": [99]}
        assert process_cpu.sum_by_group(groups, measured) == {
            "sess-a": 4.5,
            "sess-b": 7.0,
        }

    def test_a_group_whose_pids_were_not_measured_totals_zero(self):
        assert process_cpu.sum_by_group({"sess-a": [1, 2]}, {}) == {"sess-a": 0.0}


def _fake_run(monkeypatch, stdout: str, returncode: int = 0, capture_argv=None):
    class Result:
        def __init__(self) -> None:
            self.stdout = stdout
            self.returncode = returncode

    def fake(argv, **_kwargs):
        if capture_argv is not None:
            capture_argv["argv"] = list(argv)
        return Result()

    monkeypatch.setattr(process_cpu.subprocess, "run", fake)
