from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app


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
    def __init__(self) -> None:
        self.registered: list[dict[str, Any]] = []

    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        self.registered.append({"pane_id": pane_id, **kwargs})


class FakeCodexHomeManager:
    def __init__(self, root: Path, session_homes: dict[str, Path] | None = None) -> None:
        self.root = root
        self.real_home = root / "real-codex"
        self.prepared: list[str] = []
        self.session_homes = session_homes or {}

    def prepare(self, home_id: str) -> Path:
        self.prepared.append(home_id)
        return self.root / home_id

    def find_session_home(self, resume_id: str) -> Path | None:
        return self.session_homes.get(resume_id)


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def _stub_agent_cli_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        app,
        "_probe_agent_cli_for_spawn",
        lambda agent_key, _command=None: {
            "agent_key": agent_key,
            "binary_path": f"/test/bin/{agent_key}",
            "version": "1.0.0",
            "duration_ms": 1,
        } if agent_key and agent_key != "terminal" else None,
    )


@pytest.mark.asyncio
async def test_terminal_create_codex_prepares_home_and_registers_home_id(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "live-pane",
            "agent_key": "codex",
            "command": "codex",
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "stage_id": "01",
                "slot_label": "Build",
                "session_home_id": "stable-home",
            },
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == ["stable-home"]
    assert created["env"]["CODEX_HOME"] == str(tmp_path / "codex-panes" / "stable-home")
    assert created["metadata"]["session_home_id"] == "stable-home"
    assert fake_attr.registered == [{
        "pane_id": "live-pane",
        "vendor": "codex",
        "cwd": "/ws",
        "workspace_path": "/ws",
        "stage_id": "01",
        "slot_key": "01:Build",
        "explicit_session_id": "",
        "session_marker": "",
        "session_home_id": "stable-home",
    }]
    assert session.websocket.sent[0]["payload"]["pane_id"] == "live-pane"


@pytest.mark.asyncio
async def test_terminal_create_codex_legacy_resume_keeps_default_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Resuming a session recorded under the real ~/.codex must not override
    CODEX_HOME — the per-pane home has no record of it and resume would fail."""
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    fake_home.session_homes["legacy-id"] = fake_home.real_home
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m3",
        "type": "terminal.create",
        "payload": {
            "pane_id": "legacy-pane",
            "agent_key": "codex",
            # Real frontend shape: spawnPane wraps commands in a login shell.
            "command": ["/bin/zsh", "-lc", "codex resume legacy-id --yolo"],
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "session_home_id": "stable-home",
            },
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == []
    assert created["env"] is None


@pytest.mark.asyncio
async def test_terminal_create_codex_resume_of_pane_session_uses_pane_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Resume of a session NOT in the default home keeps the per-pane override."""
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m4",
        "type": "terminal.create",
        "payload": {
            "pane_id": "pane-2",
            "agent_key": "codex",
            "command": "codex resume pane-session-id",
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "session_home_id": "stable-home",
            },
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == ["stable-home"]
    assert created["env"]["CODEX_HOME"] == str(tmp_path / "codex-panes" / "stable-home")


