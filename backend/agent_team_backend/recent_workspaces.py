"""Recent-workspaces registry.

Tracks the workspaces a user has opened so the Welcome screen can offer a
"recent" list (à la VS Code's Open Recent). Persisted as a single JSON file
under the macOS app-data dir. Capped at ``max_size`` entries — the oldest
*unpinned* entry is dropped first; pinned entries never drop.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .applog import app_data_dir
from .db import DB_FILENAME, Database

log = logging.getLogger("agent_team_backend.recent_workspaces")

RECENT_FILE = "recent-workspaces.json"
_KV_KEY = "recent_workspaces"
DEFAULT_MAX_SIZE = 20


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _empty_doc() -> dict[str, Any]:
    return {"version": 1, "recent": [], "max_size": DEFAULT_MAX_SIZE}


class RecentWorkspacesStore:
    def __init__(self, path: Path | None = None, db: Database | None = None) -> None:
        self._path = path or (app_data_dir() / RECENT_FILE)
        self._db = db or Database(self._path.parent / DB_FILENAME)
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._db.path

    def _import_legacy(self, cur: Any, data: Any) -> None:
        if isinstance(data, dict) and isinstance(data.get("recent"), list):
            self._db.kv_set(_KV_KEY, data, now=int(time.time()))
        else:
            log.warning("legacy recent-workspaces.json malformed; starting empty")

    def _read(self) -> dict[str, Any]:
        data = self._db.kv_get(_KV_KEY)
        if data is None:
            self._db.import_json(_KV_KEY, self._path, self._import_legacy)
            data = self._db.kv_get(_KV_KEY)
        if data is None:
            return _empty_doc()
        if not isinstance(data, dict) or not isinstance(data.get("recent"), list):
            log.warning("stored recent-workspaces document malformed; resetting")
            return _empty_doc()
        data.setdefault("version", 1)
        data.setdefault("max_size", DEFAULT_MAX_SIZE)
        return data

    def _write(self, doc: dict[str, Any]) -> None:
        self._db.kv_set(_KV_KEY, doc, now=int(time.time()))

    @staticmethod
    def _normalize(path: str) -> str:
        return os.path.abspath(os.path.expanduser(path))

    def _cap(self, recent: list[dict[str, Any]], max_size: int) -> list[dict[str, Any]]:
        """Drop oldest *unpinned* entries until len <= max_size.

        ``recent`` is assumed to be ordered most-recent-first. Pinned entries
        are kept regardless of position (they never count against the cap by
        being dropped — but they still occupy a slot).
        """
        if len(recent) <= max_size:
            return recent
        pinned = [e for e in recent if e.get("pinned")]
        unpinned = [e for e in recent if not e.get("pinned")]
        keep_unpinned = max(0, max_size - len(pinned))
        unpinned = unpinned[:keep_unpinned]
        # Re-merge preserving original most-recent-first order.
        kept = {id(e) for e in pinned} | {id(e) for e in unpinned}
        return [e for e in recent if id(e) in kept]

    # ---- public API ----

    def list(self) -> list[dict[str, Any]]:
        """Return entries most-recent-first, each annotated with ``exists``.

        ``exists`` reflects whether the folder is still on disk so the UI can
        grey out stale entries without dropping them.
        """
        recent = self._read()["recent"]
        return [{**e, "exists": os.path.isdir(e["path"])} for e in recent]

    def touch(self, path: str, *, state: str = "", task: str = "") -> dict[str, Any]:
        """Record that ``path`` was just opened; move it to the front."""
        norm = self._normalize(path)
        with self._lock:
            doc = self._read()
            recent: list[dict[str, Any]] = doc["recent"]
            now = _now_iso()

            idx = next((i for i, e in enumerate(recent) if e["path"] == norm), -1)
            if idx >= 0:
                entry = recent.pop(idx)
                entry["last_opened_at"] = now
                if state:
                    entry["last_known_state"] = state
                if task:
                    entry["last_known_task"] = task
            else:
                entry = {
                    "path": norm,
                    "name": os.path.basename(norm.rstrip("/")) or norm,
                    "last_opened_at": now,
                    "pinned": False,
                    "last_known_state": state,
                    "last_known_task": task,
                }
            recent.insert(0, entry)
            doc["recent"] = self._cap(recent, doc.get("max_size", DEFAULT_MAX_SIZE))
            self._write(doc)
            return entry

    def pin(self, path: str) -> None:
        self._set_pinned(path, True)

    def unpin(self, path: str) -> None:
        self._set_pinned(path, False)

    def _set_pinned(self, path: str, pinned: bool) -> None:
        norm = self._normalize(path)
        with self._lock:
            doc = self._read()
            for e in doc["recent"]:
                if e["path"] == norm:
                    e["pinned"] = pinned
                    self._write(doc)
                    return
            raise KeyError(f"workspace not in recent list: {norm}")

    def remove(self, path: str) -> None:
        norm = self._normalize(path)
        with self._lock:
            doc = self._read()
            new_recent = [e for e in doc["recent"] if e["path"] != norm]
            if len(new_recent) == len(doc["recent"]):
                raise KeyError(f"workspace not in recent list: {norm}")
            doc["recent"] = new_recent
            self._write(doc)
