"""OpenCode CLI conversation reader.

Storage: ONE shared SQLite database (WAL journal) holding all projects and
sessions — <XDG_DATA_HOME|~/.local/share>/opencode/opencode.db:

  session   id (`ses_…`), project_id, parent_id (non-NULL = subagent child
            session), directory (the session's cwd), token totals
  message   id (`msg_…`), session_id, data = message JSON. Assistant data
            carries tokens {input, output, reasoning, cache{read,write}},
            modelID and time {created, completed}; rows are UPDATEd in place
            while a turn streams, so tokens are only credited once
            time.completed lands.
  part      message content blocks; user input text is stored verbatim in
            data ({"type":"text","text":…}) — the `at-pane:` marker lives here.

Responsibilities:
  • parse_session_file()/parse_incremental(): completed assistant messages →
    TokenUsage (cache folded into input, reasoning into output). cwd is the
    session's `directory` so Attribution's workspace gate matches the pane cwd.
  • find_sessions_by_marker(): resolve `at-pane:<paneId>` kickoff markers to
    (session_id, directory) by scanning user-message text parts of top-level
    sessions (subagent child sessions are excluded) — used by Attribution to
    emit session.detected (resume id = session.id, `opencode --session <id>`).

Concurrency: the opencode process owns the WAL writer, so every connection
here is read-only (`file:…?mode=ro` URI), short-lived, and busy/locked-
tolerant — any sqlite error is treated as "no new data this cycle". A missing
db just means the CLI isn't installed → silently skip.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from collections.abc import Iterable
from dataclasses import replace
from pathlib import Path

from .base import IncrementalParseResult, LogReader, TokenUsage

log = logging.getLogger("agent_team_backend.log_readers.opencode")

_DB_NAME = "opencode.db"

# Row-fetch busy wait: long enough to ride out an opencode write transaction,
# short enough not to stall the watcher's drain thread.
_BUSY_TIMEOUT_MS = 250

# In-flight (not yet completed) assistant rows re-checked on later cycles.
# Bounded so the compact checkpoint stays compact; rows abandoned mid-stream
# (CLI crash) eventually fall off the front.
_PENDING_CAP = 64

# message.id is a text key, so incremental parsing watermarks on the table's
# implicit rowid (monotonic per INSERT; UPDATEs keep it stable).
_USAGE_SQL = """
SELECT m.rowid, m.id, m.session_id, m.data, COALESCE(s.directory, '')
FROM message m
JOIN session s ON s.id = m.session_id
{where}
ORDER BY m.rowid
"""

# Markers are typed by the user, so they live in text parts of user messages.
# parent_id IS NULL keeps subagent child sessions out — a marker forwarded
# into a subagent prompt must not bind the child id (it can't be resumed as
# the pane's session).
_MARKER_SQL = """
SELECT p.session_id, p.data, m.data, COALESCE(s.directory, '')
FROM part p
JOIN message m ON m.id = p.message_id
JOIN session s ON s.id = p.session_id
WHERE p.data LIKE '%at-pane:%' AND s.parent_id IS NULL
ORDER BY p.time_created
"""


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _data_dir(app_dir: str) -> Path:
    env = os.environ.get("XDG_DATA_HOME")
    base = Path(env) if env else Path.home() / ".local" / "share"
    return base / app_dir


def _tokens_from_data(data: dict) -> tuple[int, int]:
    """(input, output) with cache reads/writes folded into input and
    reasoning folded into output (per TokenUsage design)."""
    tokens = data.get("tokens")
    if not isinstance(tokens, dict):
        return 0, 0
    cache = tokens.get("cache")
    if not isinstance(cache, dict):
        cache = {}
    input_tokens = (
        _int(tokens.get("input")) + _int(cache.get("read")) + _int(cache.get("write"))
    )
    output_tokens = _int(tokens.get("output")) + _int(tokens.get("reasoning"))
    return input_tokens, output_tokens


def _completed_ms(data: dict) -> int:
    """time.completed (epoch ms) of an assistant message; 0 while streaming."""
    t = data.get("time")
    return _int(t.get("completed")) if isinstance(t, dict) else 0


class OpencodeLogReader(LogReader):
    vendor: str = "opencode"
    # Kilo Code is an OpenCode fork with the same schema — KiloLogReader
    # subclasses this reader and overrides only these location attributes.
    _dir_name: str = "opencode"
    _db_name: str = _DB_NAME

    def _opencode_dirs(self) -> list[Path]:
        """The single shared data dir (as a list for callers that iterate it)."""
        return [_data_dir(self._dir_name)]

    def _db_paths(self) -> list[Path]:
        return [d / self._db_name for d in self._opencode_dirs()]

    def project_dirs(self) -> list[Path]:
        return [d for d in self._opencode_dirs() if d.is_dir()]

    def session_files(self) -> list[Path]:
        return [db for db in self._db_paths() if db.is_file()]

    def session_id_from_path(self, path: Path) -> str:
        """Only the shared db is a session source. Sibling files under the
        data dir (auth.json, legacy storage/*.json) must not coin bogus ids
        or trigger pointless marker scans."""
        if path.name != self._db_name:
            return ""
        return path.stem

    def has_session(self, session_id: str) -> bool:
        """True if the shared db knows this session id. The resume preflight
        uses this so a stale persisted id fails preflight instead of
        launching a doomed `opencode --session <id>`."""
        session_id = session_id.strip()
        if not session_id:
            return False
        for db in self._db_paths():
            if not db.is_file():
                continue
            rows = self._query(
                db, "SELECT 1 FROM session WHERE id = ?", (session_id,)
            )
            if rows:
                return True
        return False

    def _query(
        self, path: Path, sql: str, params: tuple = ()
    ) -> list[tuple] | None:
        """Short-lived read-only query. None = db unreadable this cycle
        (missing / busy / locked / mid-write) — callers treat it as no data."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
                return con.execute(sql, params).fetchall()
            finally:
                con.close()
        except (sqlite3.Error, OSError) as err:
            log.debug("sqlite read %s failed: %s", path, err)
            return None

    def _event_from_row(
        self, path: Path, row: tuple
    ) -> tuple[TokenUsage | None, bool]:
        """(event, done) for one message row. done=False means the row is a
        still-streaming assistant message — retry it on a later cycle."""
        _row_id, message_id, session_id, data_json, directory = row
        try:
            data = json.loads(str(data_json or ""))
        except json.JSONDecodeError:
            data = None
        if not isinstance(data, dict) or data.get("role") != "assistant":
            return None, True
        completed = _completed_ms(data)
        if not completed:
            return None, False
        input_tokens, output_tokens = _tokens_from_data(data)
        if input_tokens == 0 and output_tokens == 0:
            return None, True
        return TokenUsage(
            vendor=self.vendor,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cwd=str(directory or ""),
            session_id=str(session_id or ""),
            file_path=str(path),
            dedup_key=f"msg:{message_id}",
            timestamp=str(completed),
            model=str(data.get("modelID") or ""),
        ), True

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        # The watcher routes every .json/.db under the data dir here (e.g.
        # auth.json, legacy storage/); only the shared db carries sessions.
        if path.name != self._db_name:
            return []
        rows = self._query(path, _USAGE_SQL.format(where=""))
        if rows is None:
            return []
        out: list[TokenUsage] = []
        for row in rows:
            key = f"msg:{row[1]}"
            if key in seen_keys:
                continue
            event, done = self._event_from_row(path, row)
            if not done:
                continue  # still streaming — not marked seen, retried next cycle
            seen_keys.add(key)
            if event is not None:
                out.append(event)
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        if path.name != self._db_name:
            return IncrementalParseResult([], dict(checkpoint))
        try:
            stat = path.stat()
        except OSError:
            return IncrementalParseResult([], dict(checkpoint))
        identity = f"{stat.st_dev}:{stat.st_ino}"
        replaced = bool(checkpoint.get("identity") and checkpoint.get("identity") != identity)
        last_row_id = 0 if replaced else max(0, int(checkpoint.get("row_id") or 0))
        pending: set[int] = (
            set()
            if replaced
            else {int(r) for r in (checkpoint.get("pending") or []) if int(r) > 0}
        )

        def _where(watermark: int, pend: set[int]) -> str:
            clause = f"WHERE m.rowid > {watermark}"
            if pend:
                clause += f" OR m.rowid IN ({','.join(str(r) for r in sorted(pend))})"
            return clause

        rows = self._query(path, _USAGE_SQL.format(where=_where(last_row_id, pending)))
        if rows is None:
            return IncrementalParseResult([], dict(checkpoint))
        if not rows and last_row_id:
            max_rows = self._query(path, "SELECT COALESCE(MAX(rowid), 0) FROM message")
            max_row_id = int(max_rows[0][0]) if max_rows else last_row_id
            if max_row_id < last_row_id:
                last_row_id = 0
                pending = set()
                rows = self._query(path, _USAGE_SQL.format(where=_where(0, set())))
                if rows is None:
                    return IncrementalParseResult([], dict(checkpoint))

        out: list[TokenUsage] = []
        next_row_id = last_row_id

        def _cursor() -> dict:
            trimmed = sorted(pending)[-_PENDING_CAP:]
            return {
                "kind": "sqlite",
                "row_id": next_row_id,
                "pending": trimmed,
                "identity": identity,
            }

        for row in rows:
            row_id = int(row[0])
            next_row_id = max(next_row_id, row_id)
            event, done = self._event_from_row(path, row)
            if not done:
                pending.add(row_id)  # streaming assistant row — recheck later
                continue
            pending.discard(row_id)
            if event is None:
                continue
            out.append(replace(event, checkpoint=_cursor()))
        return IncrementalParseResult(out, _cursor())

    def find_sessions_by_marker(
        self, markers: Iterable[str]
    ) -> dict[str, tuple[str, str]]:
        """marker → (session_id, session directory) for kickoff markers found
        in user-message text parts of top-level sessions. Earliest match wins
        per marker. Empty dict when nothing matches or the db is unreadable
        this cycle."""
        wanted = [m for m in markers if m]
        if not wanted:
            return {}
        found: dict[str, tuple[str, str]] = {}
        for db in self._db_paths():
            if not db.is_file():
                continue
            rows = self._query(db, _MARKER_SQL)
            if rows is None:
                continue
            for session_id, part_json, message_json, directory in rows:
                try:
                    message = json.loads(str(message_json or ""))
                except json.JSONDecodeError:
                    continue
                if not isinstance(message, dict) or message.get("role") != "user":
                    continue
                text = str(part_json or "")
                for marker in wanted:
                    if marker not in found and marker in text:
                        found[marker] = (str(session_id or ""), str(directory or ""))
        return found
