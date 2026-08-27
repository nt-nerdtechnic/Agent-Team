"""Cross-workspace inter-CLI messaging: registry, target resolution, handlers."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, ws_handlers
from agent_team_backend.agent_message_log import AgentMessageLog
from agent_team_backend.db import Database


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture
def remote_roster_clean() -> Any:
    """Only for the tests that seed a remote roster. Deliberately not autouse:
    every other test in this file must run against a roster nothing ever
    touched, which is the state of a machine with no server configured."""
    from agent_team_backend import remote_roster

    remote_roster._reset_for_test()
    yield
    remote_roster._reset_for_test()


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def _seed_two_workspaces() -> None:
    agent_messaging.register("p1", "claude-1", "/ws/alpha", agent_key="claude")
    agent_messaging.register("p2", "reviewer", "/ws/alpha", agent_key="claude")
    agent_messaging.register("p3", "reviewer", "/ws/beta", agent_key="codex")


# ── Registry ───────────────────────────────────────────────────────────────
def test_register_exposes_workspace_label_and_qualified_name() -> None:
    entry = agent_messaging.register("p1", "reviewer", "/Users/me/Agent-Team")
    assert entry.workspace_label == "Agent-Team"
    assert entry.qualified_name == "Agent-Team/reviewer"


def test_register_replaces_existing_entry_so_renames_propagate() -> None:
    agent_messaging.register("p1", "old", "/ws/alpha")
    agent_messaging.register("p1", "new", "/ws/alpha")
    entry = agent_messaging.get("p1")
    assert entry is not None and entry.name == "new"
    assert len(agent_messaging.list_panes()) == 1


def test_same_name_allowed_in_different_workspaces() -> None:
    _seed_two_workspaces()
    names = [(e.workspace_path, e.name) for e in agent_messaging.list_panes()]
    assert ("/ws/alpha", "reviewer") in names
    assert ("/ws/beta", "reviewer") in names


def test_list_panes_filters_by_workspace() -> None:
    _seed_two_workspaces()
    only_beta = agent_messaging.list_panes("/ws/beta")
    assert [e.pane_id for e in only_beta] == ["p3"]


def test_trailing_slash_workspace_is_normalized() -> None:
    agent_messaging.register("p1", "a", "/ws/alpha/")
    assert agent_messaging.list_panes("/ws/alpha")[0].pane_id == "p1"


def test_drop_owner_takes_offline_only_that_windows_panes() -> None:
    win_a, win_b = object(), object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=win_a)
    agent_messaging.register("p2", "b", "/ws/beta", owner=win_b)
    dropped = agent_messaging.drop_owner(win_a)
    assert dropped == ["p1"]
    # The entry stays — a disconnected window is usually reconnecting — but is
    # flagged, so callers can tell "offline" from "does not exist".
    assert [e.pane_id for e in agent_messaging.list_panes()] == ["p1", "p2"]
    assert agent_messaging.get("p1").offline is True
    assert agent_messaging.get("p2").offline is False


# ── Offline lifecycle ──────────────────────────────────────────────────────
def test_offline_pane_survives_disconnect_and_is_restored_by_reconnect() -> None:
    window = object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=window)
    agent_messaging.register("p2", "sender", "/ws/alpha", owner=window)
    agent_messaging.set_busy("p1", True)
    agent_messaging.drop_owner(window)

    offline = agent_messaging.get("p1")
    assert offline is not None and offline.offline is True
    assert offline.to_dict()["offline"] is True

    # Reconnect: the window re-runs agent_msg.register for each pane it mirrors.
    reconnected = object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=reconnected)
    agent_messaging.register("p2", "sender", "/ws/alpha", owner=reconnected)
    restored = agent_messaging.get("p1")
    assert restored is not None
    assert restored.offline is False
    assert restored.offline_since is None
    assert restored.busy is True  # a reconnect is not a state change
    assert agent_messaging.resolve("p2", "a").pane is restored


def test_offline_pane_is_forgotten_after_the_grace_period() -> None:
    window = object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=window)
    agent_messaging.drop_owner(window)

    entry = agent_messaging.get("p1")
    assert entry is not None
    # Backdate past the grace period; the sweep runs lazily off any read.
    entry.offline_since -= agent_messaging.OFFLINE_GRACE_S + 1
    assert agent_messaging.get("p1") is None
    assert agent_messaging.list_panes() == []


def test_offline_pane_stays_within_the_grace_period() -> None:
    window = object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=window)
    agent_messaging.drop_owner(window)

    entry = agent_messaging.get("p1")
    assert entry is not None
    entry.offline_since -= agent_messaging.OFFLINE_GRACE_S - 5
    assert agent_messaging.get("p1") is not None


def test_resolving_an_offline_target_is_not_unknown_target() -> None:
    window_a, window_b = object(), object()
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=window_a)
    agent_messaging.register("p2", "reviewer", "/ws/beta", owner=window_b)
    agent_messaging.drop_owner(window_b)

    result = agent_messaging.resolve("p1", "beta/reviewer")
    assert result.pane is None
    assert result.code == "target-offline"
    assert "offline" in result.error
    # The failure a caller must not confuse it with.
    assert agent_messaging.resolve("p1", "beta/nobody").code == "unknown-target-in-workspace"


def test_resolving_an_offline_target_by_bare_name_reports_offline() -> None:
    window = object()
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=window)
    agent_messaging.register("p2", "reviewer", "/ws/alpha", owner=window)
    agent_messaging.drop_owner(window)

    assert agent_messaging.resolve("p1", "reviewer").code == "target-offline"


def test_a_live_pane_wins_over_an_offline_one_with_the_same_address() -> None:
    old_window, new_window = object(), object()
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=old_window)
    agent_messaging.register("old", "reviewer", "/ws/beta", owner=old_window)
    agent_messaging.drop_owner(old_window)
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=new_window)
    agent_messaging.register("new", "reviewer", "/ws/beta", owner=new_window)

    # Both entries exist; the offline one must neither shadow the live pane nor
    # make the address look ambiguous.
    assert agent_messaging.resolve("p1", "beta/reviewer").pane.pane_id == "new"
    assert agent_messaging.resolve("p1", "reviewer").pane is None  # different workspace


# ── Resolution ─────────────────────────────────────────────────────────────
def test_bare_name_resolves_only_within_sender_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is not None and result.pane.pane_id == "p2"
    assert result.cross_workspace is False


def test_bare_name_never_reaches_another_workspace() -> None:
    agent_messaging.register("p1", "claude-1", "/ws/alpha")
    agent_messaging.register("p3", "reviewer", "/ws/beta")
    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is None
    assert result.error is not None and "unknown target" in result.error


def test_qualified_name_reaches_another_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "beta/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p3"
    assert result.cross_workspace is True


def test_qualified_name_within_own_workspace_is_not_cross_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "alpha/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p2"
    assert result.cross_workspace is False


def test_absolute_workspace_path_addressing() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "/ws/beta/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p3"


def test_unknown_workspace_is_an_error_not_a_fallback() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "gamma/reviewer")
    assert result.pane is None
    assert result.error is not None and "unknown workspace" in result.error


def test_ambiguous_workspace_basename_refuses_to_guess() -> None:
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    agent_messaging.register("p3", "target", "/three/proj")
    result = agent_messaging.resolve("p1", "proj/target")
    assert result.pane is None
    assert result.error is not None and "ambiguous workspace" in result.error


def test_ambiguity_resolved_by_longer_path_suffix() -> None:
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    result = agent_messaging.resolve("p1", "two/proj/target")
    assert result.pane is not None and result.pane.pane_id == "p2"


def test_duplicate_name_in_one_workspace_refuses_to_guess() -> None:
    """Two windows can hold the same workspace (a detached run group) and each
    derives handles locally, so the same name can appear twice."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "claude-2", "/ws/beta")
    agent_messaging.register("p3", "claude-2", "/ws/beta")
    result = agent_messaging.resolve("p1", "beta/claude-2")
    assert result.pane is None
    assert result.error is not None and "ambiguous target" in result.error


