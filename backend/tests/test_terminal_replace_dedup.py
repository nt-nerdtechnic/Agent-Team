"""terminal.create must reap the pane's previous PTY via replaces_terminal_id.

Resume-id dedup cannot catch it: a CLI rewrites its session id on every
resume, so across restores the argv ids never match and the replaced PTY
lingers ownerless forever (observed: hours-idle `claude --resume` processes).
The frontend passes the pane's last terminal_session_id; the backend kills it
when it is the same pane's predecessor or an ownerless leftover — never a PTY
another window still owns.
"""
from __future__ import annotations

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

    def get(self, session_id: str) -> SimpleNamespace | None:
        return next((s for s in self.live if s.id == session_id), None)

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


@pytest.fixture(autouse=True)
def _stub_agent_cli_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        app,
        "_probe_agent_cli_for_spawn",
        lambda agent_key, _command=None: None,
    )
    monkeypatch.setattr(app, "_PTY_OWNERS", {})


def _session(terminals: FakeTerminals) -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = terminals  # type: ignore[assignment]
    return session


def _live_pty(term_id: str, pane_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=term_id,
        pane_id=pane_id,
        agent_key="claude",
        command=["/bin/zsh", "-lc", "claude --resume old-id"],
        closed=False,
    )


async def _create(
    session: app.Session, pane_id: str, replaces_terminal_id: str
) -> None:
    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": pane_id,
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
            "replaces_terminal_id": replaces_terminal_id,
        },
    })


async def test_replaces_kills_same_pane_predecessor() -> None:
    terminals = FakeTerminals(live=[_live_pty("t-old", "pane-1")])
    session = _session(terminals)
    await _create(session, pane_id="pane-1", replaces_terminal_id="t-old")
    assert ("t-old", True) in terminals.killed
    assert len(terminals.created) == 1


async def test_replaces_kills_ownerless_leftover_across_pane_ids() -> None:
    # Pane ids regenerate across restores — an ownerless predecessor is still
    # reaped even though the pane id differs.
    terminals = FakeTerminals(live=[_live_pty("t-old", "pane-old")])
    session = _session(terminals)
    await _create(session, pane_id="pane-new", replaces_terminal_id="t-old")
    assert ("t-old", True) in terminals.killed


async def test_replaces_refuses_another_windows_live_pane() -> None:
    terminals = FakeTerminals(live=[_live_pty("t-old", "pane-other")])
    session = _session(terminals)
    app._PTY_OWNERS["t-old"] = object()  # another WS still owns it
    await _create(session, pane_id="pane-new", replaces_terminal_id="t-old")
    assert terminals.killed == []
    assert len(terminals.created) == 1


async def test_replaces_unknown_or_dead_id_is_noop() -> None:
    terminals = FakeTerminals(live=[])
    session = _session(terminals)
    await _create(session, pane_id="pane-1", replaces_terminal_id="t-gone")
    assert terminals.killed == []
    assert len(terminals.created) == 1
