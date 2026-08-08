"""Install a GitHub Copilot CLI hook that reports when a pane is waiting.

Unlike Claude and Qwen, Copilot loads every ``*.json`` under its hooks
directory on its own, with no registration anywhere else. That lets us own a
single file end to end — ``$COPILOT_HOME/hooks/agent-team.json`` — instead of
merging into a document the user also edits, so there is nothing of theirs to
preserve, corrupt, or back up. The file is rewritten wholesale each startup.

Copilot's handler shape is FLAT (``{"command": ..., "timeoutSec": ...}``),
not Claude's nested ``{"hooks": [{"type": "command", ...}]}``. It accepts the
nested form through a compatibility layer, but the flat one is native.

We install ONE event: ``notification`` (lowercase — Copilot's event names are
not Claude's). It carries the same ``notification_type`` vocabulary the other
two vendors use, and ``permission_prompt`` there was measured to fire only
when a prompt actually blocks the turn. Its sibling ``permissionRequest`` hook
is deliberately NOT used: it also fires when a tool is auto-approved (verified
with --allow-all-tools), which would report a working pane as blocked.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
from pathlib import Path
from typing import Any

log = logging.getLogger("agent_team_backend.copilot_hooks")

# Our file inside Copilot's hooks directory. Named for the product so a user
# reading the directory can tell where it came from.
_HOOK_FILENAME = "agent-team.json"


def hooks_dir() -> Path:
    """Resolve ~/.copilot/hooks. Honours $COPILOT_HOME (the config ROOT)."""
    env = os.environ.get("COPILOT_HOME")
    root = Path(env) if env else Path.home() / ".copilot"
    return root / "hooks"


def _build_command(port_file: str) -> str:
    """Shell one-liner forwarding the hook's stdin JSON to this backend.

    Reads the port at fire time so it survives backend restarts. Ends in
    `exit 0` unconditionally: a non-zero exit is how a Copilot hook reports
    failure, and curl exits non-zero whenever the backend is down — which is
    the normal state when Navide is not running.
    """
    safe_port_file = shlex.quote(port_file)
    return (
        f"PORT=$(cat {safe_port_file} 2>/dev/null); "
        f"[ -n \"$PORT\" ] && curl -fsS -m 2 -o /dev/null -X POST "
        f"-H 'Content-Type: application/json' "
        f"-H 'X-Agent-Team-Event: notification' "
        f"--data-binary @- "
        f"\"http://127.0.0.1:$PORT/hooks/copilot\" >/dev/null 2>&1; exit 0"
    )


def install_hooks(port_file: str, hooks_directory: Path | None = None) -> dict[str, Any]:
    """Write our hook file. Idempotent by construction — the file is ours.

    Skipped when Copilot's config root does not exist: creating it would
    provision a directory tree for a CLI the user has not installed.
    """
    directory = hooks_directory or hooks_dir()
    if hooks_directory is None and not directory.parent.is_dir():
        return {"installed": False, "path": str(directory), "reason": "copilot not configured"}

    path = directory / _HOOK_FILENAME
    document = {
        "version": 1,
        "disableAllHooks": False,
        "hooks": {
            "notification": [
                {
                    "command": _build_command(port_file),
                    "timeoutSec": 5,
                }
            ]
        },
    }
    try:
        directory.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(document, indent=2), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    except OSError as err:
        log.warning("could not write copilot hook file: %s", err)
        return {"installed": False, "path": str(path), "error": str(err)}

    log.info("installed Copilot hook → %s (port_file=%s)", path, port_file)
    return {"installed": True, "path": str(path), "events": 1, "port_file": port_file}
