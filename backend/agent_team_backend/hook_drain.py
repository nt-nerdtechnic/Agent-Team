"""Stop-hook delivery: hand a queued message to a claude pane without typing.

Every other delivery path writes the envelope to the pane's PTY stdin, which is
the same thing as typing it — it occupies the CLI's input box and has to wait
for whoever is at the keyboard. Claude Code's Stop hook offers a way around
that: a hook answering `{"decision": "block", "reason": "<text>"}` keeps the
agent from stopping and hands it that text as the next thing to do. The input
box is never touched.

The queue itself stays in the renderer (that is where the rate limit, the log
and the FIFO live), so the Stop hook's HTTP request turns into one targeted
question to the window that owns the pane, bounded by a short timeout: a hook
blocks the agent for as long as it runs, so a window that is slow to answer
must cost a fraction of a second, not a turn. Nothing answered means nothing to
deliver, and the message simply waits for the ordinary stdin path.
"""

from __future__ import annotations

import logging
import secrets
import time
from typing import Any

from . import agent_messaging
from .ipc import make_event
from .pending_registry import TIMEOUT, PendingRegistry

log = logging.getLogger("agent_team_backend.hook_drain")

#: How long the Stop hook waits for the owning window to answer. The hook is
#: synchronous — Claude is parked until it returns — so this is deliberately
#: shorter than the curl timeout wrapping it: overshooting costs the agent a
#: visible stall, while giving up costs nothing but a fallback to stdin.
DRAIN_TIMEOUT_S = 1.5

#: How many messages in a row may be delivered to one pane this way before it
#: is allowed to stop. Claude Code ends the turn itself after 8 consecutive
#: blocks; stopping first means the cap is ours to explain rather than showing
#: up as the CLI overriding a hook. The pane is idle at that point, so the rest
#: of its queue goes out over stdin as it always did.
MAX_CONSECUTIVE = 5

#: How long a pane's own conversation-log turn end is treated as superseded
#: after its Stop hook blocked. The blocked turn is still written to the JSONL,
#: and its reader reports it as a turn end that arrives AFTER the hook already
#: said the agent is working — believing it would call the pane idle and start
#: typing the next queued message into a pane acting on the last one. The window
#: has to outlast that record's lag and the pause before Claude's next tool
#: call, both of which are seconds; it stays far short of a real turn, and the
#: next Stop hook that is allowed through clears it early anyway.
SUPERSEDED_TURN_END_S = 15.0

_pending: PendingRegistry[dict[str, Any]] = PendingRegistry()

#: pane_id -> consecutive hook deliveries since that pane last stopped for real.
_consecutive: dict[str, int] = {}

#: pane_id -> monotonic time of the Stop this pane was last blocked from making.
_blocked_at: dict[str, float] = {}


def resolve_drain(request_id: str, result: dict[str, Any]) -> bool:
    """Hand a window's answer to the waiting Stop hook."""
    return _pending.resolve(request_id, result)


def turn_end_is_superseded(pane_id: str) -> bool:
    """Whether a turn end reported for this pane describes a turn we blocked.

    Expires by itself, so a pane whose hooks stop arriving cannot be held as
    working forever.
    """
    started = _blocked_at.get(pane_id)
    if started is None:
        return False
    if time.monotonic() - started < SUPERSEDED_TURN_END_S:
        return True
    _blocked_at.pop(pane_id, None)
    return False


def forget_pane(pane_id: str) -> None:
    """Drop a closed pane's counter."""
    _consecutive.pop(pane_id, None)
    _blocked_at.pop(pane_id, None)


async def drain_for_stop_hook(pane_id: str, *, stop_hook_active: bool) -> str:
    """The envelope this pane's Stop hook should block on, or "" to let it stop.

    Also the one place that records whether this pane stopped, which is what
    `turn_end_is_superseded` reads: the Stop hook is the authoritative signal,
    so letting one through retires the mark rather than waiting for it to age
    out.
    """
    # Marked before the ask, not after. Asking takes up to DRAIN_TIMEOUT_S, and
    # the conversation log's own record of the very turn we are deciding about
    # lands inside that window — early enough to be believed and report the pane
    # idle. Retracted below the moment it turns out nothing was drained, so a
    # pane that simply stopped is never held on a mark it did not earn.
    if pane_id:
        _blocked_at.setdefault(pane_id, time.monotonic())
    envelope = await _drain(pane_id, stop_hook_active=stop_hook_active)
    if pane_id:
        if envelope:
            _blocked_at[pane_id] = time.monotonic()
        else:
            _blocked_at.pop(pane_id, None)
    return envelope


async def _drain(pane_id: str, *, stop_hook_active: bool) -> str:
    """The decision itself.

    `stop_hook_active` is Claude Code's own flag for "this turn only happened
    because a stop hook blocked the last one"; a Stop without it is a turn the
    user or the agent ended on its own, which is what resets the streak.
    """
    if not pane_id:
        return ""
    if not stop_hook_active:
        _consecutive.pop(pane_id, None)
    entry = agent_messaging.get(pane_id)
    # Only claude has a Stop hook that can block, and only a pane some window
    # still mirrors has a queue to drain.
    if entry is None or entry.agent_key != "claude":
        return ""
    owner = agent_messaging.owner(pane_id)
    if owner is None:
        return ""
    if _consecutive.get(pane_id, 0) >= MAX_CONSECUTIVE:
        _consecutive.pop(pane_id, None)
        return ""

    request_id = f"{pane_id}:drain:{secrets.token_hex(8)}"
    fut = _pending.register(request_id)
    try:
        await owner.send_json(
            make_event("agent_msg.hook_drain", {"request_id": request_id, "pane_id": pane_id})
        )
    except Exception as err:  # noqa: BLE001 — a dead socket is just "no message"
        log.debug("hook drain request failed for %s: %s", pane_id, err)
        _pending.discard(request_id)
        _consecutive.pop(pane_id, None)
        return ""

    result = await _pending.wait(request_id, fut, timeout=DRAIN_TIMEOUT_S)
    envelope = str(result.get("envelope") or "") if isinstance(result, dict) else ""
    if result is TIMEOUT or not envelope:
        _consecutive.pop(pane_id, None)
        return ""
    _consecutive[pane_id] = _consecutive.get(pane_id, 0) + 1
    return envelope


def _reset_for_test() -> None:
    _pending.pending.clear()
    _consecutive.clear()
    _blocked_at.clear()
