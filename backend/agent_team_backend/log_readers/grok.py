"""Grok CLI (superagent-ai grok-cli) conversation reader.

Storage: ONE shared SQLite database ~/.grok/grok.db (WAL journal) holding all
workspaces and sessions — unlike the per-session files of the other vendors:

  workspaces   id = sha1(scope_key)[:16]; scope_key = git root | canonical cwd
  sessions     id = uuid-hex[:12], keyed to a workspace
  messages     message_json stores the user's text verbatim (marker lives here)
  usage_events per-turn input/output/total tokens, model, session_id

Responsibilities:
  • parse_session_file(): new `usage_events` rows → TokenUsage, deduped by the
    autoincrement row id via seen_keys. cwd is the session's workspace
    scope_key so Attribution's workspace gate matches the pane's cwd.
  • find_sessions_by_marker(): resolve `at-pane:<paneId>` kickoff markers to
    (session_id, workspace_root) by scanning messages.message_json — used by
    Attribution to emit session.detected (resume id = sessions.id, `grok -s`).

Concurrency: the grok process owns the WAL writer, so every connection here is
read-only (`file:…?mode=ro` URI), short-lived, and busy/locked-tolerant — any
sqlite error is treated as "no new data this cycle". A missing db just means
the CLI isn't installed → silently skip.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path

from .base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    join_text_blocks,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.grok")

_DB_NAME = "grok.db"

# Row-fetch busy wait: long enough to ride out a grok write transaction,
# short enough not to stall the watcher's drain thread.
_BUSY_TIMEOUT_MS = 250

_USAGE_SQL = """
SELECT u.id, u.session_id, u.model, u.input_tokens, u.output_tokens,
       u.created_at, COALESCE(w.scope_key, '')
FROM usage_events u
JOIN sessions s ON s.id = u.session_id
LEFT JOIN workspaces w ON w.id = s.workspace_id
ORDER BY u.id
"""

_MARKER_SQL = """
SELECT m.session_id, m.message_json, COALESCE(w.scope_key, '')
FROM messages m
JOIN sessions s ON s.id = m.session_id
LEFT JOIN workspaces w ON w.id = s.workspace_id
WHERE m.message_json LIKE '%at-pane:%'
ORDER BY m.created_at, m.seq
"""

_ACTIVITY_SQL = """
SELECT m.session_id, m.seq, m.role, m.message_json, m.created_at,
       COALESCE(w.scope_key, '')
