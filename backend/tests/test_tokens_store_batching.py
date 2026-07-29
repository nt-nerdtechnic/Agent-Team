"""Batched persistence and unified ingestion-checkpoint coverage."""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from agent_team_backend.tokens_store import (
    COLD_FILE_DAYS,
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


def test_backfill_burst_writes_nothing_until_flush(
    tmp_path: Path, monkeypatch
) -> None:
    store = _store(tmp_path)
    workspace = str(tmp_path / "workspace")
    writes: list[Path] = []
    original = store._atomic_write

    def counted(path: Path, data: dict) -> None:
        writes.append(path)
        original(path, data)

    monkeypatch.setattr(store, "_atomic_write", counted)
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

    assert writes == []
    memory = store.snapshot(workspace)
    store.flush()
    assert {path.name for path in writes} == {
        "tokens.json",
        "token-ingestion-state.json",
        "token-persistence-journal.json",
    }
    # One global tokens.json and one workspace tokens.json share the filename.
    assert len(writes) == 4
    assert not (tmp_path / "token-persistence-journal.json").exists()

    fresh = _store(tmp_path)
    disk = fresh.snapshot(workspace)
    assert disk["global"] == memory["global"]
    assert disk["workspace"] == memory["workspace"]
    fresh.flush()


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
    state = json.loads((tmp_path / "token-ingestion-state.json").read_text())
    assert len(state["recent_event_keys"]) == RECENT_EVENT_KEYS_LIMIT
    assert len(state["files"]) == 1


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
    state = json.loads((tmp_path / "token-ingestion-state.json").read_text())
    assert state["legacy_event_keys"] == []
    assert state["files"]["/logs/session.jsonl"]["global"]["offset"] == 99


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
    original = store._atomic_write
    blocked_once = False

    def blocking_write(path: Path, data: dict) -> None:
        nonlocal blocked_once
        if path.name == "token-persistence-journal.json" and not blocked_once:
            blocked_once = True
            entered.set()
            assert release.wait(timeout=5)
        original(path, data)

    monkeypatch.setattr(store, "_atomic_write", blocking_write)
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

    persisted = json.loads(store._workspace_path(workspace).read_text())
    assert persisted["current_run"]["run_id"] == "r1"
    assert persisted["cumulative"]["totals"]["calls"] == 1
    store.flush()


def test_interrupted_workspace_reset_recovers_totals_and_checkpoint_together(
    tmp_path: Path, monkeypatch
) -> None:
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
    store.flush()

    original = store._atomic_write
    failed = False

    def fail_after_journal(path: Path, data: dict) -> None:
        nonlocal failed
        if path == store._workspace_path(workspace) and not failed:
            failed = True
            raise OSError("simulated crash after journal")
        original(path, data)

    monkeypatch.setattr(store, "_atomic_write", fail_after_journal)
    store.reset("workspace", workspace)
    assert (tmp_path / "token-persistence-journal.json").exists()

    # The same live process must recover the pending reset before committing a
    # newer event; otherwise the next journal would overwrite the reset batch.
    store.record(
        workspace,
        source="cli",
        vendor="claude",
        input_tokens=3,
        dedup_key="event-after-reset",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 20, "identity": "1:1"},
    )
    store.flush()
    assert not (tmp_path / "token-persistence-journal.json").exists()

    recovered = _store(tmp_path)
    snap = recovered.snapshot(workspace)
    assert snap["workspace"]["cumulative"]["totals"] == {
        "input": 3, "output": 0, "calls": 1,
    }
    assert recovered.get_ingestion_checkpoint(
        "/logs/session.jsonl", workspace
    )["offset"] == 20
    recovered.flush()


