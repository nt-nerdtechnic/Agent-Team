"""MCP/Skills settings WebSocket integration and bundle safety tests."""

from __future__ import annotations

import asyncio
import tempfile
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, skills_store as skills_store_module, ws_handlers
from agent_team_backend.mcp_settings import MCPSettingsStore, REDACTED_SECRET
from agent_team_backend.skills_store import SkillsStore, SkillsStoreError


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeMCPManager:
    def __init__(self, status: list[dict[str, Any]] | None = None) -> None:
        self.status = status or []
        self.reloads: list[Path] = []
        self.list_calls = 0

    async def list_status(self) -> list[dict[str, Any]]:
        self.list_calls += 1
        return self.status

    async def reload(self, path: Path) -> None:
        self.reloads.append(path)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


async def _request(
    session: app.Session,
    msg_type: str,
    payload: dict[str, Any] | None = None,
    *,
    msg_id: str = "request-1",
) -> dict[str, Any]:
    await app.handle_message(
        session,
        {"id": msg_id, "type": msg_type, "payload": payload or {}},
    )
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


@pytest.fixture
def settings_stores(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[MCPSettingsStore, SkillsStore, FakeMCPManager]:
    mcp_store = MCPSettingsStore(tmp_path / "mcp_servers.json")
    skills_store = SkillsStore(
        root=tmp_path / "skills",
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[],
    )
    manager = FakeMCPManager()
    monkeypatch.setattr(app, "mcp_settings_store", mcp_store)
    monkeypatch.setattr(app, "skills_store", skills_store)
    monkeypatch.setattr(app, "mcp_manager", manager)
    return mcp_store, skills_store, manager


def test_settings_paths_and_bundle_redact_mcp_without_skills_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    settings_stores: tuple[MCPSettingsStore, SkillsStore, FakeMCPManager],
) -> None:
    mcp_store, skills_store, _manager = settings_stores
    monkeypatch.setattr(
        app,
        "roles_store",
        SimpleNamespace(path=tmp_path / "roles.json", list=lambda: []),
    )
    monkeypatch.setattr(
        app,
        "stages_store",
        SimpleNamespace(path=tmp_path / "pipelines.json", export_document=lambda: {}),
    )
    monkeypatch.setattr(
        app,
        "analyzer_settings_store",
        SimpleNamespace(path=tmp_path / "analyzer.json", get=lambda: {}),
    )
    monkeypatch.setattr(
        app,
        "ai_chat_settings_store",
        SimpleNamespace(path=tmp_path / "ai-chat.json", get=lambda: {}),
    )
    mcp_store.replace_servers(
        [
            {
                "name": "local",
                "transport": "stdio",
                "command": "node",
                "env": {"API_TOKEN": "env-secret", "LOG_LEVEL": "debug"},
            },
            {
                "name": "remote",
                "transport": "http",
                "url": "https://example.test/mcp",
                "headers": {
                    "Authorization": "Bearer secret",
                    "Accept": "application/json",
                },
            },
        ]
    )
    skills_store.create_skill("private-skill", "must not be bundled", consent=True)
    attachment = skills_store.root / "private-skill" / "references" / "secret.txt"
    attachment.parent.mkdir()
    attachment.write_text("attachment-content", encoding="utf-8")

    paths = app._settings_paths()
    bundle = app._settings_bundle()

    assert paths["skills"] == str(skills_store.root)
    assert paths["skills_state"] == str(skills_store.state_path)
    assert bundle["mcp_servers"][0]["env"] == {
        "API_TOKEN": REDACTED_SECRET,
        "LOG_LEVEL": "debug",
    }
    assert bundle["mcp_servers"][1]["headers"] == {
        "Authorization": REDACTED_SECRET,
        "Accept": "application/json",
    }
    assert "skills" not in bundle
    assert "skills_state" not in bundle
    encoded = json.dumps(bundle)
    assert "must not be bundled" not in encoded
    assert "attachment-content" not in encoded


@pytest.mark.asyncio
async def test_mcp_list_and_save_return_opaque_revision_and_keep_response_compatibility(
    settings_stores: tuple[MCPSettingsStore, SkillsStore, FakeMCPManager],
) -> None:
    store, _skills, manager = settings_stores
    store.replace_servers(
        [{"name": "ctx", "transport": "stdio", "command": "npx"}]
    )
    manager.status = [
        {
            "name": "ctx",
            "status": "connected",
            "tool_count": 1,
            "tools": [{"name": "resolve", "description": ""}],
        }
    ]
    session = _session()

    listed = await _request(session, "mcp.list_servers")
    revision = listed["payload"]["revision"]

    assert listed["ok"] is True
    assert isinstance(revision, str)
    assert revision == str(store.revision)
    assert listed["payload"]["servers"][0]["status"] == "connected"
    assert listed["payload"]["path"] == str(store.path)
    # The page is the single entry point for every CLI's MCP, so a listing
    # also carries what each agent already loads on its own.
    assert listed["payload"]["native"] == []
    assert {agent["key"] for agent in listed["payload"]["agents"]} >= {"claude", "aider"}

    saved = await _request(
        session,
        "mcp.save_servers",
        {
            "servers": [
                {
                    "name": "remote",
                    "transport": "sse",
                    "url": "https://example.test/sse",
                }
            ],
            "expected_revision": revision,
        },
        msg_id="save-1",
    )

    assert saved["ok"] is True
    assert saved["payload"]["ok"] is True
    assert saved["payload"]["servers"][0]["name"] == "remote"
    assert saved["payload"]["revision"] == str(store.revision)
    assert manager.reloads == [store.path]


