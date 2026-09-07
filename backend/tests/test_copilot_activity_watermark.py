"""Copilot's activity dedup is a bounded watermark, not a key per line.

Same GitHub #28 mechanism as grok: the watcher drops an activity dedup bag
larger than _ACTIVITY_KEYS_PERSIST_LIMIT rather than truncating it, so a reader
that leaves one key per line never gets its cursor persisted and replays its
whole file on every backend start. Copilot's events.jsonl walk is a dense
ascending scan, so its progress collapses into the shared line high-water mark.

`activity_resumes_by_line` deliberately stays False for this reader even so:
the flag is per-READER, and this one also serves session-store.db, whose bag is
keyed on db row ids. Flipping it would have the watcher count newlines in a
SQLite file and drop a line number into a bag nothing consults.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.cli_vendors.copilot import CopilotLogReader
from agent_team_backend.log_readers.base import activity_high_water
from agent_team_backend.log_readers.watcher import _ACTIVITY_KEYS_PERSIST_LIMIT


def _events(root: Path, session: str, records: list[dict], *, terminated: bool = True) -> Path:
    d = root / "session-state" / session
    d.mkdir(parents=True, exist_ok=True)
    path = d / "events.jsonl"
    body = "".join(json.dumps(r) + "\n" for r in records)
    if not terminated and body.endswith("\n"):
        body = body[:-1]
    path.write_text(body, encoding="utf-8")
    return path


def _turn(n: int) -> list[dict]:
    return [
        {"type": "user.message", "content": f"ask {n}", "timestamp": f"2026-09-07T00:00:{n:02d}Z"},
        {"type": "assistant.message", "content": f"reply {n}", "timestamp": f"2026-09-07T00:00:{n:02d}Z"},
        {"type": "assistant.turn_end", "timestamp": f"2026-09-07T00:00:{n:02d}Z"},
    ]


def test_a_second_pass_over_an_unchanged_file_emits_nothing(tmp_path: Path) -> None:
    """The restart case, which is the whole reason the mark exists."""
    path = _events(tmp_path, "s1", _turn(1) + _turn(2))
    reader = CopilotLogReader()

    seen: set[str] = set()
    assert reader.parse_activity(path, seen), "the first pass delivered nothing"
    assert reader.parse_activity(path, seen) == [], "the file replayed on the second pass"


def test_only_lines_past_the_mark_are_emitted(tmp_path: Path) -> None:
    path = _events(tmp_path, "s1", _turn(1))
    reader = CopilotLogReader()
    seen: set[str] = set()
    reader.parse_activity(path, seen)

    path.write_text(
        path.read_text() + "".join(json.dumps(r) + "\n" for r in _turn(2)),
        encoding="utf-8",
    )
    out = reader.parse_activity(path, seen)
    assert out, "an appended turn never arrived"
    assert not any("ask 1" in (e.text or "") for e in out), "a line before the mark came back"


def test_the_bag_stays_small_enough_to_persist(tmp_path: Path) -> None:
    """One key per line is exactly what made the watcher refuse to store it."""
    records: list[dict] = []
    for n in range(40):
        records.extend(_turn(n))
    path = _events(tmp_path, "s1", records)

    seen: set[str] = set()
    CopilotLogReader().parse_activity(path, seen)
    assert len(seen) <= _ACTIVITY_KEYS_PERSIST_LIMIT, (
        f"{len(seen)} keys for {len(records)} lines — the watcher would drop this bag"
    )


def test_a_half_written_final_record_keeps_the_mark_behind_it(tmp_path: Path) -> None:
    """GitHub #21. A record still mid-write does not parse AND has no newline
    yet; the mark must stay behind it so the completed line is delivered on a
    later poll. Advancing past it drops those events for good, and when the
    lost line is assistant.turn_end the pane stays "mid-turn" forever.

    Note the guard is on decode failure, not on the missing newline alone: a
    line that parses is complete content whether or not its newline landed.
    """
    d = tmp_path / "session-state" / "s1"
    d.mkdir(parents=True, exist_ok=True)
    path = d / "events.jsonl"
    body = "".join(json.dumps(r) + "\n" for r in _turn(1))
    path.write_text(body + '{"type": "assistant.turn_e', encoding="utf-8")

    seen: set[str] = set()
    CopilotLogReader().parse_activity(path, seen)

    complete_lines = len(_turn(1))
    assert activity_high_water(seen) == complete_lines, (
        "the mark moved onto a record that is still being written"
    )


def test_a_terminated_unparseable_line_is_stepped_over(tmp_path: Path) -> None:
    """The other half of the same branch: a finished line that will never parse
    must not hold the mark behind it, or every poll re-emits the whole rest of
    the file."""
    d = tmp_path / "session-state" / "s1"
    d.mkdir(parents=True, exist_ok=True)
    path = d / "events.jsonl"
    body = "".join(json.dumps(r) + "\n" for r in _turn(1))
    path.write_text(body + "not json at all\n", encoding="utf-8")

    seen: set[str] = set()
    CopilotLogReader().parse_activity(path, seen)
    assert activity_high_water(seen) == len(_turn(1)) + 1, (
        "a permanently broken line held the mark hostage"
    )
