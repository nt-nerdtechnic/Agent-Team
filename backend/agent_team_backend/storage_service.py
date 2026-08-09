"""Disk-usage accounting and cleanup for the "Storage usage" settings page.

Two entry points, both blocking (callers offload with ``asyncio.to_thread``):

- ``collect_usage()`` walks the app-data dir, the CLI profile homes, the
  per-pane codex homes and every open workspace's ``.agent-team`` dir, and
  reports the bytes each bucket costs.
- ``cleanup()`` deletes the buckets the caller names.

Three invariants the whole module is built around:

1. **Symlinks are never followed.** ``~/.codex-panes/*``, ``~/.navide-panes/*``
   and ``<app_data>/runtime/skills/*`` are dense symlink farms pointing back at
   shared config — a ``~/.navide-panes`` home mirrors the whole real home, so
   following one would walk the user's entire disk. Every
   ``stat``/``is_dir`` call passes ``follow_symlinks=False`` and a symlink
   itself counts as zero bytes.
2. **Every deletion is root-guarded.** A path is resolved and asserted to be
   strictly inside the root its bucket declares before anything is removed —
   the same shape as ``CodexHomeManager.cleanup``.
3. **Unknown is never orphan.** Buckets that mean "nothing references this any
   more" are only filled when every source the reference set is built from was
   readable; one unreadable source protects the whole bucket.

Scan errors (permissions, races) are collected into an ``errors`` list rather
than raised: a single unreadable directory must not blank the whole page.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import stat
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from .applog import app_data_dir
from .credential_vault import LOGIN_HOME_DIRNAME
from .db import DB_FILENAME, MIGRATED_SUFFIX
from .history_store import HISTORY_FILE
from .plan_history import HISTORY_DIR_NAME as PLAN_HISTORY_DIR_NAME
from .plugins.builtin.navide_plans import pane_home
from .profiles_store import PROFILE_HOME_DIRNAME, default_profiles_root
from .projects import (
    PROJECT_DIR_NAME,
    PROJECT_FILE,
    RUNS_SUBDIR,
    _KV_KEY as PROJECT_KV_KEY,
)
from .recent_workspaces import RECENT_FILE, _KV_KEY as RECENT_KV_KEY
from .skills_store import SKILLS_DIR, SKILLS_RUNTIME_DIR
from .spawn_history import (
    SPAWN_HISTORY_FILE,
    _KV_KEY as SPAWN_HISTORY_KV_KEY,
    entry_manual_log_names,
    read_stored_entries,
    read_stored_entries_checked,
)
from .store_migrations import BACKUP_DIR
from .terminals import live_output_log_paths
from .tokens_store import WORKSPACES_SUBDIR
from .usage_service import USAGE_CACHE_FILE

DEFAULT_STALE_DAYS = 30
MAX_REPORTED_PATHS = 5

# Mirrors the path built in plugins/builtin/navide_skills/skills_wiring.py; the
# plugin has no constant to import and importing a plugin from here would be
# the wrong direction.
CLAUDE_SKILLS_RUNTIME_DIR = "runtime/claude-managed-skills"

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

# A manual log touched this recently counts as live even when the terminal
# service does not claim it. Safety net for the cases the in-process set
# cannot cover: a pane whose backend was restarted under it, or a scan racing
# a spawn that has not registered its log yet.
LIVE_LOG_MTIME_WINDOW_SECONDS = 15 * 60

# A Codex pane home touched this recently counts as in use even when no pane
# record names it: ``CodexHomeManager.prepare`` creates the home before the
# renderer persists the pane record, so a scan racing a spawn would otherwise
# call a brand-new home an orphan.
CODEX_HOME_GRACE_SECONDS = 24 * 3600

# Directories the OS mounts volumes under. A missing child of one of these is
# a disk that is not plugged in, not a folder somebody deleted.
MOUNT_HOST_DIRS = ("/Volumes", "/mnt", "/media", "/net")


class StorageGuardError(Exception):
    """A deletion target resolved outside the root its bucket declares."""


# ── root resolvers (patched wholesale in tests) ─────────────────────────────


def app_data_root() -> Path:
    return app_data_dir()


def profiles_root() -> Path:
    return default_profiles_root()


def codex_panes_root() -> Path:
    return Path.home() / ".codex-panes"


def shim_panes_root() -> Path:
    """Per-pane MCP shim homes for kimi/grok/antigravity, one level deeper
    than the codex panes root: ``<agent>/<pane id>``."""
    return Path.home() / pane_home.PANES_DIR_NAME


def updater_cache_paths() -> list[Path]:
    """The updater scratch dir. Empty on platforms without it.

    Deliberately *only* ``<appName>-updater``, matching exactly what the main
    process clears. The appId-namespaced neighbours are never cleared — one is
    the live CFNetwork HTTP cache (unsafe to remove while the app runs), the
    other Squirrel's install state machine (removing it mid-install breaks the
    update) — so reporting their bytes under a cleanable item would promise
    space that no cleanup can ever free.
    """
    caches = Path.home() / "Library" / "Caches"
    # Both spellings, because main matches `<appName>-updater` for the package
    # name *and* the (renamed) product name.
    found = [caches / f"{name}-updater" for name in ("agent-team", "Navide")]
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
    navide_db = _measured(
        _Item(
            "navideDatabase",
            risk="danger",
            cleanable=False,
            root=root,
            paths=[root / DB_FILENAME],
            note="Settings, token accounting and registries; never cleaned from here.",
        ),
        errors,
    )
    backups = _measured(
        _Item(
            "storeBackups",
            risk="safe",
            cleanable=True,
            root=root,
            paths=[
                root / BACKUP_DIR,
                *sorted(root.glob("_pipeline-backup-*")),
                # JSON stores retired by the SQLite import; kept only as a
                # rollback safety net.
                *sorted(root.glob(f"*{MIGRATED_SUFFIX}")),
                *sorted((root / WORKSPACES_SUBDIR).glob(f"*/*{MIGRATED_SUFFIX}")),
            ],
            note="Pre-migration copies of the store files; only needed to roll back.",
        ),
        errors,
    )
    runtime = _measured(
        _Item(
            "runtimeArtifacts",
            # Regenerated on the next app *start*, but this runs mid-session:
            # an open Codex pane symlinks its skills view into the projection,
            # so clearing it now leaves that pane pointing at nothing.
            risk="caution",
            cleanable=True,
            root=root,
            # Deliberately the skill projections only, not the whole `runtime`
            # dir: git_askpass_helper.py lives beside them and its path is
            # resolved once at import, so removing it breaks every
            # authenticated git operation until the backend restarts.
            paths=[root / SKILLS_RUNTIME_DIR, root / CLAUDE_SKILLS_RUNTIME_DIR],
            note="Skill projections; rebuilt on the next app start.",
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
        navide_db,
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


def _read_json_object(
    path: Path, errors: list[dict[str, str]]
) -> tuple[dict[str, Any] | None, bool]:
    """``(document, readable)`` for a JSON object on disk.

    A file that is simply absent yields ``(None, True)``: "this workspace has
    no records" is an answer, not a failure. Everything else — a permission
    error, a half-written file, a document that is not an object — yields
    ``(None, False)`` plus an entry in ``errors``, so callers can fail closed.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, True
    except (OSError, ValueError) as err:
        _record_error(errors, path, err)
        return None, False
    if not isinstance(data, dict):
        errors.append({"path": str(path), "message": "expected a JSON object"})
        return None, False
    return data, True


