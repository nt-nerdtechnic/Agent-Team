"""CredentialWatcher: notice a CLI sign-in that happened outside Navide and
re-point the active-account ledger at it.

Two halves are exercised. The watcher half is the de-noising gate: credential
files sit in directories that churn (``~/.claude.json`` is Claude Code's whole
config), so a file event must only lead somewhere when the account identity
actually changed. The reconcile half moves ``defaults[agentKey]`` — and nothing
else: no credential is captured, restored, swapped or cleared, and the account
switch rate limit is not consumed, because nothing was switched.
"""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.credential_watcher import (
    CredentialWatcher,
    reconcile_live_account,
    unregistered_live_accounts,
)
from agent_team_backend.profiles_store import CliProfilesStore


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def _codex_auth(email: str) -> str:
    """A codex auth.json whose id_token JWT payload carries ``email`` — the
    shape ``cli_vendors.codex.identity_from_secret`` reads."""
    payload = base64.urlsafe_b64encode(
        json.dumps({"email": email}).encode()
    ).decode().rstrip("=")
    return json.dumps({"tokens": {"access_token": "tok", "id_token": f"h.{payload}.s"}})


@pytest.fixture()
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CliProfilesStore:
    s = CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "cli-profiles",
    )
    monkeypatch.setattr(app, "cli_profiles_store", s)
    return s


@pytest.fixture()
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def record(event: dict[str, Any], *, exclude: Any = None) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", record)
    return sent


