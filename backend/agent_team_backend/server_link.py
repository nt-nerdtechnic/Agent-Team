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
import platform
import time
from dataclasses import dataclass
from typing import Any, Callable

import websockets

from . import agent_messaging, device_identity, pane_policy, remote_roster

log = logging.getLogger("agent_team_backend.server_link")

#: ui_settings key holding the Navide-Server WebSocket URL (e.g.
#: ``ws://localhost:8787/ws``). Empty or absent means "no server configured",
#: which keeps this whole module inert. It lives in ui_settings rather than a
#: private store so the Settings UI can write it through the existing
#: ``ui.settings.set`` handler without new plumbing.
SERVER_URL_SETTING = "agentTeam.p2p.serverUrl"

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

#: ``sessions.upsert`` accepts exactly these three values and rejects anything
#: else with BAD_REQUEST, so the registry's own vocabulary (busy / idle /
#: offline) is renamed here rather than sent through. The mapping is one to one,
#: so nothing the roster knows is lost: mid-turn is "running", waiting for input
#: is "waiting", and a pane whose window has disconnected is "disconnected" —
#: transient, not terminal. That distinction is the remote half of the local
#: target-offline code: the pane is still there and expected back once its
#: window reconnects. Reporting it as "waiting" would be indistinguishable from
#: a healthy idle pane, and "exited" would claim the session ended when it has
#: not.
STATUS_BUSY = "running"
STATUS_IDLE = "waiting"
STATUS_OFFLINE = "disconnected"

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
    from . import app

    value = app.ui_settings_store.get().get(SERVER_URL_SETTING)
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
        self._tasks: set[asyncio.Task] = set()
        self._device_id = ""
        self.member_id = ""
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
        self.member_id = str(payload.get("memberId") or "")
        log.info(
            "navide-server link authenticated as member %s (%s) for device %s",
            self.member_id or "unknown",
            payload.get("displayName") or "",
            payload.get("deviceId") or "",
        )

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
        self._policy = payload.get("policy")
        self._policy_revision = raw_revision if isinstance(raw_revision, int) else 0
        log.info("navide-server pane policy is at revision %s", self._policy_revision)

    def policy_snapshot(self) -> dict[str, Any]:
        """The cached policy and the revision it came at, for the editor UI.

        Reads the cache rather than the server: the cache is what actually
        decides every inbound message, and it survives a disconnect, so the
        editor can still show the rules that are refusing messages while the
        link is down.
        """
        return {"policy": self._policy, "revision": self._policy_revision}

    async def set_policy(self, policy: Any) -> dict[str, Any]:
        """Write this device's policy to the server and adopt the new revision.

        Same shape as ``send_message``: the server's reply frame, or a locally
        minted error frame naming the link state when the write cannot leave
        this machine. Only the device itself (or an admin) may write its policy,
        so there is no target to name beyond our own deviceId.
        """
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        try:
            reply = await self._request(
                "policy.set", {"deviceId": self._device_id, "policy": policy}
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
            else:
                # No revision to pin the cache to — re-read rather than guess,
                # since a cache pinned to the wrong revision would ignore the
                # very push that would have corrected it.
                await self._refresh_policy()
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

        Note the rows carry no ``deviceName`` today: the server stores one per
        device (from ``auth.hello``) but does not join it into the session
        directory, so the only human-readable label available here is the
        device id. ``remote_roster`` reads the field anyway, so a server that
        starts sending it lights this up with no change on this side.
        """
        data = payload if isinstance(payload, dict) else {}
        sessions = data.get("sessions")
        remote_roster.replace(
            sessions if isinstance(sessions, list) else [],
            local_device_id=self._device_id,
        )

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
        remote_roster.set_online_devices(
            {
                str(device.get("deviceId") or "")
                for device in devices
                if isinstance(device, dict)
            }
        )

    # ---- messages ----

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
        payload: dict[str, Any] = {"to": to, "text": text, "msgKey": msg_key}
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

    def _note_inbound(self, msg_key: str) -> bool:
        """Claim a msgKey. False means it was already handled — drop it.

        The server pushes ``messages.pending`` to every connection it holds for
        this device. That is one connection in the steady state, but a backend
        restart can leave the old socket open a moment after the new one is up,
        and then the same message arrives twice.
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
        self._inbound[msg_key] = {"created_at": now, "pane_id": "", "acked": False}
        return True

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
        if not self._note_inbound(msg_key):
            log.info("navide-server re-sent message %s; ignoring the duplicate", msg_key)
            return

        source = data.get("from") if isinstance(data.get("from"), dict) else {}
        target = data.get("to") if isinstance(data.get("to"), dict) else {}
        workspace = str(target.get("workspace") or "")
        pane_name = str(target.get("paneName") or "")

        await self._ensure_policy()
        # The addressed workspace/paneName are checked, not the resolved pane's:
        # resolution happens after this. `paneName` is matched exactly by the
        # resolver, so it is already the pane's real name; only a workspace
        # written as a longer path suffix ("nest/proj" for the pane labelled
        # "proj") can read differently, and it can only fail to match a rule.
        if not pane_policy.is_allowed(
            self._policy,
            member_id=str(source.get("memberId") or ""),
            device_id=str(source.get("deviceId") or ""),
            workspace=workspace,
            pane_name=pane_name,
        ):
            log.warning(
                "pane policy denied message %s from device %s to %s/%s",
                msg_key,
                source.get("deviceId"),
                workspace,
                pane_name,
            )
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

        self._inbound[msg_key]["pane_id"] = result.pane.pane_id
        await self._deliver(msg_key, result.pane, source, str(data.get("text") or ""))

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
        from .plugins.builtin.navide_plans import plan_mcp

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


async def set_policy(policy: Any) -> dict[str, Any] | None:
    """Write this device's pane policy, or None when no server is configured.

    None means the same thing it means for ``send_message``: this machine never
    had a server, so there is no policy anywhere to write. Every other failure
    is a reply frame carrying LINK_OFFLINE or LINK_UNAUTHORIZED.
    """
    if _link is None:
        return None
    return await _link.set_policy(policy)


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
