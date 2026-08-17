"""agent_msg.push handler: the transport half of push delivery.

The window that owns a pane decides whether to push — it holds the queue, the
rate limit and the idle gate — so this handler only performs the transport and
reports whether it landed. Two things it must get right: a refusal has to come
back as a plain `ok: false` (the window then types the message in, and a raised
error would strand it), and a push that DID land has to say the pane is now
working, or the window keeps calling it idle and types the next message into a
pane already acting on this one.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, push_delivery
from agent_team_backend.cli_vendors.base import PushChannel


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.fixture()
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    captured: list[dict] = []

    async def fake_broadcast(event, **_kwargs):
        captured.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return captured


@pytest.fixture(autouse=True)
def clean_state():
    push_delivery._reset_for_test()
    app._pane_activity.clear()
    yield
    push_delivery._reset_for_test()
    app._pane_activity.clear()


async def _push(session: app.Session, **payload: Any) -> dict[str, Any]:
    await app.handle_message(session, {
        "id": "m1", "type": "agent_msg.push", "payload": payload,
    })
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


def _arm_hook_pane(pane_id: str = "pane-1") -> None:
    push_delivery._panes[pane_id] = push_delivery.PaneChannel(
        pane_id=pane_id,
        agent_key="claude",
        kind=push_delivery.KIND_HOOK,
        channel=PushChannel(holds_input_box=False, hook_wait=True),
    )


@pytest.mark.asyncio
async def test_a_landed_push_is_reported_with_its_channel(broadcasts) -> None:
    _arm_hook_pane()
    armed = push_delivery.arm_hook("pane-1")
    assert armed is not None
    session = _session()
    response = await _push(session, pane_id="pane-1", text="hello")
    assert response["payload"] == {
        "ok": True, "kind": "rewake", "reason": "", "unclear": False,
    }


@pytest.mark.asyncio
async def test_a_landed_push_says_the_pane_is_now_working(broadcasts) -> None:
    _arm_hook_pane()
    push_delivery.arm_hook("pane-1")
    await _push(_session(), pane_id="pane-1", text="hello")
    activity = [e["payload"] for e in broadcasts if e["type"] == "agent.activity"]
    assert activity and activity[-1]["event_type"] == "agent_active"
    assert activity[-1]["pane_id"] == "pane-1"
    assert activity[-1]["detail"] == "push:rewake"
    # The same record cli_wait_idle reads, so it cannot call the pane idle.
    assert app._pane_activity["pane-1"]["event_type"] == "agent_active"


@pytest.mark.asyncio
async def test_a_refused_push_reports_ok_false_and_says_nothing_about_activity(
    broadcasts,
) -> None:
    _arm_hook_pane()  # registered, but no waiter parked
    session = _session()
    response = await _push(session, pane_id="pane-1", text="hello")
    assert response["payload"]["ok"] is False
    assert response["payload"]["reason"] == "not-armed"
    assert [e for e in broadcasts if e["type"] == "agent.activity"] == []


@pytest.mark.asyncio
async def test_a_pane_with_no_channel_is_refused_rather_than_erroring(broadcasts) -> None:
    session = _session()
    response = await _push(session, pane_id="unknown", text="hello")
    assert response["payload"] == {
        "ok": False, "kind": "", "reason": "no-channel", "unclear": False,
    }


@pytest.mark.asyncio
async def test_a_failure_that_may_have_left_text_behind_says_so(broadcasts) -> None:
    """`unclear` is what stops the window typing the same envelope in on top of
    a composer that is still holding it."""
    push_delivery._panes["pane-1"] = push_delivery.PaneChannel(
        pane_id="pane-1",
        agent_key="opencode",
        kind=push_delivery.KIND_HTTP,
        channel=PushChannel(
            holds_input_box=True,
            port_flag="--port",
            append_path="/tui/append-prompt",
            submit_path="/tui/submit-prompt",
            clear_path="/tui/clear-prompt",
        ),
        port=1,  # nothing is listening; the append fails before any text lands
    )
    response = await _push(_session(), pane_id="pane-1", text="hello")
    assert response["payload"]["ok"] is False
    assert response["payload"]["reason"] == "not-listening"
    assert response["payload"]["unclear"] is False


@pytest.mark.asyncio
async def test_a_malformed_request_is_an_error(broadcasts) -> None:
    session = _session()
    response = await _push(session, pane_id="", text="hello")
    assert response.get("error", {}).get("code") == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_registering_tells_a_reloaded_window_the_channel_is_still_there(
    broadcasts,
) -> None:
    """A window that reloaded, or reattached to a PTY it did not spawn, never
    saw the announcement made at spawn — and would keep typing into a pane it
    could push to for as long as it lives."""
    from agent_team_backend import agent_messaging

    agent_messaging._reset_for_test()
    _arm_hook_pane()
    push_delivery.arm_hook("pane-1")
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "pane-1",
            "name": "worker",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
        },
    })
    events = [
        f for f in session.websocket.sent  # type: ignore[attr-defined]
        if f.get("type") == "agent_msg.push_state"
    ]
    assert events and events[0]["payload"] == {
        "pane_id": "pane-1", "kind": "rewake", "ready": True,
    }
    agent_messaging._reset_for_test()


@pytest.mark.asyncio
async def test_registering_says_nothing_for_a_pane_with_no_live_channel(
    broadcasts,
) -> None:
    from agent_team_backend import agent_messaging

    agent_messaging._reset_for_test()
    _arm_hook_pane()  # registered, but nothing parked on it
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "pane-1",
            "name": "worker",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
        },
    })
    assert not [
        f for f in session.websocket.sent  # type: ignore[attr-defined]
        if f.get("type") == "agent_msg.push_state"
    ]
    agent_messaging._reset_for_test()