@pytest.mark.asyncio
async def test_mcp_conflict_and_invalid_file_return_stable_errors_without_reload(
    tmp_path: Path,
    settings_stores: tuple[MCPSettingsStore, SkillsStore, FakeMCPManager],
) -> None:
    store, _skills, manager = settings_stores
    store.list_servers()
    stale_revision = store.revision
    external = [{"name": "external", "transport": "stdio", "command": "echo"}]
    store.path.write_text(json.dumps(external), encoding="utf-8")
    os.utime(store.path, ns=(stale_revision + 10_000, stale_revision + 10_000))
    session = _session()

    conflict = await _request(
        session,
        "mcp.save_servers",
        {
            "servers": [{"name": "mine", "transport": "stdio", "command": "node"}],
            "expected_revision": str(stale_revision),
        },
    )

    assert conflict["ok"] is False
    assert conflict["error"]["code"] == "MCP_SETTINGS_CONFLICT"
    assert conflict["error"]["details"] == {
        "expected_revision": str(stale_revision),
        "actual_revision": str(store.revision),
        "path": str(store.path),
    }
    assert manager.reloads == []
    assert json.loads(store.path.read_text(encoding="utf-8")) == external

    invalid_content = "{not valid json"
    store.path.write_text(invalid_content, encoding="utf-8")
    invalid = await _request(session, "mcp.list_servers", msg_id="invalid-1")

    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "MCP_SETTINGS_INVALID"
    assert invalid["error"]["details"]["path"] == str(store.path)
    assert store.path.read_text(encoding="utf-8") == invalid_content
    assert manager.list_calls == 0


@pytest.mark.asyncio
async def test_bundle_import_restores_local_mcp_secrets_and_ignores_skills(
    settings_stores: tuple[MCPSettingsStore, SkillsStore, FakeMCPManager],
) -> None:
    store, skills_store, manager = settings_stores
    store.replace_servers(
        [
            {
                "name": "local",
                "transport": "stdio",
                "command": "node",
                "env": {"API_TOKEN": "local-env-secret"},
            },
            {
                "name": "remote",
                "transport": "http",
                "url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer local-secret"},
            },
        ]
    )
    skills_store.create_skill("keep-me", "untouched", consent=True)
    session = _session()

    response = await _request(
        session,
        "settings.bundle.import",
        {
            "bundle": {
                "mcp_servers": [
                    {
                        "name": "local",
                        "transport": "stdio",
                        "command": "node",
                        "env": {"API_TOKEN": REDACTED_SECRET},
                    },
                    {
                        "name": "remote",
                        "transport": "http",
                        "url": "https://example.test/mcp",
                        "headers": {"Authorization": REDACTED_SECRET},
                    },
                ],
                "skills": [{"name": "must-be-ignored"}],
                "skills_attachments": ["must-be-ignored.txt"],
            }
        },
    )

    assert response["ok"] is True
    assert response["payload"]["applied"] == ["mcp"]
    persisted = store.list_servers()
    assert persisted[0]["env"]["API_TOKEN"] == "local-env-secret"
    assert persisted[1]["headers"]["Authorization"] == "Bearer local-secret"
    assert REDACTED_SECRET not in store.path.read_text(encoding="utf-8")
    assert skills_store.get_skill("keep-me")["skill"]["description"] == "untouched"
    assert not (skills_store.root / "must-be-ignored").exists()
    assert manager.reloads == [store.path]


@pytest.mark.asyncio
async def test_skills_handlers_run_store_operations_in_worker_threads(
    monkeypatch: pytest.MonkeyPatch,
    settings_stores: tuple[MCPSettingsStore, SkillsStore, FakeMCPManager],
) -> None:
    _mcp, skills_store, _manager = settings_stores
    monkeypatch.setattr(skills_store_module, "send2trash", lambda path: shutil.rmtree(path))
    original_to_thread = asyncio.to_thread
    threaded: list[str] = []

    async def spy(operation: Any, *args: Any, **kwargs: Any) -> Any:
        threaded.append(operation.__name__)
        return await original_to_thread(operation, *args, **kwargs)

    monkeypatch.setattr(ws_handlers.asyncio, "to_thread", spy)
    session = _session()

    created = await _request(
        session,
        "skills.create",
        {"name": "demo", "description": "first", "consent": True},
        msg_id="create",
    )
    revision = created["payload"]["skill"]["revision"]
    fetched = await _request(session, "skills.get", {"name": "demo"}, msg_id="get")
    saved = await _request(
        session,
        "skills.save",
        {
            "name": "demo",
            "fields": {"description": "updated", "metadata": {"nested": True}},
            "body": "# Instructions\n",
            "expected_revision": revision,
        },
        msg_id="save",
    )
    disabled = await _request(
        session,
        "skills.set_enabled",
        {"name": "demo", "enabled": False},
        msg_id="disable",
    )
    listed = await _request(session, "skills.list", msg_id="list")
    deleted = await _request(
        session, "skills.delete", {"name": "demo"}, msg_id="delete"
    )

    assert created["payload"]["skill"]["description"] == "first"
    assert fetched["payload"]["skill"]["name"] == "demo"
    assert saved["payload"]["skill"]["fields"]["metadata"] == {"nested": True}
    assert saved["payload"]["skill"]["body"] == "# Instructions\n"
    assert disabled["payload"]["skill"]["enabled"] is False
    assert listed["payload"]["root"] == str(skills_store.root)
    assert listed["payload"]["skills"][0]["enabled"] is False
    assert deleted["payload"] == {"name": "demo", "deleted": True}
    assert threaded == [
        "create_skill",
        "get_skill",
        "save_skill",
        "set_enabled",
        "list_skills",
        "delete_skill",
    ]


