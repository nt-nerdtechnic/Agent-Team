"""cli_read_incoming: reading the full text of messages addressed to you.

cli_pending_incoming shows 200 characters with the whitespace flattened; this
returns what was written. The interesting part is not the read but the
consume: it is two steps (reserve, then release), and every failure has to
leave the message queued rather than swallowed.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    auth as plan_mcp_auth,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _pane_ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _host_ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed() -> None:
    agent_messaging.register("pa", "reader", "/ws/alpha")


def _row(uid: str = "u1", content: str = "hello", **over: Any) -> dict[str, Any]:
    row = {
        "uid": uid,
        "sender": "writer",
        "status": "queued",
        "content": content,
        "createdAt": 0,
    }
    row.update(over)
    return row


def _fake_ui(monkeypatch: pytest.MonkeyPatch, replies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Answer each _ui_request from `replies` in order, recording the calls."""
    calls: list[dict[str, Any]] = []

    async def fake(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"workspace_path": workspace_path, "op": op, **kwargs})
        return replies[len(calls) - 1] if len(calls) <= len(replies) else {"ok": False, "error": "no reply"}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    return calls


@pytest.mark.asyncio
async def test_only_a_pane_has_an_inbox() -> None:
    """A host or external credential has no messaging name, so nothing can be
    addressed to it — the refusal says that rather than returning empty."""
    result = await plan_mcp.cli_read_incoming(_host_ctx())
    assert result["ok"] is False
    assert "inbox" in result["error"]


@pytest.mark.asyncio
async def test_returns_the_whole_message_not_an_excerpt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reason this tool exists. cli_pending_incoming would return 200
    characters of this with the newlines collapsed."""
    _seed()
    long_text = "line one\n\n" + ("x" * 900) + "\n\tindented tail"
    calls = _fake_ui(monkeypatch, [
        {"ok": True, "result": {"messages": [_row(content=long_text)], "reserved": ["u1"]}},
        {"ok": True, "result": {"settled": ["u1"]}},
    ])

    result = await plan_mcp.cli_read_incoming(_pane_ctx())

    assert result["ok"] is True
    assert result["messages"][0]["content"] == long_text
    assert result["messages"][0]["consumed"] is True
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_peek_reads_without_reserving(monkeypatch: pytest.MonkeyPatch) -> None:
    """A peek must not touch delivery at all: one call, no reservation, and
    the message is reported as not consumed."""
    _seed()
    calls = _fake_ui(monkeypatch, [
        {"ok": True, "result": {"messages": [_row()], "reserved": []}},
    ])

    result = await plan_mcp.cli_read_incoming(_pane_ctx(), peek=True)

    assert result["messages"][0]["consumed"] is False
    assert len(calls) == 1, "a peek must not issue a settle call"
    assert calls[0]["args"]["reserve"] is False


@pytest.mark.asyncio
async def test_a_lost_release_reports_not_consumed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The failure this design exists to survive.

    The window handed over the text but never confirmed the release. The
    message must be reported as NOT consumed and the caller told plainly, so
    it expects the message in its pane rather than assuming it was taken.
    """
    _seed()
    _fake_ui(monkeypatch, [
        {"ok": True, "result": {"messages": [_row()], "reserved": ["u1"]}},
        {"ok": False, "error": "timed out"},
    ])

    result = await plan_mcp.cli_read_incoming(_pane_ctx())

    assert result["ok"] is True, "the text was read; that half succeeded"
    assert result["messages"][0]["consumed"] is False
    assert "not consumed" in result["note"]


