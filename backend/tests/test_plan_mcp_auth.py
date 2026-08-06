"""Credential resolution for /plan-mcp (plan_mcp._resolve_caller) and the
plan_mcp_auth token store it reads from.

Every tool on the server requires one of three credential kinds — pane, host,
or external (only while enabled). This exercises the acceptance/rejection
matrix directly against _resolve_caller (shared by every tool) plus one
integration check that a real tool (plan_list) enforces it.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.plugins.builtin.navide_plans import plan_mcp, plan_mcp_auth, plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(**params: str) -> Any:
    """A Context whose HTTP request carries `params` as its query string; no
    params at all mimics a request with no query string / no request object."""
    if not params:
        return SimpleNamespace(request_context=SimpleNamespace(request=None))
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


# ── plan_mcp_auth: token persistence ────────────────────────────────────────


def test_tokens_are_generated_once_and_persisted() -> None:
    internal = plan_mcp_auth.internal_token()
    external = plan_mcp_auth.external_token()
    assert internal and external and internal != external
    # Re-reading returns the same tokens (persisted to disk, not regenerated).
    assert plan_mcp_auth.internal_token() == internal
    assert plan_mcp_auth.external_token() == external


def test_external_access_defaults_to_disabled() -> None:
    assert plan_mcp_auth.external_enabled() is False


def test_set_external_enabled_persists() -> None:
    config = plan_mcp_auth.set_external_enabled(True)
    assert config["external_enabled"] is True
    assert plan_mcp_auth.external_enabled() is True
    config = plan_mcp_auth.set_external_enabled(False)
    assert config["external_enabled"] is False
    assert plan_mcp_auth.external_enabled() is False


def test_regenerate_external_token_changes_only_the_external_token() -> None:
    internal_before = plan_mcp_auth.internal_token()
    external_before = plan_mcp_auth.external_token()
    config = plan_mcp_auth.regenerate_external_token()
    assert config["external_token"] != external_before
    assert config["internal_token"] == internal_before
    assert plan_mcp_auth.external_token() == config["external_token"]


# ── _resolve_caller: acceptance/rejection matrix ────────────────────────────


def test_resolve_caller_rejects_no_request() -> None:
    with pytest.raises(plan_mcp.CallerUnknown, match="could not identify your pane"):
        plan_mcp._resolve_caller(_ctx())


def test_resolve_caller_accepts_a_valid_pane_credential() -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha")
    caller = plan_mcp._resolve_caller(
        _ctx(pane="pa", t=plan_mcp_wiring.caller_token())
    )
    assert caller.kind == "pane"
    assert caller.pane_id == "pa"


def test_resolve_caller_rejects_a_missing_pane_id() -> None:
    with pytest.raises(plan_mcp.CallerUnknown, match="could not identify your pane"):
        plan_mcp._resolve_caller(_ctx(t=plan_mcp_wiring.caller_token()))


def test_resolve_caller_rejects_a_bad_pane_token() -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha")
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx(pane="pa", t="not-the-token"))


def test_resolve_caller_rejects_a_stale_pane_id() -> None:
    with pytest.raises(plan_mcp.CallerUnknown, match="stale"):
        plan_mcp._resolve_caller(_ctx(pane="long-gone", t=plan_mcp_wiring.caller_token()))


def test_resolve_caller_accepts_a_valid_host_credential() -> None:
    caller = plan_mcp._resolve_caller(
        _ctx(client="host", t=plan_mcp_auth.internal_token())
    )
    assert caller.kind == "host"
    assert caller.pane_id == ""


def test_resolve_caller_rejects_a_bad_host_token() -> None:
    with pytest.raises(plan_mcp.CallerUnknown, match="host token rejected"):
        plan_mcp._resolve_caller(_ctx(client="host", t="wrong"))


def test_resolve_caller_rejects_external_while_disabled() -> None:
    assert plan_mcp_auth.external_enabled() is False
    with pytest.raises(plan_mcp.CallerUnknown, match="disabled"):
        plan_mcp._resolve_caller(
            _ctx(client="external", t=plan_mcp_auth.external_token())
        )


def test_resolve_caller_accepts_a_valid_external_credential_once_enabled() -> None:
    plan_mcp_auth.set_external_enabled(True)
    caller = plan_mcp._resolve_caller(
        _ctx(client="external", t=plan_mcp_auth.external_token())
    )
    assert caller.kind == "external"
    assert caller.pane_id == ""


def test_resolve_caller_rejects_a_bad_external_token_even_when_enabled() -> None:
    plan_mcp_auth.set_external_enabled(True)
    with pytest.raises(plan_mcp.CallerUnknown, match="external token rejected"):
        plan_mcp._resolve_caller(_ctx(client="external", t="wrong"))


# ── integration: a real tool enforces the same gate ─────────────────────────


@pytest.mark.asyncio
async def test_plan_list_rejects_a_request_with_no_credential(tmp_path) -> None:
    with pytest.raises(plan_mcp.CallerUnknown):
        await plan_mcp.plan_list(str(tmp_path), _ctx())


@pytest.mark.asyncio
async def test_plan_list_accepts_a_host_credential(tmp_path) -> None:
    # No plans directory yet — plan_list just returns [] rather than erroring,
    # so reaching that (instead of CallerUnknown) proves the credential passed.
    result = await plan_mcp.plan_list(
        str(tmp_path), _ctx(client="host", t=plan_mcp_auth.internal_token())
    )
    assert result == []
