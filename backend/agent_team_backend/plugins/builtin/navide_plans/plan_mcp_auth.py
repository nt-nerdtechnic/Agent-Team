"""Credential store for the /plan-mcp endpoint's host and external callers.

Every /plan-mcp tool call must carry one of three credential kinds (see
plan_mcp._resolve_caller):

- pane: ``?pane=<id>&t=<per-run caller token>`` — plan_mcp_wiring.caller_token(),
  unrelated to this module.
- host: ``?client=host&t=<internal token>`` — this backend's own CLI wiring
  (the fallback claude config, and any wired command where the pane id was
  not known at spawn time) so a backend-owned config is never mistaken for
  an external caller.
- external: ``?client=external&t=<external token>`` — a client outside
  Navide's own process tree, accepted only while explicitly enabled.

Both tokens and the enabled flag persist in ``plan_mcp_auth.json`` under the
app data dir so host-wired panes and previously shared external tokens keep
working across backend restarts. Tokens are generated on first read and
written back immediately; there is no in-memory cache, so tests relying on
AGENT_TEAM_DATA_DIR isolation get a clean file per test for free.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
from pathlib import Path
from typing import Any

from agent_team_backend.applog import app_data_dir

AUTH_FILENAME = "plan_mcp_auth.json"

# Reentrant: set_external_enabled/regenerate_external_token call _config()
# while already holding the lock.
_lock = threading.RLock()


def auth_path() -> Path:
    return app_data_dir() / AUTH_FILENAME


def _harden(path: Path) -> None:
    """Tighten a file left group/world readable by an older version.

    os.replace carries the temp file's mode over, so anything this module
    writes is already 0600 — this only catches files from before that.
    """
    try:
        if path.stat().st_mode & 0o077:
            path.chmod(0o600)
    except OSError:
        pass


def _read_raw() -> dict[str, Any]:
    path = auth_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    _harden(path)
    return raw if isinstance(raw, dict) else {}


def _write(config: dict[str, Any]) -> None:
    path = auth_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    # These are bearer tokens: the file must never exist group/world readable,
    # not even between a default-mode create and a chmod. os.open sets the
    # mode at creation; the explicit chmod covers a umask that widened it.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(config, indent=2) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _config() -> dict[str, Any]:
    """Load the auth config, generating and persisting missing tokens once."""
    raw = _read_raw()
    internal = raw.get("internal_token") if isinstance(raw.get("internal_token"), str) else ""
    external = raw.get("external_token") if isinstance(raw.get("external_token"), str) else ""
    enabled = raw.get("external_enabled") if isinstance(raw.get("external_enabled"), bool) else False
    if internal and external:
        return {"internal_token": internal, "external_enabled": enabled, "external_token": external}
    with _lock:
        # Re-read under the lock: a concurrent caller may have just written it.
        raw = _read_raw()
        internal = raw.get("internal_token") if isinstance(raw.get("internal_token"), str) else ""
        external = raw.get("external_token") if isinstance(raw.get("external_token"), str) else ""
        enabled = raw.get("external_enabled") if isinstance(raw.get("external_enabled"), bool) else False
        internal = internal or secrets.token_urlsafe(32)
        external = external or secrets.token_urlsafe(32)
        config = {"internal_token": internal, "external_enabled": enabled, "external_token": external}
        _write(config)
        return config


def internal_token() -> str:
    return str(_config()["internal_token"])


def external_enabled() -> bool:
    return bool(_config()["external_enabled"])


def external_token() -> str:
    return str(_config()["external_token"])


def set_external_enabled(enabled: bool) -> dict[str, Any]:
    """Persist the external-access toggle. Returns the resulting config."""
    with _lock:
        config = _config()
        config["external_enabled"] = bool(enabled)
        _write(config)
        return config


def regenerate_external_token() -> dict[str, Any]:
    """Mint a new external token, invalidating the old one. Returns the
    resulting config."""
    with _lock:
        config = _config()
        config["external_token"] = secrets.token_urlsafe(32)
        _write(config)
        return config