def test_unknown_pane_in_known_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "beta/nobody")
    assert result.pane is None
    assert result.error is not None and "unknown target" in result.error


def test_empty_and_malformed_targets() -> None:
    _seed_two_workspaces()
    assert agent_messaging.resolve("p1", "").error == "empty target"
    assert agent_messaging.resolve("p1", "beta/").error is not None


def test_every_failure_carries_a_code_and_its_substitutions() -> None:
    """The UI localizes from `code`/`params`; only `error` stays English, and it
    is what the MCP tools hand back to a calling agent."""
    _seed_two_workspaces()
    agent_messaging.register("p4", "claude-2", "/ws/beta")
    agent_messaging.register("p5", "claude-2", "/ws/beta")

    cases = [
        ("", "empty-target", {}),
        ("beta/", "missing-pane-name", {"to": "beta/"}),
        ("nobody", "unknown-target", {"to": "nobody"}),
        ("gamma/reviewer", "unknown-workspace", {"ws": "gamma"}),
        ("beta/nobody", "unknown-target-in-workspace", {"name": "nobody", "ws": "beta"}),
        ("beta/claude-2", "ambiguous-target", {"name": "claude-2", "ws": "beta", "n": "2"}),
    ]
    for target, code, params in cases:
        result = agent_messaging.resolve("p1", target)
        assert result.pane is None, target
        assert result.code == code, target
        assert result.params == params, target
        assert result.error, target


def test_ambiguous_workspace_reports_the_match_count() -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/one/shared")
    agent_messaging.register("p3", "reviewer", "/two/shared")

    result = agent_messaging.resolve("p1", "shared/reviewer")

    assert result.pane is None
    assert result.code == "ambiguous-workspace"
    assert result.params == {"ws": "shared", "n": "2"}


