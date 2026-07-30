"""ProjectStore.set_tab_order — run-group tab order persistence.

The run groups themselves live in the renderer; the backend just persists the
id list as an ordering hint. Covers the happy path (store + round-trip through
disk), overwriting a previous order, unknown/stale ids being kept verbatim
(the frontend skips them on restore), peek semantics (no project → None,
nothing created on disk), and the backward-compatible default (a legacy
project.json without the field → empty list).
"""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.projects import ProjectStore


def _store_with_project(ws: Path) -> ProjectStore:
    store = ProjectStore()
    store.save(store.load_or_create(str(ws)))
    return store


def test_stores_tab_order_and_round_trips_through_disk(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    result = store.set_tab_order(str(tmp_path), tab_order=["rg-2", "rg-1", "rg-3"])
    assert result is not None
    assert result.tab_order == ["rg-2", "rg-1", "rg-3"]
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.tab_order == ["rg-2", "rg-1", "rg-3"]


def test_overwrites_previous_order(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_tab_order(str(tmp_path), tab_order=["a", "b"])
    store.set_tab_order(str(tmp_path), tab_order=["b", "a"])
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.tab_order == ["b", "a"]


def test_unknown_ids_are_stored_verbatim(tmp_path: Path) -> None:
    """Stale/unknown ids are harmless — the frontend skips them on restore."""
    store = _store_with_project(tmp_path)
    store.set_tab_order(str(tmp_path), tab_order=["ghost", "rg-1"])
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.tab_order == ["ghost", "rg-1"]


def test_no_project_returns_none_and_creates_nothing(tmp_path: Path) -> None:
    """peek semantics: setting tab order must never create a project.json."""
    store = ProjectStore()
    assert store.set_tab_order(str(tmp_path), tab_order=["a"]) is None
    assert not store.project_file(str(tmp_path)).exists()


def test_legacy_project_json_without_field_defaults_to_empty(tmp_path: Path) -> None:
    """Backward compat: a legacy project.json without tab_order loads as []."""
    legacy = tmp_path / ".agent-team" / "project.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(json.dumps({
        "id": "p1", "name": "x", "workspace_path": str(tmp_path),
        "created_at": "t", "updated_at": "t",
    }), encoding="utf-8")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.tab_order == []
