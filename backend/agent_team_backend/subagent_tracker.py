"""Per-pane count of background subagents a CLI pane is waiting on.

Claude Code fires ``PreToolUse`` before every tool call and ``SubagentStop``
when a subagent finishes. Pairing the two — a Task going in, its stop coming
back out — gives the orchestrator something no amount of buffer-scanning can:
the number of background agents a pane is currently parked on.

The unattended loop needs exactly that. A pane waiting on background agents
ends its turn for real (Claude's Stop hook fires, because the main agent really
did stop), so every completion signal the loop has says "ready for the next
instruction" when the truth is "parked". Only this count tells the two apart.

Two properties matter more than precision here, because the loop fails open on
a wrong count either way:

* **Never negative.** A ``SubagentStop`` whose matching ``PreToolUse`` was
  never attributed to a pane (a subagent running under its own session id)
  would otherwise drive the count below zero and mask later real waits.
* **Self-clearing.** A pane whose count is back to zero is dropped, so the
  table stays the size of "panes with subagents running", not "panes ever
  seen".

Staleness is the caller's problem, on purpose: a subagent killed with its CLI
never reports its stop, so a count can stay above zero forever. The frontend
bounds how long it will honour one (``LOOP_SUBAGENT_WAIT_MAX_MS``) rather than
this module guessing a lifetime for work that legitimately runs for an hour.
"""

from __future__ import annotations

#: Tool names that spawn a subagent. Claude Code has renamed this tool over
#: time and the hook payload carries whatever the running build calls it, so
#: both spellings count — an unknown name simply means no subagent is tracked,
#: which degrades to today's behaviour rather than to a wrong count.
_SUBAGENT_TOOLS = frozenset({"Task", "Agent"})

#: pane_id → number of subagents started but not yet reported finished.
_pending: dict[str, int] = {}


def note_tool_use(pane_id: str, tool_name: str) -> int:
    """Count a PreToolUse. Returns the pane's pending count afterwards."""
    if not pane_id:
        return 0
    if tool_name in _SUBAGENT_TOOLS:
        _pending[pane_id] = _pending.get(pane_id, 0) + 1
    return _pending.get(pane_id, 0)


def note_subagent_stop(pane_id: str) -> int:
    """Count a SubagentStop. Returns the pane's pending count afterwards."""
    if not pane_id:
        return 0
    remaining = _pending.get(pane_id, 0) - 1
    if remaining > 0:
        _pending[pane_id] = remaining
        return remaining
    _pending.pop(pane_id, None)
    return 0


def pending(pane_id: str) -> int:
    """How many subagents this pane is waiting on (0 when unknown)."""
    return _pending.get(pane_id, 0) if pane_id else 0


def reset(pane_id: str) -> None:
    """Forget a pane's count — its CLI exited, or its session was replaced."""
    _pending.pop(pane_id, None)
