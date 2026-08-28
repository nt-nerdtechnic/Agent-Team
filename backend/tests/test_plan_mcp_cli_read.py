"""cli_read_log / cli_get_status / cli_wait_idle: reading another pane's
state through the Plan MCP server (Phase C)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import server as plan_mcp, auth as plan_mcp_auth, wiring as plan_mcp_wiring


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


# ── cli_read_log: incremental reads (P3-1) ────────────────────────────────


@pytest.mark.asyncio
async def test_read_log_since_a_cursor_returns_only_what_was_appended(
    tmp_path: Path,
) -> None:
    """Without a cursor a caller re-reads the same tail every time and cannot
    tell what the other agent said since it last looked."""
    _seed_pane(tmp_path)
    log = tmp_path / "conv.log"
    log.write_text("old1\nold2\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(log)
    )

    first = await plan_mcp.cli_read_log("worker", _ctx())
    assert first["next_cursor"] == log.stat().st_size
    assert first["rotated"] is False

    with log.open("a", encoding="utf-8") as f:
        f.write("new1\nnew2\n")

    second = await plan_mcp.cli_read_log("worker", _ctx(), since=first["next_cursor"])

    assert second["text"] == "new1\nnew2"
    assert second["truncated"] is False
    assert second["next_cursor"] == log.stat().st_size


@pytest.mark.asyncio
async def test_read_log_since_the_end_returns_nothing_new(tmp_path: Path) -> None:
    _seed_pane(tmp_path)
    log = tmp_path / "conv.log"
    log.write_text("only\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(log)
    )

    first = await plan_mcp.cli_read_log("worker", _ctx())
    again = await plan_mcp.cli_read_log("worker", _ctx(), since=first["next_cursor"])

    assert again["text"] == ""
    assert again["next_cursor"] == first["next_cursor"]


@pytest.mark.asyncio
async def test_read_log_since_a_cursor_past_the_end_restarts_and_says_so(
    tmp_path: Path,
) -> None:
    """A truncated or replaced capture file leaves the cursor pointing at
    nothing; silently returning an empty read would look like "said nothing"."""
    _seed_pane(tmp_path)
    log = tmp_path / "conv.log"
    log.write_text("a much longer first life of this file\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(log)
    )
    stale_cursor = log.stat().st_size
    log.write_text("short\n", encoding="utf-8")

    result = await plan_mcp.cli_read_log("worker", _ctx(), since=stale_cursor)

    assert result["rotated"] is True
    assert result["text"] == "short"
    assert result["next_cursor"] == log.stat().st_size


@pytest.mark.asyncio
async def test_read_log_since_still_honours_the_byte_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(plan_mcp, "_LOG_TAIL_MAX_BYTES", 100)
    _seed_pane(tmp_path)
    log = tmp_path / "conv.log"
    log.write_text("seed\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(log)
    )
    cursor = log.stat().st_size
    with log.open("a", encoding="utf-8") as f:
        f.write("\n".join(f"line{i:04d}" for i in range(200)) + "\n")

    result = await plan_mcp.cli_read_log("worker", _ctx(), since=cursor, tail_lines=500)

    assert result["truncated"] is True
    assert len(result["text"].encode("utf-8")) <= 100
    assert result["text"].endswith("line0199")


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

    assert result["idle"] is True
    assert result["source"] == "turn_complete"
    assert result["waited_s"] == 0.0
    # The fast path answers from recorded activity alone: an idle pane must not
    # cost a round-trip to its window.
    assert "ui_status" not in result


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


@pytest.mark.asyncio
async def test_wait_idle_trusts_the_window_when_the_busy_flag_is_stale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # busy is frontend-reported and can stay stuck on; the owning window's own
    # view of the pane is the signal that stays current.
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.01)
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", True)
    app._record_pane_activity("pw", "agent_active", "")

    async def _idle_window(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"ok": True, "result": {"status": "idle", "buffer": ""}}

    monkeypatch.setattr(plan_mcp, "_ui_request", _idle_window)

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"), timeout_s=1.0)

    assert result["idle"] is True
    assert result["source"] == "ui_status"


@pytest.mark.asyncio
async def test_wait_idle_keeps_waiting_while_the_window_reports_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.01)
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", True)

    async def _busy_window(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"ok": True, "result": {"status": "running", "buffer": ""}}

    monkeypatch.setattr(plan_mcp, "_ui_request", _busy_window)

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"), timeout_s=0.05)

    assert result["idle"] is False
    assert result["source"] == "timeout"
    # The window answered, and answered "still working" — a different failure
    # from a window that stopped answering at all.
    assert result["reason"] == "busy"


@pytest.mark.asyncio
async def test_wait_idle_backs_off_then_gives_up_on_a_window_that_does_not_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # With no window listening every probe burns the full _ui_request timeout,
    # so retries have to back off — but a single missed deadline is not proof
    # the window is gone, so one failure must not be the last probe either.
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.001)
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_UI_PROBE_EVERY", 1)
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", True)
    calls = 0

    async def _no_window(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"ok": False, "error": "no reply"}

    monkeypatch.setattr(plan_mcp, "_ui_request", _no_window)

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"), timeout_s=0.5)

    assert result["source"] == "timeout"
    # It retried, and it stopped: never more than the failure budget.
    assert calls == plan_mcp._WAIT_IDLE_UI_MAX_FAILURES
    assert result["reason"] == "unreachable"


@pytest.mark.asyncio
async def test_wait_idle_keeps_probing_a_window_that_recovers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One missed deadline used to disable probing for the rest of the wait,
    leaving only the unreliable busy flag."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.001)
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_UI_PROBE_EVERY", 1)
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", True)
    app._record_pane_activity("pw", "agent_active", "")
    calls = 0

    async def _flaky_window(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"ok": False, "error": "no reply"}
        return {"ok": True, "result": {"status": "idle", "buffer": ""}}

    monkeypatch.setattr(plan_mcp, "_ui_request", _flaky_window)

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"), timeout_s=0.5)

    assert result["idle"] is True
    assert result["source"] == "ui_status"


# ── cli_wait_idle: what it returns (P2-1 / P2-2) ─────────────────────────


@pytest.mark.asyncio
async def test_wait_idle_returns_what_the_finished_turn_said() -> None:
    """Knowing the pane is idle without knowing what it did forced a second
    cli_get_status call for the text that was already in hand."""
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    app._record_pane_activity("pw", "turn_complete", "tests pass")

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"))

    assert result["last_activity"]["type"] == "turn_complete"
    assert result["last_activity"]["text"] == "tests pass"


@pytest.mark.asyncio
async def test_wait_idle_omits_last_activity_when_the_pane_recorded_none() -> None:
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"))

    assert result["idle"] is True
    assert "last_activity" not in result


@pytest.mark.asyncio
async def test_wait_idle_timeout_says_the_pane_is_parked_on_a_human(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """"awaiting" is deliberately not idle — the pane is waiting on a permission
    prompt — but the caller still has to be able to tell that apart from work."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.001)
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", True)

    async def _awaiting_window(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"ok": True, "result": {"status": "awaiting", "buffer": ""}}

    monkeypatch.setattr(plan_mcp, "_ui_request", _awaiting_window)

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"), timeout_s=0.05)

    assert result["idle"] is False
    assert result["reason"] == "awaiting"
    assert result["ui_status"] == "awaiting"


