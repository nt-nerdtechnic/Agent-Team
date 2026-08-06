"""Tests for the persisted inter-CLI message log."""

from __future__ import annotations

import sqlite3

import pytest

from agent_team_backend.agent_message_log import (
    MAX_CONTENT_CHARS,
    MAX_ROWS,
    AgentMessageLog,
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
        {"uid": "a:4", "created_at": 100, "content": "no status"},
        {"uid": "a:5", "created_at": 100, "status": "queued"},
        "not a dict",
        _row("a:6", 600),
    ])
    assert written == 1
    assert [r["uid"] for r in log.tail()] == ["a:6"]


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


def test_append_survives_a_database_write_failure(log, monkeypatch, caplog):
    """A failed write degrades to memory-only: the rows stay readable in the
    tail buffer and the failure is only logged."""
    log.append([_row("a:1", 100)])

    def boom():
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(log._db, "transaction", boom)
    with caplog.at_level("WARNING"):
        assert log.append([_row("a:2", 200)]) == 0
    assert [r["uid"] for r in log.tail()] == ["a:1", "a:2"]
    assert any("agent message log append failed" in r.message for r in caplog.records)
