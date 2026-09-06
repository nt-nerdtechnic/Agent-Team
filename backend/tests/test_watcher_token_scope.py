"""Token/usage ingestion shares the activity scan's scope.

One candidate set serves both consumers: _drain_loop runs the activity parse
and then queues the same path for the token pass. When the activity scope was
narrowed to workspaces that have a live pane (the cold-start flood fix), token
backfill narrowed with it. That was briefly treated as damage and given a
second, wider provider of its own — and then reversed on a product decision:
usage is counted for what Navide is watching, and nothing else. A CLI run
while Navide was closed, or in a workspace with no live pane, is not counted.

What that decision costs, and why it is affordable: the ledger itself is
durable (tokens_store keeps per-workspace and global totals, plus a per-file
ingestion checkpoint), so nothing already counted is ever recounted or lost.
Only bytes written where Navide was not looking go uncounted. In exchange the
scan never has to walk a multi-GB history nobody asked to be re-read.

The one thing that decision does make load-bearing is the shutdown flush: with
no wide catch-up sweep, a coalesced token path that stop() throws away is not
found again by a later start. See drain_pending_tokens.

None of this dispatch had coverage before these tests — a green suite is not
evidence here, so every assertion was mutation-checked against a deliberately
broken watcher.
"""

from __future__ import annotations

import ast
import asyncio
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


def _seed(root: Path, workspace_path: str, name: str) -> Path:
    d = root / workspace_path.strip("/").replace("/", "_")
    d.mkdir(parents=True, exist_ok=True)
    f = d / name
    f.write_text("{}\n")
    return f


def _watcher(reader: LogReader, scope: list[str] | None) -> LogWatcher:
    w = LogWatcher(
        sink=_noop,
        activity_sink=_noop,
        workspace_provider=None if scope is None else (lambda: list(scope)),
        rescan_interval_s=0.02,
    )
    w.add_reader(reader)
    return w


# ── the scope is one list, and usage follows it ────────────────────────────

def test_a_workspace_with_no_pane_is_not_scanned_for_usage_either(tmp_path: Path) -> None:
    # The product decision, pinned: no live pane means Navide is not watching,
    # so that workspace's usage is not counted. A second, wider provider used
    # to exist purely to defeat this.
    reader = _ScopedReader(tmp_path)
    live = _seed(tmp_path, "/ws/live", "a.jsonl")
    _seed(tmp_path, "/ws/no-pane", "b.jsonl")

    w = _watcher(reader, ["/ws/live"])
    assert w._files_to_scan() == [live]  # noqa: SLF001


def test_one_sweep_enumerates_each_reader_scope_once(tmp_path: Path) -> None:
    # The memo is what keeps a single scope affordable: a reader tree is walked
    # once per sweep, not once per workspace that names it.
    reader = _ScopedReader(tmp_path)
    _seed(tmp_path, "/ws/a", "a.jsonl")
    _seed(tmp_path, "/ws/b", "b.jsonl")

    w = _watcher(reader, ["/ws/a", "/ws/b", "/ws/a"])
    reader.enumerations.clear()
    w._files_to_scan()  # noqa: SLF001
    assert sorted(x for x in reader.enumerations if x) == ["/ws/a", "/ws/b"]


def test_an_empty_scope_scans_nothing_rather_than_everything(tmp_path: Path) -> None:
    # The startup shape: the first sweep runs before any pane has registered.
    reader = _ScopedReader(tmp_path)
    _seed(tmp_path, "/ws/live", "a.jsonl")
    w = _watcher(reader, [])
    assert w._files_to_scan() == []  # noqa: SLF001


def test_the_mtime_gate_still_applies(tmp_path: Path) -> None:
    reader = _ScopedReader(tmp_path)
    live = _seed(tmp_path, "/ws/live", "a.jsonl")
    w = _watcher(reader, ["/ws/live"])
    assert w._files_to_scan() == [live]  # noqa: SLF001
    assert w._files_to_scan() == []  # unchanged mtime  # noqa: SLF001


# ── the shutdown flush the decision makes load-bearing ─────────────────────

async def test_shutdown_settles_coalesced_token_paths(tmp_path: Path) -> None:
    # Without the wide catch-up sweep, a path stop() throws away is not
    # rediscovered: its workspace may never have a live pane again.
    reader = _ScopedReader(tmp_path)
    path = _seed(tmp_path, "/ws/live", "a.jsonl")
    w = _watcher(reader, ["/ws/live"])
    w._started = True  # noqa: SLF001

    parsed: list[Path] = []

    async def _record(p: Path, replay_workspace: str = "") -> bool:
        parsed.append(p)
        return True

    w._process_token_path = _record  # type: ignore[method-assign]  # noqa: SLF001
    w._queue_token_path(path)  # noqa: SLF001

    await w.drain_pending_tokens()
    assert parsed == [path], "a pending token path must settle before shutdown"


