"""Wire pane CLI agents (claude / codex) to the Plan MCP endpoint.

The backend serves a Plan MCP server at ``/plan-mcp`` (see plan_mcp.py) on a
dynamic port picked fresh each launch, so nothing static can point at it.
Merge-writing user-owned config files was rejected as clobber-prone:
``~/.claude.json`` is rewritten wholesale by a running claude CLI (a
read-modify-write from us can lose its update, and vice versa) and
``~/.codex/config.toml`` is user-global and shared into every per-pane
CODEX_HOME via symlink. Instead, terminal.create appends CLI-native,
additive spawn-time flags — no user config file is ever modified:

- claude: ``--mcp-config <app_data_dir>/plan-mcp.json``. Servers from
  ``--mcp-config`` load IN ADDITION to the user's own MCP config (we never
  pass ``--strict-mcp-config``). The JSON file lives in the app's own data
  dir and is rewritten on every backend startup so its URL always carries
  the current port.
- codex: ``-c mcp_servers.navide-plans.url="http://127.0.0.1:<port>/plan-mcp"``
  — a one-shot TOML override merged over config.toml at process start
  (``-c`` is a global flag, valid after subcommands like ``codex resume``).

The port is read from the discovery file written by __main__ before uvicorn
starts (same mechanism the Claude hooks use). File absent → wiring no-ops,
so a spawn is never broken over MCP wiring.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
from pathlib import Path
from typing import Any

from agent_team_backend.applog import app_data_dir, backend_port_file

log = logging.getLogger("agent_team_backend.plugins.builtin.navide_plans.plan_mcp_wiring")

SERVER_NAME = "navide-plans"
CLAUDE_CONFIG_FILENAME = "plan-mcp.json"


def plan_mcp_url(port: int) -> str:
    return f"http://127.0.0.1:{port}/plan-mcp"


def claude_config_path() -> Path:
    """App-owned MCP config file handed to claude panes via --mcp-config."""
    return app_data_dir() / CLAUDE_CONFIG_FILENAME


def backend_port() -> int | None:
    """Current backend port from the discovery file (absent/invalid → None)."""
    try:
        text = backend_port_file().read_text(encoding="utf-8").strip()
        return int(text) if text else None
    except (OSError, ValueError):
        return None


def write_claude_config(port: int, path: Path | None = None) -> Path:
    """Write the claude ``--mcp-config`` file pointing at ``port``.

    The file is wholly app-owned (it contains only the navide-plans entry;
    the user's own MCP config is a separate surface we never touch), so this
    is a plain idempotent rewrite: unchanged content is left alone, a stale
    port from a previous run is overwritten. Atomic via os.replace.
    """
    path = path or claude_config_path()
    payload = {
        "mcpServers": {SERVER_NAME: {"type": "http", "url": plan_mcp_url(port)}}
    }
    content = json.dumps(payload, indent=2) + "\n"
    try:
        if path.read_text(encoding="utf-8") == content:
            return path
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise
    return path


def _command_text(command: Any) -> str:
    """Real CLI command string from a terminal.create payload command.

    The frontend wraps agent commands as ``[shell, '-ilc'|'-lc', '<cmd>']`` —
    the real command is the LAST element. Plain strings pass through.
    (Local copy of app._command_text; importing app here would be circular.)
    """
    if isinstance(command, list):
        return str(command[-1]) if command else ""
    return str(command or "")


def _append_to_command(command: Any, suffix: str) -> Any:
    """Append ``suffix`` to the real command, preserving the shell wrapper."""
    if isinstance(command, list):
        updated = list(command)
        updated[-1] = f"{updated[-1]} {suffix}"
        return updated
    return f"{command} {suffix}"


def wire_command(
    agent_key: str,
    command: Any,
    port: int | None,
    claude_config: Path | None = None,
) -> Any:
    """Append Plan-MCP wiring flags to a pane spawn command.

    No-op for non-claude/codex agents, unknown port, empty commands,
    already-wired commands, a user-supplied ``--mcp-config`` (respect their
    deliberate MCP setup, esp. with --strict-mcp-config), or (claude) a
    missing config file — a spawn must never break over MCP wiring.
    """
    if port is None:
        return command
    text = _command_text(command)
    if not text.strip():
        return command
    if agent_key == "claude":
        if "--mcp-config" in text:
            return command
        config = claude_config or claude_config_path()
        if not config.is_file():
            return command
        return _append_to_command(command, f"--mcp-config {shlex.quote(str(config))}")
    if agent_key == "codex":
        if f"mcp_servers.{SERVER_NAME}" in text:
            return command
        override = f'mcp_servers.{SERVER_NAME}.url="{plan_mcp_url(port)}"'
        return _append_to_command(command, f"-c {shlex.quote(override)}")
    return command
