"""One-time import of the legacy ingestion state (snapshot + delta log +
write-ahead journal) into SQLite, and the dirty-row commit semantics that
replaced the append-only delta log."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from agent_team_backend.tokens_store import TokensStore

CHECKPOINT = {"kind": "jsonl", "offset": 10, "identity": "1:1"}


def _store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
        recorded_keys_path=tmp_path / "recorded-event-keys.json",
        legacy_reader_keys_path=tmp_path / "log-readers-seen.json",
    )


def _snapshot(tmp_path: Path) -> Path:
    return tmp_path / "token-ingestion-state.json"


def _delta(tmp_path: Path) -> Path:
    return tmp_path / "token-ingestion-delta.jsonl"


def _journal(tmp_path: Path) -> Path:
    return tmp_path / "token-persistence-journal.json"


def _write_snapshot(tmp_path: Path, files: dict, **extra) -> None:
    doc = {
        "version": 2,
        "files": files,
        "legacy_event_keys": [],
        "recent_event_keys": [],
    }
    doc.update(extra)
    _snapshot(tmp_path).write_text(json.dumps(doc), encoding="utf-8")


def _snapshot_identity(tmp_path: Path) -> dict:
    try:
        st = _snapshot(tmp_path).stat()
    except OSError:
        return {"mtime_ns": 0, "size": 0}
    return {"mtime_ns": st.st_mtime_ns, "size": st.st_size}


def _write_delta(tmp_path: Path, records: list[dict]) -> None:
    lines = [json.dumps({"t": "hdr", "base": _snapshot_identity(tmp_path)})]
    lines.extend(json.dumps(r) for r in records)
    _delta(tmp_path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_checkpoint_advances_persist_across_restart(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.advance_ingestion_checkpoint("/logs/a.jsonl", CHECKPOINT)
    store.advance_ingestion_checkpoint(
        "/logs/a.jsonl", {"kind": "jsonl", "offset": 40, "identity": "1:1"}
    )
    store.advance_ingestion_checkpoint("/logs/b.jsonl", CHECKPOINT, "/ws")
    store._flush_dirty()

    fresh = _store(tmp_path)
    assert fresh.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 40
    assert fresh.get_ingestion_checkpoint("/logs/b.jsonl", "/ws")["offset"] == 10
    fresh.flush()


def test_import_merges_snapshot_delta_and_journal(tmp_path: Path) -> None:
    """Everything the legacy three-file machinery held must land in SQLite:
    the snapshot, the delta records on top of it, and the pending batch a
    crash left in the write-ahead journal."""
    _write_snapshot(tmp_path, {
        "/logs/a.jsonl": {"global": dict(CHECKPOINT), "workspaces": {}},
    })
    _write_delta(tmp_path, [
        {"t": "ckpt", "p": "/logs/a.jsonl", "w": "",
         "c": {"kind": "jsonl", "offset": 40, "identity": "1:1"}},
        {"t": "rek", "k": "global::1:1::event-1"},
    ])
    global_doc = {
        "all_time": {"input": 12, "output": 3, "calls": 1},
        "by_vendor": {}, "by_day": {},
    }
    _journal(tmp_path).write_text(json.dumps({
        "version": 2,
        "writes": [{"path": str(tmp_path / "tokens.json"), "data": global_doc}],
        "delta": [{"t": "ckpt", "p": "/logs/a.jsonl", "w": "",
                   "c": {"kind": "jsonl", "offset": 60, "identity": "1:1"}}],
    }), encoding="utf-8")

    store = _store(tmp_path)
    assert store.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 60
    assert store.snapshot(None)["global"]["all_time"] == global_doc["all_time"]
    # The remembered dedup key keeps the already-counted event out of totals.
    store.record(None, source="cli", vendor="claude", input_tokens=5,
                 dedup_key="event-1", ingestion_file="/logs/a.jsonl",
                 ingestion_checkpoint={"kind": "jsonl", "offset": 60, "identity": "1:1"})
    assert store.snapshot(None)["global"]["all_time"]["calls"] == 1

    # The legacy artifacts are retired.
    assert not _snapshot(tmp_path).exists()
    assert _snapshot(tmp_path).with_name(
        "token-ingestion-state.json.migrated-v1"
    ).exists()
    assert not _delta(tmp_path).exists()
    assert not _journal(tmp_path).exists()
    store.flush()


def test_import_runs_once(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, {
        "/logs/a.jsonl": {"global": dict(CHECKPOINT), "workspaces": {}},
    })
    store = _store(tmp_path)
    assert store.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 10
    store.flush()

    # A stale copy reappearing (restored from backup) must not re-import
    # over the database's newer state.
    _write_snapshot(tmp_path, {
        "/logs/a.jsonl": {
            "global": {"kind": "jsonl", "offset": 99, "identity": "1:1"},
            "workspaces": {},
        },
    })
    fresh = _store(tmp_path)
    assert fresh.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 10
    assert not _snapshot(tmp_path).exists()  # retired out of the way
    fresh.flush()


def test_stale_delta_is_dropped_when_the_snapshot_moved_underneath_it(
    tmp_path: Path,
) -> None:
    """A build that predates the log rewrites the snapshot without touching
    it. Replaying then would drag checkpoints backwards, so the import drops
    the log and the snapshot stands on its own."""
    _write_snapshot(tmp_path, {})
    _write_delta(tmp_path, [
        {"t": "ckpt", "p": "/logs/a.jsonl", "w": "",
         "c": {"kind": "jsonl", "offset": 99, "identity": "1:1"}},
    ])
    # Stand in for the older build: a snapshot rewritten with no idea the
    # log exists (its stat no longer matches the log's header).
    _write_snapshot(tmp_path, {
        "/logs/a.jsonl": {"global": dict(CHECKPOINT), "workspaces": {}},
    }, marker="rewritten")

    store = _store(tmp_path)
    assert store.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 10
    store.flush()


def test_torn_delta_tail_imports_the_records_that_survived(tmp_path: Path) -> None:
    """A crash mid-append leaves a half-written line; everything before the
    tear is still good and must be imported."""
    _write_snapshot(tmp_path, {
        "/logs/a.jsonl": {"global": dict(CHECKPOINT), "workspaces": {}},
    })
    _write_delta(tmp_path, [
        {"t": "ckpt", "p": "/logs/a.jsonl", "w": "",
         "c": {"kind": "jsonl", "offset": 40, "identity": "1:1"}},
    ])
    with open(_delta(tmp_path), "a", encoding="utf-8") as fh:
        fh.write('{"t":"ckpt","p":"/logs/b.js')

    store = _store(tmp_path)
    assert store.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 40
    assert store.get_ingestion_checkpoint("/logs/b.jsonl") == {}
    store.flush()


def test_delta_without_snapshot_still_imports(tmp_path: Path) -> None:
    """Until the first legacy compaction the log was the only place
    checkpoints lived; an upgrade from that state must not lose them."""
    _write_delta(tmp_path, [
        {"t": "ckpt", "p": "/logs/a.jsonl", "w": "", "c": dict(CHECKPOINT)},
        {"t": "ckpt", "p": "/logs/b.jsonl", "w": "/ws", "c": dict(CHECKPOINT)},
    ])
    store = _store(tmp_path)
    assert store.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 10
    assert store.get_ingestion_checkpoint("/logs/b.jsonl", "/ws")["offset"] == 10
    store.flush()


def test_flush_writes_only_the_dirty_rows(tmp_path: Path) -> None:
    """The whole point of the migration: advancing one offset must cost one
    row UPSERT, not a rewrite of the entire ingestion state."""
    store = _store(tmp_path)
    for idx in range(50):
        store.advance_ingestion_checkpoint(
            f"/logs/file-{idx}.jsonl",
            {"kind": "jsonl", "offset": 1, "identity": "1:1"},
        )
    store._flush_dirty()

    before = store._db._conn.total_changes
    store.advance_ingestion_checkpoint(
        "/logs/file-7.jsonl", {"kind": "jsonl", "offset": 2, "identity": "1:1"}
    )
    store._flush_dirty()
    assert store._db._conn.total_changes - before == 1

    # Nothing dirty → nothing written at all.
    before = store._db._conn.total_changes
    store._flush_dirty()
    assert store._db._conn.total_changes == before
    store.flush()


def test_failed_commit_keeps_state_dirty_for_retry(tmp_path: Path, monkeypatch) -> None:
    store = _store(tmp_path)
    store.advance_ingestion_checkpoint("/logs/a.jsonl", CHECKPOINT)

    original = store._db.transaction
    calls = {"n": 0}

    def failing_transaction():
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("simulated commit failure")
        return original()

    monkeypatch.setattr(store._db, "transaction", failing_transaction)
    store._flush_dirty()  # swallowed, state re-marked dirty
    store._flush_dirty()  # retry succeeds

    fresh = _store(tmp_path)
    assert fresh.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 10
    fresh.flush()
    store.flush()


def test_recorded_events_survive_a_restart(tmp_path: Path) -> None:
    """Dedup keys are persisted with the checkpoints — otherwise a restart
    would re-count every event already accounted for."""
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    assert store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        dedup_key="claude::/logs/a.jsonl::msg::req",
        ingestion_file="/logs/a.jsonl",
        ingestion_checkpoint=CHECKPOINT,
    )
    store._flush_dirty()

    fresh = _store(tmp_path)
    # Same event again: the replayed dedup key must keep it out of the totals.
    fresh.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        dedup_key="claude::/logs/a.jsonl::msg::req",
        ingestion_file="/logs/a.jsonl",
        ingestion_checkpoint=CHECKPOINT,
    )
    snap = fresh.snapshot(workspace)
    assert snap["global"]["all_time"]["calls"] == 1
    assert snap["global"]["all_time"]["input"] == 10
    fresh.flush()
    store.flush()


@pytest.mark.parametrize("payload", ["{ not json", ""])
def test_corrupt_or_empty_snapshot_starts_empty(tmp_path: Path, payload: str) -> None:
    _snapshot(tmp_path).write_text(payload, encoding="utf-8")
    store = _store(tmp_path)
    assert store.get_ingestion_checkpoint("/logs/a.jsonl") == {}
    store.flush()
