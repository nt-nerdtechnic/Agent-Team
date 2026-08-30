"""The handlers behind the trust surface: knocks, approve, block, unblock.

These drive the real dispatcher, so they also cover the wiring — a handler that
was never registered fails here rather than silently in production.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, device_trust, server_link, ws_handlers

pytestmark = pytest.mark.asyncio

THEIRS = "m-theirs"
THEIR_BOX = "dev-their-box"


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def _call(msg_type: str, payload: dict) -> dict:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "x1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


class FakeLink:
    """Stands in for a connected ServerLink: holds one policy document and the
    knock ledger, and records what would have been written."""

    def __init__(self, policy: Any = None, *, editable: bool = True) -> None:
        self.policy = policy
        self.editable = editable
        self.writes: list[Any] = []
        self.requests = device_trust.AccessRequests()

    async def policy_state(self) -> dict:
        return {
            "state": "connected" if self.editable else "unconfigured",
            "editable": self.editable,
            "policy": self.policy,
            "revision": 1,
            "deviceId": "dev-mine",
            "memberId": "m-mine",
        }

    async def set_policy(self, policy: Any) -> dict:
        self.writes.append(policy)
        self.policy = policy
        return {"ok": True, "payload": {"revision": len(self.writes) + 1}}


@pytest.fixture
def link(monkeypatch):
    fake = FakeLink()
    monkeypatch.setattr(server_link, "policy_state", fake.policy_state)
    monkeypatch.setattr(server_link, "set_policy", fake.set_policy)
    monkeypatch.setattr(server_link, "access_requests", fake.requests.list)
    monkeypatch.setattr(server_link, "forget_access_request", fake.requests.forget)
    monkeypatch.setattr(server_link, "forget_access_requests_for_device", fake.requests.forget_device)
    monkeypatch.setattr(ws_handlers.remote_roster, "list_devices", lambda: [])

    broadcast_calls: list[dict] = []

    async def fake_broadcast(event: dict, **_kwargs) -> None:
        broadcast_calls.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    fake.broadcasts = broadcast_calls  # type: ignore[attr-defined]
    return fake


def _knock(fake: FakeLink, *, pane: str = "reviewer", device: str = THEIR_BOX) -> str:
    return fake.requests.record(
        member_id=THEIRS,
        device_id=device,
        device_name="their box",
        workspace="proj",
        pane_name=pane,
    )["key"]


# ---- reading -----------------------------------------------------------------


async def test_the_knock_list_is_readable(link) -> None:
    _knock(link)
    reply = await _call("p2p.access_requests.list", {})
    assert reply["ok"] is True
    assert [r["paneName"] for r in reply["payload"]["requests"]] == ["reviewer"]


# ---- approving ---------------------------------------------------------------


async def test_approving_writes_one_narrow_allow_rule(link) -> None:
    """The grant is exactly as wide as the knock was. Widening it to a wildcard
    is an edit made in the editor, where the user can see what they widened."""
    key = _knock(link)
    reply = await _call("p2p.access_requests.approve", {"key": key})
    assert reply["ok"] is True
    assert link.writes[-1]["rules"] == [
        {
            "from": {"memberId": THEIRS, "deviceId": THEIR_BOX},
            "to": {"workspace": "proj", "paneName": "reviewer"},
            "action": "allow",
        }
    ]
    # The rule it wrote must be one the enforcement side actually honours —
    # a grant this build would skip is a permission the user believes they gave.
    from agent_team_backend import pane_policy

    assert pane_policy.validate(link.writes[-1]) == ""
    assert pane_policy.is_allowed(
        link.writes[-1],
        member_id=THEIRS,
        device_id=THEIR_BOX,
        workspace="proj",
        pane_name="reviewer",
    )


async def test_approving_one_pane_grants_nothing_next_door(link) -> None:
    key = _knock(link, pane="reviewer")
    await _call("p2p.access_requests.approve", {"key": key})
    from agent_team_backend import pane_policy

    assert not pane_policy.is_allowed(
        link.writes[-1],
        member_id=THEIRS,
        device_id=THEIR_BOX,
        workspace="proj",
        pane_name="deployer",
    )


async def test_approving_clears_the_knock_and_tells_the_windows(link) -> None:
    key = _knock(link)
    await _call("p2p.access_requests.approve", {"key": key})
    assert link.requests.list() == []
    assert any(e["type"] == "p2p.access_requests.changed" for e in link.broadcasts)


async def test_approving_the_same_knock_twice_is_refused_not_duplicated(link) -> None:
    """What a second click on a stale list looks like."""
    key = _knock(link)
    await _call("p2p.access_requests.approve", {"key": key})
    again = await _call("p2p.access_requests.approve", {"key": key})
    assert again["ok"] is False
    assert again["error"]["code"] == "NOT_FOUND"
    assert len(link.writes) == 1


async def test_approving_keeps_the_rules_that_were_already_there(link) -> None:
    existing = {
        "from": {"memberId": "m-other", "deviceId": "dev-other"},
        "to": {"workspace": "*", "paneName": "*"},
        "action": "allow",
    }
    link.policy = {"version": 1, "default": "deny", "rules": [existing]}
    key = _knock(link)
    await _call("p2p.access_requests.approve", {"key": key})
    assert existing in link.writes[-1]["rules"]
    assert len(link.writes[-1]["rules"]) == 2


async def test_approving_does_not_mutate_the_cached_policy_in_place(link) -> None:
    """The cache is what authorization reads; a half-built document must never
    become the live one if the write fails."""
    cached = {"version": 1, "default": "deny", "rules": []}
    link.policy = cached
    key = _knock(link)
    await _call("p2p.access_requests.approve", {"key": key})
    assert cached["rules"] == []


# ---- dismissing --------------------------------------------------------------


async def test_dismissing_grants_nothing(link) -> None:
    key = _knock(link)
    reply = await _call("p2p.access_requests.dismiss", {"key": key})
    assert reply["payload"]["forgotten"] is True
    assert link.writes == []
    assert link.requests.list() == []


# ---- blocking ----------------------------------------------------------------


async def test_blocking_a_device_writes_a_block_and_clears_its_knocks(link) -> None:
    _knock(link, pane="a")
    _knock(link, pane="b")
    _knock(link, device="dev-someone-else", pane="c")
    reply = await _call("p2p.trust.block", {"deviceId": THEIR_BOX, "reason": "stolen"})
    assert reply["ok"] is True
    assert device_trust.is_blocked(link.writes[-1], member_id="", device_id=THEIR_BOX)
    # Blocking stops this machine being asked about that device.
    assert [r["deviceId"] for r in link.requests.list()] == ["dev-someone-else"]


async def test_blocking_needs_something_to_block(link) -> None:
    reply = await _call("p2p.trust.block", {})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "BAD_REQUEST"
    assert link.writes == []


async def test_blocking_twice_does_not_stack_entries(link) -> None:
    await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    assert len(link.writes[-1]["blocked"]) == 1


async def test_a_written_block_is_one_the_enforcement_side_reads(link) -> None:
    """The write path and the read path must agree, or the user is looking at a
    refusal that is not happening."""
    await _call("p2p.trust.block", {"memberId": THEIRS})
    written = link.writes[-1]
    assert device_trust.validate_blocked(written) == ""
    assert (
        device_trust.ring(
            written, member_id=THEIRS, device_id="dev-anything", own_member_id="m-mine"
        )
        == device_trust.RING_BLOCKED
    )


async def test_unblocking_lifts_the_refusal_without_granting_anything(link) -> None:
    await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    await _call("p2p.trust.unblock", {"deviceId": THEIR_BOX})
    written = link.writes[-1]
    assert not device_trust.is_blocked(written, member_id=THEIRS, device_id=THEIR_BOX)
    # Back to being decided by the rules, which deny by default.
    from agent_team_backend import pane_policy

    assert not pane_policy.is_allowed(
        written, member_id=THEIRS, device_id=THEIR_BOX, workspace="proj", pane_name="reviewer"
    )


async def test_a_corrupt_block_list_is_replaced_rather_than_crashing(link) -> None:
    """The document is stored verbatim by the server, so it can hold whatever
    another client wrote. The read side skips what it cannot parse; the write
    side has to survive appending to it."""
    link.policy = {"version": 1, "default": "deny", "rules": [], "blocked": "everyone"}
    reply = await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    assert reply["ok"] is True
    assert [b["deviceId"] for b in link.writes[-1]["blocked"]] == [THEIR_BOX]


async def test_unblocking_survives_a_corrupt_block_list(link) -> None:
    link.policy = {"version": 1, "default": "deny", "rules": [], "blocked": 7}
    reply = await _call("p2p.trust.unblock", {"deviceId": THEIR_BOX})
    assert reply["ok"] is True
    assert link.writes[-1]["blocked"] == []


async def test_a_policy_that_cannot_be_written_is_refused_before_it_is_sent(link) -> None:
    """An offline or unconfigured link can show its cached rules and must not
    pretend to have saved a change to them."""
    link.editable = False
    reply = await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    assert reply["ok"] is False
    assert link.writes == []
