"""Tests for AIChatSettingsStore — especially model key mapping."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.ai_chat_settings import (
    AIChatSettingsStore,
    DEFAULTS,
    _KV_KEY,
    _VALID_PROVIDERS,
    _PROVIDER_MODEL_FIELD,
)


def make_store(tmp_path: Path) -> AIChatSettingsStore:
    return AIChatSettingsStore(path=tmp_path / "settings.json")


def test_get_defaults(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.get()
    assert result["provider"] == DEFAULTS["provider"]
    assert "model" in result


def test_get_model_alias_anthropic(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"provider": "anthropic", "model": "claude-opus-4-8"})
    result = store.get()
    assert result["model"] == "claude-opus-4-8"
    assert result["anthropic_model"] == "claude-opus-4-8"


def test_get_model_alias_ollama(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"provider": "ollama", "model": "llama3.2:70b"})
    result = store.get()
    assert result["model"] == "llama3.2:70b"
    assert result["ollama_model"] == "llama3.2:70b"


def test_set_model_without_provider_change(tmp_path: Path) -> None:
    """Frontend may send only model without repeating provider."""
    store = make_store(tmp_path)
    # first establish provider=anthropic
    store.set({"provider": "anthropic"})
    # now update model only
    store.set({"model": "claude-haiku-4-5-20251001"})
    result = store.get()
    assert result["anthropic_model"] == "claude-haiku-4-5-20251001"
    assert result["model"] == "claude-haiku-4-5-20251001"
    assert result["provider"] == "anthropic"


def test_model_key_not_persisted_to_disk(tmp_path: Path) -> None:
    """The computed `model` alias must NOT be written to the stored document."""
    store = make_store(tmp_path)
    store.set({"provider": "anthropic", "model": "claude-sonnet-4-6"})
    raw = store._db.kv_get(_KV_KEY)
    assert "model" not in raw


def test_set_unknown_keys_ignored(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.set({"bogus_key": "whatever"})
    assert "bogus_key" not in result


def test_invalid_provider_falls_back_to_ollama(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.set({"provider": "unknown_provider"})
    assert result["provider"] == "ollama"


def test_set_returns_model_alias(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.set({"provider": "anthropic", "model": "claude-opus-4-8"})
    assert result.get("model") == "claude-opus-4-8"


# ── New multi-provider tests ──────────────────────────────────────────────────

@pytest.mark.parametrize("provider,expected_field,model", [
    ("openai",           "openai_model",           "gpt-4o"),
    ("google",           "google_model",           "gemini-2.5-pro"),
    ("groq",             "groq_model",             "llama-3.3-70b-versatile"),
    ("deepseek",         "deepseek_model",         "deepseek-chat"),
    ("mistral",          "mistral_model",          "mistral-large-latest"),
    ("xai",              "xai_model",              "grok-3-mini"),
    ("openai_compatible","openai_compatible_model", "my-custom-model"),
])
def test_model_alias_all_providers(tmp_path: Path, provider: str, expected_field: str, model: str) -> None:
    """Setting model for each provider writes to the correct provider-specific field."""
    store = make_store(tmp_path)
    result = store.set({"provider": provider, "model": model})
    assert result["provider"] == provider
    assert result["model"] == model
    assert result[expected_field] == model


def test_all_new_providers_in_valid_providers() -> None:
    """Every new provider must be in _VALID_PROVIDERS and _PROVIDER_MODEL_FIELD."""
    new_providers = {"openai", "google", "groq", "deepseek", "mistral", "xai", "openai_compatible"}
    assert new_providers.issubset(set(_VALID_PROVIDERS))
    assert new_providers.issubset(set(_PROVIDER_MODEL_FIELD.keys()))


def test_new_providers_have_defaults() -> None:
    """Each new cloud provider must have key and model entries in DEFAULTS."""
    for prov in ("openai", "google", "groq", "deepseek", "mistral", "xai"):
        assert f"{prov}_api_key" in DEFAULTS, f"Missing {prov}_api_key in DEFAULTS"
        assert f"{prov}_model"   in DEFAULTS, f"Missing {prov}_model in DEFAULTS"
    # Custom OpenAI-compatible has three fields
    for field in ("openai_compatible_base_url", "openai_compatible_api_key", "openai_compatible_model"):
        assert field in DEFAULTS


def test_api_keys_not_in_defaults_values() -> None:
    """All API key DEFAULTS must be empty strings (no hardcoded secrets)."""
    key_fields = [k for k in DEFAULTS if k.endswith("_api_key")]
    for field in key_fields:
        assert DEFAULTS[field] == "", f"{field} should default to ''"


def test_model_key_not_persisted_for_new_providers(tmp_path: Path) -> None:
    """The computed `model` alias must NOT appear in the persisted document for any provider."""
    for prov in _VALID_PROVIDERS:
        store = AIChatSettingsStore(path=tmp_path / prov / "s.json")
        store.set({"provider": prov, "model": "test-model"})
        raw = store._db.kv_get(_KV_KEY)
        assert "model" not in raw, f"'model' alias leaked for provider={prov}"


def test_legacy_json_imported_once_and_retired(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps({"provider": "anthropic", "anthropic_api_key": "sk-ant-test"}),
        encoding="utf-8",
    )
    store = make_store(tmp_path)
    result = store.get()
    assert result["provider"] == "anthropic"
    assert result["anthropic_api_key"] == "sk-ant-test"
    assert not path.exists()
    assert path.with_name(path.name + ".migrated-v1").exists()
    # Second instance sees the imported data without re-importing.
    assert make_store(tmp_path).get()["anthropic_api_key"] == "sk-ant-test"


def test_switch_provider_preserves_other_keys(tmp_path: Path) -> None:
    """Switching provider must not wipe out keys for other providers."""
    store = make_store(tmp_path)
    store.set({"provider": "anthropic", "anthropic_api_key": "sk-ant-test"})
    store.set({"provider": "openai", "openai_api_key": "sk-oai-test"})
    result = store.get()
    assert result["provider"] == "openai"
    assert result["anthropic_api_key"] == "sk-ant-test"
    assert result["openai_api_key"] == "sk-oai-test"


def test_openai_compatible_fields(tmp_path: Path) -> None:
    """Custom OpenAI-compatible provider stores base_url, key, and model."""
    store = make_store(tmp_path)
    store.set({
        "provider": "openai_compatible",
        "openai_compatible_base_url": "http://localhost:1234/v1",
        "openai_compatible_api_key": "my-secret",
        "openai_compatible_model": "llama-3.3-70b",
    })
    result = store.get()
    assert result["openai_compatible_base_url"] == "http://localhost:1234/v1"
    assert result["openai_compatible_api_key"] == "my-secret"
    assert result["model"] == "llama-3.3-70b"


def test_invalid_provider_still_falls_back_to_ollama(tmp_path: Path) -> None:
    """Unknown provider values are still rejected (backward compat)."""
    store = make_store(tmp_path)
    result = store.set({"provider": "some_future_provider"})
    assert result["provider"] == "ollama"
