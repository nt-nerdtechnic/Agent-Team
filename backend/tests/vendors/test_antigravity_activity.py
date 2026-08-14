"""AntigravityLogReader.parse_activity — per-step activity from `steps`.

The conversation db keeps `idx` / `step_type` / `status` as plain integers, so
activity is read per step rather than inferred from the file's mtime. Only the
text sits in protobuf; the payload shapes encoded here mirror real
conversations (verified by decoding the on-disk ones).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from agent_team_backend.cli_vendors import antigravity as antigravity_mod
from agent_team_backend.log_readers import AntigravityLogReader


# ── protobuf encoding, just enough to build realistic payloads ──────────────

def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _field(number: int, value: bytes | int) -> bytes:
    if isinstance(value, int):
        return _varint(number << 3) + _varint(value)
    return _varint((number << 3) | 2) + _varint(len(value)) + value


def _metadata(epoch: int) -> bytes:
    """google.protobuf.Timestamp in the end-time field."""
    return _field(8, _field(1, epoch))


def _assistant(reply: str = "", thinking: str = "") -> bytes:
    """step_payload for an assistant step. Field 6 is a `bot-<uuid>` id that
    the reader must never mistake for text."""
    inner = b""
    if reply:
        inner += _field(1, reply.encode())
    if thinking:
        inner += _field(3, thinking.encode())
    inner += _field(6, b"bot-58b8114e-745b-4285-a3aa-32373cd6d380")
    return _field(20, inner)


def _user(prompt: str) -> bytes:
    # Field 3 carries the same text re-wrapped with a length prefix; the
    # reader must read field 2 and not that.
    inner = _field(2, prompt.encode()) + _field(3, b"\n\x24" + prompt.encode())
    return _field(19, inner)


# ── db fixture ──────────────────────────────────────────────────────────────

def _make_steps_db(path: Path, rows: list[tuple[int, int, int, bytes, bytes]]) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE `steps` (`idx` integer, `step_type` integer NOT NULL "
        "DEFAULT 0, `status` integer NOT NULL DEFAULT 0, `metadata` blob, "
        "`step_payload` blob, PRIMARY KEY (`idx`))"
    )
    con.executemany("INSERT INTO steps VALUES (?, ?, ?, ?, ?)", rows)
    con.commit()
    con.close()


def _reader_rooted_at(tmp_path: Path, monkeypatch) -> AntigravityLogReader:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / ".gemini" / "antigravity-cli" / "conversations").mkdir(parents=True)
    return AntigravityLogReader()


def _db_with(tmp_path: Path, monkeypatch, rows) -> tuple[AntigravityLogReader, Path]:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = reader.project_dirs()[0] / "aa11bb22.db"
    _make_steps_db(db, rows)
    return reader, db


# ── tests ───────────────────────────────────────────────────────────────────

def test_first_pass_records_watermark_without_reporting_history(
    tmp_path: Path, monkeypatch
) -> None:
    # Resuming an old conversation must not make its pane look busy.
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 14, 3, b"", _user("hi")),
        (1, 15, 3, _metadata(1_770_000_000), _assistant(reply="done")),
    ])
    seen: set[str] = set()

    assert reader.parse_activity(db, seen) == []
    assert seen == {"agy_idx::1"}


def test_first_pass_skips_past_a_capped_page(tmp_path: Path, monkeypatch) -> None:
    # Regression: the watermark used to come from the last row of ONE capped
    # page, so a long conversation replayed its remaining pages as fresh
    # activity on the next pass — showing a resumed pane as working.
    monkeypatch.setattr(antigravity_mod, "_MAX_STEPS_PER_PASS", 2)
    reader, db = _db_with(tmp_path, monkeypatch, [
        (idx, 21, 3, b"", b"") for idx in range(6)
    ])
    seen: set[str] = set()

    assert reader.parse_activity(db, seen) == []
    assert seen == {"agy_idx::5"}  # not ::1
    assert reader.parse_activity(db, seen) == []


def test_assistant_reply_completes_the_turn_with_its_text(
    tmp_path: Path, monkeypatch
) -> None:
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 15, 3, _metadata(1_770_000_000), _assistant(reply="all set ✅")),
    ])

    (event,) = reader.parse_activity(db, {"agy_idx::-1"})
    assert event.event_type == "turn_complete"
    assert event.detail == "assistant"
    assert event.text == "all set ✅"
    assert event.session_id == "aa11bb22"
    assert event.timestamp.startswith("2026-")


def test_reasoning_only_step_keeps_the_pane_active(
    tmp_path: Path, monkeypatch
) -> None:
    # Thinking is not talking: ending the turn here would open the messaging
    # gate mid-turn, which is what left injected messages sitting unsent.
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 15, 3, b"", _assistant(thinking="**Considering the deploy**")),
    ])

    (event,) = reader.parse_activity(db, {"agy_idx::-1"})
    assert (event.event_type, event.detail) == ("agent_active", "assistant:thinking")
    assert event.text == ""


def test_unfinished_assistant_step_is_not_a_completed_turn(
    tmp_path: Path, monkeypatch
) -> None:
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 15, 5, b"", _assistant(reply="partial")),
    ])

    (event,) = reader.parse_activity(db, {"agy_idx::-1"})
    assert event.event_type == "agent_active"


def test_bot_id_is_never_reported_as_turn_text(
    tmp_path: Path, monkeypatch
) -> None:
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 15, 3, b"", _assistant()),  # id field only
    ])

    (event,) = reader.parse_activity(db, {"agy_idx::-1"})
    assert event.event_type == "agent_active"
    assert "bot-" not in event.text


def test_user_step_carries_the_prompt_for_pane_naming(
    tmp_path: Path, monkeypatch
) -> None:
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 14, 3, b"", _user("分析目前的專案架構程式碼")),
    ])

    (event,) = reader.parse_activity(db, {"agy_idx::-1"})
    # "user" is the cross-end contract detail the frontend names panes from.
    assert (event.event_type, event.detail) == ("agent_active", "user")
    assert event.text == "分析目前的專案架構程式碼"


def test_question_step_ends_the_turn(tmp_path: Path, monkeypatch) -> None:
    # Blocked on the user's answer — a message sent now would just queue.
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 138, 3, b"", b""),
    ])

    (event,) = reader.parse_activity(db, {"agy_idx::-1"})
    assert (event.event_type, event.detail) == ("turn_complete", "assistant:question")


def test_tool_step_reports_activity_under_its_type(
    tmp_path: Path, monkeypatch
) -> None:
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 21, 3, _metadata(1_770_000_000), b""),
    ])

    (event,) = reader.parse_activity(db, {"agy_idx::-1"})
    assert (event.event_type, event.detail) == ("agent_active", "step-21")


def test_watermark_advances_so_steps_report_once(
    tmp_path: Path, monkeypatch
) -> None:
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 14, 3, b"", _user("go")),
        (1, 15, 3, b"", _assistant(reply="done")),
    ])
    seen = {"agy_idx::-1"}

    assert len(reader.parse_activity(db, seen)) == 2
    assert seen == {"agy_idx::1"}
    assert reader.parse_activity(db, seen) == []


def test_tool_step_after_a_reply_reopens_the_turn(
    tmp_path: Path, monkeypatch
) -> None:
    # A reply that precedes a tool call ends the turn early. The gate stays
    # shut because the tool's own step reports the pane active again.
    reader, db = _db_with(tmp_path, monkeypatch, [
        (0, 15, 3, b"", _assistant(reply="先看一下結構：")),
        (1, 21, 3, b"", b""),
    ])

    events = reader.parse_activity(db, {"agy_idx::-1"})
    assert [e.event_type for e in events] == ["turn_complete", "agent_active"]


def test_unreadable_db_reports_nothing(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = reader.project_dirs()[0] / "broken.db"
    db.write_bytes(b"not sqlite at all")
    seen = {"agy_idx::-1"}

    assert reader.parse_activity(db, seen) == []
    assert seen == {"agy_idx::-1"}  # watermark untouched
