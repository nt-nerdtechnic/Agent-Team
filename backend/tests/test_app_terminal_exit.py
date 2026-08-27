from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.ipc import make_event


class FakeAttribution:
    def __init__(self) -> None:
        self.unregistered: list[str] = []

    def unregister_pane(self, pane_id: str) -> None:
        self.unregistered.append(pane_id)


def _exit_event(pane_id: str = "p1", exit_code: int | None = 127) -> dict[str, Any]:
    return make_event("terminal.exit", {
        "terminal_session_id": "t1",
        "pane_id": pane_id,
        "reason": "exit",
        "exit_code": exit_code,
    })


@pytest.fixture(autouse=True)
def _clean_pending() -> Any:
    yield
    for handle in app._PENDING_UNREGISTERS.values():
        handle.cancel()
    app._PENDING_UNREGISTERS.clear()


@pytest.mark.asyncio
async def test_active_emit_terminal_exit_unregisters_after_grace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An autonomous PTY exit must release the attribution registration
    (regression: only terminal.kill unregistered, so a CLI that died on its
    own leaked its session marker in _unbound_markers forever). The release
    is delayed so the CLI's final log flush / late marker binding is still
    attributed to the pane."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_UNREGISTER_GRACE_SEC", 0.0)

    # No entry in _PTY_OWNERS: cleanup must run even for a detached pane.
    await app._active_emit(_exit_event())

    # Not yet — the grace timer must elapse first.
    assert fake_attr.unregistered == []
    await asyncio.sleep(0.05)
    assert fake_attr.unregistered == ["p1"]
    assert "p1" not in app._PENDING_UNREGISTERS


@pytest.mark.asyncio
async def test_pane_recreate_cancels_pending_unregister(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A pane re-created during the grace period (renderer reload respawns
    keep their pane id) must keep its fresh registration."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_UNREGISTER_GRACE_SEC", 0.0)

    await app._active_emit(_exit_event())
    app._cancel_pane_unregister("p1")

    await asyncio.sleep(0.05)
    assert fake_attr.unregistered == []
    assert "p1" not in app._PENDING_UNREGISTERS


@pytest.mark.asyncio
async def test_active_emit_non_exit_event_does_not_unregister(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_UNREGISTER_GRACE_SEC", 0.0)

    await app._active_emit(make_event("terminal.output", {
        "terminal_session_id": "t1",
        "pane_id": "p1",
        "data": "hello",
        "stream": "stdout",
    }))

    await asyncio.sleep(0.05)
    assert fake_attr.unregistered == []


@pytest.mark.asyncio
async def test_active_emit_terminal_exit_without_pane_id_is_safe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_UNREGISTER_GRACE_SEC", 0.0)

    event = _exit_event()
    event["payload"].pop("pane_id")
    await app._active_emit(event)

    await asyncio.sleep(0.05)
    assert fake_attr.unregistered == []


@pytest.mark.asyncio
async def test_active_emit_terminal_exit_clears_the_subagent_count() -> None:
    """A CLI that exits with subagents running never reports their stops.

    Left behind, the count would gate the NEXT loop started on this pane id for
    the whole staleness window — a loop that silently refuses to continue, on a
    pane whose CLI is long gone.
    """
    from agent_team_backend import subagent_tracker

    subagent_tracker.reset("p1")
    subagent_tracker.note_tool_use("p1", "Task")
    subagent_tracker.note_tool_use("p1", "Task")
    assert subagent_tracker.pending("p1") == 2

    await app._active_emit(_exit_event("p1"))

    assert subagent_tracker.pending("p1") == 0
