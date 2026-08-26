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


def test_hook_vendors_are_exactly_those_declaring_an_installer() -> None:
    """Installing hooks and being allowed to post them are one decision.

    They used to be two: a `frozenset` here and three hand-written install
    blocks at startup. A vendor added to one and not the other would either
    install hooks the endpoint rejects, or be admitted to an endpoint nothing
    ever points at it.
    """
    from agent_team_backend.cli_vendors.registry import VENDORS

    declared = {k for k, s in VENDORS.items() if s.install_hooks is not None}

    assert declared == set(app_module._HOOK_VENDORS)
    assert declared == {"claude", "copilot", "qwen"}


def test_each_declared_installer_is_callable_and_isolated(monkeypatch, tmp_path) -> None:
    """Every installer runs against a config root that does not exist, which
    is what a machine without that CLI looks like: it must no-op, not raise —
    startup treats a raising installer as non-fatal but logs it as a failure.
    """
    from agent_team_backend.cli_vendors.registry import VENDORS

    monkeypatch.setenv("HOME", str(tmp_path))
    port_file = tmp_path / "port.txt"
    port_file.write_text("54321")
    for key, spec in VENDORS.items():
        if spec.install_hooks is None:
            continue
        result = spec.install_hooks(str(port_file))
        assert isinstance(result, dict), f"{key} installer returned {type(result)}"


def test_stop_hook_records_pane_activity_so_wait_idle_sees_it(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """The hook is the earliest and most reliable end-of-turn signal there is,
    but it only ever reached the frontend: `_pane_activity` was written from
    the log-reader sink alone, so cli_wait_idle could not see a hook-reported
    turn end and had to sit out its 10s quiet threshold instead.
    """
    import asyncio
    from types import SimpleNamespace

    from agent_team_backend import agent_messaging
    from agent_team_backend.plugins.builtin.navide_plans import plan_mcp, plan_mcp_wiring

    agent_messaging._reset_for_test()
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="claude")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    try:
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "stop"},
            json={"session_id": "s-1", "cwd": "/ws/alpha"},
        )

        assert app_module._pane_activity["pw"]["event_type"] == "turn_complete"

        ctx = SimpleNamespace(
            request_context=SimpleNamespace(
                request=SimpleNamespace(
                    query_params={"pane": "other", "t": plan_mcp_wiring.caller_token()}
                )
            )
        )
        result = asyncio.run(plan_mcp.cli_wait_idle("alpha/worker", ctx, timeout_s=5.0))

        assert result["idle"] is True
        assert result["source"] == "turn_complete"
        assert result["waited_s"] == 0.0
    finally:
        agent_messaging._reset_for_test()
        app_module._pane_activity.clear()


def test_stop_hook_does_not_blank_the_turn_text_the_log_reader_recorded(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """Hook payloads carry no assistant text. Recording one over a
    turn_complete the JSONL reader already described would cost cli_wait_idle
    and cli_get_status the text of the turn that just ended."""
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    app_module._record_pane_activity("pw", "turn_complete", "what the agent said")
    try:
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "stop"},
            json={"session_id": "s-1", "cwd": "/ws/alpha"},
        )
        assert app_module._pane_activity["pw"]["text"] == "what the agent said"
    finally:
        app_module._pane_activity.clear()


def test_a_reattached_panes_hook_keeps_the_text_recorded_under_its_old_id(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """Session attribution answers with the id the PTY was created under, and a
    pane rebuilt around that PTY answers to a newer one — so the activity cache
    is filed under the new id while the hook arrives naming the old. The hook
    re-reads the entry it is about to overwrite, so both ends have to resolve
    the same way or a reattached pane's turn text is blanked."""
    from agent_team_backend import agent_messaging

    agent_messaging._reset_for_test()
    app_module._pane_activity.clear()
    agent_messaging.register("pw2", "worker", "/ws/alpha", agent_key="claude")
    agent_messaging.add_aliases("pw2", ["pw"], "/ws/alpha")
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    app_module._record_pane_activity("pw", "turn_complete", "what the agent said")
    try:
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "stop"},
            json={"session_id": "s-1", "cwd": "/ws/alpha"},
        )
        assert app_module._pane_activity["pw2"]["text"] == "what the agent said"
        # ...and only ever one entry: a pane must not accumulate one per reload.
        assert "pw" not in app_module._pane_activity
    finally:
        agent_messaging._reset_for_test()
        app_module._pane_activity.clear()


