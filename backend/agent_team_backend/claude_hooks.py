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
from urllib.parse import quote

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

#: Events that also arm the background rewake waiter — the hook that lets an
#: inter-CLI message reach a claude pane that is sitting IDLE, which is the one
#: moment the Stop hook above cannot cover. SessionStart puts one in place for a
#: pane that starts idle; Stop re-arms it after every turn, which is what keeps
#: the channel alive for the rest of the session.
#:
#: UserPromptSubmit is deliberately left out. It would re-arm more often, but
#: exiting 2 on that event normally means "erase the prompt the user just
#: typed"; asyncRewake is documented to route exit 2 through the wake path
#: instead, and that has not been verified here. The gain does not justify the
#: failure mode.
_REWAKE_EVENTS: tuple[str, ...] = ("SessionStart", "Stop")

#: How long the hook itself allows the parked request to run. Ordered above the
#: backend's own `push_delivery.HOOK_WAIT_S` and the curl deadline below it, so
#: the backend is always the one that gives up first: a curl that timed out
#: while the backend still believed in its waiter would take a message with it.
_REWAKE_TIMEOUT_S = 2100
_REWAKE_CURL_TIMEOUT_S = 1860


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


def _build_rewake_command(port_file: str) -> str:
    """Build the parked-waiter hook.

    Runs as an `asyncRewake` hook, which means Claude Code backgrounds it and
    reads its exit code rather than its stdout: exiting 2 wakes the agent — even
    an idle one — and shows the hook's stderr as a system reminder. So the
    envelope is written to stderr and the exit code is the whole protocol.

    The request blocks until the backend has something to say or gives up, and
    a backend that is not running (no port file, connection refused) leaves the
    hook exiting 0, which is "nothing to report" and costs the pane nothing.

    The `t` parameter says the hook came from this machine's installer, not
    that its caller is authorised: it lives in this settings file, which
    anything running as this user can read. It is kept in the app data
    directory and survives a backend restart, so a pane that is still running
    keeps working with the command it was given.
    """
    from . import push_delivery

    safe_port_file = shlex.quote(port_file)
    token = quote(push_delivery.rewake_token(), safe="")
    return (
        f"{_AGENT_TEAM_MARKER} kind=rewake\n"
        f"PORT=$(cat {safe_port_file} 2>/dev/null); "
        f"[ -n \"$PORT\" ] || exit 0\n"
        f"BODY=$(curl -fsS -m {_REWAKE_CURL_TIMEOUT_S} -X POST "
        f"-H 'Content-Type: application/json' "
        f"-H 'X-Agent-Team-Event: rewake' "
        f"--data-binary @- "
        f"\"http://127.0.0.1:$PORT/hooks/claude/rewake?t={token}\" || true)\n"
        f"[ -n \"$BODY\" ] || exit 0\n"
        f"printf '%s\\n' \"$BODY\" >&2\n"
        f"exit 2"
    )


def _rewake_wanted() -> bool:
    """Whether claude's push channel is switched on right now.

    Read here rather than only at delivery time so switching the channel off
    actually takes the hook out of the user's settings file, which is what the
    Settings copy promises. Asked through `channel_for` like everything else,
    so a channel cannot be half-off — and so an unreadable switch leaves the
    hook installed, which is that function's own default.
    """
    from . import push_delivery

    return push_delivery.channel_for("claude") is not None


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

    The rewake waiter is the one entry that is conditional: it exists only to
    serve claude's push channel, so a user who switched that channel off gets
    it stripped here and not written back. The signal hooks are unaffected —
    they feed activity detection, which has nothing to do with push delivery.
    """
    path = settings_file or settings_path()
    settings = _read_settings(path)
    hooks_section = settings.get("hooks")
    if not isinstance(hooks_section, dict):
        hooks_section = {}

    rewake_wanted = _rewake_wanted()
    # If this is a dev backend instance and the existing settings already point
    # to a live production hook (non-dev port file), preserve the production
    # hook so launching dev never breaks the running production app.
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
        log.info("dev backend skipping hook install: production hook is active")
        return {"status": "skipped", "reason": "production hook active"}

    added = 0
    for event_name in [*_HOOK_EVENTS, *(e for e in _REWAKE_EVENTS if e not in _HOOK_EVENTS)]:
        event_kind = _HOOK_EVENTS.get(event_name, "")
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
        # Append our entries. The two are separate hook objects on purpose: the
        # signal hook is synchronous and its answer is read, the rewake waiter
        # is backgrounded and only its exit code matters, and a single event
        # (Stop) wants both.
        ours: list[dict[str, Any]] = []
        if event_kind:
            ours.append({
                "type": "command",
                "command": _build_curl_command(port_file, event_kind),
            })
        if event_name in _REWAKE_EVENTS and rewake_wanted:
            ours.append({
                "type": "command",
                "command": _build_rewake_command(port_file),
                "asyncRewake": True,
                "timeout": _REWAKE_TIMEOUT_S,
            })
        if ours:
            cleaned.append({"hooks": ours})
            added += 1
        # An event we contribute nothing to (SessionStart with the rewake
        # channel off) must not leave an empty wrapper behind, and must not
        # keep a key we are the only reason for.
        if cleaned:
            hooks_section[event_name] = cleaned
        else:
            hooks_section.pop(event_name, None)

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
