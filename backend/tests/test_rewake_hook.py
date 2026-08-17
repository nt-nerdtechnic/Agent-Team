"""Rewake delivery: POST /hooks/claude/rewake parking a background hook.

The Stop hook covers a message that arrives while a claude pane is working. A
pane sitting idle runs no hook at all, so instead one is left waiting here and
answered when there is something to say — Claude Code wakes the agent on the
hook's exit code and shows its stderr as a system reminder, with nothing typed
into the pane.

What is worth pinning down is the shape of that answer, that a waiter is never
answered twice, and that everything which cannot produce one returns promptly:
declining is what leaves the message to the ordinary typed path, while hanging
on would hold the channel open against a pane that no longer has it.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app as app_module
from agent_team_backend import claude_hooks, push_delivery
from agent_team_backend.app import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture()
def events(monkeypatch) -> list[dict]:
    captured: list[dict] = []

    async def fake_broadcast(event, **_kwargs):
        captured.append(event)

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    return captured


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    push_delivery._reset_for_test()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pane-1", "/ws/alpha", "")
    )
    yield
    push_delivery._reset_for_test()


def _url(token: str | None = None) -> str:
    """The endpoint as the installed hook addresses it, freshness token and all."""
    return f"/hooks/claude/rewake?t={token if token is not None else push_delivery.rewake_token()}"


def _park(client: TestClient, session_id: str = "s-1"):
    return client.post(_url(), json={"session_id": session_id})


# ── the endpoint ────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_a_parked_hook_is_answered_with_the_envelope(events) -> None:
    import httpx

    async def push_once() -> None:
        # Wait for the request to register its waiter, then hand it a message.
        for _ in range(400):
            if push_delivery.is_ready("pane-1"):
                break
            await asyncio.sleep(0.01)
        assert await push_delivery.deliver(
            "pane-1", "[Navide MSG] from: builder-1\ndo the thing"
        ) == (True, "")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        pusher = asyncio.create_task(push_once())
        resp = await http.post(_url(), json={"session_id": "s-1"})
        await pusher
    assert resp.status_code == 200
    body = resp.text
    assert "[Navide MSG] from: builder-1" in body
    assert "do the thing" in body
    # The reminder prefix is what tells the agent this is work handed to it,
    # rather than a note about its own run.
    assert body.startswith("[Navide]")


@pytest.mark.asyncio
async def test_a_waiter_is_answered_only_once(events) -> None:
    """The envelope is consumed by the hook that took it: a second message has
    to wait for the next waiter rather than vanishing into a spent one."""
    import httpx

    async def push_twice() -> None:
        for _ in range(400):
            if push_delivery.is_ready("pane-1"):
                break
            await asyncio.sleep(0.01)
        assert await push_delivery.deliver("pane-1", "first") == (True, "")
        assert await push_delivery.deliver("pane-1", "second") == (False, "not-armed")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        pusher = asyncio.create_task(push_twice())
        resp = await http.post(_url(), json={"session_id": "s-1"})
        await pusher
    assert "first" in resp.text
    assert "second" not in resp.text


def test_a_session_no_pane_owns_is_declined_at_once(
    client: TestClient, events, monkeypatch
) -> None:
    monkeypatch.setattr(app_module, "_REWAKE_ATTRIBUTION_WAIT_S", 0.0)
    monkeypatch.setattr(app_module.attribution, "pane_for_session", lambda _sid: ("", None, None))
    resp = _park(client)
    assert resp.status_code == 200
    assert resp.text == ""


def test_a_payload_without_a_session_is_declined_at_once(client: TestClient, events) -> None:
    resp = client.post(_url(), json={})
    assert resp.status_code == 200
    assert resp.text == ""


def test_the_wait_ends_empty_rather_than_hanging(
    client: TestClient, events, monkeypatch
) -> None:
    monkeypatch.setattr(push_delivery, "HOOK_WAIT_S", 0.05)
    resp = _park(client)
    assert resp.status_code == 200
    assert resp.text == ""
    # And the channel is announced gone, so no window keeps offering it.
    states = [e["payload"] for e in events if e["type"] == "agent_msg.push_state"]
    assert states[0]["ready"] is True
    assert states[-1]["ready"] is False


def test_the_channel_is_announced_while_a_hook_is_parked(
    client: TestClient, events, monkeypatch
) -> None:
    monkeypatch.setattr(push_delivery, "HOOK_WAIT_S", 0.05)
    _park(client)
    states = [e["payload"] for e in events if e["type"] == "agent_msg.push_state"]
    assert states[0] == {"pane_id": "pane-1", "kind": "rewake", "ready": True}


def test_a_pane_running_another_cli_is_never_parked(
    client: TestClient, events, monkeypatch
) -> None:
    """register_hook_pane consults the vendor registry, so only a CLI that
    declares the channel can hold one open."""
    monkeypatch.setattr(push_delivery, "channel_for", lambda _key: None)
    resp = _park(client)
    assert resp.status_code == 200
    assert resp.text == ""


@pytest.mark.asyncio
async def test_an_envelope_past_the_cli_cap_is_left_to_the_typed_path() -> None:
    """Claude Code writes hook output past 10,000 characters to a file and
    shows a preview instead, so half an instruction would reach the agent."""
    push_delivery.register_hook_pane("pane-1", "claude")
    assert push_delivery.arm_hook("pane-1") is not None
    assert await push_delivery.deliver("pane-1", "x" * 10_001) == (False, "too-long")
    # Just inside the cap, with the prefix counted, still goes.
    assert await push_delivery.deliver("pane-1", "ok") == (True, "")


def test_a_request_without_the_run_token_is_refused(client: TestClient, events) -> None:
    """A hook left over from an earlier backend run, or anything that never
    went through the installer, must not be able to park on someone's pane."""
    resp = client.post("/hooks/claude/rewake", json={"session_id": "s-1"})
    assert resp.status_code == 403
    assert resp.text == ""
    assert not push_delivery.is_ready("pane-1")


