from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.terminals import TerminalService


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    """Fake with one pre-existing live PTY resuming a known session id."""

    def __init__(self, live: list[SimpleNamespace] | None = None) -> None:
        self.created: list[dict[str, Any]] = []
        self.killed: list[tuple[str, bool]] = []
        self.live = live or []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id=f"term-{len(self.created)}",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append((session_id, force))
        self.live = [s for s in self.live if s.id != session_id]

    def find_live_by_resume_id(
        self, agent_key: str, resume_id: str, extract: Any
    ) -> list[SimpleNamespace]:
        return [
            s
            for s in self.live
            if not s.closed
            and s.agent_key == agent_key
            and extract(s.command) == resume_id
        ]


class FakeAttribution:
    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        pass


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


def _session(terminals: FakeTerminals) -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = terminals  # type: ignore[assignment]
    return session


def _live_pty(term_id: str, agent_key: str, command: list[str]) -> SimpleNamespace:
    return SimpleNamespace(id=term_id, agent_key=agent_key, command=command, closed=False)


async def _create(session: app.Session, command: Any, pane_id: str = "pane-1") -> None:
    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": pane_id,
            "agent_key": "claude",
            "command": command,
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })


def test_resume_id_for_agent_dispatches_per_agent() -> None:
    cmd = ["/bin/zsh", "-lc", "claude --dangerously-skip-permissions --resume abc-123"]
    assert app._resume_id_for_agent("claude", cmd) == "abc-123"
    assert app._resume_id_for_agent("codex", "codex resume xyz --yolo") == "xyz"
    # Fresh spawns and agents without an id-carrying resume flag yield ''.
    assert app._resume_id_for_agent("claude", "claude") == ""
    assert app._resume_id_for_agent("aider", "aider --restore-chat-history") == ""


async def test_find_live_by_resume_id_matches_only_live_same_agent() -> None:
    # async so TerminalService.__init__ finds a running event loop.
    service = TerminalService(emit=lambda _e: None)  # type: ignore[arg-type]
    match = _live_pty("t1", "claude", ["/bin/zsh", "-lc", "claude --resume abc"])
    closed = _live_pty("t2", "claude", ["/bin/zsh", "-lc", "claude --resume abc"])
    closed.closed = True
    other_agent = _live_pty("t3", "qwen", ["/bin/zsh", "-lc", "qwen --resume abc"])
    other_id = _live_pty("t4", "claude", ["/bin/zsh", "-lc", "claude --resume def"])
    service._sessions = {s.id: s for s in (match, closed, other_agent, other_id)}  # type: ignore[assignment]

    found = service.find_live_by_resume_id(
        "claude", "abc", lambda cmd: app._claude_resume_id(cmd)
    )
    assert [s.id for s in found] == ["t1"]


@pytest.mark.asyncio
async def test_resume_spawn_reaps_live_duplicate_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    stale = _live_pty(
        "term-stale", "claude", ["/bin/zsh", "-lc", "claude --resume abc-123"]
    )
    terminals = FakeTerminals(live=[stale])
    session = _session(terminals)

    await _create(session, ["/bin/zsh", "-lc", "claude --resume abc-123"])

    assert terminals.killed == [("term-stale", True)]
    assert len(terminals.created) == 1


@pytest.mark.asyncio
async def test_fresh_spawn_leaves_unrelated_sessions_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    stale = _live_pty(
        "term-stale", "claude", ["/bin/zsh", "-lc", "claude --resume abc-123"]
    )
    terminals = FakeTerminals(live=[stale])
    session = _session(terminals)

    await _create(session, "claude")

    assert terminals.killed == []
    assert len(terminals.created) == 1


@pytest.mark.asyncio
async def test_resume_spawn_of_different_session_leaves_live_pty_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    stale = _live_pty(
        "term-stale", "claude", ["/bin/zsh", "-lc", "claude --resume abc-123"]
    )
    terminals = FakeTerminals(live=[stale])
    session = _session(terminals)

    await _create(session, ["/bin/zsh", "-lc", "claude --resume other-999"])

    assert terminals.killed == []
    assert len(terminals.created) == 1