def _read_kv_object(
    data_dir: Path, kv_key: str, legacy_name: str, errors: list[dict[str, str]]
) -> tuple[dict[str, Any] | None, bool]:
    """A kv document from ``<data_dir>/navide.db``, with legacy JSON fallback.

    Read-only connection so a scan never blocks (or mutates) the app's own
    handle. Falls back to ``<data_dir>/<legacy_name>`` while the kv row does
    not exist yet (a data dir the running backend has not touched since the
    SQLite migration). Same ``(document, readable)`` contract as
    ``_read_json_object`` — an unreadable database, an unparseable row or a
    row that is not an object fails closed.
    """
    db_path = data_dir / DB_FILENAME
    if db_path.exists():
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            try:
                row = conn.execute(
                    "SELECT value FROM kv WHERE key = ?", (kv_key,)
                ).fetchone()
            finally:
                conn.close()
        except sqlite3.Error as err:
            _record_error(errors, db_path, err)
            return None, False
        if row is not None:
            try:
                data = json.loads(row[0])
            except ValueError as err:
                _record_error(errors, db_path, err)
                return None, False
            if not isinstance(data, dict):
                errors.append({"path": str(db_path), "message": "expected a JSON object"})
                return None, False
            return data, True
    return _read_json_object(data_dir / legacy_name, errors)


