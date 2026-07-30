"""Per-workspace AI chat persistence in `<workspace>/.agent-team/navide.db`.

Two whole-document kv entries (the frontend already serializes the full
thread array / notes document):
  - kv "chat_threads"   list of chat thread records
  - kv "chat_notes"     {"notes": str, "notepads": list} (quick notes + named notepads)

Legacy `chat-threads.json` / `chat-notes.json` are imported on first access
and renamed `*.migrated-v1`.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from .db import Database, WorkspaceDatabases
from .projects import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.chat_store")

THREADS_FILE = "chat-threads.json"
NOTES_FILE = "chat-notes.json"
_THREADS_KEY = "chat_threads"
_NOTES_KEY = "chat_notes"
# Chat history was previously bounded by the renderer's localStorage quota
# (~10 MB); 8 MB keeps any real dataset loadable while still rejecting
# runaway/corrupt documents. Enforced symmetrically: an oversize document is
# refused at write time (the old file store only checked on read).
MAX_FILE_BYTES = 8_388_608

NOTES_DEFAULTS: dict[str, Any] = {"notes": "", "notepads": []}


class ChatStore:
    """Whole-document kv storage for chat threads + notes."""

    def __init__(self, databases: WorkspaceDatabases | None = None) -> None:
        self._databases = databases or WorkspaceDatabases()

    def _legacy_file(self, workspace_path: str, name: str) -> Path:
        return Path(os.path.abspath(workspace_path)) / PROJECT_DIR_NAME / name

    @staticmethod
    def _parse_legacy(text: str) -> Any:
        if len(text.encode("utf-8")) > MAX_FILE_BYTES:
            raise ValueError("legacy chat document exceeds size limit")
        return json.loads(text)

    def _import_legacy(self, db: Database, workspace_path: str) -> None:
        """One-time import of both legacy JSON files into the workspace db.

        Runs before every kv read AND write so a first-read import can never
        clobber a document a fresh write already stored.
        """
        for key, name in ((_THREADS_KEY, THREADS_FILE), (_NOTES_KEY, NOTES_FILE)):
            source = self._legacy_file(workspace_path, name)

            def load(cur: Any, data: Any, key: str = key) -> None:
                # kv_set joins the surrounding import transaction (reentrant).
                db.kv_set(key, data, now=int(time.time()))

            def merge(cur: Any, data: Any, key: str = key, source: Path = source) -> None:
                # Legacy-writer coexistence: an older app version regenerated
                # the JSON file after the import. Whole-document store, so
                # last-writer-wins at document granularity: the regenerated
                # file replaces the kv document only when its mtime is newer
                # than the kv row's updated_at.
                try:
                    mtime = source.stat().st_mtime
                except OSError:
                    return
                stamp = db.kv_updated_at(key)
                if stamp is None or mtime > stamp:
                    db.kv_set(key, data, now=int(time.time()))

            db.import_json(
                key,
                source,
                load,
                parse=self._parse_legacy,
                merge=merge,
            )

    def _read(self, workspace_path: str, key: str) -> Any:
        db = self._databases.peek(workspace_path)
        if db is None:
            # No database yet — import only when there is legacy data to move.
            if not (
                self._legacy_file(workspace_path, THREADS_FILE).exists()
                or self._legacy_file(workspace_path, NOTES_FILE).exists()
            ):
                return None
            db = self._databases.get(workspace_path)
            if db is None:
                return None
        self._import_legacy(db, workspace_path)
        return db.kv_get(key)

    def _write(self, workspace_path: str, key: str, doc: Any) -> Path | None:
        db = self._databases.get(workspace_path)
        if db is None:
            return None
        self._import_legacy(db, workspace_path)
        payload = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        if len(payload.encode("utf-8")) > MAX_FILE_BYTES:
            log.warning(
                "refusing to store %s for %s: document exceeds %d bytes",
                key, workspace_path, MAX_FILE_BYTES,
            )
            return None
        db.kv_set(key, doc, now=int(time.time()))
        return db.path

    def get_threads(self, workspace_path: str) -> list[Any]:
        data = self._read(workspace_path, _THREADS_KEY)
        return data if isinstance(data, list) else []

    def set_threads(self, workspace_path: str, threads: list[Any]) -> Path | None:
        return self._write(workspace_path, _THREADS_KEY, list(threads))

    def get_notes(self, workspace_path: str) -> dict[str, Any]:
        data = self._read(workspace_path, _NOTES_KEY)
        if not isinstance(data, dict):
            return dict(NOTES_DEFAULTS)
        notes = data.get("notes")
        notepads = data.get("notepads")
        return {
            "notes": notes if isinstance(notes, str) else "",
            "notepads": notepads if isinstance(notepads, list) else [],
        }

    def set_notes(
        self, workspace_path: str, *, notes: str, notepads: list[Any]
    ) -> Path | None:
        return self._write(
            workspace_path, _NOTES_KEY, {"notes": notes, "notepads": list(notepads)}
        )
