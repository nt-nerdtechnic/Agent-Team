"""CredentialVault: slot capture/restore, atomic switching, harvest.

The file backend runs against tmp paths only; the macOS Keychain backend runs
against an injected fake `security` runner — the real Keychain and the real
home are NEVER touched."""

from __future__ import annotations

import json
import os
import shlex
import stat
from pathlib import Path

import pytest

from agent_team_backend.credential_vault import (
    CLAUDE_LIVE_KEYCHAIN_SERVICE,
    DEFAULT_SLOT_ID,
    CredentialVault,
    CredentialVaultError,
    LiveCredentials,
    legacy_claude_keychain_service,
)


class FakeSecurity:
    """In-memory generic-password store mimicking the `security` CLI."""

    def __init__(self) -> None:
        self.items: dict[str, str] = {}
        self.calls: list[list[str]] = []
        self.stdin_commands: list[str] = []

    def __call__(self, args: list[str], input_text: str | None = None) -> tuple[int, str]:
        self.calls.append(list(args))
        if args == ["-i"]:
            # Interactive mode: the whole command arrives on stdin.
            self.stdin_commands.append(input_text or "")
            tokens = shlex.split((input_text or "").strip())
        else:
            tokens = list(args)
        service = tokens[tokens.index("-s") + 1]
        cmd = tokens[0]
        if cmd == "find-generic-password":
            if service in self.items:
                return 0, self.items[service] + "\n"
            return 44, ""
        if cmd == "add-generic-password":
            self.items[service] = tokens[tokens.index("-w") + 1]
            return 0, ""
        if cmd == "delete-generic-password":
            return (0, "") if self.items.pop(service, None) is not None else (44, "")
        return 1, ""


def _file_vault(tmp_path: Path) -> CredentialVault:
    return CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="linux",
    )


def _mac_vault(tmp_path: Path) -> tuple[CredentialVault, FakeSecurity]:
    sec = FakeSecurity()
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=sec,
        platform="darwin",
    )
    return vault, sec


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# ── file backend ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("agent_key,live_rel", [
    ("codex", ".codex/auth.json"),
    ("kimi", ".kimi-code/credentials/kimi-code.json"),
    ("grok", ".grok/auth.json"),
    ("claude", ".claude/.credentials.json"),
])
def test_capture_and_restore_round_trip(tmp_path: Path, agent_key: str, live_rel: str) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / live_rel
    _write(live, '{"who": "acct-a"}')

    assert vault.slot_is_empty(agent_key, "slot1")
    vault.capture(agent_key, "slot1")
    assert not vault.slot_is_empty(agent_key, "slot1")

    vault.clear_live(agent_key)
    assert not live.exists()

    vault.restore(agent_key, "slot1")
    assert live.read_text(encoding="utf-8") == '{"who": "acct-a"}'


