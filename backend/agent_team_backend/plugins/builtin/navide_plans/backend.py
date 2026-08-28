"""Backend entry for the builtin ``navide.plans`` plugin.

The plugin owns one thing: the ``plan_*`` MCP tools. Everything else that used
to be registered here — the ``/plan-mcp`` route, the session-manager lifecycle,
the claude ``--mcp-config`` refresh, the spawn-command transformer — is core
(see :mod:`agent_team_backend.mcp_server`), because none of it is about plans:
it is the endpoint every CLI pane is wired to, and it must come up whether or
not this plugin loads.

The tools are installed onto that core server rather than served from a second
endpoint, so an agent sees one tool list.

The host loads this file by path, not as a package member, so the import below
must be absolute — a relative one raises ModuleNotFoundError and the plugin is
skipped with a single log line.
"""

from __future__ import annotations

from typing import Any

from agent_team_backend.plugins.builtin.navide_plans import plan_tools


def activate(context: Any) -> None:
    context.register_mcp_tools(plan_tools.install)


def deactivate() -> None:
    # Registrations are cleared by the host. Tools already installed on the
    # core server stay for the life of the process: FastMCP has no unregister,
    # and a builtin plugin is never deactivated at runtime anyway.
    pass
