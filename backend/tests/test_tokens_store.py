"""Token aggregator + SQLite persistence tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.db import Database
from agent_team_backend.tokens_store import LEGACY_EVENT_KEYS_LIMIT, TokensStore


def _kv(tmp_path: Path, key: str):
    """Read one kv value straight from the store's database file."""
    db = Database(tmp_path / "navide.db")
    try:
        return db.kv_get(key)
    finally:
        db.close()


@pytest.fixture
def store(tmp_path: Path) -> TokensStore:
    """Fresh store with a temp global file (no contamination from real env)."""
    return TokensStore(
        global_path=tmp_path / "global-tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
    )


@pytest.fixture
def workspace(tmp_path: Path) -> str:
    ws = tmp_path / "ws"
    ws.mkdir()
    return str(ws)


def test_no_recording_when_both_token_counts_zero(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(
        workspace, source="cli", vendor="claude",
        input_tokens=0, output_tokens=0,
    )
    snap = store.snapshot(workspace)
    assert snap["workspace"]["current_run"]["totals"]["calls"] == 0


def test_record_updates_current_run_cumulative_and_global(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(
        workspace, source="analyzer", vendor="analyzer",
        stage_id="01", pane_id="pane-a",
        input_tokens=100, output_tokens=200,
    )
    snap = store.snapshot(workspace)

    run = snap["workspace"]["current_run"]
    assert run["totals"] == {"input": 100, "output": 200, "calls": 1}
    assert run["by_vendor"]["analyzer"] == {"input": 100, "output": 200, "calls": 1}
    assert run["by_stage"]["01"] == {"input": 100, "output": 200, "calls": 1}
    assert run["by_pane"]["pane-a"] == {"input": 100, "output": 200, "calls": 1}

    cum = snap["workspace"]["cumulative"]
    assert cum["totals"] == {"input": 100, "output": 200, "calls": 1}

    assert snap["global"]["all_time"] == {"input": 100, "output": 200, "calls": 1}
    assert snap["global"]["by_vendor"]["analyzer"] == {"input": 100, "output": 200, "calls": 1}


def test_two_calls_sum_correctly(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude", stage_id="02",
                 input_tokens=10, output_tokens=20)
    store.record(workspace, source="cli", vendor="claude", stage_id="02",
                 input_tokens=5, output_tokens=15)
    snap = store.snapshot(workspace)
    assert snap["workspace"]["current_run"]["by_vendor"]["claude"] == {
        "input": 15, "output": 35, "calls": 2,
    }


def test_starting_new_run_archives_previous(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t1", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=1, output_tokens=1)
    store.start_run(workspace, run_id="r2", task="t2", run_dir="runs/r2")
    snap = store.snapshot(workspace)
    assert snap["workspace"]["current_run"]["run_id"] == "r2"
    assert snap["workspace"]["current_run"]["totals"]["calls"] == 0
    # Previous run archived with its 1 call
    assert any(r["run_id"] == "r1" and r["totals"]["calls"] == 1
               for r in snap["workspace"]["runs"])


def test_persistence_roundtrip(tmp_path: Path) -> None:
    global_path = tmp_path / "global.json"
    workspace_base_dir = tmp_path / "workspaces"
    workspace = tmp_path / "ws"
    workspace.mkdir()

    s1 = TokensStore(global_path=global_path, workspace_base_dir=workspace_base_dir)
    s1.start_run(str(workspace), run_id="r1", task="t", run_dir="runs/r1")
    s1.record(str(workspace), source="analyzer", vendor="analyzer",
              input_tokens=10, output_tokens=20)
    s1.flush()

    # Fresh store reads back the same values
    s2 = TokensStore(global_path=global_path, workspace_base_dir=workspace_base_dir)
    snap = s2.snapshot(str(workspace))
    assert snap["workspace"]["cumulative"]["totals"]["input"] == 10
    assert snap["global"]["all_time"]["output"] == 20


def test_flush_leaves_no_json_artifacts(tmp_path: Path) -> None:
    """Persistence is the database alone — no legacy JSON files reappear."""
    global_path = tmp_path / "global.json"
    workspace_base_dir = tmp_path / "workspaces"
    workspace = tmp_path / "ws"
    workspace.mkdir()
    s = TokensStore(global_path=global_path, workspace_base_dir=workspace_base_dir)
    s.start_run(str(workspace), run_id="r1", task="t", run_dir="runs/r1")
    s.record(str(workspace), source="cli", vendor="codex",
             input_tokens=5, output_tokens=5)
    s.flush()

    assert not global_path.exists()
    assert not workspace_base_dir.exists()
    # The data still round-trips through the database.
    s2 = TokensStore(global_path=global_path, workspace_base_dir=workspace_base_dir)
    assert s2.snapshot(str(workspace))["workspace"]["cumulative"]["totals"]["calls"] == 1


def test_reset_run_clears_current_but_keeps_cumulative(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=100, output_tokens=200)
    snap = store.reset("run", workspace_path=workspace)
    assert snap["workspace"]["current_run"]["totals"]["calls"] == 0
    # Cumulative + global preserved
    assert snap["workspace"]["cumulative"]["totals"]["input"] == 100
    assert snap["global"]["all_time"]["input"] == 100


def test_reset_workspace_clears_only_workspace(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=10, output_tokens=20)
    snap = store.reset("workspace", workspace_path=workspace)
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 0
    # Global preserved
    assert snap["global"]["all_time"]["calls"] == 1


def test_reset_global_clears_global(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=10, output_tokens=20)
    snap = store.reset("global", workspace_path=workspace)
    assert snap["global"]["all_time"]["calls"] == 0
    # Workspace data preserved
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 1


def test_reset_unknown_scope_raises(store: TokensStore) -> None:
    with pytest.raises(ValueError):
        store.reset("bogus", workspace_path=None)


def test_record_with_no_workspace_only_updates_global(store: TokensStore, tmp_path: Path) -> None:
    # No workspace_path → workspace state is untouched, global still gets it
    store.record(None, source="analyzer", vendor="analyzer",
                 input_tokens=7, output_tokens=11)
    snap = store.snapshot(None)
    assert snap["global"]["all_time"]["input"] == 7
    # workspace doc should be a blank shell
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 0


def test_corrupt_json_recovers_gracefully(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / ".agent-team").mkdir()
    (workspace / ".agent-team" / "tokens.json").write_text("{not valid json", encoding="utf-8")

    s = TokensStore(global_path=tmp_path / "g.json", workspace_base_dir=tmp_path / "workspaces")
    snap = s.snapshot(str(workspace))
    # Should fall back to empty doc, not raise
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 0


def test_record_negative_tokens_clamped_to_zero(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    # A bad parser might pass negatives — we silently treat as zero.
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=-10, output_tokens=5)
    snap = store.snapshot(workspace)
    # input clamped to 0, output 5 → still recorded (calls=1)
    assert snap["workspace"]["current_run"]["totals"] == {
        "input": 0, "output": 5, "calls": 1,
    }


# ───────────────────────── Legacy event key bounds ─────────────────────────


def _write_ingestion_state(
    path: Path, keys: list[str], expires_at: str | None = None
) -> None:
    doc: dict = {
        "version": 2,
        "files": {},
        "legacy_event_keys": keys,
        "recent_event_keys": [],
    }
    if expires_at is not None:
        doc["legacy_event_keys_expires_at"] = expires_at
    path.write_text(json.dumps(doc), encoding="utf-8")


def _legacy_store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "global-tokens.json",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
        workspace_base_dir=tmp_path / "workspaces",
    )


def test_legacy_event_keys_capped_on_load(tmp_path: Path) -> None:
    state_path = tmp_path / "token-ingestion-state.json"
    _write_ingestion_state(
        state_path, [f"k{i:06d}" for i in range(LEGACY_EVENT_KEYS_LIMIT + 100)]
    )
    store = _legacy_store(tmp_path)
    store.flush()
    saved = _kv(tmp_path, "tokens.legacy_event_keys")
    assert len(saved["keys"]) == LEGACY_EVENT_KEYS_LIMIT
    # Expiry gets stamped the first time keys are seen without one.
    assert isinstance(saved["expires_at"], str)
    assert saved["expires_at"] > "2026"


def test_legacy_event_keys_cleared_after_expiry(tmp_path: Path) -> None:
    state_path = tmp_path / "token-ingestion-state.json"
    _write_ingestion_state(
        state_path, ["a", "b"], expires_at="2000-01-01T00:00:00Z"
    )
    store = _legacy_store(tmp_path)
    store.flush()
    assert _kv(tmp_path, "tokens.legacy_event_keys")["keys"] == []


def test_legacy_event_keys_expiry_stamped_once(tmp_path: Path) -> None:
    state_path = tmp_path / "token-ingestion-state.json"
    _write_ingestion_state(state_path, ["a"])
    store = _legacy_store(tmp_path)
    store.flush()
    first = _kv(tmp_path, "tokens.legacy_event_keys")
    assert first["keys"] == ["a"]  # under cap, not expired → kept
    store2 = _legacy_store(tmp_path)
    store2.flush()
    second = _kv(tmp_path, "tokens.legacy_event_keys")
    assert second["expires_at"] == first["expires_at"]


def test_legacy_event_key_still_drains_via_record(tmp_path: Path) -> None:
    state_path = tmp_path / "token-ingestion-state.json"
    _write_ingestion_state(state_path, ["dup1"])
    store = _legacy_store(tmp_path)
    # First event matching a legacy key is suppressed (already counted
    # pre-migration) and consumes the key.
    assert store.record(None, source="cli", vendor="claude",
                        input_tokens=5, output_tokens=5, dedup_key="dup1")
    assert store.snapshot(None)["global"]["all_time"]["calls"] == 0
    # Key consumed → the same event replaying again counts normally.
    assert store.record(None, source="cli", vendor="claude",
                        input_tokens=5, output_tokens=5, dedup_key="dup1")
    assert store.snapshot(None)["global"]["all_time"]["calls"] == 1
    store.flush()
    assert _kv(tmp_path, "tokens.legacy_event_keys")["keys"] == []


# ───────────────── live per-session tally (no persistence) ─────────────────
#
# The live tally is a cache of what a vendor's session log actually holds,
# published by set_live_total() after an off-loop scan (app._scan_live_session).
# record() must not touch it — an accumulator drifts the moment an event is
# missed or deduped, which is the whole reason this dimension was moved off it.


def test_record_no_longer_feeds_the_live_tally(store: TokensStore, workspace: str) -> None:
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20,
    )
    snap = store.snapshot(workspace)
    assert snap["workspace"]["live_by_session"] == {}
    # ... while the durable tallies are recorded exactly as before.
    assert snap["workspace"]["cumulative"]["totals"] == {"input": 10, "output": 20, "calls": 1}
    assert snap["global"]["all_time"] == {"input": 10, "output": 20, "calls": 1}


def test_record_still_fills_the_run_by_pane_bucket(store: TokensStore, workspace: str) -> None:
    """by_pane belongs to the run ledger and keeps its pane dimension."""
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20,
    )
    ws = store.snapshot(workspace)["workspace"]
    assert ws["current_run"]["by_pane"]["pane-a"] == {"input": 10, "output": 20, "calls": 1}
    assert ws["live_by_session"] == {}


