"""Control-plane link to Navide-Server: this machine's pane roster, published.

The backend is the *client* here. It dials out to a Navide-Server the user
configured, authenticates with a long-lived access token, and reports the CLI
panes it knows about so agents on other devices can address them. Nothing
listens for inbound connections — ``/ws`` stays loopback only — so this file
adds no reachable surface beyond one outbound WebSocket.

**One link per backend process, not per workspace.** The backend is the only
process that sees every open workspace at once, and ``agent_messaging._PANES``
is already process-wide, so a single connection carries the roster of all of
them. A per-workspace connection would multiply the server's device rows for
one machine and break the "device" identity the whole addressing scheme rests
on.

Wire protocol (agreed with Navide-Server)::

    request   {id, type, payload}
    response  {id, type: "<type>.result", ok, payload|error}
    event     {type, payload}            server push, no id

**Transient and terminal failures take different paths, on purpose.** A dropped
socket is transient: reconnect with backoff, re-send ``auth.hello`` (the server
upserts on the same deviceId) and re-report the whole roster — the same shape
the renderer already uses when it re-runs ``agent_msg.register`` after a WS
reconnect. A rejected or revoked credential is terminal: the answer cannot
change by asking again, so the link stops for good and says why. Running a
revoked account through the reconnect backoff would knock on the server's door
every 30 seconds forever while the user sees nothing at all.

**Delivery reuses the on-machine path rather than duplicating it.** A message
relayed in from another device is broadcast as the same ``agent_msg.deliver``
event a local ``cli_send`` produces, so the receiving window's idle gate, rate
limit, queue cap and message log all apply unchanged; this module only adds the
receiver-side policy check the on-machine path does not need, and translates the
window's ``agent_msg.delivered`` verdict back into ``messages.ack``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import platform
import time
from dataclasses import dataclass
from typing import Any, Callable

import websockets

from . import (
    agent_messaging,
    device_crypto,
    device_identity,
    device_signing,
    device_trust,
    pane_policy,
    remote_roster,
    trust_store,
)

log = logging.getLogger("agent_team_backend.server_link")

#: ui_settings key holding the Navide-Server WebSocket URL (e.g.
#: ``ws://localhost:8787/ws``). Empty or absent means "no server configured",
#: which keeps this whole module inert. It lives in ui_settings rather than a
#: private store so the Settings UI can write it through the existing
#: ``ui.settings.set`` handler without new plumbing.
# The one address every install talks to. Hard-coded on purpose: the server is
# a service this product operates, not a field each user configures — a typo'd
# address produced a link that silently never dialled, and there was no correct
# value for the user to discover on their own.
#
# NAVIDE_SERVER_URL overrides it for local development (point at ws://localhost:8787/ws)
# and for the verification scripts. Nothing in the UI writes it.
DEFAULT_SERVER_URL = "wss://server.navide.dev/ws"
SERVER_URL_ENV = "NAVIDE_SERVER_URL"

# Kept only so an install carrying the old user-entered address can have it
# ignored and cleared; nothing reads it as a source any more.
SERVER_URL_SETTING = "agentTeam.p2p.serverUrl"
# The signed-in email, kept in plain ui_settings rather than the vault: it is
# not a credential, and the Settings pane needs it to say *which* account is
# connected. The token it was exchanged for is the secret, and that stays in
# the vault.
ACCOUNT_EMAIL_SETTING = "agentTeam.p2p.accountEmail"

#: Vault secret name for the access token. It is a *long-lived* credential —
#: the server neither expires nor rotates it, the only way it stops working is
#: an admin revoking it — so it is stored once and read back, never refreshed.
ACCESS_TOKEN_SECRET = "navide-server-token"

#: Reported in ``auth.hello`` so the server can tell client kinds apart.
CLIENT_NAME = "navide-desktop"

#: Reconnect backoff, matching the renderer's own WS client ceiling
#: (``reconnectMaxMs`` in src/shared/wsClient.ts) so a network blip is ridden
#: out on the same timescale everywhere.
RECONNECT_BASE_S = 1.0
RECONNECT_MAX_S = 30.0

#: How long a request may wait for its ``.result`` frame.
REQUEST_TIMEOUT_S = 20.0

#: Roster changes arrive as nudges (see ``roster_changed``), but two of the
#: registry's mutations have no handler behind them: ``drop_owner`` flags panes
#: offline and ``purge_expired`` forgets them lazily, from whatever read path
#: happens to run next. So the reporter also re-scans on this interval rather
#: than trusting the nudges to be complete.
ROSTER_SWEEP_S = 30.0

#: Coalescing pause after a report. A window reconnecting re-registers every
#: pane it mirrors, which would otherwise be one upsert per pane per nudge.
ROSTER_DEBOUNCE_S = 0.5

#: The fallback vocabulary, used only when the owning window has not reported a
#: badge word — see ``_pane_status``. It used to be the *whole* vocabulary: the
#: enum ``sessions.upsert`` enforces had four values, so the seven states a
#: sidebar can show were renamed down into two here, and a pane whose CLI had
#: died was published as "waiting". The enum is wider now and the badge word is
#: passed through, which leaves these three as the answer to a smaller question:
#: what to say when all we know is the delivery flag. Mid-turn is "running",
#: anything else is "waiting", and a pane whose window has disconnected is
#: "disconnected" — transient, not
#: terminal. That distinction is the remote half of the local target-offline
#: code: the pane is still there and expected back once its window reconnects.
#: Reporting it as "waiting" would be indistinguishable from a healthy idle
#: pane, and "exited" would claim the session ended when it has not. A restore
#: placeholder is the second thing "disconnected" covers — see _pane_status.
STATUS_BUSY = "running"
STATUS_IDLE = "waiting"
STATUS_OFFLINE = "disconnected"

#: Local-only, and deliberately outside the four values above: the contract's
#: enum has no word for "restored but never opened", and inventing one the
#: server would reject with BAD_REQUEST is how a pane disappears from the
#: roster entirely. It is substituted into this device's own rows in
#: ``network_snapshot`` and never sent anywhere. The wording matches the
#: sidebar's ``paneStatus.waiting`` ("not opened") on purpose — the same pane
#: must not be called two different things in two places.
STATUS_NOT_OPENED = "not-opened"

#: Bounds on the inbound-message bookkeeping below. Same shape as the MCP
#: server's ``_mcp_message_status``: a count cap plus a TTL, because nothing
#: outlives the process and an unbounded map fed by a remote peer is a leak
#: with a sender attached to it.
MESSAGE_MEMORY_MAX = 500
MESSAGE_MEMORY_TTL_S = 3600.0

#: Error codes this module answers ``send_message`` with when a server *is*
#: configured but the message cannot leave this machine. They are deliberately
#: not server codes — the request never reached one — and they exist so that a
#: connection state cannot be mistaken for a bad address. Without them the
#: caller falls back to the "unknown device" answer it gives when no server is
#: configured at all, which reads as "you typed the wrong machine" for what is
#: really "the link is down, try again in a moment".
#:
#: LINK_OFFLINE is transient (the reconnect loop is working on it);
#: LINK_UNAUTHORIZED is terminal (the credential was rejected or revoked, and
#: retrying can only produce the same answer until the user signs in again).
#: Answered when a message could not be sealed for a peer that has published a
#: key before. Deliberately a link-level code and not a server one: the message
#: never left this machine, and the caller must not read it as "the far end
#: refused" — nothing over there has heard of it.
#: Where the receiver's own signature over its own policy lives. Inside the
#: document rather than beside it, so the server's contract is unchanged: it
#: still stores one opaque JSON object verbatim and still never interprets it.
POLICY_SIGNATURE_FIELD = "_sig"

LINK_ENCRYPTION_FAILED = "p2p-encryption-failed"
#: Refused because this machine cannot read its own trust record. Distinct from
#: an encryption failure: nothing is wrong with the message, this machine is
#: simply not in a state where it can tell one sender from another.
LINK_TRUST_UNAVAILABLE = "p2p-trust-unavailable"

#: The one word every unauthenticated inbound message is refused with. Kept
#: single on purpose, exactly as "policy-denied" covers both blocked and merely
#: unauthorized: telling a sender *which* of "no signature", "unknown key" and
#: "wrong key" applied would let the relay map out this machine's pin table.
REASON_UNAUTHENTICATED = "unauthenticated"
#: The field of a message the signature covers. Signed alongside the digest so
#: a ciphertext cannot be re-presented as plaintext under a valid signature.
BODY_CIPHER = "cipher"
BODY_TEXT = "text"
LINK_OFFLINE = "LINK_OFFLINE"
LINK_UNAUTHORIZED = "LINK_UNAUTHORIZED"

#: What the Settings UI shows for the link. These exist because "I saved a URL
#: and a token, is it working?" is otherwise unanswerable from the frontend: a
#: wrong URL and a rejected token both end with no messages getting through, but
#: only one of them is worth retyping the token for. UNREACHABLE is transient
#: (the reconnect loop keeps trying), UNAUTHORIZED is terminal.
STATE_UNCONFIGURED = "unconfigured"
STATE_CONNECTING = "connecting"
STATE_CONNECTED = "connected"
STATE_UNREACHABLE = "unreachable"
STATE_UNAUTHORIZED = "unauthorized"


class ServerLinkTerminated(RuntimeError):
    """A failure that would answer the same way on every retry."""


@dataclass(frozen=True)
class ServerLinkConfig:
    url: str = ""
    token: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.url and self.token)


# ---- configuration ----------------------------------------------------------


def _vault():
    # The app-wide singleton, imported late to avoid an import cycle (app
    # imports this module). Tests swap it wholesale, so reading it through app
    # is also what keeps them off the real Keychain.
    from . import app

    return app.credential_vault


def server_url() -> str:
    """The address this install connects to: the built-in one unless overridden.

    A previously stored per-user address is deliberately NOT consulted — an
    install upgrading from the configurable era must move to the real service,
    not keep dialling whatever was typed in months ago.
    """
    override = os.environ.get(SERVER_URL_ENV, "")
    return override.strip() or DEFAULT_SERVER_URL


def account_email() -> str:
    from . import app

    value = app.ui_settings_store.get().get(ACCOUNT_EMAIL_SETTING)
    return value.strip() if isinstance(value, str) else ""


def access_token() -> str:
    return (_vault().read_app_secret(ACCESS_TOKEN_SECRET) or "").strip()


def set_access_token(token: str | None) -> None:
    """Store the Navide-Server access token, or erase it when None/empty."""
    value = (token or "").strip()
    _vault().write_app_secret(ACCESS_TOKEN_SECRET, value or None)


def load_config() -> ServerLinkConfig:
    """Read the link's configuration. Blocking (Keychain); call off the loop.

    An unreadable setting or Keychain answers "not configured" rather than
    raising: a broken cross-device config must never keep the backend from
    starting, and on-machine messaging does not depend on any of this.
    """
    try:
        return ServerLinkConfig(url=server_url(), token=access_token())
    except Exception as err:  # noqa: BLE001
        log.warning("navide-server link configuration is unreadable: %s", err)
        return ServerLinkConfig()


# ---- roster payloads --------------------------------------------------------


def _pane_status(entry: agent_messaging.RegisteredPane) -> str:
    if entry.offline:
        return STATUS_OFFLINE
    # A restore placeholder is neither of the other two: "running" claims an
    # agent is working, "waiting" claims a message sent now would be picked up,
    # and no CLI has been started behind it for either to be true. Its `busy`
    # flag says true — the window reports every pane it cannot inject into as
    # busy, which is the right answer for delivery and the wrong one for a
    # status word — so the flag is deliberately not consulted here.
    #
    # That mismatch used to apply to every pane, not just placeholders: `busy`
    # was the *only* signal this function had, so seven sidebar states collapsed
    # into two words and a crashed pane read as "waiting" — the one word that
    # promises a message would be picked up. `display_status` is the window's
    # own badge word, reported alongside `busy` for exactly this.
    if not entry.realized:
        return STATUS_OFFLINE
    # The window's own badge word, when it reported one. Passed through rather
    # than re-derived: the whole point is that the same pane is called the same
    # thing here and in the sidebar, and any mapping in between is a second
    # place for the two to drift apart.
    if entry.display_status:
        return entry.display_status
    # Nothing reported yet — a window that has not finished its first tick, or
    # an older build that only knows `busy`. Deliberately still the legacy word:
    # "waiting" here means "we only know the delivery flag", which is a smaller
    # claim than "idle" and is the honest one to make.
    return STATUS_BUSY if entry.busy else STATUS_IDLE


def _session_payload(entry: agent_messaging.RegisteredPane) -> dict[str, Any]:
    """One pane as ``sessions.upsert`` wants it.

    ``deviceId`` is deliberately absent: the server takes it from the
    authenticated connection, and sending our own would let a client claim
    another device's sessions. ``workspace`` is the device-local folder
    basename used in ``<workspace>/<pane>`` addresses, ``workspacePath`` the
    absolute path — the first is what a remote agent types, the second what a
    human recognises.
    """
    return {
        "title": entry.name,
        "agentKey": entry.agent_key,
        "status": _pane_status(entry),
        # No task concept exists on this side yet; the field is part of the
        # agreed request shape, so it is sent empty rather than omitted.
        "taskId": "",
        "workspacePath": entry.workspace_path,
        "workspace": entry.workspace_label,
        "paneId": entry.pane_id,
    }


def _reason_key(reason: str) -> str:
    """The renderer encodes its delivery reason as JSON (``{"key": ...}``); the
    ack carries the key alone.

    The server stores ``reason`` verbatim and never interprets it, so the keys
    forwarded here are exactly the ones a sender already reads back from
    ``cli_check_message`` on one machine — "rate-limit", "queue-full",
    "inject-failed", "pane-closed". Translating them into a second vocabulary
    would give the same failure two names.
    """
    try:
        parsed = json.loads(reason)
    except (TypeError, ValueError):
        return reason
    if isinstance(parsed, dict) and isinstance(parsed.get("key"), str):
        return parsed["key"]
    return reason


async def _quiet(task: asyncio.Task) -> None:
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task


class ServerLink:
    """One outbound connection: authenticate, then keep the roster published."""

    def __init__(
        self,
        *,
        connect: Callable[..., Any] | None = None,
        config_loader: Callable[[], ServerLinkConfig] | None = None,
        token_clearer: Callable[[], None] | None = None,
        device_name: str | None = None,
    ) -> None:
        self._connect = connect or websockets.connect
        self._load_config = config_loader or load_config
        self._clear_token = token_clearer or (lambda: set_access_token(None))
        self._device_name = device_name or platform.node() or "unknown"
        self._task: asyncio.Task | None = None
        self._stopped = False
        self._ws: Any = None
        # A socket exists *and* auth.hello was accepted on it. Tracked apart
        # from _ws because the gap between the two is a real state: a request
        # written into it is answered AUTH_REQUIRED, which would surface to the
        # sender as a server refusal rather than "not connected yet".
        self._authenticated = False
        self._next_id = 0
        self._pending: dict[str, asyncio.Future] = {}
        # Single-writer discipline, same as the renderer-facing socket: the
        # websockets protocol forbids concurrent writes on one connection.
        self._send_lock = asyncio.Lock()
        self._roster_dirty = asyncio.Event()
        # pane_id -> the payload last accepted by the server, so an unchanged
        # pane is not re-sent on every sweep.
        self._reported: dict[str, dict[str, Any]] = {}
        # pane_id -> server-issued sessionId, kept across reconnects so an
        # update lands on the same session row instead of minting a new one.
        # Purely an optimisation: the server falls back to (deviceId, paneId),
        # so losing this map costs one extra id lookup, never a duplicate row.
        self._session_ids: dict[str, str] = {}
        # Whether this connection has already sent its full-roster sessions.sync.
        self._synced = False
        # msgKey -> {created_at, pane_id, acked} for every message relayed in
        # from another device. Presence *is* the dedupe set: the server pushes
        # messages.pending to every connection it holds for this device, and a
        # backend restart can briefly leave two open, so the same message can
        # arrive twice. Keyed on msgKey rather than inferred from timestamps —
        # a timestamp that fails to parse falls through and injects twice.
        self._inbound: dict[str, dict[str, Any]] = {}
        # Receiver-side pane policy, cached with the revision it came at. None
        # means "never fetched"; the cache is deliberately kept across
        # reconnects so an authorization decision does not depend on the
        # control plane being reachable at the moment a message lands.
        self._policy: Any = None
        self._policy_revision: int | None = None
        # Who knocked and was refused. In memory only: a knock is a prompt for
        # a person sitting there now, not a record to keep, and persisting it
        # would mean deciding where — the policy document belongs to the
        # server, and this is nobody's business but this machine's.
        self._access_requests = device_trust.AccessRequests()
        # Devices this link has ever sealed a message for now live in
        # ``trust_store``, which outlives the process. Held here it was a
        # promise that expired on every backend restart — and a restart is a
        # daily event, not something the relay had to arrange.
        #
        # Why cross-device traffic is refused outright, when it is. See
        # ``trust_store``: an initialised machine whose trust record cannot be
        # read has lost its pins, its policy high-water mark and its
        # no-downgrade list at once, and every one of those fails *silently* if
        # the answer is to start over.
        self._trust_locked = ""
        # The member id pinned for *this link's* credential. Never the one the
        # last auth.hello asserted: that is the value C1 moved.
        self._own_member = ""
        self._tasks: set[asyncio.Task] = set()
        self._device_id = ""
        self.member_id = ""
        # The role auth.hello granted this member: "admin", "member" or
        self.display_name = ""
        # Whether the account's e-mail address has been confirmed, from
        # auth.hello. A soft gate: an unverified account signs in and works
        # normally, it is only flagged (and may not invite anyone). Refreshed
        # on every reconnect and by a resend reply, because the confirming
        # click happens in a browser this process never sees.
        self.email_verified = False
        # The whole session directory as the server last described it, this
        # device's own rows included. ``remote_roster`` deliberately drops the
        # local ones — an address aimed back at this machine has to resolve
        # against the live local roster — but the account modal's network view
        # has to show the machine the user is sitting at beside the others, so
        # the raw rows are kept here as well. None means "never received one",
        # which an empty directory must not be confused with.
        self._directory: list[dict[str, Any]] | None = None
        # Device ids the server last reported online, or None while no
        # presence.changed has arrived. Kept apart from the per-session
        # ``hostOnline`` flag because the two facts arrive on different events
        # (see ``_on_presence_changed``), and because a device with no sessions
        # at all has no row to carry that flag.
        self._online_devices: set[str] | None = None
        self.terminated_reason = ""
        # Why the last dial or session failed, kept so `state()` can tell a
        # server that is not answering apart from one that has not been tried
        # yet. Cleared the moment a connection authenticates.
        self.last_error = ""

    # ---- lifecycle ----

    async def start(self) -> bool:
        """Dial the server if one is configured.

        Returns False — having done nothing whatsoever, no task, no socket, no
        timer — when there is no URL or no token. "Not set up" has to be
        indistinguishable from "this feature does not exist" for everyone still
        using Navide on one machine.
        """
        config = await asyncio.to_thread(self._load_config)
        if not config.configured:
            log.debug("navide-server link is not configured; staying offline")
            return False
        self._stopped = False
        self._task = asyncio.create_task(self._run())
        return True

    async def stop(self) -> None:
        self._stopped = True
        task = self._task
        self._task = None
        for spawned in list(self._tasks):
            spawned.cancel()
            await _quiet(spawned)
        if task is not None:
            task.cancel()
            await _quiet(task)

    def _spawn(self, coro: Any) -> None:
        """Run a coroutine off the read loop.

        Anything that issues a request has to leave the read loop free: the
        reply it waits for is read *by* that loop, so awaiting inline while
        handling a server push deadlocks the connection until the timeout.
        """
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def notify_roster_changed(self) -> None:
        """Ask the reporter to diff the roster. Cheap and idempotent."""
        self._roster_dirty.set()

    def state(self) -> str:
        """One of the STATE_* values, for the Settings UI.

        Order matters: a terminated link still holds whatever the last socket
        error was, and "your token was rejected" is the answer the user has to
        act on.
        """
        if self.terminated_reason:
            return STATE_UNAUTHORIZED
        if self._authenticated:
            return STATE_CONNECTED
        if self.last_error:
            return STATE_UNREACHABLE
        return STATE_CONNECTING

    # ---- connection loop ----

    async def _run(self) -> None:
        delay = RECONNECT_BASE_S
        while not self._stopped:
            config = await asyncio.to_thread(self._load_config)
            if not config.configured:
                log.info(
                    "navide-server link stopping: the server URL or access token "
                    "is no longer configured"
                )
                # The remote roster was this server's answer to "who else is
                # out there"; with no server, there is no one else.
                remote_roster.clear()
                return
            try:
                authenticated = await self._session(config)
            except asyncio.CancelledError:
                raise
            except ServerLinkTerminated as err:
                self.terminated_reason = str(err)
                log.error("navide-server link stopped for good: %s", err)
                return
            except Exception as err:  # noqa: BLE001
                authenticated = False
                self.last_error = str(err) or type(err).__name__
                log.warning("navide-server link failed (%s)", err)
            if self.terminated_reason:
                # Set by a server push (auth.revoked) rather than raised.
                log.error("navide-server link stopped for good: %s", self.terminated_reason)
                return
            if self._stopped:
                return
            if authenticated:
                # A link that lived long enough to authenticate is not the case
                # the backoff exists to damp; start over from the short delay.
                delay = RECONNECT_BASE_S
            log.info("navide-server link retrying in %.0fs", delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_S)

    async def _session(self, config: ServerLinkConfig) -> bool:
        """One connection, from dial to close. Returns whether it authenticated."""
        authenticated = False
        async with self._connect(config.url) as ws:
            self._ws = ws
            reader = asyncio.create_task(self._read_loop(ws))
            try:
                await self._authenticate(config)
                authenticated = True
                self._authenticated = True
                self.last_error = ""
                # A fresh connection knows nothing about what this backend told
                # the previous one, so the whole roster is flattened again.
                self._reported.clear()
                self._synced = False
                self._roster_dirty.set()
                # Any policy.changed pushed while this device was away was
                # missed, so the cached revision cannot be trusted after a
                # reconnect. One fetch per connection, not per message.
                await self._refresh_policy()
                # Same reasoning for the other direction's roster: every
                # sessions.changed pushed while this device was away was missed,
                # so the cache is realigned from a full directory read once per
                # connection and kept current by the push after that.
                await self._refresh_directory()
                reporter = asyncio.create_task(self._report_loop())
                try:
                    done, _ = await asyncio.wait(
                        {reader, reporter}, return_when=asyncio.FIRST_COMPLETED
                    )
                    for finished in done:
                        finished.result()
                finally:
                    reporter.cancel()
                    await _quiet(reporter)
            finally:
                reader.cancel()
                await _quiet(reader)
                self._ws = None
                self._authenticated = False
                self._fail_pending(ConnectionError("navide-server link closed"))
        return authenticated

    async def _read_loop(self, ws: Any) -> None:
        try:
            async for raw in ws:
                await self._handle(raw)
        finally:
            self._fail_pending(ConnectionError("navide-server connection closed"))

    async def _handle(self, raw: Any) -> None:
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            log.warning("navide-server sent a frame that is not JSON; ignoring it")
            return
        if not isinstance(message, dict):
            return
        msg_id = str(message.get("id") or "")
        future = self._pending.pop(msg_id, None) if msg_id else None
        if future is not None:
            if not future.done():
                future.set_result(message)
            return
        msg_type = str(message.get("type") or "")
        if msg_type == "auth.revoked":
            await self._on_revoked(message.get("payload"))
            return
        if msg_type == "messages.pending":
            self._spawn(self._on_message_pending(message.get("payload")))
            return
        if msg_type == "messages.acked":
            self._on_message_acked(message.get("payload"))
            return
        if msg_type == "policy.changed":
            self._spawn(self._on_policy_changed(message.get("payload")))
            return
        if msg_type == "sessions.changed":
            # Carries the whole directory, so it needs no follow-up request and
            # is applied inline rather than off the read loop.
            self._apply_directory(message.get("payload"))
            return
        if msg_type == "presence.changed":
            self._on_presence_changed(message.get("payload"))
            return
        log.debug("navide-server event %r is not wired yet; ignoring it", msg_type)

    async def _on_revoked(self, payload: Any) -> None:
        """The server withdrew this member's access mid-connection.

        Terminal, not a failed attempt: the connection has already dropped back
        to unauthenticated and every later request answers AUTH_REQUIRED. So the
        stored token goes (it can never work again), the reason is logged where
        a user can find it, and the reconnect loop stops instead of retrying a
        credential that has been taken away.
        """
        data = payload if isinstance(payload, dict) else {}
        reason = str(data.get("reason") or "no reason given")
        member = str(data.get("memberId") or "unknown")
        self.terminated_reason = f"access revoked for member {member}: {reason}"
        log.error(
            "navide-server revoked this device's access (member %s): %s — the stored "
            "access token has been cleared; sign in again to reconnect",
            member,
            reason,
        )
        try:
            await asyncio.to_thread(self._clear_token)
        except Exception as err:  # noqa: BLE001
            log.warning("clearing the navide-server access token failed: %s", err)
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

    # ---- requests ----

    def _fail_pending(self, error: BaseException) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _send_frame(self, frame: dict[str, Any]) -> None:
        """The only place this module writes to the socket (see _send_lock)."""
        ws = self._ws
        if ws is None:
            raise ConnectionError("navide-server link is not connected")
        async with self._send_lock:
            await ws.send(json.dumps(frame))

    async def _request(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._next_id += 1
        msg_id = str(self._next_id)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = future
        try:
            await self._send_frame({"id": msg_id, "type": msg_type, "payload": payload})
            reply = await asyncio.wait_for(future, REQUEST_TIMEOUT_S)
        finally:
            self._pending.pop(msg_id, None)
        return reply if isinstance(reply, dict) else {}

    async def _authenticate(self, config: ServerLinkConfig) -> None:
        self._device_id = await asyncio.to_thread(device_identity.device_id)
        reply = await self._request(
            "auth.hello",
            {
                "credential": config.token,
                "client": CLIENT_NAME,
                "deviceId": self._device_id,
                "deviceName": self._device_name,
                # Published on every hello, not only the first: the server keeps
                # the last key it was told, and a build that stopped sending one
                # would leave peers encrypting to a key this machine no longer
                # holds. Cheap to re-send, expensive to get wrong.
                "publicKey": await asyncio.to_thread(device_crypto.public_key),
                # The signing half, published on the same channel and for the
                # same reason. What the server does with it is distribute a
                # *candidate*: peers pin the first one they verify a message
                # against and stop reading this field afterwards.
                "signPublicKey": await asyncio.to_thread(device_signing.public_key),
            },
        )
        if not reply.get("ok"):
            error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
            code = str(error.get("code") or "AUTH_FAILED")
            detail = str(error.get("message") or "")
            # Every auth.hello rejection is terminal. AUTH_REJECTED means the
            # credential is invalid or disabled, BAD_REQUEST means this build
            # sent a malformed deviceId, DEVICE_CONFLICT means the id belongs to
            # another member — none of the three resolves by asking again, and
            # retrying turns a fixable error into a silent one.
            raise ServerLinkTerminated(
                f"auth.hello was rejected ({code})" + (f": {detail}" if detail else "")
            )
        payload = reply.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        await self._adopt_member(config, str(payload.get("memberId") or ""))
        self.display_name = str(payload.get("displayName") or "")
        self.email_verified = bool(payload.get("emailVerified"))
        log.info(
            "navide-server link authenticated as member %s (%s) for device %s",
            self.member_id or "unknown",
            payload.get("displayName") or "",
            payload.get("deviceId") or "",
        )

    async def _adopt_member(self, config: ServerLinkConfig, claimed: str) -> None:
        """Settle who this machine is, from the pin rather than from the reply.

        ``auth.hello`` answers with a member id and that answer used to *be*
        this machine's identity, which made it the anchor a relay could move:
        name any id, then push a message whose ``from.memberId`` is the same id,
        and the delivery path read it as one of the user's own machines and
        skipped the policy. Pinning it per credential leaves the server able to
        say it once and never able to change its mind.

        The claimed id is still kept on ``member_id`` when the store cannot
        answer, because the Settings pane shows it and a blank there reads as
        "not signed in". It is not what any trust decision reads — see
        ``_own_device``, which consults the pin.
        """
        self.member_id = claimed
        self._own_member = ""
        try:
            self.member_id = await asyncio.to_thread(
                trust_store.adopt_own_member, config.url, config.token, claimed
            )
            # Held on the link rather than read back from the store: the pin is
            # per credential, and the store may hold several. Blank until a pin
            # is settled, which is what keeps `_own_device` from ever answering
            # yes on a machine whose identity is in doubt.
            self._own_member = self.member_id
            self._trust_locked = ""
        except trust_store.TrustStoreLocked as err:
            # The link stays up: the account view, the roster and the team
            # management calls do not depend on any of this, and dropping the
            # connection would hide the reason. Message traffic is what stops.
            self._trust_locked = str(err)
            log.error("cross-device traffic is refused on this machine: %s", err)
            await self._announce_trust_notices()
        except Exception as err:  # noqa: BLE001
            self._trust_locked = f"the device trust store could not be opened ({err})"
            log.error("cross-device traffic is refused on this machine: %s", err)
            await self._announce_trust_notices()

    # ---- roster reporting ----

    async def _report_loop(self) -> None:
        while True:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._roster_dirty.wait(), ROSTER_SWEEP_S)
            self._roster_dirty.clear()
            await self._report_roster()
            await asyncio.sleep(ROSTER_DEBOUNCE_S)

    async def _report_roster(self) -> None:
        current = {entry.pane_id: _session_payload(entry) for entry in agent_messaging.list_panes()}
        if not self._synced:
            await self._sync(current)
            return
        for pane_id, payload in current.items():
            if self._reported.get(pane_id) == payload:
                continue
            if await self._upsert(pane_id, payload):
                self._reported[pane_id] = payload
        for pane_id in [p for p in self._reported if p not in current]:
            await self._remove(pane_id)

    def _with_session_id(self, pane_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        session_id = self._session_ids.get(pane_id)
        return dict(payload, sessionId=session_id) if session_id else dict(payload)

    async def _sync(self, current: dict[str, dict[str, Any]]) -> None:
        """Flatten the whole roster in one request, right after connecting.

        Reconnecting is the normal case across devices — network changes, sleep,
        a backend restart — so "how do the two sides realign" is the main path,
        not an edge one. A full sync is idempotent and lets the server drop
        whatever is no longer in the list; computing the difference ourselves is
        exactly the kind of code whose mistakes turn into ghost panes that show
        up in the roster and cannot be reached.
        """
        sessions = [self._with_session_id(pane_id, p) for pane_id, p in current.items()]
        reply = await self._request("sessions.sync", {"sessions": sessions})
        if not reply.get("ok"):
            log.warning("navide-server rejected sessions.sync: %s", reply.get("error"))
            return
        result = reply.get("payload")
        rows = result.get("sessions") if isinstance(result, dict) else None
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            pane_id = str(row.get("paneId") or "")
            session_id = str(row.get("sessionId") or "")
            if pane_id and session_id:
                self._session_ids[pane_id] = session_id
        self._reported = dict(current)
        self._synced = True

    async def _remove(self, pane_id: str) -> None:
        """Drop one closed pane without waiting for the next full sync."""
        session_id = self._session_ids.get(pane_id)
        if session_id:
            reply = await self._request("sessions.remove", {"sessionId": session_id})
            if not reply.get("ok"):
                # Retried on the next sweep, and swept up by the sync after the
                # next reconnect either way.
                log.warning(
                    "navide-server rejected sessions.remove for pane %s: %s",
                    pane_id,
                    reply.get("error"),
                )
                return
        self._reported.pop(pane_id, None)
        self._session_ids.pop(pane_id, None)

    async def _upsert(self, pane_id: str, payload: dict[str, Any]) -> bool:
        reply = await self._request("sessions.upsert", self._with_session_id(pane_id, payload))
        if not reply.get("ok"):
            # A per-session rejection is not a connection problem: log it and
            # keep the rest of the roster flowing.
            log.warning(
                "navide-server rejected sessions.upsert for pane %s: %s",
                pane_id,
                reply.get("error"),
            )
            return False
        result = reply.get("payload")
        issued = str(result.get("sessionId") or "") if isinstance(result, dict) else ""
        if issued:
            self._session_ids[pane_id] = issued
        return True

    # ---- pane policy ----

    async def _refresh_policy(self, *, revision: int | None = None) -> None:
        """Fetch this device's pane policy, unless the cache is already at
        *revision*.

        Never raises: a policy this device cannot fetch leaves the previous
        cache in force, and a device that has never fetched one denies
        everything (``pane_policy.is_allowed`` treats None as unusable). Both
        are safe states, and neither is worth dropping the connection over.
        """
        if revision is not None and revision == self._policy_revision:
            return
        try:
            reply = await self._request("policy.get", {"deviceId": self._device_id})
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server policy.get failed: %s", err)
            return
        if not reply.get("ok"):
            log.warning("navide-server rejected policy.get: %s", reply.get("error"))
            return
        payload = reply.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        raw_revision = payload.get("revision")
        # The revision is adopted whatever the document turns out to be: it is
        # only the "have I already fetched this one" hint, and leaving it unset
        # after a document that failed to verify would re-fetch the same bad
        # document on every push.
        self._policy_revision = raw_revision if isinstance(raw_revision, int) else 0
        self._policy = await asyncio.to_thread(self._verified_policy, payload.get("policy"))
        log.info("navide-server pane policy is at revision %s", self._policy_revision)

    def _verified_policy(self, raw: Any) -> Any:
        """The policy this machine will enforce, or None when there is none.

        The server stores this document and hands it back, which means the
        server chooses *which* document comes back — and ``pane_policy`` reads
        whatever it is given. It reads it very carefully (an unknown version
        fails closed, a malformed rule is skipped rather than voiding the rest),
        but every one of those checks is about a *malformed* policy. None of
        them notices a well-formed policy this machine never wrote, and
        ``{"version":1,"default":"allow","rules":[]}`` is well formed.

        So the document carries a signature this device made with its own key,
        over its own sequence number. Two things are checked and the second is
        the one that needed thinking about:

        *The signature verifies against our own signing key.* Nobody else can
        produce it, the server included — it has never held the private half.

        *The sequence is not behind the highest one we ever signed.* Not the
        server's ``revision``: that number is issued by the server, so using it
        for monotonicity would be asking the party with a motive to roll the
        policy back to certify that it had not.

        Anything that does not pass is not a policy. Returning None rather than
        the previous cache is deliberate — ``pane_policy.is_allowed(None)``
        denies everything, which is the state a device that never wrote a policy
        is already in, and the system handles it.
        """
        if self._trust_locked:
            return None
        seq = trust_store.policy_seq(self._device_id)
        if not isinstance(raw, dict):
            if seq:
                trust_store.note_policy_unverified(
                    "the server returned no policy document", device_id=self._device_id
                )
            return None
        document = {key: value for key, value in raw.items() if key != POLICY_SIGNATURE_FIELD}
        envelope = raw.get(POLICY_SIGNATURE_FIELD)
        if not isinstance(envelope, dict):
            # A device that has never written a policy gets the server's empty
            # deny-everything stand-in, which carries no signature and is not an
            # attack. Once this machine *has* signed one, an unsigned document
            # in its place is a replacement, and says so.
            if seq:
                trust_store.note_policy_unverified(
                    "the stored policy carries no signature", device_id=self._device_id
                )
            return None
        offered = envelope.get("seq")
        if isinstance(offered, bool) or not isinstance(offered, int):
            trust_store.note_policy_unverified(
                "the stored policy has no usable sequence", device_id=self._device_id
            )
            return None
        if offered < seq:
            trust_store.note_policy_unverified(
                "the stored policy is older than the last one written here",
                device_id=self._device_id,
                seq=offered,
            )
            return None
        if not device_signing.verify_policy(
            str(envelope.get("sig") or ""),
            public_key_b64=device_signing.public_key(),
            device_id=self._device_id,
            seq=offered,
            document=document,
        ):
            trust_store.note_policy_unverified(
                "the stored policy was not signed by this machine",
                device_id=self._device_id,
                seq=offered,
            )
            return None
        trust_store.note_policy_seq(self._device_id, offered)
        trust_store.clear_policy_notice()
        return document

    def policy_snapshot(self) -> dict[str, Any]:
        """The cached policy and the revision it came at, for the editor UI.

        Reads the cache rather than the server: the cache is what actually
        decides every inbound message, and it survives a disconnect, so the
        editor can still show the rules that are refusing messages while the
        link is down.
        """
        return {"policy": self._policy, "revision": self._policy_revision}

    def _signed_policy(self, policy: Any) -> Any:
        """Wrap *policy* in this device's own signature. Blocking (Keychain).

        The sequence is reserved — and written down — before the document goes
        out, so a write that fails burns a number instead of leaving one that
        could be reused. Reusing one would let the server replay whichever older
        document shared it, which is the whole check.
        """
        document = policy
        if isinstance(policy, dict):
            document = {k: v for k, v in policy.items() if k != POLICY_SIGNATURE_FIELD}
        seq = trust_store.reserve_policy_seq(self._device_id)
        signature = device_signing.sign_policy(
            device_id=self._device_id, seq=seq, document=document
        )
        return {**document, POLICY_SIGNATURE_FIELD: {"seq": seq, "sig": signature}}

    def _trust_refusal(self) -> dict[str, Any]:
        """Why this machine will not carry cross-device traffic right now."""
        return {
            "ok": False,
            "error": {
                "code": LINK_TRUST_UNAVAILABLE,
                "message": (
                    "Navide cannot read this machine's cross-device trust record, so "
                    "it cannot tell one device from another; cross-device messages "
                    "are refused until that is resolved"
                    + (f" ({self._trust_locked})" if self._trust_locked else "")
                ),
            },
        }

    async def set_policy(self, policy: Any) -> dict[str, Any]:
        """Write this device's policy to the server and adopt the new revision.

        Same shape as ``send_message``: the server's reply frame, or a locally
        minted error frame naming the link state when the write cannot leave
        this machine. Only the device itself (or an admin) may write its policy,
        so there is no target to name beyond our own deviceId.
        """
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        if self._trust_locked:
            return self._trust_refusal()
        try:
            signed = await asyncio.to_thread(self._signed_policy, policy)
        except Exception as err:  # noqa: BLE001
            log.warning("could not sign the pane policy: %s", err)
            return self._trust_refusal()
        try:
            reply = await self._request(
                "policy.set", {"deviceId": self._device_id, "policy": signed}
            )
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server policy.set failed: %s", err)
            return {
                "ok": False,
                "error": {
                    "code": LINK_OFFLINE,
                    "message": (
                        f"the navide-server link failed mid-request ({err}); it "
                        f"reconnects on its own, so retry shortly"
                    ),
                },
            }
        if reply.get("ok"):
            payload = reply.get("payload")
            revision = payload.get("revision") if isinstance(payload, dict) else None
            if isinstance(revision, int) and not isinstance(revision, bool):
                # Adopt what was just written instead of waiting for the
                # policy.changed push: that push is only a nudge, and
                # _refresh_policy skips a revision the cache already holds, so a
                # UI re-reading right after the save must not be shown the
                # policy it just replaced.
                self._policy = policy
                self._policy_revision = revision
                trust_store.clear_policy_notice()
            else:
                # No revision to pin the cache to — re-read rather than guess,
                # since a cache pinned to the wrong revision would ignore the
                # very push that would have corrected it.
                await self._refresh_policy()
        return reply

    async def resend_verification(self) -> dict[str, Any]:
        """Ask the server to re-send this account's verification mail.

        Same shape as ``set_policy``: the server's reply frame, or a locally
        minted error frame naming the link state. The server rate-limits and
        owns the token, so this side neither retries nor invents a cooldown —
        RATE_LIMITED is an answer to show, not one to swallow.
        """
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        try:
            reply = await self._request("auth.verify.resend", {})
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server auth.verify.resend failed: %s", err)
            return {
                "ok": False,
                "error": {
                    "code": LINK_OFFLINE,
                    "message": (
                        f"the navide-server link failed mid-request ({err}); it "
                        f"reconnects on its own, so retry shortly"
                    ),
                },
            }
        if reply.get("ok"):
            payload = reply.get("payload")
            if isinstance(payload, dict) and payload.get("emailVerified"):
                # The user confirmed in a browser since this link authenticated;
                # adopt it now rather than making them wait for a reconnect.
                self.email_verified = True
        return reply

    async def _on_policy_changed(self, payload: Any) -> None:
        """The server says this device's policy moved. Re-fetch only if the
        revision differs from the cached one — the event is a nudge, not the
        policy itself, and re-fetching on every nudge would put the control
        plane back in the path of each message."""
        data = payload if isinstance(payload, dict) else {}
        revision = data.get("revision")
        await self._refresh_policy(revision=revision if isinstance(revision, int) else None)

    # ---- remote roster ----

    async def _refresh_directory(self) -> None:
        """Read the team space's whole session directory into the local cache.

        Never raises, for the same reason ``_refresh_policy`` does not: a
        directory this device could not fetch leaves the previous cache in
        force, which is a worse answer than the truth but a far better one than
        an empty roster or a dropped connection.
        """
        try:
            reply = await self._request("sessions.directory", {})
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server sessions.directory failed: %s", err)
            return
        if not reply.get("ok"):
            log.warning("navide-server rejected sessions.directory: %s", reply.get("error"))
            return
        self._apply_directory(reply.get("payload"))

    def _apply_directory(self, payload: Any) -> None:
        """Replace the remote roster from a directory payload.

        ``sessions.directory`` and the ``sessions.changed`` push carry the same
        shape — the entire directory, this device's own rows included — so both
        land here and both replace wholesale. Our own rows are dropped by
        ``remote_roster.replace``: the server's copy of them is whatever was
        last reported, while ``agent_messaging`` holds the live ones.

        The rows may carry a ``deviceName`` (the server joins the one
        ``auth.hello`` gave it onto every session row); they may equally not,
        because an older server does not. Every reader here falls back to the
        device id, which is always present.

        The raw rows are also kept whole in ``_directory``, local ones included,
        for ``network_snapshot`` — see the note on that field.
        """
        data = payload if isinstance(payload, dict) else {}
        sessions = data.get("sessions")
        rows = sessions if isinstance(sessions, list) else []
        remote_roster.replace(rows, local_device_id=self._device_id)
        # Capped like the roster cache, and for the same reason: the directory
        # is filled by other machines, so it is only as small as they are well
        # behaved.
        self._directory = [row for row in rows if isinstance(row, dict)][
            : remote_roster.MAX_PANES
        ]

    def _on_presence_changed(self, payload: Any) -> None:
        """Re-flag the cached panes when a device joins or leaves.

        A device going offline changes no session row, so it produces no
        ``sessions.changed`` — only this event. Without it the roster would go
        on reporting a machine that has left as reachable until something else
        happened to touch one of its sessions.
        """
        data = payload if isinstance(payload, dict) else {}
        devices = data.get("devices")
        if not isinstance(devices, list):
            return
        online = {
            str(device.get("deviceId") or "")
            for device in devices
            if isinstance(device, dict)
        }
        online.discard("")
        # Kept as well as pushed down, because ``network_snapshot`` has to be
        # able to answer for a device the directory holds no session for.
        self._online_devices = online
        remote_roster.set_online_devices(online)

    async def ensure_directory(self) -> None:
        """Read the directory once if this connection has not carried one yet.

        Every connection fetches it at authentication time and the
        ``sessions.changed`` push keeps it current after that, so this is only
        ever the first read of a link whose fetch failed. It exists so the
        network view is not blank for a whole poll interval in that case.
        """
        if self._directory is None and self.state() == STATE_CONNECTED:
            await self._refresh_directory()

    def _device_name_for(self, device_id: str) -> str:
        """The label the directory knows this device by, or "" — a knock from a
        machine the directory has not mentioned yet still has to be showable."""
        for raw in self._directory or []:
            if str(raw.get("deviceId") or "") == device_id:
                return str(raw.get("deviceName") or "")
        return ""

    async def _announce_access_requests(self) -> None:
        """Tell every window that the knock list changed.

        Broadcast rather than addressed: the list belongs to the machine, not
        to a workspace, and whichever window has the account view open is the
        one that should light up.
        """
        from . import app
        from .ipc import make_event

        await app.broadcast(
            make_event("p2p.access_requests.changed", {"requests": self._access_requests.list()})
        )

    def access_requests(self) -> list[dict[str, Any]]:
        return self._access_requests.list()

    def forget_access_request(self, key: str) -> bool:
        return self._access_requests.forget(key)

    def forget_access_requests_for_device(self, device_id: str) -> int:
        return self._access_requests.forget_device(device_id)

    def network_snapshot(self) -> dict[str, Any]:
        """Every device in this team space, and the panes running on each.

        Answered from the cache whatever the link is doing: a link that dropped
        a second ago does not make the other machines stop existing, and an
        empty list would read as "nobody is signed in". ``state`` is the honest
        half.

        Unlike ``remote_roster`` this keeps this device's own rows. Addressing
        must not see them (the live local roster is the truth there), but the
        whole point of this view is the whole network, and the machine the user
        is sitting at is the one row they can recognise.
        """
        devices: dict[str, dict[str, Any]] = {}
        local = self._device_id
        # This machine knows more about its own panes than the server does. The
        # roster it publishes has four words to spend and "disconnected" is the
        # closest of them to a placeholder, but locally there is no reason to
        # read that compromise back: the registry holds the realized flag
        # itself. Same reason the local row's `online` is taken from the link
        # rather than from presence below — for this one device, the server is
        # not the better-informed party.
        unopened_here = {
            entry.pane_id for entry in agent_messaging.list_panes() if not entry.realized
        }

        def entry(device_id: str, device_name: str) -> dict[str, Any]:
            row = devices.get(device_id)
            if row is None:
                row = {
                    "deviceId": device_id,
                    "deviceName": device_name,
                    "isLocal": bool(local) and device_id == local,
                    "online": False,
                    "paneCount": 0,
                    "panes": [],
                }
                devices[device_id] = row
            elif not row["deviceName"] and device_name:
                row["deviceName"] = device_name
            return row

        # This machine is listed even with nothing running on it: "no devices"
        # and "one device with no panes" are different answers, and the second
        # is the one a user who has only just signed in is looking at.
        if local:
            entry(local, self._device_name)

        for raw in self._directory or []:
            device_id = str(raw.get("deviceId") or "")
            if not device_id:
                continue
            row = entry(device_id, str(raw.get("deviceName") or ""))
            pane_id = str(raw.get("paneId") or "")
            status = str(raw.get("status") or "")
            if device_id == local and pane_id in unopened_here:
                status = STATUS_NOT_OPENED
            row["panes"].append(
                {
                    "sessionId": str(raw.get("sessionId") or ""),
                    "paneId": pane_id,
                    "agentKey": str(raw.get("agentKey") or ""),
                    "title": str(raw.get("title") or ""),
                    "workspace": str(raw.get("workspace") or ""),
                    "workspacePath": str(raw.get("workspacePath") or ""),
                    # As the server spelled it, except for this device's own
                    # unopened panes (above): the four values it defines are
                    # translated by the UI, and one this build has never heard
                    # of is shown raw rather than hidden.
                    "status": status,
                    "hostOnline": bool(raw.get("hostOnline")),
                    "startedAt": str(raw.get("startedAt") or ""),
                }
            )
        for row in devices.values():
            row["paneCount"] = len(row["panes"])
            row["panes"].sort(key=lambda pane: (pane["workspace"], pane["title"]))
            if row["isLocal"]:
                # Presence is what the *server* can see, and the only thing it
                # can see of this machine is the link being reported on here.
                row["online"] = self.state() == STATE_CONNECTED
            elif self._online_devices is not None:
                row["online"] = row["deviceId"] in self._online_devices
            else:
                # No presence.changed has arrived yet, so the per-session flag
                # is the only thing that has been said about this machine.
                row["online"] = any(pane["hostOnline"] for pane in row["panes"])
        return {
            "state": self.state(),
            "deviceId": local,
            "memberId": self.member_id,
            # Folded into the same read as the devices for the reason given
            # above them: this view is polled while it is open, and a separate
            # round trip per list would be another chance to draw a picture
            # that is half one moment and half the next. Both are local state —
            # the ledger is in memory here, the block list is in the policy
            # this machine already holds — so neither costs the server
            # anything.
            "accessRequests": self._access_requests.list(),
            "blocked": device_trust.blocked_entries(self._policy),
            # Two things a person has to be told, folded into the same read:
            # a device seen for the first time (a narrative — this is what got
            # pinned) and a pinned device whose key has changed (a refusal in
            # force, with both fingerprints, because "they reinstalled" and
            # "somebody is standing in for them" look identical from here).
            "trustNotices": trust_store.notices(),
            # Pinned devices nobody has vouched for yet. Separate from the
            # notices because a notice can be dismissed and this question
            # cannot be retired by dismissing anything.
            "trustPending": trust_store.unapproved_devices(),
            "trustLocked": self._trust_locked,
            # This device first, then by label: the row a user recognises is
            # the one that should not move as other machines come and go.
            "devices": sorted(
                devices.values(),
                key=lambda d: (not d["isLocal"], d["deviceName"] or d["deviceId"]),
            ),
        }

    # ---- messages ----

    async def _sealed_for(self, to_device: str, text: str) -> dict[str, Any]:
        """What to put on the wire for one recipient: ``cipher`` or ``text``.

        Two rules, and the second is the one that matters:

        *Encrypt whenever the recipient has published a key.* The key travels
        with the session directory, so "has a key" and "is visible to me" are
        the same condition.

        *Never go back to plaintext for a device that once had one.* Without
        this the encryption would be advisory: anything that could make a key
        disappear — a stale roster, a server that omitted the field, a peer
        reconnecting from an older build — would silently turn ciphertext back
        into cleartext, and nothing on either end would say so. Once a peer has
        been seen with a key, a message that cannot be sealed is refused
        instead.
        """
        key = remote_roster.public_key_for(to_device)
        if key:
            sealed = {
                "cipher": device_crypto.seal(
                    text,
                    recipient_public_key=key,
                    from_device=self._device_id,
                    to_device=to_device,
                )
            }
            # Recorded after sealing and on disk, not before and in memory: the
            # record is what makes the *next* send refuse a vanished key, and a
            # record that did not survive a restart made that refusal a promise
            # the relay only had to wait out.
            try:
                await asyncio.to_thread(trust_store.note_encrypted_peer, to_device)
            except Exception as err:  # noqa: BLE001
                raise device_crypto.CryptoError(
                    f"this device could not record that {to_device} is encrypted ({err})"
                ) from err
            return sealed
        if trust_store.is_encrypted_peer(to_device):
            raise device_crypto.CryptoError("this device published a key before and none is known now")
        # Never seen a key: an un-upgraded peer, which can only read plaintext.
        return {"text": text}

    async def send_message(
        self,
        *,
        to: dict[str, Any],
        sender: dict[str, Any] | None,
        text: str,
        msg_key: str,
    ) -> dict[str, Any] | None:
        """Relay one message to a pane on another device.

        Returns the server's reply frame, or — when this link exists but cannot
        carry the message right now — a locally minted error frame naming the
        link state (see LINK_OFFLINE / LINK_UNAUTHORIZED). It never returns
        None: a ServerLink instance only exists once a server was configured,
        so "there is no link" is the module-level caller's answer, not this
        one's.
        """
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        if self._trust_locked:
            return self._trust_refusal()
        to_device = str(to.get("deviceId") or "")
        try:
            body = await self._sealed_for(to_device, text)
        except device_crypto.CryptoError as err:
            # Refused rather than downgraded. A message that silently went out
            # as plaintext because sealing failed would be the one case the
            # user has no way to notice.
            log.warning("refusing to send unencrypted to %s: %s", to_device, err)
            return {
                "ok": False,
                "error": {
                    "code": LINK_ENCRYPTION_FAILED,
                    "message": (
                        "this message could not be encrypted for that device, and "
                        "Navide does not fall back to sending it in the clear"
                    ),
                },
            }
        kind = BODY_CIPHER if BODY_CIPHER in body else BODY_TEXT
        try:
            signature = await asyncio.to_thread(
                device_signing.sign_message,
                msg_key=msg_key,
                from_device=self._device_id,
                to_device=to_device,
                kind=kind,
                body=body[kind],
            )
        except device_signing.SigningError as err:
            # Refused rather than sent unsigned, for the same reason a message
            # that cannot be sealed is refused rather than sent in the clear:
            # the far side would reject it anyway, and an unsigned message that
            # somehow got through would be one nobody could attribute.
            log.warning("refusing to send an unsigned message to %s: %s", to_device, err)
            return self._trust_refusal()
        payload: dict[str, Any] = {"to": to, "msgKey": msg_key, "sig": signature, **body}
        if sender:
            payload["from"] = sender
        try:
            return await self._request("messages.send", payload)
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server messages.send failed: %s", err)
            return {
                "ok": False,
                "error": {
                    "code": LINK_OFFLINE,
                    "message": (
                        f"the navide-server link failed mid-request ({err}); it "
                        f"reconnects on its own, so retry shortly"
                    ),
                },
            }

    def _unavailable(self) -> dict[str, Any]:
        """Why this configured link cannot carry a message at this instant.

        Fails immediately rather than waiting on a socket that is not there:
        the reconnect loop is the only thing that can change the answer, and it
        runs on its own schedule, so blocking the sender for REQUEST_TIMEOUT_S
        would only turn a clear error into a slow one.
        """
        if self.terminated_reason:
            return {
                "ok": False,
                "error": {
                    "code": LINK_UNAUTHORIZED,
                    "message": (
                        f"the navide-server link stopped for good: "
                        f"{self.terminated_reason}"
                    ),
                },
            }
        return {
            "ok": False,
            "error": {
                "code": LINK_OFFLINE,
                "message": (
                    "the navide-server link is configured but not connected right "
                    "now; it reconnects on its own, so retry shortly"
                ),
            },
        }

    async def _note_inbound(self, msg_key: str) -> bool:
        """Claim a msgKey. False means it was already handled — drop it.

        The server pushes ``messages.pending`` to every connection it holds for
        this device. That is one connection in the steady state, but a backend
        restart can leave the old socket open a moment after the new one is up,
        and then the same message arrives twice.

        The in-memory half above answers the ordinary case — the same socket
        pair, seconds apart. The persisted half answers the one a relay can
        arrange: hold a delivered message, wait for a backend restart, push it
        again. That wait used to be all it took, because this map was rebuilt
        empty every time the process came up, and a restart is a daily event
        rather than something anyone has to engineer.
        """
        if msg_key in self._inbound:
            return False
        now = time.monotonic()
        for key, entry in list(self._inbound.items()):
            if now - entry["created_at"] >= MESSAGE_MEMORY_TTL_S:
                del self._inbound[key]
        # Insertion-ordered, so the front of the dict is the oldest message.
        while len(self._inbound) >= MESSAGE_MEMORY_MAX:
            self._inbound.pop(next(iter(self._inbound)))
        # Claimed before any await. Everything above is synchronous on purpose:
        # the first `await` below yields the loop, and two pushes of the same
        # key would otherwise both get past the membership check while the first
        # was still in a thread — which is the duplicate this method exists to
        # stop, reintroduced by the fix for something else.
        self._inbound[msg_key] = {"created_at": now, "pane_id": "", "acked": False}

        # The persisted half, off the loop. A cold cache makes the read a
        # Keychain read and every 25th record a Keychain write; every other
        # trust_store call on this path already goes through a thread for that
        # reason, and a stalled loop in this backend is a symptom that has cost
        # this project real time before.
        #
        # Checked after the claim rather than before: the claim is what makes
        # the check race-free, and a key already in the ledger is simply left
        # marked handled in memory too.
        if await asyncio.to_thread(trust_store.has_seen_message, msg_key):
            return False
        # Recorded on the claim rather than after delivery: a message that got
        # this far has been handed to the delivery path, and re-running that
        # path is the thing being prevented.
        await asyncio.to_thread(trust_store.note_seen_message, msg_key)
        return True

    async def _authenticate_sender(
        self, data: dict[str, Any], *, msg_key: str, device_id: str, member_id: str
    ) -> bool | None:
        """Whether this message really came from *device_id*, and whether that
        device is one of ours. None means it did not, and must be refused.

        The chain this closes: the relay filled ``from`` and it filled the
        answer to ``auth.hello``, so it could write the same member id into both
        and the delivery path read the result as one of the user's own machines
        — which skips the pane policy outright. Encryption did not help, because
        a sealed box authenticates nobody: the recipient's public key is what
        seals it, and the relay is who hands that key out.

        So a message must carry a signature over
        ``(msgKey, fromDevice, toDevice, which body field, digest of it)``, and
        it is checked against the key this machine **pinned** for that device —
        not against the key the directory is advertising today. Once a device is
        pinned, changing what the directory says about it makes that device
        unreachable, which is the failure that can be seen, rather than
        impersonable, which is the one that cannot.

        First contact is trust-on-first-use, and that is a real limit rather
        than a formality: the first key offered for a device this machine has
        never heard of is believed, so a relay that gets in before the real
        device does gets pinned in its place. What pinning buys is that it only
        gets one attempt per device id, it cannot revise it afterwards, and the
        attempt leaves a notice with a fingerprint on it. Closing the rest needs
        a person to compare fingerprints out of band, which is the surface this
        version does not build.
        """
        signature = str(data.get("sig") or "")
        cipher = str(data.get("cipher") or "")
        kind = BODY_CIPHER if cipher else BODY_TEXT
        body = cipher if cipher else str(data.get("text") or "")
        if not device_id or not signature:
            log.warning("refusing message %s: it carries no sender signature", msg_key)
            return None

        pin = trust_store.pin_for(device_id)
        advertised = remote_roster.sign_public_key_for(device_id)
        if pin is not None:
            key = str(pin.get("signKey") or "")
            if advertised and advertised != key:
                # Recorded before the refusal, not after: the refusal is what
                # the sender sees, and this is the only thing the *receiver*
                # ever gets to see about it.
                await asyncio.to_thread(
                    trust_store.note_key_change,
                    device_id,
                    pinned_key=key,
                    offered_key=advertised,
                    member_id=member_id,
                )
                await self._announce_trust_notices()
                log.error(
                    "device %s now offers a different signing key; refusing message %s",
                    device_id,
                    msg_key,
                )
                return None
        else:
            key = advertised
            if not key:
                log.warning(
                    "refusing message %s: no signing key is known for device %s",
                    msg_key,
                    device_id,
                )
                return None

        if not device_signing.verify_message(
            signature,
            public_key_b64=key,
            msg_key=msg_key,
            from_device=device_id,
            to_device=self._device_id,
            kind=kind,
            body=body,
        ):
            log.warning("refusing message %s: its signature does not verify", msg_key)
            return None

        if pin is None:
            # Pinned only now, after the signature checked out, so the relay
            # cannot seed this map with keys nobody holds by naming device ids.
            try:
                pin = await asyncio.to_thread(
                    lambda: trust_store.pin_device(
                        device_id,
                        sign_key=key,
                        member_id=member_id,
                        own_member_id=self._own_member,
                    )
                )
            except trust_store.TrustStoreFull as err:
                log.error("refusing message %s: %s", msg_key, err)
                return None
            except Exception as err:  # noqa: BLE001
                log.error("refusing message %s: could not pin device %s (%s)", msg_key, device_id, err)
                return None
            await self._announce_trust_notices()

        return self._own_device(pin)

    def _own_device(self, pin: dict[str, Any]) -> bool:
        """Whether a pinned device belongs to this account.

        Read from the pin's member id rather than from the message's, and
        compared against the member id pinned for *this* credential rather than
        against whatever the last ``auth.hello`` said. Both halves used to come
        from the relay; now neither does, and neither can be revised once taken.

        Both halves still arrived over the wire on the day the pin was taken,
        though, and that is what the approval check is for. The pinned member
        id was copied out of the first message, which the relay wrote: a relay
        that invents a device id, generates a keypair, signs correctly with it
        and fills in this account's own member id passes every test above. It
        gets exactly one attempt and leaves a notice with a fingerprint on it,
        which is what pinning buys, but until this version nothing stood between
        that attempt and the ring that consults no rules. Now something does,
        and it is a person comparing that fingerprint with the other machine.

        Unapproved is not refused. It drops the sender to the member ring, where
        the pane policy answers, and the policy denies by default and records a
        knock. So the failure of a legitimate new machine is "it asked and is
        waiting", which someone can see and fix, rather than "it vanished".
        """
        pinned = str(pin.get("memberId") or "")
        if not (bool(self._own_member) and pinned == self._own_member):
            return False
        # Missing rather than False on pins written before approval existed, and
        # read the same way: see trust_store.unapproved_devices for why those
        # are not grandfathered.
        return pin.get("approved") is True

    async def _announce_trust_notices(self) -> None:
        """Tell every window that the trust notices changed.

        Broadcast for the same reason the knock list is: a key that changed
        belongs to the machine, not to a workspace, and whichever window has the
        account view open is the one that should say so.
        """
        from . import app
        from .ipc import make_event

        await app.broadcast(
            make_event(
                "p2p.trust_notices.changed",
                {
                    "notices": trust_store.notices(),
                    "pending": trust_store.unapproved_devices(),
                    "locked": self._trust_locked,
                },
            )
        )

    async def _on_message_pending(self, payload: Any) -> None:
        """A message for a pane on this machine.

        Order matters: dedupe, then authorize, then resolve. Authorizing before
        resolving is what keeps an unauthorized sender from using the ack as a
        probe — "no such pane" and "policy denied" would otherwise map out which
        panes this machine is running.
        """
        data = payload if isinstance(payload, dict) else {}
        msg_key = str(data.get("msgKey") or "")
        if not msg_key:
            log.warning("navide-server pushed a message with no msgKey; ignoring it")
            return
        if not await self._note_inbound(msg_key):
            log.info("navide-server re-sent message %s; ignoring the duplicate", msg_key)
            return
        if self._trust_locked:
            # Nothing here can be told apart from anything else while the pins
            # are unreadable, and "deliver it anyway" is the one answer that
            # would make losing them costless.
            log.error("refusing message %s: %s", msg_key, self._trust_locked)
            await self._ack(msg_key, "rejected", reason="trust-unavailable")
            return

        source = data.get("from") if isinstance(data.get("from"), dict) else {}
        target = data.get("to") if isinstance(data.get("to"), dict) else {}
        workspace = str(target.get("workspace") or "")
        pane_name = str(target.get("paneName") or "")

        sender_member = str(source.get("memberId") or "")
        sender_device = str(source.get("deviceId") or "")

        # Authenticity before authorization. Everything below this line reads
        # fields the relay writes; the signature is what says the relay only
        # *carried* them. A message that does not verify never reaches a trust
        # ring, a policy lookup, or the knock ledger — the last of those
        # matters too, or an unauthenticated sender could fill the receiver's
        # screen with knocks from names it invented.
        own_device = await self._authenticate_sender(
            data, msg_key=msg_key, device_id=sender_device, member_id=sender_member
        )
        if own_device is None:
            await self._ack(msg_key, "rejected", reason=REASON_UNAUTHENTICATED)
            return
        await self._ensure_policy()
        # Three rings, not one condition: your own machines are one trust
        # domain and never consult the rules, a blocked device is refused ahead
        # of everything including that shortcut, and everyone else is what the
        # rule set is actually for. See device_trust for why each boundary sits
        # where it does. `own_device` is settled above from a signature checked
        # against a pinned key — never from the member id in the message, which
        # the relay writes, and never from the one in auth.hello, which it also
        # writes.
        trust_ring = device_trust.ring(
            self._policy,
            member_id=sender_member,
            device_id=sender_device,
            own_device=own_device,
        )
        # The addressed workspace/paneName are checked, not the resolved pane's:
        # resolution happens after this. `paneName` is matched exactly by the
        # resolver, so it is already the pane's real name; only a workspace
        # written as a longer path suffix ("nest/proj" for the pane labelled
        # "proj") can read differently, and it can only fail to match a rule.
        refused = trust_ring == device_trust.RING_BLOCKED or (
            trust_ring != device_trust.RING_SELF
            and not pane_policy.is_allowed(
                self._policy,
                member_id=sender_member,
                device_id=sender_device,
                workspace=workspace,
                pane_name=pane_name,
            )
        )
        if refused:
            log.warning(
                "refused message %s from device %s to %s/%s (%s)",
                msg_key,
                sender_device,
                workspace,
                pane_name,
                trust_ring,
            )
            if trust_ring != device_trust.RING_BLOCKED:
                # A knock worth showing someone. Blocked senders are left out
                # on purpose — see AccessRequests.
                self._access_requests.record(
                    member_id=sender_member,
                    device_id=sender_device,
                    device_name=self._device_name_for(sender_device),
                    workspace=workspace,
                    pane_name=pane_name,
                )
                await self._announce_access_requests()
            # One wire reason for both, deliberately: telling a sender that it
            # is blocked rather than merely unauthorized hands it an oracle,
            # which is the same reason authorization runs before resolution
            # here. The distinction is kept locally, where it is useful.
            await self._ack(msg_key, "rejected", reason="policy-denied")
            return

        address = agent_messaging.Address(
            pane_name=pane_name,
            workspace=workspace,
            # A hint only: a detach or reattach mints a new pane id, so a stale
            # one falls back to resolving (workspace, paneName) and the ack
            # carries whatever that produced.
            pane_id=str(target.get("paneId") or ""),
        )
        result = agent_messaging.resolve_address("", address)
        if result.pane is None:
            await self._ack(msg_key, "failed", reason=result.code or "unknown-target")
            return

        # Decrypt only after the pane resolved: a message this machine was not
        # going to deliver anyway is one it has no reason to open, and doing the
        # work in the other order would make "did it decrypt" observable through
        # timing on messages that were never going to land.
        cipher = str(data.get("cipher") or "")
        if cipher:
            try:
                text = await asyncio.to_thread(
                    device_crypto.open_sealed,
                    cipher,
                    from_device=str(source.get("deviceId") or ""),
                    to_device=self._device_id,
                )
            except device_crypto.CryptoError:
                # Not "failed" — a retry would fail identically. The sender is
                # told the message was refused, and nothing goes to the pane:
                # delivering the ciphertext as if it were text would type a wall
                # of base64 into somebody's CLI.
                log.warning("could not open the sealed message %s; refusing it", msg_key)
                await self._ack(msg_key, "rejected", reason="undecryptable")
                return
        else:
            # The other half of the downgrade rule. The send side has refused to
            # emit plaintext to a peer known to hold a key ever since that record
            # was made durable — but a rule enforced on only one side is not a
            # rule, it is a preference. A relay that wants cleartext does not
            # need to break the sender; it can ask the receiver, and until now
            # the receiver had nothing to say no with.
            #
            # `is_encrypted_peer` is read from disk, so this survives the restart
            # that the in-memory version could simply be waited out through.
            sender_device = str(source.get("deviceId") or "")
            if sender_device and trust_store.is_encrypted_peer(sender_device):
                log.warning(
                    "refusing plaintext %s from %s, which has been encrypting",
                    msg_key, sender_device,
                )
                # Recorded as well as acked: the sender learning it was refused
                # tells a hostile sender only what it already knew. The notice is
                # for the person at this machine, and it is not dismissible for
                # the same reason a changed key is not — it reports a message
                # that was dropped, and that stays worth seeing.
                try:
                    await asyncio.to_thread(
                        trust_store.note_plaintext_refused, sender_device, msg_key=msg_key
                    )
                except Exception as err:  # noqa: BLE001
                    # The refusal stands either way; only the telling failed.
                    log.warning("could not record the refused downgrade: %s", err)
                await self._ack(msg_key, "rejected", reason="plaintext-downgrade")
                return
            text = str(data.get("text") or "")

        self._inbound[msg_key]["pane_id"] = result.pane.pane_id
        await self._deliver(msg_key, result.pane, source, text)

    async def _deliver(
        self,
        msg_key: str,
        pane: agent_messaging.RegisteredPane,
        source: dict[str, Any],
        text: str,
    ) -> None:
        """Hand the message to the window that owns the pane, on the existing
        on-machine path — the same event a local cli_send emits, so the idle
        gate, queue and message log behave identically for both."""
        from . import app
        from .ipc import make_event

        from_display = "/".join(
            part
            for part in (
                str(source.get("deviceId") or ""),
                str(source.get("workspace") or ""),
                str(source.get("paneName") or ""),
            )
            if part
        )
        await app.broadcast(
            make_event(
                "agent_msg.deliver",
                {
                    "msg_key": msg_key,
                    "target_pane_id": pane.pane_id,
                    "target_workspace_path": pane.workspace_path,
                    "target_name": pane.name,
                    "target_agent_key": pane.agent_key,
                    # No local pane sent this; the display name is the address a
                    # reply would be sent back to.
                    "from_pane_id": "",
                    "from_display": from_display or "another device",
                    "from_workspace_path": "",
                    "from_agent_key": "",
                    "cross_workspace": True,
                    "content": text,
                    # Nothing applied the per-pair rate limit on the way in, so
                    # the receiving window has to. Without it two agents
                    # answering each other across devices have no loop guard.
                    "rate_limit": True,
                },
            )
        )

    def note_delivery_result(self, msg_key: str, ok: bool, reason: str) -> bool:
        """Turn a window's agent_msg.delivered verdict into a messages.ack.

        Returns False for every key that did not come in over this link, which
        is the common case — the same event carries every on-machine delivery.
        """
        entry = self._inbound.get(msg_key)
        if entry is None or entry["acked"] or not entry["pane_id"]:
            return False
        # Claimed before the ack is awaited so a second report cannot double-ack.
        entry["acked"] = True
        self._spawn(
            self._ack(
                msg_key,
                "delivered" if ok else "failed",
                reason=_reason_key(reason),
                pane_id=entry["pane_id"],
            )
        )
        return True

    async def _ack(
        self, msg_key: str, state: str, *, reason: str = "", pane_id: str = ""
    ) -> None:
        entry = self._inbound.get(msg_key)
        if entry is not None:
            entry["acked"] = True
        payload: dict[str, Any] = {"msgKey": msg_key, "state": state}
        if reason:
            payload["reason"] = reason
        # Only sent when the message was actually resolved to a pane: it is how
        # the sender learns the pane id its cached hint should become.
        if pane_id:
            payload["paneId"] = pane_id
        try:
            reply = await self._request("messages.ack", payload)
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server messages.ack for %s failed: %s", msg_key, err)
            return
        if not reply.get("ok"):
            log.warning(
                "navide-server rejected messages.ack for %s: %s", msg_key, reply.get("error")
            )

    async def _ensure_policy(self) -> None:
        if self._policy_revision is None:
            await self._refresh_policy()

    def _on_message_acked(self, payload: Any) -> None:
        """The far side reported what became of a message this device sent."""
        from .mcp_server import server as plan_mcp

        data = payload if isinstance(payload, dict) else {}
        msg_key = str(data.get("msgKey") or "")
        if not msg_key:
            return
        # `ackPaneId` is the pane id the receiver resolved to. Nothing here
        # caches a remote pane id — cli_send resolves the address every call —
        # so it is only logged; a sender that starts caching would read it here.
        log.debug(
            "navide-server acked message %s: %s (pane %s)",
            msg_key,
            data.get("state"),
            data.get("ackPaneId") or "",
        )
        plan_mcp.record_remote_ack(
            msg_key, str(data.get("state") or ""), str(data.get("reason") or "")
        )


# ---- process-wide link ------------------------------------------------------

_link: ServerLink | None = None


async def start() -> None:
    """Start the process's one link, unless no server is configured."""
    global _link
    link = ServerLink()
    if await link.start():
        _link = link


