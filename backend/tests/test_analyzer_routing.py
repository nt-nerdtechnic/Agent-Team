"""Tests for analyzer backend routing (llama_cpp vs ollama) and settings persistence."""

from __future__ import annotations

import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock


# ── AnalyzerSettingsStore ─────────────────────────────────────────────────────

from agent_team_backend.analyzer_settings import AnalyzerSettingsStore, DEFAULTS


def test_defaults_on_missing_file(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    s = store.get()
    assert s["backend"] == "ollama"
    assert s["ollama_base_url"] == "http://localhost:11434"
    assert s["llama_cli"] == ""
    assert s["gguf_path"] == ""


def test_set_backend_ollama(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"backend": "ollama"})
    assert result["backend"] == "ollama"
    # persists
    assert store.get()["backend"] == "ollama"


def test_set_invalid_backend_resets_to_llama_cpp(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"backend": "invalid_backend"})
    assert result["backend"] == "llama_cpp"


def test_set_llama_cli_override(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"llama_cli": "/usr/local/bin/llama-cli"})
    assert result["llama_cli"] == "/usr/local/bin/llama-cli"
    assert store.get()["llama_cli"] == "/usr/local/bin/llama-cli"


def test_set_ollama_base_url(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"ollama_base_url": "http://192.168.1.10:11434"})
    assert result["ollama_base_url"] == "http://192.168.1.10:11434"


def test_unknown_keys_ignored(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"nonexistent_key": "value"})
    assert "nonexistent_key" not in result


def test_gguf_path_default_empty(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    assert store.get()["gguf_path"] == ""


def test_gguf_path_set_and_persist(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"gguf_path": "/models/qwen2.5.gguf"})
    assert result["gguf_path"] == "/models/qwen2.5.gguf"
    assert store.get()["gguf_path"] == "/models/qwen2.5.gguf"


def test_persists_across_store_instances(tmp_path):
    path = tmp_path / "settings.json"
    AnalyzerSettingsStore(path).set({"backend": "ollama"})
    assert AnalyzerSettingsStore(path).get()["backend"] == "ollama"


