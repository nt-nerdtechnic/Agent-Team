"""Backend-owned generic UI settings KV store (renderer localStorage replacement).

Flat JSON object keyed by the legacy localStorage key names (e.g.
"agentTeam.colWidths"). The document of record lives in the shared SQLite
database (kv key ``ui_settings``); the legacy ``ui_settings.json`` is imported
once on first access.

The Electron main process still reads ``ui_settings.json`` synchronously at
startup for the zero-flash theme/language bootstrap (src/main/
ui-settings-bootstrap.ts), so every persisted change also rewrites that file
atomically as a read-only mirror of the kv document.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from .applog import app_data_dir
from .db import DB_FILENAME, Database

log = logging.getLogger("agent_team_backend.ui_settings")

SETTINGS_FILE = "ui_settings.json"
_KV_KEY = "ui_settings"
_MAX_FILE_SIZE = 524_288  # 512 KB sanity cap on the legacy import (matches projects.py)


class UiSettingsStore:
    def __init__(self, path: Path | None = None, db: Database | None = None) -> None:
        self._path = path or (app_data_dir() / SETTINGS_FILE)
        self._db = db or Database(self._path.parent / DB_FILENAME)

    @property
    def path(self) -> Path:
        return self._db.path

    def _import_legacy(self, cur: Any, data: Any) -> None:
        if isinstance(data, dict):
            self._db.kv_set(_KV_KEY, data, now=int(time.time()))

    def get(self) -> dict[str, Any]:
        """Return the full settings dict; {} when missing or corrupt."""
        doc = self._db.kv_get(_KV_KEY)
        if doc is None:
            try:
                if self._path.exists() and self._path.stat().st_size > _MAX_FILE_SIZE:
                    log.warning("legacy ui_settings.json exceeds size limit; not imported")
                    return {}
            except OSError:
                pass
            if self._db.import_json(_KV_KEY, self._path, self._import_legacy):
                doc = self._db.kv_get(_KV_KEY)
                # Recreate the bootstrap mirror the import just retired.
                self._write_mirror(doc if isinstance(doc, dict) else {})
        if not isinstance(doc, dict):
            return {}
        return doc

    def set(self, updates: dict[str, Any]) -> dict[str, Any]:
        """Shallow-merge `updates` into the stored dict and persist.

        A `None` value deletes the key (remove semantics). Non-string keys are
        ignored. Returns the applied delta (suitable for broadcasting); the
        document is only rewritten when the delta is non-empty. An update that
        would grow the merged document past the size cap is rejected whole
        (nothing persisted, empty delta returned).
        """
        current = self.get()
        delta: dict[str, Any] = {}
        for key, value in updates.items():
            if not isinstance(key, str) or not key:
                continue
            if value is None:
                current.pop(key, None)
            else:
                current[key] = value
            delta[key] = value
        if delta:
            payload = json.dumps(current, ensure_ascii=False, separators=(",", ":"))
            if len(payload.encode("utf-8")) > _MAX_FILE_SIZE:
                log.warning(
                    "ui settings update rejected: document would exceed %d bytes",
                    _MAX_FILE_SIZE,
                )
                return {}
            self._db.kv_set(_KV_KEY, current, now=int(time.time()))
            self._write_mirror(current)
        return delta

    def _write_mirror(self, data: dict[str, Any]) -> None:
        """Atomic best-effort rewrite of the Electron bootstrap mirror file."""
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(
                json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            os.replace(tmp, self._path)
        except OSError as err:
            log.warning("ui settings bootstrap mirror write failed: %s", err)
