"""existing_workspace_roots(): the allowlist skips roots that are gone.

The workspace registry is never pruned — it is also what historic usage is
attributed against — so on a real install a third of its entries point at
folders that no longer exist. Every path-allowlist check (plugin terminal.run,
shell.run) rebuilt the whole list with Path.resolve() on every call, spending
most of that on roots nothing can be inside of.

The property these tests exist to hold: filtering can only make the allowlist
SMALLER. A security check may reject more after this change; it must never
permit more.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import LogReader


class _Reader(LogReader):
    def __init__(self, root: Path) -> None:
        self.vendor = "claude"
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
    return Attribution([_Reader(root)], workspaces_path=tmp_path / "ws.json")


def test_a_live_workspace_is_kept(attr: Attribution, tmp_path: Path) -> None:
    live = tmp_path / "live"
    live.mkdir()
    attr.register_workspace(str(live))
    assert attr.existing_workspace_roots() == [live.resolve()]


def test_a_workspace_whose_folder_is_gone_is_skipped(attr: Attribution, tmp_path: Path) -> None:
    gone = tmp_path / "deleted-project"
    gone.mkdir()
    attr.register_workspace(str(gone))
    gone.rmdir()

    assert attr.known_workspaces() == [str(gone)], "the registry itself must not be pruned"
    assert attr.existing_workspace_roots() == [], "a gone root still reached the allowlist"


def test_a_file_path_is_not_a_root(attr: Attribution, tmp_path: Path) -> None:
    # Registered paths are folders; anything else cannot contain a cwd.
    f = tmp_path / "not-a-dir"
    f.write_text("x")
    attr.register_workspace(str(f))
    assert attr.existing_workspace_roots() == []


def test_filtering_only_ever_narrows(attr: Attribution, tmp_path: Path) -> None:
    """The security property, stated as an assertion.

    Whatever survives the filter must have been in the unfiltered list, so a
    path that used to be refused can never start being allowed.
    """
    live = tmp_path / "live"
    live.mkdir()
    gone = tmp_path / "gone"
    gone.mkdir()
    attr.register_workspace(str(live))
    attr.register_workspace(str(gone))
    gone.rmdir()

    before = {Path(w).resolve() for w in attr.known_workspaces()}
    after = set(attr.existing_workspace_roots())
    assert after <= before, "the filter introduced a root that was never registered"
    assert live.resolve() in after


def test_the_registry_is_untouched_by_the_filter(attr: Attribution, tmp_path: Path) -> None:
    """Pruning the registry would break historic usage attribution and shrink
    the plugin allowlist for good; only the per-call view is filtered."""
    gone = tmp_path / "gone"
    gone.mkdir()
    attr.register_workspace(str(gone))
    gone.rmdir()

    attr.existing_workspace_roots()
    assert attr.known_workspaces() == [str(gone)]


def test_one_unreadable_root_does_not_break_the_others(
    attr: Attribution, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A root on a wedged mount raises rather than answering; it must be
    treated as absent instead of taking the whole allowlist down with it."""
    live = tmp_path / "live"
    live.mkdir()
    wedged = tmp_path / "wedged"
    wedged.mkdir()
    attr.register_workspace(str(live))
    attr.register_workspace(str(wedged))

    real_resolve = Path.resolve

    def _resolve(self: Path, *a: object, **k: object) -> Path:
        if self.name == "wedged":
            raise OSError("host is down")
        return real_resolve(self, *a, **k)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "resolve", _resolve)
    assert attr.existing_workspace_roots() == [live.resolve()]