def _read_recent_registry(
    errors: list[dict[str, str]]
) -> tuple[dict[str, Any] | None, bool]:
    """The recent-workspaces document, from ``navide.db``'s kv table."""
    return _read_kv_object(app_data_root(), RECENT_KV_KEY, RECENT_FILE, errors)


def _workspace_codex_home_ids(
    data_dir: Path, errors: list[dict[str, str]]
) -> tuple[set[str], bool]:
    """``(home ids this workspace still points at, readable)``.

    Two record stores matter (both in the workspace navide.db, with the
    retired JSON files as import-era fallback), and both are consulted in full:

    - the project document — every pane record, including the ones marked
      ``removed``: the id survives the removal and the App restores from it.
      Both ``pane_id`` (the home name a fresh Codex pane gets) and
      ``session_home_id`` (the home a restored pane keeps using) count.
    - spawn history — Agent History's "resume session" re-spawns from
      an entry's ``sessionId``, and Codex can only resume inside the home that
      recorded the rollout, so a history entry keeps its ``paneId`` home alive
      long after the pane record stopped mattering.
    """
    ids: set[str] = set()
    readable = True

    project, ok = _read_kv_object(data_dir, PROJECT_KV_KEY, PROJECT_FILE, errors)
    readable = readable and ok
    if project is not None:
        for key in ("panes", "manual_panes"):
            records = project.get(key)
            if not isinstance(records, list):
                continue
            for record in records:
                if not isinstance(record, dict):
                    continue
                for name in ("pane_id", "session_home_id"):
                    value = record.get(name)
                    if isinstance(value, str) and value:
                        ids.add(value)

    history, ok = _read_kv_object(
        data_dir, SPAWN_HISTORY_KV_KEY, SPAWN_HISTORY_FILE, errors
    )
    readable = readable and ok
    if history is not None:
        entries = history.get("entries")
        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                value = entry.get("paneId")
                if isinstance(value, str) and value:
                    ids.add(value)
        else:
            errors.append(
                {
                    "path": str(data_dir / SPAWN_HISTORY_FILE),
                    "message": "expected an 'entries' array",
                }
            )
            readable = False

    return ids, readable


def _is_deleted_path(path: str) -> bool:
    """True when a missing ``path`` is gone for good, not just away.

    Walks up to the nearest ancestor that still exists — never following a
    symlink, always stopping at the filesystem root. A deleted folder leaves a
    live ancestor behind on a mounted volume. Two shapes say "away" instead,
    and both answer False so the caller keeps failing closed:

    - the first missing component is a child of a mount host (``/Volumes/…``):
      that is a disk nobody plugged in, not a folder anybody deleted;
    - an ancestor cannot be stat'd at all (permissions, a dead network mount):
      an un-stat-able parent is unknown, and unknown is never "deleted".
    """
    current = Path(path)
    while True:
        parent = current.parent
        if parent == current:
            # Walked past every component without finding a live ancestor.
            return False
        try:
            os.lstat(parent)
        except FileNotFoundError:
            current = parent
            continue
        except OSError:
            return False
        return os.fspath(parent) not in MOUNT_HOST_DIRS


def _classify_pane_homes(
    panes: Path,
    referenced: set[str],
    established: bool,
    grace_cutoff: float,
    errors: list[dict[str, str]],
) -> tuple[list[Path], list[Path]]:
    """Split a directory whose children are pane-id homes into ``(stale, kept)``.

    Shared by the codex panes root and the MCP shim homes, which are named by
    the same pane ids and so answer to the same reference set.
    """
    stale: list[Path] = []
    # Loose top-level entries (a stray .DS_Store, a dangling symlink) are not
    # pane homes, so they are never cleanable — but they still have to land in
    # a bucket or the group total under-reports them.
    kept: list[Path] = [
        p for p in _top_level_entries(panes, errors) if p.is_symlink() or not p.is_dir()
    ]
    for pane in _iter_dirs(panes, errors):
        if pane.name.startswith("."):
            # Pane homes are named after a pane id; ``prepare()`` never makes a
            # dotted one. A hidden dir in the panes root belongs to something
            # else, so it is counted but never offered for deletion.
            kept.append(pane)
            continue
        try:
            mtime = pane.lstat().st_mtime
        except OSError as err:
            # Fail closed: a home we cannot even stat is never offered up.
            _record_error(errors, pane, err)
            kept.append(pane)
            continue
        if established and pane.name not in referenced and mtime < grace_cutoff:
            stale.append(pane)
        else:
            kept.append(pane)
    return stale, kept