async def stop() -> None:
    global _link
    if _link is not None:
        await _link.stop()
        _link = None


async def reconfigure() -> None:
    """Apply a configuration change without restarting the backend.

    ``start()`` runs once at boot, so before this existed a user who filled in
    the server URL and token saw nothing happen — and the failure they got was
    the "unknown device" answer for a machine with no server configured, which
    reads as a typo in the address rather than "the link never dialled".

    Tearing the old link down *before* the new one dials is the whole point:
    two links for one device would both publish the same roster and both take
    delivery of the same relayed message. ``stop()`` on a None link and
    ``start()`` with no configuration are each already no-ops, so clearing the
    settings lands back in the inert state by the same path.
    """
    await stop()
    await start()


async def status() -> dict[str, Any]:
    """What the Settings UI needs to answer "is my configuration right?".

    Never returns the token: the UI only has to know whether one is stored, and
    a long-lived credential that is echoed back is a credential that leaks into
    a renderer process, a log, or a screenshot.
    """
    link = _link
    if link is not None:
        # A link exists only because start() found both halves, so the token is
        # known to be stored without asking the Keychain again — and the
        # Settings pane polls this while it is open.
        return {
            "state": link.state(),
            "serverUrl": await asyncio.to_thread(server_url),
            "hasToken": True,
            "detail": link.terminated_reason or link.last_error,
            "deviceId": link._device_id,
            "memberId": link.member_id,
            "accountEmail": await asyncio.to_thread(account_email),
            "displayName": getattr(link, "display_name", ""),
            "emailVerified": bool(getattr(link, "email_verified", False)),
        }
    config = await asyncio.to_thread(load_config)
    return {
        "state": STATE_UNCONFIGURED,
        "serverUrl": config.url,
        # Reported even with no URL: it is what lets the token field say "one is
        # already stored" instead of asking for a credential the user cannot see
        # and would have no way to retype.
        "hasToken": bool(config.token),
        "detail": "",
        "deviceId": "",
        "memberId": "",
        "accountEmail": await asyncio.to_thread(account_email),
        "displayName": "",
        # No link means no account to judge; the UI only shows the verification
        # notice for an account it can actually see.
        "emailVerified": False,
    }