async def test_shutdown_flush_is_a_no_op_when_never_started(tmp_path: Path) -> None:
    reader = _ScopedReader(tmp_path)
    w = _watcher(reader, ["/ws/live"])
    await w.drain_pending_tokens()  # must not raise


async def test_a_slow_shutdown_flush_is_capped_rather_than_hanging(tmp_path: Path) -> None:
    """The quit must end even if a transcript will not settle.

    drain_pending_tokens sits ahead of the git watcher, server link, MCP
    teardown and the database close. stop() used to be a synchronous cancel, so
    before the drain existed nothing here could block; a network mount or a
    locked sqlite store must not be able to hold a quit open.
    """
    import agent_team_backend.log_readers.watcher as watcher_mod

    reader = _ScopedReader(tmp_path)
    w = _watcher(reader, ["/ws/live"])
    w._started = True  # noqa: SLF001

    started = asyncio.Event()

    async def _never() -> None:
        started.set()
        await asyncio.sleep(3600)

    w._flush_pending_tokens = _never  # type: ignore[method-assign]  # noqa: SLF001
    original = watcher_mod._SHUTDOWN_FLUSH_TIMEOUT_S  # noqa: SLF001
    watcher_mod._SHUTDOWN_FLUSH_TIMEOUT_S = 0.05  # noqa: SLF001
    try:
        await asyncio.wait_for(w.drain_pending_tokens(), timeout=5)
    finally:
        watcher_mod._SHUTDOWN_FLUSH_TIMEOUT_S = original  # noqa: SLF001
    assert started.is_set(), "the flush must actually have been attempted"


async def test_a_failing_shutdown_flush_does_not_block_shutdown(tmp_path: Path) -> None:
    # Best-effort by design: quitting must not hang or crash on it.
    reader = _ScopedReader(tmp_path)
    w = _watcher(reader, ["/ws/live"])
    w._started = True  # noqa: SLF001

    async def _boom() -> None:
        raise RuntimeError("store gone")

    w._flush_pending_tokens = _boom  # type: ignore[method-assign]  # noqa: SLF001
    await w.drain_pending_tokens()  # swallowed


# ── wiring ─────────────────────────────────────────────────────────────────

def _log_watcher_call() -> ast.Call:
    src = Path(__file__).resolve().parents[1] / "agent_team_backend" / "app.py"
    tree = ast.parse(src.read_text())
    starters = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.AsyncFunctionDef) and n.name == "_start_log_watcher"
    ]
    assert len(starters) == 1
    calls = [
        n for n in ast.walk(starters[0])
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
        and n.func.id == "LogWatcher"
    ]
    assert len(calls) == 1
    return calls[0]


def test_the_backend_gives_the_watcher_exactly_one_scope() -> None:
    """No second provider. Reintroducing one is the whole reversed design."""
    kwargs = {k.arg for k in _log_watcher_call().keywords}
    assert "workspace_provider" in kwargs
    assert "token_workspace_provider" not in kwargs, (
        "usage is counted for what Navide watches; a second, wider token scope "
        "would silently reinstate walking every workspace ever opened"
    )


def test_the_backend_drains_pending_tokens_before_stopping_the_watcher() -> None:
    """Order is the whole point: stop() cancels the flush task."""
    src = Path(__file__).resolve().parents[1] / "agent_team_backend" / "app.py"
    tree = ast.parse(src.read_text())
    stoppers = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.AsyncFunctionDef) and n.name == "_stop_log_watcher"
    ]
    assert len(stoppers) == 1
    # By line number, and only calls on _log_watcher itself: ast.walk is
    # breadth-first (it would report a nested call before an earlier top-level
    # one), and this function also stops the git and credential watchers.
    lines: dict[str, int] = {}
    for node in ast.walk(stoppers[0]):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        recv = node.func.value
        if not (isinstance(recv, ast.Name) and recv.id == "_log_watcher"):
            continue
        if node.func.attr in {"drain_pending_tokens", "stop"}:
            lines.setdefault(node.func.attr, node.lineno)
    assert "drain_pending_tokens" in lines, "shutdown must settle pending token paths"
    assert "stop" in lines
    assert lines["drain_pending_tokens"] < lines["stop"], (
        "drain must run before stop(), which cancels the flush task"
    )
