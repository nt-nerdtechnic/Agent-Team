"""Per-workspace record of what the preview panel has been shown.

Three writers feed one feed: the app itself (a user opening a file), an agent
(an MCP call or a Claude hook), and the filesystem watcher, which is the
catch-all for a change nobody claimed. Only the first of those goes through the
renderer, so — unlike ``agent_message_log``, where the renderer mints the uid
and the backend only upserts — this is a backend-authored log and the uid is
minted here as ``<created_at>:<seq>``.

Rows live in the workspace database (``<workspace>/.agent-team/navide.db``)
because a preview record is about a file in that workspace and means nothing
outside it.

The watcher sees the same write the agent already reported, so a naive log
would show every save twice. ``append`` therefore merges: a second row for the
same path and change inside ``MERGE_WINDOW_MS`` folds into the first, and an
attributed row (agent/user) always wins over the anonymous watcher one — it
upgrades a watcher row already on disk, and discards a watcher row arriving
after it.

A sqlite failure is logged and swallowed, never raised at the caller; it simply
means the record was not persisted.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from threading import RLock
from typing import Any

from .db import Database, WorkspaceDatabases

log = logging.getLogger("agent_team_backend.preview_log")

_COMPONENT = "preview_log"

MAX_ROWS = 300  # rows kept per workspace
MERGE_WINDOW_MS = 2000  # must stay above the git watcher's 0.4s debounce
MAX_NOTE_CHARS = 500
# Characters, not bytes — matches the frontend's MAX_INLINE_CONTENT.
MAX_INLINE_CHARS = 512 * 1024
_TRUNCATION_MARKER = "…[truncated]"

# "created"/"modified"/"deleted" are inferred from the event; "shown" means the
# file was only pushed to the preview panel, not changed.
_CHANGES = ("created", "modified", "deleted", "shown")
# "user" and "agent" mirror the frontend's PreviewSource union; "watcher" is the
# unattributed fallback the filesystem watcher writes.
_SOURCES = ("user", "agent", "watcher")
# The frontend PreviewTarget union — no new vocabulary invented here.
_KINDS = ("file", "diff", "snippet", "html", "markdown")

_COLUMNS = (
    "uid",
    "created_at",
    "change",
    "rel_path",
    "kind",
    "title",
    "source",
    "pane_id",
    "agent",
    "tool",
    "note",
    "payload",
)


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE preview_log ("
        " uid TEXT PRIMARY KEY,"
        " created_at INTEGER NOT NULL,"
        " change TEXT NOT NULL,"
        " rel_path TEXT,"
        " kind TEXT NOT NULL,"
        " title TEXT,"
        " source TEXT NOT NULL,"
        " pane_id TEXT,"
        " agent TEXT,"
        " tool TEXT,"
        " note TEXT,"
        " payload TEXT)"
    )
    cur.execute(
        "CREATE INDEX preview_log_created ON preview_log (created_at, uid)"
    )
    cur.execute(
        "CREATE INDEX preview_log_path ON preview_log (rel_path, created_at)"
    )


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clamp_note(note: str) -> str:
    if len(note) <= MAX_NOTE_CHARS:
        return note
    keep = MAX_NOTE_CHARS - len(_TRUNCATION_MARKER)
    return note[:keep] + _TRUNCATION_MARKER


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text or None


class PreviewLog:
    """Thread-safe per-workspace preview record, backed only by the database."""

    def __init__(self, databases: WorkspaceDatabases | None = None) -> None:
        self._lock = RLock()
        self._databases = databases or WorkspaceDatabases()
        # db paths whose preview_log schema is already ensured
        self._migrated: set[str] = set()
        # Breaks the created_at ties a burst inside one millisecond produces.
        self._seq = 0

    # ───────────────────────── Database plumbing ─────────────────────
    def _db(self, workspace_path: str, *, create: bool) -> Database | None:
        """The workspace db; read paths never plant one that does not exist."""
        db = (
            self._databases.get(workspace_path)
            if create
            else self._databases.peek(workspace_path)
        )
        if db is None:
            return None
        key = str(db.path)
        if key not in self._migrated:
            db.migrate(_COMPONENT, 1, _create_schema)
            self._migrated.add(key)
        return db

    # ───────────────────────── Writing ──────────────────────────────
    def append(
        self,
        workspace_path: str,
        *,
        change: str,
        kind: str = "file",
        rel_path: str | None = None,
        title: str | None = None,
        source: str,
        pane_id: str | None = None,
        agent: str | None = None,
        tool: str | None = None,
        note: str | None = None,
        payload: str | None = None,
    ) -> dict[str, Any] | None:
        """Record one preview event; returns the row to broadcast, or None.

        None means nothing new is on the feed: the input was unusable, or the
        event folded into a row already there (see the merge rules below).
        An upgraded watcher row *is* returned — its attribution changed, so
        the panel has to be told.
        """
        change = str(change or "")
        source = str(source or "")
        kind = str(kind or "")
        if change not in _CHANGES or source not in _SOURCES or kind not in _KINDS:
            log.warning(
                "preview log row rejected: change=%r source=%r kind=%r",
                change,
                source,
                kind,
            )
            return None
        payload = _optional_text(payload)
        if payload is not None and len(payload) > MAX_INLINE_CHARS:
            log.warning(
                "preview log row rejected: payload of %d chars exceeds %d",
                len(payload),
                MAX_INLINE_CHARS,
            )
            return None
        rel_path = _optional_text(rel_path)
        title = _optional_text(title)
        pane_id = _optional_text(pane_id)
        agent = _optional_text(agent)
        tool = _optional_text(tool)
        note = _optional_text(note)
        if note is not None:
            note = _clamp_note(note)

        with self._lock:
            db = self._db(workspace_path, create=True)
            if db is None:
                log.warning(
                    "preview log append failed: workspace %s is not a directory",
                    workspace_path,
                )
                return None
            now = _now_ms()
            try:
                with db.transaction() as cur:
                    existing = self._merge_candidate(cur, rel_path, change, now)
                    if existing is not None:
                        return self._merge(
                            cur,
                            existing,
                            now,
                            source=source,
                            pane_id=pane_id,
                            agent=agent,
                            tool=tool,
                            note=note,
                        )
                    self._seq += 1
                    row = {
                        "uid": f"{now}:{self._seq}",
                        "created_at": now,
                        "change": change,
                        "rel_path": rel_path,
                        "kind": kind,
                        "title": title,
                        "source": source,
                        "pane_id": pane_id,
                        "agent": agent,
                        "tool": tool,
                        "note": note,
                        "payload": payload,
                    }
                    cur.execute(
                        f"INSERT INTO preview_log ({', '.join(_COLUMNS)})"
                        f" VALUES ({', '.join('?' * len(_COLUMNS))})",
                        tuple(row[col] for col in _COLUMNS),
                    )
                    cur.execute(
                        "DELETE FROM preview_log WHERE uid NOT IN"
                        " (SELECT uid FROM preview_log"
                        "  ORDER BY created_at DESC, rowid DESC LIMIT ?)",
                        (MAX_ROWS,),
                    )
            except sqlite3.Error as err:
                log.warning(
                    "preview log append failed for %s: %s", workspace_path, err
                )
                return None
        return row

    def _merge_candidate(
        self,
        cur: sqlite3.Cursor,
        rel_path: str | None,
        change: str,
        now: int,
    ) -> sqlite3.Row | None:
        """The row this event would fold into, if there is one.

        Inline records (snippet/html/markdown) carry no path, so they have
        nothing to be the same file as and never merge.
        """
        if rel_path is None:
            return None
        return cur.execute(
            f"SELECT rowid, {', '.join(_COLUMNS)} FROM preview_log"
            " WHERE rel_path = ? AND change = ? AND created_at >= ?"
            " ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (rel_path, change, now - MERGE_WINDOW_MS),
        ).fetchone()

    def _merge(
        self,
        cur: sqlite3.Cursor,
        existing: sqlite3.Row,
        now: int,
        *,
        source: str,
        pane_id: str | None,
        agent: str | None,
        tool: str | None,
        note: str | None,
    ) -> dict[str, Any] | None:
        """Fold an event into ``existing``; returns a row only on an upgrade.

        Attribution beats anonymity in both directions: an agent/user event
        upgrades the watcher row the same write already produced, and a watcher
        event arriving after an attributed one is dropped rather than allowed
        to overwrite who did it.
        """
        if existing["source"] == "watcher" and source != "watcher":
            merged = dict(existing)
            merged.pop("rowid", None)
            merged.update(
                {
                    "created_at": now,
                    "source": source,
                    "pane_id": pane_id,
                    "agent": agent,
                    "tool": tool,
                    "note": note if note is not None else existing["note"],
                }
            )
            cur.execute(
                "UPDATE preview_log SET created_at = ?, source = ?, pane_id = ?,"
                " agent = ?, tool = ?, note = ? WHERE uid = ?",
                (
                    merged["created_at"],
                    merged["source"],
                    merged["pane_id"],
                    merged["agent"],
                    merged["tool"],
                    merged["note"],
                    merged["uid"],
                ),
            )
            return merged
        if source == "watcher" and existing["source"] != "watcher":
            return None  # the write is already on the feed, with an author
        cur.execute(
            "UPDATE preview_log SET created_at = ? WHERE uid = ?",
            (now, existing["uid"]),
        )
        return None

    def clear(self, workspace_path: str, *, before: int | None = None) -> int:
        """Delete this workspace's rows; returns how many went.

        ``before`` keeps everything stamped at or after it, which is what the
        panel's clear button wants: the rows the user can currently see go, and
        anything recorded while they clicked stays.
        """
        with self._lock:
            db = self._db(workspace_path, create=False)
            if db is None:
                return 0
            try:
                with db.transaction() as cur:
                    if before is None:
                        cur.execute("DELETE FROM preview_log")
                    else:
                        cur.execute(
                            "DELETE FROM preview_log WHERE created_at < ?",
                            (int(before),),
                        )
                    return cur.rowcount if cur.rowcount > 0 else 0
            except sqlite3.Error as err:
                log.warning(
                    "preview log clear failed for %s: %s", workspace_path, err
                )
                return 0

    # ───────────────────────── Reading ──────────────────────────────
    def tail(
        self,
        workspace_path: str,
        limit: int = 50,
        *,
        since: int | None = None,
        change: str | None = None,
        agent: str | None = None,
        source: str | None = None,
    ) -> list[dict[str, Any]]:
        """The most recent rows, newest first.

        Always a database read: this store exists to survive restarts, so a
        read must never report anything but what is actually persisted.
        """
        limit = max(1, min(int(limit), MAX_ROWS))
        where: list[str] = []
        params: list[Any] = []
        if since is not None:
            where.append("created_at > ?")
            params.append(int(since))
        if change:
            where.append("change = ?")
            params.append(str(change))
        if agent:
            where.append("agent = ?")
            params.append(str(agent))
        if source:
            where.append("source = ?")
            params.append(str(source))
        params.append(limit)
        with self._lock:
            db = self._db(workspace_path, create=False)
            if db is None:
                return []
            try:
                with db.transaction() as cur:
                    found = cur.execute(
                        f"SELECT {', '.join(_COLUMNS)} FROM preview_log"
                        + (f" WHERE {' AND '.join(where)}" if where else "")
                        + " ORDER BY created_at DESC, rowid DESC LIMIT ?",
                        tuple(params),
                    ).fetchall()
            except sqlite3.Error as err:
                log.warning(
                    "preview log read failed for %s: %s", workspace_path, err
                )
                return []
        return [dict(row) for row in found]