def test_set_live_total_overwrites_rather_than_accumulates(
    store: TokensStore, workspace: str
) -> None:
    assert store.set_live_total(workspace, "sess-1", {"input": 900, "output": 90, "calls": 9})
    assert store.set_live_total(workspace, "sess-1", {"input": 950, "output": 95, "calls": 10})
    live = store.snapshot(workspace)["workspace"]["live_by_session"]
    assert live == {"sess-1": {"input": 950, "output": 95, "calls": 10}}


def test_set_live_total_reports_whether_the_value_changed(
    store: TokensStore, workspace: str
) -> None:
    """The caller broadcasts only on a real change."""
    total = {"input": 900, "output": 90, "calls": 9}
    assert store.set_live_total(workspace, "sess-1", total)
    assert not store.set_live_total(workspace, "sess-1", dict(total))
    assert not store.set_live_total("", "sess-1", total)
    assert not store.set_live_total(workspace, "", total)


def test_one_session_is_one_bucket_across_pane_ids(
    store: TokensStore, workspace: str
) -> None:
    """Regression: a pane that is restored/respawned comes back with a fresh
    ephemeral id. Keying the bucket on the pane split one CLI session into
    three, and the panel reported "3 pane(s)" for a single open pane."""
    for _pane in ("pane-a", "pane-b", "pane-c"):
        store.set_live_total(
            workspace,
            store.live_session_key("sess-1"),
            {"input": 43021704, "output": 33024, "calls": 46},
        )
    live = store.snapshot(workspace)["workspace"]["live_by_session"]
    assert live == {"sess-1": {"input": 43021704, "output": 33024, "calls": 46}}