@pytest.mark.asyncio
async def test_a_partial_release_only_marks_what_was_released(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Consumption is per message: releasing one of two must not mark both."""
    _seed()
    _fake_ui(monkeypatch, [
        {"ok": True, "result": {
            "messages": [_row("u1"), _row("u2")],
            "reserved": ["u1", "u2"],
        }},
        {"ok": True, "result": {"settled": ["u1"]}},
    ])

    result = await plan_mcp.cli_read_incoming(_pane_ctx(), limit=2)

    by_uid = {m["uid"]: m["consumed"] for m in result["messages"]}
    assert by_uid == {"u1": True, "u2": False}
    assert "1 message(s)" in result["note"]


@pytest.mark.asyncio
async def test_an_unreachable_window_degrades_to_the_log_instead_of_failing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unreachable window must not look like "you have no mail".

    The text lives in the message log too, so the read is answered from there.
    Nothing is reserved, so delivery is untouched and the message still
    reaches the pane — which the caller is told, because otherwise it would
    read the text and wrongly assume it had been taken off the queue.
    """
    _seed()
    _fake_ui(monkeypatch, [{"ok": False, "error": "no Navide window is open"}])
    monkeypatch.setattr(
        app.agent_message_log,
        "incoming",
        lambda recipient, include_delivered=False, limit=0: [
            {"uid": "u1", "sender": "writer", "status": "queued",
             "content": "the whole thing", "kind": None, "created_at": 0},
        ],
    )

    result = await plan_mcp.cli_read_incoming(_pane_ctx())

    assert result["ok"] is True
    assert result["messages"][0]["content"] == "the whole thing"
    assert result["messages"][0]["consumed"] is False
    assert "nothing was consumed" in result["note"]


@pytest.mark.asyncio
async def test_the_degraded_read_still_honours_a_uid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fallback reads the whole inbox, so asking for one message must not
    quietly return someone else's."""
    _seed()
    _fake_ui(monkeypatch, [{"ok": False, "error": "timed out"}])
    monkeypatch.setattr(
        app.agent_message_log,
        "incoming",
        lambda recipient, include_delivered=False, limit=0: [
            {"uid": "u1", "sender": "a", "status": "queued", "content": "one",
             "kind": None, "created_at": 0},
            {"uid": "u2", "sender": "b", "status": "queued", "content": "two",
             "kind": None, "created_at": 0},
        ],
    )

    result = await plan_mcp.cli_read_incoming(_pane_ctx(), uid="u2")

    assert [m["uid"] for m in result["messages"]] == ["u2"]


@pytest.mark.asyncio
async def test_the_request_is_addressed_at_the_callers_own_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Your inbox lives in the window that owns your pane; broadcasting would
    let another window answer for it."""
    _seed()
    calls = _fake_ui(monkeypatch, [
        {"ok": True, "result": {"messages": [], "reserved": []}},
    ])

    await plan_mcp.cli_read_incoming(_pane_ctx())

    assert calls[0]["workspace_path"] == "/ws/alpha"
    assert calls[0]["action"] == "ui.messaging.readIncoming"
    assert calls[0]["caller"] is not None


@pytest.mark.asyncio
async def test_limit_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each message can be 64K of the caller's context, so an unbounded limit
    is a context-window hazard rather than a convenience."""
    _seed()
    calls = _fake_ui(monkeypatch, [
        {"ok": True, "result": {"messages": [], "reserved": []}},
    ])

    await plan_mcp.cli_read_incoming(_pane_ctx(), limit=10_000)

    assert calls[0]["args"]["limit"] == plan_mcp._INCOMING_READ_MAX


@pytest.mark.asyncio
async def test_a_uid_asks_for_exactly_that_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed()
    calls = _fake_ui(monkeypatch, [
        {"ok": True, "result": {"messages": [_row("u7")], "reserved": []}},
    ])

    await plan_mcp.cli_read_incoming(_pane_ctx(), uid="  u7  ")

    assert calls[0]["args"]["uids"] == ["u7"]


@pytest.mark.asyncio
async def test_a_paused_window_says_so_instead_of_looking_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Paused delivery makes reserveIncoming return nothing. Without a word
    about the pause that is indistinguishable from an empty inbox — the one
    conclusion this tool must never let a caller reach by accident."""
    _seed()
    _fake_ui(monkeypatch, [
        {"ok": True, "result": {"messages": [], "reserved": [], "paused": True}},
    ])

    result = await plan_mcp.cli_read_incoming(_pane_ctx())

    assert result["ok"] is True
    assert "paused" in result["note"]


@pytest.mark.asyncio
async def test_an_ordinary_empty_inbox_carries_no_note(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other side of it: genuinely having no mail must stay quiet, or the
    note stops meaning anything."""
    _seed()
    _fake_ui(monkeypatch, [
        {"ok": True, "result": {"messages": [], "reserved": [], "paused": False}},
    ])

    result = await plan_mcp.cli_read_incoming(_pane_ctx())

    assert result == {"ok": True, "count": 0, "messages": []}
