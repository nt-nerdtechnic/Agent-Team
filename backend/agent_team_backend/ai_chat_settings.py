"""AI Chat settings.

The chat runs through the CLI engine (ai_chat_cli_engine), so the provider /
API-key / model fields of the old API engine are gone. What remains is the
user's extra system prompt, appended to the CLI's own system prompt via
``--append-system-prompt``. Unknown keys in the persisted document (from
older versions) are ignored on read and dropped on the next write.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

from .applog import app_data_dir
from .db import DB_FILENAME, Database

log = logging.getLogger("agent_team_backend.ai_chat_settings")

SETTINGS_FILE = "ai_chat_settings.json"
_KV_KEY = "ai_chat_settings"

DEFAULTS: dict[str, Any] = {
    # Extra instructions appended to the CLI's system prompt ('' = none).
    "system_prompt": "",
}


class AIChatSettingsStore:
    def __init__(self, path: Path | None = None, db: Database | None = None) -> None:
        self._path = path or (app_data_dir() / SETTINGS_FILE)
        self._db = db or Database(self._path.parent / DB_FILENAME)
        # Legacy documents held API keys; the legacy JSON was chmod 0o600, so
        # keep the database file equally private (best-effort).
        try:
            os.chmod(self._db.path, 0o600)
        except OSError:
            pass

    @property
    def path(self) -> Path:
        return self._db.path

    def _import_legacy(self, cur: Any, data: Any) -> None:
        if isinstance(data, dict):
            self._db.kv_set(_KV_KEY, data, now=int(time.time()))

    def _read(self) -> dict[str, Any]:
        doc = self._db.kv_get(_KV_KEY)
        if doc is None:
            self._db.import_json(_KV_KEY, self._path, self._import_legacy)
            doc = self._db.kv_get(_KV_KEY)
        return doc if isinstance(doc, dict) else {}

    def get(self) -> dict[str, Any]:
        raw = self._read()
        result = dict(DEFAULTS)
        for k in DEFAULTS:
            if k in raw:
                result[k] = raw[k]
        return result

    def set(self, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.get()
        for key, value in updates.items():
            if key in DEFAULTS:
                current[key] = value
        if not isinstance(current.get("system_prompt"), str):
            current["system_prompt"] = DEFAULTS["system_prompt"]
        self._db.kv_set(_KV_KEY, current, now=int(time.time()))
        log.info("ai_chat settings saved")
        return dict(current)
