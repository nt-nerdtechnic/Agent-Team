"""Trust rings, the block list, and the ledger of refused knocks."""

from __future__ import annotations

import time

import pytest

from agent_team_backend import device_trust

ME = "m-mine"
MY_LAPTOP = "dev-my-laptop"
THEIRS = "m-theirs"
THEIR_BOX = "dev-their-box"


def _policy(**extra):
    return {"version": 1, "default": "deny", "rules": [], **extra}


# ---- rings -------------------------------------------------------------------


def test_my_own_device_is_its_own_ring() -> None:
    """Signing one account in twice is the grant; no rule stands between them."""
    assert (
        device_trust.ring(_policy(), member_id=ME, device_id=MY_LAPTOP, own_member_id=ME)
        == device_trust.RING_SELF
    )


def test_another_member_is_left_to_the_rules() -> None:
    assert (
        device_trust.ring(_policy(), member_id=THEIRS, device_id=THEIR_BOX, own_member_id=ME)
        == device_trust.RING_MEMBER
    )


def test_an_empty_member_id_is_never_me() -> None:
    """A message with no attested sender must not fall into the trusted ring —
    that ring skips authorization entirely."""
    assert (
        device_trust.ring(_policy(), member_id="", device_id=THEIR_BOX, own_member_id=ME)
        == device_trust.RING_MEMBER
    )
    assert (
        device_trust.ring(_policy(), member_id=ME, device_id=MY_LAPTOP, own_member_id="")
        == device_trust.RING_MEMBER
    )


def test_a_block_beats_the_own_device_shortcut() -> None:
    """The case this ordering exists for: a laptop of your own that walked off.
    Nothing else in the system can take reach away from a device that shares
    your member id."""
    policy = _policy(blocked=[{"deviceId": MY_LAPTOP, "reason": "stolen"}])
    assert (
        device_trust.ring(policy, member_id=ME, device_id=MY_LAPTOP, own_member_id=ME)
        == device_trust.RING_BLOCKED
    )


def test_blocking_a_member_covers_every_device_they_use() -> None:
    """An entry that had to match member *and* device would silently stop
    working the moment the blocked person opened a different machine."""
    policy = _policy(blocked=[{"memberId": THEIRS}])
    assert (
        device_trust.ring(policy, member_id=THEIRS, device_id="dev-new", own_member_id=ME)
        == device_trust.RING_BLOCKED
    )


def test_unreadable_policy_lands_in_the_ring_that_decides_nothing() -> None:
    """Garbage must not grant (self) and must not refuse (blocked): it hands
    the decision to pane_policy, which denies by default."""
    for junk in (None, [], "blocked", 7, {"blocked": "everyone"}, {"blocked": [7, None]}):
        assert (
            device_trust.ring(junk, member_id=THEIRS, device_id=THEIR_BOX, own_member_id=ME)
            == device_trust.RING_MEMBER
        )


def test_block_list_is_read_back_for_the_editor() -> None:
    policy = _policy(
        blocked=[
            {"deviceId": THEIR_BOX, "deviceName": "their box", "at": "2026-08-30", "reason": "x"},
            {"memberId": THEIRS},
            {"note": "no id at all"},
            "not an object",
        ]
    )
    rows = device_trust.blocked_entries(policy)
    assert [r["deviceId"] for r in rows] == [THEIR_BOX, ""]
    assert rows[0]["deviceName"] == "their box"
    assert rows[1]["memberId"] == THEIRS


# ---- the write path ----------------------------------------------------------


def test_validate_accepts_a_policy_with_no_block_list() -> None:
    """The field is optional: every policy written before it existed is valid,
    and an older build ignoring it keeps exactly today's behaviour."""
    assert device_trust.validate_blocked(_policy()) == ""


@pytest.mark.parametrize(
    "policy, fragment",
    [
        ({"blocked": "nope"}, "must be a list"),
        ({"blocked": [7]}, "must be an object"),
        ({"blocked": [{"reason": "x"}]}, "needs a deviceId or a memberId"),
        ({"blocked": [{"deviceId": "  "}]}, "needs a deviceId or a memberId"),
    ],
)
def test_validate_refuses_a_row_this_build_would_skip(policy, fragment) -> None:
    """A row is_blocked would skip is a refusal the user believes they made."""
    assert fragment in device_trust.validate_blocked(policy)


# ---- the knock ledger --------------------------------------------------------


def _requests() -> device_trust.AccessRequests:
    return device_trust.AccessRequests()


def _knock(ledger, *, pane="reviewer", device=THEIR_BOX, name="their box"):
    return ledger.record(
        member_id=THEIRS, device_id=device, device_name=name, workspace="proj", pane_name=pane
    )


def test_a_retry_refreshes_one_row_instead_of_adding_another() -> None:
    """A loop on the other end must not evict the requests a person still has
    to look at."""
    ledger = _requests()
    _knock(ledger)
    row = _knock(ledger)
    assert len(ledger.list()) == 1
    assert row["attempts"] == 2


def test_a_different_pane_is_a_different_request() -> None:
    ledger = _requests()
    _knock(ledger, pane="reviewer")
    _knock(ledger, pane="deployer")
    assert {r["paneName"] for r in ledger.list()} == {"reviewer", "deployer"}


def test_a_renamed_device_shows_the_name_it_answers_to_now() -> None:
    ledger = _requests()
    _knock(ledger, name="old name")
    _knock(ledger, name="new name")
    assert ledger.list()[0]["deviceName"] == "new name"
    # ...but a later knock the directory cannot name must not blank it out.
    _knock(ledger, name="")
    assert ledger.list()[0]["deviceName"] == "new name"


def test_newest_knock_is_listed_first() -> None:
    ledger = _requests()
    _knock(ledger, pane="first")
    time.sleep(0.01)
    _knock(ledger, pane="second")
    assert ledger.list()[0]["paneName"] == "second"


def test_forget_is_idempotent_so_a_stale_second_click_is_harmless() -> None:
    ledger = _requests()
    key = _knock(ledger)["key"]
    assert ledger.forget(key) is True
    assert ledger.forget(key) is False


def test_forgetting_a_device_clears_everything_it_had_waiting() -> None:
    """What blocking a device means for the knocks it left behind."""
    ledger = _requests()
    _knock(ledger, pane="a")
    _knock(ledger, pane="b")
    _knock(ledger, device="dev-other", pane="c")
    assert ledger.forget_device(THEIR_BOX) == 2
    assert [r["deviceId"] for r in ledger.list()] == ["dev-other"]


def test_the_ledger_is_bounded() -> None:
    """It is fed by a remote peer, so an unbounded map is a leak with a sender
    attached to it."""
    ledger = _requests()
    for i in range(device_trust.REQUESTS_MAX + 25):
        _knock(ledger, pane=f"pane-{i}")
    assert len(ledger.list()) <= device_trust.REQUESTS_MAX


def test_old_knocks_age_out(monkeypatch) -> None:
    ledger = _requests()
    _knock(ledger)
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + device_trust.REQUESTS_TTL_S + 1)
    assert ledger.list() == []
