"""File-system watcher that polls registered LogReaders for new token events.

Uses `watchdog` for change notifications, with a periodic full-rescan
fallback (default 30s) to recover from missed events (network mounts,
edge-case file ops). Token readers resume from compact per-file checkpoints
owned by TokensStore; the watcher itself persists no token dedup state.

Architecture:

    LogWatcher.start()
        ├─ observer (watchdog Observer) — async file events → enqueue(path)
        ├─ rescan loop (asyncio) — every N s → enqueue all session files
        └─ drain loop (asyncio) — pop queue → reader.parse_incremental()
                                            → emit each TokenUsage to sink

The sink callback runs on the asyncio loop. It MUST be fast (just enqueue
to tokens_store + broadcast); long work blocks the drain.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from .base import ActivityEvent, LogReader, TokenSinkResult, TokenUsage

log = logging.getLogger("agent_team_backend.log_readers.watcher")

TokenSink = Callable[[TokenUsage], Awaitable[TokenSinkResult | None]]
ActivitySink = Callable[[ActivityEvent], Awaitable[None]]
SessionSink = Callable[[str, Path], Awaitable[None]]  # (vendor, file_path)
CheckpointProvider = Callable[[str, str | None], dict]
CheckpointSink = Callable[[str, dict, str | None], None]


class _Handler(FileSystemEventHandler):
    """watchdog event handler → push affected paths onto an asyncio queue."""

    def __init__(self, on_path: Callable[[Path], None]) -> None:
        super().__init__()
        self._on_path = on_path

    def on_modified(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        s = str(event.src_path)
        # Antigravity/Grok stores are SQLite: live writes land in the -wal
        # journal first, so accept it but enqueue the canonical .db path.
        if s.endswith(".db-wal"):
            self._on_path(Path(s[: -len("-wal")]))
            return
        # .db = Antigravity conversations / Grok's shared grok.db.
        if not s.endswith((".jsonl", ".json", ".db")):
            return
        self._on_path(Path(s))

    def on_created(self, event: FileSystemEvent) -> None:
        self.on_modified(event)


class LogWatcher:
    """Orchestrates one Observer + multiple LogReaders.

    Lifecycle: `start()` spawns the watchdog observer + an asyncio drain
    task. `stop()` shuts both down cleanly. Safe to call start() twice
    (subsequent calls are no-ops).
    """

    def __init__(
        self,
        sink: TokenSink,
        *,
        activity_sink: ActivitySink | None = None,
        session_sink: SessionSink | None = None,
        rescan_interval_s: float = 30.0,
        seen_path: Path | None = None,
        save_interval_s: float = 10.0,
        workspace_provider: Callable[[], list[str]] | None = None,
        checkpoint_provider: CheckpointProvider | None = None,
        checkpoint_sink: CheckpointSink | None = None,
        progress_sink: Callable[[str, int], None] | None = None,
    ) -> None:
        self._sink = sink
        # Called on the loop with (workspace_path, remaining_backfill_files) each
        # time a workspace's historic-log backfill starts or advances; 0 = done.
        # Lets the UI show a small "tidying token history" status instead of the
        # backfill silently competing for CPU during startup.
        self._progress_sink = progress_sink
        self._backfill_remaining: dict[str, int] = {}
        # Returns the workspaces the user has actually opened. Periodic/startup
        # backfill is scoped to these so we never re-stat the entire multi-GB
        # CLI history every cycle. None → legacy full scan.
        self._workspace_provider = workspace_provider
        self._activity_sink = activity_sink
        self._session_sink = session_sink
        self._rescan_interval_s = rescan_interval_s
        # seen_path/save_interval_s remain accepted for compatibility with
        # third-party callers; token persistence now belongs to the unified
        # checkpoint store supplied below.
        _ = (seen_path, save_interval_s)
        self._local_checkpoints: dict[tuple[str, str], dict] = {}
        self._checkpoint_provider = checkpoint_provider or self._local_checkpoint
        self._checkpoint_sink = checkpoint_sink or self._advance_local_checkpoint
        self._readers: list[LogReader] = []
        # Activity dedup is in-memory only (lifetime-bound). On restart, we
        # only emit *new* activity since the last seen line, but we don't try
        # to "replay" history — old events have no semantic value to a
        # newly-started watcher anyway.
        self._activity_seen: dict[str, set[str]] = {}
        self._scan_mtimes: dict[str, float] = {}
        self._queue: asyncio.Queue[tuple[Path, str]] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._observer: Observer | None = None
        self._drain_task: asyncio.Task[None] | None = None
        self._rescan_task: asyncio.Task[None] | None = None
        self._watched_dirs: set[Path] = set()
        self._started = False

    def add_reader(self, reader: LogReader) -> None:
        self._readers.append(reader)

    # ───────────────────────── lifecycle ──────────────────────────────────

    def _local_checkpoint(self, file_path: str, workspace_path: str | None) -> dict:
        return dict(self._local_checkpoints.get((file_path, workspace_path or ""), {}))

    def _advance_local_checkpoint(
        self, file_path: str, checkpoint: dict, workspace_path: str | None
    ) -> None:
        self._local_checkpoints[(file_path, workspace_path or "")] = dict(checkpoint)

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._loop = asyncio.get_event_loop()
        self._observer = Observer()

        # Bridge watchdog (synchronous) thread → asyncio queue (main thread).
        def on_path(p: Path) -> None:
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            try:
                loop.call_soon_threadsafe(self._queue.put_nowait, (p, ""))
            except RuntimeError:
                # loop closed mid-flight
                pass

        handler = _Handler(on_path)

        # Watch every existing watch root from every reader. Skip duplicates.
        # Most readers watch the same dirs they scan; Codex also watches the
        # stable ~/.codex-panes parent because per-pane session dirs appear
        # after the backend has already started.
        for reader in self._readers:
            for d in reader.watch_dirs():
                if d in self._watched_dirs or not d.exists():
                    continue
                try:
                    self._observer.schedule(handler, str(d), recursive=True)
                    self._watched_dirs.add(d)
                    log.info("watching %s for %s logs", d, reader.vendor)
                except Exception as err:  # noqa: BLE001
                    log.warning("schedule watch on %s failed: %s", d, err)

        self._observer.start()
        self._drain_task = asyncio.create_task(self._drain_loop(), name="logwatcher.drain")
        self._rescan_task = asyncio.create_task(self._rescan_loop(), name="logwatcher.rescan")
        log.info(
            "LogWatcher started · %d reader(s) · %d dir(s) · rescan %.0fs",
            len(self._readers), len(self._watched_dirs), self._rescan_interval_s,
        )

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        for t in (self._drain_task, self._rescan_task):
            if t:
                t.cancel()
        if self._observer:
            self._observer.stop()
            try:
                self._observer.join(timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
        log.info("LogWatcher stopped")

    # ───────────────────────── workers ────────────────────────────────────

    async def _drain_loop(self) -> None:
        """Pop file paths, route to the right reader, emit events."""
        while True:
            try:
                path, replay_workspace = await self._queue.get()
            except asyncio.CancelledError:
                return
            try:
                await self._process_path(path, replay_workspace)
            except Exception as err:  # noqa: BLE001
                log.warning("processing %s failed: %s", path, err)
            finally:
                # Decrement here (not inside _process_path) so EVERY dequeued
                # backfill file counts down exactly once — even when processing
                # early-returns (zero-token event, missing file, parse error).
                # Otherwise the remaining count never hits 0 and the "tidying"
                # indicator sticks on forever.
                if replay_workspace:
                    self._emit_backfill(replay_workspace, -1)

    def _emit_backfill(self, workspace_path: str, delta: int) -> None:
        """Adjust a workspace's remaining backfill count and notify the UI.

        Must run on the loop thread: force_rescan schedules it via
        call_soon_threadsafe (it runs in an executor); _process_path calls it
        directly. Clamped at 0 so out-of-order deltas never go negative.
        """
        if not workspace_path or self._progress_sink is None:
            return
        remaining = max(0, self._backfill_remaining.get(workspace_path, 0) + delta)
        if remaining:
            self._backfill_remaining[workspace_path] = remaining
        else:
            self._backfill_remaining.pop(workspace_path, None)
        try:
            self._progress_sink(workspace_path, remaining)
        except Exception as err:  # noqa: BLE001
            log.warning("backfill progress sink raised: %s", err)

    def force_rescan(self, workspace_path: str | None = None) -> None:
        """Re-enqueue session files using a workspace-specific checkpoint.

        Used when a new workspace registration means previously-parsed
        session files may now belong to that workspace and need re-counting.
        Global and workspace checkpoints advance independently, so a replay
        can fill missing workspace totals without incrementing Global twice.

        When `workspace_path` is given, only that workspace's files are
        re-enqueued: readers that map a workspace to a specific folder (Claude)
        return just that subset; readers that can't (Codex by-date) fall back
        to all their files — those vendors keep far fewer files so the cost
        stays bounded. This avoids re-parsing the entire
        (multi-GB) Claude history on every new workspace registration, which
        would saturate the event loop and stall the whole backend.

        Without `workspace_path`, every file from every reader is re-enqueued
        (legacy full rescan).
        """
        if self._loop is None or self._loop.is_closed():
            return
        files: list[Path] = []
        for reader in self._readers:
            scoped = (
                reader.session_files_for_workspace(workspace_path)
                if workspace_path
                else None
            )
            files.extend(scoped if scoped is not None else reader.session_files())
        # Announce the backfill size first (runs on the loop, before any per-file
        # decrement) so the UI can show progress. Only workspace-scoped replays
        # count — legacy full rescans (no workspace) don't drive the indicator.
        if workspace_path and files:
            try:
                self._loop.call_soon_threadsafe(
                    self._emit_backfill, workspace_path, len(files)
                )
            except RuntimeError:
                return
        for p in files:
            try:
                self._loop.call_soon_threadsafe(
                    self._queue.put_nowait, (p, workspace_path or "")
                )
            except RuntimeError:
                return
        log.info(
            "force_rescan: queued %d file(s) for re-parse%s",
            len(files),
            f" (workspace={workspace_path})" if workspace_path else " (all readers)",
        )

    def _candidate_files(self) -> list[Path]:
        """Backfill candidates scoped to opened workspaces (no mtime filter).

        When a workspace_provider is set we only enumerate files belonging to
        the workspaces the user has actually opened (readers that can't map a
        workspace to a subset fall back to their full list — those vendors keep
        far fewer files). No provider / nothing registered yet → full scan
        (legacy).
        """
        provider = self._workspace_provider
        workspaces = list(provider()) if provider else []
        if not workspaces:
            files: list[Path] = []
            for reader in self._readers:
                files.extend(reader.session_files())
            return files
        files = []
        seen: set[str] = set()
        for reader in self._readers:
            for ws in workspaces:
                scoped = reader.session_files_for_workspace(ws)
                cand = scoped if scoped is not None else reader.session_files()
                for p in cand:
                    k = str(p)
                    if k not in seen:
                        seen.add(k)
                        files.append(p)
        return files

    def _files_to_scan(self) -> list[Path]:
        """Backfill candidates whose mtime changed since the last sweep.

        Workspace scoping (_candidate_files) bounds which files we look at;
        this mtime gate stops us from re-enqueueing unchanged files. Without
        it every 30-second cycle re-reads every workspace session file —
        including 100 MB+ Claude histories — saturating the drain task.
        """
        out: list[Path] = []
        for p in self._candidate_files():
            try:
                mtime = p.stat().st_mtime
            except OSError:
                continue
            k = str(p)
            if self._scan_mtimes.get(k) == mtime:
                continue
            self._scan_mtimes[k] = mtime
            out.append(p)
        return out

    async def _rescan_loop(self) -> None:
        """Periodically re-enqueue session files for opened workspaces.

        Catches watchdog misses (e.g. on network FS where INotify isn't
        delivered) and brand-new files since startup. Scope comes from
        _files_to_scan() so this never walks the whole CLI history.
        """
        # First scan happens immediately (initial backfill).
        delay = 0.5
        while True:
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                return
            for p in self._files_to_scan():
                self._queue.put_nowait((p, ""))
            delay = self._rescan_interval_s

    async def _process_path(self, path: Path, replay_workspace: str = "") -> None:
        reader = self._reader_for(path)
        if reader is None:
            return
        # Session-id capture for resume (Codex/Antigravity). Runs
        # independent of token parsing so it works even for session-file formats
        # the token reader doesn't (yet) understand — it only needs the file to
        # exist + contain the pane marker.
        if self._session_sink is not None and reader.vendor in ("codex", "antigravity", "grok", "kimi"):
            try:
                await self._session_sink(reader.vendor, path)
            except Exception as err:  # noqa: BLE001
                log.warning("session sink raised: %s", err)
        key = str(path.resolve())
        checkpoint = self._checkpoint_provider(key, replay_workspace or None)
        try:
            parsed = await asyncio.to_thread(reader.parse_incremental, path, checkpoint)
        except FileNotFoundError:
            return
        except Exception as err:  # noqa: BLE001
            log.warning("parse %s (%s) failed: %s", path, reader.vendor, err)
            return
        handled_workspaces: set[str] = set()
        for ev in parsed.events:
            try:
                result = await self._sink(
                    replace(ev, replay_workspace=replay_workspace) if replay_workspace else ev
                )
            except Exception as err:  # noqa: BLE001
                log.warning("token sink raised: %s", err)
                return
            if isinstance(result, TokenSinkResult):
                if not result.handled:
                    return
                if result.workspace_path:
                    handled_workspaces.add(result.workspace_path)

        if replay_workspace:
            self._checkpoint_sink(key, parsed.checkpoint, replay_workspace)
            # Yield so a big history backfill doesn't starve startup spawns /
            # live events queued behind it on the loop. (The remaining-count
            # decrement happens in _drain_loop's finally, once per dequeued file.)
            await asyncio.sleep(0)
        else:
            self._checkpoint_sink(key, parsed.checkpoint, None)
            for workspace_path in handled_workspaces:
                self._checkpoint_sink(key, parsed.checkpoint, workspace_path)

        # Activity parsing runs on the same file but with its own dedup set.
        if self._activity_sink is not None:
            act_seen = self._activity_seen.setdefault(key, set())
            try:
                activity_events = await asyncio.to_thread(
                    reader.parse_activity, path, act_seen
                )
            except FileNotFoundError:
                return
            except Exception as err:  # noqa: BLE001
                log.warning("parse_activity %s (%s) failed: %s", path, reader.vendor, err)
                return
            for aev in activity_events:
                try:
                    await self._activity_sink(aev)
                except Exception as err:  # noqa: BLE001
                    log.warning("activity sink raised: %s", err)

    def _reader_for(self, path: Path) -> LogReader | None:
        s = str(path.resolve())
        for reader in self._readers:
            for d in reader.project_dirs():
                try:
                    if s.startswith(str(d.resolve()) + "/"):
                        return reader
                except OSError:
                    continue
        return None