@pytest.mark.asyncio
async def test_wait_idle_distinguishes_a_pane_that_never_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A CLI sitting at its prompt right after boot reports idle too. Saying
    # "done" there would tell a caller that just handed it a task that the
    # task finished, when it has not begun.
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.01)
    agent_messaging.register("pw", "worker", "/ws/alpha")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.set_busy("pw", True)

    async def _idle_window(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"ok": True, "result": {"status": "idle", "buffer": ""}}

    monkeypatch.setattr(plan_mcp, "_ui_request", _idle_window)

    result = await plan_mcp.cli_wait_idle("alpha/worker", _ctx(pane_id="other"), timeout_s=1.0)

    assert result["idle"] is True
    assert result["source"] == "never_started"


# ── cli_send_and_wait ────────────────────────────────────────────────────


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


def _seed_pair() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="claude")


def _deliver_when_sent(
    broadcasts: list[dict[str, Any]], ok: bool = True, reason: str = ""
) -> "asyncio.Task[None]":
    """Play the receiving window: report the outcome as soon as the send is out.

    cli_send_and_wait waits for the message to actually GO IN before it waits
    for the turn, so a test with no window to report the delivery is testing a
    message that never arrived — which is its own case, below.
    """

    async def run() -> None:
        for _ in range(2000):
            if broadcasts:
                break
            await asyncio.sleep(0.001)
        key = broadcasts[0]["payload"]["msg_key"]
        while not plan_mcp.record_delivery_result(key, ok, reason):
            await asyncio.sleep(0.001)

    return asyncio.create_task(run())