@pytest.mark.asyncio
async def test_skills_handlers_map_expected_store_errors(
    monkeypatch: pytest.MonkeyPatch,
    settings_stores: tuple[MCPSettingsStore, SkillsStore, FakeMCPManager],
) -> None:
    _mcp, skills_store, _manager = settings_stores
    session = _session()

    missing = await _request(session, "skills.get", {"name": "missing"}, msg_id="missing")
    invalid = await _request(
        session, "skills.create", {"name": "../escape"}, msg_id="invalid"
    )
    created = skills_store.create_skill("conflict", "initial", consent=True)["skill"]
    skills_store.save_skill(
        "conflict",
        {"description": "external"},
        "external body",
        created["revision"],
    )
    conflict = await _request(
        session,
        "skills.save",
        {
            "name": "conflict",
            "fields": {"description": "mine"},
            "body": "mine",
            "expected_revision": created["revision"],
        },
        msg_id="conflict",
    )

    def fail_list() -> dict[str, Any]:
        raise SkillsStoreError("state unavailable")

    monkeypatch.setattr(skills_store, "list_skills", fail_list)
    store_error = await _request(session, "skills.list", msg_id="store-error")

    assert missing["error"]["code"] == "SKILL_NOT_FOUND"
    assert missing["error"]["details"] == {"name": "missing"}
    assert invalid["error"]["code"] == "SKILL_VALIDATION_ERROR"
    assert invalid["error"]["details"] == {"name": "../escape"}
    assert conflict["error"]["code"] == "SKILL_CONFLICT"
    assert conflict["error"]["details"]["name"] == "conflict"
    assert conflict["error"]["details"]["expected_revision"] == created["revision"]
    assert conflict["error"]["details"]["actual_revision"] != created["revision"]
    assert store_error["error"]["code"] == "SKILLS_STORE_ERROR"


@pytest.mark.asyncio
async def test_skills_create_over_ws_asks_for_consent_before_the_first_write(monkeypatch) -> None:
    """The handler must surface consent as its own error code, not a generic
    validation failure, so the UI can ask and retry."""
    from agent_team_backend import app as app_module
    from agent_team_backend.skills_store import SkillsStore

    tmp = Path(tempfile.mkdtemp())
    store = SkillsStore(
        root=tmp / "skills", state_path=tmp / "skills.json",
        runtime_root=tmp / "runtime" / "skills", native_roots=[],
    )
    monkeypatch.setattr(app_module, "skills_store", store)
    session = app_module.Session(FakeWebSocket())  # type: ignore[arg-type]

    refused = await _request(
        session, "skills.create", {"name": "demo", "description": "d"}, msg_id="c1"
    )
    assert refused["error"]["code"] == "SKILL_CONSENT_REQUIRED"
    assert refused["error"]["details"]["root"] == str(store.root)
    assert not store.root.exists()

    granted = await _request(
        session, "skills.create", {"name": "demo", "description": "d", "consent": True}, msg_id="c2"
    )
    assert granted["payload"]["skill"]["name"] == "demo"
    assert store.write_consented() is True


@pytest.mark.asyncio
async def test_mcp_list_reflects_the_servers_each_cli_already_loads(
    settings_stores: tuple[MCPSettingsStore, SkillsStore, FakeMCPManager],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_team_backend import native_mcp

    home = tmp_path / "native-home"
    (home / ".codex").mkdir(parents=True)
    (home / ".codex" / "config.toml").write_text(
        '[mcp_servers.xmind]\nurl = "https://app.xmind.com/mcp"\n', encoding="utf-8"
    )
    monkeypatch.setattr(native_mcp, "_home", lambda: home)

    listed = await _request(_session(), "mcp.list_servers")

    native = listed["payload"]["native"]
    assert [(entry["agent"], entry["name"]) for entry in native] == [("codex", "xmind")]
    # Navide's own servers stay a separate list; reflection never merges in.
    assert "xmind" not in {entry["name"] for entry in listed["payload"]["servers"]}
