"""cli_read_log / cli_get_status / cli_wait_idle: reading another pane's
state through the Plan MCP server (Phase C)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.plugins.builtin.navide_plans import plan_mcp, plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch: pytest.MonkeyPatch) -> Any:
    agent_messaging._reset_for_test()
    app._pane_activity.clear()
    # cli_get_status's ui lookup broadcasts and waits for a reply nobody sends
    # in these tests (unless a test stubs _ui_request itself) — keep that wait
    # short so "ui omitted" tests do not eat the real 15s timeout.
    monkeypatch.setattr(plan_mcp, "_UI_INVOKE_TIMEOUT_S", 0.02)
    yield
    agent_messaging._reset_for_test()
    app._pane_activity.clear()


def _ctx(pane_id: str | None = "pa", token: str | None = None) -> Any:
    if pane_id is None:
        return SimpleNamespace(request_context=SimpleNamespace(request=None))
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token() if token is None else token}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed_pane(workspace: Path, pane_id: str = "pw", name: str = "worker") -> None:
    # The default ctx() caller is pane "pa" — register it alongside the
    # target so a bare-name resolve (same workspace) succeeds.
    agent_messaging.register("pa", "caller", str(workspace))
    agent_messaging.register(pane_id, name, str(workspace), agent_key="claude")


# ── cli_read_log ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_read_log_returns_the_full_tail_when_under_both_caps(tmp_path: Path) -> None:
    _seed_pane(tmp_path)
    log = tmp_path / "conv.log"
    log.write_text("line1\nline2\nline3\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(log)
    )

    result = await plan_mcp.cli_read_log("worker", _ctx())

    assert result["ok"] is True
    assert result["log_path"] == str(log)
    assert result["text"] == "line1\nline2\nline3"
    assert result["truncated"] is False


@pytest.mark.asyncio
async def test_read_log_keeps_only_the_last_tail_lines(tmp_path: Path) -> None:
    _seed_pane(tmp_path)
    log = tmp_path / "conv.log"
    log.write_text("\n".join(f"line{i}" for i in range(1, 11)) + "\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(log)
    )

    result = await plan_mcp.cli_read_log("worker", _ctx(), tail_lines=3)

    assert result["ok"] is True
    assert result["text"] == "line8\nline9\nline10"
    assert result["truncated"] is True


@pytest.mark.asyncio
async def test_read_log_caps_at_64kb_regardless_of_tail_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(plan_mcp, "_LOG_TAIL_MAX_BYTES", 100)
    _seed_pane(tmp_path)
    log = tmp_path / "conv.log"
    # Each line is 10 bytes ("lineNNNN\n"); 200 lines is well over the 100-byte cap.
    log.write_text("\n".join(f"line{i:04d}" for i in range(200)) + "\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(log)
    )

    result = await plan_mcp.cli_read_log("worker", _ctx(), tail_lines=200)

    assert result["ok"] is True
    assert result["truncated"] is True
    assert len(result["text"].encode("utf-8")) <= 100
    assert result["text"].endswith("line0199")


@pytest.mark.asyncio
async def test_read_log_fails_when_the_file_no_longer_exists(tmp_path: Path) -> None:
    _seed_pane(tmp_path)
    missing = tmp_path / "gone.log"
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(missing)
    )

    result = await plan_mcp.cli_read_log("worker", _ctx())

    assert result["ok"] is False
    assert "no longer exists" in result["error"]


@pytest.mark.asyncio
async def test_read_log_fails_when_no_log_file_was_ever_recorded(tmp_path: Path) -> None:
    _seed_pane(tmp_path)
    # No record_manual_pane_spawn call at all — the pane is in the messaging
    # registry but the project store never learned an output_log_file for it.

    result = await plan_mcp.cli_read_log("worker", _ctx())

    assert result["ok"] is False
    assert "no log file recorded" in result["error"]


@pytest.mark.asyncio
async def test_read_log_fails_for_an_unknown_target(tmp_path: Path) -> None:
    agent_messaging.register("pa", "caller", str(tmp_path))
    result = await plan_mcp.cli_read_log("nope", _ctx())
    assert result["ok"] is False
    assert "unknown target" in result["error"]


# ── cli_get_status ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_status_reports_busy_and_last_activity() -> None:
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="codex")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", True)
    app._record_pane_activity("pw", "turn_complete", "all done")

    result = await plan_mcp.cli_get_status("alpha/worker", _ctx(pane_id="other"))

    assert result["ok"] is True
    assert result["name"] == "worker"
    assert result["agent_key"] == "codex"
    assert result["busy"] is True
    assert result["last_activity"]["type"] == "turn_complete"
    assert result["last_activity"]["text"] == "all done"
    assert isinstance(result["last_activity"]["age_seconds"], float)


@pytest.mark.asyncio
async def test_get_status_omits_last_activity_when_none_recorded() -> None:
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")

    result = await plan_mcp.cli_get_status("alpha/worker", _ctx(pane_id="other"))

    assert result["ok"] is True
    assert "last_activity" not in result


@pytest.mark.asyncio
async def test_get_status_omits_ui_when_the_window_does_not_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")

    async def _no_reply(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"ok": False, "result": None, "error": "timed out"}

    monkeypatch.setattr(plan_mcp, "_ui_request", _no_reply)

    result = await plan_mcp.cli_get_status("alpha/worker", _ctx(pane_id="other"))

    assert result["ok"] is True
    assert "ui" not in result


@pytest.mark.asyncio
async def test_get_status_includes_ui_when_the_window_answers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")

    async def _reply(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"ok": True, "result": {"status": "idle", "buffer": "$ "}, "error": None}

    monkeypatch.setattr(plan_mcp, "_ui_request", _reply)

    result = await plan_mcp.cli_get_status("alpha/worker", _ctx(pane_id="other"))

    assert result["ui"] == {"status": "idle", "buffer": "$ "}


# ── cli_wait_idle ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wait_idle_returns_immediately_on_turn_complete() -> None:
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", False)
    app._record_pane_activity("pw", "turn_complete", "done")

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"))

    assert result == {"idle": True, "source": "turn_complete", "waited_s": 0.0}


@pytest.mark.asyncio
async def test_wait_idle_reports_a_quiet_period_when_only_agent_active_seen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_QUIET_S", 0.0)
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", False)
    app._record_pane_activity("pw", "agent_active", "")

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"))

    assert result["idle"] is True
    assert result["source"] == "quiet_period"


@pytest.mark.asyncio
async def test_wait_idle_times_out_while_still_busy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.01)
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", True)

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"), timeout_s=0.03)

    assert result["idle"] is False
    assert result["source"] == "timeout"


@pytest.mark.asyncio
async def test_wait_idle_fails_for_an_unknown_target() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    result = await plan_mcp.cli_wait_idle("nope", _ctx())
    assert result["ok"] is False
    assert "unknown target" in result["error"]
