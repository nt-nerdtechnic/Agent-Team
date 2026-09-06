"""Token/usage backfill keeps its own, wider scope than activity scanning.

One candidate set used to serve two consumers: _drain_loop ran the expensive
activity parse and then queued the same path for the token pass. So narrowing
the activity scope to workspaces that have a live pane (the cold-start flood
fix) also cut token backfill down to those workspaces — and the startup sweep
is token's only offline catch-up window, since watchdog only ever fires on a
later write. Worse, the very first sweep runs at delay=0 during backend
startup, before the frontend has connected and registered any pane at all, so
the scope is necessarily empty exactly when the catch-up should happen.

The fix is a second provider: one sweep, two lists. The token-only list goes
straight to _queue_token_path, never into the drain queue, so it costs zero
activity parsing.

None of this dispatch had any coverage before these tests — a green suite is
not evidence here, so every assertion below was mutation-checked against a
deliberately broken watcher.
"""

from __future__ import annotations

import asyncio
import time
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
        self.activity_calls: list[Path] = []
        self.enumerations: list[str | None] = []

    def _dir(self, workspace_path: str) -> Path:
        return self._root / workspace_path.strip("/").replace("/", "_")

    def project_dirs(self) -> list[Path]:
        return [self._root]

    def session_files(self) -> list[Path]:
        self.enumerations.append(None)
        return sorted(self._root.rglob("*.jsonl"))

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        self.enumerations.append(workspace_path)
        d = self._dir(workspace_path)
        return sorted(d.glob("*.jsonl")) if d.is_dir() else []

    def parse_activity(self, path: Path, seen_keys: set[str]) -> list[object]:
        self.activity_calls.append(path)
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return []


