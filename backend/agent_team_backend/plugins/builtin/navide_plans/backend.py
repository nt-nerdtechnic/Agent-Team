"""Backend entry for the builtin ``navide.plans`` plugin.

Activation registers everything app.py used to wire directly:

* the ``/plan-mcp`` HTTP route serving the Plan MCP server (see plan_mcp.py),
* startup/shutdown hooks driving the MCP session-manager lifecycle plus the
  claude ``--mcp-config`` file refresh (see plan_mcp_wiring.py),
* the spawn-command transformer appending Plan-MCP flags to claude/codex
  pane commands at terminal.create time.

The host loads this file by path, so imports are absolute: plan_mcp and
plan_mcp_wiring live in this same package and keep their module-level
singletons regardless of how backend.py itself is imported.
"""

from __future__ import annotations

from typing import Any

from agent_team_backend.plugins.builtin.navide_plans import plan_mcp, plan_mcp_wiring


def _write_claude_config() -> None:
    """Refresh the app-owned claude ``--mcp-config`` file with this run's port.

    Port discovery file absent -> no-op; panes just spawn unwired. Registered
    as its own startup hook so a Plan-MCP startup failure never skips it
    (the wiring layer isolates hooks individually).
    """
    port = plan_mcp_wiring.backend_port()
    if port is not None:
        plan_mcp_wiring.write_claude_config(port)


def activate(context: Any) -> None:
    context.register_route("/plan-mcp", plan_mcp.asgi_app, ["GET", "POST", "DELETE"])
    context.register_startup(plan_mcp.startup)
    context.register_startup(_write_claude_config)
    context.register_shutdown(plan_mcp.shutdown)
    context.register_spawn_transformer(plan_mcp_wiring.wire_command)


def deactivate() -> None:
    # Registrations are cleared by the host; the MCP session manager itself is
    # stopped by the registered shutdown hook.
    pass
