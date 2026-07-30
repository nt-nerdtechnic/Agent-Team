"""Full per-workspace spawn history — kv "spawn_history" in the workspace db.

The project document keeps only a 100-entry mirror of the renderer's spawn
history (``Project.ui_spawn_history``) so its read-size cap stays safe. This
store keeps the complete history: ``merge()`` upserts every snapshot the
renderer sends and never deletes older entries, and ``read_page()`` serves
pages back newest-first for the Agent History modal.

Document shape: ``{"version": 1, "entries": [...]}`` with entries ordered
oldest → newest (matching the renderer's in-memory order). The legacy
`.agent-team/spawn-history.json` is imported on first access and renamed
`spawn-history.json.migrated-v1`.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple

from .db import DB_FILENAME, Database, WorkspaceDatabases
from .projects import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.spawn_history")

SPAWN_HISTORY_FILE = "spawn-history.json"  # legacy JSON name, still used for import
_KV_KEY = "spawn_history"
# Hard cap so a runaway client cannot grow the file forever; entries past it
# are dropped from the oldest end with a warning.
MAX_ENTRIES = 5000

# `<workspace>/.agent-team/manual/<YYYYMMDD>/<agentKey>-<paneId[:8]>.log` —
# the renderer builds these paths (App.vue) and hands them to terminal.create
# as `output_log_file`.
MANUAL_LOGS_DIRNAME = "manual"


def canonical_workspace_path(workspace_path: str) -> str:
    """A workspace's on-disk identity: absolute path with symlinks resolved.

    Two spellings of the same folder (e.g. a symlinked alias) canonicalize to
    the same string, so they share one history store and their entries count
    as belonging to each other.
    """
    return os.path.realpath(os.path.abspath(workspace_path))


def is_same_workspace(a: str, b: str) -> bool:
    """True when both paths name the same workspace after canonicalization."""
    return canonical_workspace_path(a) == canonical_workspace_path(b)


def filter_foreign_entries(
    workspace_path: str, entries: list[Any], *, context: str
) -> list[Any]:
    """Drop entries whose ``workspacePath`` names a different workspace.

    The backend must not trust the renderer's payload: a buggy or stale client
    could hand us another workspace's history. Only a present-but-foreign
    ``workspacePath`` string is rejected; entries without one (legacy data)
    and non-dict junk pass through for the caller's own validation. Logs one
    warning per batch that dropped anything.
    """
    target = canonical_workspace_path(workspace_path)
    kept: list[Any] = []
    dropped = 0
    for entry in entries:
        if isinstance(entry, dict):
            entry_ws = entry.get("workspacePath")
            if (
                isinstance(entry_ws, str)
                and entry_ws
                and canonical_workspace_path(entry_ws) != target
            ):
                dropped += 1
                continue
        kept.append(entry)
    if dropped:
        log.warning(
            "dropped %d foreign spawn-history entries for %s (%s)",
            dropped, workspace_path, context,
        )
    return kept


def manual_log_file_name(agent_key: str, pane_id: str) -> str:
    """The renderer's manual-log filename for a pane (spawnHistory.ts)."""
    return f"{agent_key}-{pane_id[:8]}.log"


def entry_manual_log_names(entry: dict[str, Any]) -> set[str]:
    """Every manual-log filename ``entry`` can be reached by.

    The date folder is *not* usable as a key: ``spawnedAt`` is rewritten when
    a pane is restored or re-recorded, so an entry's log can sit under a day
    other than the one its timestamp names. The filename is the stable key —
    ``paneId`` is a UUID, so its first 8 hex chars identify the pane. Entries
    that carry an explicit ``outputLogFile`` contribute its basename too, in
    case the renderer ever stored a name we would not derive.
    """
    names: set[str] = set()
    agent_key = entry.get("agentKey")
    pane_id = entry.get("paneId")
    if (
        isinstance(agent_key, str) and agent_key
        and isinstance(pane_id, str) and pane_id
    ):
        names.add(manual_log_file_name(agent_key, pane_id))
    stored = entry.get("outputLogFile")
    if isinstance(stored, str) and stored:
        names.add(os.path.basename(stored))
    return names


