"""Append-only pipeline history (timeline) per run.

Events live in the workspace database's ``history_events`` table, one row per
event, partitioned by ``run_dir`` (``""`` = the workspace-level timeline,
``runs/<name>`` = a pipeline run). The table is append-only: fast INSERTs, a
complete audit trail, and ``tail()`` is one indexed query. A small in-memory
tail buffer per run backs instant reads and WS broadcasts.

Legacy ``history.jsonl`` files (workspace root and per run dir) are imported
on first access of their run and renamed ``history.jsonl.migrated-v1``.

The bulk of events arrive as freeform orchestrator log lines from the frontend
(`project.log_event`); `classify_orchestrator_line()` derives a structured
`type` + clean `summary` from the stable emoji/keyword conventions the
orchestrator already uses, so no frontend changes are required for v1.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from .db import DB_FILENAME, Database, WorkspaceDatabases
from .projects import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.history")

HISTORY_FILE = "history.jsonl"  # legacy JSONL name, still used for import
TAIL_LIMIT = 500  # in-memory ring buffer size per run

_COMPONENT = "history_events"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _create_history_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE history_events ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " run_dir TEXT NOT NULL DEFAULT '',"
        " ts TEXT NOT NULL,"
        " type TEXT NOT NULL,"
        " event TEXT NOT NULL)"
    )
    cur.execute(
        "CREATE INDEX history_events_run ON history_events (run_dir, id)"
    )


def _parse_jsonl(text: str) -> list[dict[str, Any]]:
    """Parse legacy JSONL tolerantly: skip blank and torn/corrupt lines."""
    events: list[dict[str, Any]] = []
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue  # skip a torn line
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


# ── Orchestrator-line classification ────────────────────────────────────────
# The frontend emits timestamped lines like "[3:02:42 AM] Stage 02 ▶ activate
# 1 slot(s)". We strip the leading "[time] " and map the well-known prefixes to
# a structured event type. Order matters — first match wins.
_TIME_PREFIX_RE = re.compile(r"^\[[^\]]*\]\s*")

_LINE_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"🎉|Pipeline completed"), "pipeline_complete"),
    (re.compile(r"sentinel detected|✓ sentinel"), "sentinel_detected"),
    (re.compile(r"analyzer says complete|完成已確認|turn_complete \+ clean"), "stage_completed"),
    (re.compile(r"completion 待確認|完成取消"), "analyzer_result"),
    (re.compile(r"🧠|asking analyzer|intent="), "analyzer_result"),
    (re.compile(r"🔀|handoff|context_handoff|Handoff"), "context_handoff"),
    (re.compile(r"🎯|Manager|DISPATCH|ASK FROM|REPORT FROM"), "manager"),
    (re.compile(r"❓|question|問題"), "question_detected"),
    (re.compile(r"↩|answered|已回答"), "question_answered"),
    (re.compile(r"🤖|auto-?answer|自動回答"), "question_auto_answered"),
    (re.compile(r"▶ activate|watcher armed"), "stage_advance"),
    (re.compile(r"pre-spawn|pane_spawn|injecting role|injecting kickoff|kickoff sent|role prompt sent"), "pane_spawn"),
    (re.compile(r"⏰|idle|hard cap|stall|stalled|卡住"), "stage_stalled"),
    (re.compile(r"⚠|error|failed|錯誤"), "warning"),
]


def classify_orchestrator_line(line: str) -> tuple[str, str]:
    """Return (event_type, summary) for a freeform orchestrator log line."""
    summary = _TIME_PREFIX_RE.sub("", line or "").strip()
    for pat, etype in _LINE_RULES:
        if pat.search(summary):
            return etype, summary
    return "log", summary


def _extract_stage_id(summary: str) -> str | None:
    m = re.search(r"\bStage\s+(\d{1,2})\b", summary)
    return m.group(1) if m else None


class HistoryStore:
    """Thread-safe append-only history with per-run in-memory tail buffers."""

    def __init__(self, databases: WorkspaceDatabases | None = None) -> None:
        self._lock = RLock()
        self._databases = databases or WorkspaceDatabases()
        # key: (canonical workspace, run_dir) → ring buffer of recent events
        self._tails: dict[tuple[str, str], deque[dict[str, Any]]] = {}
        # db paths whose history_events schema is already ensured
        self._migrated: set[str] = set()

    # ───────────────────────── Paths ────────────────────────────────
    def _legacy_path(self, workspace_path: str, run_dir: str) -> Path:
        base = Path(workspace_path) / PROJECT_DIR_NAME
        return (base / run_dir / HISTORY_FILE) if run_dir else (base / HISTORY_FILE)

    def path_str(self, workspace_path: str, run_dir: str) -> str:
        """Where the events live now: the workspace database file."""
        return str(Path(workspace_path) / PROJECT_DIR_NAME / DB_FILENAME)

    def _tail_key(self, workspace_path: str, run_dir: str) -> tuple[str, str]:
        return (os.path.realpath(os.path.abspath(workspace_path)), run_dir)

    # ───────────────────────── Database plumbing ─────────────────────
    def _db(self, workspace_path: str, run_dir: str, *, create: bool) -> Database | None:
        """The workspace db; read paths only materialize it for a legacy import."""
        if create:
            db = self._databases.get(workspace_path)
        else:
            db = self._databases.peek(workspace_path)
            if db is None and self._legacy_path(workspace_path, run_dir).exists():
                db = self._databases.get(workspace_path)
        if db is None:
            return None
        self._ensure_ready(db, workspace_path, run_dir)
        return db

    def _ensure_ready(self, db: Database, workspace_path: str, run_dir: str) -> None:
        """Create the table and run this run's one-time legacy JSONL import."""
        key = str(db.path)
        if key not in self._migrated:
            db.migrate(_COMPONENT, 1, _create_history_schema)
            self._migrated.add(key)

        def load(cur: sqlite3.Cursor, events: Any) -> None:
            for event in events:
                cur.execute(
                    "INSERT INTO history_events (run_dir, ts, type, event)"
                    " VALUES (?, ?, ?, ?)",
                    (
                        run_dir,
                        str(event.get("ts", "")),
                        str(event.get("type", "log")),
                        json.dumps(event, ensure_ascii=False),
                    ),
                )

        # merge=load: legacy-writer coexistence. A JSONL regenerated by an
        # older app version after the import holds only events recorded since
        # the migration, so appending every line as a new row is safe (the
        # table is append-only and the rows cannot overlap imported data).
        db.import_json(
            f"history:{run_dir}",
            self._legacy_path(workspace_path, run_dir),
            load,
            parse=_parse_jsonl,
            merge=load,
        )

    # ───────────────────────── Recording ────────────────────────────
    def record(
        self,
        workspace_path: str,
        *,
        run_dir: str = "",
        type: str,
        summary: str,
        run_id: str = "",
        stage_id: str | None = None,
        pane_id: str | None = None,
        vendor: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append one HistoryEvent and return it (for WS broadcast)."""
        event: dict[str, Any] = {
            "id": uuid.uuid4().hex,
            "ts": _now_iso(),
            "run_id": run_id or run_dir,
            "type": type,
            "summary": summary,
        }
        if stage_id:
            event["stage_id"] = stage_id
        if pane_id:
            event["pane_id"] = pane_id
        if vendor:
            event["vendor"] = vendor
        if detail:
            event["detail"] = detail

        key = self._tail_key(workspace_path, run_dir)
        with self._lock:
            buf = self._tails.get(key)
            if buf is None:
                buf = deque(maxlen=TAIL_LIMIT)
                self._tails[key] = buf
            buf.append(event)
            try:
                db = self._db(workspace_path, run_dir, create=True)
                if db is None:
                    log.warning(
                        "history append failed: workspace %s is not a directory",
                        workspace_path,
                    )
                    return event
                with db.transaction() as cur:
                    cur.execute(
                        "INSERT INTO history_events (run_dir, ts, type, event)"
                        " VALUES (?, ?, ?, ?)",
                        (run_dir, event["ts"], event["type"],
                         json.dumps(event, ensure_ascii=False)),
                    )
            except sqlite3.Error as err:
                # Same degradation as the old JSONL append: the event stays
                # in the in-memory tail and the write failure is only logged.
                log.warning(
                    "history append failed for %s: %s", workspace_path, err
                )
        return event

    def record_line(
        self,
        workspace_path: str,
        line: str,
        *,
        run_dir: str = "",
        run_id: str = "",
        pane_id: str | None = None,
        vendor: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Classify a freeform orchestrator log line and record it."""
        etype, summary = classify_orchestrator_line(line)
        return self.record(
            workspace_path,
            run_dir=run_dir,
            type=etype,
            summary=summary,
            run_id=run_id,
            stage_id=_extract_stage_id(summary),
            pane_id=pane_id,
            vendor=vendor,
            detail=detail,
        )

    # ───────────────────────── Reading ──────────────────────────────
    def tail(
        self, workspace_path: str, run_dir: str = "", limit: int = TAIL_LIMIT
    ) -> list[dict[str, Any]]:
        """Return the most recent `limit` events, newest last.

        Serves from the in-memory ring buffer when warm, otherwise queries the
        run's newest rows from the workspace database.
        """
        key = self._tail_key(workspace_path, run_dir)
        with self._lock:
            buf = self._tails.get(key)
            if buf is not None and len(buf) > 0:
                items = list(buf)
                return items[-limit:]
        # Cold read from the database (imports the legacy JSONL if present).
        db = self._db(workspace_path, run_dir, create=False)
        if db is None:
            return []
        fetch = max(limit, TAIL_LIMIT)
        try:
            with db.transaction() as cur:
                rows = cur.execute(
                    "SELECT event FROM history_events WHERE run_dir = ?"
                    " ORDER BY id DESC LIMIT ?",
                    (run_dir, fetch),
                ).fetchall()
        except sqlite3.Error as err:
            log.warning("history read failed for %s: %s", workspace_path, err)
            return []
        events: list[dict[str, Any]] = []
        for row in reversed(rows):
            try:
                parsed = json.loads(row["event"])
            except ValueError:
                continue  # skip a corrupt row
            if isinstance(parsed, dict):
                events.append(parsed)
        # Warm the buffer for next time — only if record() hasn't already
        # populated it while we held no lock during the cold read.
        with self._lock:
            if self._tails.get(key) is None:
                self._tails[key] = deque(events[-TAIL_LIMIT:], maxlen=TAIL_LIMIT)
        return events[-limit:]

    def snapshot(
        self, workspace_path: str, run_dir: str = "", limit: int = TAIL_LIMIT
    ) -> dict[str, Any]:
        return {
            "workspace_path": workspace_path or "",
            "run_dir": run_dir,
            "path": self.path_str(workspace_path, run_dir),
            "events": self.tail(workspace_path, run_dir, limit),
        }
