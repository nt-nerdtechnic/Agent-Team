"""File-system watcher that polls registered LogReaders for new token events.

Uses `watchdog` for change notifications, with a periodic full-rescan
fallback (default 30s) to recover from missed events (network mounts,
edge-case file ops). Token readers resume from compact per-file checkpoints
owned by TokensStore; the watcher persists its activity dedup marks into the
same store, under the reserved "@activity" scope, so a restart resumes where
the last one stopped instead of replaying every transcript from line 1.

Architecture:

    LogWatcher.start()
        ├─ observer (watchdog Observer) — async file events → enqueue(path)
        ├─ drain loop (asyncio) — immediate session/activity processing
        ├─ rescan loop (asyncio) — every N s → enqueue changed session files
        └─ token loop (asyncio) — every 300s → parse coalesced paths
                                             → emit TokenUsage to sink

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

from .base import (
    ActivityEvent,
    LogReader,
    TokenSinkResult,
    TokenUsage,
    seed_pre_start_activity,
)

log = logging.getLogger("agent_team_backend.log_readers.watcher")

# A file's activity dedup set used to hold one short key per line ever parsed
# from it (see LogReader.parse_activity), for the whole process lifetime, so a
# full-corpus scan pinned that memory permanently — and because those keys are
# allocated interleaved with the transient json.loads garbage of the same scan,
# they scatter across every pymalloc arena and stop CPython returning any of
# them (an arena is only ever munmap'd once it is completely empty).
# Measured 2026-08-18 on a zero-pane startup scan of 5209 transcripts:
# 452,693 retained keys, ~47 MB of live strings/sets, holding 481 MB of arenas.
# A file that is gone can never be scanned again, so its set is pure garbage.
# A file that still exists keeps its set however old it looks: resuming an old
# session is a first-class flow here, and a resumed transcript with no dedup
# state replays every historical turn — text, turn_complete and all — at a pane
# that is already registered and attributed. (The durable "@activity"
# checkpoint below would rebuild the mark on the next read, but only after the
# file has already been re-enqueued and re-walked; the in-memory bag is what
# makes the common case free.)
_ACTIVITY_SEEN_SWEEP_S = 600.0

# Reserved checkpoint scope for the activity dedup bag. Real scopes are either
# "" (Global) or an absolute workspace path, so a leading "@" cannot collide —
# and the tokens_store paths that iterate workspace scopes (reset, prune) match
# on a literal workspace path, never on "any scope".
_ACTIVITY_SCOPE = "@activity"
_ACTIVITY_KIND = "activity"
# The bag is stored whole, so it is only stored while it stays small. All 13
# vendors keep a handful of sentinel keys (a line high-water mark, a cumulative
# total, the last turn's text) rather than one key per line, so this holds for
# every one of them; a reader that regressed to per-item keys silently falls
# back to the old in-memory-only behaviour instead of writing an unbounded blob
# into the checkpoint row of every transcript.
_ACTIVITY_KEYS_PERSIST_LIMIT = 8

TokenSink = Callable[[TokenUsage], Awaitable[TokenSinkResult | None]]
ActivitySink = Callable[[ActivityEvent], Awaitable[None]]
SessionSink = Callable[[str, Path], Awaitable[None]]  # (vendor, file_path)
CheckpointProvider = Callable[[str, str | None], dict]
CheckpointSink = Callable[[str, dict, str | None], None]


class _Handler(FileSystemEventHandler):
    """watchdog event handler → push affected paths onto an asyncio queue."""

    def __init__(
        self,
        on_path: Callable[[Path], None],
        accepts_path: Callable[[str], bool] | None = None,
    ) -> None:
        super().__init__()
        self._on_path = on_path
        # Vendor hook (LogReader.accepts_watch_path): paths the generic
        # extension filter below would drop but some reader claims.
        self._accepts_path = accepts_path or (lambda _s: False)

    def on_modified(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        s = str(event.src_path)
        # Antigravity/Grok/OpenCode stores are SQLite: live writes land in the
        # -wal journal first, so accept it but enqueue the canonical .db path.
        if s.endswith(".db-wal"):
            self._on_path(Path(s[: -len("-wal")]))
            return
        if self._accepts_path(s):
            self._on_path(Path(s))
            return
        # .db = Antigravity conversations / Grok's grok.db / OpenCode's
        # opencode.db / Kilo's kilo.db.
        if not s.endswith((".jsonl", ".json", ".db")):
            return
        self._on_path(Path(s))

    def on_created(self, event: FileSystemEvent) -> None:
        self.on_modified(event)


class LogWatcher:
    """Orchestrates one Observer + multiple LogReaders.

    Lifecycle: `start()` spawns the watchdog observer + asyncio worker
    tasks. `stop()` shuts them down cleanly. Safe to call start() twice
    (subsequent calls are no-ops).
    """

    def __init__(
        self,
        sink: TokenSink,
        *,
        activity_sink: ActivitySink | None = None,
        session_sink: SessionSink | None = None,
        rescan_interval_s: float = 30.0,
        token_interval_s: float = 300.0,
        seen_path: Path | None = None,
        save_interval_s: float = 10.0,
        workspace_provider: Callable[[], list[str]] | None = None,
        token_workspace_provider: Callable[[], list[str]] | None = None,
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
        # Second, wider scope for token/usage backfill only. The activity scope
        # above is deliberately narrow (workspaces with a live pane), but token
        # accounting has to keep covering every workspace ever opened —
        # register_workspace promises attribution "including files that existed
        # before registration", and the startup sweep is token's only offline
        # catch-up window (watchdog fires on later writes, never on what grew
        # while the backend was down). Files that fall only in this scope are
        # queued straight for token ingestion and never enter the drain queue,
        # so they cost zero activity parsing. None → no token-only sweep, i.e.
        # exactly the behaviour before this parameter existed.
        self._token_workspace_provider = token_workspace_provider
        self._activity_sink = activity_sink
        self._session_sink = session_sink
        self._rescan_interval_s = rescan_interval_s
        self._token_interval_s = token_interval_s
        # seen_path/save_interval_s remain accepted for compatibility with
        # third-party callers; token persistence now belongs to the unified
        # checkpoint store supplied below.
        _ = (seen_path, save_interval_s)
        self._local_checkpoints: dict[tuple[str, str], dict] = {}
        self._checkpoint_provider = checkpoint_provider or self._local_checkpoint
        self._checkpoint_sink = checkpoint_sink or self._advance_local_checkpoint
        self._readers: list[LogReader] = []
        # Per-file activity dedup bags, restored from the durable "@activity"
        # checkpoint on first sight and written back as they advance
        # (_restore_activity_seen / _persist_activity_seen). This dict is the
        # hot cache, not the record: a restart with an empty one used to mean
        # every reader walked its transcript from line 1 and broadcast an
        # agent.activity per historical entry — ~148,000 in the first 60s of a
        # cold start (GitHub #28). Bags are dropped once the file is deleted
        # (_sweep_activity_seen); they used to be lifetime-bound, which is how
        # this became the backend's largest retained structure.
        self._activity_seen: dict[str, set[str]] = {}
        self._activity_seen_swept_at: float | None = None
        self._scan_mtimes: dict[str, float] = {}
        # Enumeration state shared by the two scopes of one sweep; installed by
        # _discover_sweep and torn down again when it returns. See _sweep_state.
        self._sweep_seen: set[str] | None = None
        self._sweep_memo: dict[tuple[int, str | None], list[Path]] | None = None
        self._queue: asyncio.Queue[tuple[Path | None, str]] = asyncio.Queue()
        self._pending_token_paths: dict[tuple[str, str], Path] = {}
        self._pending_token_backfills: dict[tuple[str, str], int] = {}
        self._token_flush_lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._observer: Observer | None = None
        self._drain_task: asyncio.Task[None] | None = None
        self._rescan_task: asyncio.Task[None] | None = None
        self._token_task: asyncio.Task[None] | None = None
        self._token_flush_tasks: set[asyncio.Task[None]] = set()
        self._watched_dirs: set[Path] = set()
        self._handler: _Handler | None = None
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

        def accepts_path(s: str) -> bool:
            # Live view, not a snapshot — readers may register after start().
            return any(r.accepts_watch_path(s) for r in self._readers)

        handler = _Handler(on_path, accepts_path)
        self._handler = handler

        # Watch every existing watch root from every reader. Skip duplicates.
        # Most readers watch the same dirs they scan; Codex also watches the
        # stable ~/.codex-panes parent because per-pane session dirs appear
        # after the backend has already started. Roots that don't exist yet
        # (fresh install: CLI homes are created on first spawn/login) are
        # re-checked every rescan cycle by _watch_new_dirs.
        self._watch_new_dirs()

        self._observer.start()
        self._drain_task = asyncio.create_task(self._drain_loop(), name="logwatcher.drain")
        self._rescan_task = asyncio.create_task(self._rescan_loop(), name="logwatcher.rescan")
        self._token_task = asyncio.create_task(self._token_loop(), name="logwatcher.tokens")
        log.info(
            "LogWatcher started · %d reader(s) · %d dir(s) · rescan %.0fs · tokens %.0fs",
            len(self._readers), len(self._watched_dirs),
            self._rescan_interval_s, self._token_interval_s,
        )

    def watch_dir(self, directory: Path) -> bool:
        """Subscribe the observer to an extra directory at runtime.

        A managed account's persistent config home appears/becomes relevant
        only when a profile pane spawns — after start() already scheduled the
        static watch roots. Watching the home recursively covers claude's
        <home>/projects, kimi's <home>/sessions and grok's <home>/.grok in one
        subscription; the home dir is checked for existence below so the
        schedule can't fail on a not-yet-created session subdir. Lazy + deduped:
        only homes with a live pane are added, and an already-watched dir is a
        no-op. Returns True when a new subscription was created."""
        if not self._started or self._observer is None or self._handler is None:
            return False
        d = Path(directory)
        if d in self._watched_dirs:
            return False
        try:
            if not d.exists():
                return False
            self._observer.schedule(self._handler, str(d), recursive=True)
            self._watched_dirs.add(d)
            log.info("watching %s (profile config home)", d)
            return True
        except Exception as err:  # noqa: BLE001
            log.warning("schedule watch on %s failed: %s", d, err)
            return False

    def _watch_new_dirs(self) -> None:
        """Subscribe reader watch roots that exist now but didn't earlier.

        On a fresh install none of the CLI homes (~/.codex-panes,
        ~/.codex/sessions, …) exist when start() runs — they are created by
        the first pane spawn or in-pane login. watch_dirs() only returns
        existing dirs, so without a periodic re-check watchdog never observes
        those vendors and delivery degrades to the rescan loop alone (a
        single point of failure). Called from start() and once per rescan
        cycle; already-watched dirs are deduped so steady-state cost is a few
        exists() checks."""
        if self._observer is None or self._handler is None:
            return
        for reader in self._readers:
            for d in reader.watch_dirs():
                if d in self._watched_dirs or not d.exists():
                    continue
                try:
                    self._observer.schedule(self._handler, str(d), recursive=True)
                    self._watched_dirs.add(d)
                    log.info("watching %s for %s logs", d, reader.vendor)
                except Exception as err:  # noqa: BLE001
                    log.warning("schedule watch on %s failed: %s", d, err)

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        for t in (
            self._drain_task,
            self._rescan_task,
            self._token_task,
            *self._token_flush_tasks,
        ):
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

    def _queue_token_path(self, path: Path, replay_workspace: str = "") -> None:
        """Coalesce one path for the next token-ingestion pass."""
        try:
            path_key = str(path.resolve())
        except OSError:
            path_key = str(path)
        key = (path_key, replay_workspace)
        self._pending_token_paths[key] = path
        if replay_workspace:
            self._pending_token_backfills[key] = (
                self._pending_token_backfills.get(key, 0) + 1
            )

    async def _drain_loop(self) -> None:
        """Process session/activity immediately and defer only token ingestion."""
        processed = 0
        while True:
            try:
                path, replay_workspace = await self._queue.get()
            except asyncio.CancelledError:
                return
            if path is None:
                task = asyncio.create_task(
                    self._flush_pending_tokens(), name="logwatcher.tokens.flush"
                )
                self._token_flush_tasks.add(task)
                task.add_done_callback(self._token_flush_tasks.discard)
                continue
            try:
                await self._process_realtime_path(path)
            except Exception as err:  # noqa: BLE001
                log.warning("processing realtime signals from %s failed: %s", path, err)
            finally:
                # Token retry/progress is independent of session/activity
                # parsing. Even an unclaimed replay path must reach the token
                # pass so its backfill count can complete.
                self._queue_token_path(path, replay_workspace)
                processed += 1
                if processed % 10 == 0:
                    await asyncio.sleep(0)

    async def _token_loop(self) -> None:
        """Commit coalesced token paths at most once per configured interval."""
        while True:
            try:
                await asyncio.sleep(self._token_interval_s)
            except asyncio.CancelledError:
                return
            await self._flush_pending_tokens()

    async def _flush_pending_tokens(self) -> None:
        async with self._token_flush_lock:
            pending, self._pending_token_paths = self._pending_token_paths, {}
            backfills, self._pending_token_backfills = self._pending_token_backfills, {}
            for key, path in pending.items():
                replay_workspace = key[1]
                try:
                    handled = await self._process_token_path(path, replay_workspace)
                    if not handled:
                        self._pending_token_paths.setdefault(key, path)
                except Exception as err:  # noqa: BLE001
                    self._pending_token_paths.setdefault(key, path)
                    log.warning("processing tokens from %s failed: %s", path, err)
                finally:
                    if replay_workspace:
                        self._emit_backfill(
                            replay_workspace, -backfills.get(key, 0)
                        )

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
        # Flush sentinel behind the batch. The backfill count only decrements in
        # _flush_pending_tokens, and the periodic token loop is _token_interval_s
        # (5 min) away — without this the "tidying" indicator sticks until then.
        if workspace_path and files:
            try:
                self._loop.call_soon_threadsafe(self._queue.put_nowait, (None, ""))
            except RuntimeError:
                return
        log.info(
            "force_rescan: queued %d file(s) for re-parse%s",
            len(files),
            f" (workspace={workspace_path})" if workspace_path else " (all readers)",
        )

    def _sweep_state(self) -> tuple[set[str], dict[tuple[int, str | None], list[Path]]]:
        """The `seen` set and enumeration memo for the sweep in progress.

        _discover_sweep installs one pair so the activity and token-only passes
        share them: a file claimed by the first pass is skipped by the second,
        and a reader tree is walked once rather than once per pass. A call from
        outside a sweep (tests, ad-hoc use) gets a throwaway pair, so each
        method still behaves correctly on its own.
        """
        if self._sweep_seen is not None and self._sweep_memo is not None:
            return self._sweep_seen, self._sweep_memo
        return set(), {}

    def _reader_files(
        self,
        reader: LogReader,
        workspace: str | None,
        memo: dict[tuple[int, str | None], list[Path]],
    ) -> list[Path]:
        """One enumeration per (reader, workspace) per sweep.

        Readers that cannot narrow by workspace (Codex files itself by date;
        Grok/Kilo/Muse/OpenCode keep every session in one shared store) return
        None from session_files_for_workspace and fall back to their whole
        list — for every workspace, in every scope. Without this memo the two
        scopes would walk those trees N_workspaces × 2 times per sweep instead
        of once.
        """
        key = (id(reader), workspace)
        cached = memo.get(key)
        if cached is not None:
            return cached
        if workspace is None:
            files = list(reader.session_files())
        else:
            scoped = reader.session_files_for_workspace(workspace)
            files = (
                list(scoped)
                if scoped is not None
                else self._reader_files(reader, None, memo)
            )
        memo[key] = files
        return files

    def _collect_candidates(
        self,
        workspaces: list[str],
        seen: set[str],
        memo: dict[tuple[int, str | None], list[Path]],
    ) -> list[Path]:
        """Enumerate one scope's candidate files, skipping anything already
        claimed by an earlier pass of the same sweep."""
        files: list[Path] = []
        # Empty workspace list = legacy unscoped full scan. It still records
        # into `seen`, so a token-only pass behind it finds nothing left over.
        sources = [None] if not workspaces else list(workspaces)
        for reader in self._readers:
            for ws in sources:
                for p in self._reader_files(reader, ws, memo):
                    k = str(p)
                    if k not in seen:
                        seen.add(k)
                        files.append(p)
        return files

    def _candidate_files(self) -> list[Path]:
        """Backfill candidates scoped to opened workspaces (no mtime filter).

        When a workspace_provider is set we only enumerate files belonging to
        the workspaces the user has actually opened (readers that can't map a
        workspace to a subset fall back to their full list — those vendors keep
        far fewer files). No provider / nothing registered yet → full scan
        (legacy).
        """
        provider = self._workspace_provider
        if provider is not None:
            workspaces = list(provider())
            if not workspaces:
                # When a workspace provider is configured but has no open workspaces
                # yet (e.g. startup with empty project list), skip full-disk scans.
                return []
        else:
            workspaces = []
        seen, memo = self._sweep_state()
        return self._collect_candidates(workspaces, seen, memo)

    def _token_only_candidate_files(self) -> list[Path]:
        """Candidates that belong to the token scope but not the activity one.

        Only meaningful inside a sweep, where the shared `seen` set has already
        absorbed everything the activity pass claimed; what comes back here is
        the remainder — the workspaces with no live pane right now, whose usage
        would otherwise never be backfilled.
        """
        provider = self._token_workspace_provider
        if provider is None:
            return []
        workspaces = list(provider())
        if not workspaces:
            return []
        seen, memo = self._sweep_state()
        return self._collect_candidates(workspaces, seen, memo)

    def _sweep_activity_seen(self, now: float) -> None:
        """Forget the activity dedup set of every file that no longer exists.

        Runs at most every _ACTIVITY_SEEN_SWEEP_S off the rescan loop; `now`
        is loop-monotonic.

        Only deleted files are forgotten. A file that still exists keeps its
        set no matter how long it has been idle: dropping it does not free a
        session, it arms one. The next append re-enqueues the file, the reader
        starts from line 1 with an empty set, and every historical
        `agent_active` / `turn_complete` — carrying turn text and MSG blocks —
        is broadcast again, this time to a live, attributed pane. The durable
        "@activity" checkpoint now backs the bag up, so the replay is bounded
        by what the store still holds rather than by the file — but it is one
        provider call and a re-walk of the file either way, and the per-file
        sets are bounded by the readers' high-water marks (see
        log_readers.base), so retaining them is cheap.

        The checkpoint row of a deleted file is deliberately left alone here:
        tokens_store prunes an unreadable path after DEAD_ENTRY_DAYS, which
        tolerates a file that is only temporarily missing (an unmounted volume,
        a rename in flight) where an eager delete here would not.
        """
        if (
            self._activity_seen_swept_at is not None
            and now - self._activity_seen_swept_at < _ACTIVITY_SEEN_SWEEP_S
        ):
            return
        dropped = 0
        keys = 0
        for path in list(self._activity_seen):
            if Path(path).exists():
                continue
            keys += len(self._activity_seen.pop(path, ()))
            dropped += 1
            self._scan_mtimes.pop(path, None)
        self._activity_seen_swept_at = now
        if dropped:
            log.info(
                "activity dedup sweep: dropped %d deleted file(s), %d key(s); "
                "%d file(s) still tracked",
                dropped, keys, len(self._activity_seen),
            )

    def _files_to_scan(self) -> list[Path]:
        """Backfill candidates whose mtime changed since the last sweep.

        Workspace scoping (_candidate_files) bounds which files we look at;
        this mtime gate stops us from re-enqueueing unchanged files. Without
        it every 30-second cycle re-reads every workspace session file —
        including 100 MB+ Claude histories — saturating the drain task.

        Takes no arguments and returns a list: test_watcher_offloop_discovery
        replaces this method wholesale with a zero-arg spy to prove discovery
        stays off the event loop.
        """
        return self._changed_since_last_scan(self._candidate_files())

    def _token_only_files_to_scan(self) -> list[Path]:
        """Changed candidates that only the token scope covers.

        Same shape and same mtime gate as _files_to_scan, for the files the
        activity pass did not claim. _rescan_loop hands these straight to
        _queue_token_path, so they never reach _process_realtime_path and
        never cost a parse_activity.
        """
        return self._changed_since_last_scan(self._token_only_candidate_files())

    def _changed_since_last_scan(self, files: list[Path]) -> list[Path]:
        """Drop files whose mtime is unchanged since we last enqueued them.

        _scan_mtimes is shared by both scopes on purpose: a file is worth
        re-reading once per change, whichever scope surfaced it.
        """
        out: list[Path] = []
        for p in files:
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

    def _discover_sweep(self) -> tuple[list[Path], list[Path]]:
        """One enumeration pass over disk, two lists: activity, then token-only.

        The order here is semantics, not style. Both passes share one `seen`
        set, so whichever runs first claims a file that falls in both scopes —
        and token-only files bypass the drain queue entirely. Collect token
        first and every overlapping file loses its activity events, silently.

        Runs in a worker thread (see _rescan_loop); the per-sweep state is torn
        down before returning so a later standalone call can't inherit it.
        """
        self._sweep_seen = set()
        self._sweep_memo = {}
        try:
            activity = self._files_to_scan()
            token_only = self._token_only_files_to_scan()
        finally:
            self._sweep_seen = None
            self._sweep_memo = None
        return activity, token_only

    async def _rescan_loop(self) -> None:
        """Enqueue changed files immediately at startup, then every rescan."""
        first_scan = True
        delay = 0.0
        while True:
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                return
            # The sweep body must never kill this task: it is the only
            # delivery path for vendors watchdog isn't observing, and nothing
            # restarts a dead rescan loop. One reader raising (corrupt store,
            # unexpected file shape) skips this cycle, not all future ones.
            try:
                self._watch_new_dirs()
                # Discovery is disk-bound (vendor tree walks, per-file header
                # reads, one stat per candidate) and must stay off the event
                # loop: on a cold page cache a sweep takes seconds, and the
                # loop freezing that long suspends every PTY reader and WS
                # send. Only the enqueue runs back on the loop. _scan_mtimes
                # stays safe: this coroutine is its only writer, and the
                # sweep below runs strictly after the thread returns.
                activity_paths, token_only_paths = await asyncio.to_thread(
                    self._discover_sweep
                )
                for path in activity_paths:
                    self._queue.put_nowait((path, ""))
                # Token-only paths coalesce straight into the next token pass:
                # no drain queue, so no _process_realtime_path and no
                # parse_activity for a workspace nobody has open. Queued after
                # the activity batch for the same reason _discover_sweep
                # collects in that order — see its docstring. Still ahead of
                # the first_scan sentinel below, so startup catch-up settles in
                # the first flush. _pending_token_paths keeps its single-writer
                # invariant: this is the loop thread, same as _drain_loop.
                for path in token_only_paths:
                    pass
                if self._loop is not None:
                    self._sweep_activity_seen(self._loop.time())
            except Exception as err:  # noqa: BLE001
                log.warning("rescan sweep failed: %s", err)
            if first_scan:
                # The drain processes all startup paths before this marker, so
                # historic token usage catches up immediately and atomically
                # through the existing sink/checkpoint path.
                self._queue.put_nowait((None, ""))
                first_scan = False
            delay = self._rescan_interval_s

    async def _process_path(self, path: Path, replay_workspace: str = "") -> None:
        """Compatibility helper: process every concern immediately."""
        await self._process_realtime_path(path)
        await self._process_token_path(path, replay_workspace)

    async def _process_realtime_path(self, path: Path) -> bool:
        """Capture session identity and activity without token batching delay."""
        reader = self._reader_for(path)
        if reader is None:
            return False
        # Session-id capture for resume (Codex/Antigravity). Runs
        # independent of token parsing so it works even for session-file formats
        # the token reader doesn't (yet) understand — it only needs the file to
        # exist + contain the pane marker.
        if self._session_sink is not None and reader.emits_session_sink:
            try:
                await self._session_sink(reader.vendor, path)
            except Exception as err:  # noqa: BLE001
                log.warning("session sink raised: %s", err)
        key = str(path.resolve())

        # Activity parsing stays realtime even though token accounting is
        # intentionally delayed.
        if self._activity_sink is not None:
            act_seen = self._activity_seen.get(key)
            seeded = False
            if act_seen is None:
                act_seen, seeded = await self._restore_activity_seen(key, path, reader)
                self._activity_seen[key] = act_seen
            before = frozenset(act_seen)
            try:
                activity_events = await asyncio.to_thread(
                    reader.parse_activity, path, act_seen
                )
            except FileNotFoundError:
                return False
            except Exception as err:  # noqa: BLE001
                log.warning("parse_activity %s (%s) failed: %s", path, reader.vendor, err)
                return False
            for aev in activity_events:
                try:
                    await self._activity_sink(aev)
                except Exception as err:  # noqa: BLE001
                    log.warning("activity sink raised: %s", err)
            # After delivery, so the durable mark can never run ahead of what
            # was actually broadcast. `seeded` is its own signal because a seed
            # leaves the bag unchanged across the parse that follows it — the
            # reader finds nothing new and rewrites the same mark.
            if seeded or frozenset(act_seen) != before:
                self._persist_activity_seen(key, act_seen)
        return True

    async def _restore_activity_seen(
        self, key: str, path: Path, reader: LogReader
    ) -> tuple[set[str], bool]:
        """The dedup bag for a file not in the hot cache: (bag, was_seeded).

        Restored from the durable checkpoint when one exists. When none does,
        this is the first time any process has looked at the file, and a
        line-resuming reader gets it seeded to EOF instead of replayed — see
        seed_pre_start_activity for the mtime gate that keeps a live pane's
        fresh transcript out of that path.
        """
        try:
            stored = self._checkpoint_provider(key, _ACTIVITY_SCOPE) or {}
        except Exception as err:  # noqa: BLE001
            log.warning("activity checkpoint provider raised for %s: %s", path, err)
            stored = {}
        if stored.get("kind") == _ACTIVITY_KIND:
            keys = stored.get("keys")
            if isinstance(keys, list):
                return {str(k) for k in keys}, False
            return set(), False
        seen: set[str] = set()
        if not reader.activity_resumes_by_line:
            return seen, False
        # stat + line walk are disk-bound; the drain runs on the loop.
        seeded = await asyncio.to_thread(seed_pre_start_activity, path, seen)
        return seen, seeded

    def _persist_activity_seen(self, key: str, act_seen: set[str]) -> None:
        """Write a file's dedup bag back to the durable checkpoint store.

        Sorted so the serialized row is stable and _checkpoint_is_newer's
        difference test does not fire on set-iteration order alone. An
        over-limit bag is left unwritten rather than truncated: a partial bag
        would read back as a real resume point and silently swallow the lines
        it dropped.
        """
        if len(act_seen) > _ACTIVITY_KEYS_PERSIST_LIMIT:
            return
        try:
            self._checkpoint_sink(
                key,
                {"kind": _ACTIVITY_KIND, "keys": sorted(act_seen)},
                _ACTIVITY_SCOPE,
            )
        except Exception as err:  # noqa: BLE001
            log.warning("activity checkpoint sink raised for %s: %s", key, err)

    async def _process_token_path(
        self, path: Path, replay_workspace: str = ""
    ) -> bool:
        """Parse and commit token usage plus its durable checkpoint."""
        reader = self._reader_for(path)
        if reader is None:
            return True
        key = str(path.resolve())
        checkpoint = self._checkpoint_provider(key, replay_workspace or None)
        try:
            parsed = await asyncio.to_thread(reader.parse_incremental, path, checkpoint)
        except FileNotFoundError:
            return True
        except Exception as err:  # noqa: BLE001
            log.warning("parse %s (%s) failed: %s", path, reader.vendor, err)
            return False
        handled_workspaces: set[str] = set()
        for ev in parsed.events:
            try:
                result = await self._sink(
                    replace(ev, replay_workspace=replay_workspace) if replay_workspace else ev
                )
            except Exception as err:  # noqa: BLE001
                log.warning("token sink raised: %s", err)
                return False
            if isinstance(result, TokenSinkResult):
                if not result.handled:
                    return False
                if result.workspace_path:
                    handled_workspaces.add(result.workspace_path)

        if replay_workspace:
            self._checkpoint_sink(key, parsed.checkpoint, replay_workspace)
            # Yield so a big history backfill doesn't starve startup spawns /
            # live events queued behind it on the loop. Backfill progress is
            # decremented by _flush_pending_tokens after this pass finishes.
            await asyncio.sleep(0)
        else:
            self._checkpoint_sink(key, parsed.checkpoint, None)
            for workspace_path in handled_workspaces:
                self._checkpoint_sink(key, parsed.checkpoint, workspace_path)
        return True

    def _reader_for(self, path: Path) -> LogReader | None:
        try:
            resolved = path.resolve()
        except OSError:
            resolved = path
        for reader in self._readers:
            try:
                if reader.claims_path(resolved):
                    return reader
            except OSError:
                continue
        return None
