"""Append-only ingestion delta: commit cost, replay, and compaction."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.tokens_store import DELTA_COMPACT_LINES, TokensStore

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


def test_ordinary_commit_appends_instead_of_rewriting_the_snapshot(
    tmp_path: Path,
) -> None:
    """The whole point: recording an advanced offset must not cost a rewrite
    of a state file that is megabytes on a real machine."""
    store = _store(tmp_path)
    store.advance_ingestion_checkpoint("/logs/a.jsonl", CHECKPOINT)
    store._flush_dirty()

    assert not _snapshot(tmp_path).exists()
    records = [json.loads(line) for line in _delta(tmp_path).read_text().splitlines()]
    assert records[0]["t"] == "hdr"
    assert records[1] == {"t": "ckpt", "p": "/logs/a.jsonl", "w": "", "c": CHECKPOINT}
    store.flush()


def test_restart_replays_the_delta_over_the_snapshot(tmp_path: Path) -> None:
    """Until the first compaction the log is the only place checkpoints live."""
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


def test_flush_compacts_so_shutdown_leaves_a_whole_snapshot(tmp_path: Path) -> None:
    """A cleanly stopped app must leave state a downgraded build can read."""
    store = _store(tmp_path)
    store.advance_ingestion_checkpoint("/logs/a.jsonl", CHECKPOINT)
    store._flush_dirty()
    assert _delta(tmp_path).exists()

    store.flush()
    assert not _delta(tmp_path).exists()
    state = json.loads(_snapshot(tmp_path).read_text())
    assert state["files"]["/logs/a.jsonl"]["global"]["offset"] == 10


def test_delta_is_discarded_when_the_snapshot_moved_underneath_it(
    tmp_path: Path,
) -> None:
    """A build that predates the log rewrites the snapshot without touching it.
    Replaying then would drag checkpoints backwards, so the log is dropped."""
    store = _store(tmp_path)
    store.advance_ingestion_checkpoint(
        "/logs/a.jsonl", {"kind": "jsonl", "offset": 99, "identity": "1:1"}
    )
    store._flush_dirty()
    assert _delta(tmp_path).exists()

    # Stand in for the older build: a snapshot written with no idea the log exists.
    _snapshot(tmp_path).write_text(
        json.dumps({
            "version": 2,
            "files": {"/logs/a.jsonl": {"global": CHECKPOINT, "workspaces": {}}},
            "legacy_event_keys": [],
            "recent_event_keys": [],
        }),
        encoding="utf-8",
    )

    fresh = _store(tmp_path)
    # The snapshot wins; the stale log does not resurrect offset 99.
    assert fresh.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 10
    fresh.flush()


def test_replaying_the_same_records_twice_is_idempotent(tmp_path: Path) -> None:
    """Journal recovery can append a batch that already landed."""
    store = _store(tmp_path)
    store.advance_ingestion_checkpoint("/logs/a.jsonl", CHECKPOINT)
    store._flush_dirty()

    duplicated = _delta(tmp_path).read_text().splitlines()
    body = [line for line in duplicated[1:] if line.strip()]
    _delta(tmp_path).write_text("\n".join(duplicated + body) + "\n", encoding="utf-8")

    fresh = _store(tmp_path)
    assert fresh.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 10
    fresh.flush()


def test_a_torn_tail_replays_what_survived_and_forces_a_rebuild(
    tmp_path: Path,
) -> None:
    """A crash mid-append leaves a half-written line. Appending past it would
    strand later records behind the tear, so the next commit compacts."""
    store = _store(tmp_path)
    store.advance_ingestion_checkpoint("/logs/a.jsonl", CHECKPOINT)
    store._flush_dirty()
    with open(_delta(tmp_path), "a", encoding="utf-8") as fh:
        fh.write('{"t":"ckpt","p":"/logs/b.js')

    fresh = _store(tmp_path)
    assert fresh.get_ingestion_checkpoint("/logs/a.jsonl")["offset"] == 10
    assert fresh.get_ingestion_checkpoint("/logs/b.jsonl") == {}
    assert fresh._force_compaction

    fresh.advance_ingestion_checkpoint("/logs/c.jsonl", CHECKPOINT)
    fresh._flush_dirty()
    assert _snapshot(tmp_path).exists()
    assert not _delta(tmp_path).exists()
    fresh.flush()


def test_the_log_is_compacted_once_it_outgrows_its_bound(tmp_path: Path) -> None:
    store = _store(tmp_path)
    for offset in range(1, DELTA_COMPACT_LINES + 2):
        store.advance_ingestion_checkpoint(
            "/logs/a.jsonl", {"kind": "jsonl", "offset": offset, "identity": "1:1"}
        )
    store._flush_dirty()

    assert not _delta(tmp_path).exists()
    state = json.loads(_snapshot(tmp_path).read_text())
    assert state["files"]["/logs/a.jsonl"]["global"]["offset"] == DELTA_COMPACT_LINES + 1
    store.flush()


def test_recorded_events_survive_a_restart_without_a_snapshot(tmp_path: Path) -> None:
    """Dedup keys live in the same state, so they ride the log too — otherwise a
    restart would re-count every event the log had already accounted for."""
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
    assert not _snapshot(tmp_path).exists()

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
