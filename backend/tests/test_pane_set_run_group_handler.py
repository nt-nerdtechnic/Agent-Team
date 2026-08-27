"""pane.set_run_group RPC handler — what the frontend is allowed to conclude.

movePaneToGroup (App.vue) drops the pane's group id in memory on the strength of
this reply. A pane whose record the store cannot find was not written, so the
reply must say so: answering ok there loses the assignment on screen while the
record on disk keeps it, and the pane comes back on a tab that no longer matches
after the next restore.
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


def _reply(session: "app.Session") -> dict[str, Any]:
    return session.websocket.sent[0]  # type: ignore[attr-defined]


async def _set_run_group(session: "app.Session", ws: str, pane_id: str, gid: str) -> None:
    await app.handle_message(session, {
        "id": "m1",
        "type": "pane.set_run_group",
        "payload": {"workspace_path": ws, "pane_id": pane_id, "run_group_id": gid},
    })


@pytest.mark.asyncio
async def test_unknown_pane_is_answered_with_an_error(tmp_path: Path) -> None:
    session = _session()
    await _set_run_group(session, str(tmp_path), "nope", "rg-1")

    reply = _reply(session)
    assert reply["ok"] is False
    assert reply["error"]["code"] == "PANE_NOT_FOUND"
    assert reply["payload"] is None


@pytest.mark.asyncio
async def test_known_pane_is_answered_with_the_written_project(tmp_path: Path) -> None:
    ws = str(tmp_path)
    await app.handle_message(_session(), {
        "id": "m0",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })
    session = _session()
    await _set_run_group(session, ws, "P1", "rg-1")

    reply = _reply(session)
    assert reply["ok"] is True
    panes = reply["payload"]["project"]["panes"]
    assert [(p["pane_id"], p["run_group_id"]) for p in panes] == [("P1", "rg-1")]