def test_successful_resolve_carries_no_error_code() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "beta/reviewer")
    assert result.pane is not None
    assert result.code is None and result.params is None


def test_sender_display_is_always_qualified() -> None:
    _seed_two_workspaces()
    assert agent_messaging.sender_display("p1", "fallback") == "alpha/claude-1"
    assert agent_messaging.sender_display("nope", "fallback") == "fallback"


# ── Device dimension ───────────────────────────────────────────────────────
FOREIGN_DEVICE = "11111111-2222-3333-4444-555555555555"


def _this_device() -> str:
    from agent_team_backend import device_identity

    return device_identity.device_id()


def test_parse_target_splits_one_two_and_three_segment_forms() -> None:
    bare = agent_messaging.parse_target("reviewer")
    assert (bare.device_id, bare.workspace, bare.pane_name) == ("", "", "reviewer")

    two = agent_messaging.parse_target("beta/reviewer")
    assert (two.device_id, two.workspace, two.pane_name) == ("", "beta", "reviewer")

    three = agent_messaging.parse_target(f"{FOREIGN_DEVICE}/beta/reviewer")
    assert (three.device_id, three.workspace, three.pane_name) == (
        FOREIGN_DEVICE,
        "beta",
        "reviewer",
    )
    assert three.local_target == "beta/reviewer"
    assert three.to_string() == f"{FOREIGN_DEVICE}/beta/reviewer"


def test_three_segment_address_for_this_device_resolves_exactly_as_two() -> None:
    _seed_two_workspaces()
    plain = agent_messaging.resolve("p1", "beta/reviewer")
    with_device = agent_messaging.resolve("p1", f"{_this_device()}/beta/reviewer")
    assert with_device.pane is plain.pane
    assert with_device.pane.pane_id == "p3"
    assert with_device.cross_workspace == plain.cross_workspace is True


def test_this_device_segment_also_carries_an_absolute_workspace_path() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", f"{_this_device()}//ws/beta/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p3"


def test_unknown_device_is_reported_apart_from_unknown_target() -> None:
    """A foreign device may well be the right address — it just cannot be
    looked up here — so it must not read as "that pane does not exist"."""
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", f"{FOREIGN_DEVICE}/beta/reviewer")
    assert result.pane is None
    assert result.code == "unknown-device"
    assert result.params == {
        "device": FOREIGN_DEVICE,
        "to": f"{FOREIGN_DEVICE}/beta/reviewer",
    }
    assert "roster" in result.error
    assert agent_messaging.resolve("p1", "beta/nobody").code == "unknown-target-in-workspace"


def test_two_segment_and_bare_addressing_is_untouched_by_the_device_dimension() -> None:
    """The hard requirement: nobody on one machine has to rewrite anything."""
    _seed_two_workspaces()
    assert agent_messaging.resolve("p1", "reviewer").pane.pane_id == "p2"
    assert agent_messaging.resolve("p1", "beta/reviewer").pane.pane_id == "p3"
    assert agent_messaging.resolve("p1", "/ws/beta/reviewer").pane.pane_id == "p3"


def test_a_multi_segment_workspace_is_not_mistaken_for_a_device() -> None:
    """`parent/proj/pane` predates devices and still means the workspace
    `parent/proj` — only a UUID-shaped leading segment is read as a device."""
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    assert agent_messaging.resolve("p1", "two/proj/target").pane.pane_id == "p2"


def test_a_human_readable_leading_segment_is_read_as_workspace() -> None:
    """`resolve` is local-only addressing and stays that way: a non-UUID leading
    segment is a workspace here and fails as one. Device names are a second
    reading, tried by the caller afterwards — see parse_remote_target."""
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "laptop-b/beta/reviewer")
    assert result.code == "unknown-workspace"
    assert result.params == {"ws": "laptop-b/beta"}


# ── Device labels from the remote roster ───────────────────────────────────
# `parse_remote_target` is the second reading of a target, consulted only after
# `resolve` has already failed on it. These pin that ordering, because getting
# it backwards would silently re-point addresses that work today.


def _seed_remote(**overrides: object) -> None:
    from agent_team_backend import remote_roster

    row = {
        "sessionId": "sess-1",
        "deviceId": "far-device",
        "deviceName": "laptop-b",
        "workspace": "beta",
        "workspacePath": "/home/other/beta",
        "title": "reviewer",
        "paneId": "p-far",
        "agentKey": "claude",
        "status": "waiting",
        "hostOnline": True,
    }
    row.update(overrides)
    remote_roster.replace([row], local_device_id="this-device")


def test_parse_remote_target_finds_nothing_without_a_roster() -> None:
    """The no-server line: an empty roster makes every second reading a no-op,
    so the caller's answer is the one it always gave."""
    empty = agent_messaging.parse_remote_target("laptop-b/beta/reviewer")
    assert (empty.address, empty.error, empty.code) == (None, None, None)