def test_live_session_key_falls_back_to_the_session_file(store: TokensStore) -> None:
    assert store.live_session_key("sess-1", "/logs/a.jsonl") == "sess-1"
    assert store.live_session_key("", "/logs/a.jsonl") == "/logs/a.jsonl"
    assert store.live_session_key("", "") == ""


def test_drop_live_session_removes_only_that_session(
    store: TokensStore, workspace: str
) -> None:
    store.set_live_total(workspace, "sess-1", {"input": 10, "output": 1, "calls": 1})
    store.set_live_total(workspace, "sess-2", {"input": 20, "output": 2, "calls": 1})
    store.drop_live_session(workspace, "sess-1")
    assert set(store.snapshot(workspace)["workspace"]["live_by_session"]) == {"sess-2"}


def test_set_live_total_never_touches_cumulative_global_or_checkpoints(
    store: TokensStore, workspace: str, tmp_path: Path
) -> None:
    """The scanned events are already in the durable tallies."""
    session_file = str(tmp_path / "sess-1.jsonl")
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20, dedup_key="e1",
        ingestion_file=session_file,
        ingestion_checkpoint={"kind": "jsonl", "offset": 100, "identity": "1:2"},
    )
    before = store.snapshot(workspace)
    ckpt_before = store.get_ingestion_checkpoint(session_file, workspace)

    store.set_live_total(workspace, "sess-1", {"input": 5000, "output": 400, "calls": 9})
    after = store.snapshot(workspace)

    assert after["workspace"]["cumulative"] == before["workspace"]["cumulative"]
    assert after["global"] == before["global"]
    assert store.get_ingestion_checkpoint(session_file, workspace) == ckpt_before


