"""Append-only persistence for the inter-CLI message log.

The renderer's message log (`useAgentMessaging`) is a capped in-memory list
that dies with the window. This store mirrors it into the global
``<app_data>/navide.db`` so it survives a reload or a restart. The log is
cross-workspace by construction (a message can address a pane in another
workspace), so it lives in the global database, not a per-workspace one.

``uid`` is supplied by the renderer (``<boot-hex>:<local-seq>``) and is
globally unique; the backend never mints ids, which keeps re-sending the same
row idempotent (upsert). ``uid`` is an opaque key — it is *not* ordered, so
every read and the prune order by ``created_at`` plus the backend-assigned
``seq`` insertion counter, which breaks the ties that ``created_at``
(millisecond resolution) produces for a fan-out queued in one tick.
``from``/``to`` are reserved-ish words in SQL, hence the
``sender``/``recipient`` columns.

Surviving a backend restart is this store's entire purpose, so — unlike
history_store, which serves hot per-run tails — there is no in-memory mirror:
``tail()`` always reads the database, and what it returns is exactly what is
persisted. A sqlite failure is logged and swallowed, never raised at the
caller; it simply means the data was not persisted.
"""

from __future__ import annotations

import logging
import sqlite3
from threading import RLock
from typing import Any

from .db import Database

log = logging.getLogger("agent_team_backend.agent_message_log")

_COMPONENT = "agent_message_log"

MAX_ROWS = 500  # rows kept on disk
# The store can never retain more than MAX_ROWS, so a larger batch is mostly
# work thrown away; cap it so a renderer bug cannot block the event loop
# (append() is a synchronous sqlite call made from an async handler).
MAX_APPEND_ROWS = MAX_ROWS * 2
# Characters, not bytes: a CJK message can occupy ~3x this in UTF-8.
MAX_CONTENT_CHARS = 64 * 1024  # one runaway message must not bloat the db
_TRUNCATION_MARKER = "…[truncated]"

_STATUSES = ("queued", "delivering", "delivered", "failed", "cancelled")
# Message kinds Navide writes itself. NULL means an ordinary agent-sent message,
# which is what every row written before this column existed is.
#
# "fallback" is a spawned pane's turn forwarded by Navide because the pane ended
# it without writing the report it was asked for. Unlike a notice it is an
# ordinary message in every other respect — it has a real sender and can be
# resent — so only the label is Navide's.
_KINDS = ("notice", "fallback")
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
    "sender_agent",
    "recipient_agent",
    "kind",
)

# Upsert: everything but the primary key and ``seq`` is refreshed. Keeping the
# original ``seq`` is what makes a re-append (the frontend folds a pending
# status patch into a pending append row) keep its place in the log.
_CONFLICT_UPDATE = ", ".join(f"{c} = excluded.{c}" for c in _COLUMNS if c != "uid")


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


def _add_seq(cur: sqlite3.Cursor) -> None:
    """v2: the insertion counter that breaks ``created_at`` ties.

    Existing rows are backfilled in ``created_at`` order — the best order
    available for data written before the counter existed.
    """
    cur.execute(
        "ALTER TABLE agent_message_log ADD COLUMN seq INTEGER NOT NULL DEFAULT 0"
    )
    existing = cur.execute(
        "SELECT uid FROM agent_message_log ORDER BY created_at ASC, uid ASC"
    ).fetchall()
    for seq, row in enumerate(existing, start=1):
        cur.execute(
            "UPDATE agent_message_log SET seq = ? WHERE uid = ?", (seq, row["uid"])
        )
    cur.execute("DROP INDEX IF EXISTS agent_message_log_created")
    cur.execute(
        "CREATE INDEX agent_message_log_created ON agent_message_log (created_at, seq)"
    )


def _add_agent_keys(cur: sqlite3.Cursor) -> None:
    """v3: which CLI vendor each side of a message is.

    Rows written before these columns existed keep NULL — the log panel shows a
    handle with no vendor rather than guessing one, because a pane can be
    rebuilt onto a different CLI and the registry only knows what is running
    now, not what sent the message back then.
    """
    cur.execute("ALTER TABLE agent_message_log ADD COLUMN sender_agent TEXT")
    cur.execute("ALTER TABLE agent_message_log ADD COLUMN recipient_agent TEXT")


def _add_kind(cur: sqlite3.Cursor) -> None:
    """v4: who authored a message — Navide itself, or an agent.

    Rows written before this column keep NULL, which reads as "an ordinary
    message". That is right for every one of them: the only kind is the
    delivery-failure notice, which did not exist when they were written.
    """
    cur.execute("ALTER TABLE agent_message_log ADD COLUMN kind TEXT")


def _clamp_content(content: str) -> str:
    if len(content) <= MAX_CONTENT_CHARS:
        return content
    keep = MAX_CONTENT_CHARS - len(_TRUNCATION_MARKER)
    return content[:keep] + _TRUNCATION_MARKER


def _coerce_status(value: Any) -> str:
    text = str(value)
    return text if text in _STATUSES else "failed"


def _coerce_kind(value: Any) -> str | None:
    """Only a kind this app writes survives; anything else stores as NULL.

    The panel reads this to decide what a row *is* (it suppresses Resend on a
    notice), so an unrecognized value must degrade to "ordinary message" rather
    than reach the UI.
    """
    if value is None:
        return None
    text = str(value)
    return text if text in _KINDS else None


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        # OverflowError: json.loads accepts the non-standard `Infinity`
        # literal, and int(inf) raises.
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
        "sender_agent": _optional_text(row.get("sender_agent")),
        "recipient_agent": _optional_text(row.get("recipient_agent")),
        "kind": _coerce_kind(row.get("kind")),
    }