def test_a_device_name_resolves_once_the_roster_knows_it(remote_roster_clean) -> None:
    _seed_remote()
    match = agent_messaging.parse_remote_target("laptop-b/beta/reviewer")
    assert match.address is not None
    assert match.address.device_id == "far-device"
    assert match.address.workspace == "beta"
    assert match.address.pane_name == "reviewer"
    # The id form reads the same way, which is what cli_list_targets advertises.
    by_id = agent_messaging.parse_remote_target("far-device/beta/reviewer")
    assert by_id.address is not None and by_id.address.device_id == "far-device"


def test_local_resolution_wins_over_a_device_of_the_same_name(remote_roster_clean) -> None:
    """The protection that must survive device names: `two/proj/target` names a
    workspace today, and a machine called `two` must not take it away. `resolve`
    still answers it, and the caller only ever consults the roster after
    `resolve` has failed."""
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    _seed_remote(deviceName="two", workspace="proj", title="target")

    assert agent_messaging.resolve("p1", "two/proj/target").pane.pane_id == "p2"


def test_a_two_segment_target_is_never_read_as_a_device(remote_roster_clean) -> None:
    """`folder/pane` stays a workspace address, matching the rule for id-shaped
    device segments — otherwise a device name would swallow it whole."""
    _seed_remote()
    assert agent_messaging.parse_remote_target("laptop-b/reviewer").address is None


def test_an_ambiguous_device_name_is_refused_not_guessed(remote_roster_clean) -> None:
    from agent_team_backend import remote_roster

    remote_roster.replace(
        [
            {
                "sessionId": f"s{i}",
                "deviceId": f"d{i}",
                "deviceName": "laptop",
                "workspace": "beta",
                "title": "reviewer",
                "status": "waiting",
                "hostOnline": True,
            }
            for i in (1, 2)
        ],
        local_device_id="this-device",
    )
    match = agent_messaging.parse_remote_target("laptop/beta/reviewer")
    assert match.address is None
    assert match.code == "ambiguous-device"
    assert match.params == {"device": "laptop", "n": "2"}


def test_a_pane_name_containing_a_slash_behaves_the_same_with_a_device_segment() -> None:
    """The pane name is the trailing segment, before and after the device
    dimension: everything ahead of it is still the workspace."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "feature/x", "/ws/alpha")

    plain = agent_messaging.resolve("p1", "alpha/feature/x")
    with_device = agent_messaging.resolve("p1", f"{_this_device()}/alpha/feature/x")
    assert plain.code == with_device.code == "unknown-workspace"
    assert plain.params == with_device.params == {"ws": "alpha/feature"}


def test_resolve_address_uses_a_matching_pane_id_hint() -> None:
    _seed_two_workspaces()
    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", device_id=_this_device(), pane_id="p3"
    )
    result = agent_messaging.resolve_address("p1", address)
    assert result.pane is not None and result.pane.pane_id == "p3"
    assert result.cross_workspace is True


def test_resolve_address_falls_back_when_the_hint_went_stale() -> None:
    """A detach/reattach mints a new pane id; the sender's cached one is not an
    identity, so resolution falls back to (workspace, pane name) and the caller
    reads the new id off the result."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("reattached", "reviewer", "/ws/beta")

    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", pane_id="detached-old-id"
    )
    result = agent_messaging.resolve_address("p1", address)
    assert result.pane is not None and result.pane.pane_id == "reattached"


def test_resolve_address_ignores_a_hint_that_now_names_another_pane() -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("recycled", "someone-else", "/ws/beta")
    agent_messaging.register("p3", "reviewer", "/ws/beta")

    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", pane_id="recycled"
    )
    assert agent_messaging.resolve_address("p1", address).pane.pane_id == "p3"


def test_resolve_address_hint_for_a_bare_name_stays_in_the_sender_workspace() -> None:
    _seed_two_workspaces()
    address = agent_messaging.Address(pane_name="reviewer", pane_id="p3")
    result = agent_messaging.resolve_address("p1", address)
    # p3 is the /ws/beta pane; a bare name must not reach it, hint or not.
    assert result.pane is not None and result.pane.pane_id == "p2"
    assert result.cross_workspace is False


def test_resolve_address_reports_an_offline_hint_target_as_offline() -> None:
    window = object()
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/ws/beta", owner=window)
    agent_messaging.drop_owner(window)

    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", pane_id="p2"
    )
    assert agent_messaging.resolve_address("p1", address).code == "target-offline"


def test_resolve_address_refuses_a_foreign_device_before_looking_anywhere() -> None:
    _seed_two_workspaces()
    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", device_id=FOREIGN_DEVICE, pane_id="p3"
    )
    result = agent_messaging.resolve_address("p1", address)
    assert result.pane is None
    assert result.code == "unknown-device"
    assert result.params["to"] == f"{FOREIGN_DEVICE}/beta/reviewer"


