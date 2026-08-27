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


def test_live_bucket_accrues_without_an_active_run(store: TokensStore, workspace: str) -> None:
    """A manually opened CLI pane has no run, so by_pane stays empty — but the
    live tally is what the panel reads in that case and must still count."""
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20,
    )
    snap = store.snapshot(workspace)
    assert snap["workspace"]["current_run"] is None
    assert snap["workspace"]["live_by_pane"] == {
        "pane-a::sess-1": {"input": 10, "output": 20, "calls": 1},
    }


def test_live_bucket_falls_back_to_bare_pane_id(store: TokensStore, workspace: str) -> None:
    store.record(
        workspace, source="cli", vendor="claude", pane_id="pane-a",
        input_tokens=1, output_tokens=2,
    )
    live = store.snapshot(workspace)["workspace"]["live_by_pane"]
    assert live == {"pane-a": {"input": 1, "output": 2, "calls": 1}}


def test_live_and_run_buckets_both_accrue(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20,
    )
    ws = store.snapshot(workspace)["workspace"]
    assert ws["current_run"]["by_pane"]["pane-a"] == {"input": 10, "output": 20, "calls": 1}
    assert ws["live_by_pane"]["pane-a::sess-1"] == {"input": 10, "output": 20, "calls": 1}


def test_live_bucket_ignores_duplicate_events(store: TokensStore, workspace: str) -> None:
    for _ in range(2):
        store.record(
            workspace, source="cli", vendor="claude",
            pane_id="pane-a", session_id="sess-1",
            input_tokens=10, output_tokens=20, dedup_key="evt-1",
        )
    live = store.snapshot(workspace)["workspace"]["live_by_pane"]
    assert live["pane-a::sess-1"] == {"input": 10, "output": 20, "calls": 1}


def test_forget_pane_drops_every_session_of_that_pane(store: TokensStore, workspace: str) -> None:
    for session in ("sess-1", "sess-2"):
        store.record(
            workspace, source="cli", vendor="claude",
            pane_id="pane-a", session_id=session,
            input_tokens=10, output_tokens=20,
        )
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-b", session_id="sess-3",
        input_tokens=5, output_tokens=5,
    )
    store.forget_pane("pane-a")
    live = store.snapshot(workspace)["workspace"]["live_by_pane"]
    assert set(live) == {"pane-b::sess-3"}


def test_reset_run_without_a_run_clears_the_live_tally(store: TokensStore, workspace: str) -> None:
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20,
    )
    snap = store.reset("run", workspace_path=workspace)
    assert snap["workspace"]["live_by_pane"] == {}
    # Cumulative + global untouched, same as a run reset.
    assert snap["workspace"]["cumulative"]["totals"]["input"] == 10
    assert snap["global"]["all_time"]["input"] == 10


def test_reset_run_with_a_run_keeps_the_live_tally(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20,
    )
    snap = store.reset("run", workspace_path=workspace)
    assert snap["workspace"]["current_run"]["totals"]["calls"] == 0
    assert snap["workspace"]["live_by_pane"]["pane-a::sess-1"]["calls"] == 1


def test_live_tally_is_not_persisted(tmp_path: Path) -> None:
    """"This session" semantics: a restart starts the live tally over."""
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
    store.flush()

    snap = TokensStore(**kwargs).snapshot(ws)
    assert snap["workspace"]["live_by_pane"] == {}
    # The durable tallies did survive.
    assert snap["workspace"]["cumulative"]["totals"]["input"] == 10


def test_snapshot_without_a_workspace_still_has_live_by_pane(store: TokensStore) -> None:
    assert store.snapshot(None)["workspace"]["live_by_pane"] == {}
