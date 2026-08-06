from __future__ import annotations

import json
import shlex
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.plugins import wiring as plugin_wiring
from agent_team_backend.plugins.builtin.navide_plans import plan_mcp_auth, plan_mcp_wiring


# ---- write_claude_config ----


def test_write_claude_config_creates_file(tmp_path: Path) -> None:
    path = tmp_path / "plan-mcp.json"
    out = plan_mcp_wiring.write_claude_config(4567, path)
    assert out == path
    data = json.loads(path.read_text(encoding="utf-8"))
    # No pane id known for this fallback file, so the URL carries this
    # backend's own host credential instead of being bare.
    assert data == {
        "mcpServers": {
            "navide-plans": {"type": "http", "url": plan_mcp_wiring.plan_mcp_url(4567)}
        }
    }
    assert f"client=host&t={plan_mcp_auth.internal_token()}" in data["mcpServers"]["navide-plans"]["url"]


def test_write_claude_config_updates_stale_port(tmp_path: Path) -> None:
    path = tmp_path / "plan-mcp.json"
    plan_mcp_wiring.write_claude_config(1111, path)
    plan_mcp_wiring.write_claude_config(2222, path)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["mcpServers"]["navide-plans"]["url"] == plan_mcp_wiring.plan_mcp_url(2222)


def test_write_claude_config_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "plan-mcp.json"
    plan_mcp_wiring.write_claude_config(4567, path)
    before = path.stat().st_mtime_ns
    plan_mcp_wiring.write_claude_config(4567, path)
    assert path.stat().st_mtime_ns == before  # unchanged content → no rewrite
    assert not path.with_suffix(".json.tmp").exists()


# ---- backend_port ----


def test_backend_port_reads_discovery_file(tmp_path: Path) -> None:
    # conftest autouse fixture points AGENT_TEAM_DATA_DIR at tmp_path.
    (tmp_path / "backend-port").write_text("4567\n", encoding="utf-8")
    assert plan_mcp_wiring.backend_port() == 4567


def test_backend_port_absent_or_garbage(tmp_path: Path) -> None:
    assert plan_mcp_wiring.backend_port() is None
    (tmp_path / "backend-port").write_text("not-a-port", encoding="utf-8")
    assert plan_mcp_wiring.backend_port() is None


# ---- plan_mcp_url: pane vs. host credential ----


def test_plan_mcp_url_with_pane_id_carries_the_pane_credential() -> None:
    url = plan_mcp_wiring.plan_mcp_url(4567, "pane-1")
    assert url == (
        f"http://127.0.0.1:4567/plan-mcp?pane=pane-1&t={plan_mcp_wiring.caller_token()}"
    )


def test_plan_mcp_url_without_pane_id_carries_the_host_credential() -> None:
    url = plan_mcp_wiring.plan_mcp_url(4567)
    assert url == (
        f"http://127.0.0.1:4567/plan-mcp?client=host&t={plan_mcp_auth.internal_token()}"
    )


# ---- wire_command: claude ----


@pytest.fixture
def claude_config(tmp_path: Path) -> Path:
    # Deliberately a dir with a space (real path is "Application Support/…")
    # so quoting is exercised.
    config = tmp_path / "App Data" / "plan-mcp.json"
    config.parent.mkdir(parents=True)
    return plan_mcp_wiring.write_claude_config(4567, config)


def test_wire_claude_appends_quoted_flag_to_shell_wrapper(claude_config: Path) -> None:
    command = ["/bin/zsh", "-ilc", "claude --dangerously-skip-permissions"]
    wired = plan_mcp_wiring.wire_command("claude", command, 4567, claude_config=claude_config)
    assert wired[:2] == ["/bin/zsh", "-ilc"]
    assert wired[2] == (
        "claude --dangerously-skip-permissions "
        f"--mcp-config {shlex.quote(str(claude_config))}"
    )
    assert command[2] == "claude --dangerously-skip-permissions"  # input untouched


def test_wire_claude_plain_string_command(claude_config: Path) -> None:
    wired = plan_mcp_wiring.wire_command("claude", "claude", 4567, claude_config=claude_config)
    assert wired == f"claude --mcp-config {shlex.quote(str(claude_config))}"