def test_hook_with_no_resolvable_pane_records_nothing(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    # Stop can arrive before the JSONL path claimed the session; there is no
    # pane to attribute it to, and inventing one would be worse than waiting.
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: (None, None, None)
    )
    client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "stop"},
        json={"session_id": "unclaimed", "cwd": "/ws/alpha"},
    )
    assert app_module._pane_activity == {}


# ── Background-subagent counting ───────────────────────────────────────────
#
# PreToolUse(Task) in, SubagentStop out. The resulting count rides on every
# broadcast so the frontend loop can tell a turn that ended DONE from one that
# ended to WAIT — a CLI parked on a background agent fires the Stop hook for
# real, so nothing else it reports reveals the difference.


@pytest.fixture()
def attributed(monkeypatch):
    """Resolve every session to one pane, and start it with a clean count."""
    from agent_team_backend import subagent_tracker

    pane_id = "pane-hooked"
    subagent_tracker.reset(pane_id)
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: (pane_id, "/tmp/ws", "")
    )
    yield pane_id
    subagent_tracker.reset(pane_id)


def _post(client: TestClient, kind: str, **body) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": kind},
        json={"session_id": "s-1", "cwd": "/tmp/ws", **body},
    )
    assert resp.status_code == 200


def test_task_pre_tool_use_reports_a_pending_subagent(
    client: TestClient, events: list[dict], attributed: str
) -> None:
    _post(client, "pre_tool_use", tool_name="Task")
    payload = _payload(events)
    assert payload["event_type"] == "agent_active"
    assert payload["pending_subagents"] == 1


def test_subagent_stop_clears_the_count_and_reads_as_activity(
    client: TestClient, events: list[dict], attributed: str
) -> None:
    _post(client, "pre_tool_use", tool_name="Task")
    events.clear()
    _post(client, "subagent_stop")
    payload = _payload(events)
    # It joins agent_active rather than earning a third bucket: the main agent
    # is about to pick its work back up, which is what agent_active says.
    assert payload["event_type"] == "agent_active"
    assert payload["detail"] == "hook:subagent_stop"
    assert payload["pending_subagents"] == 0


def test_a_turn_that_ends_while_a_subagent_runs_still_reports_the_count(
    client: TestClient, events: list[dict], attributed: str
) -> None:
    # The reported spin, in one exchange: two background agents started, then
    # the main agent stops to wait for them. turn_complete is truthful — the
    # turn really ended — and pending_subagents is what says "don't continue".
    _post(client, "pre_tool_use", tool_name="Task")
    _post(client, "pre_tool_use", tool_name="Task")
    events.clear()
    _post(client, "stop")
    payload = _payload(events)
    assert payload["event_type"] == "turn_complete"
    assert payload["pending_subagents"] == 2


def test_ordinary_tool_use_does_not_report_a_subagent(
    client: TestClient, events: list[dict], attributed: str
) -> None:
    _post(client, "pre_tool_use", tool_name="Read")
    assert _payload(events)["pending_subagents"] == 0


def test_an_unknown_event_kind_is_still_rejected(client: TestClient, events: list[dict]) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "subagent_start"},
        json={"session_id": "s-1"},
    )
    assert resp.json()["ok"] is False
    assert events == []


def test_a_vendor_that_cannot_report_subagent_stops_never_counts(
    client: TestClient, events: list[dict], attributed: str, monkeypatch
) -> None:
    """Counting needs both halves; one half alone climbs forever.

    qwen installs a Notification hook and nothing else, so it can report a tool
    going in but never a subagent coming back out. A count stuck above zero
    would hold that pane's loop back for the whole staleness window — worse
    than not counting at all.
    """
    monkeypatch.setattr(app_module, "_HOOK_VENDORS", frozenset({"claude", "qwen"}))
    resp = client.post(
        "/hooks/qwen",
        headers={"X-Agent-Team-Event": "pre_tool_use"},
        json={"session_id": "s-1", "cwd": "/tmp/ws", "tool_name": "Task"},
    )
    assert resp.status_code == 200
    assert _payload(events)["pending_subagents"] == 0
