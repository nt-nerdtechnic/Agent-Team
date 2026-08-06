"""ui_invoke / ui_snapshot / ui_list_actions: the MCP face of routing UI
requests to the Navide renderer window that owns a workspace_path, via the
ui.invoke.request / ui.invoke.result WS event pair.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.plugins.builtin.navide_plans import plan_mcp, plan_mcp_auth


def _ctx() -> Any:
    """A Context carrying a valid host credential — ui_* tools only need *a*
    valid /plan-mcp credential, not a specific pane identity."""
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


@pytest.fixture
def unicasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_unicast_any(event: dict[str, Any]) -> bool:
        events.append(event)
        return True

    monkeypatch.setattr(app, "unicast_any", fake_unicast_any)
    return events


async def _answer(tag: str) -> None:
    """Stand in for the renderer window replying with a ui.invoke.result."""
    for _ in range(200):
        keys = list(plan_mcp._ui_invoke_pending.pending)
        if keys:
            plan_mcp.resolve_ui_invoke(
                keys[0], {"ok": True, "result": {"echo": tag}, "error": None}
            )
            return
        await asyncio.sleep(0.005)
    raise AssertionError("no pending ui.invoke request appeared")


@pytest.mark.asyncio
async def test_ui_invoke_broadcasts_and_returns_the_result(
    broadcasts: list[dict[str, Any]], unicasts: list[dict[str, Any]]
) -> None:
    task = asyncio.create_task(_answer("invoke"))
    result = await plan_mcp.ui_invoke("/ws/alpha", "editor.save", _ctx(), {"path": "a.py"})
    await task

    assert result == {"ok": True, "result": {"echo": "invoke"}, "error": None}
    assert len(broadcasts) == 1
    assert unicasts == []
    payload = broadcasts[0]["payload"]
    assert broadcasts[0]["type"] == "ui.invoke.request"
    assert payload["workspace_path"] == "/ws/alpha"
    assert payload["op"] == "invoke"
    assert payload["action"] == "editor.save"
    assert payload["args"] == {"path": "a.py"}
    assert payload["global"] is False
    assert isinstance(payload["request_id"], str) and payload["request_id"]


@pytest.mark.asyncio
async def test_ui_invoke_workspace_open_unicasts_instead_of_broadcasting(
    broadcasts: list[dict[str, Any]], unicasts: list[dict[str, Any]]
) -> None:
    task = asyncio.create_task(_answer("invoke"))
    result = await plan_mcp.ui_invoke("/ws/beta", "ui.workspace.open", _ctx(), {"path": "/ws/beta"})
    await task

    assert result["ok"] is True
    assert broadcasts == []
    assert len(unicasts) == 1
    payload = unicasts[0]["payload"]
    assert unicasts[0]["type"] == "ui.invoke.request"
    assert payload["op"] == "invoke"
    assert payload["action"] == "ui.workspace.open"
    assert payload["global"] is True


@pytest.mark.asyncio
async def test_ui_invoke_global_reports_when_no_window_is_open(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    async def fake_unicast_any(_event: dict[str, Any]) -> bool:
        return False

    monkeypatch.setattr(app, "unicast_any", fake_unicast_any)
    result = await plan_mcp.ui_invoke("/ws/delta", "ui.workspace.open", _ctx(), None)

    assert result == {
        "ok": False,
        "result": None,
        "error": "no Navide window is open to handle this request",
    }
    assert broadcasts == []
    assert plan_mcp._ui_invoke_pending.pending == {}


@pytest.mark.asyncio
async def test_ui_invoke_times_out_when_no_window_answers(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    monkeypatch.setattr(plan_mcp, "_UI_INVOKE_TIMEOUT_S", 0.05)

    result = await plan_mcp.ui_invoke("/ws/gamma", "editor.save", _ctx(), None)

    assert result["ok"] is False
    assert "no Navide window owns" in result["error"]
    assert "timed out" in result["error"]
    # The pending entry must not leak once the wait gives up.
    assert plan_mcp._ui_invoke_pending.pending == {}


@pytest.mark.asyncio
async def test_ui_list_actions_uses_the_list_actions_op(
    broadcasts: list[dict[str, Any]],
) -> None:
    task = asyncio.create_task(_answer("list_actions"))
    result = await plan_mcp.ui_list_actions("/ws/alpha", _ctx())
    await task

    assert result["ok"] is True
    payload = broadcasts[0]["payload"]
    assert payload["op"] == "list_actions"
    assert payload["action"] is None
    assert payload["args"] is None
    assert payload["global"] is False


@pytest.mark.asyncio
async def test_ui_snapshot_uses_the_snapshot_op(broadcasts: list[dict[str, Any]]) -> None:
    task = asyncio.create_task(_answer("snapshot"))
    result = await plan_mcp.ui_snapshot("/ws/alpha", _ctx())
    await task

    assert result["ok"] is True
    payload = broadcasts[0]["payload"]
    assert payload["op"] == "snapshot"
    assert payload["action"] is None
    assert payload["global"] is False


def test_resolve_ui_invoke_ignores_an_unknown_request_id() -> None:
    assert plan_mcp.resolve_ui_invoke("nope", {"ok": True, "result": None, "error": None}) is False


@pytest.mark.asyncio
async def test_ui_diagnostics_invokes_the_diagnostics_read_action_with_its_args(
    broadcasts: list[dict[str, Any]],
) -> None:
    task = asyncio.create_task(_answer("diagnostics"))
    result = await plan_mcp.ui_diagnostics(
        "/ws/alpha", _ctx(), since_seq=7, pane_id="pane-1", limit=25
    )
    await task

    assert result["ok"] is True
    payload = broadcasts[0]["payload"]
    assert payload["op"] == "invoke"
    assert payload["action"] == "ui.diagnostics.read"
    assert payload["args"] == {"sinceSeq": 7, "paneId": "pane-1", "limit": 25}
    assert payload["global"] is False


@pytest.mark.asyncio
async def test_ui_diagnostics_uses_its_documented_defaults(
    broadcasts: list[dict[str, Any]],
) -> None:
    task = asyncio.create_task(_answer("diagnostics-defaults"))
    await plan_mcp.ui_diagnostics("/ws/alpha", _ctx())
    await task

    payload = broadcasts[0]["payload"]
    assert payload["args"] == {"sinceSeq": 0, "paneId": "", "limit": 50}


@pytest.mark.asyncio
async def test_ui_invoke_result_carries_warnings_through_unchanged_when_present() -> None:
    """_ui_request returns whatever resolve_ui_invoke was handed — including an
    optional `warnings` list the renderer attached to flag an in-window
    anomaly (e.g. injectText resending) even though the action still ok'd."""

    async def _answer_with_warnings() -> None:
        for _ in range(200):
            keys = list(plan_mcp._ui_invoke_pending.pending)
            if keys:
                plan_mcp.resolve_ui_invoke(
                    keys[0],
                    {
                        "ok": True,
                        "result": "pane-1",
                        "error": None,
                        "warnings": ["[inject.resend] content not echoed — resending"],
                    },
                )
                return
            await asyncio.sleep(0.005)
        raise AssertionError("no pending ui.invoke request appeared")

    task = asyncio.create_task(_answer_with_warnings())
    result = await plan_mcp._ui_request("/ws", "invoke", action="ui.pane.create")
    await task

    assert result["warnings"] == ["[inject.resend] content not echoed — resending"]


