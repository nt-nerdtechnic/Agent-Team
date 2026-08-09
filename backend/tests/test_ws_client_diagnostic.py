"""client.diagnostic handler: writes renderer-side observations into the
backend log.

The renderer has no log of its own, so pane preparation timings and IME
composition stalls — the half of the input round-trip the user actually
touches — had nowhere to be recorded. This channel puts them on the same
timeline as the PTY events they have to be compared against.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from agent_team_backend import app


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


async def _send(session: app.Session, payload: dict[str, Any]) -> None:
    await app.handle_message(session, {
        "id": "m1",
        "type": "client.diagnostic",
        "payload": payload,
    })


@pytest.mark.asyncio
async def test_records_the_line_under_its_category(caplog) -> None:
    session = _session()
    with caplog.at_level(logging.INFO, logger="agent_team_backend.client"):
        await _send(session, {
            "category": "pane-prep",
            "message": "pane=7521fea3 agent=claude settling->ready after=4310ms",
        })
    assert "pane-prep" in caplog.text
    assert "settling->ready after=4310ms" in caplog.text


@pytest.mark.asyncio
async def test_warning_level_is_honoured(caplog) -> None:
    session = _session()
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.client"):
        await _send(session, {
            "category": "ime",
            "message": "stale composition unlatched after 2200ms",
            "level": "warning",
        })
    assert "stale composition unlatched" in caplog.text
    assert any(r.levelno == logging.WARNING for r in caplog.records)


@pytest.mark.asyncio
async def test_an_empty_message_writes_nothing(caplog) -> None:
    session = _session()
    with caplog.at_level(logging.INFO, logger="agent_team_backend.client"):
        await _send(session, {"category": "ime", "message": ""})
    assert caplog.text == ""


@pytest.mark.asyncio
async def test_a_runaway_message_is_truncated(caplog) -> None:
    """A renderer bug must not be able to write megabytes into the log."""
    session = _session()
    with caplog.at_level(logging.INFO, logger="agent_team_backend.client"):
        await _send(session, {"category": "x" * 200, "message": "y" * 5000})
    assert "y" * 1000 in caplog.text
    assert "y" * 1001 not in caplog.text
    assert "x" * 41 not in caplog.text


@pytest.mark.asyncio
async def test_the_caller_gets_an_ack() -> None:
    """The renderer sends through the normal request path, so an unanswered
    message would leave it waiting for a reply that never comes."""
    session = _session()
    await _send(session, {"category": "ime", "message": "anything"})
    ws: Any = session.websocket
    assert ws.sent and ws.sent[-1]["payload"] == {"ok": True}
