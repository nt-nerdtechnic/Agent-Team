"""This machine's stable device identity.

Cross-device agent messaging addresses a *device*, not a person: one member
may run Navide on several machines, and a message A sends to B must not be
echoed back to A — an agent that receives its own message answers it and
loops. That requires an id which stays the same across restarts, so a remote
roster never accumulates ghost devices and a peer's cached addressing keeps
resolving.

The id is a UUID4 stored in ``device-identity.json`` under the app data dir
(device-level, not per-workspace: it identifies the machine, not a project).
It is generated on first read and written back immediately. A missing, empty,
truncated or otherwise unparseable file is regenerated rather than fatal —
the backend must still start — but every generation is logged, because to a
peer a new id means a new machine.

Like plan_mcp_auth there is no in-memory cache: the file is tiny, and reading
through keeps ``AGENT_TEAM_DATA_DIR`` isolation honest for tests.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from pathlib import Path

from agent_team_backend.applog import app_data_dir

log = logging.getLogger(__name__)

IDENTITY_FILENAME = "device-identity.json"

_lock = threading.Lock()


def device_identity_path() -> Path:
    return app_data_dir() / IDENTITY_FILENAME


def _read() -> str:
    """Return the stored device id, or "" if it is missing or unusable."""
    path = device_identity_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return ""
    except (OSError, ValueError) as exc:
        log.warning("device identity file %s is unreadable (%s)", path, exc)
        return ""
    value = raw.get("device_id") if isinstance(raw, dict) else None
    if not isinstance(value, str):
        log.warning("device identity file %s has no device_id string", path)
        return ""
    try:
        uuid.UUID(value)
    except ValueError:
        log.warning("device identity file %s holds a malformed id", path)
        return ""
    return value


def _write(value: str) -> None:
    """Persist *value*, replacing the file atomically.

    Not for secrecy — the id is not a credential, the server only recognises
    it and never issues it — but a half-written file would read back as
    corrupt and mint a new id, which every peer sees as a different machine.
    """
    path = device_identity_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps({"device_id": value}, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def device_id() -> str:
    """This machine's device id, generating and persisting it on first use."""
    existing = _read()
    if existing:
        return existing
    with _lock:
        # Re-read under the lock: a concurrent caller may have just written it.
        existing = _read()
        if existing:
            return existing
        value = str(uuid.uuid4())
        _write(value)
        log.info("generated a new device id %s at %s", value, device_identity_path())
        return value
