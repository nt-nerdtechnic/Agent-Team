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
