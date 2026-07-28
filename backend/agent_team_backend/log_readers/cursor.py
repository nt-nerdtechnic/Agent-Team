"""Cursor CLI (`agent`, legacy `cursor-agent`) conversation store reader.

Layout (root = ~/.cursor/chats — Cursor offers no official env override for
its data home, so the root is fixed; tests relocate it via Path.home()):

  ~/.cursor/chats/<project-hash>/<session-uuid>/store.db   one SQLite db per session
    meta  table — single row (key '0'), value = hex-encoded JSON
                  (agentId, latestRootBlobId, lastUsedModel, createdAt; NO cwd)
    blobs table — content-addressed protobuf blobs (SHA256 keys) with NO
                  public schema. User input is embedded VERBATIM as UTF-8
                  inside a blob, so the kickoff's `at-pane:<paneId>` marker is
                  found by a raw bytes substring scan — the protobuf is never
                  decoded.

  <project-hash> is community-documented as md5(cwd) hexdigest (NOT confirmed
  upstream — Cursor is closed source; format knowledge here comes from
  community reverse engineering, e.g. agentgrep). The hash is used only as a
  best-effort workspace filter and never gates marker binding (markers are
  globally unique).

  ~/.cursor/acp-sessions/<id>/store.db (ACP mode) is intentionally ignored,
  as is ~/.cursor/projects/<slug>/agent-transcripts/*.jsonl — that is Cursor
  IDE data, not the CLI's.

Cursor CLI stores NO token usage locally, so this reader emits no TokenUsage
events at all (parse_session_file/parse_incremental return empty — the
minimal legal behaviour for the interface). parse_activity emits a coarse
`agent_active` whenever the db's mtime/size changes; there is no
turn_complete signal (the store has no known end-of-turn record).

Everything here is maximally defensive: any missing table, unexpected
schema, undecodable value, or sqlite error is tolerated by silently skipping
that db — never by raising.

resume: `agent --resume=<chatId>` (session id = the <session-uuid> dir name).
"""

from __future__ import annotations

import hashlib
import logging
import re
import sqlite3
from collections.abc import Iterable
from pathlib import Path

from .base import ActivityEvent, IncrementalParseResult, LogReader, TokenUsage

log = logging.getLogger("agent_team_backend.log_readers.cursor")

_DB_NAME = "store.db"

# Read-only busy wait: long enough to ride out an agent write transaction,
# short enough not to stall the watcher's drain thread (same as Grok).
_BUSY_TIMEOUT_MS = 250

# Marker-scan bounds. The kickoff marker lands in an early, small user-input
# blob, so scanning the head of each blob is enough; the caps keep a huge or
# blob-heavy session db from turning every scan into a performance disaster.
_MAX_BLOB_BYTES = 262_144   # bytes searched per blob (truncated in SQL)
_MAX_BLOBS_PER_DB = 512     # blobs examined per store.db

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Sentinel prefix persisted inside the watcher-owned per-file seen_keys set
# (same trick as Kimi's turn state): the last observed mtime/size, so
# parse_activity emits agent_active only when the db actually changed.
_STAT_PREFIX = "cursor_stat::"


def cursor_chats_root() -> Path:
    """Cursor CLI's per-session chat-store root (fixed, no env override)."""
    return Path.home() / ".cursor" / "chats"


def cursor_project_hash(cwd: str) -> str:
    """Community-documented <project-hash> for a workspace: md5(cwd) hexdigest.

    UNCONFIRMED upstream — callers must treat a non-match as "unknown", never
    as proof a session belongs elsewhere.
    """
    if not cwd:
        return ""
    return hashlib.md5(cwd.encode("utf-8")).hexdigest()


