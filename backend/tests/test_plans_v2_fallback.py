"""MCP routing policy for the production Plans package adapter."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend.fs_service import FsError
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server.toolkit import Caller
from agent_team_backend.plugins.builtin.navide_plans import plan_tools


def _host_context() -> Any:
    return SimpleNamespace(
        request_context=SimpleNamespace(
            request=SimpleNamespace(
                query_params={
                    "client": "host",
                    "t": plan_mcp_auth.internal_token(),
                }
            )
        )
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error_code",
    ["BACKEND_UNAVAILABLE", "INVALID_RUNTIME", "NOT_READY", "PROTOCOL_ERROR", "PLUGIN_STOPPING", "host_timeout", "host_unavailable"],
)
async def test_explicit_host_availability_errors_use_the_legacy_adapter(
    monkeypatch: pytest.MonkeyPatch,
    error_code: str,
) -> None:
    async def denied_route(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {"code": error_code, "message": "Plans v2 is unavailable"},
        }

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", denied_route)

    result = await plan_tools._host_agent_plan_call(
        Caller(kind="host"),
        "/workspace",
        "plans.list",
        {},
    )

    assert result is plan_tools._NO_HOST_ROUTE


@pytest.mark.asyncio
@pytest.mark.parametrize("error_code", ["CAPABILITY_DENIED", "WORKSPACE_SCOPE_VIOLATION"])
async def test_security_errors_do_not_fallback_to_legacy_filesystem(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
    error_code: str,
) -> None:
    async def denied_route(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {"code": error_code, "message": "Plans operation denied"},
        }

    def legacy_must_not_run(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        raise AssertionError("legacy Plans filesystem fallback must not run")

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", denied_route)
    monkeypatch.setattr(plan_tools, "_list_plans_sync", legacy_must_not_run)

    with pytest.raises(FsError) as raised:
        await plan_tools.plan_list(_host_context(), workspace_path=str(tmp_path))

    assert raised.value.code == error_code


@pytest.mark.asyncio
async def test_backend_unavailable_falls_back_to_the_legacy_adapter(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    async def unavailable_route(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {"code": "BACKEND_UNAVAILABLE", "message": "child exited"},
        }

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", unavailable_route)
    monkeypatch.setattr(plan_tools, "_list_plans_sync", lambda workspace_path: [])

    assert await plan_tools.plan_list(_host_context(), workspace_path=str(tmp_path)) == []