@pytest.mark.asyncio
async def test_send_and_wait_does_not_accept_the_state_it_sent_into(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    """The race this tool exists for: the target is idle when you send, so a
    plain wait returns "already idle" — with the PREVIOUS turn's text — before
    it has read a word of your message."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    monkeypatch.setattr(plan_mcp, "_SEND_AND_WAIT_START_GRACE_S", 0.02)
    _seed_pair()
    app._record_pane_activity("pw", "turn_complete", "the answer to the PREVIOUS question")

    delivery = _deliver_when_sent(broadcasts)
    result = await plan_mcp.cli_send_and_wait("worker", "a new question", _ctx(), timeout_s=0.1)
    await delivery

    assert result["idle"] is False
    assert result["reason"] == "never_started"
    # And it must not pass the stale turn off as the reply.
    assert "last_activity" not in result


@pytest.mark.asyncio
async def test_send_and_wait_returns_the_turn_that_followed_the_send(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    _seed_pair()
    app._record_pane_activity("pw", "turn_complete", "stale")

    async def worker_replies() -> None:
        await asyncio.sleep(0.02)
        app._record_pane_activity("pw", "turn_complete", "fresh")

    delivery = _deliver_when_sent(broadcasts)
    task = asyncio.create_task(worker_replies())
    result = await plan_mcp.cli_send_and_wait("worker", "go", _ctx(), timeout_s=2.0)
    await task
    await delivery

    assert result["ok"] is True
    assert result["idle"] is True
    assert result["source"] == "turn_complete"
    assert result["last_activity"]["text"] == "fresh"
    assert result["target"] == "alpha/worker"
    assert result["msg_key"] == broadcasts[0]["payload"]["msg_key"]


@pytest.mark.asyncio
async def test_send_and_wait_settles_on_quiet_for_a_cli_with_no_turn_complete(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    """cursor and friends never emit turn_complete, so the only completion
    available is silence — and `source` has to say so."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_QUIET_S", 0.0)
    _seed_pair()

    async def worker_stirs() -> None:
        await asyncio.sleep(0.02)
        app._record_pane_activity("pw", "agent_active", "")

    delivery = _deliver_when_sent(broadcasts)
    task = asyncio.create_task(worker_stirs())
    result = await plan_mcp.cli_send_and_wait("worker", "go", _ctx(), timeout_s=2.0)
    await task
    await delivery

    assert result["idle"] is True
    assert result["source"] == "quiet_period"


@pytest.mark.asyncio
async def test_send_and_wait_returns_a_refused_send_unchanged(
    broadcasts: list[dict[str, Any]],
) -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    result = await plan_mcp.cli_send_and_wait("nope", "go", _ctx(), timeout_s=0.1)
    assert result["ok"] is False
    assert "unknown target" in result["error"]
    assert broadcasts == []


