"""_redact_argv: backend.log must not receive the MCP caller token verbatim.

backend.log is 0644 and terminal session creation logs the full spawn argv,
which for an MCP-spawned pane includes a URL carrying `?pane=<id>&t=<caller
token>`. Logging that string handed out a live, working credential to
anyone who could read the log (e.g. a user attaching it to a bug report).
"""

from __future__ import annotations

from agent_team_backend.terminals import _redact_argv


def test_redact_argv_masks_only_the_t_query_param() -> None:
    argv = [
        "node",
        "server.js",
        "http://127.0.0.1:1/plan-mcp?pane=p1&t=SECRET",
    ]

    redacted = _redact_argv(argv)

    assert redacted[0] == "node"
    assert redacted[1] == "server.js"
    assert "SECRET" not in redacted[2]
    assert redacted[2] == "http://127.0.0.1:1/plan-mcp?pane=p1&t=<redacted>"


def test_redact_argv_leaves_arguments_without_a_token_untouched() -> None:
    argv = ["/bin/zsh", "-lc", "echo hi"]
    assert _redact_argv(argv) == argv
