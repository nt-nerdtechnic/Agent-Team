"""Background-subagent counting: the signal the unattended loop gates on.

A CLI pane waiting on background agents ends its turn for real, so every
completion signal the loop has says "ready" when the truth is "parked". This
count is the only thing that tells the two apart, which makes its failure modes
worth pinning: it must never go negative, and it must clear itself.
"""

from agent_team_backend import subagent_tracker


def setup_function() -> None:
    subagent_tracker.reset("pane-a")
    subagent_tracker.reset("pane-b")


def test_task_tool_raises_the_count_and_subagent_stop_lowers_it() -> None:
    assert subagent_tracker.note_tool_use("pane-a", "Task") == 1
    assert subagent_tracker.note_tool_use("pane-a", "Task") == 2
    assert subagent_tracker.pending("pane-a") == 2
    assert subagent_tracker.note_subagent_stop("pane-a") == 1
    assert subagent_tracker.note_subagent_stop("pane-a") == 0


def test_both_spellings_of_the_subagent_tool_count() -> None:
    assert subagent_tracker.note_tool_use("pane-a", "Task") == 1
    assert subagent_tracker.note_tool_use("pane-a", "Agent") == 2


def test_ordinary_tools_do_not_count() -> None:
    for tool in ("Read", "Bash", "Edit", "Grep", ""):
        subagent_tracker.note_tool_use("pane-a", tool)
    assert subagent_tracker.pending("pane-a") == 0


def test_never_goes_negative() -> None:
    # A subagent running under its own session id has its PreToolUse attributed
    # to no pane, but its stop can still land here. Going negative would mask
    # the next real wait, so the count floors at zero.
    assert subagent_tracker.note_subagent_stop("pane-a") == 0
    assert subagent_tracker.note_subagent_stop("pane-a") == 0
    assert subagent_tracker.pending("pane-a") == 0
    assert subagent_tracker.note_tool_use("pane-a", "Task") == 1


def test_panes_are_counted_independently() -> None:
    subagent_tracker.note_tool_use("pane-a", "Task")
    subagent_tracker.note_tool_use("pane-b", "Task")
    subagent_tracker.note_tool_use("pane-b", "Task")
    assert subagent_tracker.pending("pane-a") == 1
    assert subagent_tracker.pending("pane-b") == 2
    subagent_tracker.note_subagent_stop("pane-a")
    assert subagent_tracker.pending("pane-a") == 0
    assert subagent_tracker.pending("pane-b") == 2


def test_an_unattributed_event_is_ignored() -> None:
    # A hook that fired before the session was claimed by a pane.
    assert subagent_tracker.note_tool_use("", "Task") == 0
    assert subagent_tracker.note_subagent_stop("") == 0
    assert subagent_tracker.pending("") == 0


def test_reaching_zero_forgets_the_pane() -> None:
    subagent_tracker.note_tool_use("pane-a", "Task")
    subagent_tracker.note_subagent_stop("pane-a")
    assert "pane-a" not in subagent_tracker._pending
