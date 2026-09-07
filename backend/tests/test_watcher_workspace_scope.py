"""_candidate_files() honours the workspace_provider it was given.

This is the guard for the cold-start flood. The scan scope used to be every
workspace ever opened (attribution.known_workspaces, never pruned), so a cold
start re-parsed the whole CLI transcript corpus and broadcast an
agent.activity per entry — measured at ~800k messages over two minutes.
Narrowing the provider is the fix, and nothing else in backend/tests asserts
this dispatch: test_watcher_offloop_discovery replaces _files_to_scan with a
spy and only checks which thread it ran on. Without these tests the change is
invisible to the suite.
"""

from __future__ import annotations

from pathlib import Path

from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.log_readers.watcher import LogWatcher


async def _noop(_usage: TokenUsage) -> None:
    return None


class _ScopedReader(LogReader):
    """A reader whose on-disk layout maps a workspace to its own folder."""

    def __init__(self, root: Path) -> None:
        self.vendor = "claude"
        self._root = root

    def _dir(self, workspace_path: str) -> Path:
        return self._root / workspace_path.strip("/").replace("/", "_")

    def project_dirs(self) -> list[Path]:
        return [self._root]

    def session_files(self) -> list[Path]:
        return sorted(self._root.rglob("*.jsonl"))

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        d = self._dir(workspace_path)
        return sorted(d.glob("*.jsonl")) if d.is_dir() else []

    def parse_session_file(self, path: Path) -> object:  # pragma: no cover
        raise NotImplementedError