def test_unchanged_checkpoint_does_not_trigger_a_rewrite(
    tmp_path: Path, monkeypatch
) -> None:
    """A rescan that finds no new bytes must not dirty the ingestion state.

    The watcher re-submits a checkpoint for every file it scans, so treating an
    unadvanced offset as "newer" rewrote the whole (multi-megabyte) state file
    every save interval even when nothing had changed.
    """
    store = _store(tmp_path)
    checkpoint = {"kind": "jsonl", "offset": 40, "identity": "1:1"}
    store.advance_ingestion_checkpoint("/logs/session.jsonl", checkpoint)
    store.flush()

    writes: list[Path] = []
    original = store._atomic_write

    def counted(path: Path, data: dict) -> None:
        writes.append(path)
        original(path, data)

    monkeypatch.setattr(store, "_atomic_write", counted)

    # Same offset re-submitted (idle rescan) — nothing to persist.
    store.advance_ingestion_checkpoint("/logs/session.jsonl", dict(checkpoint))
    store.flush()
    assert writes == []

    # A genuine advance still persists.
    store.advance_ingestion_checkpoint(
        "/logs/session.jsonl", {"kind": "jsonl", "offset": 41, "identity": "1:1"}
    )
    store.flush()
    assert [path.name for path in writes] == [
        "token-persistence-journal.json",
        "token-ingestion-state.json",
    ]
    assert store.get_ingestion_checkpoint("/logs/session.jsonl")["offset"] == 41

    # A rotated file (new identity) at a lower offset must still be accepted.
    store.advance_ingestion_checkpoint(
        "/logs/session.jsonl", {"kind": "jsonl", "offset": 5, "identity": "1:2"}
    )
    assert store.get_ingestion_checkpoint("/logs/session.jsonl")["offset"] == 5
    store.flush()


def test_ingestion_state_is_written_without_indentation(tmp_path: Path) -> None:
    """The state file dominates write volume; indentation is ~30% of its bytes."""
    store = _store(tmp_path)
    store.record(
        str(tmp_path / "workspace"),
        source="cli",
        vendor="claude",
        input_tokens=10,
        dedup_key="event",
        ingestion_file="/logs/session.jsonl",
        ingestion_checkpoint={"kind": "jsonl", "offset": 40, "identity": "1:1"},
    )
    store.flush()

    raw = (tmp_path / "token-ingestion-state.json").read_text()
    assert "\n" not in raw
    assert ", " not in raw
    assert json.loads(raw)["files"]["/logs/session.jsonl"]["global"]["offset"] == 40

    # Ledger files stay indented — they are small and get read by humans.
    assert "\n" in (tmp_path / "tokens.json").read_text()
    store.flush()


def _state_with_files(tmp_path: Path, files: dict) -> Path:
    path = tmp_path / "token-ingestion-state.json"
    path.write_text(json.dumps({"version": 2, "files": files}), encoding="utf-8")
    return path


def test_startup_prune_strips_cold_dedup_windows(tmp_path: Path) -> None:
    """`files` has no other eviction path, so the windows accumulate (7.5 MB
    on a real machine) and get rewritten whole on every flush."""
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
        # Unreadable path: left strictly alone, so a transient I/O fault
        # cannot wipe the dedup state and trigger a full re-read.
        "/gone/session.jsonl": {
            "global": {
                "kind": "jsonl", "offset": 5, "identity": "3:3",
                "recent_keys": ["z"],
            },
            "workspaces": {},
        },
    })
    store = _store(tmp_path)
    files = store._ingestion_state["files"]

    assert files["/gone/session.jsonl"]["global"]["recent_keys"] == ["z"]
    # Cold: window stripped in every scope, but position preserved.
    cold_entry = files[str(old)]
    assert "recent_keys" not in cold_entry["global"]
    assert "recent_keys" not in cold_entry["workspaces"]["/ws"]
    assert cold_entry["global"]["offset"] == 10
    assert cold_entry["global"]["identity"] == "1:1"
    # Hot files are untouched — their window is still doing work.
    assert files[str(fresh)]["global"]["recent_keys"] == ["c"]

    # The prune is itself a mutation, so it must reach disk.
    store.flush()
    persisted = json.loads((tmp_path / "token-ingestion-state.json").read_text())
    assert "recent_keys" not in persisted["files"][str(old)]["global"]


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
    assert store._ingestion_state["files"][str(cold_pi)]["global"][
        "recent_keys"
    ] == ["p1", "p2"]
    store.flush()
