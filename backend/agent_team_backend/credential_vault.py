"""Per-account credential slots for CLI agents.

Profiles no longer isolate a CLI's whole config home: every agent runs
against the user's real home, and a profile is only a credential slot.
Switching the active account captures the live credentials into the outgoing
account's slot and restores the incoming account's slot into the live
location. The reserved slot ``__default__`` holds the unmanaged original
login while a managed account is active.

Live credential locations (relative to the real home):

    claude  macOS: Keychain generic password, service
            ``Claude Code-credentials`` (file fallback
            ``~/.claude/.credentials.json``); elsewhere the file only.
            The display-only ``oauthAccount`` object lives at the top level
            of ``~/.claude.json``.
    codex   ``~/.codex/auth.json``
    kimi    ``~/.kimi-code/credentials/kimi-code.json``
    grok    ``~/.grok/auth.json``

Slot storage:

    claude on macOS  backend-owned Keychain item
                     ``Navide CLI account claude-<slot_id>`` for the secret,
                     plus ``oauth-account.json`` (display info, not a secret)
                     in the slot directory
    everything else  0600 files under ``<profiles_root>/<agentKey>/<slot_id>/``

All Keychain access goes through an injectable ``security_runner`` so tests
never touch the real Keychain.
"""

from __future__ import annotations

import getpass
import hashlib
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .profiles_store import canonical_path_str, default_profiles_root

log = logging.getLogger("agent_team_backend.credential_vault")

# Reserved slot for the unmanaged original login (defaults[agent] = null).
DEFAULT_SLOT_ID = "__default__"

CLAUDE_LIVE_KEYCHAIN_SERVICE = "Claude Code-credentials"
_SLOT_SERVICE_PREFIX = "Navide CLI account "

# Secret file name inside a slot directory, per agent.
_SLOT_FILES = {
    "claude": ".credentials.json",
    "codex": "auth.json",
    "kimi": "kimi-code.json",
    "grok": "auth.json",
}

# Live secret file path segments, relative to the real home.
_LIVE_FILES = {
    "claude": (".claude", ".credentials.json"),
    "codex": (".codex", "auth.json"),
    "kimi": (".kimi-code", "credentials", "kimi-code.json"),
    "grok": (".grok", "auth.json"),
}

_OAUTH_ACCOUNT_SLOT_FILE = "oauth-account.json"

# runner(args_after_security, stdin_text) -> (returncode, stdout)
SecurityRunner = Callable[[list[str], "str | None"], "tuple[int, str]"]


class CredentialVaultError(RuntimeError):
    """A credential read/write against the live location or a slot failed."""


