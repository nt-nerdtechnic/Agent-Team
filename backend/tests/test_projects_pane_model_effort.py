"""PaneRecord.model / .effort: the per-pane CLI model + reasoning-effort pick.

These persist the choice made at spawn time so a restored pane comes back on
the same model instead of silently falling back to the vendor default.

Both fields follow the *guarded* write semantics of `origin` / `session_id`
(``if value: pane.field = value``) rather than the unconditional one used for
``command``. The rebuild path re-spawns an existing record with empty values,
so an unconditional write would erase the user's pick on every restart —
``test_empty_model_does_not_erase_an_existing_pick`` is the behavioral proof.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.projects import PaneRecord, ProjectStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


def _pane(store: ProjectStore, ws: str, pane_id: str) -> PaneRecord:
    project = store.peek(ws)
    assert project is not None
    return next(p for p in project.panes if p.pane_id == pane_id)


# ── dataclass defaults ───────────────────────────────────────────────────────

def test_pane_record_model_and_effort_default_to_empty() -> None:
    """Empty string is the "unspecified" sentinel the whole contract rests on."""
    pane = PaneRecord(pane_id="x")
    assert pane.model == ""
    assert pane.effort == ""


# ── 1. round trip through the store ──────────────────────────────────────────

def test_model_and_effort_survive_a_fresh_store_reload(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """spawn(model, effort) -> persisted -> a *different* store reads it back.

    A second ProjectStore shares no in-memory state with the first, so this
    only passes if the values really went through serialization into the
    workspace's on-disk project document and back out via from_dict. That is
    the exact path pane restore takes after an App restart.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(
        ws, pane_id="p1", agent="claude", model="opus-4", effort="high"
    )

    reloaded = _pane(ProjectStore(), ws, "p1")
    assert reloaded.model == "opus-4"
    assert reloaded.effort == "high"


def test_stored_document_carries_the_new_keys(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """The serialized pane dict must contain the agreed cross-layer key names.

    _project_payload uses asdict(), so these dict keys are what the frontend
    receives; a rename on either side would break restore silently.
    """
    store, ws = store_ws
    project = store.record_manual_pane_spawn(
        ws, pane_id="p1", agent="claude", model="gpt-5", effort="low"
    )
    pane_dict = next(p for p in project.to_dict()["panes"] if p["pane_id"] == "p1")
    assert pane_dict["model"] == "gpt-5"
    assert pane_dict["effort"] == "low"


# ── 2. guarded write: an empty value must not erase an existing pick ─────────

def test_empty_model_does_not_erase_an_existing_pick(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """The behavioral proof of "write only when non-empty".

    Flip the assignment to an unconditional `pane.model = model` (the style
    used for `command`) and this test goes red: the second call, which is what
    the rebuild path issues, would blank the record.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(
        ws, pane_id="p1", agent="claude", model="opus-4", effort="high"
    )
    # A rebuild hop: same pane, no model/effort in the payload.
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", command="claude")

    pane = _pane(store, ws, "p1")
    assert pane.model == "opus-4"
    assert pane.effort == "high"
    assert pane.command == "claude", "unguarded fields must still be written"


def test_a_new_non_empty_value_replaces_the_old_one(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """The guard must not freeze the field: a real re-pick still lands.

    Without this, "never overwrite" would pass test 2 while making the model
    picker permanently sticky after the first choice.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", model="opus-4",
                                   effort="high")
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", model="sonnet-4",
                                   effort="low")

    pane = _pane(store, ws, "p1")
    assert pane.model == "sonnet-4"
    assert pane.effort == "low"


