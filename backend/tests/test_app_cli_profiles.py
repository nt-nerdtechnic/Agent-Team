"""cli_profiles.* WS handlers + the per-pane profile-isolation spawn contract.

Managed accounts run each pane inside the profile's persistent isolated home
(pinned at spawn, so a resume returns to the SAME account). cli_profiles.
set_default swaps the live credentials through the vault and only decides which
account NEW panes bind to — it never kills or disturbs running panes."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import asyncio
import os
import shutil

import pytest

from agent_team_backend import app
from agent_team_backend import ws_handlers
from agent_team_backend.credential_vault import CredentialVault
from agent_team_backend.profiles_store import CliProfilesStore


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeProc:
    def __init__(self) -> None:
        self.alive = True

    def poll(self) -> int | None:
        return None if self.alive else 0


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.killed: list[str] = []
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

    async def kill(self, session_id: str, force: bool = False) -> None:
        # Mirrors TerminalService.kill: the terminal closes immediately; the
        # child process dies unless the term is marked as surviving SIGKILL.
        self.killed.append(session_id)
        term = self.registry.get(session_id)
        if term is None:
            return
        term.closed = True
        if not getattr(term, "survives_kill", False):
            term.proc.alive = False


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
        self.prepared_sources: list[Path | None] = []

    def prepare(self, home_id: str, *, source_home: Path | None = None) -> Path:
        self.prepared.append(home_id)
        self.prepared_sources.append(source_home)
        return self.root / home_id

    def find_session_home(self, resume_id: str) -> Path | None:
        return None


class FakeVault:
    def __init__(self, fail: bool = False, root: Path | None = None) -> None:
        self.switch_calls: list[tuple[str, str, str]] = []
        self.login_harvests: list[tuple[str, str]] = []
        self.slot_secrets_deleted: list[tuple[str, str]] = []
        self.delete_slot_secrets_fail = False
        self.fail = fail
        self.root = root
        self._locks: dict[str, asyncio.Lock] = {}

    def switch_lock(self, agent_key: str) -> asyncio.Lock:
        lock = self._locks.get(agent_key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[agent_key] = lock
        return lock

    def switch(self, agent_key: str, from_slot_id: str, to_slot_id: str) -> None:
        self.switch_calls.append((agent_key, from_slot_id, to_slot_id))
        if self.fail:
            raise RuntimeError("swap boom")

    def login_home_path(self, agent_key: str, slot_id: str) -> Path:
        return (self.root or Path("/nonexistent")) / agent_key / slot_id / "login-home"

    def harvest_login_home(self, agent_key: str, slot_id: str) -> bool:
        # Mirrors CredentialVault: a home with a secret is captured + removed,
        # a secretless home (login still pending/abandoned) is a no-op.
        self.login_harvests.append((agent_key, slot_id))
        home = self.login_home_path(agent_key, slot_id)
        if not (home / "auth.json").exists():
            return False
        shutil.rmtree(home)
        return True

    def delete_slot_secrets(self, agent_key: str, slot_id: str) -> None:
        if self.delete_slot_secrets_fail:
            raise RuntimeError("cleanup boom")
        self.slot_secrets_deleted.append((agent_key, slot_id))

    def identity(self, agent_key: str, slot_id: str | None = None) -> dict[str, Any]:
        return {"email": None, "signedIn": False}


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def login_watch_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Record login-watch starts instead of spawning real (sleeping) tasks."""
    from agent_team_backend import usage_service

    started: list[tuple[str, str]] = []
    monkeypatch.setattr(
        usage_service,
        "start_login_watch",
        lambda agent_key, profile_id: started.append((agent_key, profile_id)),
    )
    return started


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
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FakeVault:
    v = FakeVault(root=tmp_path / "fake-vault")
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
    session: app.Session,
    terminal_id: str,
    agent_key: str,
    closed: bool = False,
    survives_kill: bool = False,
    login_profile_id: str | None = None,
) -> SimpleNamespace:
    term = SimpleNamespace(
        id=terminal_id,
        agent_key=agent_key,
        closed=closed,
        proc=FakeProc(),
        survives_kill=survives_kill,
        metadata={"login_profile_id": login_profile_id} if login_profile_id else {},
    )
    session.terminals.registry[terminal_id] = term  # type: ignore[attr-defined]
    app._PTY_OWNERS[terminal_id] = session
    return term


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