def _default_security_runner(args: list[str], input_text: str | None = None) -> tuple[int, str]:
    proc = subprocess.run(
        ["/usr/bin/security", *args],
        input=input_text,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return proc.returncode, proc.stdout


def _kc_quote(value: str) -> str:
    """Quote a value for the `security -i` interactive command parser."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    os.chmod(path, 0o600)


def legacy_claude_keychain_service(config_dir: Path | str) -> str:
    """Keychain service Claude Code used under CLAUDE_CONFIG_DIR isolation:
    the fixed service name suffixed with sha256(config-dir string)[:8]."""
    digest = hashlib.sha256(canonical_path_str(config_dir).encode("utf-8")).hexdigest()
    return f"{CLAUDE_LIVE_KEYCHAIN_SERVICE}-{digest[:8]}"


@dataclass
class LiveCredentials:
    """A point-in-time credential snapshot for one agent.

    ``secret`` is the raw credential payload (JSON text) or ``None`` when
    logged out. ``account`` is claude's display-only ``oauthAccount`` object.
    """

    secret: str | None = None
    account: dict | None = None


class CredentialVault:
    def __init__(
        self,
        *,
        root: Path | None = None,
        real_home: Path | None = None,
        security_runner: SecurityRunner | None = None,
        platform: str | None = None,
    ) -> None:
        self._root = Path(canonical_path_str(root or default_profiles_root()))
        self._real_home = Path(real_home or Path.home())
        self._security = security_runner or _default_security_runner
        self._platform = platform or sys.platform

    # ---- locations ----

    @property
    def _is_macos(self) -> bool:
        return self._platform == "darwin"

    def slot_dir(self, agent_key: str, slot_id: str) -> Path:
        return self._root / agent_key / slot_id

    def _slot_service(self, agent_key: str, slot_id: str) -> str:
        return f"{_SLOT_SERVICE_PREFIX}{agent_key}-{slot_id}"

    def _live_file(self, agent_key: str) -> Path:
        return self._real_home.joinpath(*_LIVE_FILES[agent_key])

    def _claude_config_json(self) -> Path:
        return self._real_home / ".claude.json"

    # ---- Keychain primitives (injectable runner; never the real Keychain
    # in tests) ----

    def _keychain_read(self, service: str) -> str | None:
        try:
            rc, out = self._security(["find-generic-password", "-s", service, "-w"], None)
        except Exception as err:  # noqa: BLE001
            log.warning("keychain read %s failed: %s", service, err)
            return None
        if rc != 0:
            return None
        secret = out.rstrip("\n")
        return secret or None

    def _keychain_write(self, service: str, secret: str) -> None:
        # -U updates in place when the item already exists. The account
        # attribute mirrors what the CLIs use (the login user name).
        # Interactive mode (-i) takes the command on stdin so the secret
        # never appears in the argv, which any local process can read via
        # the process table.
        command = " ".join(
            [
                "add-generic-password",
                "-U",
                "-a", _kc_quote(getpass.getuser()),
                "-s", _kc_quote(service),
                "-w", _kc_quote(secret),
            ]
        )
        rc, _ = self._security(["-i"], command + "\n")
        if rc != 0:
            raise CredentialVaultError(f"keychain write failed for {service!r}")

    def _keychain_delete(self, service: str) -> None:
        # A missing item is fine — deletion is idempotent.
        self._security(["delete-generic-password", "-s", service], None)

    # ---- live credentials ----

    def read_live(self, agent_key: str) -> LiveCredentials:
        if agent_key == "claude":
            secret = self._keychain_read(CLAUDE_LIVE_KEYCHAIN_SERVICE) if self._is_macos else None
            if secret is None:
                secret = _read_text(self._live_file("claude"))
            return LiveCredentials(secret=secret, account=self._read_live_oauth_account())
        return LiveCredentials(secret=_read_text(self._live_file(agent_key)))

    def write_live(self, agent_key: str, creds: LiveCredentials) -> None:
        if agent_key == "claude":
            if creds.secret is None:
                if self._is_macos:
                    self._keychain_delete(CLAUDE_LIVE_KEYCHAIN_SERVICE)
                self._live_file("claude").unlink(missing_ok=True)
            elif self._is_macos:
                self._keychain_write(CLAUDE_LIVE_KEYCHAIN_SERVICE, creds.secret)
                # Stale file credentials would shadow-report the old account.
                self._live_file("claude").unlink(missing_ok=True)
            else:
                _write_private(self._live_file("claude"), creds.secret)
            self._write_live_oauth_account(creds.account)
            return
        if creds.secret is None:
            self._live_file(agent_key).unlink(missing_ok=True)
        else:
            _write_private(self._live_file(agent_key), creds.secret)

    def clear_live(self, agent_key: str) -> None:
        self.write_live(agent_key, LiveCredentials())

    def _read_live_oauth_account(self) -> dict | None:
        raw = _read_text(self._claude_config_json())
        if raw is None:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        account = data.get("oauthAccount") if isinstance(data, dict) else None
        return account if isinstance(account, dict) else None

    def _write_live_oauth_account(self, account: dict | None) -> None:
        """Set/remove the top-level ``oauthAccount`` in ``~/.claude.json``,
        preserving every other key."""
        path = self._claude_config_json()
        raw = _read_text(path)
        try:
            data = json.loads(raw) if raw is not None else {}
        except ValueError:
            log.warning("%s is not valid JSON; leaving oauthAccount untouched", path)
            return
        if not isinstance(data, dict):
            return
        if account is None:
            if "oauthAccount" not in data:
                return
            data.pop("oauthAccount")
        else:
            data["oauthAccount"] = account
        try:
            path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except OSError as err:
            raise CredentialVaultError(f"cannot update {path}: {err}") from err

    # ---- slots ----

    def read_slot(self, agent_key: str, slot_id: str) -> LiveCredentials:
        slot = self.slot_dir(agent_key, slot_id)
        if agent_key == "claude":
            if self._is_macos:
                secret = self._keychain_read(self._slot_service(agent_key, slot_id))
            else:
                secret = _read_text(slot / _SLOT_FILES["claude"])
            account_raw = _read_text(slot / _OAUTH_ACCOUNT_SLOT_FILE)
            account = None
            if account_raw is not None:
                try:
                    parsed = json.loads(account_raw)
                    account = parsed if isinstance(parsed, dict) else None
                except ValueError:
                    account = None
            return LiveCredentials(secret=secret, account=account)
        return LiveCredentials(secret=_read_text(slot / _SLOT_FILES[agent_key]))

    def write_slot(self, agent_key: str, slot_id: str, creds: LiveCredentials) -> None:
        slot = self.slot_dir(agent_key, slot_id)
        if agent_key == "claude":
            if self._is_macos:
                service = self._slot_service(agent_key, slot_id)
                if creds.secret is None:
                    self._keychain_delete(service)
                else:
                    self._keychain_write(service, creds.secret)
            elif creds.secret is None:
                (slot / _SLOT_FILES["claude"]).unlink(missing_ok=True)
            else:
                _write_private(slot / _SLOT_FILES["claude"], creds.secret)
            account_file = slot / _OAUTH_ACCOUNT_SLOT_FILE
            if creds.account is None:
                account_file.unlink(missing_ok=True)
            else:
                _write_private(account_file, json.dumps(creds.account, indent=2))
            return
        if creds.secret is None:
            (slot / _SLOT_FILES[agent_key]).unlink(missing_ok=True)
        else:
            _write_private(slot / _SLOT_FILES[agent_key], creds.secret)

    def slot_is_empty(self, agent_key: str, slot_id: str) -> bool:
        return self.read_slot(agent_key, slot_id).secret is None

    def slot_account(self, agent_key: str, slot_id: str) -> dict | None:
        """The slot's display-only account info (claude's ``oauthAccount``)."""
        return self.read_slot(agent_key, slot_id).account

    # ---- account switching ----

    def capture(self, agent_key: str, slot_id: str) -> LiveCredentials:
        """Mirror the live credential state into ``slot_id`` (a logged-out
        live state empties the slot). Returns the captured snapshot."""
        creds = self.read_live(agent_key)
        self.write_slot(agent_key, slot_id, creds)
        return creds

    def restore(self, agent_key: str, slot_id: str) -> None:
        """Make ``slot_id``'s content the live credentials. An empty slot
        clears the live credentials (the CLI then prompts a fresh login)."""
        self.write_live(agent_key, self.read_slot(agent_key, slot_id))

    def switch(self, agent_key: str, from_slot_id: str, to_slot_id: str) -> None:
        """Atomically move the live credentials into ``from_slot_id`` and bring
        ``to_slot_id`` live. On a restore failure the captured snapshot is
        written back so the live state is never lost."""
        outgoing = self.capture(agent_key, from_slot_id)
        try:
            self.restore(agent_key, to_slot_id)
        except Exception as err:
            try:
                self.write_live(agent_key, outgoing)
            except Exception as rollback_err:  # noqa: BLE001
                log.error(
                    "credential rollback for %s failed after restore error: %s",
                    agent_key, rollback_err,
                )
            raise CredentialVaultError(
                f"switching {agent_key} credentials failed: {err}"
            ) from err

    def harvest(self, agent_key: str, slot_id: str) -> bool:
        """Opportunistically fill an EMPTY slot from live credentials (the user
        just logged in inside a pane). No-op when the slot already holds a
        secret or nothing is live. Returns True when something was harvested."""
        if not self.slot_is_empty(agent_key, slot_id):
            return False
        creds = self.read_live(agent_key)
        if creds.secret is None:
            return False
        self.write_slot(agent_key, slot_id, creds)
        return True

    def harvest_legacy_claude_home(self, slot_id: str, legacy_home: Path) -> bool:
        """Capture a legacy CLAUDE_CONFIG_DIR home's credentials into a slot.

        Under CLAUDE_CONFIG_DIR isolation, Claude Code stored the secret in a
        Keychain item whose service is suffixed with a hash of the config-dir
        path (see ``legacy_claude_keychain_service``); the non-macOS fallback
        is ``<home>/.credentials.json``. Display info comes from the legacy
        home's own ``.claude.json``. Returns True when a secret was captured.
        """
        secret = None
        if self._is_macos:
            secret = self._keychain_read(legacy_claude_keychain_service(legacy_home))
        if secret is None:
            secret = _read_text(legacy_home / ".credentials.json")
        account = None
        raw = _read_text(legacy_home / ".claude.json")
        if raw is not None:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and isinstance(parsed.get("oauthAccount"), dict):
                    account = parsed["oauthAccount"]
            except ValueError:
                pass
        if secret is None:
            return False
        self.write_slot("claude", slot_id, LiveCredentials(secret=secret, account=account))
        if self._is_macos:
            # The slot owns the credential now; the legacy item would strand
            # a token copy in the Keychain forever (its config dir is archived
            # and no CLI reads it again). Deletion is idempotent.
            self._keychain_delete(legacy_claude_keychain_service(legacy_home))
        return True
