"""ProjectStore.set_pane_stopped — STOP badge persistence for project.panes.

Covers the round-trip of the new PaneRecord.stopped field (asdict/from_dict),
backward compatibility (old project.json without the key loads as False),
set/clear, and no-op for an unknown pane_id.
"""

from __future__ import annotations

from pathlib import Path

from agent_team_backend.projects import PaneRecord, Project, ProjectStore


def _store_with_pane(ws: Path, pane_id: str, *, stopped: bool = False) -> ProjectStore:
    store = ProjectStore()
    project = store.load_or_create(str(ws))
    project.panes = [PaneRecord(pane_id=pane_id, origin="manual", stopped=stopped)]
    store.save(project)
    return store


def test_pane_record_round_trips_stopped(tmp_path: Path) -> None:
    store = _store_with_pane(tmp_path, "a", stopped=True)
    project = store.peek(str(tmp_path))
    assert project is not None
    restored = Project.from_dict(project.to_dict())
    assert restored.panes[0].stopped is True


def test_project_json_without_stopped_loads_as_false(tmp_path: Path) -> None:
    """Old records predate the field; from_dict filters unknown keys, so a dict
    missing `stopped` must default to False (never raise)."""
    store = _store_with_pane(tmp_path, "a", stopped=True)
    data = store.peek(str(tmp_path)).to_dict()  # type: ignore[union-attr]
    for pane in data["panes"]:
        pane.pop("stopped", None)
    restored = Project.from_dict(data)
    assert restored.panes[0].stopped is False


def test_set_pane_stopped_sets_and_clears(tmp_path: Path) -> None:
    store = _store_with_pane(tmp_path, "a")

    store.set_pane_stopped(str(tmp_path), pane_id="a", stopped=True)
    reloaded = ProjectStore().peek(str(tmp_path))
    assert reloaded is not None
    assert reloaded.panes[0].stopped is True

    store.set_pane_stopped(str(tmp_path), pane_id="a", stopped=False)
    reloaded = ProjectStore().peek(str(tmp_path))
    assert reloaded is not None
    assert reloaded.panes[0].stopped is False


def test_set_pane_stopped_is_noop_for_unknown_pane(tmp_path: Path) -> None:
    store = _store_with_pane(tmp_path, "a")
    store.set_pane_stopped(str(tmp_path), pane_id="ghost", stopped=True)
    reloaded = ProjectStore().peek(str(tmp_path))
    assert reloaded is not None
    assert reloaded.panes[0].stopped is False