def test_wire_claude_second_run_is_noop(claude_config: Path) -> None:
    once = plan_mcp_wiring.wire_command("claude", "claude", 4567, claude_config=claude_config)
    twice = plan_mcp_wiring.wire_command("claude", once, 4567, claude_config=claude_config)
    assert twice == once


def test_wire_claude_respects_user_mcp_config_flag(claude_config: Path) -> None:
    command = "claude --mcp-config /home/user/my-servers.json --strict-mcp-config"
    assert plan_mcp_wiring.wire_command("claude", command, 4567, claude_config=claude_config) == command


def test_wire_claude_missing_config_file_is_noop(tmp_path: Path) -> None:
    missing = tmp_path / "nope" / "plan-mcp.json"
    assert plan_mcp_wiring.wire_command("claude", "claude", 4567, claude_config=missing) == "claude"


# ---- wire_command: codex ----


def test_wire_codex_appends_config_override() -> None:
    wired = plan_mcp_wiring.wire_command("codex", "codex --yolo", 4567)
    # No pane id given, so the override URL carries the host credential.
    assert wired == (
        "codex --yolo -c "
        f"'mcp_servers.navide-plans.url=\"{plan_mcp_wiring.plan_mcp_url(4567)}\"'"
    )
    assert "client=host" in wired


def test_wire_codex_resume_command() -> None:
    command = ["/bin/zsh", "-lc", "codex resume abc123 --yolo"]
    wired = plan_mcp_wiring.wire_command("codex", command, 4567)
    assert wired[2].startswith("codex resume abc123 --yolo -c ")
    assert f'mcp_servers.navide-plans.url="{plan_mcp_wiring.plan_mcp_url(4567)}"' in wired[2]


def test_wire_codex_with_pane_id_uses_pane_credential() -> None:
    """With a pane id, the override URL still carries the pane credential
    (unaffected by the host-credential fallback added for the empty case)."""
    wired = plan_mcp_wiring.wire_command("codex", "codex", 4567, pane_id="p1")
    url = plan_mcp_wiring.plan_mcp_url(4567, "p1")
    assert "pane=p1" in url and "client=host" not in url
    assert url in wired


def test_wire_codex_second_run_is_noop() -> None:
    once = plan_mcp_wiring.wire_command("codex", "codex", 4567)
    assert plan_mcp_wiring.wire_command("codex", once, 4567) == once


# ---- wire_command: copilot ----


def test_wire_copilot_appends_inline_config() -> None:
    wired = plan_mcp_wiring.wire_command("copilot", "copilot --allow-all-tools", 4567)
    inline = plan_mcp_wiring.inline_mcp_config(4567)
    assert wired == f"copilot --allow-all-tools --additional-mcp-config {shlex.quote(inline)}"
    assert "client=host" in wired


def test_wire_copilot_shell_wrapper_and_pane_credential() -> None:
    command = ["/bin/zsh", "-ilc", "copilot"]
    wired = plan_mcp_wiring.wire_command("copilot", command, 4567, pane_id="p1")
    assert wired[:2] == ["/bin/zsh", "-ilc"]
    assert wired[2].startswith("copilot --additional-mcp-config ")
    assert "pane=p1" in wired[2] and "client=host" not in wired[2]
    assert command[2] == "copilot"  # input untouched


def test_wire_copilot_second_run_is_noop() -> None:
    once = plan_mcp_wiring.wire_command("copilot", "copilot", 4567)
    assert plan_mcp_wiring.wire_command("copilot", once, 4567) == once


def test_wire_copilot_keeps_user_additional_config() -> None:
    """copilot's flag is additive and repeatable, so a user's own
    --additional-mcp-config is augmented, not stepped aside for."""
    command = "copilot --additional-mcp-config @/home/user/servers.json"
    wired = plan_mcp_wiring.wire_command("copilot", command, 4567)
    assert wired.startswith(command + " --additional-mcp-config ")
    assert plan_mcp_wiring.SERVER_NAME in wired


# ---- wire_command: opencode / kilo (config in an env var) ----


