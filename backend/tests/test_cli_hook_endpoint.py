"""Tests for POST /hooks/{vendor} — the CLI hook receiver.

The endpoint's job is to turn a CLI's lifecycle hook into an `agent.activity`
broadcast. What matters most here is `notification_type`: it is the only signal
that separates "the CLI is parked on the user" from "the CLI finished its
turn", which are indistinguishable on the PTY.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app as app_module
from agent_team_backend.app import app


@pytest.fixture()
def client() -> TestClient:
    # No context manager: startup events (watchers/MCP) must not run in tests.
    return TestClient(app)


@pytest.fixture()
def events(monkeypatch) -> list[dict]:
    """Capture the events the handler broadcasts instead of sending them."""
    captured: list[dict] = []

    async def fake_broadcast(event, **_kwargs):
        captured.append(event)

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    return captured


def _payload(events: list[dict]) -> dict:
    assert len(events) == 1, f"expected exactly one broadcast, got {len(events)}"
    return events[0]["payload"]


def test_notification_forwards_the_type_that_distinguishes_waiting_from_done(
    client: TestClient, events: list[dict]
) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "s-1", "cwd": "/tmp/ws", "notification_type": "permission_prompt"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    payload = _payload(events)
    assert payload["vendor"] == "claude"
    assert payload["event_type"] == "agent_active"
    assert payload["detail"] == "hook:notification"
    assert payload["notification_type"] == "permission_prompt"


def test_idle_prompt_is_forwarded_verbatim_for_the_frontend_to_reject(
    client: TestClient, events: list[dict]
) -> None:
    # The backend does not editorialize: idle_prompt reaches the frontend as
    # itself, and the AWAITING decision (which excludes it) lives there.
    client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "s-1", "cwd": "/tmp/ws", "notification_type": "idle_prompt"},
    )
    assert _payload(events)["notification_type"] == "idle_prompt"


@pytest.mark.parametrize("vendor", ["qwen", "copilot"])
def test_other_vendors_reach_the_same_handler_and_keep_their_label(
    client: TestClient, events: list[dict], vendor: str
) -> None:
    resp = client.post(
        f"/hooks/{vendor}",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "v-1", "cwd": "/tmp/ws", "notification_type": "permission_prompt"},
    )
    assert resp.status_code == 200
    payload = _payload(events)
    assert payload["vendor"] == vendor
    assert payload["notification_type"] == "permission_prompt"


def test_copilots_camelcase_session_id_is_understood(
    client: TestClient, events: list[dict]
) -> None:
    # Copilot sends sessionId; Claude and Qwen send session_id. Attribution
    # keys off this value, so reading only one spelling would silently drop
    # every Copilot event.
    client.post(
        "/hooks/copilot",
        headers={"X-Agent-Team-Event": "notification"},
        json={"sessionId": "cp-1", "cwd": "/tmp/ws", "notification_type": "permission_prompt"},
    )
    assert _payload(events)["session_id"] == "cp-1"


def test_missing_notification_type_becomes_empty_not_absent(
    client: TestClient, events: list[dict]
) -> None:
    # Older CLI builds omit the field; the key must still exist so the frontend
    # reads "" (not awaiting) rather than tripping on undefined.
    client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "stop"},
        json={"session_id": "s-1", "cwd": "/tmp/ws"},
    )
    payload = _payload(events)
    assert payload["event_type"] == "turn_complete"
    assert payload["notification_type"] == ""


def test_unknown_vendor_is_rejected_without_broadcasting(
    client: TestClient, events: list[dict]
) -> None:
    resp = client.post(
        "/hooks/some-other-cli",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "x", "notification_type": "permission_prompt"},
    )
    assert resp.json()["ok"] is False
    assert events == []


def test_unknown_event_kind_is_rejected_without_broadcasting(
    client: TestClient, events: list[dict]
) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "something_new"},
        json={"session_id": "s-1"},
    )
    assert resp.json()["ok"] is False
    assert events == []
