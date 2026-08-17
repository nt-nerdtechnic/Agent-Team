"""Which `ui.pane.getStatus` replies cli_wait_idle may return from.

The renderer merged its two parked states into one 'awaiting' badge, so the
status string alone can no longer say whether a quiet pane is holding a
permission prompt (must NOT be handed work — the prompt would eat it as its
answer) or an open question (always returned from, and panes reaching here as
'idle' before the state existed still must). `awaitingKind` carries the split
across a language boundary no type checker guards, which is exactly why it
needs tests of its own.
"""

from __future__ import annotations

from agent_team_backend.plugins.builtin.navide_plans.plan_mcp import _ui_status_is_idle


def test_plain_idle_statuses_pass() -> None:
    for status in ("idle", "exited", "stopped", "error"):
        assert _ui_status_is_idle({"status": status}) is True, status


def test_working_statuses_do_not_pass() -> None:
    for status in ("running", "starting"):
        assert _ui_status_is_idle({"status": status}) is False, status


def test_awaiting_a_question_passes() -> None:
    # Regression: these panes reported 'idle' here before the parked states
    # existed. Blocking them would make cli_wait_idle newly time out on
    # exchanges it has always returned from.
    assert _ui_status_is_idle({"status": "awaiting", "awaitingKind": "question"}) is True


def test_awaiting_a_permission_prompt_does_not_pass() -> None:
    # Sending work here would answer the prompt instead of starting a turn.
    assert _ui_status_is_idle({"status": "awaiting", "awaitingKind": "permission"}) is False


def test_awaiting_without_a_kind_fails_closed() -> None:
    # An older window that predates the field, or a malformed reply. Treating
    # the unknown case as answerable is the costly direction.
    assert _ui_status_is_idle({"status": "awaiting"}) is False
    assert _ui_status_is_idle({"status": "awaiting", "awaitingKind": None}) is False
    assert _ui_status_is_idle({"status": "awaiting", "awaitingKind": "some_future_kind"}) is False


def test_a_kind_cannot_rescue_a_working_status() -> None:
    # awaitingKind only qualifies 'awaiting'; it must never widen anything else.
    assert _ui_status_is_idle({"status": "running", "awaitingKind": "question"}) is False


def test_missing_or_empty_status_does_not_pass() -> None:
    assert _ui_status_is_idle({}) is False
    assert _ui_status_is_idle({"status": ""}) is False
