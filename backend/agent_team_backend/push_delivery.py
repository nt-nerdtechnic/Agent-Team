"""Push delivery: hand a queued message to a CLI without typing it into a pane.

Every ordinary delivery writes the envelope to the pane's PTY stdin, which is
the same thing as typing it: it occupies the CLI's input box, it has to wait
for whoever is at the keyboard, and it is only as reliable as the echo the TUI
happens to produce. Some CLIs offer a second way in, and this module is the one
place that knows how to use them.

Which way a CLI offers is that CLI's own business and is declared by its module
in ``cli_vendors`` (``VendorSpec.push_channel``); this module knows only the
three mechanisms and does the I/O:

- an HTTP SERVER the CLI's own TUI is a client of (opencode, kilo). The pane is
  spawned with a per-pane free port, and a message is appended to the composer
  and submitted over loopback. The text still lands in the input box, so this
  buys atomic insertion rather than freedom from the typing hold.
- a JSONL FILE the CLI watches (qwen). The pane is spawned pointing at a
  per-pane file and a message is one appended line. The text never reaches the
  composer.
- a HOOK PARKED HERE (claude). The CLI runs a background hook that blocks on
  this backend until there is something to say; answering it wakes an idle
  agent with the message as a system reminder, without touching the input box.

Ownership is unchanged: the queue, the rate limit, the log and the FIFO all
stay in the renderer, which decides per message whether to push and falls back
to the PTY the moment a push does not land. Nothing here is a delivery
guarantee — see ``deliver`` for what each mechanism can actually prove.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import shlex
import socket
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from .applog import app_data_dir
from .cli_vendors import registry
from .cli_vendors.base import PushChannel
from .pending_registry import TIMEOUT, PendingRegistry

log = logging.getLogger("agent_team_backend.push_delivery")

#: Route labels, mirrored by the renderer's `push:<kind>` message route and by
#: the docs. Stable strings: they end up in the delivery log.
KIND_HTTP = "tui-http"
KIND_FILE = "input-file"
KIND_HOOK = "rewake"

#: Settings key holding the agent keys whose push channel the user switched
#: off. A negative list, like the CLI-agents one it sits beside: every channel
#: is on until someone says otherwise, and a vendor that gains one later is on
#: too without a settings migration.
DISABLED_SETTING_KEY = "pushChannelsDisabled"

#: File under the app data dir holding the secret the rewake hook carries back.
#: Owner-only, minted once and kept: see `rewake_token`.
REWAKE_TOKEN_FILENAME = "push_rewake_token"

#: Only for a data dir that cannot be written. Keeps a single value for the
#: process rather than minting one per call, which would refuse every hook.
_EPHEMERAL_REWAKE_TOKEN = secrets.token_urlsafe(24)

#: Serialises the mint, so two installers starting at once cannot bake
#: different values into different panes.
_token_lock = threading.Lock()

#: How long an HTTP push may take before it counts as not having landed. The
#: server is on loopback and the pane is idle, so this only has to outlast a
#: TUI that is busy repainting.
HTTP_TIMEOUT_S = 5.0

#: How long a parked hook waiter is held open before it is told to give up.
#: The hook is backgrounded by the CLI, so this costs a sleeping process rather
#: than a stalled agent; long enough that a pane which just went idle keeps the
#: channel for a whole coffee break, short enough that an abandoned waiter does
#: not outlive the session by much.
HOOK_WAIT_S = 1800.0


@dataclass
class PaneChannel:
    """One pane's live push channel."""

    pane_id: str
    agent_key: str
    kind: str
    channel: PushChannel
    port: int = 0
    password: str = ""
    input_file: str = ""
    #: Request ids of hook waiters parked for this pane. Only the newest is
    #: ever answered with a message; the rest are released empty.
    waiters: list[str] = field(default_factory=list)


_panes: dict[str, PaneChannel] = {}
#: Parked hook waiters, keyed by request id. Resolving one hands its envelope
#: to the hook that is blocked on it.
_waiters: PendingRegistry[str] = PendingRegistry()

#: Reads the user's per-vendor switches. Injected by the app at startup rather
#: than imported, so this module keeps no back-edge to the one that imports it.
#: Unset — which is what tests and any caller that never configured it see —
#: means every declared channel is on.
_disabled_reader: Callable[[], set[str]] | None = None


def set_disabled_reader(reader: Callable[[], set[str]] | None) -> None:
    """Point this module at the user's per-vendor switches."""
    global _disabled_reader
    _disabled_reader = reader


