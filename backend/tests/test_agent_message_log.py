"""Tests for the persisted inter-CLI message log."""

from __future__ import annotations

import sqlite3

import pytest

from agent_team_backend.agent_message_log import (
    MAX_APPEND_ROWS,
    MAX_CONTENT_CHARS,
    MAX_ROWS,
    AgentMessageLog,
    _create_schema,
)
from agent_team_backend.db import Database


@pytest.fixture
def log(tmp_path):
    return AgentMessageLog(db=Database(tmp_path / "navide.db"))


def _row(uid: str, created_at: int, **over):
    row = {
        "uid": uid,
        "created_at": created_at,
        "status": "delivered",
        "sender": "alpha/claude-1",
        "recipient": "beta/reviewer",
        "content": f"hello {uid}",
    }
    row.update(over)
    return row


def test_append_and_tail_round_trip_oldest_first(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    assert store.append([_row("a:1", 100), _row("a:2", 200)]) == 2

    # A fresh store over the same database reads it back cold, oldest first.
    cold = AgentMessageLog(db=db)
    rows = cold.tail()
    assert [r["uid"] for r in rows] == ["a:1", "a:2"]
    assert rows[0]["sender"] == "alpha/claude-1"
    assert rows[0]["recipient"] == "beta/reviewer"
    assert rows[0]["content"] == "hello a:1"
    assert rows[0]["reason"] is None
    assert rows[0]["delivered_at"] is None


def test_tail_orders_by_created_at_not_insertion(tmp_path):
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db).append([_row("a:2", 200), _row("a:1", 100)])
    assert [r["uid"] for r in AgentMessageLog(db=db).tail()] == ["a:1", "a:2"]


def test_tail_limit_returns_the_newest(log):
    log.append([_row(f"a:{i}", i) for i in range(1, 6)])
    assert [r["uid"] for r in log.tail(2)] == ["a:4", "a:5"]


def test_append_before_the_first_read_does_not_hide_persisted_rows(tmp_path):
    """A backend restart under a live renderer: the new store writes before it
    ever reads, and must still report the rows written by its predecessor."""
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db).append([_row("a:1", 100), _row("a:2", 200)])

    restarted = AgentMessageLog(db=db)
    restarted.append([_row("a:3", 300)])
    assert [r["uid"] for r in restarted.tail()] == ["a:1", "a:2", "a:3"]


def test_repeated_uid_replaces_instead_of_duplicating(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row("a:1", 100, status="queued")])
    store.append([_row("a:1", 100, status="delivered", content="final")])

    for rows in (store.tail(), AgentMessageLog(db=db).tail()):
        assert len(rows) == 1
        assert rows[0]["status"] == "delivered"
        assert rows[0]["content"] == "final"


def test_prune_keeps_only_the_newest_max_rows(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row(f"a:{i:04d}", i) for i in range(MAX_ROWS + 20)])

    with db.transaction() as cur:
        total = cur.execute("SELECT COUNT(*) AS n FROM agent_message_log").fetchone()["n"]
    assert total == MAX_ROWS
    rows = AgentMessageLog(db=db).tail()
    assert len(rows) == MAX_ROWS
    assert rows[0]["uid"] == "a:0020"
    assert rows[-1]["uid"] == f"a:{MAX_ROWS + 19:04d}"


def test_prune_breaks_created_at_ties_by_insertion_order(tmp_path):
    """Realistic input: unpadded uids (they sort lexically, so `a3f9:100` <
    `a3f9:2`) and one `created_at` for the whole fan-out, which Date.now()
    ties at millisecond resolution."""
    db = Database(tmp_path / "navide.db")
    total = MAX_ROWS + 5
    AgentMessageLog(db=db).append(
        [_row(f"a3f9:{i}", 1000) for i in range(1, total + 1)]
    )

    rows = AgentMessageLog(db=db).tail()
    assert [r["uid"] for r in rows] == [f"a3f9:{i}" for i in range(6, total + 1)]


def test_reappending_a_row_keeps_its_place_in_the_log(tmp_path):
    """The frontend folds a pending status patch into a pending append row;
    the re-append must not jump the row to the end of a tied batch."""
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([
        _row("a:1", 1000, status="queued"),
        _row("a:2", 1000),
        _row("a:3", 1000),
    ])
    store.append([_row("a:1", 1000, status="delivered")])

    for rows in (store.tail(), AgentMessageLog(db=db).tail()):
        assert [r["uid"] for r in rows] == ["a:1", "a:2", "a:3"]
        assert rows[0]["status"] == "delivered"


