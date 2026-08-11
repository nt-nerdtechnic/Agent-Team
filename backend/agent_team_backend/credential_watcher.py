"""Filesystem watcher that keeps the "which account is active" ledger honest
when a CLI is signed in from outside Navide.

``cli_profiles_store.defaults[agentKey]`` is Navide's own bookkeeping: it only
ever moved when the user switched accounts through ``cli_profiles.set_default``.
Running ``claude /login`` (or ``codex login``, …) in a plain terminal rewrites
the live credentials behind the ledger's back, and every account row keeps
naming the old profile until the user notices.

Design (mirrors GitWatcher):

    CredentialWatcher.start()
        └─ observer (watchdog Observer)
            └─ one non-recursive handler per directory holding a live secret

The PARENT directory is watched, never the credential file itself: these files
are written with a tmp-file + ``os.replace``, so the inode a file watch is
bound to is thrown away on the first login. ``~/.claude.json`` is watched the
same way (from the home directory) because on macOS claude's secret lives in
the Keychain — that config file's ``oauthAccount`` block is the only on-disk
signal that the account changed.

That makes the event stream extremely noisy: ``~/.claude.json`` is Claude
Code's entire config, rewritten on every prompt. So a file event never
reconciles anything by itself — it only triggers an identity fingerprint read,
and the work below runs solely when the fingerprint differs from the last one
seen. Reconciliation never WRITES the live credentials: the live state already
belongs to whichever account the user signed into. Normally only the ledger
pointer is corrected; a login no profile holds at all also gets a profile of
its own, whose (empty by construction) slot is filled from the live snapshot.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from .cli_vendors.registry import VENDORS
from .credential_vault import DEFAULT_SLOT_ID, vault_to_thread
from .profiles_store import SUPPORTED_AGENT_KEYS

log = logging.getLogger("agent_team_backend.credential_watcher")

IdentitySink = Callable[[str], Awaitable[None]]

# Claude Code's config file in the real home. Its top-level ``oauthAccount``
# block is the account identity the vault reads (see
# ``CredentialVault.live_account``).
CLAUDE_CONFIG_FILENAME = ".claude.json"

# Sentinel for "no fingerprint recorded yet" — a signed-out agent is a
# legitimate reading, so no ordinary value can stand in for "never read".
_UNSEEN = object()


def _watch_targets(
    real_home: Path, agent_keys: tuple[str, ...]
) -> dict[Path, dict[str, str]]:
    """``{directory: {filename: agentKey}}`` — every directory to watch and the
    exact file names inside it that carry an account identity. Filtering on the
    name matters: the home directory and ``~/.claude`` churn constantly, and an
    unfiltered handler would read the Keychain on every unrelated write."""
    targets: dict[Path, dict[str, str]] = {}
    for agent_key in agent_keys:
        spec = VENDORS.get(agent_key)
        if spec is None or spec.live_file is None:
            continue
        live = real_home.joinpath(*spec.live_file)
        targets.setdefault(live.parent, {})[live.name] = agent_key
    if "claude" in agent_keys:
        targets.setdefault(real_home, {})[CLAUDE_CONFIG_FILENAME] = "claude"
    return targets


def live_identity_fingerprint(agent_key: str) -> object:
    """Who the live credentials currently belong to, cheap enough to read on
    every credential-file event.

    claude uses ``~/.claude.json``'s ``oauthAccount`` (email + account uuid) so
    the common case costs one file read instead of a Keychain ``security``
    subprocess. The other agents read their live secret's identity — a file
    read too; kimi has no identity field, so all it can report is whether a
    token exists. Blocking I/O: call through ``vault_to_thread``."""
    from . import app

    vault = app.credential_vault
    if agent_key == "claude":
        account = vault.live_account("claude") or {}
        return (account.get("emailAddress"), account.get("accountUuid"))
    identity = vault.identity(agent_key)
    return (identity.get("email"), bool(identity.get("signedIn")))


def _norm_email(value: object) -> str | None:
    return value.casefold() if isinstance(value, str) and value else None


def _match_live_slot(agent_key: str) -> tuple[str | None, str, str | None]:
    """``(live email, active slot id, matching slot id)`` for one agent.

    The live email is None whenever the account cannot be identified at all —
    signed out, kimi (no identity field), or a claude long-lived-token login
    that carries no ``oauthAccount``. Nothing is aligned in that case.

    The active slot is checked first so two slots holding the same login can
    never flip the ledger. An active slot whose snapshot carries no email is
    treated as matching: an empty ``__default__`` (the user never registered a
    profile) means "whatever unmanaged login lives in the real home", and
    reporting that as a foreign account would fire on every untouched install.

    Blocking reads (files, plus the Keychain for claude slots)."""
    from . import app

    vault = app.credential_vault
    live = vault.identity(agent_key)
    raw_email = live.get("email") if live.get("signedIn") else None
    email = _norm_email(raw_email)
    doc = app.cli_profiles_store.list()
    active = doc["defaults"].get(agent_key) or DEFAULT_SLOT_ID
    if email is None:
        return None, active, None
    slot_ids = [active] + [
        p["id"]
        for p in doc["profiles"]
        if p.get("agentKey") == agent_key and p.get("id") != active
    ]
    if DEFAULT_SLOT_ID not in slot_ids:
        slot_ids.append(DEFAULT_SLOT_ID)
    for slot_id in slot_ids:
        slot_email = _norm_email(vault.identity(agent_key, slot_id).get("email"))
        if slot_email == email or (slot_email is None and slot_id == active):
            return raw_email, active, slot_id
    return raw_email, active, None


def _adopt_unregistered_live_account(agent_key: str, email: str) -> str | None:
    """Give a live login no slot holds its own profile and make it the active
    one; returns the new profile id, or None when nothing was registered.

    Without this the ledger keeps naming some other account, and the next
    switch would capture this login into a slot that belongs to a different
    one. The live credentials are never written: ``harvest`` only fills the
    new slot — empty by construction — from the live state.

    That fill is mandatory. A registered profile with an empty slot is a logout
    trap: ``restore`` on it clears the live credentials. So a harvest that does
    not happen takes the profile back down with it rather than leave the trap
    behind. Every failure is contained here — the caller still broadcasts, and
    the account then shows up as an unregistered live login instead. Blocking;
    call inside ``switch_lock(agent_key)``."""
    from . import app

    store = app.cli_profiles_store
    vault = app.credential_vault
    try:
        profile = store.create(agent_key=agent_key, name=email)
    except Exception as err:  # noqa: BLE001 — a watcher must never crash
        log.warning("registering the live %s account failed: %s", agent_key, err)
        return None
    profile_id = str(profile["id"])
    registered = False
    try:
        if vault.harvest(agent_key, profile_id):
            store.set_default(agent_key, profile_id)
            registered = True
        else:
            log.warning("the live %s credentials could not be snapshotted", agent_key)
    except Exception as err:  # noqa: BLE001
        log.warning("registering the live %s account failed: %s", agent_key, err)
    if not registered:
        # Secrets first, then the store's archive-by-rename (the order
        # cli_profiles.delete uses — see delete_slot_secrets). Separate
        # attempts: failing to clean a secret must not leave the profile
        # itself registered, which is the half-done state that hurts.
        try:
            vault.delete_slot_secrets(agent_key, profile_id)
        except Exception as err:  # noqa: BLE001
            log.warning("cleaning up slot %s/%s failed: %s", agent_key, profile_id, err)
        try:
            store.delete(profile_id)
        except Exception as err:  # noqa: BLE001
            log.error("undoing profile %s for %s failed: %s", profile_id, agent_key, err)
        return None
    log.info(
        "live %s account %s was unregistered; registered it as profile %s",
        agent_key, email, profile_id,
    )
    return profile_id


def align_default_to_live(agent_key: str) -> str | None:
    """Point ``defaults[agent_key]`` at the slot whose snapshot matches the
    live credentials, registering a profile for the account when no slot holds
    it (see ``_adopt_unregistered_live_account``); returns the slot id when the
    pointer moved, else None.

    The live credentials are never captured, restored, swapped or cleared here —
    the live state is already the account the user signed into, and the only
    thing that can be wrong is which profile Navide believes that is. Call
    inside ``credential_vault.switch_lock(agent_key)`` so a manual
    ``cli_profiles.set_default`` cannot interleave. Blocking."""
    from . import app

    email, active, matched = _match_live_slot(agent_key)
    if matched is None:
        # An account nothing holds. Registering it needs an identity to name
        # it by, which is exactly what a None email says we do not have.
        return None if email is None else _adopt_unregistered_live_account(agent_key, email)
    if matched == active:
        return None
    app.cli_profiles_store.set_default(
        agent_key, None if matched == DEFAULT_SLOT_ID else matched
    )
    log.info(
        "active %s account realigned to slot %s (signed in outside Navide)",
        agent_key, matched,
    )
    return matched


def unregistered_live_accounts() -> dict[str, dict]:
    """``{agentKey: {"email", "signedIn"}}`` for every agent whose live login
    matches no registered slot — the user signed into an account Navide has
    never seen. Absent keys mean "the live login is accounted for" (or cannot
    be identified, which is not evidence of anything). Blocking."""
    out: dict[str, dict] = {}
    for agent_key in SUPPORTED_AGENT_KEYS:
        try:
            email, _active, matched = _match_live_slot(agent_key)
        except Exception as err:  # noqa: BLE001 — display-only, never fatal
            log.warning("live %s identity lookup failed: %s", agent_key, err)
            continue
        if email is not None and matched is None:
            out[agent_key] = {"email": email, "signedIn": True}
    return out


async def reconcile_live_account(agent_key: str) -> None:
    """CredentialWatcher sink: this agent's live credentials now belong to a
    different account than when we last looked.

    ``forced`` stays False in the broadcast — a forced ``cli_profiles.changed``
    makes every window restart its panes of that agent, which is only correct
    when the credentials were swapped underneath them. Nothing was swapped
    here, so restarting would interrupt the user for nothing. The switch is
    likewise not counted against the account-switch rate limit: that budget
    exists to keep switching a manual action, and this is not a switch."""
    from . import app
    from .ws_handlers import _broadcast_profiles_changed

    try:
        async with app.credential_vault.switch_lock(agent_key):
            await vault_to_thread(align_default_to_live, agent_key)
    except Exception as err:  # noqa: BLE001 — a watcher must never crash the loop
        log.warning("reconciling the active %s account failed: %s", agent_key, err)
        return
    await _broadcast_profiles_changed(
        "live_credentials", agent_key=agent_key, forced=False
    )
    # The usage badges read the active account's credentials — pull them now so
    # the badge follows the account the user just signed into.
    from .usage_service import service

    service.request_refresh()


class _CredentialDirHandler(FileSystemEventHandler):
    """watchdog handler bound to one directory. Reacts only to the exact file
    names that hold an account identity, and reports which agent they belong
    to."""

    def __init__(self, files: dict[str, str], on_touched: Callable[[str], None]) -> None:
        super().__init__()
        self._files = files
        self._on_touched = on_touched

    def on_any_event(self, event: FileSystemEvent) -> None:
        # `closed`/`opened` carry no state change. A `moved` event is the
        # interesting one: these files are replaced from a tmp file, so the
        # destination path is what names the credential.
        if event.event_type in ("opened", "closed"):
            return
        for raw in (event.src_path, getattr(event, "dest_path", "")):
            if not raw:
                continue
            agent_key = self._files.get(os.path.basename(str(raw)))
            if agent_key is not None:
                self._on_touched(agent_key)


class CredentialWatcher:
    """One Observer over the live credential locations of every profile-capable
    agent. Debounced file events read the account fingerprint; only a genuine
    change calls ``on_identity_change(agent_key)``."""

    def __init__(
        self,
        on_identity_change: IdentitySink,
        *,
        real_home: Path | None = None,
        agent_keys: tuple[str, ...] = SUPPORTED_AGENT_KEYS,
        fingerprint: Callable[[str], object] = live_identity_fingerprint,
        debounce_s: float = 0.8,
    ) -> None:
        self._on_identity_change = on_identity_change
        self._real_home = Path(real_home or Path.home())
        self._agent_keys = agent_keys
        self._fingerprint = fingerprint
        self._debounce_s = debounce_s
        self._loop: asyncio.AbstractEventLoop | None = None
        self._observer: Observer | None = None
        self._fingerprints: dict[str, object] = {}
        self._pending: dict[str, asyncio.TimerHandle] = {}
        self._seed_task: asyncio.Task | None = None
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._loop = asyncio.get_event_loop()
        self._observer = Observer()
        self._observer.start()
        watched = 0
        for directory, files in _watch_targets(self._real_home, self._agent_keys).items():
            # A missing directory means that CLI was never installed or never
            # signed in. It must never fail startup, and it cannot hold a
            # credential to miss.
            if not directory.is_dir():
                continue
            handler = _CredentialDirHandler(files, self._mark_touched_threadsafe)
            try:
                self._observer.schedule(handler, str(directory), recursive=False)
            except Exception as err:  # noqa: BLE001
                log.warning("CredentialWatcher schedule on %s failed: %s", directory, err)
                continue
            watched += 1
        self._seed_task = asyncio.ensure_future(self._seed())
        log.info(
            "CredentialWatcher started (%d dirs, debounce %.0fms)",
            watched, self._debounce_s * 1000,
        )

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        if self._seed_task is not None:
            self._seed_task.cancel()
            self._seed_task = None
        for th in self._pending.values():
            th.cancel()
        self._pending.clear()
        if self._observer:
            self._observer.stop()
            try:
                self._observer.join(timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
        log.info("CredentialWatcher stopped")

    async def _seed(self) -> None:
        """Record each agent's identity as it is at startup, off the loop.

        Without this the first credential-file event of the process — which
        Claude Code produces within seconds just by writing its config — has
        nothing to compare against and would reconcile and broadcast for a
        change that never happened. An event that gets there first wins: its
        reading is the newer one."""
        for agent_key in self._agent_keys:
            if agent_key in self._fingerprints:
                continue
            try:
                fp = await vault_to_thread(self._fingerprint, agent_key)
            except Exception as err:  # noqa: BLE001
                log.warning("seeding the live %s identity failed: %s", agent_key, err)
                continue
            self._fingerprints.setdefault(agent_key, fp)

    # ───────────────────────── debounce (loop thread) ─────────────────────

    def _mark_touched_threadsafe(self, agent_key: str) -> None:
        """Called from the watchdog observer thread → hop to the loop thread."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._schedule_fire, agent_key)
        except RuntimeError:
            pass  # loop closed mid-flight

    def _schedule_fire(self, agent_key: str) -> None:
        loop = self._loop
        if loop is None:
            return
        existing = self._pending.get(agent_key)
        if existing is not None:
            existing.cancel()
        self._pending[agent_key] = loop.call_later(
            self._debounce_s, self._fire, agent_key
        )

    def _fire(self, agent_key: str) -> None:
        self._pending.pop(agent_key, None)
        asyncio.ensure_future(self._check(agent_key))

    async def _check(self, agent_key: str) -> None:
        """The de-noising gate: read who the live credentials belong to and do
        nothing unless that differs from the last reading."""
        try:
            fp = await vault_to_thread(self._fingerprint, agent_key)
        except Exception as err:  # noqa: BLE001
            log.warning("reading the live %s identity failed: %s", agent_key, err)
            return
        if self._fingerprints.get(agent_key, _UNSEEN) == fp:
            return
        self._fingerprints[agent_key] = fp
        await self._on_identity_change(agent_key)
