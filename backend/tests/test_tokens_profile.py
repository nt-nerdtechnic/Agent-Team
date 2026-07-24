"""Token schema migrations: the retained v1→v2 seed, the v2→v3 drop of the
`by_profile` dimension (per-account usage is no longer tracked), and the
grok inode-keyed dedup invariant. cli events no longer carry a profile."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend import store_migrations as sm
from agent_team_backend.tokens_store import (
    DEFAULT_PROFILE_KEY,
    TOKENS_FILE,
    WORKSPACES_SUBDIR,
    TokensStore,
    migrate_tokens_v1_to_v2,
    migrate_tokens_v2_to_v3,
)


@pytest.fixture
def store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
    )


@pytest.fixture
def workspace(tmp_path: Path) -> str:
    ws = tmp_path / "ws"
    ws.mkdir()
    return str(ws)


def _write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


# ─────────────────── recording (schema v3: no by_profile) ───────────────────


def test_cli_record_credits_vendor_globally_and_per_workspace(store, workspace) -> None:
    store.record(
        workspace, source="cli", vendor="claude", agent_key="claude",
        input_tokens=10, output_tokens=20,
    )
    snap = store.snapshot(workspace)
    # Totals land on the vendor + all-time dimensions.
    assert snap["global"]["by_vendor"]["claude"] == {"input": 10, "output": 20, "calls": 1}
    assert snap["global"]["all_time"] == {"input": 10, "output": 20, "calls": 1}
    assert snap["workspace"]["cumulative"]["by_vendor"]["claude"] == {
        "input": 10, "output": 20, "calls": 1,
    }
    # The per-account dimension is gone.
    assert "by_profile" not in snap["global"]
    assert "by_profile" not in snap["workspace"]["cumulative"]


def test_record_does_not_create_by_profile(store, workspace) -> None:
    store.record(
        workspace, source="cli", vendor="codex", agent_key="codex",
        input_tokens=5, output_tokens=7,
    )
    store.record(
        workspace, source="analyzer", vendor="analyzer",
        input_tokens=100, output_tokens=200,
    )
    snap = store.snapshot(workspace)
    assert "by_profile" not in snap["global"]
    assert "by_profile" not in snap["workspace"]["cumulative"]


# ─────────────────── grok inode-keyed dedup invariant ───────────────────


def test_grok_inode_dedup_still_holds(store, workspace) -> None:
    """A replayed grok event (same dedup_key + checkpoint identity) must still
    be deduped."""
    checkpoint = {"kind": "sqlite", "identity": "inode-123", "row_id": 5}
    common = dict(
        source="cli", vendor="grok", agent_key="grok",
        input_tokens=10, output_tokens=20, dedup_key="k1",
        ingestion_file="grok.db", ingestion_checkpoint=checkpoint,
    )
    assert store.record(workspace, **common) is True
    # Same event again → deduped, no double count (returns True = handled).
    assert store.record(workspace, **common) is True
    snap = store.snapshot(workspace)
    assert snap["global"]["all_time"] == {"input": 10, "output": 20, "calls": 1}
    assert snap["global"]["by_vendor"]["grok"] == {"input": 10, "output": 20, "calls": 1}


# ─────────────────── migration v1 → v2 (retained) ───────────────────


def _global_v1() -> dict:
    return {
        "schemaVersion": 1,
        "all_time": {"input": 30, "output": 60, "calls": 3},
        "by_vendor": {
            "claude": {"input": 20, "output": 40, "calls": 2},
            "analyzer": {"input": 10, "output": 20, "calls": 1},
        },
        "by_day": {},
    }


def _workspace_v1() -> dict:  # note: legacy workspace docs carry NO schemaVersion
    return {
        "current_run": None,
        "runs": [],
        "cumulative": {
            "totals": {"input": 20, "output": 40, "calls": 2},
            "by_vendor": {
                "claude": {"input": 20, "output": 40, "calls": 2},
                "analyzer": {"input": 5, "output": 5, "calls": 1},
            },
            "by_stage": {},
        },
    }


def test_migrate_global_v1_to_v2_seeds_default_and_excludes_analyzer() -> None:
    out = migrate_tokens_v1_to_v2(_global_v1())
    assert out["schemaVersion"] == 2
    assert out["by_profile"] == {
        "claude": {DEFAULT_PROFILE_KEY: {"input": 20, "output": 40, "calls": 2}},
    }


# ─────────────────── migration v2 → v3 (drop by_profile) ───────────────────


def _global_v2() -> dict:
    return {
        "schemaVersion": 2,
        "all_time": {"input": 30, "output": 60, "calls": 3},
        "by_vendor": {
            "claude": {"input": 20, "output": 40, "calls": 2},
            "analyzer": {"input": 10, "output": 20, "calls": 1},
        },
        "by_day": {},
        "by_profile": {
            "claude": {
                DEFAULT_PROFILE_KEY: {"input": 12, "output": 24, "calls": 1},
                "acc1": {"input": 8, "output": 16, "calls": 1},
            },
        },
    }


def _workspace_v2() -> dict:
    return {
        "schemaVersion": 2,
        "current_run": None,
        "runs": [],
        "cumulative": {
            "totals": {"input": 20, "output": 40, "calls": 2},
            "by_vendor": {"claude": {"input": 20, "output": 40, "calls": 2}},
            "by_stage": {},
            "by_profile": {"claude": {"acc1": {"input": 20, "output": 40, "calls": 2}}},
        },
    }


def test_migrate_global_v2_to_v3_drops_by_profile_preserving_totals() -> None:
    out = migrate_tokens_v2_to_v3(_global_v2())
    assert out["schemaVersion"] == 3
    assert "by_profile" not in out
    # No totals lost: by_vendor / all_time are untouched.
    assert out["by_vendor"]["claude"] == {"input": 20, "output": 40, "calls": 2}
    assert out["all_time"] == {"input": 30, "output": 60, "calls": 3}


def test_migrate_workspace_v2_to_v3_drops_cumulative_by_profile() -> None:
    out = migrate_tokens_v2_to_v3(_workspace_v2())
    assert out["schemaVersion"] == 3
    assert "by_profile" not in out["cumulative"]
    assert out["cumulative"]["by_vendor"]["claude"] == {"input": 20, "output": 40, "calls": 2}


def test_migrate_v2_to_v3_is_idempotent() -> None:
    once = migrate_tokens_v2_to_v3(_global_v2())
    twice = migrate_tokens_v2_to_v3(once)
    assert twice is once  # already v3 → untouched (same object)


def test_run_migrations_chains_v1_to_v3(tmp_path) -> None:
    global_path = tmp_path / TOKENS_FILE
    ws_path = tmp_path / WORKSPACES_SUBDIR / "abcd1234" / TOKENS_FILE
    _write_json(global_path, _global_v1())
    _write_json(ws_path, _workspace_v1())

    sm._run_migrations(tmp_path)

    g = json.loads(global_path.read_text(encoding="utf-8"))
    w = json.loads(ws_path.read_text(encoding="utf-8"))
    # v1 → v2 → v3: by_profile seeded then dropped, totals preserved.
    assert g["schemaVersion"] == 3
    assert "by_profile" not in g
    assert g["by_vendor"]["claude"]["calls"] == 2
    assert w["schemaVersion"] == 3
    assert "by_profile" not in w["cumulative"]
    assert w["cumulative"]["by_vendor"]["claude"]["calls"] == 2

    # Idempotent on disk: a second pass leaves the bytes untouched.
    before_g, before_w = global_path.read_bytes(), ws_path.read_bytes()
    sm._run_migrations(tmp_path)
    assert global_path.read_bytes() == before_g
    assert ws_path.read_bytes() == before_w


def test_store_load_migrates_v1_global_to_v3(tmp_path) -> None:
    """The store is constructed before store_migrations runs at startup, so it
    must run the migration chain itself when it loads a v1 global doc on disk —
    dropping by_profile while keeping the vendor totals."""
    _write_json(tmp_path / "tokens.json", _global_v1())
    store = TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
    )
    snap = store.snapshot(None)
    assert "by_profile" not in snap["global"]
    assert snap["global"]["by_vendor"]["claude"]["calls"] == 2