def test_duplicate_uid_inside_one_batch_stores_a_single_row(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    assert store.append([
        _row("a:1", 100, status="queued"),
        _row("a:1", 100, status="delivered", content="final"),
    ]) == 1

    rows = AgentMessageLog(db=db).tail()
    assert [r["uid"] for r in rows] == ["a:1"]
    assert rows[0]["status"] == "delivered"
    assert rows[0]["content"] == "final"
    # One row means a later patch cannot land on a stale copy.
    assert store.update([{"uid": "a:1", "status": "failed"}]) == 1
    assert store.tail()[0]["status"] == "failed"


def test_an_oversized_batch_is_truncated_to_the_newest_rows(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    oversized = [_row(f"a:{i}", i) for i in range(1, MAX_APPEND_ROWS + 51)]
    assert store.append(oversized) == MAX_APPEND_ROWS
    assert store.tail()[-1]["uid"] == f"a:{MAX_APPEND_ROWS + 50}"


def test_update_writes_only_the_provided_fields(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row("a:1", 100, status="queued", content="body")])

    assert store.update([{"uid": "a:1", "status": "delivered", "delivered_at": 900}]) == 1
    for rows in (store.tail(), AgentMessageLog(db=db).tail()):
        assert rows[0]["status"] == "delivered"
        assert rows[0]["delivered_at"] == 900
        assert rows[0]["content"] == "body"  # untouched


def test_update_of_unknown_uid_is_a_silent_no_op(log):
    log.append([_row("a:1", 100)])
    assert log.update([{"uid": "gone:9", "status": "failed", "reason": "pruned"}]) == 0
    assert [r["uid"] for r in log.tail()] == ["a:1"]


def test_update_coerces_an_unknown_status_to_failed(log):
    log.append([_row("a:1", 100, status="queued")])
    log.update([{"uid": "a:1", "status": "exploded"}])
    assert log.tail()[0]["status"] == "failed"


def test_clear_keeps_queued_and_delivering_by_default(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([
        _row("a:1", 100, status="queued"),
        _row("a:2", 200, status="delivering"),
        _row("a:3", 300, status="delivered"),
        _row("a:4", 400, status="failed"),
    ])
    assert store.clear() == 2
    for rows in (store.tail(), AgentMessageLog(db=db).tail()):
        assert [r["uid"] for r in rows] == ["a:1", "a:2"]


def test_clear_with_explicit_empty_keep_deletes_everything(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row("a:1", 100, status="queued"), _row("a:2", 200)])
    assert store.clear([]) == 2
    assert store.tail() == []
    assert AgentMessageLog(db=db).tail() == []


def test_content_is_clamped_with_a_marker(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row("a:1", 100, content="x" * (MAX_CONTENT_CHARS * 2))])
    stored = AgentMessageLog(db=db).tail()[0]["content"]
    assert len(stored) == MAX_CONTENT_CHARS
    assert stored.endswith("[truncated]")


def test_invalid_rows_are_skipped(log):
    written = log.append([
        {"created_at": 100, "status": "queued", "content": "no uid"},
        {"uid": "a:2", "status": "queued", "content": "no created_at"},
        {"uid": "a:3", "created_at": "not a number", "status": "queued", "content": "x"},
        # json.loads accepts the non-standard `Infinity` literal and int()
        # raises OverflowError on it — that must skip one row, not the batch.
        {"uid": "a:4", "created_at": float("inf"), "status": "queued", "content": "x"},
        {"uid": "a:5", "created_at": 100, "content": "no status"},
        {"uid": "a:6", "created_at": 100, "status": "queued"},
        "not a dict",
        _row("a:7", 700),
    ])
    assert written == 1
    assert [r["uid"] for r in log.tail()] == ["a:7"]


def test_unknown_status_on_append_becomes_failed(log):
    log.append([_row("a:1", 100, status="weird")])
    assert log.tail()[0]["status"] == "failed"


def test_optional_columns_round_trip(tmp_path):
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db).append([
        _row(
            "a:1",
            100,
            status="failed",
            reason="rate limit",
            delivered_at=150,
            remote="outbound",
            remote_workspace="/ws/beta",
        )
    ])
    row = AgentMessageLog(db=db).tail()[0]
    assert row["reason"] == "rate limit"
    assert row["delivered_at"] == 150
    assert row["remote"] == "outbound"
    assert row["remote_workspace"] == "/ws/beta"


def _boom():
    raise sqlite3.OperationalError("disk I/O error")


