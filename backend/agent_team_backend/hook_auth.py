"""What an installed CLI hook must present before ``/hooks/<vendor>`` believes it.

The hook commands live in the CLIs' own settings files, and those are world
readable — ``~/.claude/settings.json`` is 0644 under the default umask — so a
secret written into the command text (the way the rewake hook carries its
``t=``) is readable by every account on the machine, and the finding this
closes was exactly that: any local account could POST a forged ``stop`` or
``notification`` and have the frontend act on it.

This secret is not in the command. The command names a file, and curl reads
the header out of it when the hook fires (``-H @file``). The file is 0600 in
the app data directory: a hook running as this user presents it, another
account cannot open it, and nothing appears in ``ps`` because the value never
becomes an argument. Read at fire time rather than install time, so a pane
started before a backend restart keeps working with the command it was given
— the same reason the rewake token is persisted rather than minted per run.

Not a boundary against this user's own processes; nothing on this machine is.
"""

from __future__ import annotations

import logging
import os
import secrets
import threading
from pathlib import Path

from .applog import app_data_dir

log = logging.getLogger(__name__)

#: The header the hook sends and the endpoint checks.
HEADER = "X-Agent-Team-Hook"
#: The file holds the complete header line, because that is what curl's
#: ``-H @file`` expects; ``token()`` reads the value back out of it.
FILENAME = "hook-auth"

_lock = threading.Lock()
_ephemeral = secrets.token_urlsafe(24)
_ephemeral_warned = False


def header_file() -> Path:
    """Where the hook command points curl. Ensures the file exists, so a
    freshly installed hook never fires against a file that is not there yet."""
    token()
    return app_data_dir() / FILENAME


def _read(path: Path) -> str:
    try:
        line = path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    prefix = HEADER + ": "
    if not line.startswith(prefix):
        return ""
    value = line[len(prefix):].strip()
    if value:
        try:
            if path.stat().st_mode & 0o077:
                path.chmod(0o600)
        except OSError:
            pass
    return value


def _write(path: Path, value: str) -> None:
    """Never group/world readable, not even between create and chmod."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(f"{HEADER}: {value}\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def token() -> str:
    """The value a hook must present. Created on first use, kept on disk.

    Uncached on purpose: tests isolate ``AGENT_TEAM_DATA_DIR`` per test, and a
    process-wide cache would carry one test's secret into the next.
    """
    path = app_data_dir() / FILENAME
    existing = _read(path)
    if existing:
        return existing
    with _lock:
        existing = _read(path)
        if existing:
            return existing
        value = secrets.token_urlsafe(24)
        try:
            _write(path, value)
        except OSError as err:
            global _ephemeral_warned
            if not _ephemeral_warned:
                _ephemeral_warned = True
                log.warning(
                    "could not persist the hook secret (%s); using a per-run one, "
                    "which no installed hook can present", err
                )
            return _ephemeral
        return value


def presented(value: str | None) -> bool:
    """Whether a request carried the current secret. Constant-time, and an
    absent header is simply a mismatch — there is no second answer."""
    return bool(value) and secrets.compare_digest(str(value), token())
