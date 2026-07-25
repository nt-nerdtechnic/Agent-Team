"""CLI account profile registry.

Each supported CLI agent (claude/codex/kimi/grok) can register multiple named
account profiles. Every agent runs against the user's real home (sessions and
settings are shared); a profile is only a credential slot under
``~/.navide/cli-profiles/<agentKey>/<profileId>`` — switching the active
account swaps credentials between that slot and the real home (see
``credential_vault``). Spawns get no per-profile env isolation.

Path strings must be stable byte-for-byte across calls: the legacy-home
migration derives Keychain service names from the literal path string
(sha256 prefix), so the same profile must always produce the identical
absolute, NFC-normalised, no-trailing-slash path.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .applog import app_data_dir

log = logging.getLogger("agent_team_backend.cli_profiles")

PROFILES_FILE = "cli-profiles.json"
PROFILES_SCHEMA_VERSION = 1
# antigravity is excluded on purpose: its OAuth token lives in a fixed-name
# macOS Keychain entry, so config-home isolation cannot separate accounts.
SUPPORTED_AGENT_KEYS = ("claude", "codex", "kimi", "grok")
# Env vars that override Claude Code's OAuth login when they leak in from the
# parent environment — they must never reach a spawn while a managed claude
# account (a non-null default profile) is active.
CLAUDE_ENV_OVERRIDES = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_path_str(path: Path | str) -> str:
    """Absolute, NFC-normalised path string without a trailing slash."""
    return unicodedata.normalize("NFC", os.path.normpath(os.path.abspath(str(path))))


def default_profiles_root() -> Path:
    """Root that holds every persisted profile home, one subdir per agent key."""
    return Path.home() / ".navide" / "cli-profiles"


def _empty_doc() -> dict[str, Any]:
    return {
        "schemaVersion": PROFILES_SCHEMA_VERSION,
        "profiles": [],
        # None = built-in default (the user's real home; no env injection).
        "defaults": {key: None for key in SUPPORTED_AGENT_KEYS},
    }


class CliProfilesStore:
    """JSON-file registry of CLI account profiles (atomic writes, lazy dirs)."""

    def __init__(
        self, path: Path | None = None, profiles_root: Path | None = None
    ) -> None:
        self._path = path or (app_data_dir() / PROFILES_FILE)
        self._profiles_root = Path(
            canonical_path_str(profiles_root or default_profiles_root())
        )
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._path

    @property
    def profiles_root(self) -> Path:
        return self._profiles_root

    # ---- disk I/O ----

    def _read(self) -> dict[str, Any]:
        if not self._path.exists():
            return _empty_doc()
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("cli-profiles.json must contain a JSON object")
            doc = _empty_doc()
            profiles = data.get("profiles")
            if isinstance(profiles, list):
                doc["profiles"] = [p for p in profiles if isinstance(p, dict)]
            defaults = data.get("defaults")
            if isinstance(defaults, dict):
                for key in SUPPORTED_AGENT_KEYS:
                    value = defaults.get(key)
                    doc["defaults"][key] = str(value) if value else None
            return doc
        except Exception as err:  # noqa: BLE001
            log.warning("cli-profiles.json corrupt (%s); starting empty", err)
            return _empty_doc()

    def _write(self, doc: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self._path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    # ---- public API ----

    def list(self) -> dict[str, Any]:
        doc = self._read()
        return {"profiles": doc["profiles"], "defaults": doc["defaults"]}

    def get(self, profile_id: str) -> dict[str, Any] | None:
        for p in self._read()["profiles"]:
            if p.get("id") == profile_id:
                return p
        return None

    def get_default_profile(self, agent_key: str) -> dict[str, Any] | None:
        doc = self._read()
        default_id = doc["defaults"].get(agent_key)
        if not default_id:
            return None
        for p in doc["profiles"]:
            if p.get("id") == default_id:
                return p
        return None

    def create(self, *, agent_key: str, name: str) -> dict[str, Any]:
        self._validate_agent_key(agent_key)
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("profile name is required")
        with self._lock:
            doc = self._read()
            existing = {p.get("id") for p in doc["profiles"]}
            profile_id = uuid4().hex[:8]
            while profile_id in existing:
                profile_id = uuid4().hex[:8]
            profile = {
                "id": profile_id,
                "agentKey": agent_key,
                "name": clean_name,
                "createdAt": _now_iso(),
            }
            doc["profiles"].append(profile)
            self._write(doc)
            return profile

    def rename(self, profile_id: str, name: str) -> dict[str, Any]:
        """Change the display name only — the home directory never moves."""
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("profile name is required")
        with self._lock:
            doc = self._read()
            for p in doc["profiles"]:
                if p.get("id") == profile_id:
                    p["name"] = clean_name
                    self._write(doc)
                    return p
            raise KeyError(f"profile not found: {profile_id}")

    def delete(self, profile_id: str) -> dict[str, Any]:
        """Unregister the profile. The home dir is renamed aside, NEVER
        removed — it can hold the user's login credentials."""
        with self._lock:
            doc = self._read()
            profile = next(
                (p for p in doc["profiles"] if p.get("id") == profile_id), None
            )
            if profile is None:
                raise KeyError(f"profile not found: {profile_id}")
            doc["profiles"] = [p for p in doc["profiles"] if p.get("id") != profile_id]
            for key, value in list(doc["defaults"].items()):
                if value == profile_id:
                    doc["defaults"][key] = None
            self._write(doc)
        home = self.home_path(profile)
        if home.exists():
            base = f"{home.name}.deleted-{time.time_ns()}"
            target = home.with_name(base)
            suffix = 1
            while target.exists():
                target = home.with_name(f"{base}-{suffix}")
                suffix += 1
            try:
                home.rename(target)
            except OSError as err:
                log.warning("could not archive profile home %s: %s", home, err)
        return {"profiles": doc["profiles"], "defaults": doc["defaults"]}

    def set_default(self, agent_key: str, profile_id: str | None) -> dict[str, Any]:
        self._validate_agent_key(agent_key)
        with self._lock:
            doc = self._read()
            if profile_id:
                profile = next(
                    (p for p in doc["profiles"] if p.get("id") == profile_id), None
                )
                if profile is None:
                    raise KeyError(f"profile not found: {profile_id}")
                if profile.get("agentKey") != agent_key:
                    raise ValueError(
                        f"profile {profile_id} does not belong to agent {agent_key!r}"
                    )
                doc["defaults"][agent_key] = profile_id
            else:
                doc["defaults"][agent_key] = None
            self._write(doc)
            return doc["defaults"]

    def home_path(self, profile: dict[str, Any]) -> Path:
        return Path(
            canonical_path_str(
                self._profiles_root / str(profile["agentKey"]) / str(profile["id"])
            )
        )

    def ensure_home(self, profile: dict[str, Any]) -> Path:
        home = self.home_path(profile)
        home.mkdir(parents=True, exist_ok=True)
        return home

    def _validate_agent_key(self, agent_key: str) -> None:
        if agent_key not in SUPPORTED_AGENT_KEYS:
            raise ValueError(
                f"unsupported agent for CLI profiles: {agent_key!r} "
                f"(supported: {', '.join(SUPPORTED_AGENT_KEYS)})"
            )