def test_reset_run_without_a_run_clears_the_live_tally(store: TokensStore, workspace: str) -> None:
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20,
    )
    store.set_live_total(workspace, "sess-1", {"input": 10, "output": 20, "calls": 1})
    snap = store.reset("run", workspace_path=workspace)
    assert snap["workspace"]["live_by_session"] == {}
    # Cumulative + global untouched, same as a run reset.
    assert snap["workspace"]["cumulative"]["totals"]["input"] == 10
    assert snap["global"]["all_time"]["input"] == 10


def test_reset_run_with_a_run_keeps_the_live_tally(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.set_live_total(workspace, "sess-1", {"input": 10, "output": 20, "calls": 1})
    snap = store.reset("run", workspace_path=workspace)
    assert snap["workspace"]["current_run"]["totals"]["calls"] == 0
    assert snap["workspace"]["live_by_session"]["sess-1"]["calls"] == 1


def test_live_tally_is_not_persisted(tmp_path: Path) -> None:
    """A restart starts from an empty cache; the first scan re-derives it."""
    kwargs = {
        "global_path": tmp_path / "global-tokens.json",
        "workspace_base_dir": tmp_path / "workspaces",
    }
    ws = str(tmp_path / "ws")
    store = TokensStore(**kwargs)
    store.record(
        ws, source="cli", vendor="claude", pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20,
    )
    store.set_live_total(ws, "sess-1", {"input": 10, "output": 20, "calls": 1})
    store.flush()

    snap = TokensStore(**kwargs).snapshot(ws)
    assert snap["workspace"]["live_by_session"] == {}
    # The durable tallies did survive.
    assert snap["workspace"]["cumulative"]["totals"]["input"] == 10


def test_snapshot_without_a_workspace_still_has_live_by_session(store: TokensStore) -> None:
    assert store.snapshot(None)["workspace"]["live_by_session"] == {}
