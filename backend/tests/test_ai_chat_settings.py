"""Tests for AIChatSettingsStore — trimmed CLI-engine settings."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.ai_chat_settings import (
    AIChatSettingsStore,
    DEFAULTS,
    _KV_KEY,
)


def make_store(tmp_path: Path) -> AIChatSettingsStore:
    return AIChatSettingsStore(path=tmp_path / "settings.json")


def test_get_defaults(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert store.get() == DEFAULTS


def test_set_and_get_system_prompt(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.set({"system_prompt": "Prefer functional style."})
    assert result["system_prompt"] == "Prefer functional style."
    assert store.get()["system_prompt"] == "Prefer functional style."


def test_set_unknown_keys_ignored(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.set({"bogus_key": "whatever", "provider": "anthropic"})
    assert "bogus_key" not in result
    assert "provider" not in result


def test_non_string_system_prompt_falls_back_to_default(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.set({"system_prompt": 123})
    assert result["system_prompt"] == DEFAULTS["system_prompt"]


def test_legacy_provider_fields_hidden_on_read(tmp_path: Path) -> None:
    """Documents written by the removed API engine expose only current fields."""
    store = make_store(tmp_path)
    store._db.kv_set(_KV_KEY, {
        "provider": "anthropic",
        "anthropic_api_key": "sk-ant-test",
        "system_prompt": "keep me",
    }, now=0)
    result = store.get()
    assert result == {"system_prompt": "keep me"}


def test_legacy_fields_dropped_on_next_write(tmp_path: Path) -> None:
    """set() persists only current fields — stale API keys are purged."""
    store = make_store(tmp_path)
    store._db.kv_set(_KV_KEY, {
        "provider": "anthropic",
        "anthropic_api_key": "sk-ant-test",
    }, now=0)
    store.set({"system_prompt": "hi"})
    raw = store._db.kv_get(_KV_KEY)
    assert raw == {"system_prompt": "hi"}


def test_legacy_json_imported_once_and_retired(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps({"provider": "anthropic", "system_prompt": "from legacy"}),
        encoding="utf-8",
    )
    store = make_store(tmp_path)
    result = store.get()
    assert result["system_prompt"] == "from legacy"
    assert not path.exists()
    assert path.with_name(path.name + ".migrated-v1").exists()
    # Second instance sees the imported data without re-importing.
    assert make_store(tmp_path).get()["system_prompt"] == "from legacy"
