from __future__ import annotations

import json
import shlex
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend import plan_mcp_wiring


# ---- write_claude_config ----


def test_write_claude_config_creates_file(tmp_path: Path) -> None:
    path = tmp_path / "plan-mcp.json"
    out = plan_mcp_wiring.write_claude_config(4567, path)
    assert out == path
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data == {
        "mcpServers": {
            "navide-plans": {"type": "http", "url": "http://127.0.0.1:4567/plan-mcp"}
        }
    }


def test_write_claude_config_updates_stale_port(tmp_path: Path) -> None:
    path = tmp_path / "plan-mcp.json"
    plan_mcp_wiring.write_claude_config(1111, path)
    plan_mcp_wiring.write_claude_config(2222, path)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["mcpServers"]["navide-plans"]["url"] == "http://127.0.0.1:2222/plan-mcp"


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
    wired = plan_mcp_wiring.wire_command("claude", command, 4567, claude_config)
    assert wired[:2] == ["/bin/zsh", "-ilc"]
    assert wired[2] == (
        "claude --dangerously-skip-permissions "
        f"--mcp-config {shlex.quote(str(claude_config))}"
    )
    assert command[2] == "claude --dangerously-skip-permissions"  # input untouched


def test_wire_claude_plain_string_command(claude_config: Path) -> None:
    wired = plan_mcp_wiring.wire_command("claude", "claude", 4567, claude_config)
    assert wired == f"claude --mcp-config {shlex.quote(str(claude_config))}"


def test_wire_claude_second_run_is_noop(claude_config: Path) -> None:
    once = plan_mcp_wiring.wire_command("claude", "claude", 4567, claude_config)
    twice = plan_mcp_wiring.wire_command("claude", once, 4567, claude_config)
    assert twice == once


def test_wire_claude_respects_user_mcp_config_flag(claude_config: Path) -> None:
    command = "claude --mcp-config /home/user/my-servers.json --strict-mcp-config"
    assert plan_mcp_wiring.wire_command("claude", command, 4567, claude_config) == command


def test_wire_claude_missing_config_file_is_noop(tmp_path: Path) -> None:
    missing = tmp_path / "nope" / "plan-mcp.json"
    assert plan_mcp_wiring.wire_command("claude", "claude", 4567, missing) == "claude"


# ---- wire_command: codex ----


def test_wire_codex_appends_config_override() -> None:
    wired = plan_mcp_wiring.wire_command("codex", "codex --yolo", 4567)
    assert wired == (
        "codex --yolo -c "
        "'mcp_servers.navide-plans.url=\"http://127.0.0.1:4567/plan-mcp\"'"
    )


def test_wire_codex_resume_command() -> None:
    command = ["/bin/zsh", "-lc", "codex resume abc123 --yolo"]
    wired = plan_mcp_wiring.wire_command("codex", command, 4567)
    assert wired[2].startswith("codex resume abc123 --yolo -c ")
    assert 'mcp_servers.navide-plans.url="http://127.0.0.1:4567/plan-mcp"' in wired[2]


def test_wire_codex_second_run_is_noop() -> None:
    once = plan_mcp_wiring.wire_command("codex", "codex", 4567)
    assert plan_mcp_wiring.wire_command("codex", once, 4567) == once


# ---- wire_command: gates ----


def test_wire_noop_without_port(claude_config: Path) -> None:
    assert plan_mcp_wiring.wire_command("claude", "claude", None, claude_config) == "claude"
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
    config = plan_mcp_wiring.write_claude_config(4567)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)

    async def _no_path_refresh(_agent_key: str) -> None:
        pass

    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", _no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", lambda *_a, **_k: None)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]

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

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["command"][2] == (
        "claude --dangerously-skip-permissions "
        f"--mcp-config {shlex.quote(str(config))}"
    )