def _safe_normalize(row: Any) -> dict[str, Any] | None:
    """``_normalize`` that can never take the rest of the batch down."""
    try:
        return _normalize(row)
    except Exception as err:  # one hostile value must skip only its own row
        log.warning("agent message log row skipped: %s", err)
        return None


class AgentMessageLog:
    """Thread-safe append-only message log backed only by the database."""

    def __init__(self, db: Database) -> None:
        self._lock = RLock()
        self._db = db
        self._db.migrate(_COMPONENT, 1, _create_schema)
        self._db.migrate(_COMPONENT, 2, _add_seq)
        self._db.migrate(_COMPONENT, 3, _add_agent_keys)
        self._db.migrate(_COMPONENT, 4, _add_kind)
        self._seq = self._read_max_seq()

    def _read_max_seq(self) -> int:
        try:
            with self._db.transaction() as cur:
                row = cur.execute(
                    "SELECT MAX(seq) AS n FROM agent_message_log"
                ).fetchone()
        except sqlite3.Error as err:
            log.warning("agent message log seq seed failed: %s", err)
            return 0
        return int(row["n"] or 0) if row is not None else 0

    # ───────────────────────── Writing ──────────────────────────────
    def append(self, rows: list[dict[str, Any]]) -> int:
        """Persist a batch of rows; returns how many were written.

        Unusable rows are skipped, a uid repeated inside the batch keeps only
        its last occurrence, and anything beyond ``MAX_APPEND_ROWS`` is
        dropped. A failed write is logged and 0 is returned — nothing was
        persisted, and ``tail()`` will say so.
        """
        rows = list(rows or [])
        if len(rows) > MAX_APPEND_ROWS:
            log.warning(
                "agent message log batch of %d rows truncated to %d",
                len(rows),
                MAX_APPEND_ROWS,
            )
            rows = rows[-MAX_APPEND_ROWS:]  # the newest are the ones kept anyway
        # dict keyed by uid: a duplicate inside one batch would otherwise be
        # inserted twice, with the later status lost to the upsert.
        clean: dict[str, dict[str, Any]] = {}
        for row in rows:
            normalized = _safe_normalize(row)
            if normalized is not None:
                clean[normalized["uid"]] = normalized
        if not clean:
            return 0
        with self._lock:
            seq = self._seq
            values = []
            for row in clean.values():
                seq += 1
                values.append(tuple(row[col] for col in _COLUMNS) + (seq,))
            try:
                with self._db.transaction() as cur:
                    cur.executemany(
                        "INSERT INTO agent_message_log"
                        f" ({', '.join(_COLUMNS)}, seq)"
                        f" VALUES ({', '.join('?' * (len(_COLUMNS) + 1))})"
                        f" ON CONFLICT(uid) DO UPDATE SET {_CONFLICT_UPDATE}",
                        values,
                    )
                    cur.execute(
                        "DELETE FROM agent_message_log WHERE uid NOT IN"
                        " (SELECT uid FROM agent_message_log"
                        "  ORDER BY created_at DESC, seq DESC LIMIT ?)",
                        (MAX_ROWS,),
                    )
            except sqlite3.Error as err:
                log.warning("agent message log append failed: %s", err)
                return 0
            self._seq = seq
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
    def pending_incoming(self, recipient: str, limit: int = MAX_ROWS) -> list[dict[str, Any]]:
        """Messages addressed to `recipient` that have not been delivered yet.

        The recipient's view of the queue, which nothing else here offers: every
        other read is the sender's. An agent deep in its own work is exactly the
        one that cannot be typed into, so "is anything waiting for me?" had no
        answer at all — the queue itself lives in the receiving window's memory,
        and this table was only ever read back as one flat tail.

        Matched on the recipient's messaging name, which is what the renderer
        wrote: a pane renamed since a message was queued stops matching it, and
        reports nothing rather than someone else's mail.

        "delivering" counts as pending on purpose — it means the injection is in
        flight, not that it landed.
        """
        recipient = str(recipient or "")
        if not recipient:
            return []
        limit = max(1, min(int(limit), MAX_ROWS))
        with self._lock:
            try:
                with self._db.transaction() as cur:
                    found = cur.execute(
                        f"SELECT {', '.join(_COLUMNS)} FROM agent_message_log"
                        " WHERE recipient = ? AND status IN ('queued', 'delivering')"
                        " ORDER BY created_at DESC, seq DESC LIMIT ?",
                        (recipient, limit),
                    ).fetchall()
            except sqlite3.Error as err:
                log.warning("agent message log pending read failed: %s", err)
                return []
        return [dict(row) for row in reversed(found)]

    def tail(self, limit: int = MAX_ROWS) -> list[dict[str, Any]]:
        """The most recent rows, newest last — the renderer's array order.

        Always a database read: this store exists to survive restarts, so a
        read must never report anything but what is actually persisted.
        """
        limit = max(1, min(int(limit), MAX_ROWS))
        with self._lock:
            try:
                with self._db.transaction() as cur:
                    found = cur.execute(
                        f"SELECT {', '.join(_COLUMNS)} FROM agent_message_log"
                        " ORDER BY created_at DESC, seq DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
            except sqlite3.Error as err:
                log.warning("agent message log read failed: %s", err)
                return []
        return [dict(row) for row in reversed(found)]