async def policy_state() -> dict[str, Any]:
    """What the pane-policy editor needs to answer "who may command me?".

    Answered whatever the link is doing, because the policy is cached on this
    machine and a user whose messages are being refused has to be able to read
    the rules doing the refusing. ``editable`` is the honest half: the policy
    lives on the server, so an offline link can show it and not write it.

    Reads no configuration and touches no keychain — the Settings pane polls
    this while it is open, and the unconfigured answer is a constant.
    """
    link = _link
    if link is None:
        return {
            "state": STATE_UNCONFIGURED,
            "editable": False,
            "policy": None,
            "revision": None,
            "deviceId": "",
            "memberId": "",
        }
    state = link.state()
    snapshot = link.policy_snapshot()
    return {
        "state": state,
        # Only a live, authenticated link can carry a policy.set, and a UI that
        # offered the buttons anyway would leave the user believing a rule was
        # saved that never left the machine.
        "editable": state == STATE_CONNECTED,
        "policy": snapshot["policy"],
        "revision": snapshot["revision"],
        "deviceId": link._device_id,
        "memberId": link.member_id,
    }


def access_requests() -> list[dict[str, Any]]:
    """Refused knocks, or an empty list when no server was ever configured —
    a machine with no link cannot have been knocked on."""
    return [] if _link is None else _link.access_requests()


