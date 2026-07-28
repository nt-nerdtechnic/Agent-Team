"""Generic MCP (Model Context Protocol) client manager.

Manages persistent connections to one or more MCP servers.
Config lives at app_data_dir() / "mcp_servers.json" — written with defaults
on first launch so users can customise without touching source code.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .mcp_settings import MCPSettingsStore, default_mcp_servers

log = logging.getLogger("agent_team_backend.mcp_manager")

try:
    from mcp import ClientSession
    from mcp.client.sse import sse_client
    from mcp.client.stdio import StdioServerParameters, stdio_client
    from mcp.client.streamable_http import streamablehttp_client
    _MCP_AVAILABLE = True
except ImportError:
    _MCP_AVAILABLE = False
    ClientSession = None  # type: ignore[assignment,misc]
    StdioServerParameters = None  # type: ignore[assignment,misc]
    sse_client = None  # type: ignore[assignment]
    stdio_client = None  # type: ignore[assignment]
    streamablehttp_client = None  # type: ignore[assignment]

_CALL_TIMEOUT = 30.0  # seconds per tool call


# ── Config ────────────────────────────────────────────────────────────────────

@dataclass
class MCPServerConfig:
    name: str
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    transport: str = "stdio"
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)


def _default_config() -> list[dict[str, Any]]:
    return default_mcp_servers()


def load_mcp_config(path: Path | None = None) -> list[MCPServerConfig]:
    try:
        raw = MCPSettingsStore(path).list_enabled()
    except ValueError as err:
        log.warning("MCP config not loaded: %s", err)
        return []
    return [MCPServerConfig(**item) for item in raw]


# ── Single server client ───────────────────────────────────────────────────────

class MCPClient:
    """Persistent connection to one MCP server."""

    def __init__(self, config: MCPServerConfig) -> None:
        self.name = config.name
        self._config = config
        self._session: Any = None
        self._transport_cm: Any = None
        self._session_cm: Any = None
        self._lock = asyncio.Lock()
        self.ready = False

    async def start(self) -> None:
        """Connect to the MCP server and perform the MCP handshake."""
        if not _MCP_AVAILABLE:
            log.warning("MCP '%s' skipped — mcp package not installed", self.name)
            return
        try:
            if self._config.transport == "stdio":
                final_env = os.environ.copy()
                final_env.update(self._config.env)
                server_params = StdioServerParameters(
                    command=self._config.command,
                    args=self._config.args,
                    env=final_env,
                )
                transport_cm = stdio_client(server_params)
            elif self._config.transport == "http":
                transport_cm = streamablehttp_client(
                    self._config.url,
                    headers=self._config.headers or None,
                )
            elif self._config.transport == "sse":
                transport_cm = sse_client(
                    self._config.url,
                    headers=self._config.headers or None,
                )
            else:
                raise ValueError(f"unsupported MCP transport: {self._config.transport}")
            streams = await transport_cm.__aenter__()
            self._transport_cm = transport_cm
            # mcp>=1.27 streamable HTTP yields (read, write, get_session_id),
            # while stdio and SSE yield only (read, write).
            read, write = streams[:2]
            session_cm = ClientSession(read, write)
            self._session = await session_cm.__aenter__()
            self._session_cm = session_cm
            await asyncio.wait_for(self._session.initialize(), timeout=15.0)
            self.ready = True
            log.info("MCP '%s' connected", self.name)
        except asyncio.CancelledError:
            await self.stop()
            raise
        except Exception as err:  # noqa: BLE001
            log.warning("MCP '%s' failed to start: %s", self.name, err)
            self.ready = False
            await self.stop()  # ensure spawned subprocess is cleaned up

    async def stop(self) -> None:
        """Tear down the session and its underlying transport."""
        for cm in (self._session_cm, self._transport_cm):
            if cm is not None:
                try:
                    await cm.__aexit__(None, None, None)
                except (Exception, asyncio.CancelledError):  # noqa: BLE001
                    pass
        self._session = None
        self._session_cm = None
        self._transport_cm = None
        self.ready = False
        log.info("MCP '%s' stopped", self.name)

    async def list_tools(self) -> list[dict[str, str]]:
        """Return the tools exposed by this server (best-effort, empty on failure)."""
        if not self.ready or self._session is None:
            return []
        try:
            result = await asyncio.wait_for(self._session.list_tools(), timeout=10.0)
            return [
                {"name": t.name, "description": t.description or ""}
                for t in result.tools
            ]
        except Exception:  # noqa: BLE001
            return []

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        if not self.ready or self._session is None:
            raise RuntimeError(f"MCP '{self.name}' not ready")
        async with self._lock:
            return await asyncio.wait_for(
                self._session.call_tool(tool_name, arguments),
                timeout=_CALL_TIMEOUT,
            )


# ── Multi-server manager ───────────────────────────────────────────────────────

class MCPManager:
    """Lifecycle manager for all configured MCP servers."""

    def __init__(self) -> None:
        self._clients: dict[str, MCPClient] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._config_path: Path | None = None

    async def startup(self, config_path: Path | None = None) -> None:
        async with self._lifecycle_lock:
            self._config_path = config_path
            await self._shutdown_unlocked()
            configs = load_mcp_config(config_path)
            for cfg in configs:
                client = MCPClient(cfg)
                await client.start()
                self._clients[cfg.name] = client
            log.info("MCPManager: %d server(s) initialised", len(self._clients))

    async def shutdown(self) -> None:
        async with self._lifecycle_lock:
            await self._shutdown_unlocked()

    async def reload(self, config_path: Path | None = None) -> None:
        await self.startup(config_path or self._config_path)

    async def _shutdown_unlocked(self) -> None:
        for client in self._clients.values():
            await client.stop()
        self._clients.clear()

    def get(self, name: str) -> MCPClient | None:
        return self._clients.get(name)

    async def list_status(self) -> list[dict[str, Any]]:
        """Return live status + tool info for every running client."""
        result = []
        for name, client in self._clients.items():
            tools = await client.list_tools()
            result.append({
                "name": name,
                "status": "connected" if client.ready else "error",
                "tool_count": len(tools),
                "tools": tools,
            })
        return result

    async def call_tool(self, server: str, tool: str, arguments: dict[str, Any]) -> Any:
        client = self.get(server)
        if client is None:
            raise KeyError(f"No MCP server named '{server}'")
        return await client.call_tool(tool, arguments)
