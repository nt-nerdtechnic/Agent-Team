"""MCP settings store validation and persistence tests."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from pydantic import ValidationError

from agent_team_backend.mcp_settings import (
    MCPServersDocument,
    MCPSettingsConflictError,
    MCPSettingsError,
    MCPSettingsStore,
    REDACTED_SECRET,
    is_secret_setting_name,
    redact_mcp_server_secrets,
    restore_mcp_server_secrets,
)


def test_store_creates_default_config(tmp_path: Path) -> None:
    path = tmp_path / "mcp_servers.json"
    store = MCPSettingsStore(path)

    servers = store.list_servers()

    assert path.exists()
    assert servers[0]["name"] == "context7"
    assert servers[0]["transport"] == "stdio"
    assert servers[0]["enabled"] is True
    assert store.revision > 0


def test_replace_servers_validates_and_persists_atomically(tmp_path: Path) -> None:
    path = tmp_path / "mcp_servers.json"
    store = MCPSettingsStore(path)

    servers = store.replace_servers(
        [
            {
                "name": "docs",
                "command": "npx",
                "args": ["--path", "/My Docs", '--label="two words"'],
                "env": {"API_TOKEN": "secret"},
                "enabled": False,
            }
        ]
    )

    assert servers == [
        {
            "name": "docs",
            "enabled": False,
            "transport": "stdio",
            "command": "npx",
            "args": ["--path", "/My Docs", '--label="two words"'],
            "env": {"API_TOKEN": "secret"},
        }
    ]
    assert json.loads(path.read_text(encoding="utf-8")) == servers
    assert not path.with_suffix(".json.tmp").exists()


def test_legacy_file_migrates_before_validation_without_data_loss(tmp_path: Path) -> None:
    path = tmp_path / "mcp_servers.json"
    legacy = [
        {
            "name": "docs",
            "command": "node",
            "args": ["server.js", "two words"],
            "env": {"DOCS_TOKEN": "secret"},
            "enabled": False,
        }
    ]
    path.write_text(json.dumps(legacy), encoding="utf-8")

    servers = MCPSettingsStore(path).list_servers()

    assert servers[0] == {**legacy[0], "transport": "stdio"}
    assert json.loads(path.read_text(encoding="utf-8")) == servers


def test_document_accepts_legacy_payload_for_existing_api_callers() -> None:
    document = MCPServersDocument(servers=[{"name": "ctx", "command": "npx"}])
    assert document.servers[0].transport == "stdio"


def test_discriminated_union_accepts_http_and_sse() -> None:
    document = MCPServersDocument(
        servers=[
            {
                "name": "remote",
                "transport": "http",
                "url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer token"},
            },
            {
                "name": "events",
                "transport": "sse",
                "url": "http://127.0.0.1:9000/sse",
            },
        ]
    )
    assert [server.transport for server in document.servers] == ["http", "sse"]


@pytest.mark.parametrize(
    "server",
    [
        {"name": "ctx", "transport": "stdio", "url": "https://example.test"},
        {"name": "ctx", "transport": "http", "command": "npx", "url": "https://example.test"},
        {"name": "ctx", "transport": "sse"},
        {"name": "ctx", "transport": "http", "url": "file:///tmp/socket"},
        {"name": "ctx", "transport": "stdio", "command": "   "},
        {"name": "ctx", "transport": "http", "url": "   "},
    ],
)
def test_transport_specific_invalid_shapes_are_rejected(server: dict) -> None:
    with pytest.raises(ValidationError):
        MCPServersDocument(servers=[server])


def test_duplicate_server_names_are_rejected_across_transports() -> None:
    with pytest.raises(ValidationError, match="server names must be unique"):
        MCPServersDocument(
            servers=[
                {"name": "ctx", "transport": "stdio", "command": "npx"},
                {"name": "ctx", "transport": "http", "url": "https://example.test"},
            ]
        )


def test_invalid_env_and_header_names_are_rejected() -> None:
    with pytest.raises(ValidationError, match="invalid env key"):
        MCPServersDocument(
            servers=[
                {
                    "name": "ctx",
                    "transport": "stdio",
                    "command": "npx",
                    "env": {"BAD-KEY": "value"},
                }
            ]
        )
    with pytest.raises(ValidationError, match="invalid header name"):
        MCPServersDocument(
            servers=[
                {
                    "name": "ctx",
                    "transport": "http",
                    "url": "https://example.test",
                    "headers": {"Bad Header": "value"},
                }
            ]
        )


@pytest.mark.parametrize(
    "content",
    [
        "{not valid json",
        json.dumps([{"name": "bad", "transport": "http"}]),
        "x" * 1_000_001,
    ],
)
def test_invalid_corrupt_or_oversized_file_is_never_overwritten(
    tmp_path: Path, content: str
) -> None:
    path = tmp_path / "mcp_servers.json"
    path.write_text(content, encoding="utf-8")

    with pytest.raises(MCPSettingsError):
        MCPSettingsStore(path).list_servers()

    assert path.read_text(encoding="utf-8") == content


def test_stale_revision_rejects_write_without_mutation(tmp_path: Path) -> None:
    path = tmp_path / "mcp_servers.json"
    store = MCPSettingsStore(path)
    store.list_servers()
    stale_revision = store.revision
    external = [{"name": "external", "transport": "stdio", "command": "echo"}]
    path.write_text(json.dumps(external), encoding="utf-8")
    os.utime(path, ns=(stale_revision + 10_000, stale_revision + 10_000))
    before = path.read_bytes()

    with pytest.raises(MCPSettingsConflictError) as raised:
        store.replace_servers(
            [{"name": "mine", "transport": "stdio", "command": "node"}],
            expected_revision=stale_revision,
        )

    assert raised.value.actual_revision == store.revision
    assert path.read_bytes() == before


def test_matching_revision_allows_write(tmp_path: Path) -> None:
    store = MCPSettingsStore(tmp_path / "mcp_servers.json")
    store.list_servers()
    revision = store.revision

    servers = store.replace_servers(
        [{"name": "mine", "transport": "stdio", "command": "node"}],
        expected_revision=revision,
    )

    assert servers[0]["name"] == "mine"
    assert store.revision != revision


def test_secret_helpers_cover_env_and_headers_without_mutating_inputs() -> None:
    servers = [
        {
            "name": "local",
            "transport": "stdio",
            "command": "node",
            "env": {
                "API_TOKEN": "env-secret",
                "PRIVATE_KEY": "private-secret",
                "LOG_LEVEL": "debug",
            },
        },
        {
            "name": "remote",
            "transport": "http",
            "url": "https://example.test",
            "headers": {
                "Authorization": "Bearer secret",
                "X-Api-Key": "header-secret",
                "Accept": "application/json",
            },
        },
    ]

    redacted = redact_mcp_server_secrets(servers)

    assert redacted[0]["env"] == {
        "API_TOKEN": REDACTED_SECRET,
        "PRIVATE_KEY": REDACTED_SECRET,
        "LOG_LEVEL": "debug",
    }
    assert redacted[1]["headers"] == {
        "Authorization": REDACTED_SECRET,
        "X-Api-Key": REDACTED_SECRET,
        "Accept": "application/json",
    }
    assert servers[0]["env"]["API_TOKEN"] == "env-secret"
    assert servers[1]["headers"]["Authorization"] == "Bearer secret"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Auth", True),
        ("Authorization", True),
        ("Set-Cookie", True),
        ("clientCredential", True),
        ("clientCredentials", True),
        ("PRIVATE_KEY", True),
        ("X-Key", True),
        ("APIKey", True),
        ("API_KEY", True),
        ("GITHUB_TOKEN", True),
        ("CLIENT_SECRET", True),
        ("DB_PASSWORD", True),
        ("SSH_PASSWD", True),
        ("SSH_PASSPHRASE", True),
        ("LOG_LEVEL", False),
        ("MONKEY", False),
    ],
)
def test_secret_name_predicate_uses_canonical_tokens(name: str, expected: bool) -> None:
    assert is_secret_setting_name(name) is expected


def test_restore_secrets_uses_matching_local_values_and_drops_unknown_sentinels() -> None:
    imported = [
        {
            "name": "remote",
            "transport": "http",
            "url": "https://example.test",
            "headers": {
                "Authorization": REDACTED_SECRET,
                "X-New-Token": REDACTED_SECRET,
                "Accept": REDACTED_SECRET,
            },
        }
    ]
    existing = [
        {
            "name": "remote",
            "transport": "http",
            "url": "https://old.test",
            "headers": {"Authorization": "Bearer local"},
        }
    ]

    restored = restore_mcp_server_secrets(imported, existing)

    assert restored[0]["headers"] == {
        "Authorization": "Bearer local",
        "Accept": REDACTED_SECRET,
    }
    assert imported[0]["headers"]["Authorization"] == REDACTED_SECRET
