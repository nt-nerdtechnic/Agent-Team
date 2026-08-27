"""Filesystem watcher that fires `git.changed` when a repo's working tree or
`.git` state changes on disk — the same model VS Code / Cursor use for their
Source Control panel (event-driven, not fixed-interval polling).

Design (mirrors LogWatcher):

    GitWatcher.start(loop)
        └─ observer (watchdog Observer)
    GitWatcher.watch(ws_path)
        └─ schedule a per-root handler (recursive) on each repo root

A change anywhere in the working tree, or in the first-level git-state files
under `.git/` (index, HEAD, refs, MERGE_HEAD, …), marks that workspace dirty.
A short debounce coalesces bursts (e.g. a build writing many files, or `git
checkout` touching thousands) into a single `on_change(ws_path, paths)`
call, `paths` being the workspace-relative files the window touched.

Noise is filtered in the handler: build/dependency dirs (node_modules, .venv,
dist, …) and git-internal churn (.git/objects, .git/logs, *.lock) never
trigger a refresh — matching VS Code's behaviour, which ignores `index.lock`
and only reacts to the first level of `.git`.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

log = logging.getLogger("agent_team_backend.git_watcher")

ChangeSink = Callable[[str], Awaitable[None]]
# Same debounce, one extra argument: the workspace-relative paths that made the
# window dirty, each with the watchdog event type that touched it.
PathChangeSink = Callable[[str, list[tuple[str, str]]], Awaitable[None]]

# Working-tree path segments that should never trigger a git refresh. These are
# build artefacts / dependency trees that aren't tracked but churn constantly.
_IGNORE_SEGMENTS = frozenset({
    "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
    "target", ".next", ".nuxt", ".turbo", ".cache", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".idea", ".gradle",
    # Our own run artifacts: pipeline panes stream agent output into
    # .agent-team/runs/.../*.log continuously. git ignores this dir (it ships a
    # `.gitignore` of `*`), but watchdog doesn't read .gitignore — so without
    # this, every log write fires git.changed → a 7-request git fan-out in the
    # frontend, flooding the shared WebSocket and stalling pipeline messages.
    ".agent-team",
})

# First-level entries under `.git/` that are pure internal churn — reacting to
# them would fire on every object write / reflog append with no UI-visible
# effect. Everything else at the first level (index, HEAD, refs, MERGE_HEAD,
# ORIG_HEAD, FETCH_HEAD, packed-refs …) is meaningful git state.
_IGNORE_GIT_FIRST_LEVEL = frozenset({"objects", "logs", "hooks", "lfs"})

# Sub-dirs of a Laravel storage/ dir that churn on every HTTP request via
# file-based session/cache drivers — same fan-out problem as .agent-team
# above. Scoped narrowly (not a bare "storage" entry in _IGNORE_SEGMENTS) so a
# tracked storage/ dir in a non-Laravel project (e.g. Rails Active Storage)
# still reports changes normally.
_IGNORE_STORAGE_SUBDIRS = frozenset({"framework", "logs"})

# Directories monitored for plan and report documents.
PLAN_DOC_DIRS = frozenset({
    (".agent-team", "plans"),
    (".agent-team", "reports"),
    (".claude", "loop-reports"),
    (".claude", "plans"),
    (".cursor", "plans"),
    ("docs", "plans"),
    ("docs", "reports"),
})


class _RepoHandler(FileSystemEventHandler):
    """watchdog handler bound to one repo root. Filters noise, then bridges
    meaningful events to the asyncio loop as a 'this workspace is dirty' signal."""

    def __init__(
        self,
        root: Path,
        ws_path: str,
        on_dirty: Callable[[str, list[tuple[str, str]]], None],
        on_plans_dirty: Callable[[str], None] | None = None,
    ) -> None:
        super().__init__()
        self._root = root
        self._ws_path = ws_path
        self._on_dirty = on_dirty
        self._on_plans_dirty = on_plans_dirty

    def on_any_event(self, event: FileSystemEvent) -> None:
        # `closed`/`opened` events carry no state change; only react to actual
        # create/delete/modify/move.
        if event.event_type in ("opened", "closed"):
            return
        src = str(event.src_path)
        dest = str(event.dest_path) if getattr(event, "dest_path", "") else ""
        # Plan documents live under .agent-team/, which the git filter ignores
        # wholesale — check them on a separate channel before that filter.
        if self._on_plans_dirty is not None and (
            self._is_plan_doc(src) or (dest and self._is_plan_doc(dest))
        ):
            self._on_plans_dirty(self._ws_path)
        src_ok = self._is_relevant(src)
        dest_ok = bool(dest) and self._is_relevant(dest)
        if src_ok or dest_ok:
            self._on_dirty(
                self._ws_path, self._changed_paths(event, src, dest, src_ok, dest_ok)
            )

    def _changed_paths(
        self,
        event: FileSystemEvent,
        src: str,
        dest: str,
        src_ok: bool,
        dest_ok: bool,
    ) -> list[tuple[str, str]]:
        """The (workspace-relative path, change) pairs this event contributes.

        A move is the only event naming two files — the old path is gone and
        the new one has appeared — so it splits into a deleted and a created
        entry; every other type maps to itself. Directory events carry no pair
        at all: they still mark the workspace dirty (the git refresh must fire
        exactly as before), they are just not file changes worth recording.
        """
        if event.is_directory:
            return []
        if event.event_type == "moved":
            pairs = []
            if src_ok:
                pairs.append((src, "deleted"))
            if dest_ok:
                pairs.append((dest, "created"))
        elif src_ok:
            pairs = [(src, str(event.event_type))]
        else:
            pairs = []
        out: list[tuple[str, str]] = []
        for path, change in pairs:
            rel = self._rel(path)
            if rel:
                out.append((rel, change))
        return out

    def _rel(self, src: str) -> str:
        """`src` as a path relative to the repo root, or "" if it is outside."""
        try:
            return str(Path(src).resolve().relative_to(self._root))
        except (ValueError, OSError):
            return ""

    def _is_plan_doc(self, src: str) -> bool:
        """True for a user-facing plan or report document (HTML or markdown) directly
        under one of the supported plan/report directories — infra files (`_` prefix),
        hidden files and `.history/` snapshots are excluded, so snapshot writes
        triggered by a plans event can never re-trigger it.

        The directory may sit at any depth: a nested plan root (a repository
        below the workspace) is listed by `plan_index`, so its documents have to
        push `plans.changed` too, or the list silently stops refreshing for them.
        Noise segments are still pruned — a plan-shaped path inside
        `node_modules` is a dependency's document, not the user's."""
        try:
            rel = Path(src).resolve().relative_to(self._root)
        except (ValueError, OSError):
            return False
        parts = rel.parts
        if len(parts) < 3:
            return False
        if (parts[-3], parts[-2]) not in PLAN_DOC_DIRS:
            return False
        # `.agent-team` is itself an ignored segment (run-log churn), so the
        # prefix check stops before the plan directory's own two segments.
        if any(seg in _IGNORE_SEGMENTS for seg in parts[:-3]):
            return False
        name = parts[-1]
        return name.endswith((".html", ".plan.md", ".md")) and not name.startswith(("_", "."))

    def _is_relevant(self, src: str) -> bool:
        try:
            rel = Path(src).resolve().relative_to(self._root)
        except (ValueError, OSError):
            return False
        parts = rel.parts
        if not parts:
            return False
        name = parts[-1]
        if name.endswith(".lock"):
            return False  # index.lock, ref locks — transient, ignore.
        if ".git" in parts:
            gi = parts.index(".git")
            sub = parts[gi + 1:]
            if not sub:
                return False
            return sub[0] not in _IGNORE_GIT_FIRST_LEVEL
        if "storage" in parts:
            si = parts.index("storage")
            sub = parts[si + 1:]
            if sub and sub[0] in _IGNORE_STORAGE_SUBDIRS:
                return False
        # Working tree: drop anything under a known build/dependency dir.
        return not any(seg in _IGNORE_SEGMENTS for seg in parts)


class GitWatcher:
    """One Observer, many repos. Lazily `watch()` a workspace the first time the
    GitPane looks at it; debounced `on_change(ws_path, paths)` fires on disk changes."""

    def __init__(
        self,
        on_change: PathChangeSink,
        *,
        on_plans_change: ChangeSink | None = None,
        debounce_s: float = 0.4,
    ) -> None:
        self._on_change = on_change
        self._on_plans_change = on_plans_change
        self._debounce_s = debounce_s
        self._loop: asyncio.AbstractEventLoop | None = None
        self._observer: Observer | None = None
        self._roots: dict[str, Path] = {}  # ws_path -> resolved root
        self._pending: dict[str, asyncio.TimerHandle] = {}
        # ws_path -> the (rel_path, event_type) pairs seen in the open window
        self._dirty_paths: dict[str, set[tuple[str, str]]] = {}
        self._pending_plans: dict[str, asyncio.TimerHandle] = {}
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._loop = asyncio.get_event_loop()
        self._observer = Observer()
        self._observer.start()
        log.info("GitWatcher started (debounce %.0fms)", self._debounce_s * 1000)

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        for th in self._pending.values():
            th.cancel()
        self._pending.clear()
        self._dirty_paths.clear()
        for th in self._pending_plans.values():
            th.cancel()
        self._pending_plans.clear()
        if self._observer:
            self._observer.stop()
            try:
                self._observer.join(timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
        log.info("GitWatcher stopped")

    def watch(self, ws_path: str) -> None:
        """Register a workspace to watch. Idempotent; safe to call on every
        git.status. No-op until start() has run."""
        if not self._started or self._observer is None or not ws_path:
            return
        if ws_path in self._roots:
            return
        try:
            root = Path(ws_path).resolve(strict=True)
        except OSError:
            return
        if not root.is_dir():
            return
        handler = _RepoHandler(
            root,
            ws_path,
            self._mark_dirty_threadsafe,
            self._mark_plans_dirty_threadsafe if self._on_plans_change else None,
        )
        try:
            self._observer.schedule(handler, str(root), recursive=True)
        except Exception as err:  # noqa: BLE001
            log.warning("GitWatcher schedule on %s failed: %s", root, err)
            return
        self._roots[ws_path] = root
        log.info("GitWatcher watching %s", root)

    # ───────────────────────── debounce (loop thread) ─────────────────────

    def _mark_dirty_threadsafe(
        self, ws_path: str, paths: list[tuple[str, str]]
    ) -> None:
        """Called from the watchdog observer thread → hop to the loop thread."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._schedule_fire, ws_path, paths)
        except RuntimeError:
            pass  # loop closed mid-flight

    def _schedule_fire(self, ws_path: str, paths: list[tuple[str, str]]) -> None:
        loop = self._loop
        if loop is None:
            return
        if paths:
            self._dirty_paths.setdefault(ws_path, set()).update(paths)
        existing = self._pending.get(ws_path)
        if existing is not None:
            existing.cancel()
        self._pending[ws_path] = loop.call_later(
            self._debounce_s, self._fire, ws_path
        )

    def _fire(self, ws_path: str) -> None:
        self._pending.pop(ws_path, None)
        paths = sorted(self._dirty_paths.pop(ws_path, set()))
        asyncio.create_task(self._on_change(ws_path, paths))

    # ─────────────────── plans channel (same debounce model) ──────────────

    def _mark_plans_dirty_threadsafe(self, ws_path: str) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._schedule_fire_plans, ws_path)
        except RuntimeError:
            pass  # loop closed mid-flight

    def _schedule_fire_plans(self, ws_path: str) -> None:
        loop = self._loop
        if loop is None:
            return
        existing = self._pending_plans.get(ws_path)
        if existing is not None:
            existing.cancel()
        self._pending_plans[ws_path] = loop.call_later(
            self._debounce_s, self._fire_plans, ws_path
        )

    def _fire_plans(self, ws_path: str) -> None:
        self._pending_plans.pop(ws_path, None)
        if self._on_plans_change is not None:
            asyncio.create_task(self._on_plans_change(ws_path))
