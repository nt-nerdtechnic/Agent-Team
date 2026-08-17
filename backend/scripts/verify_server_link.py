"""End-to-end interface check: server_link.py against a *real* Navide-Server.

backend/tests/test_server_link.py runs against an in-process fake WebSocket we
wrote ourselves from the contract. A fake built from our reading of the contract
answers with our misreadings too, so it can only ever confirm that the code
agrees with itself. This script removes that circularity: it drives the real
``ServerLink`` — the same requests, the same reply parsing, the same push
handlers — against a running server, and checks what actually comes back.

Two links are opened for the *same member* on two different deviceIds, because
the server's identity model is a person and "one person, two machines" is the
case where a message can be echoed back to its own sender.

Sections 1-8 walk the happy path. Sections 9-14 are the boundaries a working
deployment actually meets: a message key that arrives twice, a policy that
refuses, a pane whose id changed under a cached hint, two devices discovering
each other's panes, a device that went offline, and the server itself going away
mid-session and coming back.

Usage (server must already be running)::

    NAVIDE_ADMIN_TOKEN=dev-token \
      uv --project backend run python backend/scripts/verify_server_link.py

Environment:
    NAVIDE_WS            WebSocket URL (default ws://localhost:8787/ws)
    NAVIDE_ADMIN_TOKEN   member credential to authenticate with (default dev-token)
    NAVIDE_SERVER_DIR    server checkout, used only by section 14 to run a
                         *disposable second instance* it may kill and restart
                         (default ~/Desktop/Navide-Server/server)
    NAVIDE_VERIFY_PORT   port for that disposable instance (default 8799)

Section 14 never touches the server under NAVIDE_WS: killing a shared instance
would take down whoever else is using it. It launches its own process, on its
own port, against its own throwaway database outside the server's repo.

It is deliberately *not* a pytest module: a test that needs a server running
somewhere else would fail the suite on every machine that does not have one.

Every run uses freshly generated deviceIds so repeated runs never inherit state
(a policy set by a previous run would hide "never configured" behaviour), and it
cleans up the session rows it created. It never writes to the server's repo.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import os
import secrets
import shutil
import socket
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_team_backend import (  # noqa: E402
    agent_messaging,
    app,
    device_identity,
    remote_roster,
    server_link,
)
from agent_team_backend.server_link import ServerLink, ServerLinkConfig  # noqa: E402

URL = os.environ.get("NAVIDE_WS") or "ws://localhost:8787/ws"
TOKEN = os.environ.get("NAVIDE_ADMIN_TOKEN") or "dev-token"
SERVER_DIR = Path(
    os.environ.get("NAVIDE_SERVER_DIR")
    or (Path.home() / "Desktop" / "Navide-Server" / "server")
)
VERIFY_PORT = int(os.environ.get("NAVIDE_VERIFY_PORT") or "8799")

WORKSPACE_PATH = "/tmp/navide-verify-ws"
WORKSPACE_LABEL = "navide-verify-ws"
PANE_ID = "verify-pane-1"
#: The id the same pane gets after a detach — section 11's stale-hint case.
PANE_ID_2 = "verify-pane-1-reattached"
PANE_NAME = "receiver"

# Per-run device ids. The server's DEVICE_ID_RE is [A-Za-z0-9._:-]{8,128}.
RUN = secrets.token_hex(4)
DEVICE_A = f"verify-a-{RUN}"
DEVICE_B = f"verify-b-{RUN}"
#: Section 14 only, against the disposable server.
DEVICE_C = f"verify-c-{RUN}"
DEVICE_D = f"verify-d-{RUN}"

#: The address every A→B message in sections 6-11 uses.
TO_B = {"deviceId": DEVICE_B, "workspace": WORKSPACE_LABEL, "paneName": PANE_NAME}
SENDER = {"workspace": WORKSPACE_LABEL, "paneName": "sender", "paneId": "verify-sender"}


def allow_a_policy(member_id: str, device_id: str = DEVICE_A) -> dict[str, Any]:
    """A policy letting exactly one device drive the verify pane."""
    return {
        "version": 1,
        "default": "deny",
        "rules": [
            {
                "from": {"memberId": member_id, "deviceId": device_id},
                "to": {"workspace": WORKSPACE_LABEL, "paneName": PANE_NAME},
                "action": "allow",
            }
        ],
    }

_passed = 0
_failed = 0


def check(cond: bool, label: str, extra: Any = None) -> bool:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ✓ {label}")
    else:
        _failed += 1
        detail = "" if extra is None else f"  -> {json.dumps(extra, ensure_ascii=False, default=str)}"
        print(f"  ✗ {label}{detail}")
    return cond


# ---- device identity --------------------------------------------------------

# ServerLink reads this machine's device id from device_identity at auth time,
# and there is only one of those per process. A ContextVar is what lets two
# links in one process each keep their own: asyncio.create_task and
# asyncio.to_thread both copy the current context, so the value set right before
# link.start() is the one that link keeps for every reconnect.
_current_device: contextvars.ContextVar[str] = contextvars.ContextVar("verify_device", default="")
_real_device_id = device_identity.device_id


def _device_id() -> str:
    return _current_device.get() or _real_device_id()


device_identity.device_id = _device_id  # type: ignore[assignment]


# ---- what actually reached a pane -------------------------------------------

# ServerLink hands an inbound message to the window that owns the pane by
# broadcasting agent_msg.deliver. No window is attached to this script, so that
# broadcast is both the proof a message was injected and — by its absence — the
# proof a refused one never was. Recorded here rather than inferred from acks:
# an ack says what this side decided, a broadcast says what it did.
_delivered: list[dict[str, Any]] = []
_real_broadcast = app.broadcast


async def _record_broadcast(event: Any, **kwargs: Any) -> None:
    if isinstance(event, dict) and event.get("type") == "agent_msg.deliver":
        _delivered.append(event.get("payload") or {})
    await _real_broadcast(event, **kwargs)


app.broadcast = _record_broadcast  # type: ignore[assignment]


def delivered(msg_key: str) -> list[dict[str, Any]]:
    return [p for p in _delivered if p.get("msg_key") == msg_key]


# ---- instrumentation --------------------------------------------------------


class Recorder:
    """Everything one link sent and everything the server pushed back."""

    def __init__(self, link: ServerLink, name: str) -> None:
        self.name = name
        self.calls: list[dict[str, Any]] = []
        self.pending: list[dict[str, Any]] = []
        self.acked: list[dict[str, Any]] = []
        self.directories: list[dict[str, Any]] = []

        original_request = link._request

        async def request(msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
            reply = await original_request(msg_type, payload)
            self.calls.append({"type": msg_type, "payload": payload, "reply": reply})
            return reply

        link._request = request  # type: ignore[method-assign]

        original_pending = link._on_message_pending

        async def on_pending(payload: Any) -> None:
            self.pending.append(payload if isinstance(payload, dict) else {})
            await original_pending(payload)

        link._on_message_pending = on_pending  # type: ignore[method-assign]

        original_acked = link._on_message_acked

        def on_acked(payload: Any) -> None:
            self.acked.append(payload if isinstance(payload, dict) else {})
            original_acked(payload)

        link._on_message_acked = on_acked  # type: ignore[method-assign]

        original_apply = link._apply_directory

        def on_directory(payload: Any) -> None:
            # Records both halves of the roster path: the one fetch per
            # connection and every sessions.changed push after it.
            self.directories.append(payload if isinstance(payload, dict) else {})
            original_apply(payload)

        link._apply_directory = on_directory  # type: ignore[method-assign]

    def last(self, msg_type: str) -> dict[str, Any] | None:
        for entry in reversed(self.calls):
            if entry["type"] == msg_type:
                return entry
        return None


async def until(predicate, label: str, timeout: float = 15.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    print(f"  ✗ timed out waiting for {label}")
    return False


async def open_link(device_id: str, name: str, url: str = "") -> tuple[ServerLink, Recorder]:
    target = url or URL
    link = ServerLink(
        config_loader=lambda: ServerLinkConfig(url=target, token=TOKEN),
        token_clearer=lambda: None,
        device_name=f"verify-{name}",
    )
    recorder = Recorder(link, name)
    _current_device.set(device_id)
    started = await link.start()
    if not started:
        raise SystemExit("ServerLink refused to start; check NAVIDE_WS / token")
    ok = await until(lambda: bool(link.member_id) or bool(link.terminated_reason), f"{name} auth")
    if not ok or link.terminated_reason:
        raise SystemExit(f"{name} failed to authenticate: {link.terminated_reason}")
    return link, recorder


# ---- a server this script is allowed to kill --------------------------------


def _port_open(port: int) -> bool:
    with contextlib.closing(socket.socket()) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


async def _wait_for_port(port: int, want_open: bool, timeout: float = 30.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if _port_open(port) is want_open:
            return True
        await asyncio.sleep(0.1)
    return False


class DisposableServer:
    """A second Navide-Server this script owns outright.

    Section 14 has to watch a link survive its server disappearing, and the only
    honest way to test that is to make one disappear. The instance under
    NAVIDE_WS is shared — taking it down would break whoever else is on it — so
    this starts a private one: own port, own database in a temp dir, never a
    write inside the server's checkout. `tsx` is invoked directly rather than
    through `npm start` so that terminating the process terminates the server
    rather than a wrapper that outlives it.
    """

    def __init__(self, port: int, db_dir: Path) -> None:
        self.port = port
        self.url = f"ws://localhost:{port}/ws"
        self._db = db_dir / "verify.db"
        self._proc: Any = None

    async def start(self) -> None:
        tsx = SERVER_DIR / "node_modules" / ".bin" / "tsx"
        if not tsx.exists():
            raise FileNotFoundError(f"{tsx} not found (set NAVIDE_SERVER_DIR)")
        if _port_open(self.port):
            raise RuntimeError(f"port {self.port} is already in use")
        self._proc = await asyncio.create_subprocess_exec(
            str(tsx),
            "src/index.ts",
            cwd=str(SERVER_DIR),
            env={
                **os.environ,
                "PORT": str(self.port),
                "NAVIDE_DB_PATH": str(self._db),
                "NAVIDE_ADMIN_TOKEN": TOKEN,
            },
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        if not await _wait_for_port(self.port, True):
            raise RuntimeError(f"the disposable server never listened on {self.port}")

    async def stop(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None or proc.returncode is not None:
            return
        proc.terminate()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), 10)
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        await _wait_for_port(self.port, False, timeout=10)


# ---- the checks -------------------------------------------------------------


async def main() -> int:
    print(f"== 目標 {URL} ==")
    print(f"   deviceA={DEVICE_A}  deviceB={DEVICE_B}")

    agent_messaging.register(PANE_ID, PANE_NAME, WORKSPACE_PATH, agent_key="claude")

    link_a, rec_a = await open_link(DEVICE_A, "A")
    link_b, rec_b = await open_link(DEVICE_B, "B")

    try:
        print("\n== 1. auth.hello ==")
        hello = rec_a.last("auth.hello")
        payload = (hello or {}).get("reply", {}).get("payload") or {}
        check(bool(hello) and hello["reply"].get("ok") is True, "帶 deviceId 的 auth.hello 被接受", hello)
        check(link_a.member_id == str(payload.get("memberId") or ""), "程式碼解析出的 memberId 與回應相符", payload)
        check(payload.get("deviceId") == DEVICE_A, "回應回帶同一個 deviceId", payload)
        check(
            all(k in payload for k in ("memberId", "role", "teamSpaceId", "displayName", "deviceId")),
            "回應欄位齊全（memberId/role/teamSpaceId/displayName/deviceId）",
            payload,
        )

        print("\n== 2. sessions.sync ==")
        await until(lambda: rec_a.last("sessions.sync") is not None, "A sessions.sync")
        sync = rec_a.last("sessions.sync") or {}
        sync_reply = sync.get("reply", {})
        sync_payload = sync_reply.get("payload") or {}
        check(sync_reply.get("ok") is True, "全量上報被接受", sync_reply)
        rows = sync_payload.get("sessions")
        check(isinstance(rows, list) and len(rows) == 1, "回應 sessions 是清單且長度相符", sync_payload)
        row = rows[0] if isinstance(rows, list) and rows else {}
        check(
            isinstance(row, dict) and bool(row.get("sessionId")) and row.get("paneId") == PANE_ID,
            "每列都帶 sessionId 與 paneId（程式碼靠這兩欄建表）",
            row,
        )
        check(isinstance(sync_payload.get("removed"), list), "回應帶 removed 清單", sync_payload)
        synced_id = link_a._session_ids.get(PANE_ID, "")
        check(bool(synced_id), "ServerLink 記下了 server 發的 sessionId", link_a._session_ids)

        print("\n== 3. sessions.upsert 自然鍵 (deviceId, paneId) ==")
        payload_for_pane = server_link._session_payload(agent_messaging.get(PANE_ID))
        link_a._session_ids.pop(PANE_ID, None)
        first_ok = await link_a._upsert(PANE_ID, payload_for_pane)
        first_id = link_a._session_ids.get(PANE_ID, "")
        link_a._session_ids.pop(PANE_ID, None)
        second_ok = await link_a._upsert(PANE_ID, payload_for_pane)
        second_id = link_a._session_ids.get(PANE_ID, "")
        check(first_ok and second_ok, "不帶 sessionId 的 upsert 被接受", rec_a.last("sessions.upsert"))
        check(
            bool(first_id) and first_id == second_id,
            "同一個 (deviceId, paneId) 兩次 upsert 對回同一列",
            {"first": first_id, "second": second_id},
        )
        check(
            bool(first_id) and first_id == synced_id,
            "自然鍵對回的正是 sessions.sync 建的那一列",
            {"upsert": first_id, "sync": synced_id},
        )
        # Same paneId on the other device must be a *different* row.
        payload_b = dict(payload_for_pane)
        link_b._session_ids.pop(PANE_ID, None)
        await link_b._upsert(PANE_ID, payload_b)
        check(
            link_b._session_ids.get(PANE_ID, "") not in ("", first_id),
            "另一台裝置的同一個 paneId 是不同列（自然鍵含 deviceId）",
            {"a": first_id, "b": link_b._session_ids.get(PANE_ID)},
        )

        print("\n== 4. sessions.remove ==")
        throwaway = f"verify-throwaway-{RUN}"
        await link_a._upsert(throwaway, dict(payload_for_pane, paneId=throwaway, title="throwaway"))
        removed_id = link_a._session_ids.get(throwaway, "")
        check(bool(removed_id), "先建立一筆待刪的 session", {"sessionId": removed_id})
        await link_a._remove(throwaway)
        directory = await link_a._request("sessions.directory", {})
        listed = (directory.get("payload") or {}).get("sessions") or []
        check(
            bool(removed_id)
            and removed_id not in [str(s.get("sessionId")) for s in listed if isinstance(s, dict)],
            "sessions.remove 之後那一列真的不在目錄裡",
            {"sessionId": removed_id},
        )
        check(throwaway not in link_a._session_ids, "ServerLink 也把本地映射清掉了", link_a._session_ids)

        print("\n== 5. policy.get（沒設過） ==")
        policy_call = rec_b.last("policy.get") or {}
        policy_payload = (policy_call.get("reply") or {}).get("payload") or {}
        check(
            policy_payload.get("revision") == 0,
            "沒設過的裝置回 revision 0",
            policy_payload,
        )
        check(
            policy_payload.get("policy") == {"version": 1, "default": "deny", "rules": []},
            "沒設過的裝置回空政策（deny-by-default）",
            policy_payload,
        )
        check(
            link_b._policy_revision == 0 and isinstance(link_b._policy, dict),
            "ServerLink 快取的 revision/policy 與回應相符",
            {"revision": link_b._policy_revision, "policy": link_b._policy},
        )

        # Grant device A permission to drive device B's pane, so the delivery
        # path below exercises "allowed" rather than stopping at the policy gate.
        set_reply = await link_a._request(
            "policy.set", {"deviceId": DEVICE_B, "policy": allow_a_policy(link_a.member_id)}
        )
        check(set_reply.get("ok") is True, "（前置）admin 為裝置 B 寫入允許政策", set_reply)
        await until(lambda: link_b._policy_revision == 1, "B 收到 policy.changed 並重抓")
        check(link_b._policy_revision == 1, "policy.changed 推播讓 B 的快取升到 revision 1")

        print("\n== 6/7. messages.send / messages.pending ==")
        msg_key = f"verify:{RUN}:{secrets.token_hex(4)}"
        send_reply = await link_a.send_message(
            to={"deviceId": DEVICE_B, "workspace": WORKSPACE_LABEL, "paneName": PANE_NAME},
            sender={"workspace": WORKSPACE_LABEL, "paneName": "sender", "paneId": "verify-sender"},
            text="hello from device A",
            msg_key=msg_key,
        )
        check(
            isinstance(send_reply, dict) and send_reply.get("ok") is True,
            "裝置 A 的 messages.send 被接受",
            send_reply,
        )
        check(
            (send_reply or {}).get("payload", {}).get("state") == "pending",
            "回應 state=pending",
            send_reply,
        )
        got = await until(lambda: any(m.get("msgKey") == msg_key for m in rec_b.pending), "B messages.pending")
        check(got, "裝置 B 真的收到 messages.pending")
        pushed = next((m for m in rec_b.pending if m.get("msgKey") == msg_key), {})
        check(
            isinstance(pushed.get("from"), dict) and isinstance(pushed.get("to"), dict),
            "推播帶 from/to 物件（程式碼靠它們做政策判斷與定址）",
            pushed,
        )
        check(
            (pushed.get("to") or {}).get("paneName") == PANE_NAME
            and (pushed.get("to") or {}).get("workspace") == WORKSPACE_LABEL,
            "推播的 to.workspace / to.paneName 原樣送達",
            pushed.get("to"),
        )
        check(pushed.get("text") == "hello from device A", "推播帶原文", pushed.get("text"))
        check(
            not any(m.get("msgKey") == msg_key for m in rec_a.pending),
            "裝置 A 沒有收到自己送出的訊息（迴圈防護）",
            rec_a.pending,
        )
        check(
            link_b._inbound.get(msg_key, {}).get("pane_id") == PANE_ID,
            "B 端把訊息解析到本機 pane（政策放行、位址解析成功）",
            link_b._inbound.get(msg_key),
        )

        print("\n== 8. messages.ack -> messages.acked ==")
        # This is the verdict the receiving window reports over agent_msg.delivered;
        # no window is attached to this script, so it is injected at that seam.
        claimed = link_b.note_delivery_result(msg_key, True, json.dumps({"key": "ok"}))
        check(claimed, "B 把投遞結果認領為這條連線的訊息")
        await until(lambda: any(m.get("msgKey") == msg_key for m in rec_a.acked), "A messages.acked")
        acked = next((m for m in rec_a.acked if m.get("msgKey") == msg_key), {})
        check(bool(acked), "裝置 A 收到 messages.acked", rec_a.acked)
        check(acked.get("state") == "delivered", "acked 帶 state=delivered", acked)
        check(acked.get("ackPaneId") == PANE_ID, "acked 帶 ackPaneId（收端解析到的 pane）", acked)

        print("\n== 9. 重複 msgKey 只注入一次 ==")
        # The server stores messages with INSERT OR REPLACE and pushes on every
        # send, so a repeated key really does arrive twice — the dedupe under
        # test is the receiver's, and this is the only place it meets a real one.
        dup_key = f"verify:{RUN}:dup"
        first = await link_a.send_message(to=TO_B, sender=SENDER, text="once only", msg_key=dup_key)
        check(isinstance(first, dict) and first.get("ok") is True, "第一次送出被接受", first)
        check(await until(lambda: len(delivered(dup_key)) == 1, "第一次注入"), "第一次確實注入到 pane")
        second = await link_a.send_message(to=TO_B, sender=SENDER, text="once only", msg_key=dup_key)
        check(
            isinstance(second, dict) and second.get("ok") is True,
            "同一個 msgKey 再送一次 server 仍接受（去重責任在收端）",
            second,
        )
        pushed_twice = await until(
            lambda: len([m for m in rec_b.pending if m.get("msgKey") == dup_key]) == 2,
            "B 第二次收到 messages.pending",
        )
        check(pushed_twice, "server 真的推播了兩次（否則這條沒有驗到去重）")
        await asyncio.sleep(0.5)
        check(len(delivered(dup_key)) == 1, "重複的 msgKey 只注入一次", delivered(dup_key))

        print("\n== 10. 政策拒絕／允許的真實往返 ==")
        deny_set = await link_a._request(
            "policy.set",
            {
                "deviceId": DEVICE_B,
                "policy": {
                    "version": 1,
                    "default": "deny",
                    # A well-formed rule that simply does not name device A.
                    "rules": [
                        {
                            "from": {"memberId": link_a.member_id, "deviceId": f"{DEVICE_A}-other"},
                            "to": {"workspace": WORKSPACE_LABEL, "paneName": PANE_NAME},
                            "action": "allow",
                        }
                    ],
                },
            },
        )
        check(deny_set.get("ok") is True, "（前置）把 B 的政策改成只允許別的裝置", deny_set)
        check(
            await until(lambda: link_b._policy_revision == 2, "B 的政策升到 revision 2"),
            "policy.changed 讓 B 換上新政策",
        )
        denied_key = f"verify:{RUN}:denied"
        denied_send = await link_a.send_message(
            to=TO_B, sender=SENDER, text="should be refused", msg_key=denied_key
        )
        check(
            isinstance(denied_send, dict) and denied_send.get("ok") is True,
            "server 仍接受送出（政策是收端的事，不是 server 的）",
            denied_send,
        )
        check(
            await until(
                lambda: any(m.get("msgKey") == denied_key for m in rec_a.acked), "A 收到拒絕的 acked"
            ),
            "拒絕會回報給發送端",
        )
        denied_ack = next((m for m in rec_a.acked if m.get("msgKey") == denied_key), {})
        # rejected, not failed: an agent that cannot tell them apart retries a
        # permission refusal forever.
        check(denied_ack.get("state") == "rejected", "acked 是 rejected 不是 failed", denied_ack)
        check(denied_ack.get("reason") == "policy-denied", "acked 帶 reason=policy-denied", denied_ack)
        check(delivered(denied_key) == [], "被拒的訊息完全沒有廣播給 renderer", delivered(denied_key))

        allow_set = await link_a._request(
            "policy.set", {"deviceId": DEVICE_B, "policy": allow_a_policy(link_a.member_id)}
        )
        check(allow_set.get("ok") is True, "（前置）把 B 的政策改回允許 A", allow_set)
        check(
            await until(lambda: link_b._policy_revision == 3, "B 的政策升到 revision 3"),
            "policy.changed 讓 B 換回允許政策",
        )
        allowed_key = f"verify:{RUN}:allowed"
        await link_a.send_message(to=TO_B, sender=SENDER, text="now allowed", msg_key=allowed_key)
        check(
            await until(lambda: len(delivered(allowed_key)) == 1, "允許後的訊息被注入"),
            "同一條路徑在政策允許時真的送達",
        )
        link_b.note_delivery_result(allowed_key, True, json.dumps({"key": "ok"}))
        check(
            await until(
                lambda: any(m.get("msgKey") == allowed_key for m in rec_a.acked), "A 收到 acked"
            ),
            "允許的往返也回報給發送端",
        )
        allowed_ack = next((m for m in rec_a.acked if m.get("msgKey") == allowed_key), {})
        check(allowed_ack.get("state") == "delivered", "acked 是 delivered", allowed_ack)

        print("\n== 11. paneId hint 失效後重新解析 ==")
        # A detach or reattach mints a new pane id, so a sender's cached hint
        # goes stale while the address itself stays correct.
        agent_messaging.unregister(PANE_ID)
        agent_messaging.register(PANE_ID_2, PANE_NAME, WORKSPACE_PATH, agent_key="claude")
        stale_key = f"verify:{RUN}:stale"
        await link_a.send_message(
            to=dict(TO_B, paneId=PANE_ID), sender=SENDER, text="find me anyway", msg_key=stale_key
        )
        check(
            await until(
                lambda: any(m.get("msgKey") == stale_key for m in rec_b.pending),
                "B 收到帶舊 paneId 的推播",
            ),
            "帶 hint 的訊息送達收端",
        )
        stale_push = next((m for m in rec_b.pending if m.get("msgKey") == stale_key), {})
        check(
            (stale_push.get("to") or {}).get("paneId") == PANE_ID,
            "server 原樣轉發 to.paneId（hint 真的有到收端，這條才有意義）",
            stale_push.get("to"),
        )
        check(
            await until(lambda: len(delivered(stale_key)) == 1, "重新解析後注入"),
            "失效的 hint 沒有讓投遞失敗",
        )
        check(
            delivered(stale_key) and delivered(stale_key)[0].get("target_pane_id") == PANE_ID_2,
            "重新解析到新的 pane id",
            delivered(stale_key),
        )
        link_b.note_delivery_result(stale_key, True, json.dumps({"key": "ok"}))
        check(
            await until(
                lambda: any(m.get("msgKey") == stale_key for m in rec_a.acked), "A 收到 acked"
            ),
            "重新解析後的結果回報給發送端",
        )
        stale_ack = next((m for m in rec_a.acked if m.get("msgKey") == stale_key), {})
        check(
            stale_ack.get("ackPaneId") == PANE_ID_2,
            "ack 把新的 pane id 回帶給發送端（快取才更新得了）",
            stale_ack,
        )

        print("\n== 12. 遠端名冊：兩台裝置互相看得見對方的 pane ==")
        # The half stage 2 left out. Without it an agent can address
        # `<device>/<workspace>/<pane>` but has no way to learn that any device
        # or pane exists, so the whole cross-device path needs a human to paste
        # a device id in.
        check(bool(rec_a.directories), "連線建立時就抓過一次 sessions.directory")
        before = len(rec_a.directories)
        # Nudge both reporters: this script has no ws_handlers calling
        # server_link.roster_changed(), so nothing else would push before the
        # 30s sweep.
        link_a.notify_roster_changed()
        link_b.notify_roster_changed()

        def _both_devices_listed() -> bool:
            if len(rec_a.directories) <= before:
                return False
            rows = (rec_a.directories[-1] or {}).get("sessions") or []
            listed = {str(r.get("deviceId") or "") for r in rows if isinstance(r, dict)}
            return {DEVICE_A, DEVICE_B} <= listed

        check(
            await until(_both_devices_listed, "A 收到含兩台裝置的 sessions.changed"),
            "名冊變更由 server 主動推播（不必輪詢）",
        )
        rows = [r for r in ((rec_a.directories[-1] or {}).get("sessions") or []) if isinstance(r, dict)]
        row_b = next((r for r in rows if r.get("deviceId") == DEVICE_B), {})
        check(
            all(
                key in row_b
                for key in ("deviceId", "workspace", "workspacePath", "paneId", "title", "status", "hostOnline")
            ),
            "目錄每一列都帶定址與狀態需要的欄位",
            row_b,
        )
        check(row_b.get("hostOnline") is True, "B 在線時它的列 hostOnline=true", row_b)
        # deviceName is what lets a person address a machine by a name instead of
        # copying a UUID, so it is asserted rather than merely noted: the server
        # joins it in from the devices table, and a regression there would show
        # up as addressing silently falling back to device ids.
        check(
            row_b.get("deviceName") == "verify-B",
            "目錄帶 deviceName（auth.hello 報的那個名字，經 devices 表 join 回來）",
            row_b.get("deviceName"),
        )

        # Both directions, from one snapshot: the only difference between the
        # two views is which device is "me".
        remote_roster.replace(rows, local_device_id=DEVICE_A)
        a_view = {p.address for p in remote_roster.list_panes()}
        check(
            not any(p.device_id == DEVICE_A for p in remote_roster.list_panes()),
            "A 的遠端名冊不含自己的 pane（本機那份在 agent_messaging）",
            sorted(a_view),
        )
        check(
            f"{DEVICE_B}/{WORKSPACE_LABEL}/{PANE_NAME}" in a_view,
            "A 看得到 B 上的 pane，位址可直接複製去送",
            sorted(a_view),
        )
        remote_roster.replace(rows, local_device_id=DEVICE_B)
        b_view = {p.address for p in remote_roster.list_panes()}
        check(
            f"{DEVICE_A}/{WORKSPACE_LABEL}/{PANE_NAME}" in b_view,
            "B 也看得到 A 上的 pane",
            sorted(b_view),
        )

        remote_roster.replace(rows, local_device_id=DEVICE_A)
        target = f"{DEVICE_B}/{WORKSPACE_LABEL}/{PANE_NAME}"
        check(
            agent_messaging.parse_target(target).device_id == "",
            "（前提）非 UUID 形狀的 deviceId 舊的形狀判定認不出來",
        )
        match = agent_messaging.parse_remote_target(target)
        check(
            match.address is not None and match.address.device_id == DEVICE_B,
            "名冊讓這個位址解析得出裝置（形狀判定之外的第二次解讀）",
            {"error": match.error},
        )
        # The point of deviceName: a person addresses "the laptop", not a UUID.
        named = agent_messaging.parse_remote_target(
            f"verify-B/{WORKSPACE_LABEL}/{PANE_NAME}"
        )
        check(
            named.address is not None and named.address.device_id == DEVICE_B,
            "人類可讀的裝置名解析到同一台裝置（使用者不必複製 UUID）",
            {"error": named.error},
        )
        # The server stores the name exactly as auth.hello reported it and never
        # resolves anything by it, so the case a person types is ours to forgive.
        cased = agent_messaging.parse_remote_target(
            f"VeRiFy-b/{WORKSPACE_LABEL}/{PANE_NAME}"
        )
        check(
            cased.address is not None and cased.address.device_id == DEVICE_B,
            "裝置名大小寫不同也解析得到（server 原樣存名字，比對規則由本機定）",
            {"error": cased.error},
        )
        # One assertion guarding two layers, which is why it is here and not
        # only in test_remote_roster.py — do not remove it as a duplicate.
        #
        #   application: an id is opaque and machine-minted, so folding its case
        #   could only ever make two distinct devices collide.
        #   storage: the id arrives from the server's directory. A MySQL schema
        #   on a *_ci collation returns rows for a query that differs only in
        #   case, and the roster would then answer for a device nobody asked
        #   for. SQLite is always binary, so a local run cannot see this at all.
        #
        # Against the production server this is the check that proves the
        # deployment's collation, not just this module's comparison.
        wrong_case_id = DEVICE_B.upper()
        folded = agent_messaging.parse_remote_target(
            f"{wrong_case_id}/{WORKSPACE_LABEL}/{PANE_NAME}"
        )
        check(
            folded.address is None,
            "deviceId 大小寫不同「不」該解析得到（id 精確比對；在 *_ci collation 的 MySQL 上會失敗）",
            {"queried": wrong_case_id, "resolved": folded.address.device_id if folded.address else None},
        )

        # A device leaving changes no session row, so only presence.changed
        # reports it — without that push the roster would keep saying B is
        # reachable. Stopping B here also sets up section 13.
        await link_b.stop()
        check(
            await until(
                lambda: bool(remote_roster.list_panes())
                and all(p.offline for p in remote_roster.list_panes() if p.device_id == DEVICE_B),
                "A 的名冊把 B 的 pane 標成離線",
            ),
            "presence.changed 讓離線裝置的 pane 立刻變成 offline",
            sorted((p.address, p.host_online, p.status) for p in remote_roster.list_panes()),
        )
        # B is gone, so it can no longer clean up after itself; this member is
        # an admin, so A removes its rows instead of leaving them on a shared
        # server.
        for row_left in rows:
            if row_left.get("deviceId") == DEVICE_B and row_left.get("sessionId"):
                await link_a._request("sessions.remove", {"sessionId": row_left["sessionId"]})
        remote_roster._reset_for_test()

        print("\n== 13. DEVICE_OFFLINE ==")
        # link_b was stopped and its rows removed at the end of section 12.
        await asyncio.sleep(0.6)
        offline_reply = await link_a.send_message(
            to={"deviceId": DEVICE_B, "workspace": WORKSPACE_LABEL, "paneName": PANE_NAME},
            sender=None,
            text="you are gone",
            msg_key=f"verify:{RUN}:offline",
        )
        check(
            isinstance(offline_reply, dict) and offline_reply.get("ok") is False,
            "對已離線裝置送出被拒",
            offline_reply,
        )
        check(
            ((offline_reply or {}).get("error") or {}).get("code") == "DEVICE_OFFLINE",
            "錯誤碼是 DEVICE_OFFLINE",
            offline_reply,
        )
    finally:
        with_cleanup = [link_a]
        for link in with_cleanup:
            try:
                await link._request("sessions.sync", {"sessions": []})
            except Exception as err:  # noqa: BLE001
                print(f"  (cleanup) sessions.sync failed: {err}")
        await link_a.stop()
        await link_b.stop()
        agent_messaging._reset_for_test()

    await check_server_outage()

    print(f"\n== 結果：{_passed} 通過 / {_failed} 失敗 ==")
    return 1 if _failed else 0


async def check_server_outage() -> None:
    """Section 14: the server disappears mid-session, then comes back.

    Runs against its own disposable instance, so the shared one under NAVIDE_WS
    is never taken down. Everything here is about a *configured* link: the
    no-server-configured path is a different branch entirely and is covered by
    backend/tests (it must never reach this module at all).
    """
    print("\n== 14. Server 中途斷線與自動恢復 ==")
    if not SERVER_DIR.exists():
        check(False, f"找不到 server 目錄 {SERVER_DIR}（用 NAVIDE_SERVER_DIR 指定）")
        return

    db_dir = Path(tempfile.mkdtemp(prefix="navide-verify-db-"))
    disposable = DisposableServer(VERIFY_PORT, db_dir)
    link_c: ServerLink | None = None
    link_d: ServerLink | None = None
    try:
        try:
            await disposable.start()
        except Exception as err:  # noqa: BLE001
            check(False, f"無法啟動可拋棄的 server：{err}")
            return
        check(True, f"在 port {VERIFY_PORT} 起了一台自己的 server（不動 {URL}）")

        agent_messaging.register(PANE_ID, PANE_NAME, WORKSPACE_PATH, agent_key="claude")
        link_c, _ = await open_link(DEVICE_C, "C", disposable.url)
        link_d, rec_d = await open_link(DEVICE_D, "D", disposable.url)
        granted = await link_c._request(
            "policy.set",
            {"deviceId": DEVICE_D, "policy": allow_a_policy(link_c.member_id, DEVICE_C)},
        )
        check(granted.get("ok") is True, "（前置）允許 C 驅動 D 的 pane", granted)
        await until(lambda: link_d._policy_revision == 1, "D 收到政策")

        to_d = {"deviceId": DEVICE_D, "workspace": WORKSPACE_LABEL, "paneName": PANE_NAME}

        cached_policy = link_d._policy

        await disposable.stop()
        check(
            await until(lambda: link_c._ws is None, "C 察覺連線斷了"),
            "server 消失後連線狀態被清掉",
        )
        # t6/t12: an authorization decision must not depend on the control plane
        # being reachable at the moment a message lands.
        check(
            link_d._policy == cached_policy and link_d._policy_revision == 1,
            "斷線期間 D 的政策快取原封不動（仍可判斷處理中的訊息）",
            {"revision": link_d._policy_revision},
        )

        loop = asyncio.get_running_loop()
        started_at = loop.time()
        down_reply = await asyncio.wait_for(
            link_c.send_message(
                to=to_d, sender=SENDER, text="while down", msg_key=f"verify:{RUN}:down"
            ),
            timeout=5.0,
        )
        elapsed = loop.time() - started_at
        check(
            isinstance(down_reply, dict) and down_reply.get("ok") is False,
            "斷線期間送出直接失敗",
            down_reply,
        )
        # The point of the whole exercise: a connection problem must not come
        # back looking like a bad address.
        check(
            ((down_reply or {}).get("error") or {}).get("code") == server_link.LINK_OFFLINE,
            "錯誤碼是 LINK_OFFLINE（不是 unknown-device，也不是 server 的拒絕）",
            down_reply,
        )
        check(
            elapsed < 1.0,
            f"而且是立刻失敗：{elapsed:.2f}s（不是 {server_link.REQUEST_TIMEOUT_S:.0f}s 逾時）",
        )

        await disposable.start()
        # No one restarts the link: the reconnect backoff is the only thing that
        # can change the answer, and this is the check that it does.
        recovered = await until(
            lambda: bool(link_c and link_c._authenticated and link_d and link_d._authenticated),
            "C/D 自己重連並重新認證",
            timeout=90.0,
        )
        check(recovered, "server 回來後兩條連線都自動接回（沒有人手動介入）")
        if not recovered:
            return

        resume_key = f"verify:{RUN}:resumed"
        resumed = await link_c.send_message(
            to=to_d, sender=SENDER, text="after recovery", msg_key=resume_key
        )
        check(
            isinstance(resumed, dict) and resumed.get("ok") is True,
            "恢復後同一條 link 又送得出去",
            resumed,
        )
        check(
            await until(lambda: len(delivered(resume_key)) == 1, "恢復後的訊息被注入"),
            "恢復是完整的：訊息真的送進收端 pane，不只是連線接回來",
        )
        check(
            bool(rec_d.pending) and link_d._policy_revision == 1,
            "重連後政策重新抓回同一個 revision，收端仍照原政策放行",
            {"revision": link_d._policy_revision},
        )
    finally:
        for link in (link_c, link_d):
            if link is not None:
                with contextlib.suppress(Exception):
                    await link._request("sessions.sync", {"sessions": []})
                await link.stop()
        await disposable.stop()
        shutil.rmtree(db_dir, ignore_errors=True)
        agent_messaging._reset_for_test()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
