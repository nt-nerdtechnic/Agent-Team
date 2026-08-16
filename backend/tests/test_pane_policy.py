"""Receiver-side pane authorization: deny unless a rule says otherwise.

The policy arrives from the server verbatim and is written elsewhere, so these
tests care as much about hostile and malformed input as about the happy path:
nothing here may raise, and every ambiguity must resolve to a refusal.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from agent_team_backend import pane_policy

MEMBER = "member-1"
DEVICE = "device-a"
WORKSPACE = "Agent-Team"
PANE = "deploy"


def rule(
    member_id: str = MEMBER,
    device_id: str = DEVICE,
    workspace: str = WORKSPACE,
    pane_name: str = PANE,
    action: str = "allow",
) -> dict[str, Any]:
    return {
        "from": {"memberId": member_id, "deviceId": device_id},
        "to": {"workspace": workspace, "paneName": pane_name},
        "action": action,
    }


def policy(*rules: Any, version: Any = 1, default: Any = "deny") -> dict[str, Any]:
    return {"version": version, "default": default, "rules": list(rules)}


def allows(pol: Any, **overrides: str) -> bool:
    request = {
        "member_id": MEMBER,
        "device_id": DEVICE,
        "workspace": WORKSPACE,
        "pane_name": PANE,
    }
    request.update(overrides)
    return pane_policy.is_allowed(pol, **request)


# ── deny by default ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "pol",
    [
        None,
        {},
        [],
        "",
        "allow everything",
        42,
        {"version": 1},
        {"version": 1, "default": "deny"},
        policy(),
        policy(version=1, default="deny"),
    ],
    ids=[
        "none",
        "empty-object",
        "list",
        "empty-string",
        "string",
        "number",
        "no-rules-key",
        "no-rules-key-with-default",
        "empty-rules",
        "explicit-deny",
    ],
)
def test_a_policy_that_says_nothing_denies(pol: Any) -> None:
    assert allows(pol) is False


def test_the_server_default_for_an_unconfigured_device_denies() -> None:
    # policy.get returns an empty policy at revision 0 when nothing was ever set.
    assert allows({}) is False


# ── a single matching rule ──────────────────────────────────────────────────


def test_an_exact_rule_allows_its_own_request() -> None:
    assert allows(policy(rule())) is True


@pytest.mark.parametrize(
    "overrides",
    [
        {"member_id": "member-2"},
        {"device_id": "device-b"},
        {"workspace": "Other-Project"},
        {"pane_name": "scratch"},
    ],
    ids=["member", "device", "workspace", "pane"],
)
def test_one_differing_field_is_enough_to_deny(overrides: dict[str, str]) -> None:
    assert allows(policy(rule()), **overrides) is False


def test_a_later_rule_still_gets_its_chance() -> None:
    pol = policy(rule(pane_name="scratch"), rule(pane_name="build"), rule())
    assert allows(pol) is True


# ── wildcards ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("member_id", [MEMBER, "*"])
@pytest.mark.parametrize("device_id", [DEVICE, "*"])
@pytest.mark.parametrize("workspace", [WORKSPACE, "*"])
@pytest.mark.parametrize("pane_name", [PANE, "*"])
def test_every_wildcard_combination_over_a_matching_request_allows(
    member_id: str, device_id: str, workspace: str, pane_name: str
) -> None:
    pol = policy(rule(member_id, device_id, workspace, pane_name))
    assert allows(pol) is True


def test_a_wildcard_on_one_field_does_not_excuse_a_mismatch_on_another() -> None:
    pol = policy(rule(member_id="*", device_id="*", workspace="*"))
    assert allows(pol, pane_name="scratch") is False


def test_one_member_across_all_their_devices() -> None:
    pol = policy(rule(device_id="*", workspace="*", pane_name="*"))
    assert allows(pol, device_id="a-laptop-we-never-saw") is True
    assert allows(pol, member_id="someone-else") is False


def test_only_my_other_machine() -> None:
    pol = policy(rule(workspace="*", pane_name="*"))
    assert allows(pol) is True
    assert allows(pol, device_id="device-b") is False


# ── the wildcard is whole-field, not a glob ─────────────────────────────────


@pytest.mark.parametrize("pattern", ["dep*", "*loy", "de*oy", "*e*"])
def test_a_partial_pattern_is_a_literal_not_a_prefix_match(pattern: str) -> None:
    assert allows(policy(rule(pane_name=pattern)), pane_name="deploy") is False


def test_a_pane_actually_named_with_a_star_matches_literally() -> None:
    assert allows(policy(rule(pane_name="dep*")), pane_name="dep*") is True


# ── case sensitivity ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "overrides",
    [
        {"member_id": MEMBER.upper()},
        {"device_id": DEVICE.upper()},
        {"workspace": WORKSPACE.lower()},
        {"pane_name": PANE.upper()},
    ],
    ids=["member", "device", "workspace", "pane"],
)
def test_matching_is_case_sensitive(overrides: dict[str, str]) -> None:
    """Stays case-sensitive even though ``remote_roster.devices_named`` matches
    device *names* case-insensitively: that one only finds a machine to aim at,
    this one grants execution, and a wider match here is an over-grant."""
    assert allows(policy(rule()), **overrides) is False


def test_surrounding_whitespace_is_not_trimmed_away() -> None:
    assert allows(policy(rule(pane_name=" deploy ")), pane_name="deploy") is False


# ── malformed rules are skipped, the rest keeps working ─────────────────────


MALFORMED_RULES: list[Any] = [
    None,
    [],
    "allow",
    42,
    {},
    {"action": "allow"},
    {"from": {"memberId": MEMBER, "deviceId": DEVICE}, "action": "allow"},
    {"to": {"workspace": WORKSPACE, "paneName": PANE}, "action": "allow"},
    {"from": None, "to": {"workspace": "*", "paneName": "*"}, "action": "allow"},
    {"from": {"memberId": "*", "deviceId": "*"}, "to": "everything", "action": "allow"},
    {
        "from": {"memberId": "*"},
        "to": {"workspace": "*", "paneName": "*"},
        "action": "allow",
    },
    {
        "from": {"memberId": "*", "deviceId": 7},
        "to": {"workspace": "*", "paneName": "*"},
        "action": "allow",
    },
    {
        "from": {"memberId": "*", "deviceId": None},
        "to": {"workspace": "*", "paneName": "*"},
        "action": "allow",
    },
    rule(member_id=""),
    rule(device_id="   "),
    rule(workspace=""),
    rule(pane_name=""),
    rule(action="deny"),
    rule(action="Allow"),
    rule(action="ALLOW"),
    {"from": {"memberId": "*", "deviceId": "*"}, "to": {"workspace": "*", "paneName": "*"}},
]


@pytest.mark.parametrize("bad", MALFORMED_RULES)
def test_a_malformed_rule_never_allows(bad: Any) -> None:
    assert allows(policy(bad)) is False


@pytest.mark.parametrize("bad", MALFORMED_RULES)
def test_a_malformed_rule_does_not_void_the_good_one_next_to_it(bad: Any) -> None:
    assert allows(policy(bad, rule())) is True
    assert allows(policy(rule(), bad)) is True


@pytest.mark.parametrize("bad", MALFORMED_RULES)
def test_a_malformed_rule_never_raises(bad: Any) -> None:
    pane_policy.is_allowed(
        policy(bad), member_id="", device_id=None, workspace=[], pane_name=PANE
    )


def test_a_blank_pattern_does_not_match_a_blank_request_field() -> None:
    assert allows(policy(rule(pane_name="")), pane_name="") is False


def test_a_skipped_rule_is_visible_in_the_log(caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.pane_policy"):
        allows(policy("not a rule at all"))
    assert any(record.levelno == logging.WARNING for record in caplog.records)


# ── the rules key itself may be junk ────────────────────────────────────────


@pytest.mark.parametrize("rules", [None, "allow", 42, {}, {"0": rule()}])
def test_rules_that_are_not_a_list_deny(rules: Any) -> None:
    assert allows({"version": 1, "default": "deny", "rules": rules}) is False


def test_rules_that_are_not_a_list_are_reported(caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.pane_policy"):
        allows({"version": 1, "default": "deny", "rules": {"0": rule()}})
    assert any(record.levelno == logging.WARNING for record in caplog.records)


# ── unknown version is fail-closed ──────────────────────────────────────────


@pytest.mark.parametrize(
    "version",
    [None, 0, 2, 99, "1", "v1", 1.5, True, False, [1], {"major": 1}],
    ids=[
        "missing",
        "zero",
        "next",
        "far-future",
        "string",
        "prefixed",
        "float",
        "true",
        "false",
        "list",
        "object",
    ],
)
def test_an_unrecognised_version_denies_even_a_matching_rule(version: Any) -> None:
    assert allows(policy(rule(), version=version)) is False


def test_an_unrecognised_version_denies_even_with_default_allow() -> None:
    assert allows(policy(rule(), version=2, default="allow")) is False


def test_an_unrecognised_version_is_reported(caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.pane_policy"):
        allows(policy(rule(), version=2))
    assert any(record.levelno == logging.WARNING for record in caplog.records)


# ── the default field ───────────────────────────────────────────────────────


def test_default_allow_opens_the_machine_when_no_rule_matches() -> None:
    assert allows(policy(version=1, default="allow")) is True
    assert allows(policy(rule(pane_name="other"), default="allow")) is True


@pytest.mark.parametrize(
    "default", ["Allow", "ALLOW", " allow", "allow ", "yes", True, 1, None, ["allow"]]
)
def test_only_the_exact_string_allow_opens_the_fallback(default: Any) -> None:
    assert allows(policy(version=1, default=default)) is False


# ── an unattested source is never "any" ─────────────────────────────────────


@pytest.mark.parametrize(
    "overrides",
    [
        {"member_id": ""},
        {"member_id": "   "},
        {"device_id": ""},
        {"workspace": ""},
        {"pane_name": ""},
    ],
    ids=["no-member", "blank-member", "no-device", "no-workspace", "no-pane"],
)
def test_a_missing_request_field_is_denied_by_an_all_wildcard_rule(
    overrides: dict[str, str],
) -> None:
    pol = policy(rule(member_id="*", device_id="*", workspace="*", pane_name="*"))
    assert allows(pol, **overrides) is False


def test_a_missing_request_field_is_denied_under_default_allow() -> None:
    assert allows(policy(version=1, default="allow"), member_id="") is False


@pytest.mark.parametrize("value", [None, 42, [], {}, object()])
def test_a_non_string_request_field_denies_without_raising(value: Any) -> None:
    pol = policy(rule(member_id="*", device_id="*", workspace="*", pane_name="*"))
    assert pane_policy.is_allowed(
        pol, member_id=value, device_id=DEVICE, workspace=WORKSPACE, pane_name=PANE
    ) is False


def test_a_missing_request_field_is_reported(caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.pane_policy"):
        allows(policy(rule()), member_id="")
    assert any(record.levelno == logging.WARNING for record in caplog.records)