def forget_access_request(key: str) -> bool:
    return False if _link is None else _link.forget_access_request(key)


def forget_access_requests_for_device(device_id: str) -> int:
    return 0 if _link is None else _link.forget_access_requests_for_device(device_id)


async def set_policy(policy: Any) -> dict[str, Any] | None:
    """Write this device's pane policy, or None when no server is configured.

    None means the same thing it means for ``send_message``: this machine never
    had a server, so there is no policy anywhere to write. Every other failure
    is a reply frame carrying LINK_OFFLINE or LINK_UNAUTHORIZED.
    """
    if _link is None:
        return None
    return await _link.set_policy(policy)


async def network_snapshot() -> dict[str, Any] | None:
    """Devices and their panes in one read, or None when no server is configured.

    None means what it means everywhere else in this module: this machine never
    had a server, so there is no network to describe. Everything the view needs
    comes back in this one call — the caller polls this and nothing else.
    """
    link = _link
    if link is None:
        return None
    await link.ensure_directory()
    return link.network_snapshot()


async def resend_verification() -> dict[str, Any] | None:
    """Re-send the account verification mail, or None with no server configured.

    None means what it means everywhere else in this module: this machine never
    had a server, so there is no account anywhere to verify.
    """
    if _link is None:
        return None
    return await _link.resend_verification()


