"""Orphan adoption: a closing pane hands its children to its own parent.

Dropping the lineage instead would turn every child of a closed middle node
into a root, losing the relationship to the grandparent that still exists.

Adoption has to happen in the backend, in the same save() as the status
change: the renderer's pane list only covers one window, so children living
in a detached window or another run group would be missed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.projects import PaneRecord, Project, ProjectStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


def _panes(store: ProjectStore, ws: str) -> dict[str, PaneRecord]:
    return {p.pane_id: p for p in store.peek(ws).panes}


def _spawn_chain(store: ProjectStore, ws: str) -> None:
    """grandparent <- parent <- child"""
    store.record_manual_pane_spawn(ws, pane_id="gp", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="parent", agent="claude", spawned_by="gp")
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude", spawned_by="parent")


def test_child_is_adopted_by_the_grandparent(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    _spawn_chain(store, ws)
    store.record_manual_pane_unspawn(ws, pane_id="parent")
    assert _panes(store, ws)["child"].spawned_by == "gp"


def test_children_of_a_root_become_roots(store_ws: tuple[ProjectStore, str]) -> None:
    """A dying root has no parent to hand the children to."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="root", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="kid", agent="claude", spawned_by="root")
    store.record_manual_pane_unspawn(ws, pane_id="root")
    assert _panes(store, ws)["kid"].spawned_by == ""


def test_all_siblings_are_adopted(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="gp", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="parent", agent="claude", spawned_by="gp")
    for kid in ("k1", "k2", "k3"):
        store.record_manual_pane_spawn(ws, pane_id=kid, agent="claude", spawned_by="parent")
    store.record_manual_pane_unspawn(ws, pane_id="parent")
    panes = _panes(store, ws)
    assert [panes[k].spawned_by for k in ("k1", "k2", "k3")] == ["gp", "gp", "gp"]


def test_adoption_never_makes_a_pane_its_own_parent(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """child <- parent, and parent's own parent IS the child.

    Adoption would hand the child to itself; it must become a root instead.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="parent", agent="claude", spawned_by="child")
    project = store.peek(ws)
    next(p for p in project.panes if p.pane_id == "child").spawned_by = "parent"
    store.save(project)

    store.record_manual_pane_unspawn(ws, pane_id="parent")
    child = _panes(store, ws)["child"]
    assert child.spawned_by != "child"
    assert child.spawned_by == ""


def test_adoption_does_not_reintroduce_a_cycle(store_ws: tuple[ProjectStore, str]) -> None:
    """A pre-existing cycle must not survive adoption, and must not hang it."""
    store, ws = store_ws
    for pid in ("a", "b", "c"):
        store.record_manual_pane_spawn(ws, pane_id=pid, agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="kid", agent="claude", spawned_by="b")
    project = store.peek(ws)
    by_id = {p.pane_id: p for p in project.panes}
    by_id["a"].spawned_by = "b"
    by_id["b"].spawned_by = "c"
    by_id["c"].spawned_by = "a"          # a -> b -> c -> a
    store.save(project)

    store.record_manual_pane_unspawn(ws, pane_id="b")   # must terminate
    kid = _panes(store, ws)["kid"]
    assert kid.spawned_by in ("", "c"), f"unexpected parent {kid.spawned_by!r}"


def test_unrelated_panes_are_untouched(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    _spawn_chain(store, ws)
    store.record_manual_pane_spawn(ws, pane_id="other", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="other-kid", agent="claude",
                                   spawned_by="other")
    store.record_manual_pane_unspawn(ws, pane_id="parent")
    assert _panes(store, ws)["other-kid"].spawned_by == "other"


def test_pipeline_slot_unspawn_also_adopts(store_ws: tuple[ProjectStore, str]) -> None:
    """A pipeline pane can be a parent (MCP spawn from inside it), and it is
    closed through a different code path."""
    store, ws = store_ws
    store.start_pipeline(
        ws, task_description="t", total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    store.record_manual_pane_spawn(ws, pane_id="gp", agent="claude")
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="slot", agent="codex")
    project = store.peek(ws)
    next(p for p in project.panes if p.pane_id == "slot").spawned_by = "gp"
    store.save(project)
    store.record_manual_pane_spawn(ws, pane_id="kid", agent="claude",
                                   origin="mcp", spawned_by="slot")

    store.record_slot_unspawn(ws, stage_index=0, slot_label="Build")
    assert _panes(store, ws)["kid"].spawned_by == "gp"


def test_adoption_and_removal_land_in_one_save(store_ws: tuple[ProjectStore, str]) -> None:
    """No intermediate state where the parent is removed but children still
    point at it — both changes are in the same persisted document."""
    store, ws = store_ws
    _spawn_chain(store, ws)
    store.record_manual_pane_unspawn(ws, pane_id="parent")
    fresh = ProjectStore().peek(ws)          # re-read from disk
    by_id = {p.pane_id: p for p in fresh.panes}
    assert by_id["parent"].spawn_status == "removed"
    assert by_id["child"].spawned_by == "gp"