@pytest.mark.asyncio
async def test_ui_invoke_result_has_no_warnings_key_when_the_renderer_sent_none(
    broadcasts: list[dict[str, Any]],
) -> None:
    task = asyncio.create_task(_answer("no-warnings"))
    result = await plan_mcp._ui_request("/ws", "invoke", action="ui.settings.close")
    await task

    assert "warnings" not in result


@pytest.mark.asyncio
async def test_pane_create_gets_a_longer_deadline_than_a_plain_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Spawning a pane waits out the CLI's startup before injecting the task,
    # which alone reaches the default timeout — reporting failure there would
    # deny work that actually succeeded.
    seen: list[float] = []

    async def _capture(request_id: str, fut: Any, *, timeout: float) -> Any:
        seen.append(timeout)
        return {"ok": True, "result": None, "error": None}

    monkeypatch.setattr(plan_mcp._ui_invoke_pending, "wait", _capture)

    await plan_mcp._ui_request("/ws", "invoke", action="ui.settings.close")
    await plan_mcp._ui_request("/ws", "invoke", action="ui.pane.create")

    assert seen[0] == plan_mcp._UI_INVOKE_TIMEOUT_S
    assert seen[1] == plan_mcp._UI_INVOKE_SLOW_TIMEOUT_S
    assert seen[1] > seen[0]