def roster_changed() -> None:
    """Tell the link a pane was added, renamed, removed or changed state.

    A no-op when no server is configured, which is what lets the on-machine
    registry call sites nudge it unconditionally.
    """
    if _link is not None:
        _link.notify_roster_changed()


async def send_message(
    *,
    to: dict[str, Any],
    sender: dict[str, Any] | None,
    text: str,
    msg_key: str,
) -> dict[str, Any] | None:
    """Relay a message to a pane on another device, or None if this machine has
    no server configured.

    None means exactly one thing: **no server was ever configured**, so the
    caller falls back to the answer it gave before cross-device addressing
    existed. That is the whole no-server guarantee in one branch.

    A configured server that is merely unreachable is *not* None — it comes back
    as an error frame carrying LINK_OFFLINE or LINK_UNAUTHORIZED. Collapsing the
    two told a user whose server had just gone down that the device id they
    typed was unknown, which sends them to fix an address that was correct.
    """
    if _link is None:
        return None
    return await _link.send_message(to=to, sender=sender, text=text, msg_key=msg_key)


def note_delivery_result(msg_key: str, ok: bool, reason: str) -> bool:
    """Report a local window's delivery verdict for a message relayed in from
    another device. A no-op for every key that did not arrive that way."""
    if _link is None:
        return False
    return _link.note_delivery_result(msg_key, ok, reason)


