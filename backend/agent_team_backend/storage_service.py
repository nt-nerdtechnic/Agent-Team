"""Disk-usage accounting and cleanup for the "Storage usage" settings page.

Two entry points, both blocking (callers offload with ``asyncio.to_thread``):

- ``collect_usage()`` walks the app-data dir, the CLI profile homes, the
  per-pane codex homes and every open workspace's ``.agent-team`` dir, and
  reports the bytes each bucket costs.
- ``cleanup()`` deletes the buckets the caller names.

Two invariants the whole module is built around:

1. **Symlinks are never followed.** ``~/.codex-panes/*`` and
   ``<app_data>/runtime/skills/*`` are dense symlink farms pointing back at
   shared config; following them double-counts and can loop. Every
   ``stat``/``is_dir`` call passes ``follow_symlinks=False`` and a symlink
   itself counts as zero bytes.
2. **Every deletion is root-guarded.** A path is resolved and asserted to be
   strictly inside the root its bucket declares before anything is removed —
   the same shape as ``CodexHomeManager.cleanup``.

Scan errors (permissions, races) are collected into an ``errors`` list rather
than raised: a single unreadable directory must not blank the whole page.
"""

from __future__ import annotations

import os
import shutil
import stat
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from .applog import app_data_dir
from .credential_vault import LOGIN_HOME_DIRNAME
from .history_store import HISTORY_FILE
from .plan_history import HISTORY_DIR_NAME as PLAN_HISTORY_DIR_NAME
from .profiles_store import PROFILE_HOME_DIRNAME, default_profiles_root
from .projects import PROJECT_DIR_NAME, RUNS_SUBDIR
from .skills_store import SKILLS_DIR, SKILLS_RUNTIME_DIR
from .spawn_history import entry_manual_log_names, read_stored_entries
from .store_migrations import BACKUP_DIR
from .tokens_store import (
    INGESTION_STATE_FILE,
    PERSISTENCE_JOURNAL_FILE,
    WORKSPACES_SUBDIR,
)
from .usage_service import USAGE_CACHE_FILE

DEFAULT_STALE_DAYS = 30
MAX_REPORTED_PATHS = 5

MANUAL_LOGS_DIRNAME = "manual"
PIPELINE_LOG_FILE = "pipeline.log"
PLANS_DIRNAME = "plans"
LOGS_DIRNAME = "logs"
BACKEND_LOG_FILE = "backend.log"
# RotatingFileHandler(backupCount=5) in applog.setup_file_logging.
BACKEND_LOG_BACKUPS = 5

# Chromium/Electron state that lands in the same dir Electron uses as
# ``userData`` — which on macOS is exactly ``app_data_dir()``.
CHROMIUM_CACHE_ENTRIES = (
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
)
BROWSER_STATE_ENTRIES = (
    "Local Storage",
    "Session Storage",
    "blob_storage",
    "Shared Dictionary",
)
BROWSER_STATE_GLOBS = ("Cookies*",)

# Slot subdirs that only ever hold regenerable CLI scratch data.
PROFILE_CACHE_HOME_ENTRIES = ("cache", ".cache", "shell-snapshots", "file-history")
PROFILE_HISTORY_HOME_ENTRY = "projects"
ARCHIVED_SLOT_MARKERS = (".deleted-", ".migrated-")


class StorageGuardError(Exception):
    """A deletion target resolved outside the root its bucket declares."""


# ── root resolvers (patched wholesale in tests) ─────────────────────────────


def app_data_root() -> Path:
    return app_data_dir()


def profiles_root() -> Path:
    return default_profiles_root()


def codex_panes_root() -> Path:
    return Path.home() / ".codex-panes"


def updater_cache_paths() -> list[Path]:
    """Electron updater scratch dirs. Empty on platforms without them."""
    caches = Path.home() / "Library" / "Caches"
    if not caches.is_dir():
        return []
    found = [caches / "agent-team-updater"]
    found.extend(sorted(caches.glob("com.nerdtechnic.agent-team*")))
    return [p for p in found if p.exists()]


