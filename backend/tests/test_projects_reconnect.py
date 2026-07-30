"""ProjectStore.reconnect_pane_session — deterministic pane→transcript rebind.

Rewrites ONLY the target pane's session_id, leaves siblings untouched, and
raises on an unknown pane_id.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.projects import PaneRecord, ProjectStore


def _store_with_two_panes(ws: Path) -> ProjectStore:
    store = ProjectStore()
    project = store.load_or_create(str(ws))
    project.panes = [
        PaneRecord(pane_id="A", origin="manual", session_id="old-a"),
        PaneRecord(pane_id="B", origin="manual", session_id="keep-b"),
    ]
    store.save(project)
    return store


def test_rewrites_only_target_pane(tmp_path: Path) -> None:
    store = _store_with_two_panes(tmp_path)
    store.reconnect_pane_session(str(tmp_path), pane_id="A", session_id="new-a")

    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    by_id = {p.pane_id: p.session_id for p in fresh.panes}
    assert by_id == {"A": "new-a", "B": "keep-b"}


def test_raises_on_unknown_pane(tmp_path: Path) -> None:
    store = _store_with_two_panes(tmp_path)
    with pytest.raises(KeyError):
        store.reconnect_pane_session(str(tmp_path), pane_id="ghost", session_id="x")
