"""Append-only persistence for the inter-CLI message log.

The renderer's message log (`useAgentMessaging`) is a capped in-memory list
that dies with the window. This store mirrors it into the global
``<app_data>/navide.db`` so it survives a reload or a restart. The log is
cross-workspace by construction (a message can address a pane in another
workspace), so it lives in the global database, not a per-workspace one.

``uid`` is supplied by the renderer (``<boot-hex>:<local-seq>``) and is
globally unique; the backend never mints ids, which keeps re-sending the same
row idempotent (INSERT OR REPLACE). Newest ``MAX_ROWS`` rows are kept — the
prune runs in the same transaction as the insert. ``from``/``to`` are
reserved-ish words in SQL, hence the ``sender``/``recipient`` columns.

Resilience follows history_store: a sqlite failure is logged and swallowed,
never raised at the caller, and the rows stay in the in-memory tail buffer so
reads within the session still work.
"""

from __future__ import annotations

import logging
import sqlite3
from collections import deque
from threading import RLock
from typing import Any

from .db import Database

log = logging.getLogger("agent_team_backend.agent_message_log")

_COMPONENT = "agent_message_log"

MAX_ROWS = 500  # rows kept on disk, and the in-memory ring buffer size
MAX_CONTENT_CHARS = 64 * 1024  # one runaway message must not bloat the db
_TRUNCATION_MARKER = "…[truncated]"

_STATUSES = ("queued", "delivering", "delivered", "failed")
# Mirrors the frontend's clearMessageLog rule: in-flight messages survive.
DEFAULT_KEEP_STATUSES = ("queued", "delivering")

_COLUMNS = (
    "uid",
    "created_at",
    "status",
    "sender",
    "recipient",
    "content",
    "reason",
    "delivered_at",
    "remote",
    "remote_workspace",
)


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE agent_message_log ("
        " uid TEXT PRIMARY KEY,"
        " created_at INTEGER NOT NULL,"
        " status TEXT NOT NULL,"
        " sender TEXT NOT NULL,"
        " recipient TEXT NOT NULL,"
        " content TEXT NOT NULL,"
        " reason TEXT,"
        " delivered_at INTEGER,"
        " remote TEXT,"
        " remote_workspace TEXT)"
    )
    cur.execute(
        "CREATE INDEX agent_message_log_created ON agent_message_log (created_at, uid)"
    )


def _clamp_content(content: str) -> str:
    if len(content) <= MAX_CONTENT_CHARS:
        return content
    keep = MAX_CONTENT_CHARS - len(_TRUNCATION_MARKER)
    return content[:keep] + _TRUNCATION_MARKER


def _coerce_status(value: Any) -> str:
    text = str(value)
    return text if text in _STATUSES else "failed"


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text or None


def _normalize(row: Any) -> dict[str, Any] | None:
    """A storable row, or None when the input is unusable."""
    if not isinstance(row, dict):
        return None
    uid = str(row.get("uid") or "")
    created_at = _optional_int(row.get("created_at"))
    if not uid or created_at is None:
        return None
    if row.get("status") is None or row.get("content") is None:
        return None
    return {
        "uid": uid,
        "created_at": created_at,
        "status": _coerce_status(row.get("status")),
        "sender": str(row.get("sender") or ""),
        "recipient": str(row.get("recipient") or ""),
        "content": _clamp_content(str(row.get("content"))),
        "reason": _optional_text(row.get("reason")),
        "delivered_at": _optional_int(row.get("delivered_at")),
        "remote": _optional_text(row.get("remote")),
        "remote_workspace": _optional_text(row.get("remote_workspace")),
    }


