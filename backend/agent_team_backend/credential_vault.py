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

import asyncio
import base64
import getpass
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .profiles_store import (
    CLAUDE_ENV_OVERRIDES,
    PROFILE_HOME_DIRNAME,
    canonical_path_str,
    default_profiles_root,
)

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

# Isolated config home a login pane runs in, inside the profile's slot dir.
# The CLI completes its login there without touching the live credentials;
# the usage poller then harvests it into the slot and removes it.
LOGIN_HOME_DIRNAME = "login-home"

# Where each CLI writes its secret inside an isolated login home, relative to
# the login-home dir. Env vars and layouts mirror the pre-refactor config-home
# isolation (verified in commit 0bcfcf8^): claude uses CLAUDE_CONFIG_DIR (macOS
# secret in a path-hashed Keychain item — see harvest_legacy_claude_home),
# codex CODEX_HOME, kimi KIMI_CODE_HOME, grok a HOME shim with a real ``.grok``
# dir one level in.
_LOGIN_HOME_SECRET_FILES = {
    "codex": ("auth.json",),
    "kimi": ("credentials", "kimi-code.json"),
    "grok": ("home", ".grok", "auth.json"),
}


def _parse_json_dict(raw: str | None) -> dict | None:
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _claude_oauth_expires_at(secret: str | None) -> float | None:
    """Epoch-ms token expiry from a claude credentials JSON
    (``claudeAiOauth.expiresAt``); None when absent or unparsable."""
    data = _parse_json_dict(secret)
    oauth = data.get("claudeAiOauth") if data else None
    expires = oauth.get("expiresAt") if isinstance(oauth, dict) else None
    if isinstance(expires, bool) or not isinstance(expires, (int, float)):
        return None
    return float(expires)


def _claude_home_secret_is_fresher(home_secret: str | None, slot_secret: str) -> bool:
    """True when the profile home already holds a token the running CLI
    refreshed past the slot snapshot. Anthropic OAuth refresh tokens rotate,
    and the slot is only updated on capture/harvest — never from an in-place
    runtime refresh — so re-seeding from the slot would hand the pane a dead
    token pair ("Login expired"). Seeding is therefore runtime-first: the
    slot wins only when it is strictly newer (a fresh re-login harvest).
    When either side has no parsable expiry the comparison is impossible and
    the caller falls back to writing the slot value."""
    home_exp = _claude_oauth_expires_at(home_secret)
    slot_exp = _claude_oauth_expires_at(slot_secret)
    return home_exp is not None and slot_exp is not None and home_exp >= slot_exp


