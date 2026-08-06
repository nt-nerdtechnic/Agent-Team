"""Builtin navide.plans plugin: discovery, registrations, spawn wiring."""

from __future__ import annotations

import shlex
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.plugins import wiring
from agent_team_backend.plugins.builtin.navide_plans import plan_mcp, plan_mcp_wiring
from agent_team_backend.plugins.host import PluginHost


@pytest.fixture
def host(monkeypatch: pytest.MonkeyPatch) -> Iterator[PluginHost]:
    """A fresh host with the external plugins dir masked off, torn down after."""
    monkeypatch.delenv(wiring.PLUGINS_DIR_ENV, raising=False)
    host = PluginHost()
    yield host
    wiring.shutdown(host)


def _stage_port_file(tmp_path: Path, port: int = 4567) -> None:
    # conftest points AGENT_TEAM_DATA_DIR at tmp_path, so the discovery file
    # apply_spawn_wiring reads lives there.
    (tmp_path / "backend-port").write_text(str(port), encoding="utf-8")


# -- discovery / activation ---------------------------------------------------


def test_builtin_root_contains_navide_plans() -> None:
    dirs = wiring.discover_backend_plugin_dirs(wiring.builtin_plugins_root())
    assert wiring.builtin_plugins_root() / "navide_plans" in dirs


def test_startup_activates_builtin_and_registers_contributions(
    host: PluginHost,
) -> None:
    assert wiring.startup(host) == ["navide.plans", "navide.skills"]

    routes = host.registered_routes()
    assert [(r.path, r.methods) for r in routes] == [
        ("/plan-mcp", ["GET", "POST", "DELETE"])
    ]
    assert routes[0].asgi_app is plan_mcp.asgi_app
    # Two startup hooks (MCP session manager + claude config refresh), one
    # shutdown hook, one spawn transformer — all attributed to the plugin.
    assert [pid for pid, _ in host.startup_hooks()] == ["navide.plans"] * 2
    assert [pid for pid, _ in host.shutdown_hooks()] == ["navide.plans"]
    assert [pid for pid, _ in host.spawn_transformers()] == [
        "navide.plans",
        "navide.skills",
    ]


async def test_lifecycle_hooks_drive_plan_mcp_and_claude_config(
    host: PluginHost, tmp_path: Path
) -> None:
    _stage_port_file(tmp_path)
    wiring.startup(host)

    await wiring.run_startup_hooks(host)
    try:
        assert plan_mcp._session_manager is not None  # noqa: SLF001
        assert plan_mcp_wiring.claude_config_path().is_file()
    finally:
        await wiring.run_shutdown_hooks(host)
    assert plan_mcp._session_manager is None  # noqa: SLF001


# -- spawn wiring ------------------------------------------------------------


def test_spawn_wiring_appends_claude_flag(host: PluginHost, tmp_path: Path) -> None:
    wiring.startup(host)
    _stage_port_file(tmp_path)
    config = plan_mcp_wiring.write_claude_config(4567)

    wired = wiring.apply_spawn_wiring(host, "claude", "claude")
    assert wired == f"claude --mcp-config {shlex.quote(str(config))}"


def test_spawn_wiring_appends_codex_override(host: PluginHost, tmp_path: Path) -> None:
    wiring.startup(host)
    _stage_port_file(tmp_path)

    wired = wiring.apply_spawn_wiring(host, "codex", "codex")
    # No pane id given, so the override URL carries the host credential.
    assert wired == (
        f"codex -c 'mcp_servers.navide-plans.url=\"{plan_mcp_wiring.plan_mcp_url(4567)}\"'"
    )


def test_spawn_wiring_noop_for_other_agents(host: PluginHost, tmp_path: Path) -> None:
    wiring.startup(host)
    _stage_port_file(tmp_path)
    assert wiring.apply_spawn_wiring(host, "grok", "grok") == "grok"


def test_spawn_wiring_untouched_without_plugins(tmp_path: Path) -> None:
    _stage_port_file(tmp_path)
    command = ["/bin/zsh", "-ilc", "claude"]
    assert wiring.apply_spawn_wiring(PluginHost(), "claude", command) == command


def test_spawn_wiring_untouched_after_deactivate(
    host: PluginHost, tmp_path: Path
) -> None:
    wiring.startup(host)
    _stage_port_file(tmp_path)
    plan_mcp_wiring.write_claude_config(4567)

    host.deactivate("navide.plans")

    assert [pid for pid, _ in host.spawn_transformers()] == ["navide.skills"]
    assert wiring.apply_spawn_wiring(host, "claude", "claude") == "claude"


def test_spawn_wiring_tolerates_a_pre_pane_id_transformer(tmp_path: Path) -> None:
    """Third-party plugins were written against `(agent_key, command, port)`.
    Passing them a fourth argument would raise TypeError, which the caller
    swallows — their wiring would silently stop applying."""
    _stage_port_file(tmp_path)
    calls: list[tuple[str, Any, int | None]] = []

    def legacy(agent_key: str, command: Any, port: int | None) -> Any:
        calls.append((agent_key, command, port))
        return f"{command} --legacy"

    host = PluginHost()
    host._activated = lambda: []  # type: ignore[assignment,method-assign]
    host.spawn_transformers = lambda: [("third.party", legacy)]  # type: ignore[assignment,method-assign]

    assert wiring.apply_spawn_wiring(host, "claude", "claude", "pane-1") == "claude --legacy"
    assert calls == [("claude", "claude", 4567)]


def test_spawn_wiring_passes_the_pane_id_to_a_current_transformer(tmp_path: Path) -> None:
    _stage_port_file(tmp_path)
    seen: list[str] = []

    def current(agent_key: str, command: Any, port: int | None, pane_id: str) -> Any:
        seen.append(pane_id)
        return command

    host = PluginHost()
    host.spawn_transformers = lambda: [("third.party", current)]  # type: ignore[assignment,method-assign]

    wiring.apply_spawn_wiring(host, "claude", "claude", "pane-9")
    assert seen == ["pane-9"]