def disabled_agents() -> set[str]:
    """Agent keys whose push channel the user switched off."""
    if _disabled_reader is None:
        return set()
    try:
        return set(_disabled_reader())
    except Exception as err:  # noqa: BLE001 — an unreadable setting is not "off"
        log.warning("push channel switches unreadable (%s); treating all as on", err)
        return set()


def _rewake_token_path() -> Path:
    return app_data_dir() / REWAKE_TOKEN_FILENAME


def _harden(path: Path) -> None:
    """Tighten a token file a wide umask, or an older version, left readable."""
    try:
        if path.stat().st_mode & 0o077:
            path.chmod(0o600)
    except OSError:
        pass


def _read_rewake_token(path: Path) -> str:
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    if token:
        _harden(path)
    return token


def _write_rewake_token(path: Path, token: str) -> None:
    """Persist the secret, never existing group/world readable even briefly."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(token + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def rewake_token() -> str:
    """The secret the installed rewake hook must present.

    Kept on disk rather than minted per run, because the hook command is
    written into the CLI's settings file once and a pane that is already
    running keeps firing exactly the command it was given. A token that changed
    with every backend restart would refuse every one of those hooks, and the
    only symptom is that those panes quietly go back to being typed into until
    their CLI is restarted.

    Not an authorisation boundary: it ends up in a settings file anything
    running as this user can read. What it proves is that the caller went
    through this machine's installer, so a hook command copied from elsewhere —
    or one aimed at a port this backend now happens to hold — is refused rather
    than parking on someone's pane.

    Deliberately uncached: tests isolate `AGENT_TEAM_DATA_DIR` per test, and a
    process-wide cache would leak one test's token into the next.
    """
    path = _rewake_token_path()
    existing = _read_rewake_token(path)
    if existing:
        return existing
    with _token_lock:
        # Re-read under the lock: a concurrent caller may have just written it.
        existing = _read_rewake_token(path)
        if existing:
            return existing
        token = secrets.token_urlsafe(24)
        try:
            _write_rewake_token(path, token)
        except OSError as err:
            log.warning(
                "could not persist the rewake token (%s); using a per-run one, "
                "which panes started before this run will not match", err
            )
            return _EPHEMERAL_REWAKE_TOKEN
        return token


def channel_for(agent_key: str) -> PushChannel | None:
    """This CLI's push channel, or None when it has none or the user turned it off.

    The single place the switch is read: everything below asks this rather than
    the settings store, so a channel cannot be half-off — wired at spawn but
    refused at delivery, or the other way round.
    """
    spec = registry.vendor(agent_key)
    if spec is None or spec.push_channel is None:
        return None
    if agent_key in disabled_agents():
        return None
    return spec.push_channel


def _kind(channel: PushChannel) -> str:
    if channel.append_path:
        return KIND_HTTP
    if channel.input_file_flag:
        return KIND_FILE
    if channel.hook_wait:
        return KIND_HOOK
    return ""


def runtime_dir(kind: str) -> Path:
    """App-owned directory for a mechanism's per-pane files."""
    return app_data_dir() / "runtime" / kind