def _codex_identity_email(secret: str | None) -> str | None:
    """Best-effort login email from codex ``auth.json``: the ``id_token`` JWT
    payload carries it. Display only — the signature is not verified."""
    data = _parse_json_dict(secret)
    tokens = data.get("tokens") if data else None
    id_token = tokens.get("id_token") if isinstance(tokens, dict) else None
    if not isinstance(id_token, str) or id_token.count(".") < 2:
        return None
    payload = id_token.split(".")[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except ValueError:
        return None
    if not isinstance(claims, dict):
        return None
    email = claims.get("email")
    if isinstance(email, str) and email:
        return email
    profile = claims.get("https://api.openai.com/profile")
    if isinstance(profile, dict) and isinstance(profile.get("email"), str):
        return profile["email"] or None
    return None


def _codex_signed_in(secret: str | None) -> bool:
    data = _parse_json_dict(secret)
    if data is None:
        return False
    tokens = data.get("tokens")
    if isinstance(tokens, dict) and (tokens.get("access_token") or tokens.get("accessToken")):
        return True
    return bool(data.get("OPENAI_API_KEY"))


def _grok_auth_entry(secret: str | None) -> dict | None:
    """Grok's ``auth.json`` is a map keyed by scope URL; prefer the OIDC entry,
    fall back to the legacy ``/sign-in`` scope (mirrors usage_service)."""
    data = _parse_json_dict(secret)
    if data is None:
        return None
    oidc, legacy = None, None
    for scope, entry in data.items():
        if not isinstance(entry, dict) or not entry.get("key"):
            continue
        if str(scope).startswith("https://auth.x.ai::"):
            oidc = oidc or entry
        elif "/sign-in" in str(scope):
            legacy = legacy or entry
    return oidc or legacy

# runner(args_after_security, stdin_text) -> (returncode, output). Output is
# stdout; on failure the runner appends stderr so callers can surface the
# actual `security` error instead of a bare exit code.
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
    out = proc.stdout
    if proc.returncode != 0 and proc.stderr:
        out = (out + "\n" if out else "") + proc.stderr.strip()
    return proc.returncode, out


def _kc_quote(value: str) -> str:
    """Quote a value for the `security -i` interactive command parser."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _write_private(path: Path, text: str) -> None:
    """Atomically write a 0600 file: the content lands in a same-directory
    tmp file (created 0600) that then replaces the target, so a crash or a
    full disk mid-write can never leave a truncated or world-readable
    secret."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            fp.write(text)
        os.chmod(tmp, 0o600)  # umask-proof: the final file must be exactly 0600
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


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


@dataclass
class ProfileHomePlan:
    """Env overrides a managed account's persistent isolated home applies to
    one regular (non-login) terminal spawn."""

    env_set: dict[str, str] = field(default_factory=dict)
    env_remove: list[str] = field(default_factory=list)
    codex_source_home: Path | None = None


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
        self._switch_locks: dict[str, asyncio.Lock] = {}
        # Serializes Keychain check-then-write pairs across the spawn threads
        # (prepare_profile_home runs off the event loop; a restore spawns
        # several panes of one profile concurrently).
        self._keychain_lock = threading.Lock()

    def switch_lock(self, agent_key: str) -> asyncio.Lock:
        """Per-agent lock serializing credential swaps and opportunistic
        harvests against the shared OS credential locations (Keychain / files).
        Concurrent switches on the same agent — multiple windows, or a switch
        racing the usage poller's harvest — would otherwise interleave their
        capture/restore steps and clobber a slot (worst case: the ``__default__``
        original login). Acquire in the event loop before any ``switch``/
        ``harvest`` call. Kept on the instance so each test gets a fresh lock
        bound to its own event loop."""
        lock = self._switch_locks.get(agent_key)
        if lock is None:
            lock = asyncio.Lock()
            self._switch_locks[agent_key] = lock
        return lock

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
        rc, out = self._security(["-i"], command + "\n")
        if rc != 0:
            # Last line only, truncated: enough for the security error message
            # while guaranteeing the secret (a long JSON blob) is never logged.
            lines = out.strip().splitlines()
            detail = lines[-1][:200] if lines else ""
            raise CredentialVaultError(
                f"keychain write failed for {service!r}"
                + (f": {detail}" if detail else "")
            )

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
        preserving every other key. Written atomically (same-directory tmp
        file + ``os.replace``, keeping the original file's mode) — this file
        is the user's whole Claude config, and a crash or full disk mid-write
        must never corrupt it."""
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
        tmp = path.with_name(path.name + ".tmp")
        try:
            mode = path.stat().st_mode & 0o777
        except OSError:
            mode = None
        try:
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            if mode is not None:
                os.chmod(tmp, mode)
            os.replace(tmp, path)
        except OSError as err:
            tmp.unlink(missing_ok=True)
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

    def resolve_claude_credentials(
        self, slot_id: str, *, active: bool
    ) -> LiveCredentials:
        """Read the credential a managed Claude pane currently uses.

        A profile's persistent runtime home can contain a token refreshed by a
        running Claude CLI, so it takes precedence over the older live/slot
        copy. The built-in default has no managed runtime home. This method is
        read-only: it never captures, restores, switches, or writes credentials.
        """
        if slot_id != DEFAULT_SLOT_ID:
            home = self.profile_home_path("claude", slot_id)
            runtime_secret = (
                self._keychain_read(legacy_claude_keychain_service(home))
                if self._is_macos
                else _read_text(home / ".credentials.json")
            )
            if runtime_secret is not None:
                return LiveCredentials(secret=runtime_secret)
        return self.read_live("claude") if active else self.read_slot("claude", slot_id)

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

    def identity(self, agent_key: str, slot_id: str | None = None) -> dict:
        """Display-only identity for one account slot (``slot_id=None`` = the
        live state, i.e. the currently active account). ``signedIn`` reflects
        whether an actual credential secret exists; claude's ``oauthAccount``
        email is display-only (a long-lived-token login carries no
        oauthAccount but is still signed in). Reads files — plus, for claude
        on macOS, the Keychain — so call off the event loop.
        Returns ``{"email": str | None, "signedIn": bool}``; never raises."""
        try:
            if agent_key == "claude":
                creds = (
                    self.read_live("claude") if slot_id is None
                    else self.read_slot("claude", slot_id)
                )
                email = (
                    creds.account.get("emailAddress")
                    if isinstance(creds.account, dict) else None
                )
                email = email if isinstance(email, str) and email else None
                return {"email": email, "signedIn": creds.secret is not None}
            if slot_id is None:
                secret = _read_text(self._live_file(agent_key))
            else:
                secret = _read_text(
                    self.slot_dir(agent_key, slot_id) / _SLOT_FILES[agent_key]
                )
            if agent_key == "codex":
                return {
                    "email": _codex_identity_email(secret),
                    "signedIn": _codex_signed_in(secret),
                }
            if agent_key == "grok":
                entry = _grok_auth_entry(secret)
                email = entry.get("email") if entry else None
                return {
                    "email": email if isinstance(email, str) and email else None,
                    "signedIn": entry is not None,
                }
            # kimi (and any future agent without an identity field): presence
            # of a token is all we can show.
            data = _parse_json_dict(secret)
            return {"email": None, "signedIn": bool(data and data.get("access_token"))}
        except Exception:  # noqa: BLE001 — identity is display-only, never fatal
            return {"email": None, "signedIn": False}

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

    def delete_slot_secrets(self, agent_key: str, slot_id: str) -> None:
        """Cleanup for a profile deletion: remove the secrets the store's
        archive-by-rename cannot carry, plus any pending login home. The store
        keeps file-based slot secrets inside the renamed slot directory, but
        claude's macOS slot Keychain item (and a claude login home's
        path-hashed item) would be stranded forever. Idempotent; call inside
        ``switch_lock(agent_key)`` BEFORE the store renames the slot dir."""
        home = self.login_home_path(agent_key, slot_id)
        if home.is_dir():
            if agent_key == "claude" and self._is_macos:
                self._keychain_delete(legacy_claude_keychain_service(home))
            shutil.rmtree(home, ignore_errors=True)
        if agent_key == "claude":
            if self._is_macos:
                self._keychain_delete(self._slot_service(agent_key, slot_id))
            (self.slot_dir(agent_key, slot_id) / _OAUTH_ACCOUNT_SLOT_FILE).unlink(
                missing_ok=True
            )

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

    # ---- isolated login homes ----

    def login_home_path(self, agent_key: str, slot_id: str) -> Path:
        return self.slot_dir(agent_key, slot_id) / LOGIN_HOME_DIRNAME

    def _refresh_grok_login_shim(self, login_home: Path) -> Path:
        """Build/refresh the HOME shim for a grok login pane (shim lives one
        level in, at ``<login_home>/home``)."""
        return self._populate_grok_shim(login_home / "home")

    def _populate_grok_shim(self, shim: Path) -> Path:
        """Build/refresh a grok HOME shim at ``shim``.

        The shim mirrors every top-level entry of the real home via symlink so
        the CLI (and the pane's login shell) still sees the user's shell
        config, except ``.grok`` which is a real directory inside the shim —
        that's where grok keeps its credentials. Refreshing on every spawn
        picks up new real-home entries and drops dangling symlinks (ported from
        the pre-refactor ``refresh_grok_home_shim``)."""
        shim.mkdir(parents=True, exist_ok=True)
        (shim / ".grok").mkdir(exist_ok=True)
        # ``.grok`` stays a real dir (it holds the isolated ``auth.json``), but
        # the session database is shared: symlink grok.db (+ its sqlite -wal /
        # -shm sidecars) back to the real ~/.grok so sessions follow the user,
        # not the account.
        real_grok = self._real_home / ".grok"
        for name in ("grok.db", "grok.db-wal", "grok.db-shm"):
            self._link_shared(shim / ".grok" / name, real_grok / name, is_dir=False)
        try:
            for entry in shim.iterdir():
                if entry.is_symlink() and not entry.exists():
                    entry.unlink(missing_ok=True)
        except OSError as err:
            log.warning("grok shim cleanup in %s failed: %s", shim, err)
        try:
            real_entries = list(self._real_home.iterdir())
        except OSError as err:
            log.warning("cannot list real home %s for grok shim: %s", self._real_home, err)
            real_entries = []
        for src in real_entries:
            if src.name == ".grok":
                continue
            dst = shim / src.name
            if dst.exists() or dst.is_symlink():
                continue
            try:
                dst.symlink_to(src, target_is_directory=src.is_dir())
            except OSError as err:
                log.warning("grok shim symlink %s -> %s failed: %s", dst, src, err)
        return shim

    def login_spawn_env(self, agent_key: str, slot_id: str) -> tuple[dict[str, str], list[str]]:
        """Env for spawning ``agent_key``'s login pane inside the profile's
        isolated login home: ``(env_set, env_remove)``. Creates the login home
        (0700 — it will hold fresh credentials). Blocking I/O — call off the
        event loop."""
        if agent_key not in _SLOT_FILES:
            raise ValueError(f"unsupported agent for CLI login homes: {agent_key!r}")
        home = self.login_home_path(agent_key, slot_id)
        home.mkdir(parents=True, exist_ok=True)
        os.chmod(home, 0o700)  # umask-proof: the home will hold fresh secrets
        home_str = canonical_path_str(home)
        if agent_key == "claude":
            # Claude derives its Keychain item name from the literal
            # CLAUDE_CONFIG_DIR string; the canonical path here must match the
            # one harvest_login_home hashes later, byte for byte.
            return {"CLAUDE_CONFIG_DIR": home_str}, list(CLAUDE_ENV_OVERRIDES)
        if agent_key == "codex":
            return {"CODEX_HOME": home_str}, []
        if agent_key == "kimi":
            return {"KIMI_CODE_HOME": home_str}, []
        # grok: HOME shim; its .grok dir lives one level in.
        shim = self._refresh_grok_login_shim(Path(home_str))
        return {"HOME": canonical_path_str(shim)}, []

    def login_secret_present(self, agent_key: str, slot_id: str) -> bool:
        """True when the isolated login home already holds the CLI's secret
        file (file-based agents only — claude's Keychain secret has no cheap
        peek and its sign-in command exits on completion anyway)."""
        segments = _LOGIN_HOME_SECRET_FILES.get(agent_key)
        if segments is None:
            return False
        return self.login_home_path(agent_key, slot_id).joinpath(*segments).is_file()

    def _login_home_is_stale(self, agent_key: str, slot_id: str, home: Path) -> bool:
        """True when the slot already holds a NEWER credential than the login
        home — an old leftover home (e.g. found by the startup sweep long
        after a later re-login) must not overwrite it. Conservative: an empty
        slot or any missing mtime keeps the normal overwrite behavior.
        claude's Keychain entries carry no mtime, so the home directory itself
        stands in for the home's secret and the slot's ``oauth-account.json``
        for the slot's."""
        try:
            if self.read_slot(agent_key, slot_id).secret is None:
                return False
            slot = self.slot_dir(agent_key, slot_id)
            if agent_key == "claude":
                home_mtime = home.stat().st_mtime
                slot_mtime = (slot / _OAUTH_ACCOUNT_SLOT_FILE).stat().st_mtime
            else:
                home_mtime = home.joinpath(
                    *_LOGIN_HOME_SECRET_FILES[agent_key]
                ).stat().st_mtime
                slot_mtime = (slot / _SLOT_FILES[agent_key]).stat().st_mtime
        except OSError:
            return False
        return home_mtime < slot_mtime

    def harvest_login_home(self, agent_key: str, slot_id: str) -> bool:
        """Capture a finished isolated login into the profile's slot.

        Overwrites the slot — the user just re-logged this account, so the
        login home's credentials win over whatever the slot held — unless the
        home is STALE (the slot was re-signed after the home was written), in
        which case the home is discarded untouched. On success the login home
        is deleted; a login home without credentials yet (login still in
        progress or abandoned) is a no-op and stays for a later poll. Call
        inside ``switch_lock(agent_key)``."""
        home = self.login_home_path(agent_key, slot_id)
        if not home.is_dir():
            return False
        if self._login_home_is_stale(agent_key, slot_id, home):
            log.info("discarding stale %s login home for slot %s", agent_key, slot_id)
            if agent_key == "claude" and self._is_macos:
                self._keychain_delete(legacy_claude_keychain_service(home))
            shutil.rmtree(home, ignore_errors=True)
            return False
        if agent_key == "claude":
            # Same locations as a legacy CLAUDE_CONFIG_DIR home: path-hashed
            # Keychain item (deleted after capture) or .credentials.json, plus
            # the home's own .claude.json for the display-only oauthAccount.
            if not self.harvest_legacy_claude_home(slot_id, home):
                return False
            # The user just re-logged this account, so the login must win the
            # next seed. Runtime-first seeding keeps the profile home's copy
            # when its expiry is not older — an obsolete copy whose expiresAt
            # outlives the new login's (e.g. a revoked long-lived token with a
            # far-future expiry) would shadow the fresh login forever. Drop
            # the home copy only in that case; otherwise leave it for any
            # still-running panes of this profile.
            profile_home = self.profile_home_path(agent_key, slot_id)
            new_secret = self.read_slot("claude", slot_id).secret
            home_service = legacy_claude_keychain_service(profile_home)
            home_file = profile_home / ".credentials.json"
            home_secret = (
                self._keychain_read(home_service) if self._is_macos else _read_text(home_file)
            )
            if (
                new_secret is not None
                and home_secret != new_secret
                and _claude_home_secret_is_fresher(home_secret, new_secret)
            ):
                if self._is_macos:
                    self._keychain_delete(home_service)
                else:
                    try:
                        home_file.unlink(missing_ok=True)
                    except OSError as err:
                        log.warning("stale profile-home credential cleanup failed: %s", err)
        else:
            secret = _read_text(home.joinpath(*_LOGIN_HOME_SECRET_FILES[agent_key]))
            if secret is None:
                return False
            self.write_slot(agent_key, slot_id, LiveCredentials(secret=secret))
        shutil.rmtree(home, ignore_errors=True)
        return True

    # ---- persistent isolated homes (regular panes) ----

    def profile_home_path(self, agent_key: str, slot_id: str) -> Path:
        """The persistent config home a managed account's regular panes run in.

        Unlike ``login_home_path`` (disposable, harvested + removed after a
        login), this home lives for the profile's lifetime and holds a working
        copy of the slot's credentials so panes stay signed in. Kept as a
        subdir of the slot dir so slot bookkeeping and the login home never
        collide with the CLI's own config-home files (projects/, sessions/,
        .grok/). The literal path must be byte-for-byte stable: claude derives
        its Keychain item name from a hash of ``CLAUDE_CONFIG_DIR``."""
        return self.slot_dir(agent_key, slot_id) / PROFILE_HOME_DIRNAME

    # ---- shared-home symlinks (only credentials stay isolated) ----
    #
    # A managed account's persistent home isolates ONLY the credential secret;
    # session history and settings are symlinked back to the user's real home
    # so panes share one session store regardless of which account is active.
    # That store-sharing is also what fixes cross-profile resume: every home's
    # ``projects``/``sessions`` resolves to the same real dir, so a resume
    # preflight (and the CLI itself) always finds the session no matter which
    # home the pane runs in — no more "No conversation found" crash-loop.

    def _ensure_target_base(self, target: Path, *, is_dir: bool) -> None:
        """Make sure a shared symlink can be written through: the target dir
        itself for a directory link, or the target's parent for a file link
        (the file is created by the CLI on first write, through the symlink)."""
        try:
            (target if is_dir else target.parent).mkdir(parents=True, exist_ok=True)
        except OSError as err:
            log.warning("cannot ensure shared target base %s: %s", target, err)

    def _migrate_file(self, src: Path, target: Path) -> bool:
        """Move a real file that shadows a shared link into the real home.
        Never overwrites an existing real-home file; a clash moves ``src``
        aside into a sibling ``<name>.unmerged`` quarantine so it stops
        shadowing the shared link (leaving it in place would keep the file
        unshared on every future spawn). Returns True only when ``src`` was
        moved away (so the caller may replace it with a symlink)."""
        try:
            if target.exists():
                quarantine = src.with_name(src.name + ".unmerged")
                log.warning(
                    "shared target %s already exists; quarantining %s at %s",
                    target, src, quarantine,
                )
                shutil.move(os.fspath(src), os.fspath(quarantine))
                return True
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(os.fspath(src), os.fspath(target))
            return True
        except OSError as err:
            log.warning("migrating %s -> %s failed: %s", src, target, err)
            return False

    def _migrate_dir(self, src: Path, target: Path) -> bool:
        """Merge a real directory that shadows a shared link (session/projects
        data written under the old whole-home isolation) into the real home.
        A name clash never overwrites the real copy: the clashing file is
        moved into a sibling ``<name>.unmerged`` quarantine instead of being
        left in place, so one stale file cannot keep the whole store unshared
        forever (an unshared ``projects`` hides every resumable session from
        the CLI — the "No conversation found" restart loop). ``src`` is
        removed only once every file drained; a src that could not be fully
        merged is left in place unshared. Returns True only when ``src`` was
        fully drained and removed."""
        quarantine = src.with_name(src.name + ".unmerged")
        try:
            target.mkdir(parents=True, exist_ok=True)
            drained = True
            for root, _dirs, files in os.walk(src):
                rel = Path(root).relative_to(src)
                for name in files:
                    dest = target / rel / name
                    if dest.exists():
                        # Never overwrite the real copy; quarantine ours.
                        dest = quarantine / rel / name
                        log.warning(
                            "shared target already has %s; quarantining at %s",
                            rel / name, dest,
                        )
                    try:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(os.fspath(Path(root) / name), os.fspath(dest))
                    except OSError as err:
                        log.warning("migrating %s -> %s failed: %s", Path(root) / name, dest, err)
                        drained = False
            if not drained:
                log.warning("kept %s unshared: could not fully merge into %s", src, target)
                return False
            shutil.rmtree(src, ignore_errors=True)
            return True
        except OSError as err:
            log.warning("migrating dir %s -> %s failed: %s", src, target, err)
            return False

    def _link_shared(self, dst: Path, target: Path, *, is_dir: bool) -> None:
        """Point ``dst`` at the shared real-home ``target`` via symlink.

        Idempotent (refreshed on every spawn) and data-safe: an already-correct
        symlink is a no-op; a dangling/wrong symlink is repointed; a real
        dir/file left by an earlier whole-home-isolation build is migrated back
        into the real home first (see ``_migrate_dir``/``_migrate_file``) and,
        only if fully drained, replaced with the symlink. Every IO path is
        guarded — a failure only logs and lets the spawn proceed against the
        isolated home, never raising."""
        try:
            if dst.is_symlink():
                if os.readlink(dst) == os.fspath(target):
                    self._ensure_target_base(target, is_dir=is_dir)
                    return
                dst.unlink()  # stale/wrong link -> repoint
            elif dst.exists():
                migrated = (
                    self._migrate_dir(dst, target) if is_dir
                    else self._migrate_file(dst, target)
                )
                if not migrated:
                    return  # could not drain safely; leave unshared
            self._ensure_target_base(target, is_dir=is_dir)
            dst.symlink_to(target, target_is_directory=is_dir)
        except OSError as err:
            log.warning("shared-home link %s -> %s failed: %s", dst, target, err)

    def _seed_claude_profile_home(self, home: Path, creds: LiveCredentials) -> None:
        """Seed a claude persistent home from the slot so a pane run with
        ``CLAUDE_CONFIG_DIR=home`` is already signed in. macOS keeps the secret
        in the path-hashed Keychain item Claude Code reads under that config
        dir; elsewhere the ``.credentials.json`` file. Only the credential is
        isolated: sessions and settings are symlinked back to the real home so
        every account shares one session store (``creds.account`` is display
        info the slot's ``oauth-account.json`` already carries, so nothing is
        written into the shared ``.claude.json``)."""
        if creds.secret is not None:
            try:
                if self._is_macos:
                    service = legacy_claude_keychain_service(home)
                    # Idempotency: every restart re-seeds the profile home,
                    # and a redundant add-generic-password from a
                    # non-interactive child process can fail on macOS even
                    # though the stored secret is already current — skip the
                    # write when nothing changed. The lock serializes the
                    # check-then-write pair: a restore spawns several panes of
                    # one profile concurrently, and racing -U rewrites of the
                    # same item fail for every spawn but the first.
                    # Runtime-first: a home token the CLI refreshed past the
                    # slot snapshot must survive re-seeding (see
                    # _claude_home_secret_is_fresher).
                    with self._keychain_lock:
                        current = self._keychain_read(service)
                        if current != creds.secret and not _claude_home_secret_is_fresher(
                            current, creds.secret
                        ):
                            self._keychain_write(service, creds.secret)
                else:
                    current = _read_text(home / ".credentials.json")
                    if current != creds.secret and not _claude_home_secret_is_fresher(
                        current, creds.secret
                    ):
                        _write_private(home / ".credentials.json", creds.secret)
            except (CredentialVaultError, OSError) as err:
                # A failed credential seed must not skip the shared-home links
                # below — an unshared ``projects`` hides the real session
                # store from the pane and breaks resume for every session.
                # The pane can still sign in off whatever the item already
                # holds (the CLI refreshes it in place on its own).
                log.warning("claude profile home credential seed failed: %s", err)
        real_claude = self._real_home / ".claude"
        for name in ("projects", "todos", "shell-snapshots", "skills"):
            self._link_shared(home / name, real_claude / name, is_dir=True)
        self._link_shared(home / "settings.json", real_claude / "settings.json", is_dir=False)
        self._link_shared(home / ".claude.json", self._real_home / ".claude.json", is_dir=False)

    def _seed_codex_profile_home(self, home: Path, creds: LiveCredentials) -> None:
        """Seed a codex persistent home: the account's own ``auth.json`` plus
        symlinks to the real ``~/.codex`` config so profile panes keep the
        shared settings. ``home`` is then the CodexHomeManager source, whose
        per-pane home symlinks these entries in turn."""
        if creds.secret is not None:
            _write_private(home / "auth.json", creds.secret)
        real_codex = self._real_home / ".codex"
        for name in ("config.toml", "AGENTS.md", "skills", "plugins", "rules", "memories"):
            src = real_codex / name
            dst = home / name
            if not src.exists() or dst.exists() or dst.is_symlink():
                continue
            try:
                dst.symlink_to(src, target_is_directory=src.is_dir())
            except OSError as err:
                log.warning("codex profile-home symlink %s -> %s failed: %s", dst, src, err)
        # Session history is shared, not isolated: symlink it back to ~/.codex.
        self._link_shared(home / "sessions", real_codex / "sessions", is_dir=True)
        self._link_shared(home / "history.jsonl", real_codex / "history.jsonl", is_dir=False)

    def prepare_profile_home(self, agent_key: str, slot_id: str) -> ProfileHomePlan:
        """Create + seed the profile's persistent isolated home and return the
        spawn env pointing at it (mirrors the pre-refactor ``build_spawn_plan``,
        but the home persists and is seeded from the slot rather than harvested).
        Blocking I/O — call off the event loop."""
        if agent_key not in _SLOT_FILES:
            raise ValueError(f"unsupported agent for CLI profile homes: {agent_key!r}")
        home = self.profile_home_path(agent_key, slot_id)
        home.mkdir(parents=True, exist_ok=True)
        os.chmod(home, 0o700)  # umask-proof: the home holds live secrets
        home_str = canonical_path_str(home)
        creds = self.read_slot(agent_key, slot_id)
        if agent_key == "claude":
            self._seed_claude_profile_home(Path(home_str), creds)
            return ProfileHomePlan(
                env_set={"CLAUDE_CONFIG_DIR": home_str},
                env_remove=list(CLAUDE_ENV_OVERRIDES),
            )
        if agent_key == "codex":
            self._seed_codex_profile_home(Path(home_str), creds)
            # The per-pane CODEX_HOME mechanism stays; only its symlink source
            # switches from ~/.codex to this profile home.
            return ProfileHomePlan(codex_source_home=Path(home_str))
        if agent_key == "kimi":
            khome = Path(home_str)
            if creds.secret is not None:
                _write_private(khome / "credentials" / "kimi-code.json", creds.secret)
            real_kimi = self._real_home / ".kimi-code"
            # Sessions are shared: symlink back to ~/.kimi-code/sessions. Only
            # the credentials dir stays isolated; every other existing kimi
            # config entry is mirrored so settings follow the account too.
            self._link_shared(khome / "sessions", real_kimi / "sessions", is_dir=True)
            if real_kimi.is_dir():
                try:
                    entries = sorted(real_kimi.iterdir())
                except OSError as err:
                    log.warning("cannot list %s for kimi shim: %s", real_kimi, err)
                    entries = []
                for src in entries:
                    if src.name in ("credentials", "sessions"):
                        continue
                    self._link_shared(khome / src.name, src, is_dir=src.is_dir())
            return ProfileHomePlan(env_set={"KIMI_CODE_HOME": home_str})
        # grok: the persistent home IS the HOME shim; its .grok dir holds the db.
        shim = self._populate_grok_shim(Path(home_str))
        if creds.secret is not None:
            _write_private(shim / ".grok" / "auth.json", creds.secret)
        return ProfileHomePlan(env_set={"HOME": canonical_path_str(shim)})
