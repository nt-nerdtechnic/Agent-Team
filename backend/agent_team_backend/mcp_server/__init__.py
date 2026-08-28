"""Navide's own MCP server — the endpoint every CLI pane is wired to.

Core, not a plugin: the tools here are this machine's own capabilities
(talking to other panes, driving the UI, recording file changes), they must be
available whenever the backend runs, and the mount path is baked into pane
config files already written to disk.

A plugin adds its own tools to this server through
``PluginContext.register_mcp_tools`` rather than serving a second endpoint —
that is how ``navide.plans`` contributes the ``plan_*`` family.
"""