def _referenced_codex_home_ids(
    workspace_paths: list[str], errors: list[dict[str, str]]
) -> tuple[set[str], bool]:
    """``(home ids a pane can still reach, established)``.

    The referenced set is the union over the workspaces we know about — the
    ones the caller has open plus the recent-workspaces registry — of the ids
    their records name.

    ``established`` is the fail-closed switch. ``~/.codex-panes/<id>`` carries
    nothing that says which workspace created it, so one unreadable source
    poisons the whole answer: the records that would have named a home may be
    exactly the ones we could not read, and the caller must then treat *every*
    home as referenced. A workspace that was *deleted* is not such a source —
    its records are gone for good, so it simply contributes nothing (see
    ``_is_deleted_path``).
    """
    registry_path = app_data_root() / RECENT_FILE
    registry, ok = _read_recent_registry(errors)
    if not ok:
        return set(), False
    if registry is None:
        errors.append(
            {
                "path": str(registry_path),
                "message": "no workspace registry; Codex pane homes stay protected",
            }
        )
        return set(), False
    recent = registry.get("recent")
    if not isinstance(recent, list):
        errors.append({"path": str(registry_path), "message": "expected a 'recent' array"})
        return set(), False

    candidates = list(workspace_paths)
    candidates += [
        entry["path"]
        for entry in recent
        if isinstance(entry, dict) and isinstance(entry.get("path"), str) and entry["path"]
    ]

    ids: set[str] = set()
    established = True
    seen: set[str] = set()
    for raw in candidates:
        # Same dedupe key as the workspace group: one folder reaches us under
        # several spellings (a symlinked worktree, /tmp vs /private/tmp).
        key = os.path.realpath(os.path.expanduser(raw))
        if key in seen:
            continue
        seen.add(key)
        if not os.path.isdir(key):
            if _is_deleted_path(key):
                # The folder is gone and its record files went with it, so it
                # has no references left to contribute — a deleted workspace
                # must not freeze the whole scan.
                #
                # Considered tradeoff: a workspace that was *moved or renamed*
                # is indistinguishable from a deleted one at its old path, so
                # until the user reopens it at the new location its homes read
                # as orphans. Accepted because the bucket stays ``caution`` —
                # never part of the one-click sweep, always a manual pick plus
                # a confirmation — and the 24h grace still covers anything in
                # active use.
                errors.append(
                    {
                        "path": raw,
                        "message": (
                            "workspace is gone; its Codex pane homes count as orphaned "
                            "— drop it from the recent list to stop this warning"
                        ),
                    }
                )
                continue
            # Not reachable rather than deleted (an unplugged disk, an ancestor
            # we cannot stat): its records would have named some of these
            # homes, so nothing is an orphan this scan.
            errors.append(
                {
                    "path": raw,
                    "message": (
                        "workspace unavailable; every Codex pane home stays protected "
                        "until it is back or dropped from the recent list"
                    ),
                }
            )
            established = False
            continue
        found, readable = _workspace_codex_home_ids(Path(key) / PROJECT_DIR_NAME, errors)
        ids |= found
        established = established and readable
    return ids, established


