"""Tests for mcp_manager — config loading and MCPManager lifecycle.

Real MCP subprocess connections are tested with a mock stdio pair so
no npx/network is required for the unit test suite.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_team_backend.mcp_manager import (
    MCPClient,
    MCPManager,
    MCPServerConfig,
    _default_config,
    load_mcp_config,
)


# ── load_mcp_config ───────────────────────────────────────────────────────────

class TestLoadMcpConfig:
    def test_creates_default_file_when_missing(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        result = load_mcp_config(cfg_path)
        assert cfg_path.exists(), "Config file should be created on first load"
        assert len(result) >= 1
        assert result[0].name == "context7"

    def test_reads_existing_file(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "myserver", "command": "echo", "args": ["hello"], "env": {}, "enabled": True}
        ]))
        result = load_mcp_config(cfg_path)
        assert len(result) == 1
        assert result[0].name == "myserver"
        assert result[0].command == "echo"

    def test_disabled_servers_filtered_out(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "active", "command": "npx", "args": [], "env": {}, "enabled": True},
            {"name": "inactive", "command": "npx", "args": [], "env": {}, "enabled": False},
        ]))
        result = load_mcp_config(cfg_path)
        assert len(result) == 1
        assert result[0].name == "active"

    def test_corrupt_json_is_preserved_and_loads_no_servers(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        content = "NOT VALID JSON {{{{"
        cfg_path.write_text(content)
        result = load_mcp_config(cfg_path)
        assert result == []
        assert cfg_path.read_text() == content

    def test_reads_remote_transports(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {
                "name": "remote",
                "transport": "http",
                "url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer token"},
            },
            {
                "name": "events",
                "transport": "sse",
                "url": "https://example.test/sse",
            },
        ]))

        result = load_mcp_config(cfg_path)

        assert [(item.name, item.transport) for item in result] == [
            ("remote", "http"),
            ("events", "sse"),
        ]
        assert result[0].headers == {"Authorization": "Bearer token"}

    def test_default_config_has_context7(self):
        defaults = _default_config()
        names = [d["name"] for d in defaults]
        assert "context7" in names

    def test_context7_uses_npx(self):
        defaults = _default_config()
        ctx7 = next(d for d in defaults if d["name"] == "context7")
        assert ctx7["command"] == "npx"
        assert "@upstash/context7-mcp" in ctx7["args"]


# ── MCPServerConfig ───────────────────────────────────────────────────────────

class TestMCPServerConfig:
    def test_defaults(self):
        cfg = MCPServerConfig(name="test", command="echo")
        assert cfg.args == []
        assert cfg.env == {}
        assert cfg.enabled is True
        assert cfg.transport == "stdio"
        assert cfg.url == ""
        assert cfg.headers == {}


# ── MCPClient ─────────────────────────────────────────────────────────────────

class TestMCPClient:
    def _make_client(self, name="test"):
        cfg = MCPServerConfig(name=name, command="npx", args=["-y", "@upstash/context7-mcp"])
        return MCPClient(cfg)

    def test_initial_state(self):
        client = self._make_client()
        assert client.ready is False
        assert client.name == "test"

    @pytest.mark.asyncio
    async def test_call_tool_raises_when_not_ready(self):
        client = self._make_client()
        with pytest.raises(RuntimeError, match="not ready"):
            await client.call_tool("some-tool", {})

    @pytest.mark.asyncio
    async def test_start_sets_ready_on_success(self):
        client = self._make_client()

        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()

        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)

        mock_stdio_cm = AsyncMock()
        mock_stdio_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        mock_stdio_cm.__aexit__ = AsyncMock(return_value=None)

        # Patch at module level (imports are now at top of mcp_manager.py)
        with patch("agent_team_backend.mcp_manager.stdio_client", return_value=mock_stdio_cm), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm), \
             patch("agent_team_backend.mcp_manager.StdioServerParameters", return_value=MagicMock()), \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        assert client.ready is True

    @pytest.mark.asyncio
    async def test_stdio_passes_argv_and_merged_environment(self):
        cfg = MCPServerConfig(
            name="stdio",
            command="node",
            args=["--path", "/My Docs", '--label="two words"'],
            env={"MCP_TEST_TOKEN": "secret"},
        )
        client = MCPClient(cfg)
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_transport_cm = AsyncMock()
        mock_transport_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        server_params = MagicMock()

        with patch("agent_team_backend.mcp_manager.stdio_client", return_value=mock_transport_cm), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm), \
             patch(
                 "agent_team_backend.mcp_manager.StdioServerParameters",
                 return_value=server_params,
             ) as make_params, \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        make_params.assert_called_once()
        call = make_params.call_args.kwargs
        assert call["command"] == "node"
        assert call["args"] == ["--path", "/My Docs", '--label="two words"']
        assert call["env"]["MCP_TEST_TOKEN"] == "secret"

    @pytest.mark.asyncio
    async def test_streamable_http_uses_headers_and_ignores_session_id_callback(self):
        cfg = MCPServerConfig(
            name="remote",
            transport="http",
            url="https://example.test/mcp",
            headers={"Authorization": "Bearer token"},
        )
        client = MCPClient(cfg)
        read, write, get_session_id = AsyncMock(), AsyncMock(), MagicMock()
        mock_transport_cm = AsyncMock()
        mock_transport_cm.__aenter__ = AsyncMock(
            return_value=(read, write, get_session_id)
        )
        mock_transport_cm.__aexit__ = AsyncMock(return_value=None)
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)

        with patch(
            "agent_team_backend.mcp_manager.streamablehttp_client",
            return_value=mock_transport_cm,
        ) as make_transport, patch(
            "agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm
        ) as make_session, patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()
            await client.stop()

        make_transport.assert_called_once_with(
            "https://example.test/mcp",
            headers={"Authorization": "Bearer token"},
        )
        make_session.assert_called_once_with(read, write)
        mock_session_cm.__aexit__.assert_awaited_once_with(None, None, None)
        mock_transport_cm.__aexit__.assert_awaited_once_with(None, None, None)

    @pytest.mark.asyncio
    async def test_sse_uses_two_streams_and_headers(self):
        cfg = MCPServerConfig(
            name="events",
            transport="sse",
            url="https://example.test/sse",
            headers={"X-Api-Key": "secret"},
        )
        client = MCPClient(cfg)
        read, write = AsyncMock(), AsyncMock()
        mock_transport_cm = AsyncMock()
        mock_transport_cm.__aenter__ = AsyncMock(return_value=(read, write))
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)

        with patch(
            "agent_team_backend.mcp_manager.sse_client",
            return_value=mock_transport_cm,
        ) as make_transport, patch(
            "agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm
        ) as make_session, patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        assert client.ready is True
        make_transport.assert_called_once_with(
            "https://example.test/sse", headers={"X-Api-Key": "secret"}
        )
        make_session.assert_called_once_with(read, write)

    @pytest.mark.asyncio
    async def test_start_sets_not_ready_on_failure(self):
        client = self._make_client()

        with patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True), \
             patch("agent_team_backend.mcp_manager.stdio_client", side_effect=OSError("npx not found")):
            await client.start()

        assert client.ready is False

    @pytest.mark.asyncio
    async def test_initialize_cancellation_exits_session_and_transport_then_reraises(self):
        client = self._make_client()
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock(side_effect=asyncio.CancelledError)
        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)
        mock_transport_cm = AsyncMock()
        mock_transport_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        mock_transport_cm.__aexit__ = AsyncMock(return_value=None)

        with patch(
            "agent_team_backend.mcp_manager.stdio_client",
            return_value=mock_transport_cm,
        ), patch(
            "agent_team_backend.mcp_manager.ClientSession",
            return_value=mock_session_cm,
        ), patch(
            "agent_team_backend.mcp_manager.StdioServerParameters",
            return_value=MagicMock(),
        ), patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            with pytest.raises(asyncio.CancelledError):
                await client.start()

        mock_session_cm.__aexit__.assert_awaited_once_with(None, None, None)
        mock_transport_cm.__aexit__.assert_awaited_once_with(None, None, None)
        assert client.ready is False

    @pytest.mark.asyncio
    async def test_call_tool_delegates_to_session(self):
        client = self._make_client()

        fake_result = MagicMock()
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session.call_tool = AsyncMock(return_value=fake_result)

        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)

        mock_stdio_cm = AsyncMock()
        mock_stdio_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        mock_stdio_cm.__aexit__ = AsyncMock(return_value=None)

        with patch("agent_team_backend.mcp_manager.stdio_client", return_value=mock_stdio_cm), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm), \
             patch("agent_team_backend.mcp_manager.StdioServerParameters", return_value=MagicMock()), \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        result = await client.call_tool("resolve-library-id", {"query": "test", "libraryName": "WordPress"})
        assert result is fake_result
        mock_session.call_tool.assert_awaited_once_with(
            "resolve-library-id", {"query": "test", "libraryName": "WordPress"}
        )

    @pytest.mark.asyncio
    async def test_stop_sets_not_ready(self):
        client = self._make_client()

        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()

        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)

        mock_stdio_cm = AsyncMock()
        mock_stdio_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        mock_stdio_cm.__aexit__ = AsyncMock(return_value=None)

        with patch("agent_team_backend.mcp_manager.stdio_client", return_value=mock_stdio_cm), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm), \
             patch("agent_team_backend.mcp_manager.StdioServerParameters", return_value=MagicMock()), \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        assert client.ready is True
        await client.stop()
        assert client.ready is False


# ── MCPManager ────────────────────────────────────────────────────────────────

class TestMCPManager:
    @pytest.mark.asyncio
    async def test_startup_connects_enabled_servers(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "s1", "command": "echo", "args": [], "env": {}, "enabled": True},
            {"name": "s2", "command": "echo", "args": [], "env": {}, "enabled": False},
        ]))

        manager = MCPManager()

        with patch.object(MCPClient, "start", new_callable=AsyncMock) as mock_start:
            await manager.startup(cfg_path)

        # Only enabled server should be added
        assert "s1" in manager._clients
        assert "s2" not in manager._clients

    @pytest.mark.asyncio
    async def test_get_returns_client(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "ctx", "command": "echo", "args": [], "env": {}, "enabled": True},
        ]))

        manager = MCPManager()
        with patch.object(MCPClient, "start", new_callable=AsyncMock):
            await manager.startup(cfg_path)

        client = manager.get("ctx")
        assert client is not None
        assert manager.get("nonexistent") is None

    @pytest.mark.asyncio
    async def test_call_tool_raises_for_unknown_server(self):
        manager = MCPManager()
        with pytest.raises(KeyError, match="unknown"):
            await manager.call_tool("unknown", "some-tool", {})

    @pytest.mark.asyncio
    async def test_shutdown_clears_clients(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "s1", "command": "echo", "args": [], "env": {}, "enabled": True},
        ]))

        manager = MCPManager()
        with patch.object(MCPClient, "start", new_callable=AsyncMock), \
             patch.object(MCPClient, "stop", new_callable=AsyncMock):
            await manager.startup(cfg_path)
            assert len(manager._clients) == 1
            await manager.shutdown()
            assert len(manager._clients) == 0