# ── Resolution by pane id ──────────────────────────────────────────────────
def test_resolve_pane_id_names_one_of_two_panes_sharing_a_name() -> None:
    """The whole reason an id exists: two panes in one workspace may share a
    name, and `resolve` refuses both rather than guessing."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "claude-2", "/ws/beta")
    agent_messaging.register("p3", "claude-2", "/ws/beta")
    assert agent_messaging.resolve("p1", "beta/claude-2").code == "ambiguous-target"

    result = agent_messaging.resolve_pane_id("p1", "p3")

    assert result.pane is not None and result.pane.pane_id == "p3"
    assert result.code is None and result.error is None


def test_resolve_pane_id_follows_the_alias_table() -> None:
    """A window reload or a detach rebuilds the pane around the same running
    CLI under a new id — the id that CLI was handed at spawn time has to keep
    naming it, or every id an agent holds goes stale on a reload."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/ws/beta")
    agent_messaging.unregister("p2")
    agent_messaging.register("p2-rebuilt", "reviewer", "/ws/beta")
    agent_messaging.add_aliases("p2-rebuilt", ["p2"], "/ws/beta")

    result = agent_messaging.resolve_pane_id("p1", "p2")

    assert result.pane is not None and result.pane.pane_id == "p2-rebuilt"


def test_resolve_pane_id_refuses_a_blank_id() -> None:
    # Whitespace has to fail like an empty string: the MCP tools treat a blank
    # id as "not given" and fall back to the address, so a blank one reaching
    # here at all means the caller meant an id and typed nothing.
    _seed_two_workspaces()
    for ident in ("", "   "):
        result = agent_messaging.resolve_pane_id("p1", ident)
        assert result.pane is None, ident
        assert result.code == "empty-target", ident


def test_resolve_pane_id_refuses_an_unknown_id() -> None:
    """Kept apart from "offline": an id nothing answers to means the pane was
    rebuilt around a fresh CLI, and the answer is to read a new id — not to
    retry the one in hand."""
    _seed_two_workspaces()
    result = agent_messaging.resolve_pane_id("p1", "never-existed")

    assert result.pane is None
    assert result.code == "unknown-pane-id"
    assert result.params == {"pane_id": "never-existed"}
    assert result.error is not None and "cli_list_targets" in result.error


def test_resolve_pane_id_reports_an_offline_pane_as_offline() -> None:
    # Same distinction an address gets: the pane is right, its window is away.
    window = object()
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/ws/beta", owner=window)
    agent_messaging.drop_owner(window)

    result = agent_messaging.resolve_pane_id("p1", "p2")

    assert result.pane is None
    assert result.code == "target-offline"


def test_resolve_pane_id_flags_cross_workspace_like_an_address_does() -> None:
    """`cross_workspace` drives how the delivery is labelled to the recipient,
    so an id must compute it the same way a name does — including for a caller
    with no pane of its own, whose message comes from outside every one."""
    _seed_two_workspaces()

    assert agent_messaging.resolve_pane_id("p1", "p2").cross_workspace is False
    assert agent_messaging.resolve_pane_id("p1", "p3").cross_workspace is True
    assert agent_messaging.resolve_pane_id("", "p2").cross_workspace is True


# ── WS handlers ────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_register_handler_mirrors_pane() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "p1",
            "name": "reviewer",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
        },
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["qualified_name"] == "alpha/reviewer"
    assert agent_messaging.get("p1") is not None


@pytest.mark.asyncio
async def test_register_handler_rejects_missing_fields() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "p1"},
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["error"]["code"] == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_unregister_handler_removes_pane() -> None:
    agent_messaging.register("p1", "a", "/ws/alpha")
    session = _session()
    await app.handle_message(session, {
        "id": "u1",
        "type": "agent_msg.unregister",
        "payload": {"pane_id": "p1"},
    })
    assert agent_messaging.get("p1") is None


@pytest.mark.asyncio
async def test_list_handler_returns_all_workspaces_when_unfiltered() -> None:
    _seed_two_workspaces()
    session = _session()
    await app.handle_message(session, {
        "id": "l1",
        "type": "agent_msg.list",
        "payload": {},
    })
    panes = session.websocket.sent[0]["payload"]["panes"]  # type: ignore[attr-defined]
    assert {p["pane_id"] for p in panes} == {"p1", "p2", "p3"}


@pytest.mark.asyncio
async def test_list_pairs_pane_id_with_its_address() -> None:
    """The drag-to-mention path resolves a dropped pane id to its address
    straight from this listing, so the pairing has to be exact."""
    _seed_two_workspaces()
    session = _session()
    await app.handle_message(session, {
        "id": "l2",
        "type": "agent_msg.list",
        "payload": {},
    })
    panes = session.websocket.sent[0]["payload"]["panes"]  # type: ignore[attr-defined]
    by_id = {p["pane_id"]: p["qualified_name"] for p in panes}
    assert by_id == {
        "p1": "alpha/claude-1",
        "p2": "alpha/reviewer",
        "p3": "beta/reviewer",
    }


