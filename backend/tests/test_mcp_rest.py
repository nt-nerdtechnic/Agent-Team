"""REST MCP settings revision, validation, and conflict contracts."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from agent_team_backend import app
from agent_team_backend.mcp_settings import MCPSettingsStore


class FakeMCPManager:
    def __init__(self) -> None:
        self.reloads: list[Path] = []

    async def reload(self, path: Path) -> None:
        self.reloads.append(path)


@pytest.fixture
def rest_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[MCPSettingsStore, FakeMCPManager]:
    store = MCPSettingsStore(tmp_path / "mcp_servers.json")
    manager = FakeMCPManager()
    monkeypatch.setattr(app, "mcp_settings_store", store)
    monkeypatch.setattr(app, "mcp_manager", manager)
    return store, manager


@pytest.mark.asyncio
async def test_rest_list_returns_revision_and_preserves_invalid_file(
    rest_store: tuple[MCPSettingsStore, FakeMCPManager],
) -> None:
    store, _manager = rest_store
    listed = await app.list_mcp_servers()

    assert listed["path"] == str(store.path)
    assert listed["revision"] == str(store.revision)
    assert listed["servers"][0]["transport"] == "stdio"

    invalid_content = "{not valid json"
    store.path.write_text(invalid_content, encoding="utf-8")
    with pytest.raises(HTTPException) as raised:
        await app.list_mcp_servers()

    assert raised.value.status_code == 409
    assert raised.value.detail["code"] == "MCP_SETTINGS_INVALID"
    assert raised.value.detail["details"] == {"path": str(store.path)}
    assert store.path.read_text(encoding="utf-8") == invalid_content


@pytest.mark.asyncio
async def test_rest_replace_requires_revision_and_maps_validation_and_conflict(
    rest_store: tuple[MCPSettingsStore, FakeMCPManager],
) -> None:
    store, manager = rest_store
    store.list_servers()

    with pytest.raises(HTTPException) as missing:
        await app.replace_mcp_servers(
            {"servers": [{"name": "ctx", "transport": "stdio", "command": "node"}]}
        )
    assert missing.value.status_code == 428
    assert missing.value.detail["code"] == "MCP_REVISION_REQUIRED"

    with pytest.raises(HTTPException) as invalid:
        await app.replace_mcp_servers(
            {
                "servers": [{"name": "remote", "transport": "http"}],
                "expected_revision": str(store.revision),
            }
        )
    assert invalid.value.status_code == 422
    assert invalid.value.detail["code"] == "MCP_VALIDATION_ERROR"

    saved = await app.replace_mcp_servers(
        {
            "servers": [
                {
                    "name": "remote",
                    "transport": "http",
                    "url": "https://example.test/mcp",
                }
            ],
            "expected_revision": str(store.revision),
        }
    )
    assert saved["ok"] is True
    assert saved["revision"] == str(store.revision)
    assert manager.reloads == [store.path]

    stale_revision = store.revision
    external: list[dict[str, Any]] = [
        {"name": "external", "transport": "stdio", "command": "echo"}
    ]
    store.path.write_text(json.dumps(external), encoding="utf-8")
    os.utime(store.path, ns=(stale_revision + 10_000, stale_revision + 10_000))
    with pytest.raises(HTTPException) as conflict:
        await app.replace_mcp_servers(
            {
                "servers": [
                    {"name": "mine", "transport": "stdio", "command": "python"}
                ],
                "expected_revision": str(stale_revision),
            }
        )

    assert conflict.value.status_code == 409
    assert conflict.value.detail["code"] == "MCP_SETTINGS_CONFLICT"
    assert conflict.value.detail["details"] == {
        "expected_revision": str(stale_revision),
        "actual_revision": str(store.revision),
        "path": str(store.path),
    }
    assert json.loads(store.path.read_text(encoding="utf-8")) == external
    assert manager.reloads == [store.path]


@pytest.mark.asyncio
async def test_rest_reset_requires_revision_and_returns_new_revision(
    rest_store: tuple[MCPSettingsStore, FakeMCPManager],
) -> None:
    store, manager = rest_store
    store.replace_servers(
        [{"name": "custom", "transport": "stdio", "command": "node"}]
    )

    with pytest.raises(HTTPException) as missing:
        await app.reset_mcp_servers()
    assert missing.value.status_code == 428
    assert missing.value.detail["code"] == "MCP_REVISION_REQUIRED"

    reset = await app.reset_mcp_servers(
        {"expected_revision": str(store.revision)}
    )

    assert reset["ok"] is True
    assert reset["servers"][0]["name"] == "context7"
    assert reset["revision"] == str(store.revision)
    assert manager.reloads == [store.path]