@pytest.mark.asyncio
async def test_send_and_wait_refuses_an_empty_text_without_broadcasting(
    broadcasts: list[dict[str, Any]],
) -> None:
    _seed_pair()
    result = await plan_mcp.cli_send_and_wait("worker", "   ", _ctx(), timeout_s=0.1)
    assert result["ok"] is False
    assert "empty" in result["error"]
    assert broadcasts == []


@pytest.mark.asyncio
async def test_send_and_wait_no_longer_calls_a_held_message_idle(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    """The gap this closes. The target is idle, so the old order returned
    "idle, source turn_complete" — read as "it did your work" — while the
    message was still sitting in the window's queue because someone was typing
    in that pane. There was no turn, because nothing was ever handed over."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    _seed_pair()
    app._record_pane_activity("pw", "turn_complete", "the answer to the PREVIOUS question")

    async def the_window_reports_a_hold_and_nothing_else() -> None:
        for _ in range(2000):
            if broadcasts:
                break
            await asyncio.sleep(0.001)
        key = broadcasts[0]["payload"]["msg_key"]
        while not plan_mcp.record_message_hold(key, {"key": "typing"}):
            await asyncio.sleep(0.001)

    held = asyncio.create_task(the_window_reports_a_hold_and_nothing_else())
    result = await plan_mcp.cli_send_and_wait("worker", "go", _ctx(), timeout_s=0.2)
    await held

    assert result["ok"] is True
    assert result["idle"] is False
    assert result["source"] == "not_delivered"
    assert result["delivery_status"] == "queued"
    assert result["hold"] == {"key": "typing"}
    # The stale turn must not be passed off as the reply here either.
    assert "last_activity" not in result


@pytest.mark.asyncio
async def test_send_and_wait_reports_a_delivery_the_window_refused(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    """A message that bounced has no turn coming, and the reason is the whole
    answer — waiting out the timeout for it would tell the caller nothing."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    _seed_pair()

    delivery = _deliver_when_sent(broadcasts, ok=False, reason='{"key":"pane-closed"}')
    result = await plan_mcp.cli_send_and_wait("worker", "go", _ctx(), timeout_s=2.0)
    await delivery

    assert result["ok"] is True
    assert result["idle"] is False
    assert result["source"] == "not_delivered"
    assert result["delivery_status"] == "failed"
    assert result["reason"] == "pane-closed"


@pytest.mark.asyncio
async def test_send_and_wait_still_answers_a_zero_timeout_the_old_way(
    broadcasts: list[dict[str, Any]]
) -> None:
    """With no budget there is no delivery phase to run, so the degenerate
    call keeps the shape it had."""
    _seed_pair()
    result = await plan_mcp.cli_send_and_wait("worker", "go", _ctx(), timeout_s=0.0)

    assert result["ok"] is True
    assert result["source"] == "timeout"
    assert result["reason"] == "never_started"


# ── Addressing one exact pane by id ──────────────────────────────────────
# `pane_id` names one exact pane instead of the address argument, and has to
# mean the same thing in every tool that reads a pane as it does in cli_send.


def _external_ctx() -> Any:
    """A Context authenticated as an external client (no pane identity)."""
    plan_mcp_auth.set_external_enabled(True)
    params = {"client": "external", "t": plan_mcp_auth.external_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed_twins(workspace: str) -> None:
    """Two panes sharing one name in one workspace, plus a caller outside it.

    The caller sits elsewhere on purpose: a bare name never leaves its own
    workspace, so only the qualified form reaches these two — and that is the
    form that refuses them as ambiguous rather than guessing.
    """
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    agent_messaging.register("pw1", "worker", workspace, agent_key="claude")
    agent_messaging.register("pw2", "worker", workspace, agent_key="codex")


@pytest.mark.asyncio
async def test_read_log_by_pane_id_reads_the_twin_a_name_cannot(tmp_path: Path) -> None:
    _seed_twins(str(tmp_path))
    for pane, text in (("pw1", "first twin\n"), ("pw2", "second twin\n")):
        log = tmp_path / f"{pane}.log"
        log.write_text(text, encoding="utf-8")
        app.project_store.record_manual_pane_spawn(
            str(tmp_path), pane_id=pane, agent="claude", output_log_file=str(log)
        )

    by_name = await plan_mcp.cli_read_log(f"{tmp_path.name}/worker", _ctx(pane_id="other"))
    assert by_name["ok"] is False
    assert by_name["error_code"] == "ambiguous-target"

    result = await plan_mcp.cli_read_log("", _ctx(pane_id="other"), pane_id="pw2")
    assert result["ok"] is True
    assert result["log_path"] == str(tmp_path / "pw2.log")
    assert result["text"] == "second twin"


@pytest.mark.asyncio
async def test_read_log_refuses_a_pane_id_that_names_nothing(tmp_path: Path) -> None:
    _seed_pane(tmp_path)
    result = await plan_mcp.cli_read_log("", _ctx(), pane_id="nope")
    assert result["ok"] is False
    assert result["error_code"] == "unknown-pane-id"


@pytest.mark.asyncio
async def test_read_log_ignores_a_blank_pane_id(tmp_path: Path) -> None:
    """A blank id must not shadow the address — it is simply not given."""
    _seed_pane(tmp_path)
    log = tmp_path / "conv.log"
    log.write_text("line1\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(log)
    )

    result = await plan_mcp.cli_read_log("worker", _ctx(), pane_id="   ")

    assert result["ok"] is True
    assert result["text"] == "line1"


@pytest.mark.asyncio
async def test_read_log_by_pane_id_frees_an_external_caller_from_qualifying(
    tmp_path: Path,
) -> None:
    """An id is as qualified as an address gets, so the rule that a caller
    without a pane must name a workspace has nothing left to enforce."""
    _seed_pane(tmp_path)
    log = tmp_path / "conv.log"
    log.write_text("line1\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pw", agent="claude", output_log_file=str(log)
    )

    unqualified = await plan_mcp.cli_read_log("worker", _external_ctx())
    assert unqualified["ok"] is False
    assert "qualified" in unqualified["error"]

    result = await plan_mcp.cli_read_log("", _external_ctx(), pane_id="pw")
    assert result["ok"] is True
    assert result["target"] == f"{tmp_path.name}/worker"
    assert result["text"] == "line1"


@pytest.mark.asyncio
async def test_get_status_by_pane_id_reports_the_twin_a_name_cannot() -> None:
    _seed_twins("/ws/alpha")
    agent_messaging.set_busy("pw2", True)
    app._record_pane_activity("pw2", "turn_complete", "the second twin spoke")

    by_name = await plan_mcp.cli_get_status("alpha/worker", _ctx(pane_id="other"))
    assert by_name["ok"] is False
    assert by_name["error_code"] == "ambiguous-target"

    result = await plan_mcp.cli_get_status("", _ctx(pane_id="other"), pane_id="pw2")
    assert result["ok"] is True
    # The twins differ only by agent_key here, which is how this says which one
    # answered — both carry the same name and the same qualified address.
    assert result["agent_key"] == "codex"
    assert result["busy"] is True
    assert result["last_activity"]["text"] == "the second twin spoke"


@pytest.mark.asyncio
async def test_get_status_refuses_a_pane_id_that_names_nothing() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    result = await plan_mcp.cli_get_status("", _ctx(), pane_id="nope")
    assert result["ok"] is False
    assert result["error_code"] == "unknown-pane-id"


@pytest.mark.asyncio
async def test_get_status_ignores_a_blank_pane_id() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="codex")

    result = await plan_mcp.cli_get_status("worker", _ctx(), pane_id="   ")

    assert result["ok"] is True
    assert result["agent_key"] == "codex"


@pytest.mark.asyncio
async def test_wait_idle_by_pane_id_waits_on_the_twin_a_name_cannot() -> None:
    _seed_twins("/ws/alpha")
    app._record_pane_activity("pw2", "turn_complete", "second twin done")

    by_name = await plan_mcp.cli_wait_idle(
        "alpha/worker", _ctx(pane_id="other"), timeout_s=0.05
    )
    assert by_name["ok"] is False
    assert by_name["error_code"] == "ambiguous-target"

    result = await plan_mcp.cli_wait_idle("", _ctx(pane_id="other"), pane_id="pw2")

    assert result["idle"] is True
    assert result["source"] == "turn_complete"
    assert result["last_activity"]["text"] == "second twin done"


@pytest.mark.asyncio
async def test_wait_idle_refuses_a_pane_id_that_names_nothing() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    result = await plan_mcp.cli_wait_idle("", _ctx(), pane_id="nope", timeout_s=0.05)
    assert result["ok"] is False
    assert result["error_code"] == "unknown-pane-id"


@pytest.mark.asyncio
async def test_wait_idle_ignores_a_blank_pane_id() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw", "worker", "/ws/alpha")
    app._record_pane_activity("pw", "turn_complete", "done")

    result = await plan_mcp.cli_wait_idle("worker", _ctx(), pane_id="   ", timeout_s=0.05)

    assert result["idle"] is True
    assert result["source"] == "turn_complete"


@pytest.mark.asyncio
async def test_send_and_wait_by_pane_id_reaches_the_twin_a_name_cannot(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    """An id given here addresses both halves — the send, and the wait for the
    turn it should produce — so the reply has to come from the same twin the
    message went into."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    _seed_twins("/ws/alpha")

    by_name = await plan_mcp.cli_send_and_wait(
        "alpha/worker", "go", _ctx(pane_id="other"), timeout_s=0.1
    )
    assert by_name["ok"] is False
    assert by_name["error_code"] == "ambiguous-target"
    assert broadcasts == []

    async def the_second_twin_replies() -> None:
        await asyncio.sleep(0.02)
        app._record_pane_activity("pw2", "turn_complete", "second twin done")

    delivery = _deliver_when_sent(broadcasts)
    task = asyncio.create_task(the_second_twin_replies())
    result = await plan_mcp.cli_send_and_wait(
        "", "go", _ctx(pane_id="other"), timeout_s=2.0, pane_id="pw2"
    )
    await task
    await delivery

    assert result["ok"] is True
    assert result["idle"] is True
    assert result["source"] == "turn_complete"
    assert result["last_activity"]["text"] == "second twin done"
    assert broadcasts[0]["payload"]["target_pane_id"] == "pw2"


@pytest.mark.asyncio
async def test_send_and_wait_refuses_a_pane_id_that_names_nothing(
    broadcasts: list[dict[str, Any]],
) -> None:
    _seed_pair()
    result = await plan_mcp.cli_send_and_wait("", "go", _ctx(), timeout_s=0.1, pane_id="nope")
    assert result["ok"] is False
    assert result["error_code"] == "unknown-pane-id"
    assert broadcasts == []


@pytest.mark.asyncio
async def test_send_and_wait_ignores_a_blank_pane_id(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    _seed_pair()

    async def worker_replies() -> None:
        await asyncio.sleep(0.02)
        app._record_pane_activity("pw", "turn_complete", "fresh")

    delivery = _deliver_when_sent(broadcasts)
    task = asyncio.create_task(worker_replies())
    result = await plan_mcp.cli_send_and_wait(
        "worker", "go", _ctx(), timeout_s=2.0, pane_id="   "
    )
    await task
    await delivery

    assert result["ok"] is True
    assert result["idle"] is True
    assert broadcasts[0]["payload"]["target_pane_id"] == "pw"