async def test_cli_profiles_list_includes_identities(
    store: CliProfilesStore, events: list[dict[str, Any]], tmp_path: Path
) -> None:
    """The list payload carries per-slot display identities; the ACTIVE slot's
    identity is read from the live credential state, inactive slots from their
    slot storage. (conftest roots the vault's real home at tmp_path.)"""
    import json

    home = tmp_path / "vault-home"
    home.mkdir(parents=True, exist_ok=True)
    (home / ".claude.json").write_text(
        json.dumps({"oauthAccount": {"emailAddress": "live@example.com"}}),
        encoding="utf-8",
    )
    # signedIn requires an actual live credential secret, not just the
    # display-only oauthAccount.
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / ".credentials.json").write_text('{"tok": 1}', encoding="utf-8")
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])
    session = _session()

    await app.handle_message(session, {
        "id": "l1", "type": "cli_profiles.list", "payload": {},
    })

    identities = session.websocket.sent[0]["payload"]["identities"]  # type: ignore[attr-defined]
    # The managed profile is active -> it owns the live login.
    assert identities["claude"][profile["id"]] == {
        "email": "live@example.com", "signedIn": True,
    }
    # The built-in Default's slot is empty -> not signed in.
    assert identities["claude"]["__default__"] == {"email": None, "signedIn": False}
    assert identities["kimi"] == {"__default__": {"email": None, "signedIn": False}}


async def test_cli_profiles_changed_broadcast_includes_identities(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "c1",
        "type": "cli_profiles.create",
        "payload": {"agent_key": "claude", "name": "Work"},
    })

    assert events[0]["type"] == "cli_profiles.changed"
    assert "identities" in events[0]["payload"]
    assert events[0]["payload"]["identities"]["claude"]["__default__"] == {
        "email": None, "signedIn": False,
    }


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


async def test_concurrent_switches_serialize_no_slot_clobber(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
) -> None:
    """Two windows switching the same agent at once must serialize: the second
    switch reads the first's persisted result, so the two never capture from the
    same slot (e.g. both from __default__) and clobber the original login.

    Without the per-agent switch lock both handlers read current_id=None at the
    to_thread yield point and both swap out of __default__ — this test fails."""
    a = store.create(agent_key="codex", name="A")
    b = store.create(agent_key="codex", name="B")

    async def _switch(pid: str) -> None:
        await app.handle_message(_session(), {
            "id": "c",
            "type": "cli_profiles.set_default",
            "payload": {"agent_key": "codex", "profile_id": pid},
        })

    await asyncio.gather(_switch(a["id"]), _switch(b["id"]))

    # Exactly two swaps forming a chain: the second swaps out what the first
    # swapped in — never both out of __default__.
    assert len(vault.switch_calls) == 2
    first, second = vault.switch_calls
    assert first[1] == "__default__"
    assert second[1] == first[2]
    assert {first[2], second[2]} == {a["id"], b["id"]}
    # The account that ran second is the persisted active one.
    assert store.list()["defaults"]["codex"] == second[2]


