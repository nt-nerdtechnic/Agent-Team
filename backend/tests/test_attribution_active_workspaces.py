"""active_workspaces(): the scanning scope for activity.

known_workspaces() is every workspace ever opened and is never pruned — it
exists so historic usage can still be attributed. Using it as the scan scope
made a cold start re-parse every transcript on the machine and broadcast an
agent.activity per entry. These tests pin the narrower list the activity scan
uses instead, and the lifecycle that keeps it narrow.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import LogReader


class _Reader(LogReader):
    def __init__(self, vendor: str, root: Path) -> None:
        self.vendor = vendor
        self._root = root

    def project_dirs(self) -> list[Path]:
        return [self._root]

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path) -> object:  # pragma: no cover
        raise NotImplementedError


@pytest.fixture
def attr(tmp_path: Path) -> Attribution:
    root = tmp_path / "claude_projects"
    root.mkdir()
    return Attribution([_Reader("claude", root)], workspaces_path=tmp_path / "ws.json")


def _pane(attr: Attribution, pane_id: str, workspace: str) -> None:
    attr.register_pane(pane_id, vendor="claude", cwd=workspace, workspace_path=workspace)


def test_empty_before_any_pane_registers(attr: Attribution) -> None:
    # The intended startup shape: the watcher's first sweep runs before the
    # frontend has connected, so the scope is empty and nothing is scanned.
    attr.register_workspace("/ws/a")
    assert attr.known_workspaces() == ["/ws/a"]
    assert attr.active_workspaces() == []


def test_a_registered_pane_puts_its_workspace_in_scope(attr: Attribution) -> None:
    _pane(attr, "p1", "/ws/a")
    assert attr.active_workspaces() == ["/ws/a"]


def test_several_panes_in_one_workspace_appear_once(attr: Attribution) -> None:
    _pane(attr, "p1", "/ws/a")
    _pane(attr, "p2", "/ws/a")
    assert attr.active_workspaces() == ["/ws/a"]


def test_scope_shrinks_when_the_last_pane_goes(attr: Attribution) -> None:
    # unregister_pane fires on terminal kill, pane unspawn and idle reclaim, so
    # the scope tracks live panes rather than the session's history.
    _pane(attr, "p1", "/ws/a")
    _pane(attr, "p2", "/ws/b")
    attr.unregister_pane("p1")
    assert attr.active_workspaces() == ["/ws/b"]
    attr.unregister_pane("p2")
    assert attr.active_workspaces() == []


def test_a_reclaimed_pane_comes_back_into_scope_when_it_re_registers(attr: Attribution) -> None:
    # Idle reclaim degrades a pane to a placeholder and kills its PTY, which
    # unregisters it. Restoring the pane must put its workspace back in scope.
    _pane(attr, "p1", "/ws/a")
    attr.unregister_pane("p1")
    assert attr.active_workspaces() == []
    _pane(attr, "p1", "/ws/a")
    assert attr.active_workspaces() == ["/ws/a"]


def test_history_does_not_leak_into_the_active_list(attr: Attribution) -> None:
    # The whole point: a workspace opened once, months ago, with nothing running
    # in it now, must not drag its transcripts into the scan.
    attr.register_workspace("/ws/history-1")
    attr.register_workspace("/ws/history-2")
    _pane(attr, "p1", "/ws/live")
    assert attr.known_workspaces() == ["/ws/history-1", "/ws/history-2", "/ws/live"]
    assert attr.active_workspaces() == ["/ws/live"]


def test_pane_registered_with_only_a_cwd_still_scopes(attr: Attribution) -> None:
    # register_pane falls back to cwd when workspace_path is empty; the scope
    # has to follow that same rule or those panes would be invisible to it.
    attr.register_pane("p1", vendor="claude", cwd="/ws/from-cwd")
    assert attr.active_workspaces() == ["/ws/from-cwd"]


def test_sorted_like_known_workspaces(attr: Attribution) -> None:
    # Same shape as known_workspaces so either can be handed to the watcher's
    # workspace_provider without the caller caring which it got.
    _pane(attr, "p1", "/ws/c")
    _pane(attr, "p2", "/ws/a")
    _pane(attr, "p3", "/ws/b")
    assert attr.active_workspaces() == ["/ws/a", "/ws/b", "/ws/c"]