def manual_logs_dir(workspace_path: str) -> Path:
    return (
        Path(canonical_workspace_path(workspace_path))
        / PROJECT_DIR_NAME
        / MANUAL_LOGS_DIRNAME
    )


def _checked_entries(data: Any) -> tuple[list[dict[str, Any]], bool]:
    """Validate a store document with read_stored_entries_checked semantics."""
    if not isinstance(data, dict):
        return [], False
    entries = data.get("entries")
    if entries is None:
        return [], True
    if not isinstance(entries, list):
        return [], False
    return [e for e in entries if isinstance(e, dict)], True


def read_stored_entries_checked(
    workspace_path: str,
) -> tuple[list[dict[str, Any]], bool]:
    """``(entries, readable)`` from a side-effect-free read of the full store.

    An absent store is readable and simply empty — "this workspace has no
    records" is an answer. A permission error, an unreadable database or an
    ``entries`` that is not an array yields ``readable=False``.

    Reads the workspace database first (read-only connection, so this never
    blocks or mutates the app's own handle) and falls back to the legacy JSON
    file while the kv document does not exist yet.

    Callers that read this to decide what may be deleted must not treat an
    unreadable store as an empty one: no entry naming a file would then look
    like permission to remove it.
    """
    data_dir = Path(canonical_workspace_path(workspace_path)) / PROJECT_DIR_NAME
    db_path = data_dir / DB_FILENAME
    if db_path.exists():
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            try:
                row = conn.execute(
                    "SELECT value FROM kv WHERE key = ?", (_KV_KEY,)
                ).fetchone()
            finally:
                conn.close()
        except sqlite3.Error:
            return [], False
        if row is not None:
            try:
                data = json.loads(row[0])
            except ValueError:
                return [], False
            return _checked_entries(data)
    hf = data_dir / SPAWN_HISTORY_FILE
    try:
        data = json.loads(hf.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [], True
    except (OSError, ValueError):
        return [], False
    return _checked_entries(data)


def read_stored_entries(workspace_path: str) -> list[dict[str, Any]]:
    """Side-effect-free read of the full store; ``[]`` when missing or bad.

    Unlike ``SpawnHistoryStore._load`` this never quarantines a corrupt file
    and never seeds from the project.json mirror — it exists for read-only
    consumers such as the storage-usage scan. Use
    ``read_stored_entries_checked`` when an unreadable store must not pass for
    an empty one.
    """
    return read_stored_entries_checked(workspace_path)[0]


def _collect_manual_logs(
    workspace_path: str, entries: list[dict[str, Any]]
) -> list[tuple[Path, int]]:
    """The manual log files of ``entries`` as ``(path, size)`` pairs.

    Best-effort by design: a missing file, an unreadable day folder or a
    permission error must never fail the history deletion that triggered it.
    Every candidate is resolved and asserted to stay inside the workspace's
    ``.agent-team/manual/`` dir before it is returned, so callers can unlink
    what they get without re-checking.
    """
    names: set[str] = set()
    for entry in entries:
        names |= entry_manual_log_names(entry)
    if not names:
        return []
    manual_root = manual_logs_dir(workspace_path)
    try:
        root = manual_root.resolve(strict=True)
    except OSError:
        return []

    day_dirs: list[Path] = []
    try:
        with os.scandir(root) as it:
            for entry_it in it:
                if entry_it.is_dir(follow_symlinks=False):
                    day_dirs.append(Path(entry_it.path))
    except OSError as err:
        log.warning("cannot list manual logs under %s: %s", root, err)
        return []

    found: list[tuple[Path, int]] = []
    for day_dir in day_dirs:
        try:
            with os.scandir(day_dir) as it:
                targets = [
                    (Path(e.path), e)
                    for e in it
                    if e.name in names and e.is_file(follow_symlinks=False)
                ]
        except OSError as err:
            log.warning("cannot list manual logs in %s: %s", day_dir, err)
            continue
        for path, dir_entry in targets:
            resolved = path.parent.resolve() / path.name
            try:
                resolved.relative_to(root)
            except ValueError:
                log.warning("refusing to delete log outside %s: %s", root, resolved)
                continue
            try:
                size = dir_entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
            found.append((path, size))
    return found


def _measure_manual_logs(
    workspace_path: str, entries: list[dict[str, Any]]
) -> tuple[int, int]:
    """``(freed bytes, files)`` a real delete of ``entries`` would reclaim."""
    logs = _collect_manual_logs(workspace_path, entries)
    return sum(size for _, size in logs), len(logs)


def _delete_manual_logs(
    workspace_path: str, entries: list[dict[str, Any]]
) -> tuple[int, int]:
    """Remove the manual log files of ``entries``; ``(freed bytes, files)``."""
    freed = 0
    removed = 0
    for path, size in _collect_manual_logs(workspace_path, entries):
        try:
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError as err:
            log.warning("cannot delete manual log %s: %s", path, err)
            continue
        freed += size
        removed += 1
    return freed, removed


class DeleteResult(NamedTuple):
    """What a ``delete_entries()`` call removed.

    ``freed_bytes``/``removed_log_files`` cover the manual log files that went
    with the deleted entries; the first two fields are the historical return
    value.
    """

    deleted_ids: list[str]
    total: int
    freed_bytes: int
    removed_log_files: int


def _parse_entry_timestamp(value: Any) -> datetime | None:
    """Parse an entry's ISO-8601 timestamp; None when missing/unparseable.

    Naive timestamps are assumed UTC so they stay comparable with the
    renderer's `toISOString()` cutoffs (always suffixed with Z).
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _entry_touched_at(entry: dict[str, Any]) -> datetime | None:
    """An entry's last-touched time, for coexistence conflict resolution.

    Entries carry no updatedAt; ``spawnedAt`` is rewritten when a pane is
    restored or re-recorded and ``removedAt`` is stamped later, so the max
    of the two is the closest equivalent.
    """
    removed = _parse_entry_timestamp(entry.get("removedAt"))
    spawned = _parse_entry_timestamp(entry.get("spawnedAt"))
    if removed is not None and spawned is not None:
        return max(removed, spawned)
    return removed if removed is not None else spawned


class SpawnHistoryStore:
    """Manages the full spawn-history document for each workspace."""

    def __init__(self, databases: WorkspaceDatabases | None = None) -> None:
        # merge() runs on worker threads (the ws set_ui_state offload), so
        # every read-modify-write is serialized like ProjectStore's saves.
        self._lock = threading.RLock()
        self._databases = databases or WorkspaceDatabases()

    def history_file(self, workspace_path: str) -> Path:
        """Where the store lives now: the workspace database file."""
        # Canonical (symlink-resolved) location so every spelling of the same
        # workspace reads and writes the same store.
        ws = canonical_workspace_path(workspace_path)
        return Path(ws) / PROJECT_DIR_NAME / DB_FILENAME

    def _legacy_file(self, workspace_path: str) -> Path:
        ws = canonical_workspace_path(workspace_path)
        return Path(ws) / PROJECT_DIR_NAME / SPAWN_HISTORY_FILE

    def _db(self, workspace_path: str, *, create: bool) -> Database | None:
        """The workspace db; read paths only materialize it for a legacy import."""
        if create:
            return self._databases.get(workspace_path)
        db = self._databases.peek(workspace_path)
        if db is None and self._legacy_file(workspace_path).exists():
            db = self._databases.get(workspace_path)
        return db

    def _import_legacy(self, db: Database, workspace_path: str) -> None:
        """One-time import of the legacy spawn-history.json into the db.

        The old file store quarantined a corrupt file as ``.corrupt``; the
        import keeps an unreadable file in place for inspection instead and
        starts empty — the kv layer's own reads are corrupt-tolerant. A file
        with a malformed shape raises out of the import so it rolls back
        whole: no marker, file left in place, and fail-closed readers
        (``read_stored_entries_checked``) keep reporting it unreadable.
        """

        def load(cur: Any, data: Any) -> None:
            entries = data.get("entries") if isinstance(data, dict) else None
            if not isinstance(entries, list):
                # Raising rolls the import back (no marker, file kept), so
                # the fallback read still fails closed on the malformed file.
                raise ValueError("malformed legacy spawn-history.json")
            # kv_set joins the surrounding import transaction (reentrant).
            db.kv_set(
                _KV_KEY,
                {"version": 1, "entries": [e for e in entries if isinstance(e, dict)]},
                now=int(time.time()),
            )

        def merge(cur: Any, data: Any) -> None:
            # Legacy-writer coexistence: an older app version regenerated
            # spawn-history.json after the import. Fold its entries into the
            # kv document by paneId (merge()'s upsert key): unknown paneIds
            # are appended; when both sides have an entry, the one with the
            # newer last-touched timestamp wins, ties and unparseable
            # timestamps keeping the stored side.
            incoming = data.get("entries") if isinstance(data, dict) else None
            if not isinstance(incoming, list):
                log.warning(
                    "regenerated spawn-history.json for %s malformed; ignored",
                    workspace_path,
                )
                return
            incoming = filter_foreign_entries(
                workspace_path,
                [e for e in incoming if isinstance(e, dict)],
                context="coexistence merge",
            )
            doc = db.kv_get(_KV_KEY)
            stored_entries = doc.get("entries") if isinstance(doc, dict) else None
            stored = [
                e for e in stored_entries if isinstance(e, dict)
            ] if isinstance(stored_entries, list) else []
            index = {
                e.get("paneId"): i
                for i, e in enumerate(stored)
                if isinstance(e.get("paneId"), str)
            }
            for entry in incoming:
                pane_id = entry.get("paneId")
                if not isinstance(pane_id, str) or not pane_id:
                    continue
                i = index.get(pane_id)
                if i is None:
                    index[pane_id] = len(stored)
                    stored.append(entry)
                    continue
                theirs = _entry_touched_at(entry)
                ours = _entry_touched_at(stored[i])
                if theirs is not None and (ours is None or theirs > ours):
                    stored[i] = entry
            if len(stored) > MAX_ENTRIES:
                dropped = len(stored) - MAX_ENTRIES
                stored = stored[dropped:]
                log.warning(
                    "spawn history for %s exceeded %d entries; dropped %d oldest",
                    workspace_path, MAX_ENTRIES, dropped,
                )
            # kv_set joins the surrounding merge transaction (reentrant).
            db.kv_set(
                _KV_KEY, {"version": 1, "entries": stored}, now=int(time.time())
            )

        try:
            db.import_json(
                _KV_KEY, self._legacy_file(workspace_path), load, merge=merge
            )
        except ValueError as err:
            # Malformed shape: the import rolled back and will retry on the
            # next access; the file stays in place for inspection.
            log.warning(
                "legacy spawn-history.json for %s not imported: %s",
                workspace_path, err,
            )

    def _load(
        self,
        workspace_path: str,
        seed: list[dict[str, Any]] | None,
        db: Database | None,
    ) -> list[dict[str, Any]]:
        """Return the stored entries (oldest → newest).

        Missing document → seeded from ``seed`` (the project mirror) when
        given: the one-time migration for projects created before the full
        store existed. A corrupt document is logged and treated as missing —
        never crash on bad data.
        """
        if db is not None:
            self._import_legacy(db, workspace_path)
            data = db.kv_get(_KV_KEY)
            if data is not None:
                entries = data.get("entries") if isinstance(data, dict) else None
                if isinstance(entries, list):
                    return [e for e in entries if isinstance(e, dict)]
                log.warning(
                    "stored spawn-history document for %s malformed; starting empty",
                    workspace_path,
                )
        if seed:
            # The mirror may predate the write-layer filter, so a foreign
            # entry could have been persisted there — never migrate it in.
            return filter_foreign_entries(
                workspace_path,
                [e for e in seed if isinstance(e, dict)],
                context="mirror seed",
            )
        return []

    def _write(
        self, workspace_path: str, entries: list[dict[str, Any]], db: Database
    ) -> None:
        db.kv_set(
            _KV_KEY, {"version": 1, "entries": entries}, now=int(time.time())
        )

    def merge(
        self,
        workspace_path: str,
        entries: list[dict[str, Any]],
        *,
        seed: list[dict[str, Any]] | None = None,
    ) -> int:
        """Upsert renderer snapshot entries into the full store.

        Entries are keyed by ``paneId``: an existing entry is replaced in
        place (the incoming entry is the renderer's authoritative snapshot,
        so replacement also clears fields the renderer removed, e.g. a reset
        customName); unknown paneIds are appended in the given order. Stored
        entries absent from ``entries`` are never deleted. Returns the stored
        total.

        Write-layer isolation: entries whose ``workspacePath`` belongs to a
        different workspace (canonical comparison) are dropped with a warning
        — the store never persists foreign history.
        """
        entries = filter_foreign_entries(workspace_path, entries, context="merge")
        with self._lock:
            db = self._db(workspace_path, create=True)
            if db is None:
                log.warning(
                    "cannot merge spawn history: workspace %s is not a directory",
                    workspace_path,
                )
                return 0
            stored = self._load(workspace_path, seed, db)
            index = {
                e.get("paneId"): i
                for i, e in enumerate(stored)
                if isinstance(e.get("paneId"), str)
            }
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                pane_id = entry.get("paneId")
                if not isinstance(pane_id, str) or not pane_id:
                    continue
                i = index.get(pane_id)
                if i is None:
                    index[pane_id] = len(stored)
                    stored.append(entry)
                else:
                    stored[i] = entry
            if len(stored) > MAX_ENTRIES:
                dropped = len(stored) - MAX_ENTRIES
                stored = stored[dropped:]
                log.warning(
                    "spawn history for %s exceeded %d entries; dropped %d oldest",
                    workspace_path, MAX_ENTRIES, dropped,
                )
            self._write(workspace_path, stored, db)
            return len(stored)

    def patch_entry(
        self,
        workspace_path: str,
        pane_id: str,
        fields: dict[str, Any],
        *,
        seed: list[dict[str, Any]] | None = None,
    ) -> bool:
        """Patch one stored entry in place (atomic rewrite).

        A ``None`` value removes the key (e.g. resetting a customName); any
        other value is set. Returns False — and writes nothing — when no
        entry matches ``pane_id``. ``seed`` mirrors merge()/read_page(): a
        missing document is first migrated from the project mirror so
        pre-store projects can still be patched.
        """
        with self._lock:
            db = self._db(workspace_path, create=True)
            if db is None:
                return False
            stored = self._load(workspace_path, seed, db)
            target = next(
                (e for e in stored if e.get("paneId") == pane_id), None
            )
            if target is None:
                return False
            for key, value in fields.items():
                if value is None:
                    target.pop(key, None)
                else:
                    target[key] = value
            self._write(workspace_path, stored, db)
            return True

    def delete_entries(
        self,
        workspace_path: str,
        *,
        mode: str,
        pane_ids: list[str] | None = None,
        cutoff_iso: str | None = None,
        seed: list[dict[str, Any]] | None = None,
        dry_run: bool = False,
    ) -> DeleteResult:
        """Delete entries from the full store and their manual log files.

        Returns ``DeleteResult(deleted_ids, total_left, freed_bytes,
        removed_log_files)``. Deleting a history entry used to be record-only,
        which stranded its ``.agent-team/manual/<ymd>/<agentKey>-<paneId8>.log``
        forever — those logs are now removed alongside the entry (guarded to
        stay inside the workspace's manual dir, tolerant of missing files).

        Modes:
        - ``"ids"``: entries whose paneId is in ``pane_ids`` (record-only —
          live panes are never touched, only their history entry goes).
        - ``"removed"``: every entry carrying a ``removedAt`` timestamp.
        - ``"older_than"``: removed entries whose ``spawnedAt`` is strictly
          before ``cutoff_iso``. Active entries and entries without a
          parseable spawnedAt are kept — bulk cleanup never deletes the
          record of something that may still be running.

        Starred entries (``starred`` truthy) survive both bulk modes; only
        an explicit ``"ids"`` delete removes them.

        ``dry_run=True`` answers "what would this delete?" — same selection
        and same log-file resolution, but nothing is written and nothing is
        unlinked. It backs the renderer's delete confirmation, which has to
        name the transcript files and the disk space at stake before the user
        agrees.

        Unknown mode deletes nothing. The rewrite is atomic (one kv
        transaction) and skipped entirely when nothing matched. Each
        workspace's store is keyed by its canonical path, so entries of other
        workspaces are never affected. ``seed`` mirrors read_page(): a
        missing document is first migrated from the project mirror so the
        deletion also covers pre-store entries.
        """
        ids = {p for p in pane_ids or [] if isinstance(p, str) and p}
        cutoff = _parse_entry_timestamp(cutoff_iso)

        def doomed(entry: dict[str, Any]) -> bool:
            if mode == "ids":
                return entry.get("paneId") in ids
            if mode == "removed":
                return bool(entry.get("removedAt")) and not entry.get("starred")
            if mode == "older_than":
                if not entry.get("removedAt") or cutoff is None:
                    return False
                if entry.get("starred"):
                    return False
                spawned = _parse_entry_timestamp(entry.get("spawnedAt"))
                return spawned is not None and spawned < cutoff
            return False

        with self._lock:
            db = self._db(workspace_path, create=True)
            if db is None:
                return DeleteResult([], 0, 0, 0)
            stored = self._load(workspace_path, seed, db)
            kept: list[dict[str, Any]] = []
            deleted: list[str] = []
            gone: list[dict[str, Any]] = []
            for entry in stored:
                if doomed(entry):
                    pane_id = entry.get("paneId")
                    deleted.append(pane_id if isinstance(pane_id, str) else "")
                    gone.append(entry)
                else:
                    kept.append(entry)
            if not deleted:
                return DeleteResult([], len(kept), 0, 0)
            if dry_run:
                freed, removed = _measure_manual_logs(workspace_path, gone)
                return DeleteResult(deleted, len(kept), freed, removed)
            self._write(workspace_path, kept, db)
            # Logs go after the store rewrite: if unlinking fails half-way the
            # entries are still gone, and the leftovers show up as orphans in
            # the storage-usage page rather than as a failed delete.
            freed, removed = _delete_manual_logs(workspace_path, gone)
            return DeleteResult(deleted, len(kept), freed, removed)

    def read_page(
        self,
        workspace_path: str,
        *,
        offset: int = 0,
        limit: int = 100,
        seed: list[dict[str, Any]] | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return ``(page, total)`` where the page is newest → oldest.

        ``offset`` counts from the newest end (0 = latest entry); an
        out-of-range offset yields an empty page. When the full store is
        missing and the project mirror (``seed``) has data, the store is
        seeded first — the same one-time migration merge() performs.
        """
        with self._lock:
            db = self._db(workspace_path, create=False)
            stored = self._load(workspace_path, seed, db)
            if stored and (db is None or db.kv_updated_at(_KV_KEY) is None):
                # Persist the migration so later reads no longer depend on
                # the mirror being passed in.
                db = self._db(workspace_path, create=True)
                if db is not None:
                    self._import_legacy(db, workspace_path)
                    self._write(workspace_path, stored, db)
            offset = max(0, offset)
            limit = max(0, limit)
            newest_first = list(reversed(stored))
            return newest_first[offset : offset + limit], len(stored)