def test_append_failure_is_swallowed_and_nothing_is_persisted(log, monkeypatch, caplog):
    """A failed write is logged and reported as 0 rows — and tail() says the
    same thing, cold or warm, because there is nowhere else for it to live."""
    log.append([_row("a:1", 100)])

    monkeypatch.setattr(log._db, "transaction", _boom)
    with caplog.at_level("WARNING"):
        assert log.append([_row("a:2", 200)]) == 0
    monkeypatch.undo()

    assert [r["uid"] for r in log.tail()] == ["a:1"]
    assert [r["uid"] for r in AgentMessageLog(db=log._db).tail()] == ["a:1"]
    assert any("agent message log append failed" in r.message for r in caplog.records)


def test_update_failure_is_swallowed_and_leaves_the_row_untouched(log, monkeypatch, caplog):
    log.append([_row("a:1", 100, status="queued"), _row("a:2", 200, status="queued")])

    monkeypatch.setattr(log._db, "transaction", _boom)
    with caplog.at_level("WARNING"):
        assert log.update([
            {"uid": "a:1", "status": "delivered"},
            {"uid": "a:2", "status": "failed"},
        ]) == 0
    monkeypatch.undo()

    assert [r["status"] for r in AgentMessageLog(db=log._db).tail()] == ["queued", "queued"]
    assert any("agent message log update failed" in r.message for r in caplog.records)


def test_clear_failure_is_swallowed_and_leaves_the_rows_in_place(log, monkeypatch, caplog):
    log.append([_row("a:1", 100, status="queued"), _row("a:2", 200, status="delivered")])

    monkeypatch.setattr(log._db, "transaction", _boom)
    with caplog.at_level("WARNING"):
        assert log.clear() == 0
    monkeypatch.undo()

    assert [r["uid"] for r in AgentMessageLog(db=log._db).tail()] == ["a:1", "a:2"]
    assert any("agent message log clear failed" in r.message for r in caplog.records)


def test_a_fresh_database_migrates_straight_to_the_current_schema(tmp_path):
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db)
    assert db.schema_version("agent_message_log") == 3
    with db.transaction() as cur:
        columns = {
            r["name"] for r in cur.execute("PRAGMA table_info(agent_message_log)").fetchall()
        }
    assert {"seq", "sender_agent", "recipient_agent"} <= columns


def test_an_existing_v1_database_upgrades_and_backfills_seq(tmp_path):
    db = Database(tmp_path / "navide.db")
    db.migrate("agent_message_log", 1, _create_schema)
    with db.transaction() as cur:
        for uid, created_at in (("a3f9:2", 100), ("a3f9:1", 100), ("a3f9:10", 50)):
            cur.execute(
                "INSERT INTO agent_message_log"
                " (uid, created_at, status, sender, recipient, content)"
                " VALUES (?, ?, 'delivered', 's', 'r', 'x')",
                (uid, created_at),
            )

    store = AgentMessageLog(db=db)
    assert db.schema_version("agent_message_log") == 3
    with db.transaction() as cur:
        seqs = {
            r["uid"]: r["seq"]
            for r in cur.execute("SELECT uid, seq FROM agent_message_log").fetchall()
        }
    assert seqs == {"a3f9:10": 1, "a3f9:1": 2, "a3f9:2": 3}

    # New rows continue the counter instead of colliding with the backfill.
    store.append([_row("a3f9:11", 100)])
    assert [r["uid"] for r in AgentMessageLog(db=db).tail()] == [
        "a3f9:10", "a3f9:1", "a3f9:2", "a3f9:11",
    ]


def test_rows_written_before_v3_keep_no_vendor(tmp_path):
    """The vendor columns are additive: a pre-v3 row still reads back, with both
    sides unknown rather than guessed from whatever runs under that name now."""
    db = Database(tmp_path / "navide.db")
    db.migrate("agent_message_log", 1, _create_schema)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO agent_message_log"
            " (uid, created_at, status, sender, recipient, content)"
            " VALUES ('old:1', 100, 'delivered', 'alpha', 'beta', 'x')"
        )

    store = AgentMessageLog(db=db)
    rows = store.tail()

    assert len(rows) == 1
    assert rows[0]["sender_agent"] is None
    assert rows[0]["recipient_agent"] is None


def test_vendors_round_trip(tmp_path):
    store = AgentMessageLog(db=Database(tmp_path / "navide.db"))
    store.append([_row("a:1", 100) | {"sender_agent": "claude", "recipient_agent": "codex"}])

    row = store.tail()[0]

    assert row["sender_agent"] == "claude"
    assert row["recipient_agent"] == "codex"