async def test_cli_profiles_delete_active_refused(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Deleting the agent's ACTIVE profile is refused (PROFILE_ACTIVE): its
    credentials are the live state, and deleting would orphan them. The store
    stays untouched."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])

    await app.handle_message(session, {
        "id": "x3",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "PROFILE_ACTIVE"
    assert store.list()["profiles"] == [profile]
    assert store.list()["defaults"]["claude"] == profile["id"]
    assert vault.slot_secrets_deleted == []
    assert events == []


async def test_cli_profiles_delete_cleans_slot_secrets(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Deleting a non-active profile removes its stranded slot secrets
    (claude's Keychain item etc.) through the vault before the store archives
    the slot dir."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")

    await app.handle_message(session, {
        "id": "x4",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert vault.slot_secrets_deleted == [("claude", profile["id"])]
    assert store.list()["profiles"] == []


async def test_cli_profiles_delete_survives_cleanup_failure(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """A failing secret cleanup must never block the delete itself."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    vault.delete_slot_secrets_fail = True

    await app.handle_message(session, {
        "id": "x5",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert store.list()["profiles"] == []


async def test_cli_profiles_delete_login_in_progress_refused(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """A profile whose isolated login pane CLI still runs cannot be deleted:
    removing the login home under a live CLI breaks it."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    _register_running_terminal(
        session, "t-login", "claude", login_profile_id=profile["id"]
    )

    await app.handle_message(session, {
        "id": "x6",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "LOGIN_IN_PROGRESS"
    assert store.list()["profiles"] == [profile]
    assert vault.slot_secrets_deleted == []
    assert events == []


async def test_cli_profiles_delete_removes_leftover_login_home(
    store: CliProfilesStore, events: list[dict[str, Any]], real_vault: CredentialVault
) -> None:
    """A leftover login home (abandoned sign-in, no running pane) goes with
    the deleted profile — removed before the store renames the slot dir."""
    session = _session()
    profile = store.create(agent_key="codex", name="Work")
    home = real_vault.login_home_path("codex", profile["id"])
    home.mkdir(parents=True)

    await app.handle_message(session, {
        "id": "x7",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert not home.exists()
    assert store.list()["profiles"] == []


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


async def test_set_default_does_not_kill_running_agent_panes(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Phase 2: switching the active account NEVER kills running panes. The
    panes are pinned to the isolated home they were spawned with, so the swap
    only decides which account new panes bind to; the switch just succeeds."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    t1 = _register_running_terminal(session, "t1", "claude")
    t2 = _register_running_terminal(session, "t2", "claude")

    await app.handle_message(session, {
        "id": "b1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    # No pane killed; both still alive.
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert t1.proc.poll() is None and t2.proc.poll() is None
    assert vault.switch_calls == [("claude", "__default__", profile["id"])]
    assert store.list()["defaults"]["claude"] == profile["id"]


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
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert vault.switch_calls == [("claude", "__default__", profile["id"])]


async def test_set_default_ignores_running_login_pane(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """An isolated LOGIN pane is credential-inert: it must not trip
    PROFILE_IN_USE and must never be killed by a switch."""
    session = _session()
    signing_in = store.create(agent_key="claude", name="New")
    target = store.create(agent_key="claude", name="Work")
    _register_running_terminal(
        session, "t-login", "claude", login_profile_id=signing_in["id"]
    )

    await app.handle_message(session, {
        "id": "lp1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": target["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert vault.switch_calls == [("claude", "__default__", target["id"])]


async def test_set_default_login_in_progress_refused(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Switching to a profile whose login pane CLI is still running must be
    refused (LOGIN_IN_PROGRESS) — restoring its still-empty slot would sign
    the live state out. No pane is ever killed."""
    session = _session()
    profile = store.create(agent_key="claude", name="New")
    vault.login_home_path("claude", profile["id"]).mkdir(parents=True)
    _register_running_terminal(
        session, "t-login", "claude", login_profile_id=profile["id"]
    )
    _register_running_terminal(session, "t-regular", "claude")

    await app.handle_message(session, {
        "id": "lp2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "LOGIN_IN_PROGRESS"
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert vault.switch_calls == []
    assert store.list()["defaults"]["claude"] is None


async def test_set_default_harvests_pending_login_before_restore(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """A completed-but-unharvested login (pane exited, poller not yet run)
    must land in the slot BEFORE the swap restores it — otherwise the switch
    restores an empty slot and clears the live credentials."""
    session = _session()
    profile = store.create(agent_key="claude", name="New")
    home = vault.login_home_path("claude", profile["id"])
    home.mkdir(parents=True)
    (home / "auth.json").write_text('{"who": "fresh"}', encoding="utf-8")

    harvested_before_swap: list[bool] = []
    orig_switch = vault.switch

    def switch_spy(*args: str) -> None:
        harvested_before_swap.append(not home.exists())
        orig_switch(*args)

    vault.switch = switch_spy  # type: ignore[method-assign]

    await app.handle_message(session, {
        "id": "lp3",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert vault.login_harvests == [("claude", profile["id"])]
    assert vault.switch_calls == [("claude", "__default__", profile["id"])]
    assert harvested_before_swap == [True]


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


async def test_terminal_create_claude_active_account_injects_isolated_home(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """A managed claude account's regular pane runs inside the profile's
    persistent isolated config home (CLAUDE_CONFIG_DIR), seeded from the slot,
    with inherited Anthropic API overrides dropped so they can't shadow the
    managed OAuth login."""
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
    home = real_vault.profile_home_path("claude", profile["id"])
    assert created["env"]["CLAUDE_CONFIG_DIR"] == str(home)
    assert created["env_remove"] == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    # The persistent home is created and distinct from the disposable login home.
    assert home.is_dir()
    assert home != real_vault.login_home_path("claude", profile["id"])


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


@pytest.mark.parametrize(
    "agent_key,env_var",
    [("kimi", "KIMI_CODE_HOME"), ("grok", "HOME")],
)
async def test_terminal_create_active_account_injects_isolated_home(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    agent_key: str,
    env_var: str,
) -> None:
    """A managed kimi/grok account's regular pane runs relocated: kimi via
    KIMI_CODE_HOME = the profile home, grok via a HOME shim that IS the profile
    home (its .grok holds the account's db)."""
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
    home = real_vault.profile_home_path(agent_key, profile["id"])
    assert created["env"][env_var] == str(home)
    assert created["env_remove"] is None
    assert home.is_dir()


async def test_terminal_create_codex_active_account_sources_profile_home(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The per-pane CODEX_HOME mechanism stays, but with a managed account
    active its symlink source switches from the real ~/.codex to the profile's
    persistent isolated home (which holds the account's own auth.json)."""
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
    assert fake_home.prepared_sources == [
        real_vault.profile_home_path("codex", profile["id"])
    ]
    assert created["env"]["CODEX_HOME"] == str(tmp_path / "codex-panes" / "stable-home")
    assert created["env_remove"] is None


# ---- terminal.create: per-pane profile pin (phase 2) ----


async def test_terminal_create_pinned_profile_survives_account_switch(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """A pane pinned to profile A (its recorded metadata profile_id) resumes
    into A's isolated credential home even though the active default is now B —
    the pin, not the current active account, decides the home. Sessions are
    shared, so this keeps a resumed pane authenticated as the same account it
    was created on (credential-account continuity), not a resume-correctness
    gate: a switch must never migrate a pane's credential home."""
    profile_a = store.create(agent_key="claude", name="A")
    profile_b = store.create(agent_key="claude", name="B")
    store.set_default("claude", profile_b["id"])  # active account is now B
    session = _session()

    await app.handle_message(session, {
        "id": "pin1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "profile_id": profile_a["id"]},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CLAUDE_CONFIG_DIR"] == str(
        real_vault.profile_home_path("claude", profile_a["id"])
    )
    # NOT B's home.
    assert created["env"]["CLAUDE_CONFIG_DIR"] != str(
        real_vault.profile_home_path("claude", profile_b["id"])
    )


async def test_terminal_create_pinned_default_stays_on_real_home(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """A pane pinned to the unmanaged Default ("__default__") runs on the real
    home even while a managed account is active — a pane spawned before the
    account was created must not be dragged into a managed home on resume."""
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])  # active managed account
    session = _session()

    await app.handle_message(session, {
        "id": "pin2",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "profile_id": "__default__"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"] is None
    assert created["env_remove"] is None


async def test_terminal_create_fresh_spawn_after_switch_uses_new_account(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """A fresh (unpinned) spawn binds to the CURRENT active default — after a
    switch, new panes use the newly active account's home."""
    profile_a = store.create(agent_key="claude", name="A")
    profile_b = store.create(agent_key="claude", name="B")
    store.set_default("claude", profile_a["id"])
    store.set_default("claude", profile_b["id"])  # switched active to B
    session = _session()

    await app.handle_message(session, {
        "id": "fresh1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},  # no pin → active default
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CLAUDE_CONFIG_DIR"] == str(
        real_vault.profile_home_path("claude", profile_b["id"])
    )


def test_profile_pin_for_spawn_resolves_active_default(
    store: CliProfilesStore,
) -> None:
    """The persisted pin: an explicit value (restore) is kept verbatim; a fresh
    spawn resolves the active default (managed id, or "__default__" for the
    unmanaged Default); non-account agents are never pinned."""
    profile = store.create(agent_key="claude", name="Work")

    # Fresh spawn, no active managed account → Default sentinel.
    assert ws_handlers._profile_pin_for_spawn("claude", None) == "__default__"
    # Fresh spawn with a managed account active → its id.
    store.set_default("claude", profile["id"])
    assert ws_handlers._profile_pin_for_spawn("claude", None) == profile["id"]
    # Restore carries the recorded pin verbatim.
    assert ws_handlers._profile_pin_for_spawn("claude", "some-pin") == "some-pin"
    # Non-account agents are never pinned.
    assert ws_handlers._profile_pin_for_spawn("terminal", None) == ""


# ---- terminal.create: isolated LOGIN panes (login_profile_id) ----


@pytest.fixture()
def real_vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CredentialVault:
    v = CredentialVault(
        root=tmp_path / "cli-profiles",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="linux",
    )
    (tmp_path / "home").mkdir(exist_ok=True)
    monkeypatch.setattr(app, "credential_vault", v)
    return v


async def _create_login_pane(agent_key: str, profile_id: str) -> app.Session:
    session = _session()
    await app.handle_message(session, {
        "id": "login-1",
        "type": "terminal.create",
        "payload": {
            "pane_id": f"{agent_key}-login-pane",
            "agent_key": agent_key,
            "command": agent_key,
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
            "login_profile_id": profile_id,
        },
    })
    return session


async def test_terminal_create_login_profile_isolates_claude(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """A login pane runs claude inside the profile's login home (fresh state →
    the CLI prompts its own sign-in) with API overrides dropped; the live
    credentials and every other pane stay on the active account."""
    profile = store.create(agent_key="claude", name="Second")

    session = await _create_login_pane("claude", profile["id"])

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    login_home = real_vault.login_home_path("claude", profile["id"])
    assert created["env"]["CLAUDE_CONFIG_DIR"] == str(login_home)
    # The pane is marked as a LOGIN pane so switch guards and the harvest
    # gate can tell it apart from regular panes.
    assert created["metadata"]["login_profile_id"] == profile["id"]
    assert created["env_remove"] == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    assert login_home.is_dir()
    # The active account is untouched.
    assert store.list()["defaults"]["claude"] is None


async def test_terminal_create_login_profile_codex_skips_pane_home(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A codex login pane gets the login home as CODEX_HOME directly — the
    per-pane home would symlink auth.json back to the real ~/.codex and leak
    the login into the live credentials."""
    profile = store.create(agent_key="codex", name="Second")
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "codex_home_manager", fake_home)

    session = await _create_login_pane("codex", profile["id"])

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CODEX_HOME"] == str(
        real_vault.login_home_path("codex", profile["id"])
    )
    assert fake_home.prepared == []


@pytest.mark.parametrize("agent_key,env_var,home_suffix", [
    ("kimi", "KIMI_CODE_HOME", ""),
    ("grok", "HOME", "home"),
])
async def test_terminal_create_login_profile_kimi_grok(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    agent_key: str,
    env_var: str,
    home_suffix: str,
) -> None:
    profile = store.create(agent_key=agent_key, name="Second")

    session = await _create_login_pane(agent_key, profile["id"])

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    expected = real_vault.login_home_path(agent_key, profile["id"])
    if home_suffix:
        expected = expected / home_suffix
    assert created["env"][env_var] == str(expected)


@pytest.mark.parametrize("agent_key,expected", [
    ("claude", "claude auth login"),
    ("codex", "codex login"),
    ("kimi", "kimi login"),
    ("grok", "grok"),  # no login subcommand; first run starts its auth flow
])
async def test_terminal_create_login_pane_runs_direct_login_command(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    agent_key: str,
    expected: str,
) -> None:
    """A login pane never waits for the user to type anything: the backend
    rewrites the spawn command to the CLI's direct sign-in trigger, dropping
    YOLO flags and keeping the shell wrapper."""
    profile = store.create(agent_key=agent_key, name="Second")
    session = _session()

    await app.handle_message(session, {
        "id": "login-cmd",
        "type": "terminal.create",
        "payload": {
            "pane_id": f"{agent_key}-login-pane",
            "agent_key": agent_key,
            "command": ["/bin/zsh", "-ilc", f"{agent_key} --dangerously-skip-permissions"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
            "login_profile_id": profile["id"],
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["command"] == ["/bin/zsh", "-ilc", expected]


def test_login_spawn_command_variants() -> None:
    # Plain string commands and quoted binary overrides survive the rewrite;
    # non-account agents pass through untouched.
    assert app._login_spawn_command("claude", "claude --flag") == "claude auth login"
    assert app._login_spawn_command(
        "codex", ["/bin/zsh", "-ilc", "'/opt/my codex/codex' --flag"]
    ) == ["/bin/zsh", "-ilc", "'/opt/my codex/codex' login"]
    assert app._login_spawn_command("terminal", "bash") == "bash"


async def test_terminal_create_login_pane_starts_login_watch(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    login_watch_calls: list[tuple[str, str]],
) -> None:
    """A successful login spawn starts the fast harvest watch; a regular pane
    does not."""
    profile = store.create(agent_key="claude", name="Second")

    await _create_login_pane("claude", profile["id"])
    assert login_watch_calls == [("claude", profile["id"])]

    session = _session()
    await app.handle_message(session, {
        "id": "plain-1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "plain-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })
    assert login_watch_calls == [("claude", profile["id"])]


async def test_terminal_create_unknown_login_profile_rejected(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    session = await _create_login_pane("claude", "nope")

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"
    assert session.terminals.created == []  # type: ignore[attr-defined]


async def test_terminal_create_login_profile_wrong_agent_rejected(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    profile = store.create(agent_key="claude", name="Second")

    session = await _create_login_pane("codex", profile["id"])

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"
    assert session.terminals.created == []  # type: ignore[attr-defined]


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