def test_slot_files_are_private(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", "{}")
    vault.capture("codex", "slot1")
    slot_file = vault.slot_dir("codex", "slot1") / "auth.json"
    assert stat.S_IMODE(os.stat(slot_file).st_mode) == 0o600


def test_capture_logged_out_live_empties_slot(tmp_path: Path) -> None:
    """Capture mirrors reality: no live credentials -> the slot goes empty."""
    vault = _file_vault(tmp_path)
    vault.write_slot("grok", "slot1", LiveCredentials(secret="stale"))

    vault.capture("grok", "slot1")

    assert vault.slot_is_empty("grok", "slot1")


def test_restore_from_empty_slot_clears_live(tmp_path: Path) -> None:
    """A never-used account slot clears the live credentials so the CLI
    prompts a fresh login on the next pane."""
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".codex" / "auth.json"
    _write(live, '{"who": "old"}')

    vault.restore("codex", "fresh-slot")

    assert not live.exists()


def test_switch_moves_live_between_slots(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".kimi-code" / "credentials" / "kimi-code.json"
    _write(live, '{"who": "A"}')
    vault.write_slot("kimi", "slot-b", LiveCredentials(secret='{"who": "B"}'))

    vault.switch("kimi", DEFAULT_SLOT_ID, "slot-b")

    assert vault.read_slot("kimi", DEFAULT_SLOT_ID).secret == '{"who": "A"}'
    assert live.read_text(encoding="utf-8") == '{"who": "B"}'

    # And back: B -> default restores the original login.
    vault.switch("kimi", "slot-b", DEFAULT_SLOT_ID)
    assert vault.read_slot("kimi", "slot-b").secret == '{"who": "B"}'
    assert live.read_text(encoding="utf-8") == '{"who": "A"}'


def test_switch_to_empty_slot_clears_live(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".grok" / "auth.json"
    _write(live, '{"who": "A"}')

    vault.switch("grok", DEFAULT_SLOT_ID, "new-account")

    assert vault.read_slot("grok", DEFAULT_SLOT_ID).secret == '{"who": "A"}'
    assert not live.exists()


def test_switch_restore_failure_rolls_back_live(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".codex" / "auth.json"
    _write(live, '{"who": "A"}')

    def boom(agent_key: str, slot_id: str) -> None:
        raise RuntimeError("disk full")

    monkeypatch.setattr(vault, "restore", boom)
    with pytest.raises(CredentialVaultError):
        vault.switch("codex", DEFAULT_SLOT_ID, "slot-b")

    # The capture into the outgoing slot happened, and live is unchanged.
    assert vault.read_slot("codex", DEFAULT_SLOT_ID).secret == '{"who": "A"}'
    assert live.read_text(encoding="utf-8") == '{"who": "A"}'


def test_harvest_fills_only_empty_slot(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".codex" / "auth.json"

    assert vault.harvest("codex", "slot1") is False  # nothing live yet

    _write(live, '{"who": "A"}')
    assert vault.harvest("codex", "slot1") is True
    assert vault.read_slot("codex", "slot1").secret == '{"who": "A"}'

    _write(live, '{"who": "B"}')
    assert vault.harvest("codex", "slot1") is False  # occupied slot untouched
    assert vault.read_slot("codex", "slot1").secret == '{"who": "A"}'


def test_claude_oauth_account_round_trip(tmp_path: Path) -> None:
    """`~/.claude.json` oauthAccount travels with the credentials; other keys
    in the file survive both clear and restore."""
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".claude" / ".credentials.json", '{"claudeAiOauth": {}}')
    _write(
        tmp_path / "home" / ".claude.json",
        json.dumps({"oauthAccount": {"emailAddress": "a@x.com"}, "theme": "dark"}),
    )

    vault.capture("claude", "slot1")
    assert vault.slot_account("claude", "slot1") == {"emailAddress": "a@x.com"}

    vault.clear_live("claude")
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    assert "oauthAccount" not in config
    assert config["theme"] == "dark"

    vault.restore("claude", "slot1")
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    assert config["oauthAccount"] == {"emailAddress": "a@x.com"}
    assert config["theme"] == "dark"


# ── atomic writes ───────────────────────────────────────────────────────────


def test_claude_config_write_failure_preserves_original(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`~/.claude.json` is the user's whole Claude config: a failed publish
    (os.replace raising, e.g. disk full) must leave the original intact and
    no tmp file behind — content goes to a tmp file first, never in place."""
    vault = _file_vault(tmp_path)
    config = tmp_path / "home" / ".claude.json"
    original = json.dumps({"oauthAccount": {"emailAddress": "a@x.com"}, "theme": "dark"})
    _write(config, original)

    def boom(src: object, dst: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(CredentialVaultError):
        vault.write_live(
            "claude", LiveCredentials(secret=None, account={"emailAddress": "b@x.com"})
        )

    assert config.read_text(encoding="utf-8") == original
    assert not config.with_name(config.name + ".tmp").exists()


def test_atomic_writes_leave_no_tmp_and_keep_slot_private(tmp_path: Path) -> None:
    """Normal writes publish atomically: no `.tmp` remnants anywhere, and slot
    secret files still end up 0600."""
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", '{"who": "A"}')
    _write(tmp_path / "home" / ".claude.json", '{"theme": "dark"}')

    vault.capture("codex", "slot1")
    vault.write_live(
        "claude",
        LiveCredentials(secret='{"claudeAiOauth": {}}', account={"emailAddress": "a@x.com"}),
    )

    slot_file = vault.slot_dir("codex", "slot1") / "auth.json"
    assert stat.S_IMODE(os.stat(slot_file).st_mode) == 0o600
    assert list((tmp_path / "home").rglob("*.tmp")) == []
    assert list((tmp_path / "root").rglob("*.tmp")) == []


# ── macOS Keychain backend (fake `security` runner) ─────────────────────────


def test_mac_switch_moves_secret_between_keychain_services(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items["Claude Code-credentials"] = '{"claudeAiOauth": {"accessToken": "A"}}'

    vault.switch("claude", DEFAULT_SLOT_ID, "acct1")

    # Old login parked in the backend-owned slot item; live item gone (acct1
    # slot was empty -> logged-out live state).
    assert sec.items["Navide CLI account claude-__default__"] == \
        '{"claudeAiOauth": {"accessToken": "A"}}'
    assert "Claude Code-credentials" not in sec.items

    # Switching back restores the live item from the slot.
    vault.switch("claude", "acct1", DEFAULT_SLOT_ID)
    assert sec.items["Claude Code-credentials"] == \
        '{"claudeAiOauth": {"accessToken": "A"}}'


def test_mac_keychain_write_command_assembly(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    vault.write_slot("claude", "acct1", LiveCredentials(secret="SECRET"))

    # Writes go through `security -i` with the command on stdin: the secret
    # must never appear in the argv, where the process table leaks it.
    assert all("SECRET" not in " ".join(call) for call in sec.calls)
    assert len(sec.stdin_commands) == 1
    tokens = shlex.split(sec.stdin_commands[0].strip())
    assert tokens[0] == "add-generic-password"
    assert "-U" in tokens  # update-in-place, never a duplicate item
    assert tokens[tokens.index("-s") + 1] == "Navide CLI account claude-acct1"
    assert tokens[tokens.index("-w") + 1] == "SECRET"
    assert sec.items["Navide CLI account claude-acct1"] == "SECRET"


def test_mac_clear_live_deletes_keychain_and_file(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items["Claude Code-credentials"] = "S"
    _write(tmp_path / "home" / ".claude" / ".credentials.json", "S")
    _write(tmp_path / "home" / ".claude.json", '{"oauthAccount": {"e": 1}}')

    vault.clear_live("claude")

    assert "Claude Code-credentials" not in sec.items
    assert not (tmp_path / "home" / ".claude" / ".credentials.json").exists()
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    assert "oauthAccount" not in config


def test_mac_non_claude_agents_use_files_not_keychain(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", "{}")

    vault.capture("codex", "slot1")

    assert sec.calls == []
    assert (vault.slot_dir("codex", "slot1") / "auth.json").exists()


def test_mac_harvest_legacy_claude_home(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    legacy_home = tmp_path / "legacy" / "37a6f4f2"
    _write(legacy_home / ".claude.json", '{"oauthAccount": {"emailAddress": "old@x.com"}}')
    sec.items[legacy_claude_keychain_service(legacy_home)] = "LEGACY-SECRET"

    assert vault.harvest_legacy_claude_home("37a6f4f2", legacy_home) is True

    slot = vault.read_slot("claude", "37a6f4f2")
    assert slot.secret == "LEGACY-SECRET"
    assert slot.account == {"emailAddress": "old@x.com"}
    # The legacy Keychain item is cleaned up once the slot owns the secret.
    assert legacy_claude_keychain_service(legacy_home) not in sec.items


def test_mac_harvest_legacy_home_without_credentials(tmp_path: Path) -> None:
    vault, _sec = _mac_vault(tmp_path)
    legacy_home = tmp_path / "legacy" / "4ad13e88"
    legacy_home.mkdir(parents=True)

    assert vault.harvest_legacy_claude_home("4ad13e88", legacy_home) is False
    assert vault.slot_is_empty("claude", "4ad13e88")


# ── isolated login homes ────────────────────────────────────────────────────


@pytest.mark.parametrize("agent_key,secret_rel", [
    ("codex", "auth.json"),
    ("kimi", "credentials/kimi-code.json"),
    ("grok", "home/.grok/auth.json"),
])
def test_harvest_login_home_captures_and_removes(
    tmp_path: Path, agent_key: str, secret_rel: str
) -> None:
    vault = _file_vault(tmp_path)
    home = vault.login_home_path(agent_key, "slot1")
    _write(home / secret_rel, '{"who": "fresh-login"}')

    assert vault.harvest_login_home(agent_key, "slot1") is True
    assert vault.read_slot(agent_key, "slot1").secret == '{"who": "fresh-login"}'
    assert not home.exists()


def test_harvest_login_home_overwrites_existing_slot(tmp_path: Path) -> None:
    """The user just re-logged this account — the login home wins over
    whatever secret the slot already held."""
    vault = _file_vault(tmp_path)
    vault.write_slot("codex", "slot1", LiveCredentials(secret='{"who": "old"}'))
    home = vault.login_home_path("codex", "slot1")
    _write(home / "auth.json", '{"who": "new"}')

    assert vault.harvest_login_home("codex", "slot1") is True
    assert vault.read_slot("codex", "slot1").secret == '{"who": "new"}'
    assert not home.exists()


def test_harvest_login_home_without_secret_is_noop(tmp_path: Path) -> None:
    """A login still in progress (home exists, no secret yet) keeps both the
    slot and the login home untouched for a later poll."""
    vault = _file_vault(tmp_path)
    vault.write_slot("codex", "slot1", LiveCredentials(secret='{"who": "kept"}'))
    home = vault.login_home_path("codex", "slot1")
    home.mkdir(parents=True)

    assert vault.harvest_login_home("codex", "slot1") is False
    assert vault.read_slot("codex", "slot1").secret == '{"who": "kept"}'
    assert home.exists()


def test_harvest_login_home_missing_dir_is_noop(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    assert vault.harvest_login_home("claude", "slot1") is False
    assert vault.slot_is_empty("claude", "slot1")


@pytest.mark.parametrize("agent_key,secret_rel", [
    ("codex", "auth.json"),
    ("kimi", "credentials/kimi-code.json"),
    ("grok", "home/.grok/auth.json"),
])
def test_login_secret_present_file_agents(
    tmp_path: Path, agent_key: str, secret_rel: str
) -> None:
    vault = _file_vault(tmp_path)
    assert vault.login_secret_present(agent_key, "slot1") is False
    _write(vault.login_home_path(agent_key, "slot1") / secret_rel, "{}")
    assert vault.login_secret_present(agent_key, "slot1") is True


def test_login_secret_present_claude_never_peeks(tmp_path: Path) -> None:
    # claude's secret lives in the Keychain (no cheap peek); its sign-in
    # command exits on completion, so the peek always reports False.
    vault = _file_vault(tmp_path)
    vault.login_home_path("claude", "slot1").mkdir(parents=True)
    assert vault.login_secret_present("claude", "slot1") is False


def test_mac_harvest_login_home_claude(tmp_path: Path) -> None:
    """Claude login homes mirror legacy CLAUDE_CONFIG_DIR homes: secret in the
    path-hashed Keychain item (deleted after capture), display account in the
    home's own .claude.json."""
    vault, sec = _mac_vault(tmp_path)
    home = vault.login_home_path("claude", "slot1")
    home.mkdir(parents=True)
    sec.items[legacy_claude_keychain_service(home)] = "FRESH-SECRET"
    _write(home / ".claude.json", '{"oauthAccount": {"emailAddress": "new@x.com"}}')

    assert vault.harvest_login_home("claude", "slot1") is True

    slot = vault.read_slot("claude", "slot1")
    assert slot.secret == "FRESH-SECRET"
    assert slot.account == {"emailAddress": "new@x.com"}
    assert legacy_claude_keychain_service(home) not in sec.items
    assert not home.exists()


def test_login_spawn_env_per_agent(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)

    env_set, env_remove = vault.login_spawn_env("claude", "slot1")
    home = vault.login_home_path("claude", "slot1")
    assert env_set == {"CLAUDE_CONFIG_DIR": str(home)}
    assert env_remove == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    # The home will hold fresh secrets — private regardless of umask.
    assert stat.S_IMODE(os.stat(home).st_mode) == 0o700

    assert vault.login_spawn_env("codex", "s1") == (
        {"CODEX_HOME": str(vault.login_home_path("codex", "s1"))}, []
    )
    assert vault.login_spawn_env("kimi", "s1") == (
        {"KIMI_CODE_HOME": str(vault.login_home_path("kimi", "s1"))}, []
    )


def test_login_spawn_env_grok_builds_home_shim(tmp_path: Path) -> None:
    """Grok isolates via a HOME shim: real .grok dir inside the login home,
    every other real-home entry symlinked so shell config still applies."""
    vault = _file_vault(tmp_path)
    real_home = tmp_path / "home"
    _write(real_home / ".zshrc", "export X=1")

    env_set, env_remove = vault.login_spawn_env("grok", "slot1")

    shim = vault.login_home_path("grok", "slot1") / "home"
    assert env_set == {"HOME": str(shim)}
    assert env_remove == []
    assert (shim / ".grok").is_dir() and not (shim / ".grok").is_symlink()
    assert (shim / ".zshrc").is_symlink()
    assert (shim / ".zshrc").resolve() == (real_home / ".zshrc").resolve()


# ── display identities (signedIn = an actual credential secret exists) ──────


def _jwt(payload: dict) -> str:
    import base64

    seg = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"header.{seg}.signature"


def test_identity_claude_live_and_slot(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".claude.json",
           '{"oauthAccount": {"emailAddress": "live@x.com"}}')
    vault.write_slot("claude", "slot1",
                     LiveCredentials(secret="s", account={"emailAddress": "slot@x.com"}))

    # An oauthAccount left behind without a credential secret is not a login.
    assert vault.identity("claude") == {"email": "live@x.com", "signedIn": False}
    _write(tmp_path / "home" / ".claude" / ".credentials.json", '{"tok": 1}')
    assert vault.identity("claude") == {"email": "live@x.com", "signedIn": True}
    assert vault.identity("claude", "slot1") == {"email": "slot@x.com", "signedIn": True}
    assert vault.identity("claude", "missing") == {"email": None, "signedIn": False}


def test_mac_identity_claude_signed_in_reflects_secret(tmp_path: Path) -> None:
    """signedIn comes from the actual credential secret (Keychain item);
    the oauthAccount email is display-only. A long-lived-token login carries
    no oauthAccount but is still signed in; an oauthAccount without a secret
    is not."""
    vault, sec = _mac_vault(tmp_path)

    sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] = "SECRET"
    assert vault.identity("claude") == {"email": None, "signedIn": True}

    del sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE]
    _write(tmp_path / "home" / ".claude.json",
           '{"oauthAccount": {"emailAddress": "live@x.com"}}')
    assert vault.identity("claude") == {"email": "live@x.com", "signedIn": False}

    # Slots: secret lives in the slot's own Keychain item.
    vault.write_slot("claude", "slot1", LiveCredentials(secret="S2"))
    assert vault.identity("claude", "slot1") == {"email": None, "signedIn": True}


def test_identity_codex_email_from_id_token(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", json.dumps({
        "tokens": {"access_token": "t", "id_token": _jwt({"email": "codex@x.com"})},
    }))

    assert vault.identity("codex") == {"email": "codex@x.com", "signedIn": True}


def test_identity_codex_api_key_has_no_email(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", '{"OPENAI_API_KEY": "sk-x"}')

    assert vault.identity("codex") == {"email": None, "signedIn": True}


def test_identity_grok_email_from_auth_entry(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".grok" / "auth.json", json.dumps({
        "https://auth.x.ai::scope": {"key": "k", "email": "grok@x.com"},
    }))

    assert vault.identity("grok") == {"email": "grok@x.com", "signedIn": True}


def test_identity_kimi_signed_in_without_email(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".kimi-code" / "credentials" / "kimi-code.json",
           '{"access_token": "t", "expires_at": 9999999999}')

    assert vault.identity("kimi") == {"email": None, "signedIn": True}


def test_identity_logged_out_and_garbage_never_raise(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", "not json")

    assert vault.identity("codex") == {"email": None, "signedIn": False}
    assert vault.identity("grok") == {"email": None, "signedIn": False}
    assert vault.identity("kimi", "slot1") == {"email": None, "signedIn": False}
