from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app


@pytest.mark.asyncio
async def test_credential_request_and_cancellation_echo_the_operation_owner_nonce(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)
    request = app.build_credential_request_emitter("/workspace", "owner-nonce")
    settled = app.build_credential_settled_emitter("/workspace", "owner-nonce")

    await request("request-1", "Username for 'https://github.com':")
    await settled("request-1", None)

    assert [(event["type"], event["payload"]) for event in events] == [
        (
            "git.credential_request",
            {
                "request_id": "request-1",
                "workspace_path": "/workspace",
                "host": "github.com",
                "prompt": "Username for 'https://github.com':",
                "credential_owner_nonce": "owner-nonce",
            },
        ),
        (
            "git.credential_cancelled",
            {
                "request_id": "request-1",
                "workspace_path": "/workspace",
                "credential_owner_nonce": "owner-nonce",
            },
        ),
    ]


@pytest.mark.asyncio
async def test_successful_credential_settlement_emits_no_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)
    settled = app.build_credential_settled_emitter("/workspace", "owner-nonce")

    await settled("request-1", "submitted")

    assert events == []