def _free_port(host: str) -> int:
    """A port nothing is listening on, for the CLI to bind a moment later.

    Racy by nature — the kernel can hand the same port to someone else in
    between — but the alternative is a fixed range that collides with every
    other pane. A pane whose CLI fails to bind simply has no push channel and
    falls back to the PTY.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def _has_flag(text: str, flag: str) -> bool:
    """Whether the command already carries this flag, as a whole argument.

    Token-level rather than substring: `--portable` contains `--port`, and a
    substring test would read a pane's own unrelated flag as "the user wired
    this themselves" and silently leave it without a channel. An unparseable
    command (an unbalanced quote) falls back to whitespace splitting, which is
    wrong only for a command that would not run anyway.
    """
    if not flag:
        return False
    try:
        tokens = shlex.split(text)
    except ValueError:
        tokens = text.split()
    return any(token == flag or token.startswith(f"{flag}=") for token in tokens)


def _append_to_command(command: Any, suffix: str) -> Any:
    """Append ``suffix`` to the real command, preserving the shell wrapper.

    The frontend wraps agent commands as ``[shell, '-ilc'|'-lc', '<cmd>']`` —
    the real command is the LAST element.
    """
    if isinstance(command, list):
        updated = list(command)
        updated[-1] = f"{updated[-1]} {suffix}"
        return updated
    return f"{command} {suffix}"


def _command_text(command: Any) -> str:
    if isinstance(command, list):
        return str(command[-1]) if command else ""
    return str(command or "")


def wire_spawn(
    agent_key: str,
    command: Any,
    pane_id: str,
    env: dict[str, str] | None = None,
) -> tuple[Any, PaneChannel | None]:
    """Give a pane spawn whatever its push channel needs, and register it.

    Returns the (possibly unchanged) command and the registered channel, or
    None when this CLI has no channel, the spawn carries no pane id, or the
    user's own command already supplies the flag — their setup is theirs, and
    driving a server or a file they pointed elsewhere is not ours to do.

    A spawn must never break over this: every failure below leaves the command
    alone, which costs the pane its push channel and nothing else.
    """
    if not pane_id:
        return command, None
    channel = channel_for(agent_key)
    if channel is None:
        return command, None
    kind = _kind(channel)
    if not kind:
        return command, None

    state = PaneChannel(pane_id=pane_id, agent_key=agent_key, kind=kind, channel=channel)
    text = _command_text(command)
    try:
        if kind == KIND_HTTP:
            if _has_flag(text, channel.port_flag):
                return command, None
            state.port = _free_port(channel.host)
            command = _append_to_command(command, f"{channel.port_flag} {state.port}")
            if channel.host_flag:
                command = _append_to_command(
                    command, f"{channel.host_flag} {shlex.quote(channel.host)}"
                )
            if channel.password_env and env is not None:
                # Only when the CLI's own TUI can authenticate against it; a
                # vendor that declares no variable is saying it cannot, and a
                # password there would lock the pane out of its own server.
                state.password = env.setdefault(
                    channel.password_env, secrets.token_urlsafe(24)
                )
        elif kind == KIND_FILE:
            if _has_flag(text, channel.input_file_flag):
                return command, None
            path = _prepare_input_file(pane_id, channel)
            state.input_file = str(path)
            command = _append_to_command(
                command, f"{channel.input_file_flag} {shlex.quote(str(path))}"
            )
        # KIND_HOOK needs nothing at spawn: the CLI's hook arms the channel.
    except Exception as err:  # noqa: BLE001 — a spawn is never broken over this
        log.warning("push channel wiring failed for %s/%s: %s", agent_key, pane_id, err)
        return command, None

    _panes[pane_id] = state
    return command, state


def _prepare_input_file(pane_id: str, channel: PushChannel) -> Path:
    """Create this pane's watch file, empty and owner-only.

    Created before the CLI starts on purpose: the watcher records the file's
    size when it opens it and only ever reads past that, so an existing file
    with a previous pane's messages in it would be silently skipped — and a
    file created later, after the watcher has already recorded size 0, is read
    from the start. Starting from an empty file makes both agree.
    """
    directory = runtime_dir(KIND_FILE)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        pass
    path = directory / f"{pane_id}{channel.input_file_suffix}"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.close(fd)
    return path


def sweep_runtime_files() -> int:
    """Delete every per-pane watch file left over from a previous run.

    These files hold message text in the clear, and the pane that owned one is
    gone: nothing here can outlive the process that created it. A backend that
    was killed rather than shut down leaves them behind, so this runs at startup
    and is the only thing that ever cleans those up. Returns how many went.
    """
    directory = runtime_dir(KIND_FILE)
    removed = 0
    try:
        entries = list(directory.iterdir())
    except OSError:
        return 0
    for entry in entries:
        try:
            if entry.is_file() and not entry.is_symlink():
                entry.unlink()
                removed += 1
        except OSError as err:
            log.debug("could not remove stale watch file %s: %s", entry, err)
    if removed:
        log.info("removed %d stale push watch file(s) from %s", removed, directory)
    return removed


def get(pane_id: str) -> PaneChannel | None:
    """This pane's registered channel, or None."""
    return _panes.get(pane_id)


def is_ready(pane_id: str) -> bool:
    """Whether a message could be pushed to this pane right now.

    A hook channel is ready only while a waiter is actually parked — that is
    the whole difference between it and the other two, which are ready from the
    moment the pane spawns.
    """
    state = _panes.get(pane_id)
    if state is None:
        return False
    if channel_for(state.agent_key) is None:
        return False
    if state.kind == KIND_HOOK:
        return bool(state.waiters)
    return True


def apply_switches() -> list[tuple[str, str, bool]]:
    """Re-settle every registered pane against the user's current switches.

    A pane already running keeps whatever it was spawned with — its port stays
    open, its watch file stays where it is — so switching a vendor off does not
    take the channel away so much as stop using it: nothing is pushed any more,
    and a hook parked on the pane is released empty rather than left holding a
    connection nothing will ever answer. Switching one back on makes the same
    panes usable again without restarting them — except a hook pane, whose
    released waiter only comes back on the CLI's next Stop or SessionStart.

    Returns `(pane_id, kind, ready)` for every registered pane, which is what
    the caller broadcasts — both directions have to be announced or a window
    that stopped offering a channel would never start again.
    """
    off = disabled_agents()
    for state in _panes.values():
        if state.agent_key not in off:
            continue
        for request_id in state.waiters:
            _waiters.resolve(request_id, "")
        state.waiters.clear()
    return [
        (pane_id, state.kind, is_ready(pane_id))
        for pane_id, state in _panes.items()
    ]


