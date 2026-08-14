"""OpencodeLogReader.parse_activity — per-part activity from the shared db.

Opencode records turn ends outright: a `step-finish` part carries the LLM's
finish reason, where `"stop"` means the agent finished replying and
`"tool-calls"` means it paused to run something. Kilo Code is a fork with the
same schema and inherits all of this.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import opencode as opencode_mod
from agent_team_backend.log_readers import KiloLogReader, OpencodeLogReader
from agent_team_backend.log_readers.base import LogReader


def _make_db(path: Path, parts: list[dict], sessions: list[dict] | None = None) -> None:
    """Minimal opencode db. `parts` entries carry their own message role so a
    test can describe a whole turn in one list."""
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT)")
    con.execute("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)")
    con.execute(
        "CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, "
        "data TEXT, time_created INTEGER)"
    )
    for s in sessions or [{"id": "ses_1", "directory": "/ws", "parent_id": None}]:
        con.execute(
            "INSERT INTO session VALUES (?, ?, ?)",
            (s["id"], s.get("directory", "/ws"), s.get("parent_id")),
        )
    seen_messages: set[str] = set()
    for i, p in enumerate(parts):
        session_id = p.get("session_id", "ses_1")
        message_id = p.get("message_id", f"msg_{i}")
        if message_id not in seen_messages:
            con.execute(
                "INSERT INTO message VALUES (?, ?, ?)",
                (message_id, session_id, json.dumps({"role": p.get("role", "assistant")})),
            )
            seen_messages.add(message_id)
        con.execute(
            "INSERT INTO part VALUES (?, ?, ?, ?, ?)",
            (f"prt_{i}", session_id, message_id, json.dumps(p["data"]), 1_770_000_000_000 + i),
        )
    con.commit()
    con.close()


def _reader_rooted_at(tmp_path: Path, monkeypatch, parts, sessions=None) -> tuple[OpencodeLogReader, Path]:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    data_dir = tmp_path / "opencode"
    data_dir.mkdir(parents=True)
    db = data_dir / "opencode.db"
    _make_db(db, parts, sessions)
    return OpencodeLogReader(), db


# A whole turn: prompt, reasoning, a tool call, then the reply and its end.
TURN = [
    {"role": "user", "message_id": "m_u", "data": {"type": "text", "text": "run the tests"}},
    {"message_id": "m_a", "data": {"type": "step-start"}},
    {"message_id": "m_a", "data": {"type": "reasoning", "text": "thinking"}},
    {"message_id": "m_a", "data": {"type": "tool", "tool": "bash"}},
    {"message_id": "m_a", "data": {"type": "step-finish", "reason": "tool-calls"}},
    {"message_id": "m_a", "data": {"type": "text", "text": "All 12 tests pass."}},
    {"message_id": "m_a", "data": {"type": "step-finish", "reason": "stop"}},
]


def test_first_pass_records_the_watermark_without_reporting_history(
    tmp_path: Path, monkeypatch
) -> None:
    reader, db = _reader_rooted_at(tmp_path, monkeypatch, TURN)
    seen: set[str] = set()

    assert reader.parse_activity(db, seen) == []
    assert seen == {"opencode_part::7"}


def test_first_pass_skips_past_a_capped_page(tmp_path: Path, monkeypatch) -> None:
    # Regression: the watermark used to come from the last row of ONE capped
    # page, so every page after it replayed as fresh activity next pass —
    # lighting up idle panes from a db that holds every session ever run.
    monkeypatch.setattr(opencode_mod, "_MAX_PARTS_PER_PASS", 2)
    reader, db = _reader_rooted_at(tmp_path, monkeypatch, TURN)
    seen: set[str] = set()

    assert reader.parse_activity(db, seen) == []
    assert seen == {"opencode_part::7"}  # not ::2
    assert reader.parse_activity(db, seen) == []


def test_finish_reason_stop_completes_the_turn_with_the_reply(
    tmp_path: Path, monkeypatch
) -> None:
    reader, db = _reader_rooted_at(tmp_path, monkeypatch, TURN)

    events = reader.parse_activity(db, {"opencode_part::0"})
    ends = [e for e in events if e.event_type == "turn_complete"]

    assert len(ends) == 1
    assert ends[0].detail == "assistant"
    assert ends[0].text == "All 12 tests pass."
    assert ends[0].cwd == "/ws"
    assert ends[0].session_id == "ses_1"
    assert ends[0].timestamp.startswith("2026-")


def test_tool_calls_pause_does_not_end_the_turn(tmp_path: Path, monkeypatch) -> None:
    # Ending the turn here would open the messaging gate while the agent is
    # only pausing to run a tool.
    reader, db = _reader_rooted_at(tmp_path, monkeypatch, TURN)

    events = reader.parse_activity(db, {"opencode_part::0"})
    pause = next(e for e in events if e.detail.startswith("step-finish:"))

    assert (pause.event_type, pause.detail) == ("agent_active", "step-finish:tool-calls")


def test_reports_each_part_kind(tmp_path: Path, monkeypatch) -> None:
    reader, db = _reader_rooted_at(tmp_path, monkeypatch, TURN)

    events = reader.parse_activity(db, {"opencode_part::0"})

    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"),
        ("agent_active", "step-start"),
        ("agent_active", "assistant:thinking"),
        ("agent_active", "tool:bash"),
        ("agent_active", "step-finish:tool-calls"),
        ("agent_active", "assistant"),
        ("turn_complete", "assistant"),
    ]


def test_user_part_carries_the_prompt_for_pane_naming(tmp_path: Path, monkeypatch) -> None:
    reader, db = _reader_rooted_at(tmp_path, monkeypatch, TURN)

    events = reader.parse_activity(db, {"opencode_part::0"})
    prompt = events[0]

    # "user" is the cross-end contract detail the frontend names panes from.
    assert (prompt.event_type, prompt.detail) == ("agent_active", "user")
    assert prompt.text == "run the tests"


def test_subagent_completion_is_not_the_panes_turn_end(tmp_path: Path, monkeypatch) -> None:
    # A child session shares its parent's directory, so both resolve to the
    # same pane. Treating the child's stop as a turn end would free the gate
    # while the parent is still working.
    parts = [
        {"session_id": "ses_child", "message_id": "m_c",
         "data": {"type": "step-finish", "reason": "stop"}},
    ]
    sessions = [
        {"id": "ses_1", "directory": "/ws", "parent_id": None},
        {"id": "ses_child", "directory": "/ws", "parent_id": "ses_1"},
    ]
    reader, db = _reader_rooted_at(tmp_path, monkeypatch, parts, sessions)

    (event,) = reader.parse_activity(db, {"opencode_part::0"})

    assert (event.event_type, event.detail) == ("agent_active", "subagent:done")


def test_watermark_advances_so_parts_report_once(tmp_path: Path, monkeypatch) -> None:
    reader, db = _reader_rooted_at(tmp_path, monkeypatch, TURN)
    seen = {"opencode_part::0"}

    assert len(reader.parse_activity(db, seen)) == len(TURN)
    assert seen == {"opencode_part::7"}
    assert reader.parse_activity(db, seen) == []


def test_kilo_inherits_the_reader_under_its_own_vendor(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    data_dir = tmp_path / "kilo"
    data_dir.mkdir(parents=True)
    db = data_dir / "kilo.db"
    _make_db(db, TURN)
    reader = KiloLogReader()

    assert reader.session_files() == [db]
    events = reader.parse_activity(db, {"opencode_part::0"})

    assert {e.vendor for e in events} == {"kilo"}
    assert any(e.event_type == "turn_complete" for e in events)


def test_non_session_files_report_nothing(tmp_path: Path, monkeypatch) -> None:
    reader, db = _reader_rooted_at(tmp_path, monkeypatch, TURN)
    other = db.parent / "auth.json"
    other.write_text("{}")
    seen: set[str] = set()

    assert reader.parse_activity(other, seen) == []
    assert seen == set()


def test_unreadable_db_reports_nothing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    data_dir = tmp_path / "opencode"
    data_dir.mkdir(parents=True)
    db = data_dir / "opencode.db"
    db.write_bytes(b"not sqlite at all")
    reader = OpencodeLogReader()
    seen = {"opencode_part::0"}

    assert reader.parse_activity(db, seen) == []
    assert seen == {"opencode_part::0"}  # watermark untouched


@pytest.mark.parametrize("reader_cls", [OpencodeLogReader, KiloLogReader])
def test_both_vendors_override_the_inert_base(reader_cls) -> None:
    # The base returns [] — which is what left these two silent, and the
    # messaging gate open. Kilo gets the override by inheritance, so this also
    # guards against the fork drifting into its own (missing) implementation.
    assert reader_cls.parse_activity is not LogReader.parse_activity
