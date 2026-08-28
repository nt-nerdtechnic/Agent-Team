"""What a plugin's MCP tools may use from core.

``PluginContext.register_mcp_tools`` hands a plugin the server object; this
module is the other half of that contract — the caller identity its tools need,
and the workspace resolution that answers "which project is this call about"
(core's own preview tools resolve a workspace the same way, which is why that
chain lives here rather than in the plugin).

Everything here is deliberately re-exported under a public name. A plugin
reaching into ``server``'s private helpers would break on any internal
refactor, and the breakage would be an ImportError at backend startup — after
which that plugin's tools simply are not in the list, with one log line.
"""

from __future__ import annotations

from .server import CallerUnknown
from .server import _Caller as Caller
from .server import _plan_workspace as caller_workspace
from .server import _resolve_caller as resolve_caller
from .server import _workspace_mismatch_warning as workspace_mismatch_warning

__all__ = [
    "Caller",
    "CallerUnknown",
    "caller_workspace",
    "resolve_caller",
    "workspace_mismatch_warning",
]
