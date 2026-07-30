"""Tests for the append-only pipeline history store."""

from __future__ import annotations

import json
import sqlite3

from agent_team_backend.history_store import (
    HistoryStore,
    classify_orchestrator_line,
)


def test_record_persists_and_returns_event(tmp_path):
    ws = str(tmp_path)
    store = HistoryStore()
    ev = store.record(ws, run_dir="runs/r1", type="sentinel_detected", summary="---SPEC-DONE---")
    assert ev["type"] == "sentinel_detected"
    assert ev["id"] and ev["ts"]
    # A fresh store (new instance, same workspace db) reads the event back.
    cold = HistoryStore()
    got = cold.tail(ws, "runs/r1")
    assert [e["summary"] for e in got] == ["---SPEC-DONE---"]


def test_record_survives_a_database_write_failure(tmp_path, monkeypatch, caplog):
    """A failed database write degrades like the old JSONL append: the event
    stays in the in-memory tail and the failure is only logged."""
    ws = str(tmp_path)
    store = HistoryStore()
    store.record(ws, type="log", summary="first")
    db = store._databases.get(ws)

    def boom():
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(db, "transaction", boom)
    with caplog.at_level("WARNING"):
        event = store.record(ws, type="log", summary="second")
    assert event["summary"] == "second"
    assert [e["summary"] for e in store.tail(ws)] == ["first", "second"]
    assert any("history append failed" in r.message for r in caplog.records)


def test_tail_serves_memory_then_disk(tmp_path):
    ws = str(tmp_path)
    store = HistoryStore()
    for i in range(5):
        store.record(ws, run_dir="runs/r1", type="log", summary=f"line {i}")
    # Warm read from memory buffer.
    tail = store.tail(ws, "runs/r1", limit=3)
    assert [e["summary"] for e in tail] == ["line 2", "line 3", "line 4"]

    # A fresh store (cold) must read the same data back from disk.
    cold = HistoryStore()
    got = cold.tail(ws, "runs/r1")
    assert [e["summary"] for e in got] == [f"line {i}" for i in range(5)]


def test_legacy_jsonl_imported_once_and_retired(tmp_path):
    """A legacy history.jsonl is imported on first access of its run: torn
    trailing lines are skipped and the source is renamed .migrated-v1."""
    ws = str(tmp_path)
    path = tmp_path / ".agent-team" / "runs" / "r1" / "history.jsonl"
    path.parent.mkdir(parents=True)
    with path.open("w", encoding="utf-8") as fh:
        fh.write(json.dumps({"id": "e1", "ts": "t", "type": "log", "summary": "good"}) + "\n")
        fh.write("{ this is not valid json\n")
    cold = HistoryStore()
    got = cold.tail(ws, "runs/r1")
    assert [e["summary"] for e in got] == ["good"]
    assert not path.exists()
    assert path.with_name(path.name + ".migrated-v1").exists()
    # A second cold store serves the imported rows (no re-import, no dupes).
    assert [e["summary"] for e in HistoryStore().tail(ws, "runs/r1")] == ["good"]


def test_legacy_writer_regenerated_jsonl_is_appended(tmp_path):
    """Coexistence: an older app version recreates history.jsonl after the
    import completed. Its events are new (recorded post-migration), so they
    are appended as fresh rows and the file is retired again."""
    ws = str(tmp_path)
    store = HistoryStore()
    store.record(ws, run_dir="runs/r1", type="log", summary="from db")

    path = tmp_path / ".agent-team" / "runs" / "r1" / "history.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps({"id": "e2", "ts": "t", "type": "log", "summary": "from legacy"})
        + "\n",
        encoding="utf-8",
    )
    cold = HistoryStore()
    got = cold.tail(ws, "runs/r1")
    assert [e["summary"] for e in got] == ["from db", "from legacy"]
    assert not path.exists()
    assert path.with_name(path.name + ".migrated-v1").exists()


def test_record_line_classifies_and_extracts_stage(tmp_path):
    ws = str(tmp_path)
    store = HistoryStore()
    ev = store.record_line(ws, "[3:02:42 AM] Stage 02 ✓ sentinel detected", run_dir="runs/r1")
    assert ev["type"] == "sentinel_detected"
    assert ev["stage_id"] == "02"
    assert ev["summary"] == "Stage 02 ✓ sentinel detected"  # time prefix stripped


def test_classify_orchestrator_line_rules():
    cases = {
        "[t] 🎉 Pipeline completed all stages": "pipeline_complete",
        "[t] Stage 02 ✓ sentinel detected": "sentinel_detected",
        "[t] Stage 04 ✓ turn_complete + clean-quiet (no sentinel)": "stage_completed",
        "[t] Stage 01 🧠 asking analyzer (1211 chars)": "analyzer_result",
        "[t] Stage 02 🔀 handoff: Backend → Frontend": "context_handoff",
        "[t] Stage 02 🎯 Manager router poll started": "manager",
        "[t] Stage 01 ❓ agent asked 1 question(s)": "question_detected",
        "[t] Stage 03 ▶ activate 1 slot(s)": "stage_advance",
        "[t] [04/Backend] ✓ kickoff sent": "pane_spawn",
        "[t] some plain status line": "log",
    }
    for line, expected in cases.items():
        etype, _summary = classify_orchestrator_line(line)
        assert etype == expected, f"{line!r} → {etype} (expected {expected})"