def test_the_pick_survives_a_pane_id_rekey(store_ws: tuple[ProjectStore, str]) -> None:
    """Restore re-keys a record via previous_pane_id and passes no model.

    This is the concrete production shape of the erase bug: the pane comes back
    under a fresh id, and the choice has to travel with it.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="old", agent="claude", model="opus-4",
                                   effort="high", session_id="s1")
    store.record_manual_pane_spawn(ws, pane_id="new", previous_pane_id="old",
                                   agent="claude", session_id="s1")

    pane = _pane(store, ws, "new")
    assert pane.model == "opus-4"
    assert pane.effort == "high"


# ── 3. backward compatibility with callers that never pass the fields ────────

def test_legacy_call_without_model_or_effort_is_unchanged(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """Every pre-existing call site omits both arguments; nothing may shift.

    Asserts the whole record, not just the new fields, so a default that
    accidentally leaks into another column is caught.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(
        ws, pane_id="p1", agent="claude", role="eng", command="claude",
        session_id="s1", run_group_id="g1", origin="mcp",
    )
    pane = _pane(store, ws, "p1")

    assert pane.model == ""
    assert pane.effort == ""
    assert (pane.agent, pane.role, pane.command) == ("claude", "eng", "claude")
    assert (pane.session_id, pane.run_group_id) == ("s1", "g1")
    assert pane.origin == "mcp"
    assert pane.spawn_status == "spawned"


def test_a_document_written_before_the_fields_existed_still_loads(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """No migration is needed: from_dict filters on __dataclass_fields__, so an
    old pane dict with no model/effort keys must load with the defaults."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")

    project = store.peek(ws)
    assert project is not None
    doc = project.to_dict()
    for pane_dict in doc["panes"]:
        pane_dict.pop("model", None)
        pane_dict.pop("effort", None)

    from agent_team_backend.projects import Project
    restored = Project.from_dict(doc)
    pane = next(p for p in restored.panes if p.pane_id == "p1")
    assert pane.model == ""
    assert pane.effort == ""


# ── 4. the manual_pane.spawn WS handler forwards both fields ─────────────────

class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> "app.Session":
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_spawn_handler_forwards_model_and_effort(tmp_path: Path) -> None:
    """A manual_pane.spawn message carrying model/effort must reach the record.

    Checked through observable state (the response payload plus the persisted
    document) rather than by inspecting the call, so this stays true regardless
    of how the handler threads the values through.
    """
    ws = str(tmp_path)
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "manual_pane.spawn",
        "payload": {
            "workspace_path": ws, "pane_id": "P1", "agent": "claude",
            "command": "claude", "model": "opus-4", "effort": "high",
        },
    })

    panes = session.websocket.sent[0]["payload"]["project"]["panes"]  # type: ignore[attr-defined]
    assert [(p["model"], p["effort"]) for p in panes] == [("opus-4", "high")]
    assert _pane(ProjectStore(), ws, "P1").model == "opus-4"


@pytest.mark.asyncio
async def test_spawn_handler_omitting_model_keeps_the_stored_pick(
    tmp_path: Path
) -> None:
    """End-to-end shape of the rebuild path: the second message has no model."""
    ws = str(tmp_path)
    await app.handle_message(_session(), {
        "id": "m1", "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude",
                    "model": "opus-4", "effort": "high"},
    })
    second = _session()
    await app.handle_message(second, {
        "id": "m2", "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude",
                    "command": "claude"},
    })

    panes = second.websocket.sent[0]["payload"]["project"]["panes"]  # type: ignore[attr-defined]
    assert [(p["model"], p["effort"]) for p in panes] == [("opus-4", "high")]


@pytest.mark.asyncio
async def test_spawn_handler_tolerates_a_null_model(tmp_path: Path) -> None:
    """A JSON `null` from the frontend must behave like "unspecified", not
    write None into a str field."""
    ws = str(tmp_path)
    session = _session()
    await app.handle_message(session, {
        "id": "m1", "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude",
                    "model": None, "effort": None},
    })

    panes = session.websocket.sent[0]["payload"]["project"]["panes"]  # type: ignore[attr-defined]
    assert [(p["model"], p["effort"]) for p in panes] == [("", "")]