class _UnscopedReader(_ScopedReader):
    """A vendor that cannot map a workspace to a subset (Codex stores by date)."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.vendor = "codex"

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        return None


def _seed(root: Path, workspace_path: str, name: str) -> Path:
    d = root / workspace_path.strip("/").replace("/", "_")
    d.mkdir(parents=True, exist_ok=True)
    f = d / name
    f.write_text("{}\n")
    return f


def _watcher(root: Path, scope: list[str], reader: LogReader) -> LogWatcher:
    w = LogWatcher(sink=_noop, workspace_provider=lambda: list(scope))
    w.add_reader(reader)
    return w


def test_only_the_provided_workspaces_are_enumerated(tmp_path: Path) -> None:
    reader = _ScopedReader(tmp_path)
    live = _seed(tmp_path, "/ws/live", "a.jsonl")
    _seed(tmp_path, "/ws/history", "b.jsonl")

    w = _watcher(tmp_path, ["/ws/live"], reader)
    assert w._candidate_files() == [live]  # noqa: SLF001


def test_a_workspace_dropped_from_the_scope_stops_being_enumerated(tmp_path: Path) -> None:
    # The live case: closing the last pane in a workspace takes it out of scope
    # on the very next sweep, not at the next restart.
    reader = _ScopedReader(tmp_path)
    live = _seed(tmp_path, "/ws/live", "a.jsonl")
    other = _seed(tmp_path, "/ws/other", "b.jsonl")

    scope = ["/ws/live", "/ws/other"]
    w = _watcher(tmp_path, scope, reader)
    assert w._candidate_files() == [live, other]  # noqa: SLF001

    scope.remove("/ws/other")
    assert w._candidate_files() == [live]  # noqa: SLF001


def test_an_empty_scope_scans_nothing_rather_than_everything(tmp_path: Path) -> None:
    # The startup shape: the first sweep runs before any pane has registered.
    # It must not fall back to a full-disk scan — that is the flood.
    reader = _ScopedReader(tmp_path)
    _seed(tmp_path, "/ws/live", "a.jsonl")
    _seed(tmp_path, "/ws/history", "b.jsonl")

    w = _watcher(tmp_path, [], reader)
    assert w._candidate_files() == []  # noqa: SLF001


def test_no_provider_still_scans_everything(tmp_path: Path) -> None:
    # The legacy path stays untouched: a caller that supplies no provider is
    # asking for the full list and still gets it.
    reader = _ScopedReader(tmp_path)
    a = _seed(tmp_path, "/ws/live", "a.jsonl")
    b = _seed(tmp_path, "/ws/history", "b.jsonl")

    w = LogWatcher(sink=_noop)
    w.add_reader(reader)
    assert sorted(w._candidate_files()) == sorted([a, b])  # noqa: SLF001


def test_a_reader_that_cannot_scope_still_contributes_its_whole_list(tmp_path: Path) -> None:
    # Documented fallback: session_files_for_workspace returning None means
    # "can't scope by path", and those vendors keep far fewer files. Pinning it
    # so narrowing the provider is never mistaken for narrowing every vendor.
    reader = _UnscopedReader(tmp_path)
    a = _seed(tmp_path, "/ws/live", "a.jsonl")
    b = _seed(tmp_path, "/ws/history", "b.jsonl")

    w = _watcher(tmp_path, ["/ws/live"], reader)
    assert sorted(w._candidate_files()) == sorted([a, b])  # noqa: SLF001


def test_a_file_shared_by_two_workspaces_is_listed_once(tmp_path: Path) -> None:
    reader = _ScopedReader(tmp_path)
    shared = _seed(tmp_path, "/ws/live", "a.jsonl")

    w = _watcher(tmp_path, ["/ws/live", "/ws/live"], reader)
    assert w._candidate_files() == [shared]  # noqa: SLF001


def test_the_backend_wires_the_activity_scope_to_active_workspaces() -> None:
    """The one line that decides the scope in production.

    _candidate_files is tested above against an explicit provider, so those
    tests stay green whichever provider app.py passes — the wiring is the part
    they cannot see. Starting the real app to read it back would drag in the
    whole startup handler, so this reads the call site structurally instead of
    by string match: find the LogWatcher(...) construction inside
    _start_log_watcher and assert what its workspace_provider is bound to.

    known_workspaces is every workspace ever opened and is never pruned; using
    it here is what made a cold start re-parse the whole transcript corpus.
    """
    import ast
    from pathlib import Path as _Path

    src = _Path(__file__).resolve().parents[1] / "agent_team_backend" / "app.py"
    tree = ast.parse(src.read_text())

    starters = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.AsyncFunctionDef) and n.name == "_start_log_watcher"
    ]
    assert len(starters) == 1, "expected exactly one _start_log_watcher"

    calls = [
        n for n in ast.walk(starters[0])
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name)
        and n.func.id == "LogWatcher"
    ]
    assert len(calls) == 1, "expected exactly one LogWatcher construction"

    providers = [k.value for k in calls[0].keywords if k.arg == "workspace_provider"]
    assert len(providers) == 1, "LogWatcher must be given an explicit workspace_provider"
    provider = providers[0]
    assert isinstance(provider, ast.Attribute), ast.dump(provider)
    assert isinstance(provider.value, ast.Name) and provider.value.id == "attribution"
    assert provider.attr == "active_workspaces", (
        f"activity scope is wired to attribution.{provider.attr}; "
        "it must be active_workspaces (known_workspaces is never pruned)"
    )


async def test_a_watchdog_delivered_path_is_processed_outside_the_scope(tmp_path: Path) -> None:
    """Narrowing the scope must not narrow live detection.

    The scope only bounds the periodic/startup backfill sweep. Live events
    arrive through watchdog, which subscribes reader watch roots
    (_watch_new_dirs -> reader.watch_dirs(), no workspace provider anywhere in
    that path), so a file being written right now still reaches parse_activity
    even when no workspace is in scope at all. Without this test, tightening the
    scope could silently kill activity badges and messaging and every other test
    would stay green.
    """
    seen: list[Path] = []

    class _Recording(_ScopedReader):
        def parse_activity(self, path: Path, seen_keys: set[str]) -> list[object]:
            seen.append(path)
            return []

    reader = _Recording(tmp_path)
    live = _seed(tmp_path, "/ws/not-in-scope", "a.jsonl")

    w = LogWatcher(sink=_noop, activity_sink=_noop, workspace_provider=lambda: [])
    w.add_reader(reader)

    assert w._candidate_files() == []           # noqa: SLF001  — nothing in scope
    await w._process_realtime_path(live)        # noqa: SLF001  — what watchdog calls
    assert seen == [live], "a live file must still be parsed when its workspace is out of scope"