def forget_pane(pane_id: str) -> None:
    """Drop a closed pane's channel and release anything parked on it."""
    state = _panes.pop(pane_id, None)
    if state is None:
        return
    for request_id in state.waiters:
        _waiters.resolve(request_id, "")
    state.waiters.clear()
    if state.input_file:
        try:
            os.unlink(state.input_file)
        except OSError:
            pass


# ── hook waiters (claude asyncRewake) ───────────────────────────────────────
def arm_hook(pane_id: str) -> tuple[str, Any] | None:
    """Park a hook waiter for this pane and return (request id, future).

    Only the newest waiter is ever answered: the CLI re-arms on several events,
    so a pane accumulates one waiter per turn otherwise, and a message handed
    to a stale one would wake nothing. Earlier waiters are released empty,
    which is how their hook learns to exit without a decision.
    """
    state = _panes.get(pane_id)
    if state is None or state.kind != KIND_HOOK:
        return None
    if channel_for(state.agent_key) is None:
        return None
    for request_id in state.waiters:
        _waiters.resolve(request_id, "")
    state.waiters.clear()
    request_id = f"{pane_id}:rewake:{secrets.token_hex(8)}"
    future = _waiters.register(request_id)
    state.waiters.append(request_id)
    return request_id, future


def discard_waiter(pane_id: str, request_id: str) -> None:
    """Forget a parked waiter without answering it.

    For the case the future alone cannot see: the hook's HTTP connection went
    away — the user ran `/exit` inside the pane, or the CLI was killed while
    the pane stayed open — so the process that would act on an envelope is
    gone, but nothing resolved anything. Left alone the pane would advertise a
    channel for the rest of the wait and report every message pushed to it as
    delivered, with no agent anywhere near it.
    """
    _waiters.discard(request_id)
    state = _panes.get(pane_id)
    if state is not None and request_id in state.waiters:
        state.waiters.remove(request_id)


def register_hook_pane(pane_id: str, agent_key: str) -> PaneChannel | None:
    """Register a hook-channel pane that had nothing to wire at spawn.

    A hook channel needs no argv and no file, so nothing registers it while the
    pane is being created — the first waiter to arrive does.
    """
    state = _panes.get(pane_id)
    if state is not None:
        return state if state.kind == KIND_HOOK else None
    channel = channel_for(agent_key)
    if channel is None or _kind(channel) != KIND_HOOK:
        return None
    state = PaneChannel(
        pane_id=pane_id, agent_key=agent_key, kind=KIND_HOOK, channel=channel
    )
    _panes[pane_id] = state
    return state


async def wait_for_hook(pane_id: str, request_id: str, future: Any) -> str:
    """Hold a parked hook open until there is an envelope for it."""
    result = await _waiters.wait(request_id, future, timeout=HOOK_WAIT_S)
    state = _panes.get(pane_id)
    if state is not None and request_id in state.waiters:
        state.waiters.remove(request_id)
    if result is TIMEOUT or not isinstance(result, str):
        return ""
    return result


# ── delivery ────────────────────────────────────────────────────────────────
async def deliver(pane_id: str, text: str) -> tuple[bool, str]:
    """Push ``text`` to a pane's CLI. Returns (landed, reason).

    What "landed" is actually worth differs per mechanism, and the caller is
    told the mechanism so the delivery log can say which one it was:

    - ``tui-http``: the CLI's own server answered 2xx to both the append and
      the submit. That is the strongest evidence any of these give — the TUI
      took the text and submitted it.
    - ``input-file``: the line was appended to the file the CLI watches. The
      CLI polls that file, so this proves the message was written, NOT that it
      was read. A pane that died between the last check and the write consumes
      the message silently.
    - ``rewake``: a hook that was still parked took the envelope. The hook then
      hands it to the agent, which the backend cannot observe.

    Anything short of that is a failure the caller retries over the PTY.
    """
    state = _panes.get(pane_id)
    if state is None:
        return False, "no-channel"
    # Asked again rather than trusted from spawn time: a pane keeps running
    # across a settings change, and a channel the user has since switched off
    # must stop carrying messages without the pane being restarted.
    if channel_for(state.agent_key) is None:
        return False, "no-channel"
    if not text:
        return False, "empty"
    if state.channel.reminder_prefix:
        text = f"{state.channel.reminder_prefix}\n{text}"
    if state.channel.max_chars and len(text) > state.channel.max_chars:
        return False, "too-long"
    try:
        if state.kind == KIND_HTTP:
            return await _push_http(state, text)
        if state.kind == KIND_FILE:
            return _push_file(state, text)
        if state.kind == KIND_HOOK:
            return _push_hook(state, text)
    except Exception as err:  # noqa: BLE001 — every failure falls back to the PTY
        log.debug("push to %s (%s) failed: %s", pane_id, state.kind, err)
        return False, "push-error"
    return False, "no-channel"


