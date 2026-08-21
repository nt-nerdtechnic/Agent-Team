"""Install Qwen Code hooks that report when a pane is waiting on the user.

Qwen Code inherits Claude Code's hook design wholesale — same settings.json
shape (`hooks.<EventName>[].hooks[].command`), same `type: "command"` runner,
same stdin-JSON contract — so the read/merge/write machinery is imported from
claude_hooks rather than duplicated. Only the settings location, the event set
and the endpoint segment differ.

We install ONE event: Notification. Qwen fires it with a `notification_type` of
`permission_prompt` (the turn is blocked on a tool approval), `idle_prompt`
(the turn ended and it wants the next instruction) or `auth_success`. That
field is what lets the frontend tell "parked on the user" apart from "done" —
the two are indistinguishable on the PTY, since a prompt box paints once and
then goes silent exactly like a finished turn.

Qwen's turn boundaries are deliberately NOT taken from hooks: its log reader
already synthesizes turn_complete from a silence window, and adding a Stop hook
would duplicate that signal for no gain.

No `matcher` is set, even though Qwen matches Notification hooks against the
notification type and `matcher: "permission_prompt"` would skip the curl on
every idle_prompt. The saving is a backgrounded, 2s-capped, `|| true` request
per turn; the risk is that a matcher semantic we have not verified silently
matches nothing at all, which fails closed and invisibly. The frontend filters
by type anyway.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from .claude_hooks import (
    _build_curl_command,
    _is_ours,
    _read_settings,
    _write_settings,
)

log = logging.getLogger("agent_team_backend.qwen_hooks")

# Qwen's hook event → the kind label carried in the POST header, matching the
# vocabulary /hooks/<vendor> already understands.
_HOOK_EVENTS: dict[str, str] = {
    "Notification": "notification",
}


def settings_path() -> Path:
    """Resolve ~/.qwen/settings.json. Honours $QWEN_HOME like Claude's
    $CLAUDE_CONFIG_DIR — it names the config DIRECTORY, not the file."""
    env = os.environ.get("QWEN_HOME")
    if env:
        return Path(env) / "settings.json"
    return Path.home() / ".qwen" / "settings.json"


def install_hooks(port_file: str, settings_file: Path | None = None) -> dict[str, Any]:
    """Idempotent merge: ensure our Notification hook is present.

    Mirrors claude_hooks.install_hooks — prior agent-team entries are stripped
    by marker before ours is appended, so repeated startups don't stack copies
    and the user's own hooks are never touched.

    Skipped entirely when no ~/.qwen exists: writing settings.json would create
    the config directory for a CLI the user has not installed.
    """
    path = settings_file or settings_path()
    if settings_file is None and not path.parent.is_dir():
        return {"installed": False, "path": str(path), "reason": "qwen not configured"}

    # Refuse to write over a file we could not parse. _read_settings reports
    # unreadable JSON as an empty dict, and merging into that would replace the
    # user's models, auth and mcpServers with nothing but our hook. Qwen's
    # settings.json is a gemini-cli descendant and tolerates `//` comments,
    # which json.loads does not — so this is a reachable state, not a
    # theoretical one.
    if path.is_file():
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as err:
            log.warning("qwen settings.json unparseable (%s); leaving it alone", err)
            return {"installed": False, "path": str(path), "reason": "settings.json unparseable"}

    settings = _read_settings(path)
    hooks_section = settings.get("hooks")
    if not isinstance(hooks_section, dict):
        hooks_section = {}

    is_dev_port = "-dev" in port_file
    if is_dev_port and any(
        isinstance(e, dict)
        and any(
            isinstance(h, dict)
            and _is_ours(str(h.get("command", "")))
            and "-dev" not in str(h.get("command", ""))
            for h in e.get("hooks", [])
            if isinstance(h, dict)
        )
        for entries in hooks_section.values()
        if isinstance(entries, list)
        for e in entries
        if isinstance(e, dict)
    ):
        log.info("dev backend skipping qwen hook install: production hook is active")
        return {"installed": False, "path": str(path), "reason": "production hook active"}

    added = 0
    for event_name, event_kind in _HOOK_EVENTS.items():
        entries = hooks_section.get(event_name)
        if not isinstance(entries, list):
            entries = []
        cleaned: list[Any] = []
        for entry in entries:
            if not isinstance(entry, dict):
                cleaned.append(entry)
                continue
            inner_hooks = entry.get("hooks")
            if isinstance(inner_hooks, list):
                inner_hooks = [
                    h for h in inner_hooks
                    if not (isinstance(h, dict) and _is_ours(str(h.get("command", ""))))
                ]
                if inner_hooks:
                    cleaned.append({**entry, "hooks": inner_hooks})
                # else: drop the wrapper we emptied
            else:
                cleaned.append(entry)
        cleaned.append({
            "hooks": [{
                "type": "command",
                "command": _build_curl_command(port_file, event_kind, endpoint="qwen"),
            }],
        })
        hooks_section[event_name] = cleaned
        added += 1

    settings["hooks"] = hooks_section
    try:
        _write_settings(path, settings)
    except OSError as err:
        log.warning("could not write qwen settings.json: %s", err)
        return {"installed": False, "path": str(path), "error": str(err)}

    log.info("installed Qwen hooks → %s (events=%d, port_file=%s)",
             path, added, port_file)
    return {"installed": True, "path": str(path), "events": added, "port_file": port_file}
