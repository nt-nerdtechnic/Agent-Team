"""Per-pane view state: is_minimized (previously a dead path) and collapsed.

is_minimized had been sent by the renderer since the feature shipped, but no
handler and no field existed. backend.send is fire-and-forget, so nothing ever
surfaced — the state simply reset on every restart.

Both flags live on PaneRecord rather than in a Project-level id set, because
pane_id is regenerated on each restart: a set keyed by pane id would silently
empty itself and every subtree would come back expanded.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.projects import PaneRecord, ProjectStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


def test_flags_default_false() -> None:
    assert PaneRecord(pane_id="x").is_minimized is False
    assert PaneRecord(pane_id="x").collapsed is False


def test_set_pane_minimized_round_trips(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_minimized(ws, pane_id="p1", is_minimized=True)
    assert ProjectStore().peek(ws).panes[0].is_minimized is True


def test_set_pane_collapsed_round_trips(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_collapsed(ws, pane_id="p1", collapsed=True)
    assert ProjectStore().peek(ws).panes[0].collapsed is True


def test_flags_can_be_cleared(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_collapsed(ws, pane_id="p1", collapsed=True)
    store.set_pane_collapsed(ws, pane_id="p1", collapsed=False)
    store.set_pane_minimized(ws, pane_id="p1", is_minimized=True)
    store.set_pane_minimized(ws, pane_id="p1", is_minimized=False)
    pane = ProjectStore().peek(ws).panes[0]
    assert pane.collapsed is False
    assert pane.is_minimized is False


def test_the_two_flags_are_independent(store_ws: tuple[ProjectStore, str]) -> None:
    """Minimizing to the sidebar and folding a subtree are different actions."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_collapsed(ws, pane_id="p1", collapsed=True)
    pane = ProjectStore().peek(ws).panes[0]
    assert pane.collapsed is True
    assert pane.is_minimized is False


def test_unknown_pane_is_a_no_op(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_collapsed(ws, pane_id="nope", collapsed=True)
    store.set_pane_minimized(ws, pane_id="nope", is_minimized=True)
    pane = ProjectStore().peek(ws).panes[0]
    assert pane.collapsed is False
    assert pane.is_minimized is False


def test_flags_survive_a_re_key(store_ws: tuple[ProjectStore, str]) -> None:
    """The reason these live on PaneRecord: a restart hands the pane a new id,
    and the flag has to travel with the record rather than with the old id."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="old", agent="claude")
    store.set_pane_collapsed(ws, pane_id="old", collapsed=True)
    store.record_manual_pane_spawn(ws, pane_id="new", previous_pane_id="old",
                                   agent="claude")
    panes = {p.pane_id: p for p in ProjectStore().peek(ws).panes}
    assert "old" not in panes
    assert panes["new"].collapsed is True
