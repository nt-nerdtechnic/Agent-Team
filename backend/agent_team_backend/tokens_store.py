"""Token-usage aggregator with per-workspace + global persistence.

Records token deltas from two sources:
  - source="analyzer": local llama-cli classify / auto_answer real counts
  - source="cli":      vendor parser scraped from agent TUI output

Per-workspace state lives in `<app_data>/workspaces/<sha256_8>/tokens.json`
  where sha256_8 = first 8 hex chars of sha256(abs_workspace_path).
  Keyed on the workspace identity rather than its path so tokens survive
  workspace renames and moves.
Global lifetime state lives in `<app_data>/tokens.json`.

We never estimate — if a source can't produce a real number, we record 0.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from collections import deque
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from .applog import app_data_dir
from .projects import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.tokens")

TOKENS_FILE = "tokens.json"
# Persisted-store schema version for tokens.json (see store_migrations.py).
# v2 added the cli-source `by_profile` dimension (per-CLI-account attribution);
# v3 drops it again — accounts are now just alternate auth stores with a single
# global active one, so per-account usage is no longer tracked.
TOKENS_SCHEMA_VERSION = 3
# Legacy storage key the retired v1→v2 migration credits historic cli usage to.
# Still referenced by that migration; v2→v3 folds the whole dimension away.
DEFAULT_PROFILE_KEY = "default"
RECORDED_KEYS_FILE = "recorded-event-keys.json"
LEGACY_READER_KEYS_FILE = "log-readers-seen.json"
INGESTION_STATE_FILE = "token-ingestion-state.json"
PERSISTENCE_JOURNAL_FILE = "token-persistence-journal.json"
# Append-only companion to the ingestion state. The state is megabytes and was
# rewritten whole to record a handful of advanced offsets; mutations now append
# here instead, and the snapshot is only rebuilt once the log grows past
# DELTA_COMPACT_LINES.
#
# The snapshot's own format is deliberately untouched, so a downgraded build
# reads it and simply ignores this file — it sees state as of the last
# compaction, which is stale but valid. Guarding the other direction is why the
# header pins the snapshot's identity: any writer that does not know about the
# log (an older build) leaves a stat the header no longer matches, and the log
# is discarded rather than replayed over a newer snapshot.
INGESTION_DELTA_FILE = "token-ingestion-delta.jsonl"
DELTA_COMPACT_LINES = 5000
WORKSPACES_SUBDIR = "workspaces"
INGESTION_STATE_VERSION = 2
RECENT_EVENT_KEYS_LIMIT = 512
# The legacy migration dedup set must stay bounded: evicting a key only risks
# a one-off global double count if its event ever replays, while an unbounded
# set gets fully rewritten to disk every save interval.
LEGACY_EVENT_KEYS_LIMIT = 4096
LEGACY_EVENT_KEYS_TTL_DAYS = 14
# A session log untouched for this long will not be appended to again in
# practice, so the per-file dedup window readers stash in its checkpoint is
# dead weight — and it dominates the state file, which is rewritten whole on
# every flush. Stripping it is self-healing: the offset and identity stay, so
# a file that does come back to life rebuilds its window on the next read.
COLD_FILE_DAYS = 7


def _ws_dir_name(workspace_path: str) -> str:
    """First 8 hex chars of sha256(abs_workspace_path).

    Stable across workspace renames/moves — keyed on the canonical absolute
    path at the time the workspace was first used.
    """
    return hashlib.sha256(workspace_path.encode("utf-8")).hexdigest()[:8]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _days_from_now_iso(days: int) -> str:
    return (
        (datetime.now(timezone.utc) + timedelta(days=days))
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _empty_bucket() -> dict[str, int]:
    """A single accounting unit. `calls` counts events; in/out are token sums."""
    return {"input": 0, "output": 0, "calls": 0}


def _add(into: dict[str, int], delta: dict[str, int]) -> None:
    into["input"] += int(delta.get("input", 0))
    into["output"] += int(delta.get("output", 0))
    into["calls"] += int(delta.get("calls", 0))


def _coerce_schema(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 1


def migrate_tokens_v1_to_v2(doc: Any) -> Any:
    """Seed the v2 `by_profile` dimension, crediting all historic cli usage to
    the default account. Handles both the global doc (top-level `by_vendor`) and
    a per-workspace doc (`cumulative.by_vendor`). Idempotent: gated on
    schemaVersion, returns the doc untouched once already >= v2. Returns a new
    dict when it changes anything so the disk migrator knows to write."""
    if not isinstance(doc, dict) or _coerce_schema(doc.get("schemaVersion", 1)) >= 2:
        return doc
    doc = deepcopy(doc)
    if "cumulative" in doc and isinstance(doc.get("cumulative"), dict):
        target = doc["cumulative"]
    else:
        target = doc
    source = target.get("by_vendor") if isinstance(target.get("by_vendor"), dict) else {}
    by_profile = target.setdefault("by_profile", {})
    for vendor, bucket in source.items():
        # cli-only dimension: the analyzer source has no CLI account.
        if vendor == "analyzer" or not isinstance(bucket, dict):
            continue
        by_profile.setdefault(vendor, {}).setdefault(DEFAULT_PROFILE_KEY, deepcopy(bucket))
    doc["schemaVersion"] = 2
    return doc


def migrate_tokens_v2_to_v3(doc: Any) -> Any:
    """Drop the v2 `by_profile` dimension. Per-account usage is no longer
    tracked (accounts are just alternate auth stores with one global active).

    No totals are lost: `by_profile` was always a redundant sub-ledger of
    `by_vendor`/`all_time` — every cli event credited both from the same delta —
    so the account totals already live in those global/provider dimensions.
    Removing the key preserves every total. Handles both the global doc
    (top-level `by_profile`) and a per-workspace doc (`cumulative.by_profile`).
    Idempotent: gated on schemaVersion, returns the doc untouched once >= v3.
    Returns a new dict when it changes anything so the disk migrator writes."""
    if not isinstance(doc, dict) or _coerce_schema(doc.get("schemaVersion", 1)) >= 3:
        return doc
    doc = deepcopy(doc)
    doc.pop("by_profile", None)
    if isinstance(doc.get("cumulative"), dict):
        doc["cumulative"].pop("by_profile", None)
    doc["schemaVersion"] = 3
    return doc


def _empty_workspace_doc() -> dict[str, Any]:
    return {
        "schemaVersion": TOKENS_SCHEMA_VERSION,
        "current_run": None,  # see _new_run() shape
        "runs": [],           # archived runs
        "cumulative": {
            "totals": _empty_bucket(),
            "by_vendor": {},
            "by_stage": {},
        },
    }


def _empty_global_doc() -> dict[str, Any]:
    return {
        "schemaVersion": TOKENS_SCHEMA_VERSION,
        "all_time": _empty_bucket(),
        "by_vendor": {},
        "by_day": {},
    }


def _empty_ingestion_state() -> dict[str, Any]:
    return {
        "version": INGESTION_STATE_VERSION,
        "files": {},
        "legacy_event_keys": [],
        "legacy_event_keys_expires_at": None,
        "recent_event_keys": [],
    }


def _new_run(run_id: str, task: str, run_dir: str) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "task": task,
        "run_dir": run_dir,
        "started_at": _now_iso(),
        "ended_at": None,
        "totals": _empty_bucket(),
        "by_vendor": {},
        "by_stage": {},
        "by_pane": {},
    }


_SAVE_INTERVAL_S = 10  # batch window for dirty-flag saves
_PRUNE_INTERVAL_S = 3600  # how often the save loop rescans `files` for cold logs


class TokensStore:
    """Thread-safe in-memory aggregator with atomic JSON persistence.

    Writes are batched: record() marks dirty flags and a background thread
    flushes every _SAVE_INTERVAL_S seconds. Call flush() before shutdown.
    """

    def __init__(
        self,
        global_path: Path | None = None,
        recorded_keys_path: Path | None = None,
        workspace_base_dir: Path | None = None,
        ingestion_state_path: Path | None = None,
        legacy_reader_keys_path: Path | None = None,
    ) -> None:
        data_root = global_path.parent if global_path is not None else app_data_dir()
        self._global_path = global_path or (data_root / TOKENS_FILE)
        self._recorded_keys_path = recorded_keys_path or (data_root / RECORDED_KEYS_FILE)
        self._legacy_reader_keys_path = (
            legacy_reader_keys_path or (data_root / LEGACY_READER_KEYS_FILE)
        )
        self._ingestion_state_path = (
            ingestion_state_path or (data_root / INGESTION_STATE_FILE)
        )
        self._persistence_journal_path = data_root / PERSISTENCE_JOURNAL_FILE
        self._ingestion_delta_path = data_root / INGESTION_DELTA_FILE
        self._workspace_base_dir = workspace_base_dir or (data_root / WORKSPACES_SUBDIR)
        self._recover_persistence_journal()
        # RLock because reset() calls snapshot() while holding the lock.
        self._lock = RLock()
        # Serialize complete disk commits. In-memory mutations only need
        # _lock, but two writers must never share the fixed .tmp/journal paths
        # or let an older snapshot land after a newer synchronous lifecycle save.
        self._flush_lock = RLock()
        self._workspace_cache: dict[str, dict[str, Any]] = {}
        self._global_data: dict[str, Any] = self._load_global()
        self._legacy_paths_to_remove: set[Path] = set()
        self._files_pruned = False
        # Ingestion mutations awaiting an append, and how many lines the log
        # already holds. A change the log cannot express (legacy-key pruning,
        # a reset, the startup prune) sets _force_compaction instead.
        self._pending_delta: list[dict[str, Any]] = []
        self._delta_lines = 0
        self._force_compaction = False
        self._ingestion_state = self._load_ingestion_state()
        self._legacy_event_keys: set[str] = set(
            str(k) for k in self._ingestion_state.get("legacy_event_keys", [])
        )
        recent = [str(k) for k in self._ingestion_state.get("recent_event_keys", [])]
        self._recent_event_keys = deque(recent[-RECENT_EVENT_KEYS_LIMIT:])
        self._recent_event_key_set = set(self._recent_event_keys)
        legacy_pruned = self._enforce_legacy_key_bounds()

        # Dirty flags (set inside _lock, consumed by save loop outside _lock)
        self._dirty_ingestion_state: bool = (
            bool(self._legacy_paths_to_remove) or legacy_pruned or self._files_pruned
        )
        # Neither prune is expressible as a delta record — both remove state —
        # so the next commit has to rebuild the snapshot.
        self._force_compaction = (
            self._force_compaction or legacy_pruned or self._files_pruned
        )
        self._dirty_workspaces: set[str] = set()
        self._dirty_global: bool = False

        # Background save loop
        self._stop_event = threading.Event()
        self._save_thread = threading.Thread(
            target=self._save_loop, name="tokens_store.save", daemon=True
        )
        self._save_thread.start()

    # ───────────────────────── Disk I/O ────────────────────────────

    def _atomic_write(self, path: Path, data: dict[str, Any]) -> None:
        # The ingestion state and its journal are machine-only and dominate disk
        # write volume (megabytes per flush), so they are stored unindented.
        # Ledger files stay indented — they are small and get eyeballed.
        compact = path.name in (INGESTION_STATE_FILE, PERSISTENCE_JOURNAL_FILE)
        dump_kwargs: dict[str, Any] = (
            {"separators": (",", ":")} if compact else {"indent": 2}
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_text(
                json.dumps(data, ensure_ascii=False, **dump_kwargs), encoding="utf-8"
            )
            os.replace(tmp, path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    # ─────────────────── Ingestion delta log ───────────────────────

    def _snapshot_identity(self) -> dict[str, Any]:
        """Stat pin tying a delta log to the snapshot it was branched from."""
        try:
            st = self._ingestion_state_path.stat()
        except OSError:
            return {"mtime_ns": 0, "size": 0}
        return {"mtime_ns": st.st_mtime_ns, "size": st.st_size}

    def _read_ingestion_delta(self) -> list[dict[str, Any]]:
        """Return the log's records, or nothing if it is not ours to replay.

        A mismatched header means something rewrote the snapshot without
        touching the log — an older build, most likely. Replaying then would
        drag checkpoints backwards, so the log is dropped and the snapshot
        stands on its own.
        """
        if not self._ingestion_delta_path.exists():
            return []
        try:
            lines = self._ingestion_delta_path.read_text(encoding="utf-8").splitlines()
        except OSError as err:
            log.warning("ingestion delta unreadable (%s); ignoring it", err)
            return []
        if not lines:
            return []
        try:
            header = json.loads(lines[0])
        except json.JSONDecodeError:
            log.warning("ingestion delta header corrupt; ignoring the log")
            return []
        if header.get("base") != self._snapshot_identity():
            log.info("ingestion delta does not match the snapshot; ignoring the log")
            return []
        records: list[dict[str, Any]] = []
        for line in lines[1:]:
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                # Only the tail can be torn — a crash mid-append. Everything
                # before it is still good, but appending past the tear would
                # strand the new records behind it, so rebuild instead.
                log.info("ingestion delta truncated; replaying %d record(s)", len(records))
                self._force_compaction = True
                break
        return records

    @staticmethod
    def _apply_delta_record(doc: dict[str, Any], record: dict[str, Any]) -> None:
        """Replay one record onto a snapshot. Must stay idempotent: a journal
        recovery can append the same records twice."""
        kind = record.get("t")
        if kind == "ckpt":
            path = str(record.get("p") or "")
            checkpoint = record.get("c")
            if not path or not isinstance(checkpoint, dict):
                return
            files = doc.setdefault("files", {})
            entry = files.setdefault(path, {"global": {}, "workspaces": {}})
            workspace = str(record.get("w") or "")
            if workspace:
                entry.setdefault("workspaces", {})[workspace] = checkpoint
            else:
                entry["global"] = checkpoint
        elif kind == "rek":
            key = str(record.get("k") or "")
            if not key:
                return
            keys = [k for k in doc.get("recent_event_keys", []) if k != key]
            keys.append(key)
            doc["recent_event_keys"] = keys[-RECENT_EVENT_KEYS_LIMIT:]

    def _append_ingestion_delta(self, records: list[dict[str, Any]]) -> None:
        """Append records, starting a fresh header when the log is empty."""
        chunks: list[str] = []
        if self._delta_lines == 0:
            chunks.append(
                json.dumps(
                    {"t": "hdr", "base": self._snapshot_identity()},
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
        for record in records:
            chunks.append(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
        self._ingestion_delta_path.parent.mkdir(parents=True, exist_ok=True)
        # Starting a new header truncates: whatever was there belonged to a
        # snapshot we no longer track, and appending past it would bury the
        # header mid-file.
        mode = "a" if self._delta_lines else "w"
        with open(self._ingestion_delta_path, mode, encoding="utf-8") as fh:
            fh.write("\n".join(chunks) + "\n")
        self._delta_lines += len(records)

    def _recover_persistence_journal(self) -> bool:
        """Finish a previously interrupted batched commit before loading state."""
        if not self._persistence_journal_path.exists():
            return True
        try:
            journal = json.loads(
                self._persistence_journal_path.read_text(encoding="utf-8")
            )
            writes = journal.get("writes", []) if isinstance(journal, dict) else []
            for item in writes:
                if (
                    not isinstance(item, dict)
                    or not item.get("path")
                    or not isinstance(item.get("data"), dict)
                ):
                    continue
                self._atomic_write(Path(str(item.get("path") or "")), item["data"])
            pending = journal.get("delta") if isinstance(journal, dict) else None
            if isinstance(pending, list) and pending:
                # Safe to re-apply: delta records are idempotent, so a batch
                # that partly landed before the crash just lands again.
                self._append_ingestion_delta(
                    [r for r in pending if isinstance(r, dict)]
                )
            self._persistence_journal_path.unlink(missing_ok=True)
            log.info("recovered interrupted token persistence batch")
            return True
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as err:
            log.warning("token persistence journal recovery failed: %s", err)
            return False

    def _workspace_path(self, workspace_path: str) -> Path:
        return self._workspace_base_dir / _ws_dir_name(workspace_path) / TOKENS_FILE

    def _migrate_workspace_tokens(self, old_path: Path, new_path: Path) -> None:
        """Copy old per-workspace tokens.json to the new global path, then delete old.

        Uses atomic write (write-tmp → replace) so the new file is never partial.
        Only deletes the source after verifying the destination exists.
        """
        try:
            content = old_path.read_bytes()
            new_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = new_path.with_suffix(new_path.suffix + ".tmp")
            tmp.write_bytes(content)
            os.replace(tmp, new_path)
            if new_path.exists():
                old_path.unlink()
                log.info("migrated tokens.json from %s to %s", old_path, new_path)
        except Exception as err:  # noqa: BLE001
            log.warning("failed to migrate tokens.json from %s: %s", old_path, err)

    def _load_workspace(self, workspace_path: str) -> dict[str, Any]:
        if workspace_path in self._workspace_cache:
            return self._workspace_cache[workspace_path]
        wp = self._workspace_path(workspace_path)
        # Migrate from the old per-workspace location on first access if the new
        # global path doesn't exist yet.
        if not wp.exists():
            old_wp = Path(workspace_path) / PROJECT_DIR_NAME / TOKENS_FILE
            if old_wp.exists():
                self._migrate_workspace_tokens(old_wp, wp)
        if not wp.exists():
            doc = _empty_workspace_doc()
        else:
            try:
                doc = json.loads(wp.read_text(encoding="utf-8"))
                # Forward-migrate in memory BEFORE the setdefault fill, so an
                # un-migrated doc (no schemaVersion) is seeded rather than being
                # masked as v2 by the empty-doc default. The disk migration in
                # store_migrations does the same; both are gated on schemaVersion
                # so they converge idempotently.
                doc = migrate_tokens_v2_to_v3(migrate_tokens_v1_to_v2(doc))
                # Forward-compat: fill in any missing top-level keys.
                for k, v in _empty_workspace_doc().items():
                    doc.setdefault(k, v)
            except Exception as err:  # noqa: BLE001
                log.warning("tokens.json at %s is corrupt (%s); starting fresh", wp, err)
                doc = _empty_workspace_doc()
        self._workspace_cache[workspace_path] = doc
        return doc

    def _save_workspace(self, workspace_path: str) -> None:
        doc = self._workspace_cache.get(workspace_path)
        if doc is None:
            return
        try:
            self._atomic_write(self._workspace_path(workspace_path), doc)
        except Exception as err:  # noqa: BLE001
            log.warning("failed to write workspace tokens.json: %s", err)

    def _load_global(self) -> dict[str, Any]:
        if not self._global_path.exists():
            return _empty_global_doc()
        try:
            doc = json.loads(self._global_path.read_text(encoding="utf-8"))
            # Forward-migrate in memory (global doc is loaded at import time,
            # before store_migrations runs on disk — so the store must run the
            # migration chain itself or the eager load would clobber the
            # migrated file on next flush). Gated on schemaVersion → idempotent.
            doc = migrate_tokens_v2_to_v3(migrate_tokens_v1_to_v2(doc))
            for k, v in _empty_global_doc().items():
                doc.setdefault(k, v)
            schema = doc.get("schemaVersion", TOKENS_SCHEMA_VERSION)
            try:
                schema = int(schema)
            except (TypeError, ValueError):
                schema = TOKENS_SCHEMA_VERSION
            if schema > TOKENS_SCHEMA_VERSION:
                # Written by a newer app version; load as-is (unknown keys are
                # preserved) and don't crash.
                log.warning(
                    "global tokens.json schemaVersion %s is newer than supported "
                    "%s; loading as-is",
                    schema,
                    TOKENS_SCHEMA_VERSION,
                )
            return doc
        except Exception as err:  # noqa: BLE001
            log.warning("global tokens.json corrupt (%s); starting fresh", err)
            return _empty_global_doc()

    # ───────────────────────── Batch save loop ──────────────────────

    def _save_loop(self) -> None:
        """Background thread: flush dirty state every _SAVE_INTERVAL_S seconds."""
        ticks_per_prune = max(1, _PRUNE_INTERVAL_S // _SAVE_INTERVAL_S)
        tick = 0
        while not self._stop_event.wait(timeout=_SAVE_INTERVAL_S):
            tick += 1
            if tick % ticks_per_prune == 0:
                self._prune_cold_windows()
            self._flush_dirty()

    def _prune_cold_windows(self) -> None:
        """Rescan `files` for logs that went cold since the last scan.

        Pruning only at load is not enough: a long-running session keeps
        writing to logs that later go quiet, and their dedup windows only ever
        grow from that point on. Rescanning on a timer lets the next flush drop
        them instead of rewriting them for the rest of the process lifetime.
        """
        with self._lock:
            if self._prune_ingestion_files(self._ingestion_state):
                self._dirty_ingestion_state = True
                # Removing state is not expressible as a delta record, so the
                # next commit has to rebuild the snapshot — same reason the
                # startup prune forces it.
                self._force_compaction = True

    def _flush_dirty(self) -> None:
        """Write any dirty state to disk (called from save loop or flush())."""
        with self._flush_lock:
            self._flush_dirty_serialized()

    def _flush_dirty_serialized(self) -> None:
        """Commit one dirty snapshot while the caller owns _flush_lock."""
        # Never replace an unfinished journal with a newer batch. Apply it
        # first; if the underlying I/O problem persists, keep it for retry or
        # next-start recovery and leave newer mutations dirty in memory.
        if not self._recover_persistence_journal():
            return
        with self._lock:
            dirty_ingestion = self._dirty_ingestion_state
            dirty_workspaces = set(self._dirty_workspaces)
            dirty_global = self._dirty_global
            self._dirty_ingestion_state = False
            self._dirty_workspaces.clear()
            self._dirty_global = False
            writes: list[dict[str, Any]] = []
            for ws in dirty_workspaces:
                doc = self._workspace_cache.get(ws)
                if doc is not None:
                    writes.append({"path": str(self._workspace_path(ws)), "data": deepcopy(doc)})
            if dirty_global:
                writes.append({"path": str(self._global_path), "data": deepcopy(self._global_data)})
            delta: list[dict[str, Any]] = []
            compacting = False
            # A forced rebuild still has to run when nothing is dirty: shutdown
            # compacts so the snapshot stands alone, and the log it replaces may
            # have been written by an earlier commit.
            if dirty_ingestion or (self._force_compaction and self._delta_lines):
                # Rebuild the snapshot only when the log has grown past its
                # bound, or when a change happened that the log cannot express.
                compacting = self._force_compaction or (
                    self._delta_lines + len(self._pending_delta) > DELTA_COMPACT_LINES
                )
                if compacting:
                    writes.append({
                        "path": str(self._ingestion_state_path),
                        "data": self._state_snapshot_locked(),
                    })
                else:
                    delta = self._pending_delta
                self._pending_delta = []
                self._force_compaction = False
        if not writes and not delta:
            return
        try:
            # Write-ahead record makes totals + checkpoints recoverable as a
            # unit when the process dies between individual writes. Replaying
            # it is safe: the snapshot writes are whole-file, and the delta
            # records are idempotent.
            self._atomic_write(
                self._persistence_journal_path,
                {"version": 2, "writes": writes, "delta": delta},
            )
            for item in writes:
                self._atomic_write(Path(item["path"]), item["data"])
            if compacting:
                # The snapshot just moved, so the old log's header no longer
                # matches it — stale content is inert even if this unlink fails.
                self._ingestion_delta_path.unlink(missing_ok=True)
                self._delta_lines = 0
            if delta:
                self._append_ingestion_delta(delta)
            self._persistence_journal_path.unlink(missing_ok=True)
            if dirty_ingestion:
                self._remove_legacy_paths()
        except (OSError, TypeError, ValueError) as err:
            log.warning("failed to commit token persistence batch: %s", err)

    def flush(self) -> None:
        """Flush all pending dirty state synchronously. Call before shutdown.

        Compacts rather than appending: this is the shutdown path, so paying
        one snapshot write here leaves the state whole on disk with no log
        beside it — which is also what a downgraded build needs to read.
        """
        with self._lock:
            self._force_compaction = True
        self._stop_event.set()
        if threading.current_thread() is not self._save_thread:
            self._save_thread.join()
        self._flush_dirty()

    def _load_legacy_recorded_keys(self) -> set[str]:
        if not self._recorded_keys_path.exists():
            return set()
        try:
            data = json.loads(self._recorded_keys_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return set(str(k) for k in data)
        except (OSError, json.JSONDecodeError) as err:
            log.warning("recorded-keys file unreadable (%s); starting empty", err)
        return set()

    def _load_ingestion_state(self) -> dict[str, Any]:
        """Rebuild the state: snapshot first, then the delta log on top.

        The log has to be replayed even when no snapshot exists — until the
        first compaction that is the only place checkpoints live, and skipping
        it would send every reader back to offset 0.
        """
        doc = self._load_ingestion_snapshot()
        replayed = self._read_ingestion_delta()
        for record in replayed:
            self._apply_delta_record(doc, record)
        self._delta_lines = len(replayed)
        self._files_pruned = self._prune_ingestion_files(doc)
        return doc

    def _load_ingestion_snapshot(self) -> dict[str, Any]:
        if self._ingestion_state_path.exists():
            try:
                data = json.loads(self._ingestion_state_path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("version") == INGESTION_STATE_VERSION:
                    doc = _empty_ingestion_state()
                    doc.update(data)
                    if not isinstance(doc.get("files"), dict):
                        doc["files"] = {}
                    for path in (self._recorded_keys_path, self._legacy_reader_keys_path):
                        if path.exists():
                            self._legacy_paths_to_remove.add(path)
                    return doc
            except (OSError, json.JSONDecodeError) as err:
                log.warning("token ingestion state unreadable (%s); rebuilding", err)

        legacy = self._load_legacy_recorded_keys()
        if self._recorded_keys_path.exists():
            self._legacy_paths_to_remove.add(self._recorded_keys_path)
        if self._legacy_reader_keys_path.exists():
            # This was only a parser performance cache. It can contain events
            # the accounting sink rejected as external, so its bare keys must
            # never suppress a migration replay.
            self._legacy_paths_to_remove.add(self._legacy_reader_keys_path)
        doc = _empty_ingestion_state()
        doc["legacy_event_keys"] = sorted(legacy)
        return doc

    def _prune_ingestion_files(self, doc: dict[str, Any]) -> bool:
        """Strip the dedup window from checkpoints of logs long gone cold.

        Runs at load and then on a _PRUNE_INTERVAL_S timer from the save loop:
        `files` has no other eviction path, so the windows accumulate (7.5 MB
        on a real machine) and every flush rewrites the lot. Logs that go cold
        after startup only get stripped because of the periodic pass.

        Only a *successful* stat can strip anything. An unreadable path is
        left alone: treating one as prunable would let a transient I/O fault
        (an unmounted network home, say) wipe the whole dedup state at once,
        and the next scan would re-read every log from offset 0.

        A reader that carries its window across a rotation must be exempt —
        pi.py keeps it deliberately so an in-place rewrite is not double
        counted, and marks its checkpoints with `session_id` (pi.py:336).
        Readers that clear the window themselves on rotation (claude, qwen)
        never set that field.
        """
        files = doc.get("files")
        if not isinstance(files, dict):
            return False
        cutoff = datetime.now(timezone.utc).timestamp() - COLD_FILE_DAYS * 86400
        changed = False
        for path, entry in files.items():
            if not isinstance(entry, dict):
                continue
            try:
                if os.stat(path).st_mtime >= cutoff:
                    continue
            except OSError:
                continue
            scopes = [entry.get("global")]
            scopes.extend((entry.get("workspaces") or {}).values())
            for scope in scopes:
                if not isinstance(scope, dict) or scope.get("session_id"):
                    continue
                if scope.pop("recent_keys", None) is not None:
                    changed = True
        return changed

    def _enforce_legacy_key_bounds(self) -> bool:
        """Bound the one-time migration dedup set. Returns True if it changed.

        Keys for events that never replay would otherwise linger forever and
        be re-serialized on every flush. Expiry is stamped when keys are first
        seen and checked again on every flush snapshot so long-running
        processes drain too.
        """
        if not self._legacy_event_keys:
            return False
        changed = False
        expires_at = str(
            self._ingestion_state.get("legacy_event_keys_expires_at") or ""
        )
        if not expires_at:
            expires_at = _days_from_now_iso(LEGACY_EVENT_KEYS_TTL_DAYS)
            self._ingestion_state["legacy_event_keys_expires_at"] = expires_at
            changed = True
        if _now_iso() >= expires_at:
            log.info(
                "legacy event keys expired; dropping %d entries",
                len(self._legacy_event_keys),
            )
            self._legacy_event_keys.clear()
            return True
        if len(self._legacy_event_keys) > LEGACY_EVENT_KEYS_LIMIT:
            dropped = len(self._legacy_event_keys) - LEGACY_EVENT_KEYS_LIMIT
            log.warning(
                "legacy event keys over limit; dropping %d of %d entries",
                dropped,
                len(self._legacy_event_keys),
            )
            self._legacy_event_keys = set(
                sorted(self._legacy_event_keys)[:LEGACY_EVENT_KEYS_LIMIT]
            )
            changed = True
        return changed

    def _state_snapshot_locked(self) -> dict[str, Any]:
        self._enforce_legacy_key_bounds()
        self._ingestion_state["legacy_event_keys"] = sorted(self._legacy_event_keys)
        self._ingestion_state["recent_event_keys"] = list(self._recent_event_keys)
        return deepcopy(self._ingestion_state)

    def _remove_legacy_paths(self) -> None:
        for path in list(self._legacy_paths_to_remove):
            path.unlink(missing_ok=True)
            self._legacy_paths_to_remove.discard(path)

    def get_ingestion_checkpoint(
        self,
        file_path: str,
        workspace_path: str | None = None,
    ) -> dict[str, Any]:
        """Return a copy of the compact cursor for Global or one workspace."""
        with self._lock:
            entry = self._ingestion_state["files"].get(file_path, {})
            if workspace_path:
                value = entry.get("workspaces", {}).get(workspace_path, {})
            else:
                value = entry.get("global", {})
            return deepcopy(value) if isinstance(value, dict) else {}

    def _advance_ingestion_checkpoint_locked(
        self,
        file_path: str,
        checkpoint: dict[str, Any],
        workspace_path: str | None = None,
    ) -> None:
        if not file_path or not checkpoint:
            return
        files = self._ingestion_state["files"]
        entry = files.setdefault(file_path, {"global": {}, "workspaces": {}})
        if workspace_path:
            target = entry.setdefault("workspaces", {})
            current = target.get(workspace_path, {})
            if not self._checkpoint_is_newer(current, checkpoint):
                return
            target[workspace_path] = deepcopy(checkpoint)
        else:
            if not self._checkpoint_is_newer(entry.get("global", {}), checkpoint):
                return
            entry["global"] = deepcopy(checkpoint)
        self._pending_delta.append({
            "t": "ckpt",
            "p": file_path,
            "w": workspace_path or "",
            "c": deepcopy(checkpoint),
        })
        self._dirty_ingestion_state = True

    @staticmethod
    def _checkpoint_is_newer(current: dict[str, Any], candidate: dict[str, Any]) -> bool:
        if not current:
            return True
        if candidate.get("kind") == "sqlite" and current.get("kind") == "sqlite":
            if candidate.get("identity") != current.get("identity"):
                return True
            return int(candidate.get("row_id") or 0) > int(current.get("row_id") or 0)
        if candidate.get("kind") == "jsonl" and current.get("kind") == "jsonl":
            if candidate.get("identity") != current.get("identity"):
                return True
            return int(candidate.get("offset") or 0) > int(current.get("offset") or 0)
        return True

    @staticmethod
    def _checkpoint_is_ahead(current: dict[str, Any], candidate: dict[str, Any]) -> bool:
        """Strict position comparison used to decide whether Global needs replay."""
        if not current:
            return True
        if candidate.get("kind") == "sqlite" and current.get("kind") == "sqlite":
            if candidate.get("identity") != current.get("identity"):
                return True
            return int(candidate.get("row_id") or 0) > int(current.get("row_id") or 0)
        if candidate.get("kind") == "jsonl" and current.get("kind") == "jsonl":
            if candidate.get("identity") != current.get("identity"):
                return True
            return int(candidate.get("offset") or 0) > int(current.get("offset") or 0)
        return True

    def advance_ingestion_checkpoint(
        self,
        file_path: str,
        checkpoint: dict[str, Any],
        workspace_path: str | None = None,
    ) -> None:
        with self._lock:
            self._advance_ingestion_checkpoint_locked(file_path, checkpoint, workspace_path)

    def _remember_event_key_locked(self, scoped_key: str) -> None:
        if not scoped_key or scoped_key in self._recent_event_key_set:
            return
        self._recent_event_keys.append(scoped_key)
        self._recent_event_key_set.add(scoped_key)
        while len(self._recent_event_keys) > RECENT_EVENT_KEYS_LIMIT:
            old = self._recent_event_keys.popleft()
            self._recent_event_key_set.discard(old)
        self._pending_delta.append({"t": "rek", "k": scoped_key})
        self._dirty_ingestion_state = True

    # ───────────────────────── Run lifecycle ────────────────────────

    def start_run(
        self,
        workspace_path: str,
        *,
        run_id: str,
        task: str,
        run_dir: str,
    ) -> dict[str, Any]:
        """Archive any in-progress current_run, then start a fresh one."""
        with self._flush_lock, self._lock:
            doc = self._load_workspace(workspace_path)
            if doc["current_run"]:
                prev = doc["current_run"]
                prev["ended_at"] = _now_iso()
                doc["runs"].append(prev)
            doc["current_run"] = _new_run(run_id, task, run_dir)
            self._save_workspace(workspace_path)
            return doc["current_run"]

    def end_run(self, workspace_path: str) -> None:
        with self._flush_lock, self._lock:
            doc = self._load_workspace(workspace_path)
            if doc["current_run"]:
                doc["current_run"]["ended_at"] = _now_iso()
                doc["runs"].append(doc["current_run"])
                doc["current_run"] = None
            self._save_workspace(workspace_path)

    # ───────────────────────── Recording ───────────────────────────

    def record(
        self,
        workspace_path: str | None,
        *,
        source: str,           # "analyzer" | "cli"
        vendor: str,           # "claude" | "codex" | "analyzer"
        agent_key: str | None = None,
        pane_id: str | None = None,
        stage_id: str | None = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        dedup_key: str = "",
        ingestion_file: str = "",
        ingestion_checkpoint: dict[str, Any] | None = None,
        replay_workspace: str = "",
        legacy_dedup_key: str = "",
    ) -> bool:
        """Add a single token event. All numeric inputs are >= 0; zeros allowed.

        workspace_path may be None (e.g. for an analyzer call made before any
        workspace was selected) — those still hit the global tally.

        dedup_key is a bounded crash/retry guard. Durable replay progress comes
        from ingestion checkpoints; legacy_dedup_key is consumed only while
        converting the retired event-key files.
        """
        # Defensive normalisation: no negative tokens, no NaN.
        input_tokens = max(0, int(input_tokens))
        output_tokens = max(0, int(output_tokens))
        if input_tokens == 0 and output_tokens == 0:
            # Don't bump `calls` either — zero-zero events are no-ops.
            return False
        delta = {
            "input": input_tokens,
            "output": output_tokens,
            "calls": 1,
        }

        with self._lock:
            scope = f"workspace:{replay_workspace}" if replay_workspace else "global"
            generation = str((ingestion_checkpoint or {}).get("identity") or "")
            scoped_key = (
                f"{scope}::{generation}::{dedup_key}" if dedup_key else ""
            )
            legacy_matches = {
                key for key in (dedup_key, legacy_dedup_key)
                if key and key in self._legacy_event_keys
            }
            legacy_duplicate = bool(legacy_matches)
            recent_duplicate = bool(scoped_key and scoped_key in self._recent_event_key_set)
            global_checkpoint = self._ingestion_state["files"].get(
                ingestion_file, {}
            ).get("global", {})
            credit_global_on_replay = bool(
                replay_workspace
                and not legacy_duplicate
                and ingestion_checkpoint
                and self._checkpoint_is_ahead(global_checkpoint, ingestion_checkpoint)
            )

            if legacy_duplicate:
                self._legacy_event_keys.difference_update(legacy_matches)
                self._dirty_ingestion_state = True
            if recent_duplicate or (legacy_duplicate and not replay_workspace):
                if ingestion_checkpoint:
                    if replay_workspace:
                        self._advance_ingestion_checkpoint_locked(
                            ingestion_file, ingestion_checkpoint, replay_workspace
                        )
                    else:
                        self._advance_ingestion_checkpoint_locked(
                            ingestion_file, ingestion_checkpoint
                        )
                        if workspace_path:
                            self._advance_ingestion_checkpoint_locked(
                                ingestion_file, ingestion_checkpoint, workspace_path
                            )
                return True
            self._remember_event_key_locked(scoped_key)

            # --- workspace state ---
            if workspace_path:
                doc = self._load_workspace(workspace_path)
                # current_run (only if one is active)
                if doc["current_run"]:
                    run = doc["current_run"]
                    _add(run["totals"], delta)
                    _add(run["by_vendor"].setdefault(vendor, _empty_bucket()), delta)
                    if stage_id:
                        _add(run["by_stage"].setdefault(stage_id, _empty_bucket()), delta)
                    if pane_id:
                        _add(run["by_pane"].setdefault(pane_id, _empty_bucket()), delta)
                # cumulative (workspace lifetime, runs included)
                cum = doc["cumulative"]
                _add(cum["totals"], delta)
                _add(cum["by_vendor"].setdefault(vendor, _empty_bucket()), delta)
                if stage_id:
                    _add(cum["by_stage"].setdefault(stage_id, _empty_bucket()), delta)
                self._dirty_workspaces.add(workspace_path)

            # --- global state ---
            if not replay_workspace or credit_global_on_replay:
                g = self._global_data
                _add(g["all_time"], delta)
                _add(g["by_vendor"].setdefault(vendor, _empty_bucket()), delta)
                day = _today()
                _add(g["by_day"].setdefault(day, _empty_bucket()), delta)
                self._dirty_global = True

            if ingestion_checkpoint:
                if replay_workspace:
                    self._advance_ingestion_checkpoint_locked(
                        ingestion_file, ingestion_checkpoint, replay_workspace
                    )
                    if credit_global_on_replay:
                        self._advance_ingestion_checkpoint_locked(
                            ingestion_file, ingestion_checkpoint
                        )
                else:
                    self._advance_ingestion_checkpoint_locked(
                        ingestion_file, ingestion_checkpoint
                    )
                    if workspace_path:
                        self._advance_ingestion_checkpoint_locked(
                            ingestion_file, ingestion_checkpoint, workspace_path
                        )

        log.debug(
            "tokens recorded source=%s vendor=%s pane=%s stage=%s in=%d out=%d",
            source, vendor, pane_id, stage_id, input_tokens, output_tokens,
        )
        return True

    # ───────────────────────── Snapshot ─────────────────────────────

    def snapshot(self, workspace_path: str | None) -> dict[str, Any]:
        with self._lock:
            workspace_doc = (
                self._load_workspace(workspace_path) if workspace_path else _empty_workspace_doc()
            )
            return {
                "workspace_path": workspace_path or "",
                "workspace": {
                    "current_run": workspace_doc["current_run"],
                    "runs": workspace_doc["runs"][-20:],  # last 20 only — keep payload small
                    "cumulative": workspace_doc["cumulative"],
                },
                "global": dict(self._global_data),
            }

    # ───────────────────────── Reset ────────────────────────────────

    def reset(self, scope: str, workspace_path: str | None = None) -> dict[str, Any]:
        """Reset scope = 'run' | 'workspace' | 'global'."""
        with self._flush_lock, self._lock:
            if scope == "run" and workspace_path:
                doc = self._load_workspace(workspace_path)
                # Replace current_run with a fresh blank (preserve run_id/task)
                if doc["current_run"]:
                    cur = doc["current_run"]
                    doc["current_run"] = _new_run(
                        run_id=cur["run_id"],
                        task=cur["task"],
                        run_dir=cur.get("run_dir", ""),
                    )
                self._dirty_workspaces.add(workspace_path)
            elif scope == "workspace" and workspace_path:
                self._workspace_cache[workspace_path] = _empty_workspace_doc()
                self._dirty_workspaces.add(workspace_path)
                for entry in self._ingestion_state["files"].values():
                    if isinstance(entry, dict):
                        entry.get("workspaces", {}).pop(workspace_path, None)
                self._dirty_ingestion_state = True
                # A reset removes state, which no delta record can express, and
                # any queued record would resurrect what was just dropped.
                self._pending_delta.clear()
                self._force_compaction = True
            elif scope == "global":
                self._global_data = _empty_global_doc()
                self._dirty_global = True
                self._ingestion_state = _empty_ingestion_state()
                self._legacy_event_keys.clear()
                self._recent_event_keys.clear()
                self._recent_event_key_set.clear()
                self._dirty_ingestion_state = True
                self._pending_delta.clear()
                self._force_compaction = True
            else:
                raise ValueError(f"unknown reset scope: {scope!r}")
            result = self.snapshot(workspace_path)
            self._flush_dirty()
            return result