@pytest.mark.asyncio
async def test_route_handler_broadcasts_deliver_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_two_workspaces()
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "d1",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": "beta/reviewer",
            "content": "run the tests",
            "msg_key": "k1",
        },
    })
    await asyncio.sleep(0)

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is True
    assert resp["payload"]["target_pane_id"] == "p3"
    assert resp["payload"]["cross_workspace"] is True

    assert len(events) == 1
    payload = events[0]["payload"]
    assert events[0]["type"] == "agent_msg.deliver"
    assert payload["target_pane_id"] == "p3"
    assert payload["from_display"] == "alpha/claude-1"
    assert payload["content"] == "run the tests"
    assert payload["msg_key"] == "k1"
    # A message that starts a thread carries no correlation id, and the payload
    # stays exactly what an older window expects.
    assert "reply_to" not in payload


@pytest.mark.asyncio
async def test_route_handler_passes_reply_to_through_to_deliver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A reply echoes the correlation id of the message it answers; the registry
    hands it back untouched so the sending window can link the two rows."""
    _seed_two_workspaces()
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "d3",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p3",
            "to": "alpha/claude-1",
            "content": "all green",
            "msg_key": "k3",
            "reply_to": "p1:7",
        },
    })
    await asyncio.sleep(0)

    assert session.websocket.sent[0]["payload"]["ok"] is True  # type: ignore[attr-defined]
    assert len(events) == 1
    assert events[0]["payload"]["reply_to"] == "p1:7"
    assert events[0]["payload"]["msg_key"] == "k3"


@pytest.mark.asyncio
async def test_route_handler_reports_unresolved_without_broadcasting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_two_workspaces()
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "d2",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": "gamma/reviewer",
            "content": "hi",
            "msg_key": "k2",
        },
    })
    await asyncio.sleep(0)

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is False
    assert "unknown workspace" in resp["payload"]["error"]
    assert events == []


@pytest.mark.asyncio
async def test_route_handler_refuses_self_send(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_two_workspaces()
    monkeypatch.setattr(app, "broadcast", lambda *a, **k: asyncio.sleep(0))
    session = _session()
    await app.handle_message(session, {
        "id": "d3",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": "alpha/claude-1",
            "content": "hi",
            "msg_key": "k3",
        },
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is False
    assert "same pane" in resp["payload"]["error"]


@pytest.mark.asyncio
async def test_delivered_handler_broadcasts_result_to_every_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Including the reporter — a qualified target can resolve inside the same
    window, and excluding it would strand that message in `queued`."""
    captured: list[tuple[dict[str, Any], Any]] = []

    async def fake_broadcast(event: dict[str, Any], **kwargs: Any) -> None:
        captured.append((event, kwargs.get("exclude")))

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "x1",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": "k1", "ok": True},
    })
    await asyncio.sleep(0)

    event, exclude = captured[0]
    assert event["type"] == "agent_msg.delivery_result"
    assert event["payload"] == {"msg_key": "k1", "ok": True, "reason": ""}
    assert exclude is None


@pytest.mark.asyncio
async def test_cancel_handler_relays_the_request_to_every_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The queue lives in the receiving window, so the withdrawal is only
    relayed — including back to the sender, whose own window may own the
    target pane."""
    captured: list[tuple[dict[str, Any], Any]] = []

    async def fake_broadcast(event: dict[str, Any], **kwargs: Any) -> None:
        captured.append((event, kwargs.get("exclude")))

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "c1",
        "type": "agent_msg.cancel",
        "payload": {"msg_key": "k1"},
    })
    await asyncio.sleep(0)

    event, exclude = captured[0]
    assert event["type"] == "agent_msg.cancel"
    assert event["payload"] == {"msg_key": "k1"}
    assert exclude is None
    assert session.websocket.sent[0]["payload"] == {"ok": True}  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_cancel_handler_needs_a_msg_key() -> None:
    session = _session()
    await app.handle_message(session, {"id": "c2", "type": "agent_msg.cancel", "payload": {}})

    assert session.websocket.sent[0]["error"]["code"] == "BAD_REQUEST"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_delivered_handler_also_settles_a_cli_send_for_cli_check_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A message sent through the MCP cli_send has no window holding its
    msg_key, so the outcome has to be handed to the MCP server too — without
    disturbing the rebroadcast every window relies on."""
    from agent_team_backend.plugins.builtin.navide_plans import plan_mcp

    captured: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        captured.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    plan_mcp._record_message_sent("mcp-key", "beta/reviewer", "pa", "hi")
    try:
        session = _session()
        await app.handle_message(session, {
            "id": "x1",
            "type": "agent_msg.delivered",
            "payload": {"msg_key": "mcp-key", "ok": False, "reason": '{"key":"queue-full"}'},
        })
        await asyncio.sleep(0)

        assert plan_mcp._mcp_message_status["mcp-key"]["status"] == "failed"
        assert plan_mcp._mcp_message_status["mcp-key"]["reason"] == "queue-full"
        assert captured[0]["type"] == "agent_msg.delivery_result"
    finally:
        plan_mcp._mcp_message_status.clear()


