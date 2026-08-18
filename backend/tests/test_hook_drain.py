"""Stop-hook delivery: POST /hooks/claude answering with a queued message.

The endpoint's ordinary job is to report that a turn ended. For a claude pane
it now also gets to answer "don't stop, do this instead", which is the only
delivery path that never touches the pane's input box. What is worth pinning
down here is the shape of that answer, and every way it must decline to give
one — because declining is what falls back to the existing stdin path, and a
wrong answer stalls the agent instead.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import agent_messaging, hook_drain
from agent_team_backend import app as app_module
from agent_team_backend.app import app


class FakeWindow:
    """Stands in for the renderer window that owns a pane.

    `answer` is the envelope it replies with; None means it never replies at
    all, which is the timeout case.
    """

    def __init__(self, answer: str | None = "") -> None:
        self.answer = answer
        self.requests: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        payload = data.get("payload") or {}
        self.requests.append(payload)
        if self.answer is None:
            return
        hook_drain.resolve_drain(str(payload.get("request_id")), {"envelope": self.answer})


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture()
def events(monkeypatch) -> list[dict]:
    captured: list[dict] = []

    async def fake_broadcast(event, **_kwargs):
        captured.append(event)

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    return captured


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    agent_messaging._reset_for_test()
    hook_drain._reset_for_test()
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pane-1", "/ws/alpha", "")
    )
    yield
    agent_messaging._reset_for_test()
    hook_drain._reset_for_test()
    app_module._pane_activity.clear()


def _stop(client: TestClient, **payload: Any):
    body = {"session_id": "s-1", "cwd": "/ws/alpha", **payload}
    return client.post("/hooks/claude", headers={"X-Agent-Team-Event": "stop"}, json=body)


def _register(window: FakeWindow, agent_key: str = "claude") -> None:
    agent_messaging.register("pane-1", "worker", "/ws/alpha", agent_key=agent_key, owner=window)


def test_a_waiting_message_comes_back_as_the_stop_hook_decision(
    client: TestClient, events: list[dict]
) -> None:
    window = FakeWindow("[Navide MSG] from: builder\nrun the suite")
    _register(window)

    resp = _stop(client)

    assert resp.status_code == 200
    assert resp.json() == {
        "decision": "block",
        "reason": "[Navide MSG] from: builder\nrun the suite",
    }
    assert window.requests[0]["pane_id"] == "pane-1"


def test_a_blocked_stop_is_not_reported_as_the_turn_ending(
    client: TestClient, events: list[dict]
) -> None:
    """Claude did not stop — it took the message and kept going. Broadcasting
    turn_complete would make the frontend call the pane idle and start typing
    the NEXT queued message into a pane that is already working."""
    _register(FakeWindow("envelope"))

    _stop(client)

    payload = events[-1]["payload"]
    assert payload["event_type"] == "agent_active"
    assert payload["detail"] == "hook:stop-blocked"
    assert app_module._pane_activity["pane-1"]["event_type"] == "agent_active"


def test_nothing_queued_leaves_the_hook_with_no_decision_to_report(
    client: TestClient, events: list[dict]
) -> None:
    """An empty body is what Claude Code reads as "no decision". Answering the
    ordinary `{"ok": true}` here would be an unrecognized object on the hook's
    stdout, which it reports to the user as a hook error."""
    _register(FakeWindow(""))

    resp = _stop(client)

    assert resp.status_code == 200
    assert resp.content == b""
    assert events[-1]["payload"]["event_type"] == "turn_complete"


def test_a_window_that_never_answers_lets_the_turn_end(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    monkeypatch.setattr(hook_drain, "DRAIN_TIMEOUT_S", 0.05)
    _register(FakeWindow(None))

    resp = _stop(client)

    assert resp.content == b""
    assert events[-1]["payload"]["event_type"] == "turn_complete"


def test_a_pane_running_another_cli_is_never_asked(
    client: TestClient, events: list[dict]
) -> None:
    # Only claude's Stop hook can block, so asking anyone else would be a
    # round-trip whose answer could not be used.
    window = FakeWindow("envelope")
    _register(window, agent_key="codex")

    resp = _stop(client)

    assert window.requests == []
    assert resp.content == b""
    assert events[-1]["payload"]["event_type"] == "turn_complete"


def test_an_unattributed_session_is_never_asked(client: TestClient, events: list[dict], monkeypatch) -> None:
    # Stop can arrive before the JSONL reader claimed the session; there is no
    # pane, so there is no queue to look in.
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: (None, None, None)
    )
    window = FakeWindow("envelope")
    _register(window)

    resp = _stop(client)

    assert window.requests == []
    assert resp.content == b""


def test_consecutive_hook_deliveries_stop_at_the_cap(
    client: TestClient, events: list[dict]
) -> None:
    """Claude Code ends the turn itself after 8 consecutive blocks. Stopping
    first keeps the limit ours: the pane goes idle and the rest of its queue
    goes out over stdin, instead of the CLI overriding a hook."""
    _register(FakeWindow("envelope"))

    blocked = 0
    for _ in range(hook_drain.MAX_CONSECUTIVE + 2):
        resp = _stop(client, stop_hook_active=blocked > 0)
        if resp.content:
            blocked += 1
        else:
            break

    assert blocked == hook_drain.MAX_CONSECUTIVE


def test_a_turn_the_user_ended_restarts_the_streak(client: TestClient, events: list[dict]) -> None:
    """`stop_hook_active` is false on a turn that ended on its own, so the cap
    counts consecutive hook deliveries rather than lifetime ones."""
    _register(FakeWindow("envelope"))

    for _ in range(hook_drain.MAX_CONSECUTIVE - 1):
        assert _stop(client, stop_hook_active=True).content

    assert _stop(client, stop_hook_active=False).content
    assert _stop(client, stop_hook_active=True).content


def test_another_vendors_stop_hook_still_gets_its_plain_ack(
    client: TestClient, events: list[dict]
) -> None:
    # qwen shares the hook endpoint and the curl builder, but its hook command
    # discards the body — the decision contract is claude's alone.
    agent_messaging.register("pane-1", "worker", "/ws/alpha", agent_key="qwen", owner=FakeWindow("x"))

    resp = client.post("/hooks/qwen", headers={"X-Agent-Team-Event": "stop"}, json={"session_id": "s-1"})

    assert resp.json() == {"ok": True}


def test_a_pane_no_window_mirrors_is_never_asked(client: TestClient, events: list[dict]) -> None:
    # Registered without an owner: nobody holds its queue, so there is no one
    # to ask and the hook must not sit out its timeout.
    agent_messaging.register("pane-1", "worker", "/ws/alpha", agent_key="claude")

    resp = _stop(client)

    assert resp.content == b""


# ── The reader's own turn end for a turn we blocked ────────────────────────
# Claude Code still writes the blocked turn to its conversation log, and the
# JSONL reader reports it as a turn end — arriving AFTER the hook already said
# the agent is working. Believing it would call the pane idle and start typing
# the next queued message into a pane acting on the one it just took.


def _activity(pane_id: str = "pane-1", event_type: str = "turn_complete"):
    from types import SimpleNamespace

    from agent_team_backend.log_readers.base import ActivityEvent

    event = ActivityEvent(
        vendor="claude",
        event_type=event_type,
        cwd="/ws/alpha",
        session_id="s-1",
        file_path="/logs/s-1.jsonl",
        dedup_key="d-1",
        timestamp="2026-08-17T00:00:00Z",
        detail="assistant",
        text="what the agent said",
    )
    attributed = SimpleNamespace(pane_id=pane_id, workspace_path="/ws/alpha", stage_id=None)
    return event, attributed


def _patch_attribution(monkeypatch, pane_id: str = "pane-1") -> None:
    _event, attributed = _activity(pane_id)
    monkeypatch.setattr(app_module.attribution, "attribute", lambda _usage: attributed)


async def _emit_activity(events: list[dict], pane_id: str = "pane-1") -> dict:
    event, _attributed = _activity(pane_id)
    await app_module._on_log_activity(event)
    return events[-1]["payload"]


def _run_activity(monkeypatch, events: list[dict], pane_id: str = "pane-1") -> dict:
    _patch_attribution(monkeypatch, pane_id)
    return asyncio.run(_emit_activity(events, pane_id))


def test_a_reader_turn_end_arriving_just_after_a_block_is_flagged_superseded(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    _register(FakeWindow("envelope"))
    _stop(client)
    events.clear()
    # 5s later — well inside the window.
    hook_drain._blocked_at["pane-1"] = time.monotonic() - 5

    payload = _run_activity(monkeypatch, events)

    assert payload["superseded"] is True
    # Not relabelled: the turn's text, and the MSG blocks and sentinels read out
    # of it, are real whether or not the turn ended.
    assert payload["event_type"] == "turn_complete"
    assert payload["text"] == "what the agent said"
    # cli_wait_idle reads this, and must not call the pane idle either.
    assert app_module._pane_activity["pane-1"]["event_type"] == "agent_active"


def test_a_reader_turn_end_long_after_a_block_is_believed(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    _register(FakeWindow("envelope"))
    _stop(client)
    events.clear()
    hook_drain._blocked_at["pane-1"] = time.monotonic() - 20

    payload = _run_activity(monkeypatch, events)

    assert payload["superseded"] is False
    assert app_module._pane_activity["pane-1"]["event_type"] == "turn_complete"
    # Expired marks are dropped rather than re-tested for the life of the pane.
    assert "pane-1" not in hook_drain._blocked_at


def test_a_reader_turn_end_arriving_while_the_hook_waits_is_already_superseded(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """The ask takes up to DRAIN_TIMEOUT_S, and the log record for the very turn
    being decided lands inside it. Marking only after the answer left that
    record believed — the pane read as idle for a moment, and chimed done."""
    seen: list[dict] = []

    class RacingWindow(FakeWindow):
        async def send_json(self, data: dict[str, Any]) -> None:
            # The reader's own turn end, mid-ask.
            seen.append(await _emit_activity(events))
            await super().send_json(data)

    _patch_attribution(monkeypatch)
    _register(RacingWindow("envelope"))

    _stop(client)

    assert seen and seen[0]["superseded"] is True


def test_a_stop_that_was_allowed_through_retires_the_mark_early(
    client: TestClient, events: list[dict]
) -> None:
    """The Stop hook is the authoritative signal. Once one is allowed through,
    the pane really did stop and the next turn end is its own, not ours."""
    window = FakeWindow("envelope")
    _register(window)
    _stop(client)
    assert hook_drain.turn_end_is_superseded("pane-1") is True

    window.answer = ""
    _stop(client, stop_hook_active=True)

    assert hook_drain.turn_end_is_superseded("pane-1") is False


def test_a_pane_that_was_never_blocked_is_never_flagged(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    payload = _run_activity(monkeypatch, events)

    assert payload["superseded"] is False


def test_forgetting_a_pane_clears_its_streak() -> None:
    asyncio.run(_drain_once())
    assert hook_drain._consecutive.get("pane-1") == 1
    app_module.forget_pane_activity("pane-1")
    assert "pane-1" not in hook_drain._consecutive


async def _drain_once() -> None:
    _register(FakeWindow("envelope"))
    assert await hook_drain.drain_for_stop_hook("pane-1", stop_hook_active=False) == "envelope"
