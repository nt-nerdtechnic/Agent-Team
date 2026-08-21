"""Activity dedup must not grow with the transcript.

`parse_activity`'s `seen_keys` bag lives as long as the file does
(LogWatcher._activity_seen). Readers that walked a JSONL log from line 1 left
one `act:{line_no}` key in it per line, so the bag grew forever: measured
2026-08-18, 452,693 live keys two minutes into a zero-pane startup scan,
pinning 481 MB of pymalloc arenas the interpreter can never return (GitHub #23).

A dense ascending line scan needs only a high-water mark. These tests pin both
halves: the mark behaves like the per-line keys did, and the bag stays O(1).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.log_readers.base import (
    activity_high_water,
    set_activity_high_water,
)


# ── the shared helpers ───────────────────────────────────────────────────

def test_high_water_round_trips() -> None:
    seen: set[str] = set()
    assert activity_high_water(seen) == 0
    set_activity_high_water(seen, 42)
    assert activity_high_water(seen) == 42
    assert len(seen) == 1


def test_high_water_replaces_rather_than_accumulates() -> None:
    """The whole point: advancing the mark must not add a second key."""
    seen: set[str] = set()
    for n in range(1, 501):
        set_activity_high_water(seen, n)
    assert activity_high_water(seen) == 500
    assert len(seen) == 1


def test_high_water_never_moves_backwards() -> None:
    """A truncated file must not un-see lines, which is what the per-line
    keys did (they simply stayed in the set)."""
    seen: set[str] = set()
    set_activity_high_water(seen, 100)
    set_activity_high_water(seen, 7)
    assert activity_high_water(seen) == 100


def test_high_water_coexists_with_vendor_sentinels() -> None:
    """Nine readers keep their own state in this same bag as prefixed
    sentinels and find it by scanning. The mark must not collide with them,
    and must not evict them."""
    seen = {"qwen_text::hello", "pi_turn::{}", "__lasttext__:x"}
    set_activity_high_water(seen, 5)
    set_activity_high_water(seen, 9)
    assert activity_high_water(seen) == 9
    assert {"qwen_text::hello", "pi_turn::{}", "__lasttext__:x"} <= seen
    assert len(seen) == 4


def test_corrupt_mark_restarts_the_scan() -> None:
    seen = {"act_hw::not-a-number"}
    assert activity_high_water(seen) == 0


# ── claude: the reader the 4 GB trace named ──────────────────────────────

def _transcript(tmp_path: Path, turns: int) -> Path:
    p = tmp_path / "sess.jsonl"
    with p.open("w", encoding="utf-8") as fh:
        for i in range(turns):
            fh.write(json.dumps({
                "type": "assistant",
                "timestamp": f"2026-08-18T00:00:{i:02d}Z",
                "message": {"stop_reason": "end_turn",
                            "content": [{"type": "text", "text": f"turn {i}"}]},
            }) + "\n")
    return p


def test_claude_seen_keys_stay_constant_size(tmp_path: Path) -> None:
    """1000 lines parsed across many polls -> one key, not one per line."""
    reader = ClaudeLogReader()
    path = _transcript(tmp_path, 1000)
    seen: set[str] = set()

    reader.parse_activity(path, seen)

    assert len(seen) == 1
    assert activity_high_water(seen) == 1000


def test_claude_does_not_re_emit_parsed_lines(tmp_path: Path) -> None:
    """The behaviour the per-line keys existed to provide."""
    reader = ClaudeLogReader()
    path = _transcript(tmp_path, 5)
    seen: set[str] = set()

    first = reader.parse_activity(path, seen)
    again = reader.parse_activity(path, seen)

    assert first, "expected events on the first pass"
    assert again == []


def test_claude_emits_only_appended_lines(tmp_path: Path) -> None:
    """Incremental delivery still works: a poll after an append sees exactly
    the new turn, with its line-relative dedup keys intact."""
    reader = ClaudeLogReader()
    path = _transcript(tmp_path, 3)
    seen: set[str] = set()
    reader.parse_activity(path, seen)

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "type": "assistant",
            "timestamp": "2026-08-18T00:01:00Z",
            "message": {"stop_reason": "end_turn",
                        "content": [{"type": "text", "text": "fourth"}]},
        }) + "\n")

    fresh = reader.parse_activity(path, seen)

    assert [e.event_type for e in fresh] == ["agent_active", "turn_complete"]
    assert {e.dedup_key for e in fresh} == {"act:4", "turn:4"}
    assert len(seen) == 1


def test_claude_blank_lines_do_not_stall_the_mark(tmp_path: Path) -> None:
    """Blank lines are skipped before the seen test, so they must not make
    the mark lag behind and re-deliver the lines that follow them."""
    reader = ClaudeLogReader()
    path = tmp_path / "gappy.jsonl"
    rec = json.dumps({
        "type": "assistant",
        "timestamp": "2026-08-18T00:00:00Z",
        "message": {"stop_reason": "end_turn", "content": [{"type": "text", "text": "x"}]},
    })
    path.write_text(f"{rec}\n\n\n{rec}\n", encoding="utf-8")

    seen: set[str] = set()
    reader.parse_activity(path, seen)
    assert reader.parse_activity(path, seen) == []


def test_claude_malformed_line_is_not_retried(tmp_path: Path) -> None:
    """A line that fails json.loads used to be marked seen so later polls
    skipped it. The mark must preserve that — copilot deliberately does the
    opposite and is therefore excluded from this scheme."""
    reader = ClaudeLogReader()
    path = tmp_path / "bad.jsonl"
    path.write_text("{not json\n", encoding="utf-8")

    seen: set[str] = set()
    reader.parse_activity(path, seen)
    assert activity_high_water(seen) == 1
    assert reader.parse_activity(path, seen) == []


# ── a walk that dies mid-file must keep the ground it covered ────────────

def _long_line(i: int) -> str:
    """~500 bytes, so a few dozen lines exceed TextIOWrapper's read chunk and
    are really yielded before a later chunk can fail to decode."""
    return json.dumps({
        "type": "assistant",
        "timestamp": f"2026-08-18T00:00:{i % 60:02d}Z",
        "message": {"stop_reason": "end_turn",
                    "content": [{"type": "text", "text": f"turn {i} " + "x" * 420}]},
    }) + "\n"


def _truncated_utf8_transcript(tmp_path: Path, good_lines: int) -> Path:
    """`good_lines` complete records, then a record whose last byte sequence
    is cut in half — what a poll sees when the CLI is mid-write."""
    p = tmp_path / "partial.jsonl"
    with p.open("wb") as fh:
        for i in range(good_lines):
            fh.write(_long_line(i).encode("utf-8"))
        # '好' is 3 bytes; write only the first two.
        fh.write(b'{"type": "user", "message": {"content": "' + "好".encode()[:2])
    return p


def test_partial_write_keeps_the_progress_the_walk_made(tmp_path: Path) -> None:
    """A transcript the CLI is still writing decodes into the reader's line
    iterator and raises. The mark must already carry the lines that were
    parsed: without it the next poll restarts at line 1 and re-emits every
    `agent_active` / `turn_complete` in the file — turn text and MSG blocks
    included — at a pane that is live and attributed by then.
    """
    reader = ClaudeLogReader()
    path = _truncated_utf8_transcript(tmp_path, good_lines=60)
    seen: set[str] = set()

    with pytest.raises(UnicodeDecodeError):
        reader.parse_activity(path, seen)

    covered = activity_high_water(seen)
    assert covered > 0, "the walk's progress was thrown away with the exception"
    assert covered <= 60


def test_partial_write_does_not_re_emit_once_the_line_lands(tmp_path: Path) -> None:
    """The poll after the CLI finishes the record emits the tail only."""
    reader = ClaudeLogReader()
    path = _truncated_utf8_transcript(tmp_path, good_lines=60)
    seen: set[str] = set()
    with pytest.raises(UnicodeDecodeError):
        reader.parse_activity(path, seen)
    covered = activity_high_water(seen)
    assert covered > 0

    # The CLI completes its write: the file is valid UTF-8 again.
    with path.open("wb") as fh:
        for i in range(61):
            fh.write(_long_line(i).encode("utf-8"))

    events = reader.parse_activity(path, seen)

    replayed = [e for e in events if int(e.dedup_key.split(":")[-1]) <= covered]
    assert replayed == [], f"re-emitted {len(replayed)} already-parsed line(s)"
    assert events, "expected the lines past the mark to be delivered"
