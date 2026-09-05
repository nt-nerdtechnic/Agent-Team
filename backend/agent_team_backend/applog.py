"""Backend logging: rotating file handler under the macOS app-data dir."""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path


def default_app_data_dir() -> Path:
    """Where a shipped install keeps its state, ignoring any override.

    Split out from ``app_data_dir`` so something can ask "is this process
    running on the default state, or beside it?" — which is the question that
    decides whether a stored secret may share a name with the shipped app's.
    """
    if os.name == "posix" and os.uname().sysname == "Darwin":
        return Path(os.path.expanduser("~/Library/Application Support/Agent-Team"))
    # Fallback for non-macOS dev: XDG_DATA_HOME or ~/.local/share.
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return Path(base) / "Agent-Team"


def app_data_dir() -> Path:
    """Cross-platform-ish app data dir. V1 targets macOS.

    An explicit ``AGENT_TEAM_DATA_DIR`` override wins over the platform default.
    The dev launcher sets it so a `npm run dev` instance keeps its backend state
    (sessions, settings, backend-port) separate from a packaged app running at
    the same time — otherwise two backends fight over one state dir.
    """
    override = os.environ.get("AGENT_TEAM_DATA_DIR")
    if override:
        return Path(os.path.expanduser(override))
    return default_app_data_dir()


def log_dir() -> Path:
    d = app_data_dir() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def backend_log_path() -> Path:
    return log_dir() / "backend.log"


def backend_port_file() -> Path:
    """Path to the small text file holding the currently-running backend port.

    Used by Claude Code hooks installed in ~/.claude/settings.json so each
    hook fire can resolve the current port without us baking it into config.
    """
    return app_data_dir() / "backend-port"


def backend_ws_token_file() -> Path:
    """Path to the one-shot credential the local ``/ws`` endpoint requires.

    Deliberately a *separate* file from ``backend-port``. The port is written
    world-readable on purpose — Claude Code hooks resolve it with a plain
    ``cat`` from a shell this process does not control — while this one must
    not be. Two facts with two different audiences do not belong in one file.
    """
    return app_data_dir() / "backend-ws-token"


def setup_file_logging(level: str = "info") -> Path:
    """Attach a rotating file handler to the agent_team_backend logger tree.

    Returns the active log file path so callers (e.g. the entrypoint) can print
    it to stdout — the renderer reads stdout to surface the path in the UI.
    """
    path = backend_log_path()
    handler = RotatingFileHandler(
        path, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    handler.setLevel(level.upper())
    handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
    )
    root = logging.getLogger("agent_team_backend")
    # Avoid duplicate handlers if called twice.
    if not any(isinstance(h, RotatingFileHandler) and Path(h.baseFilename) == path for h in root.handlers):
        root.addHandler(handler)
    return path