def _cli_homes_group(workspace_paths: list[str], errors: list[dict[str, str]]) -> _Group:
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
            # Symlinked entries are skipped: a live slot wires ``home/projects``
            # and ``home/shell-snapshots`` to the shared ``~/.claude`` dirs, so
            # they weigh zero bytes here and unlinking one frees nothing while
            # breaking the profile the provisioner set up.
            candidates = [
                *(home / name for name in PROFILE_CACHE_HOME_ENTRIES),
                slot / LOGIN_HOME_DIRNAME,
            ]
            caches.extend(p for p in candidates if not p.is_symlink())
            transcripts = home / PROFILE_HISTORY_HOME_ENTRY
            if not transcripts.is_symlink():
                history.append(transcripts)

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

    referenced, established = _referenced_codex_home_ids(workspace_paths, errors)
    grace_cutoff = time.time() - CODEX_HOME_GRACE_SECONDS
    grace_hours = CODEX_HOME_GRACE_SECONDS // 3600
    orphan_panes, kept_panes = _classify_pane_homes(
        panes, referenced, established, grace_cutoff, errors
    )

    orphan_note = (
        "Codex pane homes no pane still points at: no pane record and no Agent "
        "History entry in the known workspaces names them, and none was touched "
        f"in the last {grace_hours} hours. Deleting one ends every Codex session "
        "it holds, for good."
        if established
        else (
            "Codex pane homes no pane still points at. Nothing is listed: a "
            "workspace or one of its record files could not be read this scan "
            "(see the errors below), and a home never records which workspace "
            "made it, so every home is being kept."
        )
    )
    stale_item = _measured(
        _Item(
            "codexPanesStale",
            risk="caution",
            cleanable=True,
            root=panes,
            paths=orphan_panes,
            note=orphan_note,
        ),
        errors,
    )
    recent_item = _measured(
        _Item(
            "codexPanesRecent",
            risk="caution",
            cleanable=False,
            root=panes,
            paths=kept_panes,
            note=(
                "Codex pane homes a pane record or an Agent History entry still "
                f"names, homes touched in the last {grace_hours} hours, and loose "
                "files sitting next to them. Only workspaces the App has open or "
                "still lists as recent are consulted."
            ),
        ),
        errors,
    )

    # MCP shim homes are nested one level deeper (<agent>/<pane id>), so the
    # per-agent dirs are walked and their pane homes pooled into one bucket.
    shims = shim_panes_root()
    shim_orphans: list[Path] = []
    shim_kept: list[Path] = [
        p for p in _top_level_entries(shims, errors) if p.is_symlink() or not p.is_dir()
    ]
    for agent_dir in _iter_dirs(shims, errors):
        agent_orphans, agent_kept = _classify_pane_homes(
            agent_dir, referenced, established, grace_cutoff, errors
        )
        shim_orphans += agent_orphans
        shim_kept += agent_kept

    shim_stale_item = _measured(
        _Item(
            "shimPanesStale",
            risk="caution",
            cleanable=True,
            root=shims,
            paths=shim_orphans,
            note=(
                "Per-pane MCP homes for Kimi, Grok and Antigravity that no pane "
                "still points at, on the same test as the Codex homes above. "
                "They are mostly symlinks back to your real home, so deleting "
                "one removes the links, never what they point at."
                if established
                else (
                    "Per-pane MCP homes for Kimi, Grok and Antigravity that no "
                    "pane still points at. Nothing is listed: a workspace record "
                    "could not be read this scan, so every home is being kept."
                )
            ),
        ),
        errors,
    )
    shim_recent_item = _measured(
        _Item(
            "shimPanesRecent",
            risk="caution",
            cleanable=False,
            root=shims,
            paths=shim_kept,
            note=(
                "Per-pane MCP homes still in use, touched in the last "
                f"{grace_hours} hours, or loose files sitting next to them."
            ),
        ),
        errors,
    )

    return _Group(
        "cliHomes",
        str(root),
        [
            archived_item,
            caches_item,
            history_item,
            other_item,
            stale_item,
            recent_item,
            shim_stale_item,
            shim_recent_item,
        ],
    )


# ── workspace group ─────────────────────────────────────────────────────────


def _referenced_manual_logs(
    workspace_path: str, errors: list[dict[str, str]]
) -> tuple[set[str], bool]:
    """``(filenames, readable)`` for the logs a spawn-history entry still names.

    Matching is by filename, not full path: the renderer rewrites an entry's
    ``spawnedAt`` on restore, so the date folder derived from it is unreliable
    while ``<agentKey>-<paneId[:8]>.log`` is stable (see
    ``spawn_history.entry_manual_log_names``).

    Fails closed on an unreadable store rather than reporting an empty set:
    "no entry names this file" is what makes a transcript an orphan, and
    orphans are cleanable from the one-click safe sweep.
    """
    entries, readable = read_stored_entries_checked(workspace_path)
    if not readable:
        errors.append({
            "path": str(Path(workspace_path) / PROJECT_DIR_NAME / SPAWN_HISTORY_FILE),
            "message": "spawn history unreadable; manual logs kept",
        })
        return set(), False
    names: set[str] = set()
    for entry in entries:
        names |= entry_manual_log_names(entry)
    return names, True


def _live_log_targets() -> tuple[set[str], set[Path]]:
    """``(filenames, resolved paths)`` of the logs live panes hold open.

    The filename set is the cheap pre-filter; the resolved set is what
    actually decides, because the same log is reachable under several
    spellings (``/tmp`` vs ``/private/tmp``, a symlinked worktree).
    """
    resolved: set[Path] = set()
    for raw in live_output_log_paths():
        path = Path(raw)
        try:
            resolved.add(path.parent.resolve() / path.name)
        except OSError:
            resolved.add(path)
    return {p.name for p in resolved}, resolved


