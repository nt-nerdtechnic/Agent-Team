"""RolesStore persistence — default seeding and one-time legacy JSON import."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.roles_store import RolesStore, default_roles


def _store(tmp_path: Path) -> RolesStore:
    return RolesStore(path=tmp_path / "roles.json")


def test_seeds_defaults_when_nothing_stored(tmp_path: Path) -> None:
    store = _store(tmp_path)
    roles = store.list()
    assert [r["key"] for r in roles] == [r["key"] for r in default_roles()]
    # Seed persists: a second instance sees the same list.
    assert [r["key"] for r in _store(tmp_path).list()] == [r["key"] for r in roles]


def test_upsert_and_order_preserved_across_instances(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.upsert(key="zz", label="Z", one_line="", system_prompt="prompt")
    keys = [r["key"] for r in store.list()]
    assert keys[-1] == "zz"
    assert [r["key"] for r in _store(tmp_path).list()] == keys


def test_legacy_json_imported_once_and_retired(tmp_path: Path) -> None:
    legacy = tmp_path / "roles.json"
    custom = [
        {"key": "solo", "label": "Solo", "one_line": "", "system_prompt": "p",
         "is_default": False, "created_at": "2026-01-01T00:00:00Z",
         "updated_at": "2026-01-01T00:00:00Z"},
    ]
    legacy.write_text(json.dumps(custom), encoding="utf-8")
    store = _store(tmp_path)
    assert [r["key"] for r in store.list()] == ["solo"]
    assert not legacy.exists()
    assert legacy.with_name(legacy.name + ".migrated-v1").exists()
    # No re-import (and no default re-seed) on the next start.
    assert [r["key"] for r in _store(tmp_path).list()] == ["solo"]