def test_a_request_with_the_wrong_run_token_is_refused(
    client: TestClient, events
) -> None:
    resp = client.post(_url("stale-token"), json={"session_id": "s-1"})
    assert resp.status_code == 403
    assert resp.text == ""


def test_a_hook_that_hangs_up_takes_its_waiter_with_it(
    client: TestClient, events, monkeypatch
) -> None:
    """The user ran `/exit` inside a pane they left open, so the curl died. The
    future the request awaits is untouched by that, and a pane left advertising
    a channel would report every message pushed to it as delivered with no
    agent anywhere near it.

    The disconnect itself is stubbed rather than staged: an ASGI transport does
    not deliver `http.disconnect` on a cancelled client call, so driving it for
    real would need a live server and would test the transport rather than what
    this endpoint does about it.
    """
    async def gone(_request):
        return None

    monkeypatch.setattr(app_module, "_hook_still_connected", gone)
    resp = _park(client)
    assert resp.status_code == 200
    assert resp.text == ""
    # The waiter is dropped, not merely unanswered: the pane stops offering the
    # channel, and a message arriving now is refused rather than swallowed.
    assert not push_delivery.is_ready("pane-1")
    assert asyncio.run(push_delivery.deliver("pane-1", "hi")) == (False, "not-armed")
    states = [e["payload"] for e in events if e["type"] == "agent_msg.push_state"]
    assert states[-1]["ready"] is False


# ── the installed hook ──────────────────────────────────────────────────────
def _installed(tmp_path) -> dict:
    settings = tmp_path / "settings.json"
    claude_hooks.install_hooks("/tmp/port", settings_file=settings)
    return json.loads(settings.read_text(encoding="utf-8"))["hooks"]


def _rewake_hooks(hooks: dict, event: str) -> list[dict]:
    return [
        h
        for entry in hooks.get(event, [])
        for h in entry.get("hooks", [])
        if h.get("asyncRewake")
    ]


def test_the_waiter_is_armed_at_session_start_and_re_armed_at_every_stop(tmp_path) -> None:
    hooks = _installed(tmp_path)
    assert len(_rewake_hooks(hooks, "SessionStart")) == 1
    assert len(_rewake_hooks(hooks, "Stop")) == 1
    # UserPromptSubmit is deliberately not armed — see claude_hooks.
    assert _rewake_hooks(hooks, "UserPromptSubmit") == []


def test_the_stop_event_keeps_both_its_hooks(tmp_path) -> None:
    """The synchronous signal hook and the parked waiter do different jobs and
    both belong on Stop."""
    hooks = _installed(tmp_path)
    commands = [h["command"] for entry in hooks["Stop"] for h in entry.get("hooks", [])]
    assert any("X-Agent-Team-Event: stop" in c for c in commands)
    assert any("X-Agent-Team-Event: rewake" in c for c in commands)


def test_the_waiter_declares_a_timeout_outside_the_backends_own(tmp_path) -> None:
    """The backend has to be the one that gives up first: a hook that timed out
    while the backend still believed in its waiter would take a message with
    it."""
    hook = _rewake_hooks(_installed(tmp_path), "Stop")[0]
    assert hook["timeout"] > claude_hooks._REWAKE_CURL_TIMEOUT_S
    assert claude_hooks._REWAKE_CURL_TIMEOUT_S > push_delivery.HOOK_WAIT_S


def test_the_waiter_carries_this_runs_freshness_token(tmp_path) -> None:
    hook = _rewake_hooks(_installed(tmp_path), "SessionStart")[0]
    assert f"?t={push_delivery.rewake_token()}" in hook["command"]


def test_the_waiter_exits_zero_when_the_backend_has_nothing_to_say(tmp_path) -> None:
    """Exit 2 is the wake signal, so it must be reachable only with a body."""
    hook = _rewake_hooks(_installed(tmp_path), "SessionStart")[0]
    command = hook["command"]
    assert '[ -n "$BODY" ] || exit 0' in command
    assert command.rstrip().endswith("exit 2")
    assert ">&2" in command


def test_reinstalling_does_not_stack_waiters(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    claude_hooks.install_hooks("/tmp/port", settings_file=settings)
    claude_hooks.install_hooks("/tmp/port", settings_file=settings)
    hooks = json.loads(settings.read_text(encoding="utf-8"))["hooks"]
    assert len(_rewake_hooks(hooks, "SessionStart")) == 1
    assert len(_rewake_hooks(hooks, "Stop")) == 1


def test_uninstall_removes_the_waiter_too(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    claude_hooks.install_hooks("/tmp/port", settings_file=settings)
    claude_hooks.uninstall_hooks(settings_file=settings)
    hooks = json.loads(settings.read_text(encoding="utf-8")).get("hooks", {})
    assert _rewake_hooks(hooks, "SessionStart") == []
    assert _rewake_hooks(hooks, "Stop") == []


def test_a_users_own_session_start_hook_survives_installation(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    settings.write_text(
        json.dumps({"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "mine"}]}]}}),
        encoding="utf-8",
    )
    claude_hooks.install_hooks("/tmp/port", settings_file=settings)
    hooks = json.loads(settings.read_text(encoding="utf-8"))["hooks"]
    commands = [h["command"] for entry in hooks["SessionStart"] for h in entry.get("hooks", [])]
    assert "mine" in commands