def test_wire_opencode_sets_the_config_content_var() -> None:
    env: dict[str, str] = {}
    assert plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "p1", env) == "opencode"
    payload = json.loads(env["OPENCODE_CONFIG_CONTENT"])
    entry = payload["mcp"][plan_mcp_wiring.SERVER_NAME]
    # Verified against `opencode mcp list`: remote servers are type "remote",
    # and an "mcpServers" key is rejected as unrecognised.
    assert entry["type"] == "remote"
    assert entry["url"] == plan_mcp_wiring.plan_mcp_url(4567, "p1")
    assert entry["enabled"] is True


def test_wire_kilo_uses_its_own_var_with_the_same_document() -> None:
    kilo_env: dict[str, str] = {}
    opencode_env: dict[str, str] = {}
    plan_mcp_wiring.wire_command("kilo", "kilo", 4567, "p1", kilo_env)
    plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "p1", opencode_env)
    assert kilo_env["KILO_CONFIG_CONTENT"] == opencode_env["OPENCODE_CONFIG_CONTENT"]
    assert "OPENCODE_CONFIG_CONTENT" not in kilo_env


def test_wire_env_cli_leaves_the_command_and_a_preset_var_alone() -> None:
    env = {"OPENCODE_CONFIG_CONTENT": "{}"}
    assert plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "p1", env) == "opencode"
    assert env == {"OPENCODE_CONFIG_CONTENT": "{}"}


def test_wire_env_cli_without_an_env_dict_is_a_noop() -> None:
    """The transformer still runs for callers on the older contract."""
    assert plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "p1") == "opencode"


def test_wire_env_cli_without_pane_id_uses_the_host_credential() -> None:
    env: dict[str, str] = {}
    plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "", env)
    assert "client=host" in env["OPENCODE_CONFIG_CONTENT"]


# ---- wire_command: gates ----


def test_wire_noop_without_port(claude_config: Path) -> None:
    assert plan_mcp_wiring.wire_command("claude", "claude", None, claude_config=claude_config) == "claude"
    assert plan_mcp_wiring.wire_command("codex", "codex", None) == "codex"


def test_wire_noop_for_other_agents_and_empty_command(claude_config: Path) -> None:
    for agent in ("terminal", "grok", "kimi", "antigravity", ""):
        assert plan_mcp_wiring.wire_command(agent, "grok", 4567) == "grok"
    assert plan_mcp_wiring.wire_command("claude", "", 4567, claude_config) == ""
    assert plan_mcp_wiring.wire_command("claude", [], 4567, claude_config) == []


# ---- integration: terminal.create wires a claude pane ----


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id="term-1",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeAttribution:
    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        pass


@pytest.mark.asyncio
async def test_terminal_create_wires_claude_pane(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # conftest points AGENT_TEAM_DATA_DIR at tmp_path: stage the port
    # discovery file and the startup-written claude config there.
    (tmp_path / "backend-port").write_text("4567", encoding="utf-8")
    plan_mcp_wiring.write_claude_config(4567)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)

    async def _no_path_refresh(_agent_key: str) -> None:
        pass

    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", _no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", lambda *_a, **_k: None)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]

    # Spawn wiring now runs through the plugin host: boot the builtin
    # navide.plans plugin on the app-level host, then tear it down again.
    plugin_wiring.startup(app.plugin_host)
    try:
        await app.handle_message(session, {
            "id": "m1",
            "type": "terminal.create",
            "payload": {
                "pane_id": "pane-1",
                "agent_key": "claude",
                "command": ["/bin/zsh", "-ilc", "claude --dangerously-skip-permissions"],
                "cwd": "/ws",
                "metadata": {"workspace_path": "/ws"},
            },
        })
    finally:
        plugin_wiring.shutdown(app.plugin_host)

    # The endpoint is shared by every pane, so the URL carries the pane id (and
    # the caller token) — which means claude gets the config inline rather than
    # as a path, so no per-pane file is left behind.
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    inline = plan_mcp_wiring.inline_mcp_config(4567, "pane-1")
    assert created["command"][2] == (
        f"claude --dangerously-skip-permissions --mcp-config {shlex.quote(inline)}"
    )
    assert "pane=pane-1" in inline
    assert plan_mcp_wiring.caller_token() in inline