class CursorLogReader(LogReader):
    vendor: str = "cursor"

    def _chats_root(self) -> Path:
        return cursor_chats_root()

    def project_dirs(self) -> list[Path]:
        """The single chats root (empty list when it doesn't exist)."""
        root = self._chats_root()
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for f in root.glob(f"*/*/{_DB_NAME}"):
                    if _UUID_RE.match(f.parent.name) and f.is_file():
                        out.append(f)
            except OSError as err:
                log.debug("glob %s failed: %s", root, err)
        return out

    def session_id_from_path(self, path: Path) -> str:
        """Id is the session dir name (the chatId `agent --resume=<id>`
        accepts), NOT the stem — every session file is store.db. Sibling
        files (store.db-wal, -shm, anything unexpected) are not session
        files → '' so the resume sink skips them instead of coining bogus
        ids."""
        if path.name != _DB_NAME or not _UUID_RE.match(path.parent.name):
            return ""
        return path.parent.name

    def cwd_from_file(self, path: Path) -> str:
        """Always '' — store.db's meta JSON carries no cwd, and the
        <project-hash> dir name is a one-way digest that can't be reversed."""
        return ""

    def has_session(self, session_id: str) -> bool:
        """True when <root>/<any-project-hash>/<id>/store.db exists. The
        project-hash segment is not reliably derivable from the workspace
        (md5(cwd) is unconfirmed), so glob across every project dir."""
        session_id = session_id.strip()
        if not _UUID_RE.match(session_id):
            return False
        for root in self.project_dirs():
            try:
                if any(root.glob(f"*/{session_id}/{_DB_NAME}")):
                    return True
            except OSError:
                continue
        return False

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        """Best-effort md5(cwd) scoping: when the community-documented hash
        dir exists, return only its sessions; otherwise None → the caller
        falls back to session_files(), so a wrong hash assumption can only
        widen the scan, never hide sessions."""
        hash_dir = cursor_project_hash(workspace_path)
        if not hash_dir:
            return None
        base = self._chats_root() / hash_dir
        try:
            if not base.is_dir():
                return None
            return [
                f for f in base.glob(f"*/{_DB_NAME}")
                if _UUID_RE.match(f.parent.name) and f.is_file()
            ]
        except OSError:
            return None

    def _query(self, path: Path, sql: str) -> list[tuple] | None:
        """Short-lived read-only query. None = db unreadable this cycle
        (missing / busy / locked / missing table / mid-write) — callers
        treat it as no data."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
                return con.execute(sql).fetchall()
            finally:
                con.close()
        except (sqlite3.Error, OSError) as err:
            log.debug("sqlite read %s failed: %s", path, err)
            return None

    # ── token interface: Cursor stores no usage locally ────────────────────

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        """Cursor CLI keeps no token usage on disk → never any events."""
        return []

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """No token events, ever (usage is not stored locally). The
        checkpoint passes through unchanged; change detection for activity
        lives in parse_activity."""
        return IncrementalParseResult([], dict(checkpoint))

    # ── activity: coarse mtime/size signal only ─────────────────────────────

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit one `agent_active` per observed db mtime/size change.

        The blobs are opaque protobuf, so there is no per-message or
        end-of-turn record to parse — a write to the store is the only
        activity signal available, and no turn_complete is ever emitted.
        """
        session_id = self.session_id_from_path(path)
        if not session_id:
            return []
        try:
            stat = path.stat()
        except OSError:
            return []
        token = f"{stat.st_mtime_ns}:{stat.st_size}"
        prev = next(
            (k[len(_STAT_PREFIX):] for k in seen_keys if k.startswith(_STAT_PREFIX)),
            None,
        )
        if prev == token:
            return []
        seen_keys.difference_update(
            {k for k in seen_keys if k.startswith(_STAT_PREFIX)}
        )
        seen_keys.add(_STAT_PREFIX + token)
        return [
            ActivityEvent(
                vendor="cursor",
                event_type="agent_active",
                cwd="",
                session_id=session_id,
                file_path=str(path),
                dedup_key=f"stat:{token}",
                timestamp=str(int(stat.st_mtime)),
                detail="db-write",
            )
        ]

    # ── marker binding ──────────────────────────────────────────────────────

    def find_sessions_by_marker(
        self, markers: Iterable[str]
    ) -> dict[str, tuple[str, str]]:
        """marker → (session_id, workspace_root) resolved by a raw UTF-8
        bytes substring scan over each session db's blobs (protobuf is never
        decoded). workspace_root is always '' — the store records no cwd —
        which keeps Attribution's shared-db workspace gate permissive.
        Unreadable dbs / missing tables / non-bytes values are skipped."""
        wanted = {m: m.encode("utf-8") for m in markers if m}
        if not wanted:
            return {}
        found: dict[str, tuple[str, str]] = {}
        sql = (
            f"SELECT substr(value, 1, {_MAX_BLOB_BYTES}) FROM blobs "
            f"LIMIT {_MAX_BLOBS_PER_DB}"
        )
        for db in self.session_files():
            if len(found) == len(wanted):
                break
            rows = self._query(db, sql)
            if rows is None:
                continue
            session_id = self.session_id_from_path(db)
            for (value,) in rows:
                if isinstance(value, memoryview):
                    value = bytes(value)
                elif isinstance(value, str):
                    value = value.encode("utf-8", errors="ignore")
                if not isinstance(value, bytes):
                    continue
                for marker, needle in wanted.items():
                    if marker not in found and needle in value:
                        found[marker] = (session_id, "")
        return found
