"""Claude Code hook installer + payload normaliser.

Claude Code (CLI) supports hooks: `~/.claude/settings.json` may declare shell
commands to run at specific lifecycle events (PreToolUse / Stop / Notification
/ SubagentStop / etc.). Each hook receives a JSON payload on stdin.

We install three hooks pointing at our local FastAPI endpoint so the
orchestrator gets reliable signals (better than buffer-scanning):
  - PreToolUse    → 100% signal: agent is actively working
  - Stop          → 100% signal: turn ended
  - Notification  → user attention requested (e.g. waiting for approval)

The installer is MERGE-safe: it reads the existing settings.json, only adds
our hook entries (tagged with a sentinel comment), and never overwrites the
user's other settings. Removal cleans up only entries we added.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import shutil
from pathlib import Path
from typing import Any

log = logging.getLogger("agent_team_backend.claude_hooks")

# Sentinel that marks a hook command as ours (so we can identify our entries
# on subsequent runs without touching the user's own hooks).
_AGENT_TEAM_MARKER = "# agent-team-hook"

# Lifecycle events we want signals for. Mapping to a stable kind label used
# both in the curl command (POST body) and in our marker.
_HOOK_EVENTS: dict[str, str] = {
    "PreToolUse": "pre_tool_use",
    "Stop": "stop",
    "Notification": "notification",
}


def settings_path() -> Path:
    """Resolve ~/.claude/settings.json. Honours $CLAUDE_CONFIG_DIR override."""
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    if env:
        return Path(env) / "settings.json"
    return Path.home() / ".claude" / "settings.json"


#: Response timeout for the Stop hook, which is the one event whose reply the
#: CLI acts on. Wider than the others' 2s so it outlasts the backend's own
#: `hook_drain.DRAIN_TIMEOUT_S` wait for the owning window — a curl that gave up
#: first would throw away a message the window had already marked delivered.
_STOP_TIMEOUT_S = 4


def _build_curl_command(port_file: str, event_kind: str, endpoint: str = "claude") -> str:
    """Build a curl invocation that forwards the hook stdin payload to us.

    Reads the current backend port from `port_file` at hook-fire time so the
    command survives backend restarts with different ports. If the file is
    absent (backend not running), the curl is skipped via the `|| true` tail.

    Hard-caps the request + `|| true` so a slow/offline backend never blocks the
    agent's main work. `--data-binary @-` preserves the JSON stdin verbatim.

    The Stop hook keeps the response body, because that is where Claude Code
    reads a hook's decision from: an inter-CLI message waiting for this pane
    comes back as `{"decision": "block", ...}` and becomes the agent's next
    instruction without ever touching its input box (see `hook_drain`). Nothing
    to deliver means an empty body, which is exactly "no decision to report".
    Every other event still discards it — their responses are acks, and an
    unrecognized object on a hook's stdout is reported as a hook error.

    `endpoint` is the vendor segment of /hooks/<vendor>; it defaults to claude
    so hook commands written by earlier builds keep the exact same text (the
    installer compares by marker, but an unchanged command also means an
    unchanged settings.json diff).
    """
    safe_port_file = shlex.quote(port_file)
    # Claude's Stop hook only: qwen borrows this builder, and nothing has
    # established that its CLI reads a hook's stdout the same way.
    keeps_body = event_kind == "stop" and endpoint == "claude"
    sink = "" if keeps_body else "-o /dev/null "
    timeout = _STOP_TIMEOUT_S if keeps_body else 2
    return (
        f"{_AGENT_TEAM_MARKER} kind={event_kind}\n"
        f"PORT=$(cat {safe_port_file} 2>/dev/null); "
        f"[ -n \"$PORT\" ] && curl -fsS -m {timeout} {sink}-X POST "
        f"-H 'Content-Type: application/json' "
        f"-H 'X-Agent-Team-Event: {event_kind}' "
        f"--data-binary @- "
        f"\"http://127.0.0.1:$PORT/hooks/{endpoint}\" || true"
    )


def _is_ours(command: str) -> bool:
    return _AGENT_TEAM_MARKER in command


def _read_settings(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError) as err:
        log.warning("settings.json unreadable (%s); skipping merge", err)
        return {}


def _write_settings(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Back up only on the first write per session (and only if there isn't
    # already a backup we'd clobber).
    backup = path.with_suffix(path.suffix + ".pre-agent-team.bak")
    if path.exists() and not backup.exists():
        try:
            shutil.copy2(path, backup)
            # No vendor name: qwen_hooks reuses this writer for its own file.
            log.info("backed up CLI settings → %s", backup)
        except OSError as err:
            log.warning("backup failed (%s); proceeding without backup", err)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def install_hooks(port_file: str, settings_file: Path | None = None) -> dict[str, Any]:
    """Idempotent merge: ensure our hooks are present for each event.

    `port_file` is the absolute path to a small text file containing the
    current backend port. The installed hook commands cat it at fire time so
    they survive backend restarts.

    Reads existing settings.json, removes any prior agent-team hook entries
    (by marker), and adds fresh entries. Returns status dict for logging.
    """
    path = settings_file or settings_path()
    settings = _read_settings(path)
    hooks_section = settings.get("hooks")
    if not isinstance(hooks_section, dict):
        hooks_section = {}

    added = 0
    for event_name, event_kind in _HOOK_EVENTS.items():
        entries = hooks_section.get(event_name)
        if not isinstance(entries, list):
            entries = []
        # Strip any prior agent-team entries from this event.
        cleaned: list[dict[str, Any]] = []
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
                    entry = {**entry, "hooks": inner_hooks}
                    cleaned.append(entry)
                # else: drop the empty wrapper
            else:
                cleaned.append(entry)
        # Append our entry.
        cleaned.append({
            "hooks": [{
                "type": "command",
                "command": _build_curl_command(port_file, event_kind),
            }],
        })
        hooks_section[event_name] = cleaned
        added += 1

    settings["hooks"] = hooks_section
    try:
        _write_settings(path, settings)
    except OSError as err:
        log.warning("could not write settings.json: %s", err)
        return {"installed": False, "path": str(path), "error": str(err)}

    log.info("installed Claude hooks → %s (events=%d, port_file=%s)",
             path, added, port_file)
    return {"installed": True, "path": str(path), "events": added, "port_file": port_file}


def uninstall_hooks(settings_file: Path | None = None) -> dict[str, Any]:
    """Remove all agent-team hook entries; leave everything else alone."""
    path = settings_file or settings_path()
    if not path.is_file():
        return {"removed": False, "reason": "settings.json absent"}
    settings = _read_settings(path)
    hooks_section = settings.get("hooks")
    if not isinstance(hooks_section, dict):
        return {"removed": False, "reason": "no hooks section"}

    changed = False
    for event_name, entries in list(hooks_section.items()):
        if not isinstance(entries, list):
            continue
        cleaned: list[Any] = []
        for entry in entries:
            if not isinstance(entry, dict):
                cleaned.append(entry)
                continue
            inner_hooks = entry.get("hooks")
            if isinstance(inner_hooks, list):
                filtered = [
                    h for h in inner_hooks
                    if not (isinstance(h, dict) and _is_ours(str(h.get("command", ""))))
                ]
                if filtered:
                    cleaned.append({**entry, "hooks": filtered})
                else:
                    changed = True  # dropped wrapper
            else:
                cleaned.append(entry)
        if cleaned != entries:
            changed = True
            if cleaned:
                hooks_section[event_name] = cleaned
            else:
                hooks_section.pop(event_name, None)

    if changed:
        settings["hooks"] = hooks_section
        try:
            _write_settings(path, settings)
        except OSError as err:
            return {"removed": False, "error": str(err)}
    return {"removed": changed, "path": str(path)}