@pytest.mark.asyncio
async def test_terminal_create_codex_resume_uses_owning_pane_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A session recorded under another pane home resumes with THAT home,
    even when the persisted session_home_id drifted."""
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    owning_home = tmp_path / "codex-panes" / "old-pane-home"
    fake_home.session_homes["drifted-id"] = owning_home
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m5",
        "type": "terminal.create",
        "payload": {
            "pane_id": "pane-3",
            "agent_key": "codex",
            "command": ["/bin/zsh", "-lc", "codex resume drifted-id"],
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "session_home_id": "stable-home",
            },
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == []
    assert created["env"]["CODEX_HOME"] == str(owning_home)
    assert created["metadata"]["session_home_id"] == "old-pane-home"


def test_codex_resume_id_parses_resume_commands() -> None:
    assert app._codex_resume_id("codex resume abc-123") == "abc-123"
    assert app._codex_resume_id("codex resume abc-123 --yolo") == "abc-123"
    assert app._codex_resume_id("codex") == ""
    assert app._codex_resume_id("codex --resume abc") == ""
    assert app._codex_resume_id("") == ""
    assert app._codex_resume_id(None) == ""
    # Shell-wrapped list — the shape the frontend actually sends.
    assert app._codex_resume_id(["/bin/zsh", "-lc", "codex resume abc-123 --yolo"]) == "abc-123"
    assert app._codex_resume_id(["/bin/zsh", "-lc", "codex"]) == ""
    assert app._codex_resume_id([]) == ""


def test_claude_resume_id_parses_resume_commands() -> None:
    assert app._claude_resume_id("claude --resume abc-123") == "abc-123"
    assert app._claude_resume_id(
        "claude --resume abc-123 --dangerously-skip-permissions"
    ) == "abc-123"
    assert app._claude_resume_id(
        "claude --dangerously-skip-permissions --resume abc-123"
    ) == "abc-123"
    assert app._claude_resume_id("claude") == ""
    assert app._claude_resume_id("claude --session-id abc-123") == ""
    assert app._claude_resume_id("") == ""
    assert app._claude_resume_id(None) == ""
    # Shell-wrapped list — the shape the frontend actually sends.
    assert app._claude_resume_id(
        ["/bin/zsh", "-lc", "claude --resume abc-123 --dangerously-skip-permissions"]
    ) == "abc-123"
    assert app._claude_resume_id(["/bin/zsh", "-lc", "claude"]) == ""


def test_kimi_resume_id_parses_resume_commands() -> None:
    assert app._kimi_resume_id("kimi --session session_abc-123") == "session_abc-123"
    assert app._kimi_resume_id("kimi -S session_abc-123") == "session_abc-123"
    assert app._kimi_resume_id("kimi --session session_abc-123 --yolo") == "session_abc-123"
    assert app._kimi_resume_id("kimi --yolo --session session_abc-123") == "session_abc-123"
    assert app._kimi_resume_id("kimi") == ""
    # `--session` takes an OPTIONAL id (bare flag = interactive picker); a
    # following flag must not be captured as the id.
    assert app._kimi_resume_id("kimi --session --yolo") == ""
    assert app._kimi_resume_id("kimi --session") == ""
    assert app._kimi_resume_id("") == ""
    assert app._kimi_resume_id(None) == ""
    # Shell-wrapped list — the shape the frontend actually sends.
    assert app._kimi_resume_id(
        ["/bin/zsh", "-lc", "kimi --session session_abc-123 --yolo"]
    ) == "session_abc-123"
    assert app._kimi_resume_id(["/bin/zsh", "-lc", "kimi"]) == ""


@pytest.mark.asyncio
async def test_terminal_create_claude_resume_claims_resume_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resumed Claude panes have no pinned --session-id; the resume id MUST be
    claimed at registration or the unowned-session fallback can attribute the
    session to a sibling pane in the same cwd (which then overwrites that
    sibling's persisted resume id — the lost-conversation-on-restart bug)."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m6",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": [
                "/bin/zsh", "-lc",
                "claude --resume resumed-uuid --dangerously-skip-permissions",
            ],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "resumed-uuid"


@pytest.mark.asyncio
async def test_terminal_create_claude_metadata_session_id_wins_over_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A pinned --session-id from metadata is the stronger identity; command
    parsing is only the fallback for resume spawns."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m7",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane-2",
            "agent_key": "claude",
            "command": "claude --dangerously-skip-permissions --session-id pinned-uuid",
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "explicit_session_id": "pinned-uuid",
            },
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "pinned-uuid"


@pytest.mark.asyncio
async def test_terminal_create_kimi_resume_claims_resume_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resumed Kimi panes claim their resume id at registration so live events
    route back to them and the new-session single-candidate fallback excludes
    them (a fresh sibling pane in the same cwd stays bindable)."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m8",
        "type": "terminal.create",
        "payload": {
            "pane_id": "kimi-pane",
            "agent_key": "kimi",
            "command": ["/bin/zsh", "-lc", "kimi --session session_resumed-uuid --yolo"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "session_resumed-uuid"


@pytest.mark.asyncio
async def test_spawn_path_refresh_throttles(monkeypatch: pytest.MonkeyPatch) -> None:
    """Agent-CLI spawns refresh the backend PATH (so a just-installed CLI is
    found), but at most once per interval — the probe shells out."""
    calls: list[int] = []
    monkeypatch.setattr(
        app.onboarding_deps, "_refresh_path_from_login_shell", lambda: calls.append(1)
    )
    monkeypatch.setattr(app, "_last_path_refresh", 0.0)

    await app._ensure_fresh_path_for_spawn("grok")
    await app._ensure_fresh_path_for_spawn("claude")  # inside throttle window

    assert len(calls) == 1


@pytest.mark.asyncio
async def test_spawn_path_refresh_skips_plain_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[int] = []
    monkeypatch.setattr(
        app.onboarding_deps, "_refresh_path_from_login_shell", lambda: calls.append(1)
    )
    monkeypatch.setattr(app, "_last_path_refresh", 0.0)

    await app._ensure_fresh_path_for_spawn("terminal")

    assert calls == []


@pytest.mark.asyncio
async def test_terminal_create_probe_failure_returns_details_without_spawning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_probe(_agent_key: str, _command: object = None) -> None:
        raise app.AgentCliProbeError(
            "Claude Code startup probe was terminated by SIGKILL after 42ms (/opt/bin/claude)",
            {
                "binary_path": "/opt/bin/claude",
                "signal": "SIGKILL",
                "exit_code": -9,
                "duration_ms": 42,
            },
        )

    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", fail_probe)
    session = _session()

    await app.handle_message(session, {
        "id": "probe-fail",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
        },
    })

    assert session.terminals.created == []  # type: ignore[attr-defined]
    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "CLI_PROBE_FAILED"
    assert response["error"]["details"]["signal"] == "SIGKILL"
    assert response["error"]["details"]["binary_path"] == "/opt/bin/claude"


@pytest.mark.asyncio
async def test_terminal_create_rejects_child_that_died_before_ack() -> None:
    session = _session()

    def create_closed(**kwargs: Any) -> SimpleNamespace:
        return SimpleNamespace(
            id="dead-term",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
            closed=True,
            close_reason="exit",
            exit_code=-9,
            exit_signal="SIGKILL",
            uptime_ms=42,
        )

    session.terminals.create = create_closed  # type: ignore[method-assign]

    await app.handle_message(session, {
        "id": "early-death",
        "type": "terminal.create",
        "payload": {
            "pane_id": "terminal-pane",
            "agent_key": "terminal",
            "command": "bash",
            "cwd": "/ws",
        },
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "CLI_PROBE_FAILED"
    assert response["error"]["details"]["uptime_ms"] == 42
    assert response["error"]["details"]["signal"] == "SIGKILL"


@pytest.mark.asyncio
async def test_terminal_create_antigravity_registers_session_marker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Antigravity has no launch-time session identity; its marker MUST reach
    attribution.register_pane or binding/resume can never happen (regression:
    the register gate was hardcoded to claude/codex only)."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m3",
        "type": "terminal.create",
        "payload": {
            "pane_id": "ag-pane",
            "agent_key": "antigravity",
            "command": "agy --dangerously-skip-permissions",
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "session_marker": "at-pane:ag-pane",
            },
        },
    })

    assert fake_attr.registered == [{
        "pane_id": "ag-pane",
        "vendor": "antigravity",
        "cwd": "/ws",
        "workspace_path": "/ws",
        "stage_id": None,
        "slot_key": "",
        "explicit_session_id": "",
        "session_marker": "at-pane:ag-pane",
        "session_home_id": "",
    }]