@pytest.fixture()
def codex_live(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Write codex's live auth.json in the vault's (tmp) real home."""
    # File mode: the conftest security runner always reports 'not found', so
    # the claude Keychain path stays inert for the other agents' reads too.
    monkeypatch.setattr(app.credential_vault, "_platform", "linux")
    live_dir = tmp_path / "vault-home" / ".codex"
    live_dir.mkdir(parents=True, exist_ok=True)

    def write(email: str) -> None:
        (live_dir / "auth.json").write_text(_codex_auth(email), encoding="utf-8")

    return write


def _write_slot(agent_key: str, slot_id: str, secret: str) -> None:
    slot = app.credential_vault.slot_dir(agent_key, slot_id)
    slot.mkdir(parents=True, exist_ok=True)
    (slot / "auth.json").write_text(secret, encoding="utf-8")


def _forbid_credential_writes(
    monkeypatch: pytest.MonkeyPatch, allow: tuple[str, ...] = ()
) -> None:
    """Reconciliation corrects bookkeeping only — the live credentials already
    belong to the account it aligns to. Any vault call that MOVES a credential
    is a bug, so make them all fail loudly. ``allow`` exempts the slot-only
    calls a test expects (registering an unknown account harvests into its new
    slot, which never writes the live state)."""
    def refuse(name: str):
        def _call(*_args: Any, **_kwargs: Any) -> None:
            raise AssertionError(f"reconcile must not call credential_vault.{name}")
        return _call

    for name in (
        "switch", "capture", "restore", "clear_live", "write_live", "write_slot",
        "harvest", "harvest_login_home", "delete_slot_secrets",
    ):
        if name not in allow:
            monkeypatch.setattr(app.credential_vault, name, refuse(name))


# ---- watcher: de-noising ---------------------------------------------------


async def test_identical_fingerprint_is_not_reported(tmp_path: Path) -> None:
    """A credential file rewritten without an account change (token refresh,
    config churn) must not reach the sink; a genuine change must."""
    home = tmp_path / "home"
    (home / ".codex").mkdir(parents=True)
    live = home / ".codex" / "auth.json"
    live.write_text("{}", encoding="utf-8")

    fired: list[str] = []

    async def sink(agent_key: str) -> None:
        fired.append(agent_key)

    identity = {"codex": ("a@example.com", True)}
    watcher = CredentialWatcher(
        sink,
        real_home=home,
        agent_keys=("codex",),
        fingerprint=lambda key: identity[key],
        debounce_s=0.1,
    )
    watcher.start()
    try:
        await asyncio.sleep(0.2)  # let the startup seeding land
        live.write_text('{"tokens": {"access_token": "refreshed"}}', encoding="utf-8")
        await asyncio.sleep(0.4)
        assert fired == []

        identity["codex"] = ("b@example.com", True)
        live.write_text('{"tokens": {"access_token": "other-account"}}', encoding="utf-8")
        await asyncio.sleep(0.4)
        assert fired == ["codex"]
    finally:
        watcher.stop()


async def test_unrelated_file_in_a_watched_dir_is_ignored(tmp_path: Path) -> None:
    """Only the credential file names matter — the directories around them
    (the home dir, ~/.claude) are written by everything."""
    home = tmp_path / "home"
    (home / ".codex").mkdir(parents=True)

    fired: list[str] = []

    async def sink(agent_key: str) -> None:
        fired.append(agent_key)

    watcher = CredentialWatcher(
        sink,
        real_home=home,
        agent_keys=("codex",),
        fingerprint=lambda key: ("changed-every-time", object()),
        debounce_s=0.1,
    )
    watcher.start()
    try:
        await asyncio.sleep(0.2)
        (home / ".codex" / "history.jsonl").write_text("x", encoding="utf-8")
        (home / "unrelated.txt").write_text("x", encoding="utf-8")
        await asyncio.sleep(0.4)
        assert fired == []
    finally:
        watcher.stop()


async def test_missing_credential_dirs_do_not_break_start(tmp_path: Path) -> None:
    """A CLI that was never installed has no directory to watch; startup must
    survive that (all four agents are watched, most users have one or two)."""
    home = tmp_path / "empty-home"
    home.mkdir()

    async def sink(_agent_key: str) -> None:  # pragma: no cover - never called
        raise AssertionError("nothing should fire")

    watcher = CredentialWatcher(sink, real_home=home, debounce_s=0.1)
    watcher.start()
    await asyncio.sleep(0.1)
    watcher.stop()


# ---- reconcile -------------------------------------------------------------


async def test_reconcile_moves_default_to_the_matching_slot(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    codex_live,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    work = store.create(agent_key="codex", name="Work")
    personal = store.create(agent_key="codex", name="Personal")
    store.set_default("codex", work["id"])
    _write_slot("codex", work["id"], _codex_auth("work@example.com"))
    _write_slot("codex", personal["id"], _codex_auth("personal@example.com"))
    # The user ran `codex login` in a plain terminal and picked the other one.
    codex_live("personal@example.com")
    _forbid_credential_writes(monkeypatch)

    await reconcile_live_account("codex")

    assert store.list()["defaults"]["codex"] == personal["id"]
    # Not a switch: the manual-switch budget must stay untouched, or a few
    # external logins would start refusing the user's own switches.
    assert ws_handlers._switch_history.get("codex", []) == []
    changed = [e for e in events if e["type"] == "cli_profiles.changed"]
    assert len(changed) == 1
    payload = changed[0]["payload"]
    assert payload["reason"] == "live_credentials"
    assert payload["agent_key"] == "codex"
    # forced=True makes every window restart its panes of this agent — wrong
    # here, since no credential moved under them.
    assert payload["forced"] is False
    assert payload["unregistered"] == {}


async def test_reconcile_registers_an_unknown_account(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    codex_live,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An account no slot holds gets a profile of its own, holding a snapshot
    of the live credentials, and becomes the active one."""
    work = store.create(agent_key="codex", name="Work")
    store.set_default("codex", work["id"])
    _write_slot("codex", work["id"], _codex_auth("work@example.com"))
    codex_live("stranger@example.com")
    # Everything that would MOVE the live credentials is still forbidden — only
    # the slot-only pair the snapshot needs may run.
    _forbid_credential_writes(monkeypatch, allow=("harvest", "write_slot"))

    await reconcile_live_account("codex")

    new_id = store.list()["defaults"]["codex"]
    assert new_id not in (None, work["id"])
    assert app.credential_vault.read_slot("codex", new_id).secret == _codex_auth(
        "stranger@example.com"
    )
    # Now that it is registered, it is no longer an unregistered login.
    assert unregistered_live_accounts() == {}
    assert ws_handlers._switch_history.get("codex", []) == []
    payload = [e for e in events if e["type"] == "cli_profiles.changed"][0]["payload"]
    assert payload["forced"] is False
    assert payload["unregistered"] == {}
    assert [p["id"] for p in payload["profiles"]] == [work["id"], new_id]


async def test_registration_failure_leaves_no_credential_less_profile(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    codex_live,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A profile whose slot stayed empty would log the user out the moment it
    is restored, so a failed snapshot takes the profile back down and the
    account falls back to being reported as an unregistered live login."""
    work = store.create(agent_key="codex", name="Work")
    store.set_default("codex", work["id"])
    _write_slot("codex", work["id"], _codex_auth("work@example.com"))
    codex_live("stranger@example.com")
    _forbid_credential_writes(monkeypatch)  # harvest raises

    await reconcile_live_account("codex")

    assert [p["id"] for p in store.list()["profiles"]] == [work["id"]]
    assert store.list()["defaults"]["codex"] == work["id"]
    assert unregistered_live_accounts() == {
        "codex": {"email": "stranger@example.com", "signedIn": True}
    }
    payload = [e for e in events if e["type"] == "cli_profiles.changed"][0]["payload"]
    assert payload["unregistered"] == {
        "codex": {"email": "stranger@example.com", "signedIn": True}
    }


async def test_an_unidentifiable_live_login_registers_nothing(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """kimi carries no identity field, so its live login can never be told
    apart from any other — there is nothing to name a profile after."""
    monkeypatch.setattr(app.credential_vault, "_platform", "linux")
    live = tmp_path / "vault-home" / ".kimi-code" / "credentials"
    live.mkdir(parents=True)
    (live / "kimi-code.json").write_text('{"access_token": "tok"}', encoding="utf-8")
    parked = store.create(agent_key="kimi", name="Parked")
    store.set_default("kimi", parked["id"])
    _forbid_credential_writes(monkeypatch)

    await reconcile_live_account("kimi")

    assert [p["id"] for p in store.list()["profiles"]] == [parked["id"]]
    assert store.list()["defaults"]["kimi"] == parked["id"]


async def test_unregistered_is_empty_for_an_unmanaged_login(
    store: CliProfilesStore, codex_live
) -> None:
    """The common install: no profiles at all, so the live login IS the
    built-in Default account even though that slot holds no snapshot."""
    codex_live("solo@example.com")

    assert unregistered_live_accounts() == {}


async def test_cli_profiles_list_carries_unregistered(
    store: CliProfilesStore, events: list[dict[str, Any]], codex_live
) -> None:
    work = store.create(agent_key="codex", name="Work")
    store.set_default("codex", work["id"])
    _write_slot("codex", work["id"], _codex_auth("work@example.com"))
    codex_live("stranger@example.com")
    session = _session()

    await app.handle_message(session, {
        "id": "l1", "type": "cli_profiles.list", "payload": {},
    })

    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["unregistered"] == {
        "codex": {"email": "stranger@example.com", "signedIn": True}
    }