# ---- account API (register / login) -----------------------------------------
#
# These two calls happen *before* this machine has a token, so they cannot go
# through the long-lived link: that link only dials once a token exists, and
# authenticates before it will carry anything. auth.register and auth.login are
# the server's only unauthenticated endpoints, so each call opens its own
# short-lived connection, sends one frame, and closes.
#
# The password only ever exists inside this function's frame. What gets stored
# is the token the server hands back — the same long-lived credential a user
# would otherwise have pasted in by hand.


class AccountError(Exception):
    """A server-reported failure of an account call, carrying its code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def account_request(
    url: str, msg_type: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Call one unauthenticated account endpoint over a throwaway connection.

    Raises AccountError for a server-reported failure (so the caller can keep
    the server's own code, e.g. EMAIL_TAKEN) and ConnectionError/TimeoutError
    for anything that stops the call reaching a server at all — the caller
    turns those into a link-level error rather than a credential problem.
    """
    target = (url or "").strip()
    if not target:
        raise ConnectionError("no server url configured")
    # Honour a test's injected connector when one is installed on the link.
    connect = _link._connect if _link is not None else websockets.connect
    frame = json.dumps({"id": "acct-1", "type": msg_type, "payload": payload})
    async with connect(target) as ws:
        await asyncio.wait_for(ws.send(frame), REQUEST_TIMEOUT_S)
        while True:
            raw = await asyncio.wait_for(ws.recv(), REQUEST_TIMEOUT_S)
            try:
                message = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if not isinstance(message, dict):
                continue
            # Ignore anything that is not the reply to this one request; a
            # server is free to push events onto a connection at any time.
            if message.get("id") != "acct-1":
                continue
            if message.get("ok"):
                result = message.get("payload")
                return result if isinstance(result, dict) else {}
            error = message.get("error")
            code = "SERVER_ERROR"
            detail = "account request failed"
            if isinstance(error, dict):
                code = str(error.get("code") or code)
                detail = str(error.get("message") or detail)
            raise AccountError(code, detail)
