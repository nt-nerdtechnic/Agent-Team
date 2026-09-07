"""pipeline.slot_unspawn RPC handler — the PTY must not outlive the slot.

Closing a pipeline slot removes its pane record, and a pane the renderer never
realized has no terminal ref to kill through. Without a backend-side sweep the
process survives with nothing left pointing at it, exactly as manual panes did
before 254121fb.
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


class FakeTerminals:
    def __init__(self, by_pane: dict[str, list[str]]) -> None:
        self._by_pane = by_pane
        self.killed: list[tuple[str, bool]] = []

    def live_session_ids_for_pane(self, pane_id: str) -> list[str]:
        return list(self._by_pane.get(pane_id, []))

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append((session_id, force))


def _session(terminals: FakeTerminals) -> "app.Session":
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = terminals  # type: ignore[assignment]
    return session


def _spawned_slot(ws: str, pane_id: str) -> None:
    app.project_store.start_pipeline(
        ws,
        task_description="t",
        total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    app.project_store.record_slot_spawn(
        ws, stage_index=0, slot_label="Build", pane_id=pane_id, agent="codex",
    )


async def _unspawn(session: "app.Session", ws: str) -> None:
    await app.handle_message(session, {
        "id": "m1",
        "type": "pipeline.slot_unspawn",
        "payload": {"workspace_path": ws, "stage_index": 0, "slot_label": "Build"},
    })


@pytest.mark.asyncio
async def test_slot_unspawn_kills_the_pty_still_running_under_the_slot(tmp_path: Path) -> None:
    ws = str(tmp_path)
    _spawned_slot(ws, "P1")
    terminals = FakeTerminals({"P1": ["term-1", "term-2"]})
    session = _session(terminals)

    await _unspawn(session, ws)

    assert terminals.killed == [("term-1", True), ("term-2", True)]
    panes = session.websocket.sent[0]["payload"]["project"]["panes"]  # type: ignore[attr-defined]
    assert [p["spawn_status"] for p in panes] == ["removed"]


@pytest.mark.asyncio
async def test_slot_unspawn_leaves_other_panes_ptys_alone(tmp_path: Path) -> None:
    ws = str(tmp_path)
    _spawned_slot(ws, "P1")
    terminals = FakeTerminals({"other-pane": ["term-9"]})
    session = _session(terminals)

    await _unspawn(session, ws)

    assert terminals.killed == []


@pytest.mark.asyncio
async def test_slot_unspawn_without_a_record_sweeps_nothing(tmp_path: Path) -> None:
    """No slot pane means no pane id — the sweep must not fall back to a blank one."""
    ws = str(tmp_path)
    app.project_store.start_pipeline(
        ws,
        task_description="t",
        total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build", "slots": []}],
    )
    terminals = FakeTerminals({"": ["term-blank"]})
    session = _session(terminals)

    await _unspawn(session, ws)

    assert terminals.killed == []


@pytest.mark.asyncio
async def test_manual_pane_unspawn_still_sweeps(tmp_path: Path) -> None:
    """The sweep is shared with manual_pane.unspawn — that path must keep it."""
    ws = str(tmp_path)
    app.project_store.record_manual_pane_spawn(ws, pane_id="M1", agent="claude")
    terminals = FakeTerminals({"M1": ["term-m"]})
    session = _session(terminals)

    await app.handle_message(session, {
        "id": "m1",
        "type": "manual_pane.unspawn",
        "payload": {"workspace_path": ws, "pane_id": "M1"},
    })

    assert terminals.killed == [("term-m", True)]
