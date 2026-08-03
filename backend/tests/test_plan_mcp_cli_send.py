"""cli_send / cli_list_targets: the MCP face of inter-CLI messaging.

The `---MSG---` output protocol only reaches agents taught it in their kickoff,
so a hand-opened pane cannot discover it. These tools appear in the agent's tool
list on their own and route through the same registry.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.plugins.builtin.navide_plans import plan_mcp, plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str | None = "pa", token: str | None = None) -> Any:
    """A Context whose HTTP request carries the pane-identifying query string."""
    if pane_id is None:
        return SimpleNamespace(request_context=SimpleNamespace(request=None))
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token() if token is None else token}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed() -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "reviewer", "/ws/beta", agent_key="codex")
    agent_messaging.register("pc", "helper", "/ws/alpha", agent_key="claude")


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


# ── Caller identity ────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_send_refuses_when_the_request_cannot_identify_a_pane(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(pane_id=None))
    assert result["ok"] is False
    assert "identify your pane" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_send_refuses_a_bad_caller_token(captured: list[dict[str, Any]]) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(token="not-the-token"))
    assert result["ok"] is False
    assert "token rejected" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_send_refuses_a_pane_id_that_is_no_longer_live(
    captured: list[dict[str, Any]],
) -> None:
    """A re-attached pane (detach, window reload) gets a NEW pane id without
    re-running spawn wiring, so the CLI keeps quoting the old one. Acting on it
    would break self-send detection and strip the sender's identity."""
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(pane_id="long-gone"))
    assert result["ok"] is False
    assert "stale" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_list_targets_refuses_a_stale_pane_id() -> None:
    _seed()
    result = await plan_mcp.cli_list_targets(_ctx(pane_id="long-gone"))
    assert result["targets"] == []
    assert "stale" in result["error"]


# ── Sending ────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_send_broadcasts_the_delivery(captured: list[dict[str, Any]]) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "run the tests", _ctx())

    assert result == {"ok": True, "target": "beta/reviewer", "cross_workspace": True}
    assert len(captured) == 1
    payload = captured[0]["payload"]
    assert captured[0]["type"] == "agent_msg.deliver"
    assert payload["target_pane_id"] == "pb"
    assert payload["from_display"] == "alpha/sender"
    assert payload["content"] == "run the tests"
    assert payload["cross_workspace"] is True
    # This path never went through the frontend's send-side rate limit, so the
    # receiving window has to apply it — otherwise two agents replying to each
    # other through cli_send have no loop guard.
    assert payload["rate_limit"] is True


@pytest.mark.asyncio
async def test_send_to_a_bare_name_stays_in_the_callers_workspace(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("helper", "local please", _ctx())

    assert result["ok"] is True
    assert result["cross_workspace"] is False
    assert captured[0]["payload"]["target_pane_id"] == "pc"


@pytest.mark.asyncio
async def test_send_refuses_unknown_ambiguous_and_self(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    agent_messaging.register("pd", "reviewer", "/ws/dup")
    agent_messaging.register("pe", "reviewer", "/ws/dup")

    unknown = await plan_mcp.cli_send("gamma/reviewer", "x", _ctx())
    assert unknown["ok"] is False and "unknown workspace" in unknown["error"]

    ambiguous = await plan_mcp.cli_send("dup/reviewer", "x", _ctx())
    assert ambiguous["ok"] is False and "ambiguous target" in ambiguous["error"]

    myself = await plan_mcp.cli_send("sender", "x", _ctx())
    assert myself["ok"] is False and "your own pane" in myself["error"]

    assert captured == []


@pytest.mark.asyncio
async def test_send_refuses_empty_text(captured: list[dict[str, Any]]) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "   ", _ctx())
    assert result["ok"] is False and "empty" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_message_key_is_unique_per_send(captured: list[dict[str, Any]]) -> None:
    _seed()
    await plan_mcp.cli_send("beta/reviewer", "one", _ctx())
    await plan_mcp.cli_send("beta/reviewer", "two", _ctx())
    keys = {e["payload"]["msg_key"] for e in captured}
    assert len(keys) == 2


# ── Listing ────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_list_targets_excludes_the_caller_and_flags_own_workspace() -> None:
    _seed()
    result = await plan_mcp.cli_list_targets(_ctx())

    assert result["you"] == "alpha/sender"
    by_address = {t["address"]: t for t in result["targets"]}
    assert set(by_address) == {"beta/reviewer", "alpha/helper"}
    assert by_address["alpha/helper"]["same_workspace"] is True
    assert by_address["beta/reviewer"]["same_workspace"] is False


@pytest.mark.asyncio
async def test_list_targets_reports_an_unidentified_caller() -> None:
    _seed()
    result = await plan_mcp.cli_list_targets(_ctx(pane_id=None))
    assert result["targets"] == []
    assert "identify your pane" in result["error"]


@pytest.mark.asyncio
async def test_tools_are_registered_without_a_ctx_argument() -> None:
    tools = {t.name: t for t in await plan_mcp.server.list_tools()}
    assert set(tools) >= {"cli_send", "cli_list_targets"}
    # The Context parameter is injected, never asked of the agent.
    assert set((tools["cli_send"].inputSchema.get("properties") or {})) == {"to", "text"}
    assert not (tools["cli_list_targets"].inputSchema.get("properties") or {})
