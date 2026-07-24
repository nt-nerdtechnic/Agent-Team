"""CLI account profile registry + spawn-env planning.

Each supported CLI agent (claude/codex/kimi/grok) can register multiple named
account profiles. A profile only reserves an isolated config-home directory
under ``~/.navide/cli-profiles/<agentKey>/<profileId>``; the CLI performs its
own login inside the terminal, and the app never stores or reads credentials.

Path strings handed to CLIs must be stable byte-for-byte across spawns:
Claude Code derives its macOS Keychain entry name from the literal
``CLAUDE_CONFIG_DIR`` string (sha256 prefix), so the same profile must always
produce the identical absolute, NFC-normalised, no-trailing-slash path.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import unicodedata
from dataclasses import dataclass, field
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
# parent environment — they must never reach a profile spawn.
CLAUDE_ENV_OVERRIDES = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_path_str(path: Path | str) -> str:
    """Absolute, NFC-normalised path string without a trailing slash."""
    return unicodedata.normalize("NFC", os.path.normpath(os.path.abspath(str(path))))


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
            canonical_path_str(profiles_root or (Path.home() / ".navide" / "cli-profiles"))
        )
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._path

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


def credential_home_for(agent_key: str, store: CliProfilesStore) -> Path | None:
    """Directory the usage poller should treat as ``agent_key``'s credential
    base for the ACTIVE profile, or ``None`` when the built-in default (the real
    home) is active — in which case the caller keeps its current default path
    byte-for-byte.

    The returned base mirrors ``build_spawn_plan``'s isolation env, resolved to
    the exact layer each ``read_*_credentials`` reader expects::

        claude  <base>/.credentials.json          base = CLAUDE_CONFIG_DIR = profile_home
        codex   <base>/auth.json                   base = CODEX_HOME source = profile_home
        kimi    <base>/credentials/kimi-code.json  base = KIMI_CODE_HOME    = profile_home
        grok    <base>/.grok/auth.json             base = HOME shim         = profile_home/home

    antigravity is never isolated (fixed-name Keychain entry), so it is not a
    supported key here and always resolves to the real home upstream.
    """
    if agent_key not in SUPPORTED_AGENT_KEYS:
        return None
    profile = store.get_default_profile(agent_key)
    if profile is None:
        return None
    home = store.home_path(profile)
    # grok isolates via a HOME shim; its .grok dir lives one level in.
    return home / "home" if agent_key == "grok" else home


# ---- spawn-env planning ----


@dataclass
class ProfileSpawnPlan:
    """Env overrides a selected profile applies to one terminal spawn."""

    env_set: dict[str, str] = field(default_factory=dict)
    env_remove: list[str] = field(default_factory=list)
    codex_source_home: Path | None = None


def refresh_grok_home_shim(profile_home: Path, real_home: Path) -> Path:
    """Build/refresh the HOME shim for a grok profile.

    The shim mirrors every top-level entry of the real home via symlink so the
    CLI still sees the user's shell config, except ``.grok`` which is a real
    directory inside the profile — that's where grok keeps its credentials.
    Refreshing on every spawn picks up new real-home entries and drops
    dangling symlinks (mirrors codex_home's shared-entry symlinking).
    """
    shim = profile_home / "home"
    shim.mkdir(parents=True, exist_ok=True)
    (shim / ".grok").mkdir(exist_ok=True)
    try:
        for entry in shim.iterdir():
            if entry.is_symlink() and not entry.exists():
                entry.unlink(missing_ok=True)
    except OSError as err:
        log.warning("grok shim cleanup in %s failed: %s", shim, err)
    try:
        real_entries = list(real_home.iterdir())
    except OSError as err:
        log.warning("cannot list real home %s for grok shim: %s", real_home, err)
        real_entries = []
    for src in real_entries:
        if src.name == ".grok":
            continue
        dst = shim / src.name
        if dst.exists() or dst.is_symlink():
            continue
        try:
            dst.symlink_to(src, target_is_directory=src.is_dir())
        except OSError as err:
            log.warning("grok shim symlink %s -> %s failed: %s", dst, src, err)
    return shim


def build_spawn_plan(
    agent_key: str, profile_home: Path, *, real_home: Path | None = None
) -> ProfileSpawnPlan:
    """Compute the env overrides for spawning ``agent_key`` under a profile."""
    home_str = canonical_path_str(profile_home)
    if agent_key == "claude":
        return ProfileSpawnPlan(
            env_set={"CLAUDE_CONFIG_DIR": home_str},
            env_remove=list(CLAUDE_ENV_OVERRIDES),
        )
    if agent_key == "kimi":
        return ProfileSpawnPlan(env_set={"KIMI_CODE_HOME": home_str})
    if agent_key == "codex":
        # The per-pane CODEX_HOME mechanism stays; only its symlink source
        # switches from ~/.codex to the profile home.
        return ProfileSpawnPlan(codex_source_home=Path(home_str))
    if agent_key == "grok":
        shim = refresh_grok_home_shim(Path(home_str), real_home or Path.home())
        return ProfileSpawnPlan(env_set={"HOME": canonical_path_str(shim)})
    raise ValueError(f"unsupported agent for CLI profiles: {agent_key!r}")