async def _push_http(state: PaneChannel, text: str) -> tuple[bool, str]:
    """Append the envelope to the CLI's composer and submit it.

    The two calls fail very differently and the caller has to be able to tell
    them apart, which is why every failure here is named rather than raised:

    - Nothing reached the composer (the server is not up yet, or it refused the
      append). The pane is exactly as it was, so the message can be typed in
      straight away.
    - The text IS in the composer and the submit did not happen. Whatever else
      is done, it must not be typed in on top — that would submit the envelope
      twice over, concatenated. The pane passed the typing hold to get here, so
      the box was believed empty and the only thing in it is ours: clearing is
      the compensation, and it is attempted for a refusal and for an outright
      error alike, because both leave the same mess.
    """
    channel = state.channel
    base = f"http://{channel.host}:{state.port}"
    auth = (
        httpx.BasicAuth(channel.username or "", state.password)
        if state.password
        else None
    )
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S, auth=auth) as client:
        try:
            appended = await client.post(f"{base}{channel.append_path}", json={"text": text})
        except httpx.ConnectError:
            # The CLI has not opened its port yet, or never did. Distinct from
            # a channel that is merely misbehaving: this one is worth retrying
            # in a few seconds rather than being written off for a minute.
            return False, "not-listening"
        except Exception as err:  # noqa: BLE001
            log.debug("push append to %s failed: %s", state.pane_id, err)
            return False, "append-error"
        if appended.status_code >= 400:
            return False, f"append-{appended.status_code}"

        reason = ""
        try:
            submitted = await client.post(f"{base}{channel.submit_path}")
            if submitted.status_code >= 400:
                reason = f"submit-{submitted.status_code}"
        except Exception as err:  # noqa: BLE001
            log.debug("push submit to %s failed: %s", state.pane_id, err)
            reason = "submit-error"
        if reason:
            await _clear_composer(client, base, channel)
            return False, reason
    return True, ""


async def _clear_composer(client: httpx.AsyncClient, base: str, channel: PushChannel) -> None:
    """Best-effort undo of an append whose submit never happened."""
    if not channel.clear_path:
        return
    try:
        await client.post(f"{base}{channel.clear_path}")
    except Exception as err:  # noqa: BLE001 — there is nothing further to try
        log.debug("could not clear composer at %s: %s", base, err)


def leaves_text_behind(kind: str, reason: str) -> bool:
    """Whether a failed push may have left the envelope in the CLI's composer.

    Only the HTTP channel writes a composer at all, and only once its append
    has landed — everything up to that point fails with the box untouched. The
    caller reads this to decide whether the message may be typed in right away
    or has to go back in the queue for the next pump, because clearing is best
    effort and a composer that still holds our text would take the envelope a
    second time.
    """
    return kind == KIND_HTTP and reason.startswith("submit-")


def _push_file(state: PaneChannel, text: str) -> tuple[bool, str]:
    """Append one JSONL command to the file the CLI watches.

    One O_APPEND write of a complete line: the watcher only consumes up to the
    last newline it can see, so a partial record is never parsed, and the file
    is never truncated or rotated, because a watcher that sees it shrink
    re-reads it from the start and would replay every message in it.
    """
    channel = state.channel
    record = {
        channel.record_type_key: channel.record_type,
        channel.record_text_key: text,
    }
    line = (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
    fd = os.open(state.input_file, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line)
    finally:
        os.close(fd)
    return True, ""


def _push_hook(state: PaneChannel, text: str) -> tuple[bool, str]:
    """Hand the envelope to the newest hook parked for this pane."""
    while state.waiters:
        request_id = state.waiters.pop()
        if _waiters.resolve(request_id, text):
            return True, ""
    return False, "not-armed"


def _reset_for_test() -> None:
    _panes.clear()
    _waiters.pending.clear()
