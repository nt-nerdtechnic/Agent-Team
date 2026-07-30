"""Global analyzer settings — backend mode, Ollama URL, llama-cli override."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from .applog import app_data_dir
from .db import DB_FILENAME, Database

log = logging.getLogger("agent_team_backend.analyzer_settings")

SETTINGS_FILE = "analyzer_settings.json"
_KV_KEY = "analyzer_settings"

DEFAULTS: dict[str, Any] = {
    "backend": "ollama",              # "llama_cpp" | "ollama"
    "ollama_base_url": "http://localhost:11434",
    "llama_cli": "",                  # empty → auto-detect from PATH
    "gguf_path": "",                  # empty → resolve via Ollama manifest; set to use a local .gguf directly
}


class AnalyzerSettingsStore:
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
        raw = self._db.kv_get(_KV_KEY)
        if raw is None:
            self._db.import_json(_KV_KEY, self._path, self._import_legacy)
            raw = self._db.kv_get(_KV_KEY)
        if not isinstance(raw, dict):
            return dict(DEFAULTS)
        merged = dict(DEFAULTS)
        for k in DEFAULTS:
            if k in raw:
                merged[k] = raw[k]
        return merged

    def set(self, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.get()
        for key, value in updates.items():
            if key in DEFAULTS:
                current[key] = value
        if current.get("backend") not in ("llama_cpp", "ollama"):
            current["backend"] = "llama_cpp"
        self._db.kv_set(_KV_KEY, current, now=int(time.time()))
        log.info("analyzer settings saved: %s", current)
        return current
