"""Wire pane CLI agents to the Plan MCP endpoint.

The backend serves a Plan MCP server at ``/plan-mcp`` (see plan_mcp.py) on a
dynamic port picked fresh each launch, so nothing static can point at it.
Merge-writing user-owned config files was rejected as clobber-prone:
``~/.claude.json`` is rewritten wholesale by a running claude CLI (a
read-modify-write from us can lose its update, and vice versa) and
``~/.codex/config.toml`` is user-global and shared into every per-pane
CODEX_HOME via symlink. Instead, terminal.create appends CLI-native,
additive spawn-time flags — no user config file is ever modified:

- claude: ``--mcp-config <inline JSON>``. The flag takes a literal JSON string
  as well as a path, and inline is what a spawn actually uses: the URL carries
  the pane id (see plan_mcp_url), so a file-based config would mean one file
  per pane left behind in the app data dir. Servers from ``--mcp-config`` load
  IN ADDITION to the user's own MCP config (we never pass
  ``--strict-mcp-config``). The written ``<app_data_dir>/plan-mcp.json`` remains
  as the fallback for a spawn with no pane id.
- codex: ``-c mcp_servers.navide-plans.url="http://127.0.0.1:<port>/plan-mcp"``
  — a one-shot TOML override merged over config.toml at process start
  (``-c`` is a global flag, valid after subcommands like ``codex resume``).
- copilot: ``--additional-mcp-config <inline JSON>``, same ``{"mcpServers":
  {...}}`` shape claude takes. The flag is documented as augmenting
  ``~/.copilot/mcp-config.json`` for the session and may be repeated, so unlike
  claude there is nothing to step aside for — a user's own servers keep
  loading alongside ours, and ``--disable-mcp-server navide-plans`` is their
  opt-out.
- opencode / kilo: no MCP flag at all, but both read an entire config document
  out of ``OPENCODE_CONFIG_CONTENT`` / ``KILO_CONFIG_CONTENT`` and deep-merge
  it over the user's files, so the spawn env carries the wiring instead. A
  value already present in the spawn env is left alone. Note this reaches only
  variables Navide itself set — one exported from the user's shell profile is
  inherited by the CLI process and would be overwritten.

Deliberately not wired this way: the CLIs whose only MCP surface is a config
file under a home directory (kimi, grok, qwen, antigravity). Their home
variable relocates credentials and sessions along with the config, so pointing
it at a Navide-owned directory logs the user out; doing it safely needs a
symlink shim of the real home, which is a much larger change than this module.

The port is read from the discovery file written by __main__ before uvicorn
starts (same mechanism the Claude hooks use). File absent → wiring no-ops,
so a spawn is never broken over MCP wiring.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import shlex
from pathlib import Path
from typing import Any
from urllib.parse import quote

from agent_team_backend.applog import app_data_dir, backend_port_file
from agent_team_backend.plugins.builtin.navide_plans import plan_mcp_auth

log = logging.getLogger("agent_team_backend.plugins.builtin.navide_plans.plan_mcp_wiring")

SERVER_NAME = "navide-plans"
CLAUDE_CONFIG_FILENAME = "plan-mcp.json"

# CLIs that read a whole config document out of an environment variable. Both
# deep-merge it over the user's own files, so this adds our server without
# displacing theirs — no config file is written, and the value dies with the
# pane. kilo is an opencode fork and takes the identical document.
INLINE_CONFIG_ENV_VARS = {
    "opencode": "OPENCODE_CONFIG_CONTENT",
    "kilo": "KILO_CONFIG_CONTENT",
}

# Minted at import, not on first use: spawn wiring runs in worker threads and
# concurrent pane restores would otherwise race to initialise it, burning a
# token into one pane's command line that a later winner immediately replaces.
_CALLER_TOKEN = secrets.token_urlsafe(24)


def plan_mcp_url(port: int, pane_id: str = "") -> str:
    """Endpoint URL, identifying the pane the CLI runs in when known.

    The endpoint requires a credential on every call (see
    plan_mcp._resolve_caller): with a pane id, the pane credential rides in
    the query string so a tool that acts *as* the calling pane (cli_send) can
    tell who is asking. Without one — the fallback claude config and any
    wired command spawned before a pane id was known — this backend's own
    host credential rides instead, so its own CLI wiring is never mistaken
    for an external caller.
    """
    base = f"http://127.0.0.1:{port}/plan-mcp"
    if pane_id:
        return f"{base}?pane={quote(pane_id, safe='')}&t={quote(caller_token(), safe='')}"
    return f"{base}?client=host&t={quote(plan_mcp_auth.internal_token(), safe='')}"


def caller_token() -> str:
    """Per-run secret marking a caller as a pane this backend run spawned.

    Scope note: it is a freshness check, not an authorisation boundary — the
    token sits in every pane's command line, so anything running as the same
    user can read it with ``ps``. What it buys is that a caller from a previous
    backend run (or something that never went through spawn wiring) is rejected
    instead of silently acting as some pane.
    """
    return _CALLER_TOKEN


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


def inline_mcp_config(port: int, pane_id: str = "") -> str:
    """Single-line JSON for the flags that take a literal config (claude's
    ``--mcp-config``, copilot's ``--additional-mcp-config``), so a pane-specific
    URL needs no per-pane file. Both CLIs read the same ``mcpServers`` shape."""
    return json.dumps(
        {"mcpServers": {SERVER_NAME: {"type": "http", "url": plan_mcp_url(port, pane_id)}}},
        separators=(",", ":"),
    )


def inline_env_config(port: int, pane_id: str = "") -> str:
    """Single-line JSON for the CLIs configured by an inline-config variable.

    opencode and its fork kilo read the same ``mcp`` map, where a streamable
    HTTP endpoint is ``type: remote`` (verified against ``opencode mcp list``:
    a ``mcpServers`` key is rejected outright as an unrecognised key). Both
    deep-merge this over the user's own config rather than replacing it.
    """
    return json.dumps(
        {
            "$schema": "https://opencode.ai/config.json",
            "mcp": {
                SERVER_NAME: {
                    "type": "remote",
                    "url": plan_mcp_url(port, pane_id),
                    "enabled": True,
                }
            },
        },
        separators=(",", ":"),
    )


def wire_command(
    agent_key: str,
    command: Any,
    port: int | None,
    pane_id: str = "",
    env: dict[str, str] | None = None,
    *,
    claude_config: Path | None = None,
) -> Any:
    """Append Plan-MCP wiring flags to a pane spawn command.

    No-op for agents with no known flag, unknown port, empty commands,
    already-wired commands, a user-supplied ``--mcp-config`` (respect their
    deliberate MCP setup, esp. with --strict-mcp-config), or (claude, when no
    pane id is known) a missing config file — a spawn must never break over MCP
    wiring.

    With a pane id, claude gets the config inline rather than by path: the URL
    now differs per pane, and writing one file per pane would leave litter
    behind in the app data dir. copilot is always inline — it has no
    file-based fallback to fall back to.

    ``env`` is the spawn environment and is mutated in place for the CLIs
    configured by variable; None (or a variable already set) leaves it alone.
    """
    if port is None:
        return command
    text = _command_text(command)
    if not text.strip():
        return command
    if agent_key == "claude":
        if "--mcp-config" in text:
            return command
        if pane_id:
            inline = inline_mcp_config(port, pane_id)
            return _append_to_command(command, f"--mcp-config {shlex.quote(inline)}")
        config = claude_config or claude_config_path()
        if not config.is_file():
            return command
        return _append_to_command(command, f"--mcp-config {shlex.quote(str(config))}")
    if agent_key == "codex":
        if f"mcp_servers.{SERVER_NAME}" in text:
            return command
        override = f'mcp_servers.{SERVER_NAME}.url="{plan_mcp_url(port, pane_id)}"'
        return _append_to_command(command, f"-c {shlex.quote(override)}")
    if agent_key == "copilot":
        if SERVER_NAME in text:
            return command
        inline = inline_mcp_config(port, pane_id)
        return _append_to_command(command, f"--additional-mcp-config {shlex.quote(inline)}")
    config_var = INLINE_CONFIG_ENV_VARS.get(agent_key)
    if config_var is not None and env is not None and config_var not in env:
        env[config_var] = inline_env_config(port, pane_id)
    return command
