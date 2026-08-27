"""Tests for read_pane_transcript — the restore path's history source."""

from agent_team_backend.spawn_history import read_pane_transcript


def _write_day(root, ymd: str, name: str, text: str) -> None:
    day = root / ".agent-team" / "manual" / ymd
    day.mkdir(parents=True, exist_ok=True)
    (day / name).write_text(text, encoding="utf-8")


def test_reads_nothing_when_the_pane_has_no_logs(tmp_path):
    assert read_pane_transcript(str(tmp_path), "claude", "abcd1234") == ("", False)


def test_joins_days_oldest_first(tmp_path):
    _write_day(tmp_path, "20260101", "claude-abcd1234.log", "older\n")
    _write_day(tmp_path, "20260102", "claude-abcd1234.log", "newer\n")
    text, truncated = read_pane_transcript(str(tmp_path), "claude", "abcd1234")
    assert text == "older\nnewer\n"
    assert truncated is False


def test_ignores_other_panes_and_other_agents(tmp_path):
    _write_day(tmp_path, "20260101", "claude-abcd1234.log", "mine\n")
    _write_day(tmp_path, "20260101", "claude-99999999.log", "other pane\n")
    _write_day(tmp_path, "20260101", "codex-abcd1234.log", "other agent\n")
    text, _ = read_pane_transcript(str(tmp_path), "claude", "abcd1234")
    assert text == "mine\n"


def test_pane_id_is_truncated_to_the_filename_form(tmp_path):
    # The renderer names the file with the first 8 chars of the pane UUID.
    _write_day(tmp_path, "20260101", "claude-abcd1234.log", "hit\n")
    text, _ = read_pane_transcript(str(tmp_path), "claude", "abcd1234-dead-beef-0000-000000000000")
    assert text == "hit\n"


def test_tail_is_capped_and_starts_on_a_line_boundary(tmp_path):
    _write_day(tmp_path, "20260101", "claude-abcd1234.log", "aaaa\nbbbb\ncccc\ndddd\n")
    text, truncated = read_pane_transcript(str(tmp_path), "claude", "abcd1234", max_bytes=12)
    assert truncated is True
    # The cap lands mid-line; the partial head is dropped rather than replayed.
    assert not text.startswith("b")
    assert text in ("cccc\ndddd\n", "dddd\n")


def test_newest_day_wins_when_the_cap_is_small(tmp_path):
    _write_day(tmp_path, "20260101", "claude-abcd1234.log", "old\n")
    _write_day(tmp_path, "20260102", "claude-abcd1234.log", "new\n")
    text, truncated = read_pane_transcript(str(tmp_path), "claude", "abcd1234", max_bytes=4)
    assert "new" in text
    assert "old" not in text
    assert truncated is True


def test_chunk_constant_matches_the_pty_output_slice():
    """A transcript frame must not be larger than a terminal.output frame.

    Both share one session send lock; a frame big enough to hold that lock in
    front of a heartbeat pong is what produced the spurious-disconnect reports.
    """
    from agent_team_backend.spawn_history import TRANSCRIPT_CHUNK_CHARS
    from agent_team_backend.terminals import _READ_CHUNK_BYTES

    assert TRANSCRIPT_CHUNK_CHARS <= _READ_CHUNK_BYTES


def test_drops_repaint_stub_rules(tmp_path):
    """A TUI redrawing its input frame leaves short rule fragments behind.

    `_clean_for_log` turns a lone \\r into a newline, so one repainted line
    becomes many. Replaying the short leftovers puts stray rules above the
    prompt; a real divider must still survive.
    """
    _write_day(
        tmp_path,
        "20260101",
        "claude-abcd1234.log",
        "real content\n"
        + "─" * 92 + "\n"      # genuine frame edge
        + "───\n"              # repaint stub
        + "───────\n"          # repaint stub
        + "more content\n",
    )
    text, _ = read_pane_transcript(str(tmp_path), "claude", "abcd1234")
    assert "real content" in text
    assert "more content" in text
    assert "─" * 92 in text            # the real one stays
    assert "\n───\n" not in text       # the stubs go
    assert "\n───────\n" not in text
