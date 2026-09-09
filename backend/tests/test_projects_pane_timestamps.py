"""PaneRecord.spawned_at / .removed_at: when a pane record was born and closed.

Agent History showed every entry with the same timestamp because PaneRecord
carried no time of its own — the frontend fell back to the project's
``updated_at``, which is rewritten on every save. These two fields are the
real times, written by the same code that flips ``spawn_status``.

Semantics the tests below pin down:
  - ``spawned_at`` is set ONCE. A rebuild hop re-spawns an existing record, and
    the pane the user is looking at started at the original time, not that hop.
  - ``removed_at`` is overwritten on each removal; only the last one is real.
  - "" means unknown (a record written before the fields existed). It is never
    back-filled with now() — a fabricated time is worse than a dash in the UI.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend import projects as projects_mod
from agent_team_backend.projects import PaneRecord, Project, ProjectStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


@pytest.fixture
def ticking_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """A distinct timestamp per call — _now_iso only has second resolution, so
    two writes inside one test would otherwise be indistinguishable."""
    ticks = iter(f"2026-09-09T00:00:{i:02d}Z" for i in range(60))
    monkeypatch.setattr(projects_mod, "_now_iso", lambda: next(ticks))


def _pane(store: ProjectStore, ws: str, pane_id: str) -> PaneRecord:
    project = store.peek(ws)
    assert project is not None
    return next(p for p in project.panes if p.pane_id == pane_id)


@pytest.fixture
def store_with_stage(tmp_path: Path) -> tuple[ProjectStore, str]:
    ws = str(tmp_path)
    store = ProjectStore()
    store.start_pipeline(
        ws,
        task_description="t",
        total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    return store, ws


# ── dataclass defaults ───────────────────────────────────────────────────────

def test_pane_record_timestamps_default_to_empty() -> None:
    pane = PaneRecord(pane_id="x")
    assert pane.spawned_at == ""
    assert pane.removed_at == ""


# ── manual panes ─────────────────────────────────────────────────────────────

def test_manual_spawn_stamps_spawned_at(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    pane = _pane(store, ws, "p1")
    assert pane.spawned_at != ""
    assert pane.removed_at == ""


def test_second_spawn_marking_does_not_overwrite_spawned_at(
    store_ws: tuple[ProjectStore, str], ticking_clock: None
) -> None:
    """The rebuild hop keeps the original birth time."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", session_id="s1")
    first = _pane(store, ws, "p1").spawned_at

    store.record_manual_pane_spawn(ws, pane_id="p2", previous_pane_id="p1",
                                   agent="claude", session_id="s1")
    assert _pane(store, ws, "p2").spawned_at == first


def test_manual_unspawn_stamps_removed_at(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.record_manual_pane_unspawn(ws, pane_id="p1")
    pane = _pane(store, ws, "p1")
    assert pane.removed_at != ""
    assert pane.spawned_at != ""  # removal does not clear the birth time


def test_retiring_a_duplicate_session_stamps_removed_at(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """A rebuild hop retires the other record sharing its session; that record
    is removed too, so it needs its own removal time."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="ghost", agent="claude", session_id="s1")
    store.record_manual_pane_spawn(ws, pane_id="live", agent="claude", session_id="s1")
    store.record_manual_pane_spawn(ws, pane_id="rebuilt", previous_pane_id="live",
                                   agent="claude", session_id="s1")

    ghost = _pane(store, ws, "ghost")
    assert ghost.spawn_status == "removed"
    assert ghost.removed_at != ""


# ── pipeline slots ───────────────────────────────────────────────────────────

def test_slot_spawn_and_unspawn_stamp_both_fields(
    store_with_stage: tuple[ProjectStore, str], ticking_clock: None
) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="codex")
    spawned = _pane(store, ws, "pane-1").spawned_at
    assert spawned != ""

    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="codex")
    assert _pane(store, ws, "pane-1").spawned_at == spawned  # set once

    store.record_slot_unspawn(ws, stage_index=0, slot_label="Build")
    pane = _pane(store, ws, "pane-1")
    assert pane.removed_at != ""
    assert pane.spawned_at == spawned


# ── persistence / backward compatibility ─────────────────────────────────────

def test_timestamps_survive_a_fresh_store_reload(store_ws: tuple[ProjectStore, str]) -> None:
    """A second ProjectStore shares no in-memory state, so this only passes if
    both fields went through the workspace document and back."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.record_manual_pane_unspawn(ws, pane_id="p1")
    expected = _pane(store, ws, "p1")

    reloaded = _pane(ProjectStore(), ws, "p1")
    assert reloaded.spawned_at == expected.spawned_at
    assert reloaded.removed_at == expected.removed_at


def test_old_pane_records_without_the_keys_load_as_unknown() -> None:
    """Documents written before these fields existed stay empty — no now()."""
    legacy = {
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
        "panes": [{"pane_id": "old", "agent": "claude", "spawn_status": "spawned"}],
    }
    restored = Project.from_dict(legacy)
    assert restored.panes[0].spawned_at == ""
    assert restored.panes[0].removed_at == ""


def test_timestamps_round_trip_through_project_dict() -> None:
    proj = Project(id="p", name="n", workspace_path="/ws", created_at="t", updated_at="t")
    proj.panes = [PaneRecord(pane_id="x", spawned_at="2026-09-09T01:00:00Z",
                             removed_at="2026-09-09T02:00:00Z")]
    restored = Project.from_dict(proj.to_dict())
    assert restored.panes[0].spawned_at == "2026-09-09T01:00:00Z"
    assert restored.panes[0].removed_at == "2026-09-09T02:00:00Z"
