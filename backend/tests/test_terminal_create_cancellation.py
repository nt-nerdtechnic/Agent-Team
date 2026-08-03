from __future__ import annotations

import asyncio
import os
import threading
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend import terminals as terminals_module


class RecordingSocket:
    def __init__(self, *, fail: bool = False) -> None:
        self.sent: list[dict[str, Any]] = []
        self.fail = fail

    async def send_json(self, payload: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("socket closed")
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[SimpleNamespace] = []
        self.killed: list[tuple[str, bool]] = []
        self._sessions: dict[str, SimpleNamespace] = {}

    def create(self, **kwargs: Any) -> SimpleNamespace:
        term = SimpleNamespace(
            id=f"term-{len(self.created) + 1}",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1200 + len(self.created)),
            closed=False,
        )
        self.created.append(term)
        self._sessions[term.id] = term
        return term

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append((session_id, force))
        self._sessions.pop(session_id, None)

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class BlockingAttribution:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.registered: list[str] = []
        self.unregistered: list[str] = []

    def register_pane(self, pane_id: str, **_kwargs: Any) -> None:
        self.started.set()
        self.release.wait(timeout=5)
        self.registered.append(pane_id)

    def unregister_pane(self, pane_id: str) -> None:
        self.unregistered.append(pane_id)


