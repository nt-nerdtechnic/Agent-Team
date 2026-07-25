"""cli_profiles.* WS handlers + the no-isolation spawn contract.

Accounts share the real home: terminal.create must not inject any profile
config-home env, and cli_profiles.set_default swaps credentials through the
vault (guarded against running panes)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import os

import pytest

from agent_team_backend import app
from agent_team_backend import ws_handlers
from agent_team_backend.profiles_store import CliProfilesStore


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.written: list[tuple[str, str]] = []
        self.registry: dict[str, SimpleNamespace] = {}

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id="term-1",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    def get(self, session_id: str) -> SimpleNamespace | None:
        return self.registry.get(session_id)

    def write(self, session_id: str, data: str) -> None:
        self.written.append((session_id, data))


class FakeAttribution:
    def __init__(self) -> None:
        self.registered: list[dict[str, Any]] = []

    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        self.registered.append({"pane_id": pane_id, **kwargs})


class FakeCodexHomeManager:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.real_home = root / "real-codex"
        self.prepared: list[str] = []

    def prepare(self, home_id: str) -> Path:
        self.prepared.append(home_id)
        return self.root / home_id

    def find_session_home(self, resume_id: str) -> Path | None:
        return None


class FakeVault:
    def __init__(self, fail: bool = False) -> None:
        self.switch_calls: list[tuple[str, str, str]] = []
        self.fail = fail

    def switch(self, agent_key: str, from_slot_id: str, to_slot_id: str) -> None:
        self.switch_calls.append((agent_key, from_slot_id, to_slot_id))
        if self.fail:
            raise RuntimeError("swap boom")


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def _stub_agent_cli_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        app,
        "_probe_agent_cli_for_spawn",
        lambda agent_key, _command=None: {
            "agent_key": agent_key,
            "binary_path": f"/test/bin/{agent_key}",
            "version": "1.0.0",
            "duration_ms": 1,
        } if agent_key and agent_key != "terminal" else None,
    )


@pytest.fixture()
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CliProfilesStore:
    s = CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "cli-profiles",
    )
    monkeypatch.setattr(app, "cli_profiles_store", s)
    return s


@pytest.fixture()
def vault(monkeypatch: pytest.MonkeyPatch) -> FakeVault:
    v = FakeVault()
    monkeypatch.setattr(app, "credential_vault", v)
    return v


@pytest.fixture()
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def record(event: dict[str, Any], *, exclude: Any = None) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", record)
    return sent


@pytest.fixture()
def spawn_stubs(monkeypatch: pytest.MonkeyPatch) -> FakeAttribution:
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    return fake_attr


def _register_running_terminal(
    session: app.Session, terminal_id: str, agent_key: str, closed: bool = False
) -> None:
    term = SimpleNamespace(id=terminal_id, agent_key=agent_key, closed=closed)
    session.terminals.registry[terminal_id] = term  # type: ignore[attr-defined]
    app._PTY_OWNERS[terminal_id] = session


# ---- cli_profiles.* CRUD handlers ----


async def test_cli_profiles_create_and_list(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "c1",
        "type": "cli_profiles.create",
        "payload": {"agent_key": "claude", "name": "Work"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    profile = response["payload"]["profile"]
    assert profile["agentKey"] == "claude"
    assert response["payload"]["profiles"] == [profile]
    assert events[0]["type"] == "cli_profiles.changed"
    assert events[0]["payload"]["reason"] == "create"

    await app.handle_message(session, {
        "id": "l1", "type": "cli_profiles.list", "payload": {},
    })

    listing = session.websocket.sent[1]  # type: ignore[attr-defined]
    assert listing["payload"]["profiles"] == [profile]
    assert listing["payload"]["defaults"] == {
        "claude": None, "codex": None, "kimi": None, "grok": None,
    }
    assert listing["payload"]["supported_agents"] == ["claude", "codex", "kimi", "grok"]


async def test_cli_profiles_create_rejects_unsupported_agent(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "c2",
        "type": "cli_profiles.create",
        "payload": {"agent_key": "antigravity", "name": "X"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"
    assert events == []


async def test_cli_profiles_rename_delete_set_default_flow(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    session = _session()
    profile = store.create(agent_key="kimi", name="Old")

    await app.handle_message(session, {
        "id": "r1",
        "type": "cli_profiles.rename",
        "payload": {"id": profile["id"], "name": "New"},
    })
    assert session.websocket.sent[0]["payload"]["profile"]["name"] == "New"  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "d1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": profile["id"]},
    })
    assert session.websocket.sent[1]["payload"]["defaults"]["kimi"] == profile["id"]  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "d2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": None},
    })
    assert session.websocket.sent[2]["payload"]["defaults"]["kimi"] is None  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "x1",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })
    assert session.websocket.sent[3]["payload"]["profiles"] == []  # type: ignore[attr-defined]
    assert [e["payload"]["reason"] for e in events] == [
        "rename", "set_default", "set_default", "delete",
    ]


async def test_set_default_triggers_usage_refresh(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Switching the active account forces the usage poller to re-fetch now so
    the quota badge reflects the new account immediately."""
    from agent_team_backend import usage_service

    calls: list[int] = []
    monkeypatch.setattr(usage_service.service, "request_refresh", lambda: calls.append(1))
    session = _session()
    profile = store.create(agent_key="codex", name="Work")

    await app.handle_message(session, {
        "id": "sd1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "codex", "profile_id": profile["id"]},
    })

    assert session.websocket.sent[0]["ok"] is True  # type: ignore[attr-defined]
    assert calls == [1]


