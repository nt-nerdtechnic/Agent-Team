"""Tests for UiSettingsStore — defaults, merge semantics, legacy import, corrupt recovery."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.db import MIGRATED_SUFFIX
from agent_team_backend.ui_settings import SETTINGS_FILE, UiSettingsStore, _MAX_FILE_SIZE


def make_store(tmp_path: Path) -> UiSettingsStore:
    return UiSettingsStore(path=tmp_path / SETTINGS_FILE)


def legacy_path(tmp_path: Path) -> Path:
    return tmp_path / SETTINGS_FILE


# ── Defaults ──────────────────────────────────────────────────────────────────

def test_get_missing_file_returns_empty_dict(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert store.get() == {}


def test_empty_set_writes_nothing(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert store.set({}) == {}
    # No non-empty delta → no bootstrap mirror file either.
    assert not legacy_path(tmp_path).exists()


# ── Merge semantics ───────────────────────────────────────────────────────────

def test_set_get_roundtrip(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"agent-team:theme": "dark", "agentTeam.colWidths": [120, 80]})
    result = store.get()
    assert result["agent-team:theme"] == "dark"
    assert result["agentTeam.colWidths"] == [120, 80]


def test_shallow_merge_preserves_other_keys(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"a": 1, "b": 2})
    store.set({"b": 3})
    assert store.get() == {"a": 1, "b": 3}


def test_none_value_deletes_key(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"a": 1, "b": 2})
    store.set({"a": None})
    assert store.get() == {"b": 2}


def test_set_returns_applied_delta(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"a": 1})
    delta = store.set({"b": 2, "a": None})
    assert delta == {"b": 2, "a": None}


def test_non_string_and_empty_keys_ignored(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    delta = store.set({1: "x", "": "y", "ok": "z"})  # type: ignore[dict-item]
    assert delta == {"ok": "z"}
    assert store.get() == {"ok": "z"}


# ── Bootstrap mirror (read by the Electron main process at startup) ───────────

def test_oversized_update_is_rejected_whole(tmp_path: Path) -> None:
    """An update that would grow the merged document past the size cap is
    refused: nothing persisted (kv or mirror), empty delta returned."""
    store = make_store(tmp_path)
    store.set({"keep": "small"})
    delta = store.set({"big": "x" * (_MAX_FILE_SIZE + 1)})
    assert delta == {}
    assert store.get() == {"keep": "small"}
    mirror = json.loads(legacy_path(tmp_path).read_text(encoding="utf-8"))
    assert mirror == {"keep": "small"}


def test_set_rewrites_bootstrap_mirror_atomically(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"a": 1})
    files = sorted(p.name for p in tmp_path.iterdir())
    assert files == ["navide.db", SETTINGS_FILE]
    # Mirror on disk is complete, valid JSON matching the stored document.
    assert json.loads(legacy_path(tmp_path).read_text(encoding="utf-8")) == {"a": 1}


def test_persistence_survives_new_store_instance(tmp_path: Path) -> None:
    make_store(tmp_path).set({"a": 1})
    assert make_store(tmp_path).get() == {"a": 1}


# ── Legacy JSON import ────────────────────────────────────────────────────────

def test_legacy_json_imported_once_and_retired(tmp_path: Path) -> None:
    legacy_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    legacy_path(tmp_path).write_text(json.dumps({"a": 1, "b": [2]}), encoding="utf-8")
    store = make_store(tmp_path)
    assert store.get() == {"a": 1, "b": [2]}
    retired = tmp_path / (SETTINGS_FILE + MIGRATED_SUFFIX)
    assert retired.exists()
    # The bootstrap mirror is recreated so the Electron main keeps its read.
    assert json.loads(legacy_path(tmp_path).read_text(encoding="utf-8")) == {"a": 1, "b": [2]}
    # Second start does not re-import.
    assert make_store(tmp_path).get() == {"a": 1, "b": [2]}


# ── Corrupt / oversized recovery ──────────────────────────────────────────────

def test_corrupt_file_returns_empty_dict(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    legacy_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    legacy_path(tmp_path).write_text("{not json", encoding="utf-8")
    assert store.get() == {}


def test_non_object_root_returns_empty_dict(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    legacy_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    legacy_path(tmp_path).write_text("[1, 2, 3]", encoding="utf-8")
    assert store.get() == {}


def test_oversized_file_returns_empty_dict(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    legacy_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    legacy_path(tmp_path).write_text(
        '{"pad": "' + "x" * (_MAX_FILE_SIZE + 1) + '"}', encoding="utf-8"
    )
    assert store.get() == {}


def test_set_recovers_corrupt_file(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    legacy_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    legacy_path(tmp_path).write_text("{not json", encoding="utf-8")
    store.set({"a": 1})
    assert store.get() == {"a": 1}
    assert json.loads(legacy_path(tmp_path).read_text(encoding="utf-8")) == {"a": 1}