class AgentMessageLog:
    """Thread-safe append-only message log with an in-memory tail buffer."""

    def __init__(self, db: Database) -> None:
        self._lock = RLock()
        self._db = db
        self._db.migrate(_COMPONENT, 1, _create_schema)
        # Oldest-first mirror of the newest rows, so reads stay correct even
        # when a write failed and the rows only ever made it to memory.
        self._tail: deque[dict[str, Any]] = deque(maxlen=MAX_ROWS)

    # ───────────────────────── Writing ──────────────────────────────
    def append(self, rows: list[dict[str, Any]]) -> int:
        """Persist a batch of rows; returns how many were written.

        Unusable rows are skipped. A failed write degrades to memory-only:
        the rows stay in the tail buffer, the failure is logged, and 0 is
        returned.
        """
        clean = [r for r in (_normalize(row) for row in rows or []) if r is not None]
        if not clean:
            return 0
        with self._lock:
            self._buffer_append(clean)
            try:
                with self._db.transaction() as cur:
                    cur.executemany(
                        "INSERT OR REPLACE INTO agent_message_log"
                        f" ({', '.join(_COLUMNS)})"
                        f" VALUES ({', '.join('?' * len(_COLUMNS))})",
                        [tuple(row[col] for col in _COLUMNS) for row in clean],
                    )
                    cur.execute(
                        "DELETE FROM agent_message_log WHERE uid NOT IN"
                        " (SELECT uid FROM agent_message_log"
                        "  ORDER BY created_at DESC, uid DESC LIMIT ?)",
                        (MAX_ROWS,),
                    )
            except sqlite3.Error as err:
                log.warning("agent message log append failed: %s", err)
                return 0
        return len(clean)

    def update(self, updates: list[dict[str, Any]]) -> int:
        """Apply ``{uid, status, reason?, delivered_at?}`` patches.

        Only the provided fields are written. An unknown uid is a silent
        no-op — its row may have been pruned. Returns the rows touched.
        """
        touched = 0
        with self._lock:
            try:
                with self._db.transaction() as cur:
                    for update in updates or []:
                        if not isinstance(update, dict):
                            continue
                        uid = str(update.get("uid") or "")
                        if not uid:
                            continue
                        fields: dict[str, Any] = {}
                        if update.get("status") is not None:
                            fields["status"] = _coerce_status(update["status"])
                        if "reason" in update:
                            fields["reason"] = _optional_text(update["reason"])
                        if "delivered_at" in update:
                            fields["delivered_at"] = _optional_int(update["delivered_at"])
                        if not fields:
                            continue
                        self._buffer_update(uid, fields)
                        cur.execute(
                            "UPDATE agent_message_log SET"
                            f" {', '.join(f'{k} = ?' for k in fields)}"
                            " WHERE uid = ?",
                            (*fields.values(), uid),
                        )
                        touched += cur.rowcount if cur.rowcount > 0 else 0
            except sqlite3.Error as err:
                log.warning("agent message log update failed: %s", err)
                return 0
        return touched

    def clear(self, keep_statuses: list[str] | None = None) -> int:
        """Delete every row whose status is not in ``keep_statuses``.

        Defaults to keeping ``queued``/``delivering``, mirroring the
        frontend's clearMessageLog rule. Returns the rows deleted.
        """
        keep = [str(s) for s in (
            DEFAULT_KEEP_STATUSES if keep_statuses is None else keep_statuses
        )]
        with self._lock:
            self._tail = deque(
                (row for row in self._tail if row["status"] in keep), maxlen=MAX_ROWS
            )
            try:
                with self._db.transaction() as cur:
                    if keep:
                        cur.execute(
                            "DELETE FROM agent_message_log WHERE status NOT IN"
                            f" ({', '.join('?' * len(keep))})",
                            tuple(keep),
                        )
                    else:
                        cur.execute("DELETE FROM agent_message_log")
                    return cur.rowcount if cur.rowcount > 0 else 0
            except sqlite3.Error as err:
                log.warning("agent message log clear failed: %s", err)
                return 0

    # ───────────────────────── Reading ──────────────────────────────
    def tail(self, limit: int = MAX_ROWS) -> list[dict[str, Any]]:
        """The most recent rows, oldest last — the renderer's array order.

        Serves from the in-memory buffer when warm, otherwise from the
        database (warming the buffer for next time).
        """
        limit = max(1, min(int(limit), MAX_ROWS))
        with self._lock:
            if self._tail:
                return [dict(row) for row in list(self._tail)[-limit:]]
            try:
                with self._db.transaction() as cur:
                    found = cur.execute(
                        f"SELECT {', '.join(_COLUMNS)} FROM agent_message_log"
                        " ORDER BY created_at DESC, uid DESC LIMIT ?",
                        (MAX_ROWS,),
                    ).fetchall()
            except sqlite3.Error as err:
                log.warning("agent message log read failed: %s", err)
                return []
            rows = [dict(row) for row in reversed(found)]
            self._tail = deque(rows, maxlen=MAX_ROWS)
            return [dict(row) for row in rows[-limit:]]

    # ───────────────────────── Tail buffer ──────────────────────────
    def _buffer_append(self, rows: list[dict[str, Any]]) -> None:
        uids = {row["uid"] for row in rows}
        if any(row["uid"] in uids for row in self._tail):
            self._tail = deque(
                (row for row in self._tail if row["uid"] not in uids), maxlen=MAX_ROWS
            )
        self._tail.extend(dict(row) for row in rows)

    def _buffer_update(self, uid: str, fields: dict[str, Any]) -> None:
        for row in self._tail:
            if row["uid"] == uid:
                row.update(fields)
                return
