"""Pane-id aliases: keeping a running CLI reachable after its pane is rebuilt.

A pane id belongs to the pane object, not to the CLI process inside it. Every
path that rebuilds a pane around a PTY that never stopped — a window reload, a
detach, taking a run group back from a detached window — mints a new one, while
the CLI keeps quoting the id it was handed at spawn time (the `?pane=` in its
/plan-mcp URL, and whatever session attribution recorded back then).

These tests cover the registry that maps the old id onto the current pane, and
the three id-keyed tables that have to follow it: the push channel, the Stop
hook's counters, and the activity cache the MCP status tools read.
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, hook_drain, push_delivery
from agent_team_backend.cli_vendors.base import PushChannel


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    push_delivery._reset_for_test()
    hook_drain._reset_for_test()
    app._pane_activity.clear()
    yield
    agent_messaging._reset_for_test()
    push_delivery._reset_for_test()
    hook_drain._reset_for_test()
    app._pane_activity.clear()


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


# ── Registry ───────────────────────────────────────────────────────────────
def test_a_former_id_resolves_to_the_pane_that_replaced_it() -> None:
    agent_messaging.register("new", "reviewer", "/ws/alpha", agent_key="claude")
    assert agent_messaging.add_aliases("new", ["old"], "/ws/alpha") == ["old"]

    entry = agent_messaging.current("old")
    assert entry is not None
    assert entry.pane_id == "new"
    assert entry.name == "reviewer"


def test_get_stays_strict_so_only_callers_that_opt_in_follow_an_alias() -> None:
    """`get` answers "is this id a pane", which a former id is not. Everything
    that means "who is the process holding this id" asks `current` instead."""
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("new", ["old"], "/ws/alpha")
    assert agent_messaging.get("old") is None


def test_a_chain_is_flattened_so_the_first_id_still_lands_on_the_last_pane() -> None:
    agent_messaging.register("b", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("b", ["a"], "/ws/alpha")
    agent_messaging.register("c", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("c", ["b"], "/ws/alpha")

    assert agent_messaging.resolve_alias("a") == "c"
    assert agent_messaging.resolve_alias("b") == "c"


def test_an_alias_wins_over_the_predecessor_entry_a_detach_has_not_dropped_yet() -> None:
    """The child window registers the pane before the parent unregisters it, so
    for a moment both ids are in the registry. The id the CLI holds must resolve
    to the pane it is attached to now — otherwise the pane sees its successor as
    somebody else and can message itself."""
    agent_messaging.register("old", "reviewer", "/ws/alpha")
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("new", ["old"], "/ws/alpha")

    entry = agent_messaging.current("old")
    assert entry is not None and entry.pane_id == "new"


def test_a_former_id_from_another_workspace_is_refused() -> None:
    agent_messaging.register("old", "reviewer", "/ws/beta")
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    assert agent_messaging.add_aliases("new", ["old"], "/ws/alpha") == []
    assert agent_messaging.resolve_alias("old") == ""


def test_an_alias_is_not_repointed_across_workspaces() -> None:
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("new", ["old"], "/ws/alpha")
    agent_messaging.register("other", "reviewer", "/ws/beta")
    assert agent_messaging.add_aliases("other", ["old"], "/ws/beta") == []
    assert agent_messaging.resolve_alias("old") == "new"


def test_empty_and_self_referential_former_ids_are_ignored() -> None:
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    assert agent_messaging.add_aliases("new", ["", "  ", "new"], "/ws/alpha") == []
    assert agent_messaging.resolve_alias("new") == ""


def test_an_id_that_comes_back_stops_being_an_alias_of_itself() -> None:
    """A→B, then A returns declaring B. Flattening would repoint A at A, which
    is not an alias — it is a pane."""
    agent_messaging.register("b", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("b", ["a"], "/ws/alpha")
    agent_messaging.register("a", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("a", ["b"], "/ws/alpha")

    assert agent_messaging.resolve_alias("a") == ""
    assert agent_messaging.resolve_alias("b") == "a"
    entry = agent_messaging.current("a")
    assert entry is not None and entry.pane_id == "a"


def test_claiming_an_id_a_connected_window_still_mirrors_is_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """It cannot be refused — a detach declares the id while the parent window
    is still online and owns it — so it is at least made visible."""
    agent_messaging.register("old", "reviewer", "/ws/alpha")
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    with caplog.at_level("WARNING"):
        agent_messaging.add_aliases("new", ["old"], "/ws/alpha")
    assert "still online" in caplog.text


def test_claiming_an_offline_id_is_the_ordinary_case_and_says_nothing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    agent_messaging.register("old", "reviewer", "/ws/alpha")
    agent_messaging._PANES["old"].offline_since = 1.0
    with caplog.at_level("WARNING"):
        agent_messaging.register("new", "reviewer", "/ws/alpha")
        agent_messaging.add_aliases("new", ["old"], "/ws/alpha")
    assert caplog.text == ""


def test_is_vacated_separates_holding_an_id_from_merely_having_had_it() -> None:
    agent_messaging.register("live", "reviewer", "/ws/alpha")
    assert agent_messaging.is_vacated("live") is False
    assert agent_messaging.is_vacated("never-registered") is True
    agent_messaging._PANES["live"].offline_since = 1.0
    assert agent_messaging.is_vacated("live") is True


def test_closing_the_pane_retires_the_ids_it_answered_to() -> None:
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("new", ["old"], "/ws/alpha")

    agent_messaging.unregister("new")

    assert agent_messaging.resolve_alias("old") == ""
    assert agent_messaging.current("old") is None


def test_unregistering_the_superseded_id_leaves_the_alias_alone() -> None:
    """A detach ends with the parent window unregistering the id its child has
    already adopted. Dropping the alias there would undo the hand-over."""
    agent_messaging.register("old", "reviewer", "/ws/alpha")
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("new", ["old"], "/ws/alpha")

    agent_messaging.unregister("old")

    entry = agent_messaging.current("old")
    assert entry is not None and entry.pane_id == "new"


def test_a_purged_pane_takes_its_former_ids_with_it() -> None:
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("new", ["old"], "/ws/alpha")
    entry = agent_messaging._PANES["new"]
    entry.offline_since = -agent_messaging.OFFLINE_GRACE_S

    assert agent_messaging.purge_expired() == ["new"]
    assert agent_messaging.resolve_alias("old") == ""


# ── agent_msg.register ─────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_register_handler_records_former_pane_ids() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "new",
            "name": "reviewer",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
            "former_pane_ids": ["old"],
        },
    })
    resp = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert resp["payload"]["pane_id"] == "new"
    assert agent_messaging.resolve_alias("old") == "new"


@pytest.mark.asyncio
async def test_register_handler_without_former_ids_registers_nothing() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register",
        "payload": {"pane_id": "new", "name": "reviewer", "workspace_path": "/ws/alpha"},
    })
    assert agent_messaging._ALIASES == {}


# ── Push channels ──────────────────────────────────────────────────────────
def _wire_channel(pane_id: str) -> None:
    channel = PushChannel(input_file_flag="--input-file", record_type="user")
    push_delivery._panes[pane_id] = push_delivery.PaneChannel(
        pane_id=pane_id, agent_key="qwen", kind=push_delivery.KIND_FILE, channel=channel
    )


def test_adopt_moves_a_still_running_panes_channel_onto_its_new_id() -> None:
    """The window reloaded: its registration went offline with it, and nothing
    live is holding the old id."""
    _wire_channel("old")
    assert push_delivery.adopt("new", ["old"]) == "old"

    state = push_delivery.get("new")
    assert state is not None and state.pane_id == "new"
    assert push_delivery.get("old") is None


def test_adopt_leaves_a_live_panes_channel_where_it_is() -> None:
    """A pane a connected window still mirrors keeps its channel however the id
    came to be declared — taking it would strand that pane for good, and only
    restarting its CLI could give it another one. The alias itself still
    stands: resolving an old id is additive, moving a channel is not."""
    agent_messaging.register("old", "reviewer", "/ws/alpha")
    agent_messaging.register("new", "reviewer", "/ws/alpha")
    agent_messaging.add_aliases("new", ["old"], "/ws/alpha")
    _wire_channel("old")

    assert push_delivery.adopt("new", ["old"]) == ""
    assert push_delivery.get("old") is not None
    assert push_delivery.get("new") is None
    assert agent_messaging.resolve_alias("old") == "new"


def test_adopt_takes_the_channel_once_the_holder_goes_offline() -> None:
    agent_messaging.register("old", "reviewer", "/ws/alpha")
    _wire_channel("old")
    agent_messaging._PANES["old"].offline_since = 1.0

    assert push_delivery.adopt("new", ["old"]) == "old"
    assert push_delivery.get("new") is not None


def test_adopt_never_takes_a_channel_from_a_pane_that_has_one() -> None:
    _wire_channel("old")
    _wire_channel("new")
    assert push_delivery.adopt("new", ["old"]) == ""
    assert push_delivery.get("old") is not None


@pytest.mark.asyncio
async def test_register_handler_reports_the_adopted_channel_as_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(push_delivery, "channel_for", lambda _key: object())
    _wire_channel("old")
    session = _session()
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "new",
            "name": "reviewer",
            "workspace_path": "/ws/alpha",
            "agent_key": "qwen",
            "former_pane_ids": ["old"],
        },
    })
    events = [
        m for m in session.websocket.sent  # type: ignore[attr-defined]
        if m.get("type") == "agent_msg.push_state"
    ]
    assert events and events[0]["payload"] == {
        "pane_id": "new", "kind": push_delivery.KIND_FILE, "ready": True
    }


# ── Stop-hook counters and the activity cache ──────────────────────────────
def test_hook_drain_counters_follow_the_pane_to_its_new_id() -> None:
    agent_messaging.register("new", "reviewer", "/ws/alpha", agent_key="claude")
    agent_messaging.add_aliases("new", ["old"], "/ws/alpha")
    hook_drain._blocked_at["new"] = time.monotonic()

    # The log reader reports the turn under the id attribution recorded at spawn.
    assert hook_drain.turn_end_is_superseded("old") is True


def test_activity_is_filed_under_the_id_the_status_tools_look_up() -> None:
    agent_messaging.register("new", "reviewer", "/ws/alpha", agent_key="claude")
    agent_messaging.add_aliases("new", ["old"], "/ws/alpha")

    app._record_pane_activity("old", "turn_complete", "done")

    assert app.pane_activity("new") is not None
    assert app.pane_activity("old") is None