# ── size accounting (never follows a symlink) ───────────────────────────────


def _record_error(errors: list[dict[str, str]], path: Path | str, err: Exception) -> None:
    errors.append({"path": str(path), "message": str(err)})


def _dir_usage(root: Path, errors: list[dict[str, str]]) -> tuple[int, int]:
    """``(bytes, fileCount)`` for a directory tree, symlinks counted as 0 bytes.

    Iterative on purpose: a deep tree must not blow the Python stack, and an
    unreadable subdirectory only costs one error entry.
    """
    total = 0
    files = 0
    stack: list[Path] = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            # A symlink costs only its own inode; the target
                            # is either counted elsewhere or lives outside.
                            files += 1
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        else:
                            total += entry.stat(follow_symlinks=False).st_size
                            files += 1
                    except OSError as err:
                        _record_error(errors, entry.path, err)
        except FileNotFoundError:
            continue
        except OSError as err:
            _record_error(errors, current, err)
    return total, files


def _path_usage(path: Path, errors: list[dict[str, str]]) -> tuple[int, int]:
    """``(bytes, fileCount)`` for a file, a tree or a missing path (0, 0)."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return 0, 0
    except OSError as err:
        _record_error(errors, path, err)
        return 0, 0
    if stat.S_ISLNK(st.st_mode):
        return 0, 1
    if stat.S_ISDIR(st.st_mode):
        return _dir_usage(path, errors)
    return st.st_size, 1


# ── deletion guards ─────────────────────────────────────────────────────────


def _guarded_target(target: Path, root: Path) -> Path:
    """Resolve ``target`` and assert it sits strictly inside ``root``.

    The final path component is deliberately *not* resolved so that a symlink
    can be unlinked in place instead of being chased to whatever it points at.
    """
    resolved_root = root.resolve()
    try:
        resolved = target.parent.resolve() / target.name
    except OSError as err:
        raise StorageGuardError(f"cannot resolve {target}: {err}") from err
    if resolved == resolved_root:
        raise StorageGuardError(f"refusing to remove the root itself: {resolved_root}")
    try:
        resolved.relative_to(resolved_root)
    except ValueError:
        raise StorageGuardError(
            f"refusing to remove path outside {resolved_root}: {resolved}"
        ) from None
    return resolved


def _remove_guarded(target: Path, root: Path) -> tuple[int, int]:
    """Delete ``target`` after the root guard; returns ``(freed, fileCount)``."""
    _guarded_target(target, root)
    try:
        st = os.lstat(target)
    except FileNotFoundError:
        return 0, 0
    freed, count = _path_usage(target, [])
    if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
        shutil.rmtree(target)
    else:
        target.unlink()
    return freed, count


def _truncate_guarded(target: Path, root: Path) -> tuple[int, int]:
    """Truncate ``target`` to zero after the root guard.

    Used for the live ``backend.log``: the RotatingFileHandler holds an open
    fd, so unlinking it would silently send every later log line to a deleted
    inode until the next rotation.
    """
    _guarded_target(target, root)
    try:
        st = os.lstat(target)
    except FileNotFoundError:
        return 0, 0
    if not stat.S_ISREG(st.st_mode):
        raise StorageGuardError(f"refusing to truncate a non-regular file: {target}")
    os.truncate(target, 0)
    return st.st_size, 1


# ── item model ──────────────────────────────────────────────────────────────


@dataclass
class _Item:
    """One row of the settings page, plus the bookkeeping cleanup needs.

    ``paths`` is the full target list; the wire payload only carries the first
    ``MAX_REPORTED_PATHS`` of them. ``root`` is the directory every target must
    resolve inside before it can be deleted.
    """

    id: str
    risk: str
    cleanable: bool
    root: Path
    paths: list[Path] = field(default_factory=list)
    bytes: int = 0
    file_count: int = 0
    handled_by: str = "backend"
    note: str | None = None
    truncate: bool = False

    def payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "bytes": self.bytes,
            "fileCount": self.file_count,
            "paths": [str(p) for p in self.paths[:MAX_REPORTED_PATHS]],
            "risk": self.risk,
            "cleanable": self.cleanable,
            "handledBy": self.handled_by,
            "note": self.note,
        }


@dataclass
class _Group:
    id: str
    root_path: str
    items: list[_Item] = field(default_factory=list)

    def payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "rootPath": self.root_path,
            "totalBytes": sum(i.bytes for i in self.items),
            "items": [i.payload() for i in self.items],
        }


def _measured(
    item: _Item, errors: list[dict[str, str]], *, existing_only: bool = True
) -> _Item:
    """Fill in ``bytes``/``fileCount`` and drop targets that do not exist."""
    kept: list[Path] = []
    total = 0
    files = 0
    for path in item.paths:
        size, count = _path_usage(path, errors)
        if existing_only and count == 0 and not path.exists():
            continue
        kept.append(path)
        total += size
        files += count
    item.paths = kept
    item.bytes = total
    item.file_count = files
    return item


def _remainder(
    item: _Item, tree_total: tuple[int, int], claimed: Iterable[_Item]
) -> _Item:
    """Turn ``item`` into the "everything else under this tree" bucket."""
    claimed_bytes = sum(i.bytes for i in claimed)
    claimed_files = sum(i.file_count for i in claimed)
    item.bytes = max(0, tree_total[0] - claimed_bytes)
    item.file_count = max(0, tree_total[1] - claimed_files)
    return item


# ── stale-ness helpers ──────────────────────────────────────────────────────


def coerce_stale_days(value: Any) -> int:
    try:
        days = int(value)
    except (TypeError, ValueError):
        return DEFAULT_STALE_DAYS
    return days if days > 0 else DEFAULT_STALE_DAYS


def _is_archived_slot(name: str) -> bool:
    return any(marker in name for marker in ARCHIVED_SLOT_MARKERS)


def _parse_ymd(name: str) -> datetime | None:
    """``20260729`` → that day at UTC midnight; None for anything else."""
    try:
        return datetime.strptime(name, "%Y%m%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _iter_dirs(root: Path, errors: list[dict[str, str]]) -> list[Path]:
    """Immediate real subdirectories of ``root`` (symlinks excluded)."""
    found: list[Path] = []
    try:
        with os.scandir(root) as it:
            for entry in it:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        found.append(Path(entry.path))
                except OSError as err:
                    _record_error(errors, entry.path, err)
    except FileNotFoundError:
        return []
    except OSError as err:
        _record_error(errors, root, err)
    return sorted(found)


# ── group builders ──────────────────────────────────────────────────────────


def _appdata_and_electron_groups(
    errors: list[dict[str, str]],
) -> tuple[_Group, _Group]:
    root = app_data_root()
    logs = root / LOGS_DIRNAME

    rotated = _measured(
        _Item(
            "rotatedLogs",
            risk="safe",
            cleanable=True,
            root=root,
            paths=[
                logs / f"{BACKEND_LOG_FILE}.{n}"
                for n in range(1, BACKEND_LOG_BACKUPS + 1)
            ],
        ),
        errors,
    )
    current = _measured(
        _Item(
            "currentLog",
            risk="safe",
            cleanable=True,
            root=root,
            paths=[logs / BACKEND_LOG_FILE],
            truncate=True,
            note="Truncated in place; the running backend keeps writing to it.",
        ),
        errors,
    )
    ingestion = _measured(
        _Item(
            "tokenIngestionState",
            risk="caution",
            cleanable=True,
            root=root,
            paths=[root / INGESTION_STATE_FILE, root / PERSISTENCE_JOURNAL_FILE],
            note=(
                "Token ingestion restarts from scratch; already-counted CLI "
                "usage may be ingested again and double-count."
            ),
        ),
        errors,
    )
    ws_tokens = _measured(
        _Item(
            "workspaceTokenStats",
            risk="caution",
            cleanable=True,
            root=root,
            paths=[root / WORKSPACES_SUBDIR],
            note="Per-workspace token history is lost; lifetime totals survive.",
        ),
        errors,
    )
    backups = _measured(
        _Item(
            "storeBackups",
            risk="safe",
            cleanable=True,
            root=root,
            paths=[root / BACKUP_DIR, *sorted(root.glob("_pipeline-backup-*"))],
            note="Pre-migration copies of the store files; only needed to roll back.",
        ),
        errors,
    )
    runtime = _measured(
        _Item(
            "runtimeArtifacts",
            risk="safe",
            cleanable=True,
            root=root,
            paths=[root / Path(SKILLS_RUNTIME_DIR).parts[0]],
            note="Regenerated on the next app start.",
        ),
        errors,
    )
    usage_cache = _measured(
        _Item(
            "usageCache",
            risk="safe",
            cleanable=True,
            root=root,
            paths=[root / USAGE_CACHE_FILE],
            note="CLI quota badges refetch on the next poll.",
        ),
        errors,
    )
    skills = _measured(
        _Item(
            "installedSkills",
            risk="danger",
            cleanable=True,
            root=root,
            paths=[root / SKILLS_DIR],
            note="Removes every installed skill; they must be reinstalled.",
        ),
        errors,
    )

    chromium = _measured(
        _Item(
            "chromiumCache",
            risk="safe",
            cleanable=True,
            root=root,
            paths=[root / name for name in CHROMIUM_CACHE_ENTRIES],
            handled_by="electron",
            note="Cleared by the main process; the window reloads its cache.",
        ),
        errors,
    )
    updater = _measured(
        _Item(
            "updaterCache",
            risk="safe",
            cleanable=True,
            root=Path.home() / "Library" / "Caches",
            paths=updater_cache_paths(),
            handled_by="electron",
            note="Downloaded update payloads; refetched if an update is needed.",
        ),
        errors,
    )
    browser_state_paths = [root / name for name in BROWSER_STATE_ENTRIES]
    for pattern in BROWSER_STATE_GLOBS:
        browser_state_paths.extend(sorted(root.glob(pattern)))
    browser = _measured(
        _Item(
            "browserState",
            risk="danger",
            cleanable=False,
            root=root,
            paths=browser_state_paths,
            handled_by="electron",
            note="Holds signed-in sessions and UI state; not offered for cleanup.",
        ),
        errors,
    )

    app_items = [
        rotated,
        current,
        ingestion,
        ws_tokens,
        backups,
        runtime,
        usage_cache,
        skills,
    ]
    other = _Item(
        "appDataOther",
        risk="danger",
        cleanable=False,
        root=root,
        note="Settings, sessions and token totals — inspect before removing anything.",
    )
    claimed_names = {
        p.name for item in [*app_items, chromium, browser] for p in item.paths
    }
    claimed_names.add(LOGS_DIRNAME)
    other.paths = [
        p for p in _top_level_entries(root, errors) if p.name not in claimed_names
    ][:MAX_REPORTED_PATHS]
    _remainder(
        other,
        _path_usage(root, errors),
        [*app_items, chromium, browser],
    )
    # logs/ may hold more than backend.log*, so fold the leftover back in.
    app_items.append(other)

    app_group = _Group("appData", str(root), app_items)
    electron_group = _Group("electron", str(root), [chromium, updater, browser])
    return app_group, electron_group


def _top_level_entries(root: Path, errors: list[dict[str, str]]) -> list[Path]:
    try:
        with os.scandir(root) as it:
            return sorted(Path(e.path) for e in it)
    except FileNotFoundError:
        return []
    except OSError as err:
        _record_error(errors, root, err)
        return []


def _cli_homes_group(stale_days: int, errors: list[dict[str, str]]) -> _Group:
    root = profiles_root()
    panes = codex_panes_root()

    archived: list[Path] = []
    caches: list[Path] = []
    history: list[Path] = []
    for agent_dir in _iter_dirs(root, errors):
        for slot in _iter_dirs(agent_dir, errors):
            if _is_archived_slot(slot.name):
                archived.append(slot)
                continue
            home = slot / PROFILE_HOME_DIRNAME
            caches.extend(home / name for name in PROFILE_CACHE_HOME_ENTRIES)
            caches.append(slot / LOGIN_HOME_DIRNAME)
            history.append(home / PROFILE_HISTORY_HOME_ENTRY)

    archived_item = _measured(
        _Item(
            "cliProfilesArchived",
            risk="safe",
            cleanable=True,
            root=root,
            paths=archived,
            note="Homes of deleted or migrated CLI accounts; kept only as a safety net.",
        ),
        errors,
    )
    caches_item = _measured(
        _Item(
            "cliProfileCaches",
            risk="safe",
            cleanable=True,
            root=root,
            paths=caches,
            note="CLI scratch caches and disposable login homes; regenerated on demand.",
        ),
        errors,
    )
    history_item = _measured(
        _Item(
            "cliProfileHistory",
            risk="danger",
            cleanable=True,
            root=root,
            paths=history,
            note="Deletes CLI conversation transcripts; sessions can no longer be resumed.",
        ),
        errors,
    )
    other_item = _remainder(
        _Item(
            "cliProfileOther",
            risk="danger",
            cleanable=False,
            root=root,
            paths=[root],
            note="Live CLI credentials and config for the accounts still in use.",
        ),
        _path_usage(root, errors),
        [archived_item, caches_item, history_item],
    )

    cutoff = time.time() - stale_days * 86400
    stale_panes: list[Path] = []
    recent_panes: list[Path] = []
    for pane in _iter_dirs(panes, errors):
        try:
            mtime = pane.lstat().st_mtime
        except OSError as err:
            _record_error(errors, pane, err)
            continue
        (stale_panes if mtime < cutoff else recent_panes).append(pane)

    stale_item = _measured(
        _Item(
            "codexPanesStale",
            risk="caution",
            cleanable=True,
            root=panes,
            paths=stale_panes,
            note=(
                f"Per-pane Codex homes untouched for over {stale_days} days. "
                "Staleness is judged by mtime only — resuming any Codex session "
                "that still uses one of these homes will break."
            ),
        ),
        errors,
    )
    recent_item = _measured(
        _Item(
            "codexPanesRecent",
            risk="caution",
            cleanable=False,
            root=panes,
            paths=recent_panes,
            note="Recently used Codex pane homes; likely still resumable.",
        ),
        errors,
    )

    return _Group(
        "cliHomes",
        str(root),
        [archived_item, caches_item, history_item, other_item, stale_item, recent_item],
    )


# ── workspace group ─────────────────────────────────────────────────────────


def _referenced_manual_logs(workspace_path: str) -> set[str]:
    """Manual-log *filenames* still referenced by a spawn-history entry.

    Matching is by filename, not full path: the renderer rewrites an entry's
    ``spawnedAt`` on restore, so the date folder derived from it is unreliable
    while ``<agentKey>-<paneId[:8]>.log`` is stable (see
    ``spawn_history.entry_manual_log_names``).
    """
    names: set[str] = set()
    for entry in read_stored_entries(workspace_path):
        names |= entry_manual_log_names(entry)
    return names


def _manual_log_buckets(
    workspace_path: str, data_dir: Path, stale_days: int, errors: list[dict[str, str]]
) -> tuple[list[Path], list[Path], list[Path]]:
    """Split ``manual/**`` files into (orphan, stale, recent)."""
    manual = data_dir / MANUAL_LOGS_DIRNAME
    referenced = _referenced_manual_logs(workspace_path)
    cutoff = datetime.now(timezone.utc) - timedelta(days=stale_days)
    orphan: list[Path] = []
    stale: list[Path] = []
    recent: list[Path] = []
    for day_dir in _iter_dirs(manual, errors):
        day = _parse_ymd(day_dir.name)
        try:
            with os.scandir(day_dir) as it:
                files = sorted(
                    Path(e.path) for e in it if not e.is_dir(follow_symlinks=False)
                )
        except FileNotFoundError:
            continue
        except OSError as err:
            _record_error(errors, day_dir, err)
            continue
        for path in files:
            if path.name not in referenced:
                orphan.append(path)
            elif day is not None and day < cutoff:
                stale.append(path)
            else:
                # Unparseable day folders stay in the non-cleanable bucket.
                recent.append(path)
    return orphan, stale, recent


def _workspaces_group(
    workspace_paths: list[str], stale_days: int, errors: list[dict[str, str]]
) -> _Group:
    seen: set[Path] = set()
    scanned: list[tuple[str, Path]] = []
    for raw in workspace_paths:
        data_dir = Path(raw) / PROJECT_DIR_NAME
        if data_dir.is_dir() and data_dir not in seen:
            seen.add(data_dir)
            scanned.append((raw, data_dir))
    data_dirs = [d for _, d in scanned]

    orphan: list[Path] = []
    stale: list[Path] = []
    recent: list[Path] = []
    pipeline_history: list[Path] = []
    pipeline_logs: list[Path] = []
    plan_history: list[Path] = []
    for workspace_path, data_dir in scanned:
        o, s, r = _manual_log_buckets(workspace_path, data_dir, stale_days, errors)
        orphan.extend(o)
        stale.extend(s)
        recent.extend(r)
        pipeline_history.append(data_dir / HISTORY_FILE)
        pipeline_logs.append(data_dir / PIPELINE_LOG_FILE)
        pipeline_logs.append(data_dir / RUNS_SUBDIR)
        plan_history.append(data_dir / PLANS_DIRNAME / PLAN_HISTORY_DIR_NAME)

    # Each workspace guards against its own .agent-team dir, so multi-workspace
    # items carry the common ancestor only for reporting; deletion re-derives
    # the per-path root below.
    root_display = str(data_dirs[0]) if data_dirs else ""

    items = [
        _measured(
            _Item(
                "manualLogsOrphan",
                risk="safe",
                cleanable=True,
                root=Path("/"),
                paths=orphan,
                note="Logs whose Agent History entry is already gone.",
            ),
            errors,
        ),
        _measured(
            _Item(
                "manualLogsStale",
                risk="caution",
                cleanable=True,
                root=Path("/"),
                paths=stale,
                note=f"Agent logs older than {stale_days} days; the history entries stay.",
            ),
            errors,
        ),
        _measured(
            _Item(
                "manualLogsRecent",
                risk="caution",
                cleanable=False,
                root=Path("/"),
                paths=recent,
                note="Recent agent logs still reachable from Agent History.",
            ),
            errors,
        ),
        _measured(
            _Item(
                "pipelineHistory",
                risk="caution",
                cleanable=True,
                root=Path("/"),
                paths=pipeline_history,
                note="Clears the pipeline event history feed.",
            ),
            errors,
        ),
        _measured(
            _Item(
                "pipelineLogs",
                risk="caution",
                cleanable=True,
                root=Path("/"),
                paths=pipeline_logs,
                note="Pipeline run logs; past runs can no longer be inspected.",
            ),
            errors,
        ),
        _measured(
            _Item(
                "planHistory",
                risk="safe",
                cleanable=True,
                root=Path("/"),
                paths=plan_history,
                note="Plan document snapshots; the current plans are untouched.",
            ),
            errors,
        ),
    ]
    tree_total = (0, 0)
    for data_dir in data_dirs:
        size, count = _path_usage(data_dir, errors)
        tree_total = (tree_total[0] + size, tree_total[1] + count)
    other = _remainder(
        _Item(
            "workspaceOther",
            risk="danger",
            cleanable=False,
            root=Path("/"),
            paths=data_dirs[:MAX_REPORTED_PATHS],
            note="Project settings, chat threads, plans and reports.",
        ),
        tree_total,
        items,
    )
    items.append(other)
    return _Group("workspaces", root_display, items)


def _workspace_item_root(path: Path) -> Path:
    """The ``.agent-team`` dir a workspace-group target must stay inside."""
    for parent in path.parents:
        if parent.name == PROJECT_DIR_NAME:
            return parent
    raise StorageGuardError(f"path is not inside a {PROJECT_DIR_NAME} dir: {path}")


# ── public API ──────────────────────────────────────────────────────────────


def _scan(
    workspace_paths: list[str], stale_days: int
) -> tuple[list[_Group], list[dict[str, str]]]:
    errors: list[dict[str, str]] = []
    app_group, electron_group = _appdata_and_electron_groups(errors)
    groups = [
        app_group,
        electron_group,
        _cli_homes_group(stale_days, errors),
        _workspaces_group(workspace_paths, stale_days, errors),
    ]
    return groups, errors


def collect_usage(
    workspace_paths: list[str], stale_days: Any = DEFAULT_STALE_DAYS
) -> dict[str, Any]:
    """Full storage report. Blocking — call via ``asyncio.to_thread``."""
    days = coerce_stale_days(stale_days)
    groups, errors = _scan(workspace_paths, days)
    group_payloads = [g.payload() for g in groups]
    try:
        usage = shutil.disk_usage(app_data_root())
        disk = {"totalBytes": usage.total, "freeBytes": usage.free}
    except OSError as err:
        _record_error(errors, app_data_root(), err)
        disk = {"totalBytes": 0, "freeBytes": 0}
    return {
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "staleDays": days,
        "totalBytes": sum(g["totalBytes"] for g in group_payloads),
        "disk": disk,
        "groups": group_payloads,
        "errors": errors,
    }


def _clean_item(item: _Item) -> dict[str, Any]:
    freed = 0
    removed = 0
    problems: list[str] = []
    for path in item.paths:
        root = item.root
        if root == Path("/"):
            # Workspace items span several workspaces; guard per path.
            try:
                root = _workspace_item_root(path)
            except StorageGuardError as err:
                problems.append(str(err))
                continue
        try:
            if item.truncate:
                size, count = _truncate_guarded(path, root)
            else:
                size, count = _remove_guarded(path, root)
        except (StorageGuardError, OSError) as err:
            problems.append(f"{path}: {err}")
            continue
        freed += size
        removed += count
    return {
        "itemId": item.id,
        "ok": not problems,
        "freedBytes": freed,
        "removedCount": removed,
        "error": "; ".join(problems) or None,
    }


def cleanup(
    item_ids: list[str],
    workspace_paths: list[str],
    stale_days: Any = DEFAULT_STALE_DAYS,
) -> dict[str, Any]:
    """Delete the named buckets. Blocking — call via ``asyncio.to_thread``.

    Unknown ids, info-only buckets and Electron-owned buckets each yield an
    ``ok: false`` result rather than an exception, so one bad id in a batch
    never aborts the rest. ``removedCount`` counts files, not top-level paths.
    """
    days = coerce_stale_days(stale_days)
    groups, _ = _scan(workspace_paths, days)
    by_id = {item.id: item for group in groups for item in group.items}

    results: list[dict[str, Any]] = []
    total = 0
    for item_id in item_ids:
        item = by_id.get(item_id)
        if item is None:
            results.append(_refused(item_id, f"unknown item id {item_id!r}"))
            continue
        if not item.cleanable:
            results.append(_refused(item_id, f"{item_id} is not cleanable"))
            continue
        if item.handled_by != "backend":
            results.append(
                _refused(item_id, f"{item_id} is cleaned by the {item.handled_by} side")
            )
            continue
        result = _clean_item(item)
        total += result["freedBytes"]
        results.append(result)
    return {"totalFreedBytes": total, "results": results}


def _refused(item_id: str, message: str) -> dict[str, Any]:
    return {
        "itemId": item_id,
        "ok": False,
        "freedBytes": 0,
        "removedCount": 0,
        "error": message,
    }
