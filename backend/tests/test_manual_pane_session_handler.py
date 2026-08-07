"""manual_pane.session RPC handler — the contract the frontend retries against.

persistPaneSession (App.vue) only stops re-sending once the response payload
shows the pane carrying the id. Session detection routinely beats
manual_pane.spawn to the backend, so the handler must answer with a record even
then; the later spawn upgrades that stub in place.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> "app.Session":
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def _panes(session: "app.Session") -> list[dict[str, Any]]:
    return session.websocket.sent[0]["payload"]["project"]["panes"]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_session_before_spawn_is_confirmed_in_the_response(tmp_path: Path) -> None:
    ws = str(tmp_path)
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "manual_pane.session",
        "payload": {"workspace_path": ws, "pane_id": "P1", "session_id": "sess-1"},
    })

    # The frontend's confirmation predicate: pane_id present AND session matches.
    assert [(p["pane_id"], p["session_id"]) for p in _panes(session)] == [("P1", "sess-1")]


@pytest.mark.asyncio
async def test_spawn_after_session_upgrades_the_same_record(tmp_path: Path) -> None:
    ws = str(tmp_path)
    await app.handle_message(_session(), {
        "id": "m1",
        "type": "manual_pane.session",
        "payload": {"workspace_path": ws, "pane_id": "P1", "session_id": "sess-1"},
    })
    spawn = _session()
    await app.handle_message(spawn, {
        "id": "m2",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })

    panes = _panes(spawn)
    assert len(panes) == 1
    assert panes[0]["spawn_status"] == "spawned"
    assert panes[0]["agent"] == "claude"
    assert panes[0]["session_id"] == "sess-1"