def test_corrupted_file_returns_defaults(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text("{ invalid json }", encoding="utf-8")
    store = AnalyzerSettingsStore(path)
    s = store.get()
    assert s["backend"] == DEFAULTS["backend"]


def test_legacy_json_imported_once_and_retired(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps({"backend": "llama_cpp", "gguf_path": "/models/a.gguf"}),
        encoding="utf-8",
    )
    store = AnalyzerSettingsStore(path)
    s = store.get()
    assert s["backend"] == "llama_cpp"
    assert s["gguf_path"] == "/models/a.gguf"
    assert not path.exists()
    assert path.with_name(path.name + ".migrated-v1").exists()
    # Second instance reads the imported document, not defaults.
    assert AnalyzerSettingsStore(path).get()["gguf_path"] == "/models/a.gguf"


# ── Routing helpers (app.py) ──────────────────────────────────────────────────

@pytest.fixture
def settings_store(tmp_path):
    return AnalyzerSettingsStore(tmp_path / "settings.json")


def test_az_llama_cli_empty_returns_none(settings_store):
    """Empty llama_cli setting should yield None (use module default)."""
    settings_store.set({"llama_cli": ""})
    v = settings_store.get().get("llama_cli", "").strip()
    assert (v or None) is None


def test_az_llama_cli_set_returns_value(settings_store):
    settings_store.set({"llama_cli": "llama-cli"})
    v = settings_store.get().get("llama_cli", "").strip()
    assert (v or None) == "llama-cli"


# ── Routing dispatches to correct backend ─────────────────────────────────────

@pytest.mark.asyncio
async def test_classify_routes_to_llama_cpp(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp"})

    with patch("agent_team_backend.app.analyzer_settings_store", store), \
         patch("agent_team_backend.app._llama_classify", new_callable=AsyncMock) as mock_llama, \
         patch("agent_team_backend.app._ollama_classify", new_callable=AsyncMock) as mock_ollama:
        mock_llama.return_value = {"intent": "completion", "questions": [], "summary": "ok"}
        from agent_team_backend import app
        # Reload routing helpers by calling them directly
        import importlib
        importlib.reload(app)
        # Re-patch after reload
        app.analyzer_settings_store = store

        # Call routing via the module-level function
        with patch.object(app, "_llama_classify", mock_llama), \
             patch.object(app, "_ollama_classify", mock_ollama):
            result = await app.analyzer_classify("some text", "qwen2.5-coder:latest")

        mock_llama.assert_called_once()
        mock_ollama.assert_not_called()
        assert result["intent"] == "completion"


@pytest.mark.asyncio
async def test_classify_routes_to_ollama(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "ollama", "ollama_base_url": "http://localhost:11434"})

    with patch("agent_team_backend.app.analyzer_settings_store", store):
        from agent_team_backend import app
        with patch.object(app, "_ollama_classify", new_callable=AsyncMock) as mock_ollama, \
             patch.object(app, "_llama_classify", new_callable=AsyncMock) as mock_llama:
            mock_ollama.return_value = {"intent": "question", "questions": [], "summary": "q"}
            app.analyzer_settings_store = store
            result = await app.analyzer_classify("some text", "qwen2.5-coder:latest")

        mock_ollama.assert_called_once()
        mock_llama.assert_not_called()


@pytest.mark.asyncio
async def test_health_routes_to_llama_cpp(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp"})

    from agent_team_backend import app
    with patch.object(app, "_llama_health", new_callable=AsyncMock) as mock_llama, \
         patch.object(app, "_ollama_health", new_callable=AsyncMock) as mock_ollama:
        mock_llama.return_value = {"ok": True, "version": "9330"}
        app.analyzer_settings_store = store
        result = await app.analyzer_health()

    mock_llama.assert_called_once()
    mock_ollama.assert_not_called()
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_health_routes_to_ollama(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "ollama"})

    from agent_team_backend import app
    with patch.object(app, "_llama_health", new_callable=AsyncMock) as mock_llama, \
         patch.object(app, "_ollama_health", new_callable=AsyncMock) as mock_ollama:
        mock_ollama.return_value = {"ok": True, "version": "0.5.1"}
        app.analyzer_settings_store = store
        result = await app.analyzer_health()

    mock_ollama.assert_called_once()
    mock_llama.assert_not_called()
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_llama_cli_override_passed_to_classify(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp", "llama_cli": "/custom/llama-cli"})

    from agent_team_backend import app
    with patch.object(app, "_llama_classify", new_callable=AsyncMock) as mock_llama:
        mock_llama.return_value = {"intent": "in_progress", "questions": [], "summary": ""}
        app.analyzer_settings_store = store
        await app.analyzer_classify("text", "model")

    call_kwargs = mock_llama.call_args.kwargs
    assert call_kwargs.get("llama_cli_override") == "/custom/llama-cli"


@pytest.mark.asyncio
async def test_empty_llama_cli_passes_none(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp", "llama_cli": ""})

    from agent_team_backend import app
    with patch.object(app, "_llama_classify", new_callable=AsyncMock) as mock_llama:
        mock_llama.return_value = {"intent": "in_progress", "questions": [], "summary": ""}
        app.analyzer_settings_store = store
        await app.analyzer_classify("text", "model")

    call_kwargs = mock_llama.call_args.kwargs
    assert call_kwargs.get("llama_cli_override") is None


# ── analyzer.py llama_cli_override plumbing ───────────────────────────────────

@pytest.mark.asyncio
async def test_run_llama_cli_uses_override():
    """_run_llama_cli should use llama_cli_override instead of LLAMA_CLI."""
    from agent_team_backend.analyzer import _run_llama_cli
    from pathlib import Path
    import asyncio

    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.communicate = AsyncMock(return_value=(b'{"intent":"completion"}', b""))

    with patch("agent_team_backend.analyzer.asyncio.create_subprocess_exec",
               new_callable=AsyncMock) as mock_exec, \
         patch("agent_team_backend.analyzer._llama_sem", asyncio.Semaphore(1)):
        mock_exec.return_value = mock_proc
        await _run_llama_cli(
            system_prompt="sys",
            user_message="msg",
            gguf_path=Path("/fake/model.gguf"),
            llama_cli_override="/custom/llama-completion",
        )

    called_cmd = mock_exec.call_args.args
    assert called_cmd[0] == "/custom/llama-completion"


@pytest.mark.asyncio
async def test_health_uses_override():
    """health() should check the overridden CLI, not the default LLAMA_CLI."""
    from agent_team_backend.analyzer import health
    import shutil

    with patch("agent_team_backend.analyzer.shutil.which") as mock_which:
        mock_which.return_value = None
        result = await health(llama_cli_override="nonexistent-binary-xyz")

    mock_which.assert_called_with("nonexistent-binary-xyz")
    assert result["ok"] is False
    assert "nonexistent-binary-xyz" in result["error"]


@pytest.mark.asyncio
async def test_health_gguf_warning_when_file_missing(tmp_path):
    """health() should include gguf_warning when custom GGUF file doesn't exist."""
    from agent_team_backend.analyzer import health

    fake_gguf = str(tmp_path / "nonexistent.gguf")

    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.communicate = AsyncMock(return_value=(b"version 9330\n", b""))

    with patch("agent_team_backend.analyzer.shutil.which", return_value="/usr/local/bin/llama-cli"), \
         patch("agent_team_backend.analyzer.asyncio.create_subprocess_exec",
               new_callable=AsyncMock, return_value=mock_proc):
        result = await health(gguf_path_override=fake_gguf)

    assert result["ok"] is True
    assert "gguf_warning" in result
    assert "nonexistent.gguf" in result["gguf_warning"]


@pytest.mark.asyncio
async def test_health_gguf_size_when_file_exists(tmp_path):
    """health() should include gguf_size when custom GGUF file exists."""
    from agent_team_backend.analyzer import health

    gguf_file = tmp_path / "model.gguf"
    gguf_file.write_bytes(b"fake gguf content" * 100)

    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.communicate = AsyncMock(return_value=(b"version 9330\n", b""))

    with patch("agent_team_backend.analyzer.shutil.which", return_value="/usr/local/bin/llama-cli"), \
         patch("agent_team_backend.analyzer.asyncio.create_subprocess_exec",
               new_callable=AsyncMock, return_value=mock_proc):
        result = await health(gguf_path_override=str(gguf_file))

    assert result["ok"] is True
    assert "gguf_warning" not in result
    assert result["gguf_size"] > 0


@pytest.mark.asyncio
async def test_classify_uses_gguf_path_override(tmp_path):
    """classify() should use gguf_path_override directly, skipping _find_gguf_path."""
    from agent_team_backend.analyzer import classify
    import asyncio

    gguf_file = tmp_path / "model.gguf"
    gguf_file.write_bytes(b"x")  # must exist

    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.communicate = AsyncMock(return_value=(
        b'{"intent":"completion","questions":[],"summary":"done"}', b""
    ))

    with patch("agent_team_backend.analyzer.asyncio.create_subprocess_exec",
               new_callable=AsyncMock, return_value=mock_proc), \
         patch("agent_team_backend.analyzer._llama_sem", asyncio.Semaphore(1)), \
         patch("agent_team_backend.analyzer._find_gguf_path") as mock_find:
        result = await classify("some text", gguf_path_override=str(gguf_file))

    mock_find.assert_not_called()
    assert result["intent"] == "completion"


@pytest.mark.asyncio
async def test_classify_gguf_override_missing_file(tmp_path):
    """classify() should return error when gguf_path_override points to missing file."""
    from agent_team_backend.analyzer import classify

    missing = str(tmp_path / "missing.gguf")
    result = await classify("some text", gguf_path_override=missing)

    assert result["intent"] == "in_progress"
    assert "_error" in result
    assert "missing.gguf" in result["_error"]


# ── analyzer.classify WS handler: queued notification ────────────────────────

class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_classify_broadcasts_queued_when_semaphore_busy(tmp_path):
    """A queued analyzer.classify (llama-cli already busy) should broadcast
    analyzer.queued with the request's pane/stage identification before
    running, so the frontend doesn't just look stuck until it finishes."""
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp"})

    from agent_team_backend import app
    session = app.Session(_FakeWebSocket())

    with patch.object(app, "analyzer_settings_store", store), \
         patch.object(app, "_llama_cli_busy", return_value=True), \
         patch.object(app, "analyzer_classify", new_callable=AsyncMock) as mock_classify, \
         patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        mock_classify.return_value = {"intent": "in_progress", "questions": [], "summary": ""}
        await app.handle_message(session, {
            "id": "m1",
            "type": "analyzer.classify",
            "payload": {"text": "hello", "pane_id": "pane-1", "stage_id": "stage-1", "workspace_path": "/ws"},
        })

    mock_broadcast.assert_called_once()
    event = mock_broadcast.call_args.args[0]
    assert event["type"] == "analyzer.queued"
    assert event["payload"] == {"pane_id": "pane-1", "stage_id": "stage-1", "workspace_path": "/ws"}
    # The classify call itself still proceeds and responds normally.
    assert session.websocket.sent[0]["payload"]["intent"] == "in_progress"


@pytest.mark.asyncio
async def test_classify_no_queued_event_when_semaphore_free(tmp_path):
    """When llama-cli is idle, classify should run immediately with no
    analyzer.queued broadcast."""
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp"})

    from agent_team_backend import app
    session = app.Session(_FakeWebSocket())

    with patch.object(app, "analyzer_settings_store", store), \
         patch.object(app, "_llama_cli_busy", return_value=False), \
         patch.object(app, "analyzer_classify", new_callable=AsyncMock) as mock_classify, \
         patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        mock_classify.return_value = {"intent": "completion", "questions": [], "summary": ""}
        await app.handle_message(session, {
            "id": "m1",
            "type": "analyzer.classify",
            "payload": {"text": "hello", "pane_id": "pane-1"},
        })

    mock_broadcast.assert_not_called()
    assert session.websocket.sent[0]["payload"]["intent"] == "completion"


@pytest.mark.asyncio
async def test_routing_passes_gguf_path_to_classify(tmp_path):
    """app.analyzer_classify should pass gguf_path_override from settings."""
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp", "gguf_path": "/custom/model.gguf"})

    from agent_team_backend import app
    with patch.object(app, "_llama_classify", new_callable=AsyncMock) as mock_llama:
        mock_llama.return_value = {"intent": "in_progress", "questions": [], "summary": ""}
        app.analyzer_settings_store = store
        await app.analyzer_classify("text", "model")

    call_kwargs = mock_llama.call_args.kwargs
    assert call_kwargs.get("gguf_path_override") == "/custom/model.gguf"