def make_session(socket: RecordingSocket | None = None) -> app.Session:
    session = app.Session(socket or RecordingSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def terminal_create_stubs(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_path_refresh(_agent_key: str) -> None:
        return None

    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", lambda *_args: None)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(
        app.plugin_wiring, "apply_spawn_wiring", lambda _host, _agent, command, _pane_id="": command
    )
    app._PTY_OWNERS.clear()
    yield
    app._PTY_OWNERS.clear()


def create_message(*, pane_id: str = "pane-1", generation: str = "gen-1", agent: str = "terminal") -> dict[str, Any]:
    return {
        "id": "create-request",
        "type": "terminal.create",
        "payload": {
            "pane_id": pane_id,
            "create_generation": generation,
            "agent_key": agent,
            "command": "bash",
            "cwd": "/",
            "metadata": {"workspace_path": "/"},
        },
    }


def cancel_message(*, pane_id: str = "pane-1", generation: str = "gen-1", msg_id: str = "cancel-request") -> dict[str, Any]:
    return {
        "id": msg_id,
        "type": "terminal.create.cancel",
        "payload": {"pane_id": pane_id, "create_generation": generation},
    }


@pytest.mark.asyncio
async def test_cancel_before_popen_tombstones_generation() -> None:
    session = make_session()

    await app.handle_message(session, cancel_message())
    await app.handle_message(session, create_message())

    assert session.terminals.created == []  # type: ignore[attr-defined]
    assert session.websocket.sent[0]["payload"]["cancelled"] is True  # type: ignore[attr-defined]
    assert session.websocket.sent[1]["error"]["code"] == "CREATE_CANCELLED"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_cancel_after_popen_waits_for_attribution_then_rolls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attribution = BlockingAttribution()
    monkeypatch.setattr(app, "attribution", attribution)
    session = make_session()

    create_task = asyncio.create_task(
        app.handle_message(session, create_message(agent="claude"))
    )
    assert await asyncio.to_thread(attribution.started.wait, 2)
    cancel_task = asyncio.create_task(app.handle_message(session, cancel_message()))
    await asyncio.sleep(0)
    assert not cancel_task.done()

    attribution.release.set()
    await asyncio.gather(create_task, cancel_task)

    terminals = session.terminals  # type: ignore[assignment]
    assert terminals.killed == [("term-1", True)]
    assert attribution.registered == ["pane-1"]
    assert attribution.unregistered == ["pane-1"]
    assert "term-1" not in app._PTY_OWNERS
    assert terminals._sessions == {}


@pytest.mark.asyncio
async def test_send_failure_marks_dead_and_rolls_back_uncommitted_terminal() -> None:
    session = make_session(RecordingSocket(fail=True))

    await app.handle_message(session, create_message())

    assert session.dead is True
    assert session.terminals.killed == [("term-1", True)]  # type: ignore[attr-defined]
    assert "term-1" not in app._PTY_OWNERS


@pytest.mark.asyncio
async def test_already_dead_session_rolls_back_before_commit() -> None:
    session = make_session()
    session.dead = True

    await app.handle_message(session, create_message())

    assert session.websocket.sent == []  # type: ignore[attr-defined]
    assert session.terminals.killed == [("term-1", True)]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_handler_cancellation_during_attribution_rolls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attribution = BlockingAttribution()
    monkeypatch.setattr(app, "attribution", attribution)
    session = make_session()
    create_task = asyncio.create_task(
        app.handle_message(session, create_message(agent="claude"))
    )
    assert await asyncio.to_thread(attribution.started.wait, 2)

    create_task.cancel()
    attribution.release.set()
    with pytest.raises(asyncio.CancelledError):
        await create_task

    assert session.terminals.killed == [("term-1", True)]  # type: ignore[attr-defined]
    assert attribution.unregistered == ["pane-1"]
    assert "term-1" not in app._PTY_OWNERS


@pytest.mark.asyncio
async def test_repeated_cancel_is_idempotent() -> None:
    session = make_session()

    await app.handle_message(session, cancel_message(msg_id="cancel-1"))
    await app.handle_message(session, cancel_message(msg_id="cancel-2"))

    assert [message["payload"]["cancelled"] for message in session.websocket.sent] == [True, True]  # type: ignore[attr-defined]
    assert session.terminals.killed == []  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_repeated_committed_create_reuses_same_terminal() -> None:
    session = make_session()

    await app.handle_message(session, create_message())
    await app.handle_message(session, create_message())

    assert len(session.terminals.created) == 1  # type: ignore[attr-defined]
    assert [message["payload"]["terminal_session_id"] for message in session.websocket.sent] == [  # type: ignore[attr-defined]
        "term-1",
        "term-1",
    ]


@pytest.mark.asyncio
async def test_cancel_after_ack_does_not_kill_committed_terminal() -> None:
    session = make_session()

    await app.handle_message(session, create_message())
    await app.handle_message(session, cancel_message())

    assert session.websocket.sent[-1]["payload"]["cancelled"] is False  # type: ignore[attr-defined]
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert "term-1" in session.terminals._sessions  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_terminal_kill_requires_owner_and_clears_owner() -> None:
    first = make_session()
    second = make_session()
    term = first.terminals.create(  # type: ignore[attr-defined]
        pane_id="pane-1", command="bash"
    )
    app._PTY_OWNERS[term.id] = first

    await app.handle_message(
        second,
        {"id": "kill-1", "type": "terminal.kill", "payload": {"terminal_session_id": term.id}},
    )
    assert second.websocket.sent[-1]["error"]["code"] == "TERMINAL_NOT_OWNED"  # type: ignore[attr-defined]
    assert second.terminals.killed == []  # type: ignore[attr-defined]

    # Reattach is the legal ownership transfer before a new connection kills.
    second.terminals = first.terminals
    await app.handle_message(
        second,
        {"id": "reattach", "type": "terminal.reattach", "payload": {"terminal_session_ids": [term.id]}},
    )
    await app.handle_message(
        second,
        {"id": "kill-2", "type": "terminal.kill", "payload": {"terminal_session_id": term.id}},
    )
    assert second.terminals.killed == [(term.id, False)]  # type: ignore[attr-defined]
    assert term.id not in app._PTY_OWNERS


@pytest.mark.asyncio
async def test_terminal_service_create_rolls_back_post_popen_setup_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def emit(_event: dict[str, Any]) -> None:
        return None

    class FakeProcess:
        pid = 9876
        returncode: int | None = None

        def wait(self, timeout: float | None = None) -> int:
            self.returncode = -9
            return self.returncode

        def poll(self) -> int | None:
            return self.returncode

    service = terminals_module.TerminalService(emit)
    process = FakeProcess()
    opened: list[int] = []
    real_openpty = terminals_module.pty.openpty

    def recording_openpty() -> tuple[int, int]:
        master, slave = real_openpty()
        opened.append(master)
        return master, slave

    registered = threading.Event()
    unregistered = threading.Event()
    killed: list[tuple[int, int]] = []

    monkeypatch.setattr(terminals_module.pty, "openpty", recording_openpty)
    monkeypatch.setattr(terminals_module.shutil, "which", lambda _cmd: "/bin/bash")
    monkeypatch.setattr(terminals_module.subprocess, "Popen", lambda *_a, **_kw: process)
    monkeypatch.setattr(terminals_module.pty_registry, "register", lambda *_a: registered.set())
    monkeypatch.setattr(terminals_module.pty_registry, "unregister", lambda *_a: unregistered.set())
    monkeypatch.setattr(terminals_module.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(
        terminals_module.os, "killpg", lambda pgid, sig: killed.append((pgid, sig))
    )

    def fail_add_reader(*_args: Any) -> None:
        raise RuntimeError("reader setup failed")

    monkeypatch.setattr(service._loop, "add_reader", fail_add_reader)

    with pytest.raises(RuntimeError, match="reader setup failed"):
        service.create(pane_id="pane-1", agent_key=None, command="bash", cwd="/")

    assert await asyncio.to_thread(registered.wait, 2)
    assert await asyncio.to_thread(unregistered.wait, 2)
    assert service._sessions == {}
    assert process.returncode == -9
    assert killed == [(9876, terminals_module.signal.SIGKILL)]
    with pytest.raises(OSError):
        os.fstat(opened[0])