class _UnscopedReader(_ScopedReader):
    """A vendor that cannot narrow by workspace (Codex files by date; Grok,
    Kilo, Muse and OpenCode keep every session in one shared store)."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.vendor = "codex"

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        self.enumerations.append(workspace_path)
        return None


def _seed(root: Path, workspace_path: str, name: str) -> Path:
    d = root / workspace_path.strip("/").replace("/", "_")
    d.mkdir(parents=True, exist_ok=True)
    f = d / name
    f.write_text("{}\n")
    return f


def _watcher(
    reader: LogReader,
    *,
    activity: list[str] | None,
    token: list[str] | None,
) -> LogWatcher:
    w = LogWatcher(
        sink=_noop,
        activity_sink=_noop,
        workspace_provider=None if activity is None else (lambda: list(activity)),
        token_workspace_provider=None if token is None else (lambda: list(token)),
        rescan_interval_s=0.02,
    )
    w.add_reader(reader)
    return w


# ── (a) the token-only list covers workspaces with no pane ─────────────────


def test_token_scope_covers_a_workspace_with_no_pane(tmp_path: Path) -> None:
    """Break point 1 and 2, together.

    The activity scope is empty (startup: no pane has registered yet, or every
    pane in that workspace was closed / idle-reclaimed). Token backfill must
    still enumerate it — otherwise usage written while Navide was down is never
    picked up, indefinitely and silently.
    """
    reader = _ScopedReader(tmp_path)
    history = _seed(tmp_path, "/ws/history", "a.jsonl")

    w = _watcher(reader, activity=[], token=["/ws/history"])

    assert w._files_to_scan() == []  # noqa: SLF001
    assert w._token_only_files_to_scan() == [history]  # noqa: SLF001


def test_token_scope_still_covers_a_workspace_after_its_last_pane_closes(
    tmp_path: Path,
) -> None:
    """Break point 4: unregister_pane shrinks the activity scope immediately,
    not at the next restart. Usage must not go with it."""
    reader = _ScopedReader(tmp_path)
    live = _seed(tmp_path, "/ws/live", "a.jsonl")
    other = _seed(tmp_path, "/ws/other", "b.jsonl")

    active = ["/ws/live", "/ws/other"]
    w = _watcher(reader, activity=active, token=["/ws/live", "/ws/other"])
    activity_paths, token_paths = w._discover_sweep()  # noqa: SLF001
    assert sorted(activity_paths) == sorted([live, other])
    assert token_paths == []

    # The pane in /ws/other goes away; its file changes afterwards.
    active.remove("/ws/other")
    other.write_text('{"n": 2}\n')
    activity_paths, token_paths = w._discover_sweep()  # noqa: SLF001
    assert activity_paths == []
    assert token_paths == [other]


def test_no_token_provider_means_no_token_only_sweep(tmp_path: Path) -> None:
    """The default stays exactly what it was before this parameter existed."""
    reader = _ScopedReader(tmp_path)
    _seed(tmp_path, "/ws/history", "a.jsonl")

    w = _watcher(reader, activity=["/ws/live"], token=None)
    assert w._token_only_files_to_scan() == []  # noqa: SLF001
    assert w._discover_sweep()[1] == []  # noqa: SLF001


def test_an_empty_token_scope_scans_nothing_rather_than_everything(
    tmp_path: Path,
) -> None:
    """Same rule the activity scope follows: a configured-but-empty provider
    must not fall back to a full-disk scan."""
    reader = _ScopedReader(tmp_path)
    _seed(tmp_path, "/ws/history", "a.jsonl")

    w = _watcher(reader, activity=[], token=[])
    assert w._token_only_files_to_scan() == []  # noqa: SLF001


# ── (b) the token-only list costs no activity parsing ──────────────────────


async def _drive_rescan(w: LogWatcher, ready) -> list[Path]:
    """Run the rescan loop and the drain, without starting watchdog.

    start() would also subscribe the observer, and macOS FSEvents reports
    spurious modifications for a freshly created tree — that would smuggle
    paths into the drain queue by a route these tests are not about. Returns
    every path handed to _queue_token_path, in order.
    """
    queued: list[Path] = []
    orig = w._queue_token_path  # noqa: SLF001

    def spy(path: Path, replay_workspace: str = "") -> None:
        queued.append(path)
        orig(path, replay_workspace)

    w._queue_token_path = spy  # type: ignore[method-assign]  # noqa: SLF001
    w._loop = asyncio.get_running_loop()  # noqa: SLF001
    drain = asyncio.create_task(w._drain_loop())  # noqa: SLF001
    rescan = asyncio.create_task(w._rescan_loop())  # noqa: SLF001
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and not ready(queued):
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)  # let anything mis-routed catch up
    finally:
        for t in (rescan, drain):
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
    return queued


async def test_token_only_paths_never_reach_parse_activity(tmp_path: Path) -> None:
    """The whole point of the split.

    A rescan sweep with an empty activity scope and a populated token scope
    must hand the file to the token pass without a single parse_activity call
    and without an entry in _activity_seen. If the token-only list went onto
    the drain queue instead, this is the test that notices.
    """
    reader = _ScopedReader(tmp_path)
    history = _seed(tmp_path, "/ws/history", "a.jsonl")

    w = _watcher(reader, activity=[], token=["/ws/history"])
    queued = await _drive_rescan(w, lambda q: bool(q))

    assert queued == [history], "token-only candidate never reached the token pass"
    assert reader.activity_calls == [], (
        "a workspace with no pane must not pay for activity parsing"
    )
    assert w._activity_seen == {}  # noqa: SLF001


async def test_an_activity_scoped_path_still_reaches_parse_activity(
    tmp_path: Path,
) -> None:
    """The other half of the pair: the split must not starve activity.

    Without this, routing *everything* to the token-only path would leave the
    test above green.
    """
    reader = _ScopedReader(tmp_path)
    live = _seed(tmp_path, "/ws/live", "a.jsonl")

    w = _watcher(reader, activity=["/ws/live"], token=["/ws/live"])
    queued = await _drive_rescan(w, lambda q: bool(q))

    assert reader.activity_calls == [live]
    # Still reaches the token pass too — via the drain, as it always did.
    assert queued == [live]


# ── (c) ordering: activity is collected and queued first ───────────────────


def test_a_file_in_both_scopes_is_claimed_by_activity_not_by_token(
    tmp_path: Path,
) -> None:
    """Ordering is semantics, not style.

    The two passes share one `seen` set, and token-only paths bypass the drain
    queue. Collect the token list first and every overlapping file loses its
    activity events — silently, because nothing else observes it.
    """
    reader = _ScopedReader(tmp_path)
    live = _seed(tmp_path, "/ws/live", "a.jsonl")
    history = _seed(tmp_path, "/ws/history", "b.jsonl")

    w = _watcher(reader, activity=["/ws/live"], token=["/ws/live", "/ws/history"])
    activity_paths, token_paths = w._discover_sweep()  # noqa: SLF001

    assert activity_paths == [live]
    assert token_paths == [history], "the overlapping file must not be token-only"


async def test_the_overlapping_file_of_an_unscoped_vendor_keeps_its_activity(
    tmp_path: Path,
) -> None:
    """The shared-store vendors are the ones this ordering actually protects.

    Codex/Grok/Kilo/Muse/OpenCode return None from session_files_for_workspace,
    so their whole file list lands in *both* scopes. Reversed, every one of
    their files would go token-only and activity would stop entirely for those
    vendors.
    """
    reader = _UnscopedReader(tmp_path)
    shared = _seed(tmp_path, "/ws/live", "a.jsonl")

    w = _watcher(reader, activity=["/ws/live"], token=["/ws/live", "/ws/history"])
    activity_paths, token_paths = w._discover_sweep()  # noqa: SLF001
    assert activity_paths == [shared]
    assert token_paths == []


# ── the sweep is cheaper, not doubled ──────────────────────────────────────


def test_one_sweep_enumerates_each_reader_scope_once(tmp_path: Path) -> None:
    """The memo is what keeps two scopes from costing two walks.

    An unscoped reader falls back to its whole list for every workspace in
    every scope; without memoisation a 114-workspace token scope would walk the
    same tree 114 times, twice over.
    """
    reader = _UnscopedReader(tmp_path)
    _seed(tmp_path, "/ws/live", "a.jsonl")

    w = _watcher(reader, activity=["/ws/live"], token=["/ws/a", "/ws/b", "/ws/c"])
    reader.enumerations.clear()
    w._discover_sweep()  # noqa: SLF001

    assert reader.enumerations.count(None) == 1, (
        f"session_files() walked {reader.enumerations.count(None)} times in one sweep"
    )


def test_the_mtime_gate_applies_to_the_token_only_list(tmp_path: Path) -> None:
    """An unchanged file must not be re-queued every 30 seconds just because
    it now arrives through the token-only path."""
    reader = _ScopedReader(tmp_path)
    history = _seed(tmp_path, "/ws/history", "a.jsonl")

    w = _watcher(reader, activity=[], token=["/ws/history"])
    assert w._discover_sweep()[1] == [history]  # noqa: SLF001
    assert w._discover_sweep()[1] == []  # noqa: SLF001


# ── the wiring itself ──────────────────────────────────────────────────────


def test_the_backend_wires_the_token_scope_to_known_workspaces() -> None:
    """The one line that decides the token scope in production.

    Everything above runs against an explicit provider and stays green
    whichever one app.py passes; the wiring is the part those tests cannot see.
    Read structurally rather than by string match, mirroring the activity-scope
    guard in test_watcher_workspace_scope.
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

    providers = [
        k.value for k in calls[0].keywords if k.arg == "token_workspace_provider"
    ]
    assert len(providers) == 1, (
        "LogWatcher must be given an explicit token_workspace_provider; without "
        "it token backfill inherits the activity scope and stops covering "
        "workspaces with no live pane"
    )
    provider = providers[0]
    assert isinstance(provider, ast.Attribute), ast.dump(provider)
    assert isinstance(provider.value, ast.Name) and provider.value.id == "attribution"
    assert provider.attr == "known_workspaces", (
        f"token scope is wired to attribution.{provider.attr}; it must be "
        "known_workspaces (active_workspaces is empty at startup and shrinks "
        "when the last pane closes)"
    )