async def test_cli_profiles_delete_clears_default(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    """Deleting the profile that was an agent's default resets that default to
    the built-in Default (null)."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])

    await app.handle_message(session, {
        "id": "x3",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert response["payload"]["defaults"]["claude"] is None
    assert events[-1]["payload"]["defaults"]["claude"] is None


async def test_cli_profiles_rename_unknown_is_bad_request(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "r2",
        "type": "cli_profiles.rename",
        "payload": {"id": "nope1234", "name": "X"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"


# ---- cli_profiles.set_default credential swap semantics ----


async def test_set_default_swaps_credentials_via_vault(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """null→B captures live into the reserved default slot and restores B;
    B→null captures live into B and restores the reserved slot."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")

    await app.handle_message(session, {
        "id": "s1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })
    await app.handle_message(session, {
        "id": "s2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": None},
    })

    assert vault.switch_calls == [
        ("claude", "__default__", profile["id"]),
        ("claude", profile["id"], "__default__"),
    ]
    assert store.list()["defaults"]["claude"] is None


async def test_set_default_noop_when_already_active(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Re-selecting the already-active account must not touch any credentials."""
    session = _session()

    await app.handle_message(session, {
        "id": "n1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "grok", "profile_id": None},
    })

    assert session.websocket.sent[0]["ok"] is True  # type: ignore[attr-defined]
    assert vault.switch_calls == []
    assert events == []


async def test_set_default_rejected_while_agent_pane_running(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    _register_running_terminal(session, "t1", "claude")
    _register_running_terminal(session, "t2", "claude")

    await app.handle_message(session, {
        "id": "b1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "PROFILE_IN_USE"
    assert response["error"]["details"]["running_count"] == 2
    assert vault.switch_calls == []
    assert store.list()["defaults"]["claude"] is None


async def test_set_default_other_agent_pane_does_not_block(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    _register_running_terminal(session, "t1", "codex")
    _register_running_terminal(session, "t2", "claude", closed=True)

    await app.handle_message(session, {
        "id": "b2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    assert session.websocket.sent[0]["ok"] is True  # type: ignore[attr-defined]
    assert vault.switch_calls == [("claude", "__default__", profile["id"])]


async def test_set_default_force_sends_esc_and_swaps(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """force=true never kills a pane: each running CLI of the agent gets one
    ESC byte, then the swap proceeds normally."""
    monkeypatch.setattr(ws_handlers, "FORCE_SWITCH_ESC_SETTLE_S", 0)
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    _register_running_terminal(session, "t1", "claude")
    _register_running_terminal(session, "t2", "codex")

    await app.handle_message(session, {
        "id": "f1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"], "force": True},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert session.terminals.written == [("t1", "\x1b")]  # type: ignore[attr-defined]
    assert vault.switch_calls == [("claude", "__default__", profile["id"])]
    # Pane survives: still registered, never killed.
    assert "t1" in app._PTY_OWNERS


async def test_set_default_swap_failure_keeps_old_default(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failing = FakeVault(fail=True)
    monkeypatch.setattr(app, "credential_vault", failing)
    session = _session()
    profile = store.create(agent_key="kimi", name="Work")

    await app.handle_message(session, {
        "id": "e1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "PROFILE_SWAP_FAILED"
    assert store.list()["defaults"]["kimi"] is None
    assert events == []


# ---- terminal.create: accounts share the real home (no env isolation) ----


async def test_terminal_create_claude_default_only_drops_api_overrides(
    store: CliProfilesStore, spawn_stubs: FakeAttribution
) -> None:
    """With a managed claude account active the spawn gets NO config-home env;
    the only effect is dropping inherited Anthropic API overrides so they
    cannot shadow the managed OAuth login."""
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])
    session = _session()

    await app.handle_message(session, {
        "id": "m2",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"] is None
    assert created["env_remove"] == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    assert "profile_id" not in created["metadata"]
    # No isolated home is created at spawn any more.
    assert not store.home_path(profile).exists()


async def test_terminal_create_without_profile_is_unchanged(
    store: CliProfilesStore, spawn_stubs: FakeAttribution
) -> None:
    """Hard regression gate: no active account (built-in default) must spawn
    with the exact pre-profile arguments — no env, no env_remove, no metadata."""
    session = _session()

    await app.handle_message(session, {
        "id": "m3",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"] is None
    assert created["env_remove"] is None
    assert "profile_id" not in created["metadata"]


@pytest.mark.parametrize("agent_key", ["kimi", "grok"])
async def test_terminal_create_active_account_injects_nothing(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, agent_key: str
) -> None:
    """kimi/grok spawns are env-identical with and without an active account:
    no KIMI_CODE_HOME, no HOME shim."""
    profile = store.create(agent_key=agent_key, name="Work")
    store.set_default(agent_key, profile["id"])
    session = _session()

    await app.handle_message(session, {
        "id": "m6",
        "type": "terminal.create",
        "payload": {
            "pane_id": f"{agent_key}-pane",
            "agent_key": agent_key,
            "command": agent_key,
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"] is None
    assert created["env_remove"] is None
    assert "profile_id" not in created["metadata"]


async def test_terminal_create_codex_active_account_uses_real_home_source(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The per-pane CODEX_HOME mechanism stays, but its symlink source is
    always the real ~/.codex — an active account changes nothing."""
    profile = store.create(agent_key="codex", name="Work")
    store.set_default("codex", profile["id"])
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    session = _session()

    await app.handle_message(session, {
        "id": "m8",
        "type": "terminal.create",
        "payload": {
            "pane_id": "codex-pane",
            "agent_key": "codex",
            "command": "codex",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "session_home_id": "stable-home"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == ["stable-home"]
    assert created["env"]["CODEX_HOME"] == str(tmp_path / "codex-panes" / "stable-home")
    assert created["env_remove"] is None
    assert "profile_id" not in created["metadata"]


def test_sanitize_inherited_cli_env_drops_home_relocations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A backend launched from a shell that still carried home-relocating vars
    # (e.g. `pnpm dev` inside an old profile pane) must not pass them on.
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/tmp/poisoned-claude")
    monkeypatch.setenv("CODEX_HOME", "/tmp/poisoned-codex")

    app._sanitize_inherited_cli_env()

    assert "CLAUDE_CONFIG_DIR" not in os.environ
    assert "CODEX_HOME" not in os.environ
