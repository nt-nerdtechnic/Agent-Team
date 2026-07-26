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

import logging
import sqlite3
from collections.abc import Iterable
from pathlib import Path

from ..profiles_store import profile_config_homes
from .base import IncrementalParseResult, LogReader, TokenUsage

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
        """The default ``.grok`` dir plus each managed profile's shim
        ``<home>/.grok``.

        A regular grok pane on a managed account runs with HOME pointed at that
        account's persistent isolated home (the HOME shim), so its ENTIRELY
        separate grok.db lives inside the shim's ``.grok`` — the default
        ~/.grok never sees those sessions. With no profile home the list is
        exactly [~/.grok]."""
        dirs: list[Path] = [Path.home() / ".grok"]
        for home in profile_config_homes("grok"):
            dirs.append(home / ".grok")
        return dirs

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
        # A profile pane's session lives in its own shim db, so scan the default
        # db AND every active profile db; first match across them wins.
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
