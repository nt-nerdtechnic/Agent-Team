"""PaneRecord.spawned_by: persistence and the re-key that keeps it alive.

pane_id is regenerated on every restart and re-linked through
previous_pane_id. A persisted spawned_by therefore points at an id that no
longer exists the moment its parent is restored — unless the children are
rewritten in the same save(). Storing the field without that rewrite is worse
than not storing it at all, because spawn-depth checks read the lineage and
would mis-count against dead pointers.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.projects import PaneRecord, ProjectStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


def _panes(store: ProjectStore, ws: str) -> dict[str, PaneRecord]:
    return {p.pane_id: p for p in store.peek(ws).panes}


def test_spawned_by_defaults_empty() -> None:
    assert PaneRecord(pane_id="x").spawned_by == ""


def test_spawned_by_round_trips(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="parent", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude",
                                   origin="mcp", spawned_by="parent")
    assert _panes(store, ws)["child"].spawned_by == "parent"


def test_omitted_spawned_by_does_not_orphan_a_child(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """Guarded like origin: a later call without the field keeps the parent."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude", spawned_by="parent")
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude")
    assert _panes(store, ws)["child"].spawned_by == "parent"


def test_restore_rekeys_children_to_the_parents_new_id(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """The core of this commit.

    Parent is restored under a fresh pane_id via previous_pane_id; the child's
    spawned_by must follow, not keep pointing at the retired id.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p-old", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="c1", agent="claude", spawned_by="p-old")
    store.record_manual_pane_spawn(ws, pane_id="c2", agent="claude", spawned_by="p-old")

    store.record_manual_pane_spawn(ws, pane_id="p-new", previous_pane_id="p-old",
                                   agent="claude")

    panes = _panes(store, ws)
    assert "p-old" not in panes, "the parent record was re-keyed, not duplicated"
    assert panes["c1"].spawned_by == "p-new"
    assert panes["c2"].spawned_by == "p-new"


def test_rekey_survives_a_second_restart(store_ws: tuple[ProjectStore, str]) -> None:
    """Two restarts in a row must not leave the child pointing at generation 1."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="c", agent="claude", spawned_by="p1")
    store.record_manual_pane_spawn(ws, pane_id="p2", previous_pane_id="p1", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="p3", previous_pane_id="p2", agent="claude")
    assert _panes(store, ws)["c"].spawned_by == "p3"


def test_rekey_drops_a_self_reference(store_ws: tuple[ProjectStore, str]) -> None:
    """A record must never become its own parent — the lineage walk would loop.

    This happens when a pane is re-keyed onto the id its own child already
    holds a pointer to.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="a", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="b", agent="claude", spawned_by="a")
    # 'b' is re-keyed onto 'a' — without the guard it would point at itself.
    store.record_manual_pane_spawn(ws, pane_id="a2", previous_pane_id="a", agent="claude")
    panes = _panes(store, ws)
    for pane in panes.values():
        assert pane.spawned_by != pane.pane_id, f"{pane.pane_id} is its own parent"


def test_pipeline_slot_rekey_also_moves_children(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """A pipeline pane has no parent, but it can be one (MCP spawn from inside
    it), so its re-key must move children too."""
    store, ws = store_ws
    store.start_pipeline(
        ws, task_description="t", total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="slot-old", agent="codex")
    store.record_manual_pane_spawn(ws, pane_id="kid", agent="claude",
                                   origin="mcp", spawned_by="slot-old")
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="slot-new", agent="codex")
    assert _panes(store, ws)["kid"].spawned_by == "slot-new"


def test_unrelated_lineages_are_untouched(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="p2", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="c1", agent="claude", spawned_by="p1")
    store.record_manual_pane_spawn(ws, pane_id="c2", agent="claude", spawned_by="p2")
    store.record_manual_pane_spawn(ws, pane_id="p1b", previous_pane_id="p1", agent="claude")
    panes = _panes(store, ws)
    assert panes["c1"].spawned_by == "p1b"
    assert panes["c2"].spawned_by == "p2", "an unrelated lineage must not move"
