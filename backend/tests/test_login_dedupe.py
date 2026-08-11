"""Signing in must not leave two profiles holding the same account.

``cli_profiles.create`` only enforces a unique id, so pressing "+ New account"
and signing into an account that already has a profile used to register a
second slot for the same login. The harvest now folds such a login back into
the profile that already holds the account — but only when the login landed in
a profile created for it, and only when the account can actually be named.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, usage_service, ws_handlers
from agent_team_backend.credential_vault import LiveCredentials
from agent_team_backend.profiles_store import CliProfilesStore
from agent_team_backend.usage_service import (
    _harvest_login_home_locked,
    sweep_pending_login_homes,
)


def _codex_auth(email: str, token: str = "tok") -> str:
    """A codex auth.json whose id_token JWT payload carries ``email`` — the
    shape ``cli_vendors.codex.identity_from_secret`` reads."""
    payload = base64.urlsafe_b64encode(
        json.dumps({"email": email}).encode()
    ).decode().rstrip("=")
    return json.dumps({"tokens": {"access_token": token, "id_token": f"h.{payload}.s"}})


@pytest.fixture()
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CliProfilesStore:
    # Same root as the conftest vault: in production both point at
    # ~/.navide/cli-profiles, and the delete path archives the slot dir.
    s = CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "vault-root",
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


def _write_login_home(agent_key: str, profile_id: str, rel: str, secret: str) -> Path:
    home = app.credential_vault.login_home_path(agent_key, profile_id)
    target = home / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(secret, encoding="utf-8")
    return home


def _profile_ids(store: CliProfilesStore) -> list[str]:
    return [p["id"] for p in store.list()["profiles"]]


async def test_login_into_a_new_profile_folds_into_the_existing_account(
    store: CliProfilesStore,
) -> None:
    """The duplicate slot is removed, the fresh login lands in the profile that
    already held the account, and the active pointer follows it."""
    kept = store.create(agent_key="codex", name="Account 1")
    app.credential_vault.write_slot(
        "codex", kept["id"], LiveCredentials(secret=_codex_auth("a@example.com", "old"))
    )
    fresh = store.create(agent_key="codex", name="Account 2")
    store.set_default("codex", fresh["id"])
    # Casing differs on purpose: account identity is compared case-insensitively.
    new_secret = _codex_auth("A@Example.com", "new")
    home = _write_login_home("codex", fresh["id"], "auth.json", new_secret)

    assert await _harvest_login_home_locked(
        app.credential_vault, "codex", fresh["id"]
    ) is True

    assert _profile_ids(store) == [kept["id"]]
    assert store.list()["defaults"]["codex"] == kept["id"]
    assert app.credential_vault.read_slot("codex", kept["id"]).secret == new_secret
    # The surviving profile is the active account, so the fresh login is live.
    assert app.credential_vault.read_live("codex").secret == new_secret
    assert not home.exists()


async def test_login_into_a_profile_that_already_had_credentials_is_kept(
    store: CliProfilesStore,
) -> None:
    """Re-signing a slot the user set up themselves is never de-duplicated,
    even when another profile holds the same account."""
    other = store.create(agent_key="codex", name="Account 1")
    app.credential_vault.write_slot(
        "codex", other["id"], LiveCredentials(secret=_codex_auth("a@example.com", "old"))
    )
    target = store.create(agent_key="codex", name="Account 2")
    app.credential_vault.write_slot(
        "codex", target["id"], LiveCredentials(secret=_codex_auth("a@example.com", "prev"))
    )
    new_secret = _codex_auth("a@example.com", "new")
    _write_login_home("codex", target["id"], "auth.json", new_secret)

    assert await _harvest_login_home_locked(
        app.credential_vault, "codex", target["id"]
    ) is True

    assert _profile_ids(store) == [other["id"], target["id"]]
    assert app.credential_vault.read_slot("codex", target["id"]).secret == new_secret
    assert app.credential_vault.read_slot("codex", other["id"]).secret == _codex_auth(
        "a@example.com", "old"
    )


async def test_unidentifiable_account_is_never_folded(store: CliProfilesStore) -> None:
    """kimi exposes no identity field, so two kimi logins can never be proven
    to be the same account."""
    other = store.create(agent_key="kimi", name="Account 1")
    app.credential_vault.write_slot(
        "kimi", other["id"], LiveCredentials(secret='{"access_token": "old"}')
    )
    fresh = store.create(agent_key="kimi", name="Account 2")
    _write_login_home(
        "kimi", fresh["id"], "credentials/kimi-code.json", '{"access_token": "new"}'
    )

    assert await _harvest_login_home_locked(
        app.credential_vault, "kimi", fresh["id"]
    ) is True

    assert _profile_ids(store) == [other["id"], fresh["id"]]
    assert app.credential_vault.read_slot("kimi", fresh["id"]).secret == (
        '{"access_token": "new"}'
    )


async def test_a_different_account_is_left_alone(store: CliProfilesStore) -> None:
    other = store.create(agent_key="codex", name="Account 1")
    app.credential_vault.write_slot(
        "codex", other["id"], LiveCredentials(secret=_codex_auth("b@example.com"))
    )
    fresh = store.create(agent_key="codex", name="Account 2")
    store.set_default("codex", fresh["id"])
    new_secret = _codex_auth("a@example.com")
    _write_login_home("codex", fresh["id"], "auth.json", new_secret)

    assert await _harvest_login_home_locked(
        app.credential_vault, "codex", fresh["id"]
    ) is True

    assert _profile_ids(store) == [other["id"], fresh["id"]]
    assert store.list()["defaults"]["codex"] == fresh["id"]
    assert app.credential_vault.read_slot("codex", fresh["id"]).secret == new_secret


async def test_folding_is_not_an_account_switch(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The user did not switch accounts: the switch rate limit stays untouched
    and the broadcast is not forced (a forced one restarts every pane of the
    agent, and no credential was pulled out from under one)."""
    def refuse(_agent_key: str) -> None:
        raise AssertionError("de-duplicating a login must not count as a switch")

    monkeypatch.setattr(ws_handlers, "_record_switch", refuse)

    kept = store.create(agent_key="codex", name="Account 1")
    app.credential_vault.write_slot(
        "codex", kept["id"], LiveCredentials(secret=_codex_auth("a@example.com", "old"))
    )
    fresh = store.create(agent_key="codex", name="Account 2")
    store.set_default("codex", fresh["id"])
    _write_login_home(
        "codex", fresh["id"], "auth.json", _codex_auth("a@example.com", "new")
    )

    await sweep_pending_login_homes()

    assert _profile_ids(store) == [kept["id"]]
    assert ws_handlers._switch_history.get("codex", []) == []
    payloads = [
        e["payload"] for e in events if e.get("type") == "cli_profiles.changed"
    ]
    assert payloads, "the UI was never told the profile list changed"
    assert all(not p.get("forced") for p in payloads)
    assert payloads[-1]["defaults"]["codex"] == kept["id"]
    assert [p["id"] for p in payloads[-1]["profiles"]] == [kept["id"]]


async def test_dedupe_failure_leaves_the_login_usable(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A merge that blows up half-way must not lose the harvested login."""
    kept = store.create(agent_key="codex", name="Account 1")
    app.credential_vault.write_slot(
        "codex", kept["id"], LiveCredentials(secret=_codex_auth("a@example.com", "old"))
    )
    fresh = store.create(agent_key="codex", name="Account 2")
    new_secret = _codex_auth("a@example.com", "new")
    _write_login_home("codex", fresh["id"], "auth.json", new_secret)

    def boom(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("keychain unavailable")

    monkeypatch.setattr(app.credential_vault, "delete_slot_secrets", boom)

    assert await _harvest_login_home_locked(
        app.credential_vault, "codex", fresh["id"]
    ) is True

    assert fresh["id"] in _profile_ids(store)
    assert app.credential_vault.read_slot("codex", fresh["id"]).secret == new_secret