@pytest.mark.asyncio
async def test_delivered_handler_also_acks_a_message_relayed_in_from_another_device(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """This handler is the only place a receiving window's verdict is seen, so
    it is where a cross-device message turns into its messages.ack."""
    from agent_team_backend import server_link

    reported: list[tuple[str, bool, str]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        pass

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    monkeypatch.setattr(
        server_link,
        "note_delivery_result",
        lambda key, ok, reason: reported.append((key, ok, reason)) or True,
    )
    session = _session()
    await app.handle_message(session, {
        "id": "x1",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": "remote-key", "ok": True, "reason": ""},
    })
    await asyncio.sleep(0)

    assert reported == [("remote-key", True, "")]


# ── Message-log persistence handlers ───────────────────────────────────────
@pytest.fixture
def message_log(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Swap the app-wide log for one rooted in tmp, like the vault fixture."""
    log = AgentMessageLog(db=Database(tmp_path / "navide.db"))
    monkeypatch.setattr(app, "agent_message_log", log)
    return log


def _log_row(uid: str, created_at: int, **over: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "uid": uid,
        "created_at": created_at,
        "status": "delivered",
        "sender": "alpha/claude-1",
        "recipient": "beta/reviewer",
        "content": f"hello {uid}",
    }
    row.update(over)
    return row


@pytest.mark.asyncio
async def test_log_append_then_snapshot_round_trip(message_log: Any) -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "la1",
        "type": "agent_msg.log_append",
        "payload": {"rows": [_log_row("a:1", 100), _log_row("a:2", 200)]},
    })
    assert session.websocket.sent[0]["payload"] == {"written": 2}  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "ls1",
        "type": "agent_msg.log_snapshot",
        "payload": {},
    })
    rows = session.websocket.sent[1]["payload"]["rows"]  # type: ignore[attr-defined]
    assert [r["uid"] for r in rows] == ["a:1", "a:2"]


@pytest.mark.asyncio
async def test_log_snapshot_clamps_the_limit(message_log: Any) -> None:
    message_log.append([_log_row(f"a:{i}", i) for i in range(1, 4)])
    session = _session()
    await app.handle_message(session, {
        "id": "ls2",
        "type": "agent_msg.log_snapshot",
        "payload": {"limit": 9000},
    })
    assert len(session.websocket.sent[0]["payload"]["rows"]) == 3  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "ls3",
        "type": "agent_msg.log_snapshot",
        "payload": {"limit": 0},
    })
    rows = session.websocket.sent[1]["payload"]["rows"]  # type: ignore[attr-defined]
    assert [r["uid"] for r in rows] == ["a:3"]


@pytest.mark.asyncio
async def test_log_update_handler_patches_status(message_log: Any) -> None:
    message_log.append([_log_row("a:1", 100, status="queued")])
    session = _session()
    await app.handle_message(session, {
        "id": "lu1",
        "type": "agent_msg.log_update",
        "payload": {
            "updates": [
                {"uid": "a:1", "status": "delivered", "delivered_at": 900},
                {"uid": "unknown:1", "status": "failed"},
            ]
        },
    })
    assert session.websocket.sent[0]["payload"] == {"updated": 1}  # type: ignore[attr-defined]
    assert message_log.tail()[0]["status"] == "delivered"


@pytest.mark.asyncio
async def test_log_clear_handler_keeps_in_flight_messages(message_log: Any) -> None:
    message_log.append([
        _log_row("a:1", 100, status="queued"),
        _log_row("a:2", 200, status="delivered"),
    ])
    session = _session()
    await app.handle_message(session, {
        "id": "lc1",
        "type": "agent_msg.log_clear",
        "payload": {},
    })
    assert session.websocket.sent[0]["payload"] == {"deleted": 1}  # type: ignore[attr-defined]
    assert [r["uid"] for r in message_log.tail()] == ["a:1"]


@pytest.mark.asyncio
async def test_log_clear_handler_honors_explicit_keep_statuses(message_log: Any) -> None:
    message_log.append([
        _log_row("a:1", 100, status="queued"),
        _log_row("a:2", 200, status="failed"),
    ])
    session = _session()
    await app.handle_message(session, {
        "id": "lc2",
        "type": "agent_msg.log_clear",
        "payload": {"keep_statuses": ["failed"]},
    })
    assert session.websocket.sent[0]["payload"] == {"deleted": 1}  # type: ignore[attr-defined]
    assert [r["uid"] for r in message_log.tail()] == ["a:2"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("msg_type", "payload"),
    [
        ("agent_msg.log_append", {"rows": "not a list"}),
        ("agent_msg.log_update", {}),
        ("agent_msg.log_clear", {"keep_statuses": "delivered"}),
        ("agent_msg.log_snapshot", {"limit": None}),
        ("agent_msg.log_snapshot", {"limit": "abc"}),
        ("agent_msg.log_snapshot", {"limit": float("inf")}),
    ],
)
async def test_log_handlers_answer_bad_request_for_malformed_payloads(
    message_log: Any, msg_type: str, payload: dict[str, Any]
) -> None:
    session = _session()
    await app.handle_message(session, {"id": "lm1", "type": msg_type, "payload": payload})
    frame = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert frame["ok"] is False
    assert frame["error"]["code"] == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_log_handlers_never_broadcast(
    message_log: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Per-window queries: unlike route/delivered, nothing fans out."""
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    for msg_id, msg_type, payload in (
        ("nb1", "agent_msg.log_append", {"rows": [_log_row("a:1", 100)]}),
        ("nb2", "agent_msg.log_update", {"updates": [{"uid": "a:1", "status": "failed"}]}),
        ("nb3", "agent_msg.log_snapshot", {}),
        ("nb4", "agent_msg.log_clear", {}),
    ):
        await app.handle_message(session, {"id": msg_id, "type": msg_type, "payload": payload})
    await asyncio.sleep(0)

    assert all(frame["ok"] is True for frame in session.websocket.sent)  # type: ignore[attr-defined]
    assert events == []


def test_handlers_are_registered() -> None:
    for msg_type in (
        "agent_msg.register",
        "agent_msg.unregister",
        "agent_msg.list",
        "agent_msg.route",
        "agent_msg.delivered",
        "agent_msg.log_snapshot",
        "agent_msg.log_append",
        "agent_msg.log_update",
        "agent_msg.log_clear",
    ):
        assert ws_handlers.lookup(msg_type) is not None


def test_every_resolve_code_has_a_ui_string() -> None:
    """The log panel renders `msg.reason-<code>`; a code with no string there
    shows the raw key to the user. Nothing else ties the two layers together,
    so adding a code without its strings has to fail here."""
    import json
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    source = (root / "backend/agent_team_backend/agent_messaging.py").read_text()
    codes = set(re.findall(r'_resolve_error\(\s*\n?\s*"([a-z-]+)"', source))
    assert codes, "no codes found — has _resolve_error been renamed?"

    for locale in ("en-US", "zh-TW"):
        strings = json.loads(
            (root / f"packages/plugin-ui/src/foundation/i18n/locales/{locale}.json").read_text()
        )["msg"]
        missing = sorted(c for c in codes if f"reason-{c}" not in strings)
        assert not missing, f"{locale} is missing msg.reason-* for: {missing}"


# ── agent_msg.hold_update ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hold_update_hands_the_reason_to_the_mcp_server() -> None:
    """Delivery lives in the window, so why a message has not gone in yet
    exists nowhere else — and an MCP caller has no Messages panel to read."""
    from agent_team_backend.plugins.builtin.navide_plans import plan_mcp

    plan_mcp._record_message_sent("mcp-key", "beta/reviewer", "pa", "hi")
    try:
        session = _session()
        await app.handle_message(session, {
            "id": "h1",
            "type": "agent_msg.hold_update",
            "payload": {"msg_key": "mcp-key", "hold": {"key": "typing"}},
        })

        assert session.websocket.sent[0]["payload"]["tracked"] is True  # type: ignore[attr-defined]
        assert plan_mcp._mcp_message_status["mcp-key"]["hold"] == {"key": "typing"}
        assert plan_mcp._mcp_message_status["mcp-key"]["hold_since"] is not None
    finally:
        plan_mcp._mcp_message_status.clear()


@pytest.mark.asyncio
async def test_hold_update_with_a_null_hold_clears_it() -> None:
    from agent_team_backend.plugins.builtin.navide_plans import plan_mcp

    plan_mcp._record_message_sent("mcp-key", "beta/reviewer", "pa", "hi")
    plan_mcp.record_message_hold("mcp-key", {"key": "typing"})
    try:
        session = _session()
        await app.handle_message(session, {
            "id": "h2",
            "type": "agent_msg.hold_update",
            "payload": {"msg_key": "mcp-key", "hold": None},
        })

        assert plan_mcp._mcp_message_status["mcp-key"]["hold"] is None
    finally:
        plan_mcp._mcp_message_status.clear()


@pytest.mark.asyncio
async def test_hold_update_for_a_key_no_window_owns_is_not_an_error() -> None:
    """Every window reports for every tracked message it holds, exactly as it
    does for deliveries — the ones this backend never minted just miss."""
    session = _session()
    await app.handle_message(session, {
        "id": "h3",
        "type": "agent_msg.hold_update",
        "payload": {"msg_key": "not-ours", "hold": {"key": "typing"}},
    })

    sent = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert sent["error"] is None
    assert sent["payload"]["tracked"] is False


@pytest.mark.asyncio
async def test_hold_update_needs_a_msg_key() -> None:
    session = _session()
    await app.handle_message(session, {"id": "h4", "type": "agent_msg.hold_update", "payload": {}})

    assert session.websocket.sent[0]["error"]["code"] == "BAD_REQUEST"  # type: ignore[attr-defined]