FROM messages m
JOIN sessions s ON s.id = m.session_id
LEFT JOIN workspaces w ON w.id = s.workspace_id
ORDER BY m.session_id, m.seq
"""

# Grok writes no end-of-turn record, so a turn is closed either by the next
# user message or — for the latest turn — once that session has been quiet for
# _TURN_IDLE_SECONDS. Quiet is measured from the session's own last message,
# not the file: one database holds EVERY session, so a busy pane would
# otherwise keep every other pane's turn open forever.
_TURN_IDLE_SECONDS = 8.0
_STATE_PREFIX = "grok_turn::"
_TEXT_PREFIX = "grok_text::"
_TEXT_MAX_CHARS = 4_000


def _cap_text(text: str) -> str:
    if len(text) <= _TEXT_MAX_CHARS:
        return text
    half = _TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _epoch(created_at: str) -> float:
    """Epoch seconds from grok's ISO timestamp (0.0 when unparseable)."""
    raw = str(created_at or "").strip()
    if not raw:
        return 0.0
    if raw.endswith("Z"):
        raw = f"{raw[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _message_text(message_json: str) -> str:
    """Visible text of a stored message (content is a string or text blocks)."""
    try:
        msg = json.loads(message_json or "")
    except (json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(msg, dict):
        return ""
    return join_text_blocks(msg.get("content"), "text")


def _read_map(seen_keys: set[str], prefix: str) -> dict:
    """The per-session sentinel map persisted inside seen_keys."""
    for k in seen_keys:
        if k.startswith(prefix):
            try:
                val = json.loads(k[len(prefix):])
            except json.JSONDecodeError:
                return {}
            return val if isinstance(val, dict) else {}
    return {}


def _write_map(seen_keys: set[str], prefix: str, value: dict) -> None:
    seen_keys.difference_update({k for k in seen_keys if k.startswith(prefix)})
    if value:
        seen_keys.add(f"{prefix}{json.dumps(value, sort_keys=True)}")


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


class GrokLogReader(LogReader):
    vendor: str = "grok"

    def _db_path(self) -> Path:
        return Path.home() / ".grok" / _DB_NAME

    def _grok_dirs(self) -> list[Path]:
        """The single default ``~/.grok`` dir (as a list for callers that
        iterate it).

        A managed grok pane runs under a HOME shim, but the shim's
        ``.grok/grok.db`` is symlinked back to the real ``~/.grok``
        (credential_vault), so every account's sessions live in this one
        database — no separate shim ``.grok`` scan is needed."""
        return [Path.home() / ".grok"]

    def _db_paths(self) -> list[Path]:
        return [d / _DB_NAME for d in self._grok_dirs()]

    def project_dirs(self) -> list[Path]:
        return [d for d in self._grok_dirs() if d.is_dir()]

    def session_files(self) -> list[Path]:
        return [db for db in self._db_paths() if db.is_file()]

    def _query(self, path: Path, sql: str) -> list[tuple] | None:
        """Short-lived read-only query. None = db unreadable this cycle
        (missing / busy / locked / mid-write) — callers treat it as no data."""
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

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        # The watcher routes every .json/.db under ~/.grok here (e.g.
        # user-settings.json); only the session db carries usage events.
        if path.name != _DB_NAME:
            return []
        rows = self._query(path, _USAGE_SQL)
        if rows is None:
            return []
        out: list[TokenUsage] = []
        for row_id, session_id, model, inp, outp, created_at, ws_root in rows:
            key = f"usage:{row_id}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            input_tokens = _int(inp)
            output_tokens = _int(outp)
            if input_tokens == 0 and output_tokens == 0:
                continue  # marked seen, nothing to credit
            out.append(TokenUsage(
                vendor="grok",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=str(ws_root or ""),
                session_id=str(session_id or ""),
                file_path=str(path),
                dedup_key=key,
                timestamp=str(created_at or ""),
                model=str(model or ""),
            ))
        return out

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` per message and `turn_complete` per user turn.

        Grok stores no end-of-turn record, so the boundary is inferred: the
        next user message closes the previous turn, and the newest turn of a
        session is flushed once that session has been quiet for
        _TURN_IDLE_SECONDS. turn_complete carries the assistant's closing text,
        which is what lets a Grok pane send inter-CLI messages — the frontend
        only parses the ---MSG-START--- protocol out of a turn_complete that
        has text.

        State is keyed by session because one database holds every session;
        the same reason the idle test uses each session's own last message
        rather than the file's mtime.
        """
        if path.name != _DB_NAME:
            return []
        rows = self._query(path, _ACTIVITY_SQL)
        if rows is None:
            return []

        out: list[ActivityEvent] = []
        states = _read_map(seen_keys, _STATE_PREFIX)
        texts = _read_map(seen_keys, _TEXT_PREFIX)
        last_seen_at: dict[str, float] = {}
        cwds: dict[str, str] = {}

        def _complete(sid: str, state: dict, detail: str) -> ActivityEvent:
            # The turn's own last message supplies the timestamp. It must be a
            # real one: the frontend dedups messaging turns by timestamp and
            # treats an unparseable one as always-fresh, which would resend a
            # turn delivered twice and replay history after a backend restart.
            return ActivityEvent(
                vendor="grok", event_type="turn_complete",
                cwd=cwds.get(sid, ""), session_id=sid, file_path=str(path),
                dedup_key=f"turn:{sid}:{int(state['idx'])}",
                timestamp=str(state.get("ts") or ""), detail=detail,
                text=str(texts.get(sid) or ""),
            )

        for session_id, seq, role, message_json, created_at, ws_root in rows:
            sid = str(session_id or "")
            key = f"act:{sid}:{seq}"
            cwds[sid] = str(ws_root or "")
            last_seen_at[sid] = max(last_seen_at.get(sid, 0.0), _epoch(created_at))
            if key in seen_keys:
                continue
            seen_keys.add(key)
            role_name = str(role or "")
            if role_name not in ("user", "assistant"):
                continue
            state = states.get(sid)
            created = str(created_at or "")
            text = ""
            if role_name == "user":
                if state is not None and not state.get("flushed"):
                    out.append(_complete(sid, state, "boundary"))
                    texts.pop(sid, None)
                idx = (int(state["idx"]) + 1) if state is not None else 0
                states[sid] = {"idx": idx, "flushed": False, "ts": created}
                text = user_prompt_text(_message_text(message_json))
            else:
                if state is None or state.get("flushed"):
                    idx = (int(state["idx"]) + 1) if state is not None else 0
                    states[sid] = {"idx": idx, "flushed": False, "ts": created}
                states[sid]["ts"] = created
                reply = _message_text(message_json).strip()
                if reply:
                    texts[sid] = _cap_text(reply)
            out.append(ActivityEvent(
                vendor="grok", event_type="agent_active",
                cwd=cwds[sid], session_id=sid, file_path=str(path),
                dedup_key=key, timestamp=str(created_at or ""),
                detail=role_name, text=text,
            ))

        # Flush every session whose newest turn has gone quiet on its own.
        now = time.time()
        for sid, state in list(states.items()):
            if state.get("flushed"):
                continue
            seen_at = last_seen_at.get(sid, 0.0)
            if seen_at <= 0.0 or now - seen_at < _TURN_IDLE_SECONDS:
                continue
            out.append(_complete(sid, state, "idle"))
            state["flushed"] = True
            texts.pop(sid, None)

        _write_map(seen_keys, _STATE_PREFIX, states)
        _write_map(seen_keys, _TEXT_PREFIX, texts)
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        if path.name != _DB_NAME:
            return IncrementalParseResult([], dict(checkpoint))
        try:
            stat = path.stat()
        except OSError:
            return IncrementalParseResult([], dict(checkpoint))
        identity = f"{stat.st_dev}:{stat.st_ino}"
        replaced = bool(checkpoint.get("identity") and checkpoint.get("identity") != identity)
        last_row_id = 0 if replaced else max(0, int(checkpoint.get("row_id") or 0))
        rows = self._query(
            path,
            _USAGE_SQL.replace("ORDER BY u.id", f"WHERE u.id > {last_row_id} ORDER BY u.id"),
        )
        if rows is None:
            return IncrementalParseResult([], dict(checkpoint))
        if not rows and last_row_id:
            max_rows = self._query(path, "SELECT COALESCE(MAX(id), 0) FROM usage_events")
            max_row_id = int(max_rows[0][0]) if max_rows else last_row_id
            if max_row_id < last_row_id:
                last_row_id = 0
                rows = self._query(path, _USAGE_SQL)
                if rows is None:
                    return IncrementalParseResult([], dict(checkpoint))
        out: list[TokenUsage] = []
        next_row_id = last_row_id
        for row_id, session_id, model, inp, outp, created_at, ws_root in rows:
            next_row_id = max(next_row_id, int(row_id))
            cursor = {"kind": "sqlite", "row_id": next_row_id, "identity": identity}
            input_tokens = _int(inp)
            output_tokens = _int(outp)
            if input_tokens == 0 and output_tokens == 0:
                continue
            out.append(TokenUsage(
                vendor="grok",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=str(ws_root or ""),
                session_id=str(session_id or ""),
                file_path=str(path),
                dedup_key=f"usage:{row_id}",
                timestamp=str(created_at or ""),
                model=str(model or ""),
                checkpoint=cursor,
            ))
        return IncrementalParseResult(
            out,
            {"kind": "sqlite", "row_id": next_row_id, "identity": identity},
        )

    def find_sessions_by_marker(
        self, markers: Iterable[str]
    ) -> dict[str, tuple[str, str]]:
        """marker → (session_id, workspace_root) for kickoff markers found in
        messages.message_json. Earliest match wins per marker. Empty dict when
        nothing matches or the db is unreadable this cycle."""
        wanted = [m for m in markers if m]
        if not wanted:
            return {}
        # Every account's sessions share the real ~/.grok/grok.db (the shim db
        # is symlinked back), so a single db scan covers them all.
        found: dict[str, tuple[str, str]] = {}
        for db in self._db_paths():
            if not db.is_file():
                continue
            rows = self._query(db, _MARKER_SQL)
            if rows is None:
                continue
            for session_id, message_json, ws_root in rows:
                text = str(message_json or "")
                for marker in wanted:
                    if marker not in found and marker in text:
                        found[marker] = (str(session_id or ""), str(ws_root or ""))
        return found
