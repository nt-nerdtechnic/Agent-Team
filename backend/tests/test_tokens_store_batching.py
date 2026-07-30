"""Batched persistence and unified ingestion-checkpoint coverage."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

from agent_team_backend.db import Database
from agent_team_backend.tokens_store import (
    COLD_FILE_DAYS,
    DEAD_ENTRY_DAYS,
    RECENT_EVENT_KEYS_LIMIT,
    TokensStore,
)


def _store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
        recorded_keys_path=tmp_path / "recorded-event-keys.json",
        legacy_reader_keys_path=tmp_path / "log-readers-seen.json",
    )


def _spy_transactions(store: TokensStore, monkeypatch) -> list[int]:
    """Count how many write transactions the store opens."""
    calls: list[int] = []
    original = store._db.transaction

    def counted():
        calls.append(1)
        return original()

    monkeypatch.setattr(store._db, "transaction", counted)
    return calls


def _kv(tmp_path: Path, key: str):
    db = Database(tmp_path / "navide.db")
    try:
        return db.kv_get(key)
    finally:
        db.close()


def _checkpoint_rows(tmp_path: Path) -> list[tuple[str, str, dict]]:
    db = Database(tmp_path / "navide.db")
    try:
        with db.transaction() as cur:
            rows = cur.execute(
                "SELECT path, scope, data FROM ingestion_checkpoints"
            ).fetchall()
        return [(r["path"], r["scope"], json.loads(r["data"])) for r in rows]
    finally:
        db.close()


def test_backfill_burst_writes_nothing_until_flush(
    tmp_path: Path, monkeypatch
) -> None:
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    transactions = _spy_transactions(store, monkeypatch)
    for idx in range(500):
        assert store.record(
            workspace,
            source="cli",
            vendor="claude",
            input_tokens=idx + 1,
            output_tokens=1,
            dedup_key=f"claude::file::event-{idx}",
            legacy_dedup_key=f"event-{idx}",
            ingestion_file="/logs/session.jsonl",
            ingestion_checkpoint={"kind": "jsonl", "offset": idx + 1, "identity": "1:1"},
        )

    assert transactions == []
    memory = store.snapshot(workspace)
    store.flush()
    assert transactions  # the batch only reaches the database on flush

    fresh = _store(tmp_path)
    disk = fresh.snapshot(workspace)
    assert disk["global"] == memory["global"]
    assert disk["workspace"] == memory["workspace"]
    fresh.flush()


def test_flush_serializes_documents_before_the_write_transaction(
    tmp_path: Path, monkeypatch
) -> None:
    """The kv documents can be multiple MB; dumping them inside the flush
    transaction would stall every store sharing the Database lock, so every
    serialization must happen before the transaction opens."""
    from agent_team_backend import tokens_store as tokens_store_module

    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=5,
        output_tokens=1,
        dedup_key="claude::file::event-1",
        legacy_dedup_key="event-1",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 1, "identity": "1:1"},
    )
    memory = store.snapshot(workspace)

    events: list[str] = []
    original_dump = tokens_store_module._dump_compact

    def spying_dump(data):
        events.append("dump")
        return original_dump(data)

    monkeypatch.setattr(tokens_store_module, "_dump_compact", spying_dump)
    original_txn = store._db.transaction

    def spying_txn():
        events.append("transaction")
        return original_txn()

    monkeypatch.setattr(store._db, "transaction", spying_txn)
    store._flush_dirty()

    assert "dump" in events and "transaction" in events
    txn_at = events.index("transaction")
    assert "dump" not in events[txn_at:]

    # The raw kv writes round-trip exactly like kv_set would have.
    fresh = _store(tmp_path)
    disk = fresh.snapshot(workspace)
    assert disk["global"] == memory["global"]
    assert disk["workspace"] == memory["workspace"]
    fresh.flush()
    store.flush()


def test_dedup_is_effective_before_flush(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    kwargs = dict(
        source="cli",
        vendor="claude",
        input_tokens=10,
        output_tokens=5,
        dedup_key="claude::file::same",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 10, "identity": "1:1"},
    )
    assert store.record(workspace, **kwargs)
    assert store.record(workspace, **kwargs)
    assert store.snapshot(workspace)["global"]["all_time"]["calls"] == 1
    store.flush()


def test_unified_state_is_bounded_by_recent_key_limit(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    for idx in range(RECENT_EVENT_KEYS_LIMIT + 300):
        store.record(
            workspace,
            source="cli",
            vendor="claude",
            input_tokens=1,
            dedup_key=f"key-{idx}",
            ingestion_file="/logs/session.jsonl",
            ingestion_checkpoint={"kind": "jsonl", "offset": idx + 1, "identity": "1:1"},
        )
    store.flush()
    assert len(_kv(tmp_path, "tokens.recent_event_keys")) == RECENT_EVENT_KEYS_LIMIT
    assert len({path for path, _, _ in _checkpoint_rows(tmp_path)}) == 1


def test_legacy_files_migrate_without_double_counting(tmp_path: Path) -> None:
    composite = "claude::/logs/session.jsonl::msg::req"
    (tmp_path / "recorded-event-keys.json").write_text(json.dumps([composite]))
    (tmp_path / "log-readers-seen.json").write_text(
        json.dumps({"/logs/session.jsonl": ["msg::req"]})
    )
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    assert store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        output_tokens=5,
        dedup_key=composite,
        legacy_dedup_key="msg::req",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 99, "identity": "1:1"},
    )
    assert store.snapshot(workspace)["global"]["all_time"]["calls"] == 0
    store.flush()

    assert not (tmp_path / "recorded-event-keys.json").exists()
    assert not (tmp_path / "log-readers-seen.json").exists()
    assert _kv(tmp_path, "tokens.legacy_event_keys")["keys"] == []
    fresh = _store(tmp_path)
    assert fresh.get_ingestion_checkpoint("/logs/session.jsonl")["offset"] == 99
    fresh.flush()


def test_legacy_watcher_cache_does_not_suppress_external_event(tmp_path: Path) -> None:
    (tmp_path / "log-readers-seen.json").write_text(
        json.dumps({"/logs/session.jsonl": ["msg::req"]})
    )
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        dedup_key="claude::/logs/session.jsonl::msg::req",
        legacy_dedup_key="msg::req",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 99, "identity": "1:1"},
    )
    assert store.snapshot(workspace)["global"]["all_time"]["calls"] == 1
    store.flush()


def test_legacy_global_key_does_not_block_workspace_replay(tmp_path: Path) -> None:
    composite = "claude::/logs/session.jsonl::msg::req"
    (tmp_path / "recorded-event-keys.json").write_text(json.dumps([composite]))
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        dedup_key=composite,
        legacy_dedup_key="msg::req",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 99, "identity": "1:1"},
        replay_workspace=workspace,
    )
    snap = store.snapshot(workspace)
    assert snap["global"]["all_time"]["calls"] == 0
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 1
    store.flush()


def test_workspace_replay_does_not_increment_global(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    cursor = {"kind": "jsonl", "offset": 10, "identity": "1:1"}
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        output_tokens=5,
        dedup_key="event",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint=cursor,
    )
    assert store.snapshot(workspace)["global"]["all_time"]["calls"] == 1

    store.reset("workspace", workspace)
    assert store.get_ingestion_checkpoint("/logs/session.jsonl", workspace) == {}
    assert store.get_ingestion_checkpoint("/logs/session.jsonl")["offset"] == 10
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        output_tokens=5,
        dedup_key="event",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint=cursor,
        replay_workspace=workspace,
    )
    snap = store.snapshot(workspace)
    assert snap["global"]["all_time"]["calls"] == 1
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 1
    store.flush()


def test_first_workspace_backfill_also_fills_missing_global(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    cursor = {"kind": "jsonl", "offset": 10, "identity": "1:1"}
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        output_tokens=5,
        dedup_key="event",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint=cursor,
        replay_workspace=workspace,
    )
    snap = store.snapshot(workspace)
    assert snap["global"]["all_time"]["calls"] == 1
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 1
    store.flush()


def test_interrupted_batch_journal_recovers_before_load(tmp_path: Path) -> None:
    global_doc = {
        "all_time": {"input": 12, "output": 3, "calls": 1},
        "by_vendor": {},
        "by_day": {},
    }
    journal = {
        "version": 1,
        "writes": [{"path": str(tmp_path / "tokens.json"), "data": global_doc}],
    }
    (tmp_path / "token-persistence-journal.json").write_text(json.dumps(journal))
    store = _store(tmp_path)
    assert store.snapshot(None)["global"]["all_time"] == global_doc["all_time"]
    assert not (tmp_path / "token-persistence-journal.json").exists()
    store.flush()


def test_lifecycle_save_cannot_be_overwritten_by_older_batch(
    tmp_path: Path, monkeypatch
) -> None:
    """start_run must serialize behind an in-flight background commit so its
    synchronous save is never interleaved with (or shadowed by) older data."""
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        dedup_key="event",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 10, "identity": "1:1"},
    )

    entered = threading.Event()
    release = threading.Event()
    original = store._db.transaction
    blocked_once = False

    def blocking_transaction():
        nonlocal blocked_once
        if not blocked_once:
            blocked_once = True
            entered.set()
            assert release.wait(timeout=5)
        return original()

    monkeypatch.setattr(store._db, "transaction", blocking_transaction)
    background = threading.Thread(target=store._flush_dirty)
    background.start()
    assert entered.wait(timeout=5)

    lifecycle = threading.Thread(
        target=lambda: store.start_run(
            workspace, run_id="r1", task="task", run_dir="runs/r1"
        )
    )
    lifecycle.start()
    lifecycle.join(timeout=0.05)
    assert lifecycle.is_alive(), "start_run must wait for the older batch commit"

    release.set()
    background.join(timeout=5)
    lifecycle.join(timeout=5)
    assert not background.is_alive()
    assert not lifecycle.is_alive()

    fresh = _store(tmp_path)
    snap = fresh.snapshot(workspace)
    assert snap["workspace"]["current_run"]["run_id"] == "r1"
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 1
    fresh.flush()
    store.flush()


def test_interrupted_workspace_reset_recovers_totals_and_checkpoint_together(
    tmp_path: Path, monkeypatch
) -> None:
    """A reset whose commit fails must stay pending — totals and checkpoint
    deletion land together on the next successful commit, not piecemeal."""
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=10,
        dedup_key="event",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 10, "identity": "1:1"},
    )
    store._flush_dirty()

    original = store._db.transaction
    failed = False

    def fail_once():
        nonlocal failed
        if not failed:
            failed = True
            raise sqlite3.OperationalError("simulated crash during commit")
        return original()

    monkeypatch.setattr(store._db, "transaction", fail_once)
    store.reset("workspace", workspace)  # its synchronous commit fails

    # The next event and flush must carry the pending reset with them.
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=3,
        dedup_key="event-after-reset",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 20, "identity": "1:1"},
    )
    store._flush_dirty()

    recovered = _store(tmp_path)
    snap = recovered.snapshot(workspace)
    assert snap["workspace"]["cumulative"]["totals"] == {
        "input": 3, "output": 0, "calls": 1,
    }
    assert recovered.get_ingestion_checkpoint(
        "/logs/session.jsonl", workspace
    )["offset"] == 20
    recovered.flush()
    store.flush()


def test_unchanged_checkpoint_does_not_trigger_a_rewrite(
    tmp_path: Path, monkeypatch
) -> None:
    """A rescan that finds no new bytes must not dirty anything.

    The watcher re-submits a checkpoint for every file it scans, so treating
    an unadvanced offset as "newer" would rewrite its row every save interval
    even when nothing changed.
    """
    store = _store(tmp_path)
    checkpoint = {"kind": "jsonl", "offset": 40, "identity": "1:1"}
    store.advance_ingestion_checkpoint("/logs/session.jsonl", checkpoint)
    store._flush_dirty()

    transactions = _spy_transactions(store, monkeypatch)

    # Same offset re-submitted (idle rescan) — nothing to persist.
    store.advance_ingestion_checkpoint("/logs/session.jsonl", dict(checkpoint))
    store._flush_dirty()
    assert transactions == []

    # A genuine advance still persists.
    store.advance_ingestion_checkpoint(
        "/logs/session.jsonl", {"kind": "jsonl", "offset": 41, "identity": "1:1"}
    )
    store._flush_dirty()
    assert len(transactions) == 1
    assert store.get_ingestion_checkpoint("/logs/session.jsonl")["offset"] == 41

    # A rotated file (new identity) at a lower offset must still be accepted.
    store.advance_ingestion_checkpoint(
        "/logs/session.jsonl", {"kind": "jsonl", "offset": 5, "identity": "1:2"}
    )
    assert store.get_ingestion_checkpoint("/logs/session.jsonl")["offset"] == 5
    store.flush()


def _state_with_files(tmp_path: Path, files: dict) -> Path:
    path = tmp_path / "token-ingestion-state.json"
    path.write_text(json.dumps({"version": 2, "files": files}), encoding="utf-8")
    return path


def test_startup_prune_strips_cold_dedup_windows(tmp_path: Path) -> None:
    """Checkpoint dedup windows have no other eviction path, so they used to
    accumulate (7.5 MB on a real machine)."""
    old = tmp_path / "cold.jsonl"
    old.write_text("{}\n", encoding="utf-8")
    cold_mtime = time.time() - (COLD_FILE_DAYS + 1) * 86400
    os.utime(old, (cold_mtime, cold_mtime))
    fresh = tmp_path / "hot.jsonl"
    fresh.write_text("{}\n", encoding="utf-8")

    _state_with_files(tmp_path, {
        str(old): {
            "global": {
                "kind": "jsonl", "offset": 10, "identity": "1:1",
                "recent_keys": ["a", "b"],
            },
            "workspaces": {
                "/ws": {
                    "kind": "jsonl", "offset": 10, "identity": "1:1",
                    "recent_keys": ["a"],
                }
            },
        },
        str(fresh): {
            "global": {
                "kind": "jsonl", "offset": 20, "identity": "2:2",
                "recent_keys": ["c"],
            },
            "workspaces": {},
        },
        # Unreadable path: its window is left strictly alone, so a transient
        # I/O fault cannot wipe the dedup state and trigger a full re-read.
        "/gone/session.jsonl": {
            "global": {
                "kind": "jsonl", "offset": 5, "identity": "3:3",
                "recent_keys": ["z"],
            },
            "workspaces": {},
        },
    })
    store = _store(tmp_path)
    files = store._files

    assert files["/gone/session.jsonl"]["global"]["recent_keys"] == ["z"]
    # Cold: window stripped in every scope, but position preserved.
    cold_entry = files[str(old)]
    assert "recent_keys" not in cold_entry["global"]
    assert "recent_keys" not in cold_entry["workspaces"]["/ws"]
    assert cold_entry["global"]["offset"] == 10
    assert cold_entry["global"]["identity"] == "1:1"
    # Hot files are untouched — their window is still doing work.
    assert files[str(fresh)]["global"]["recent_keys"] == ["c"]

    # The prune is itself a mutation, so it must reach the database.
    store.flush()
    persisted = dict(
        ((path, scope), data) for path, scope, data in _checkpoint_rows(tmp_path)
    )
    assert "recent_keys" not in persisted[(str(old), "")]
    assert "recent_keys" not in persisted[(str(old), "/ws")]
    assert persisted[(str(fresh), "")]["recent_keys"] == ["c"]


def test_startup_prune_keeps_windows_readers_carry_across_rotation(
    tmp_path: Path,
) -> None:
    """pi keeps its window across an in-place rewrite (pi.py:280-288) — that
    window is the only thing stopping a re-read from double counting, so a
    cold pi log must keep it. Its checkpoints are marked by `session_id`."""
    cold_pi = tmp_path / "pi.jsonl"
    cold_pi.write_text("{}\n", encoding="utf-8")
    stamp = time.time() - (COLD_FILE_DAYS + 30) * 86400
    os.utime(cold_pi, (stamp, stamp))

    _state_with_files(tmp_path, {
        str(cold_pi): {
            "global": {
                "kind": "jsonl", "offset": 30, "identity": "4:4",
                "session_id": "sess-1", "recent_keys": ["p1", "p2"],
            },
            "workspaces": {},
        },
    })
    store = _store(tmp_path)
    assert store._files[str(cold_pi)]["global"]["recent_keys"] == ["p1", "p2"]
    store.flush()


def _go_cold(path: Path) -> None:
    stamp = time.time() - (COLD_FILE_DAYS + 1) * 86400
    os.utime(path, (stamp, stamp))


def test_periodic_prune_strips_windows_that_went_cold_after_startup(
    tmp_path: Path,
) -> None:
    """Pruning only at load leaves a long-running session rewriting the window
    of every log that went quiet since startup."""
    log = tmp_path / "later-cold.jsonl"
    log.write_text("{}\n", encoding="utf-8")
    _state_with_files(tmp_path, {
        str(log): {
            "global": {
                "kind": "jsonl", "offset": 10, "identity": "1:1",
                "recent_keys": ["a", "b"],
            },
            "workspaces": {
                "/ws": {
                    "kind": "jsonl", "offset": 10, "identity": "1:1",
                    "recent_keys": ["a"],
                }
            },
        },
    })
    store = _store(tmp_path)
    # Hot at startup, so the load-time prune leaves it alone.
    assert store._files[str(log)]["global"]["recent_keys"] == ["a", "b"]

    _go_cold(log)
    store._dirty_checkpoints.clear()
    store._prune_cold_windows()

    entry = store._files[str(log)]
    assert "recent_keys" not in entry["global"]
    assert "recent_keys" not in entry["workspaces"]["/ws"]
    assert entry["global"]["offset"] == 10
    assert entry["global"]["identity"] == "1:1"
    # The prune is a mutation, so it has to reach the database on flush.
    assert {(str(log), ""), (str(log), "/ws")} <= store._dirty_checkpoints
    store.flush()
    persisted = dict(
        ((path, scope), data) for path, scope, data in _checkpoint_rows(tmp_path)
    )
    assert "recent_keys" not in persisted[(str(log), "")]


def test_periodic_prune_keeps_windows_readers_carry_across_rotation(
    tmp_path: Path,
) -> None:
    """The `session_id` exemption (pi.py) must hold on the periodic path too."""
    pi_log = tmp_path / "pi.jsonl"
    pi_log.write_text("{}\n", encoding="utf-8")
    _state_with_files(tmp_path, {
        str(pi_log): {
            "global": {
                "kind": "jsonl", "offset": 30, "identity": "4:4",
                "session_id": "sess-1", "recent_keys": ["p1", "p2"],
            },
            "workspaces": {},
        },
    })
    store = _store(tmp_path)
    _go_cold(pi_log)
    store._dirty_checkpoints.clear()
    store._prune_cold_windows()

    assert store._files[str(pi_log)]["global"]["recent_keys"] == ["p1", "p2"]
    assert store._dirty_checkpoints == set()
    store.flush()


def test_periodic_prune_leaves_hot_files_alone(tmp_path: Path) -> None:
    """A live log's window is still doing dedup work."""
    hot = tmp_path / "hot.jsonl"
    hot.write_text("{}\n", encoding="utf-8")
    _state_with_files(tmp_path, {
        str(hot): {
            "global": {
                "kind": "jsonl", "offset": 20, "identity": "2:2",
                "recent_keys": ["c"],
            },
            "workspaces": {},
        },
    })
    store = _store(tmp_path)
    store._dirty_checkpoints.clear()
    store._prune_cold_windows()

    assert store._files[str(hot)]["global"]["recent_keys"] == ["c"]
    assert store._dirty_checkpoints == set()
    store.flush()


def test_prune_deletes_rows_dead_for_thirty_days(tmp_path: Path) -> None:
    """A checkpoint whose log has been unreadable for DEAD_ENTRY_DAYS is
    reclaimed — this is the eviction path the JSON state never had."""
    store = _store(tmp_path)
    gone = "/gone/session.jsonl"
    store.advance_ingestion_checkpoint(
        gone, {"kind": "jsonl", "offset": 5, "identity": "3:3"}
    )
    store.advance_ingestion_checkpoint(
        gone, {"kind": "jsonl", "offset": 6, "identity": "3:3"}, "/ws"
    )
    store._flush_dirty()
    assert len(_checkpoint_rows(tmp_path)) == 2

    # Stat has been failing, but not for long enough → conservative, kept.
    store._prune_cold_windows()
    assert gone in store._files

    # Now the row has been dead past the cutoff → reclaimed everywhere.
    store._last_seen[gone] = int(time.time()) - (DEAD_ENTRY_DAYS + 1) * 86400
    store._prune_cold_windows()
    assert gone not in store._files
    store.flush()
    assert _checkpoint_rows(tmp_path) == []
    assert store.get_ingestion_checkpoint(gone) == {}