def _entry_mtime(entry: os.DirEntry[str], errors: list[dict[str, str]]) -> float | None:
    """Modification time of a scandir entry; ``None`` when it cannot be read."""
    try:
        return entry.stat(follow_symlinks=False).st_mtime
    except OSError as err:
        _record_error(errors, entry.path, err)
        return None


def _is_live_manual_log(
    path: Path, mtime: float | None, now: float, names: set[str], resolved: set[Path]
) -> bool:
    """Is a pane still writing into ``path``?

    Two independent signals, because either one alone loses data: the
    terminal service's set is authoritative but only covers panes this
    backend process spawned, while a fresh mtime catches the rest (a pane
    that survived a backend restart, a log written between two scans). An
    unreadable mtime counts as live — an unverifiable file is never offered
    for deletion.
    """
    if mtime is None or now - mtime < LIVE_LOG_MTIME_WINDOW_SECONDS:
        return True
    if path.name not in names:
        return False
    try:
        return (path.parent.resolve() / path.name) in resolved
    except OSError:
        return False


def _removable_run_dirs(
    data_dir: Path, errors: list[dict[str, str]]
) -> list[Path]:
    """Pipeline run dirs that are not the one currently being written to.

    ``runs/`` was listed whole, which took the in-progress run with it — its
    timeline and log are appended per event, so the files come back but
    everything the run had recorded so far is gone.

    Fails closed: if the project document (workspace navide.db, retired
    project.json as import-era fallback) cannot be read there is no way to
    tell which run is live, so no run is offered.
    """
    project, readable = _read_kv_object(data_dir, PROJECT_KV_KEY, PROJECT_FILE, errors)
    if not readable:
        return []
    active = str((project or {}).get("log_file_name") or "")
    # e.g. "runs/<run>/pipeline.log" — the run is its parent.
    active_dir = (data_dir / active).parent if active else None
    removable: list[Path] = []
    for run_dir in _iter_dirs(data_dir / RUNS_SUBDIR, errors):
        if active_dir is not None and run_dir.name == active_dir.name:
            continue
        removable.append(run_dir)
    return removable


def _manual_log_buckets(
    workspace_path: str, data_dir: Path, stale_days: int, errors: list[dict[str, str]]
) -> tuple[list[Path], list[Path], list[Path]]:
    """Split ``manual/**`` files into (orphan, stale, recent)."""
    manual = data_dir / MANUAL_LOGS_DIRNAME
    referenced, referenced_known = _referenced_manual_logs(workspace_path, errors)
    live_names, live_paths = _live_log_targets()
    now = time.time()
    cutoff = datetime.now(timezone.utc) - timedelta(days=stale_days)
    orphan: list[Path] = []
    stale: list[Path] = []
    recent: list[Path] = []
    for day_dir in _iter_dirs(manual, errors):
        day = _parse_ymd(day_dir.name)
        try:
            with os.scandir(day_dir) as it:
                files = sorted(
                    (
                        (Path(e.path), _entry_mtime(e, errors))
                        for e in it
                        if not e.is_dir(follow_symlinks=False)
                    ),
                    key=lambda pair: pair[0],
                )
        except FileNotFoundError:
            continue
        except OSError as err:
            _record_error(errors, day_dir, err)
            continue
        for path, mtime in files:
            # Live first: a pane alive longer than staleDays keeps writing into
            # the day folder its *spawn* date named, and a just-spawned pane has
            # no history entry yet — both would otherwise land in a cleanable
            # bucket and be unlinked out from under the open fd.
            if _is_live_manual_log(path, mtime, now, live_names, live_paths):
                recent.append(path)
            elif not referenced_known:
                # Nothing established which transcripts are still owned, so
                # none of them may be called an orphan.
                recent.append(path)
            elif path.name not in referenced:
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
        if not data_dir.is_dir():
            continue
        # Dedupe on the resolved dir, not the literal one: the same workspace
        # reaches the renderer under several spellings (a symlinked worktree,
        # /tmp vs /private/tmp), and scanning it twice double-counts every
        # byte while cleanup only ever frees them once.
        key = data_dir.resolve()
        if key in seen:
            continue
        seen.add(key)
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
        pipeline_logs.extend(_removable_run_dirs(data_dir, errors))
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
                note=(
                    "Recent agent logs still reachable from Agent History, plus "
                    "the transcripts panes are writing into right now — deleting "
                    "a log a pane still holds open would lose the rest of it, so "
                    "they are never offered for cleanup."
                ),
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
        _cli_homes_group(workspace_paths, errors),
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
