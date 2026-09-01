#!/usr/bin/env python3
"""Self-contained Backend Wire v1 fixture used by the packaged Plans spike.

The executable produced from this file deliberately imports only Python's
standard library.  stdout is reserved for compact protocol frames; diagnostics
belong on stderr.  The implementation mirrors the Node fixture's conformance
surface so a later shared corpus can exercise either language.
"""

from __future__ import annotations

import json
import math
import os
import queue
import re
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

PROTOCOL_REVISION = "2026-07-28"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId"
EVENT_FILTER_KEY = "dev.navide/pluginEvents"
MAX_FRAME_BYTES = 1_048_576
METHOD_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$")

SERVER_INFO = {"name": "navide.plans", "version": "0.1.92"}
_MISSING = object()
_write_lock = threading.Lock()
_state_lock = threading.Lock()
_pending_delays: dict[str, threading.Timer] = {}
_pending_delay_intents: set[str] = set()
_pre_cancelled_delays: set[str] = set()
_subscriptions: dict[str, dict[str, Any]] = {}
_bridge_pending: dict[str, queue.Queue[tuple[str, Any]]] = {}
_bridge_origin_ids: dict[str, set[str]] = {}
_cancelled_count = 0
_closing = False
_MAX_ROOT_ASCENT = 6


class DuplicateKeyError(ValueError):
    pass


class BridgeFailure(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(key)
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(value)


def _is_compact_json(text: str) -> bool:
    in_string = False
    escaped = False
    for character in text:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in " \t\r\n":
            return False
    return not in_string and not escaped


def parse_strict(line: bytes) -> Any:
    if not line or len(line) > MAX_FRAME_BYTES:
        raise ValueError("invalid frame size")
    text = line.decode("utf-8", errors="strict")
    if text.startswith("\ufeff") or not _is_compact_json(text):
        raise ValueError("invalid compact frame")
    return json.loads(
        text,
        object_pairs_hook=_object_pairs,
        parse_constant=_reject_constant,
    )


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _exact_keys(value: Any, keys: tuple[str, ...]) -> bool:
    return _is_record(value) and set(value) == set(keys) and len(value) == len(keys)


def _is_request_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) > 0
    ) or (
        isinstance(value, int)
        and not isinstance(value, bool)
    )


def _is_bridge_id(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("bridge:") and len(value) > len("bridge:")


def _is_bridge_origin(value: Any) -> bool:
    return (
        _exact_keys(value, ("kind", "requestId"))
        and value["kind"] in {"call", "subscription"}
        and _is_request_id(value["requestId"])
    )


def _origin_key(origin: dict[str, Any]) -> str:
    return f"{origin['kind']}:{type(origin['requestId']).__name__}:{origin['requestId']}"


def _is_json_value(value: Any) -> bool:
    if value is None or isinstance(value, (bool, str, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False


def _is_method_name(value: Any) -> bool:
    return isinstance(value, str) and METHOD_PATTERN.fullmatch(value) is not None


def _is_client_meta(value: Any) -> bool:
    if not _is_record(value):
        return False
    allowed = {
        "io.modelcontextprotocol/protocolVersion",
        "io.modelcontextprotocol/clientCapabilities",
        "io.modelcontextprotocol/clientInfo",
        "progressToken",
    }
    if any(key not in allowed for key in value):
        return False
    if value.get("io.modelcontextprotocol/protocolVersion") != PROTOCOL_REVISION:
        return False
    if not _is_record(value.get("io.modelcontextprotocol/clientCapabilities")):
        return False
    if "io.modelcontextprotocol/clientInfo" in value:
        client_info = value["io.modelcontextprotocol/clientInfo"]
        if not (
            _exact_keys(client_info, ("name", "version"))
            and isinstance(client_info["name"], str)
            and len(client_info["name"]) > 0
            and isinstance(client_info["version"], str)
            and len(client_info["version"]) > 0
        ):
            return False
    return "progressToken" not in value or _is_request_id(value["progressToken"])


def _is_runtime(value: Any) -> bool:
    return (
        _exact_keys(
            value,
            (
                "pluginId",
                "packageVersion",
                "workspaceId",
                "instanceId",
                "contributionKey",
                "hostWindowId",
                "initiator",
            ),
        )
        and isinstance(value["pluginId"], str)
        and len(value["pluginId"]) > 0
        and isinstance(value["packageVersion"], str)
        and len(value["packageVersion"]) > 0
        and all(
            value[key] is None or isinstance(value[key], str)
            for key in ("workspaceId", "instanceId", "contributionKey", "hostWindowId")
        )
        and _is_initiator(value["initiator"])
    )


def _is_initiator(value: Any) -> bool:
    if not _is_record(value):
        return False
    if value.get("kind") == "user":
        return (
            _exact_keys(value, ("kind", "id"))
            and isinstance(value["id"], str)
            and len(value["id"]) > 0
        )
    return (
        value.get("kind") == "agent"
        and value.get("source") == "mcp"
        and _exact_keys(value, ("kind", "source", "id"))
        and isinstance(value["id"], str)
        and len(value["id"]) > 0
    )


def _resolve_plan_root(workspace_path: str) -> str:
    """Mirror the core Plans root resolver without importing application code."""
    if not workspace_path:
        return workspace_path
    try:
        current = Path(workspace_path).resolve()
        if not current.is_dir():
            return workspace_path
    except OSError:
        return workspace_path

    try:
        stop = Path.home().resolve()
    except (OSError, RuntimeError):
        stop = None

    for _ in range(_MAX_ROOT_ASCENT + 1):
        if current == stop or current.parent == current:
            break
        if (current / ".git").exists():
            return str(current)
        current = current.parent
    return workspace_path


def _write_frame(frame: Any) -> None:
    encoded = json.dumps(
        frame,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    if b"\n" in encoded or b"\r" in encoded:
        raise ValueError("frame contains a line break")
    with _write_lock:
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()


def _write_raw(text: str) -> None:
    with _write_lock:
        sys.stdout.buffer.write(text.encode("utf-8"))
        sys.stdout.buffer.flush()


def _protocol_error(request_id: Any = _MISSING) -> None:
    frame: dict[str, Any] = {
        "jsonrpc": "2.0",
        "error": {"code": -32600, "message": "Invalid request"},
    }
    if request_id is not _MISSING and _is_request_id(request_id):
        frame["id"] = request_id
    _write_frame(frame)


def _response(request_id: Any, value: Any = _MISSING, subscription_id: Any = _MISSING) -> None:
    result: dict[str, Any] = {"resultType": "complete"}
    if value is not _MISSING:
        result["value"] = value
    metadata: dict[str, Any] = {SERVER_INFO_KEY: SERVER_INFO}
    if subscription_id is not _MISSING:
        metadata[SUBSCRIPTION_ID_KEY] = subscription_id
    result["_meta"] = metadata
    _write_frame({"jsonrpc": "2.0", "id": request_id, "result": result})


def _plugin_error(request_id: Any, code: str, message: str = "Plugin request failed") -> None:
    _write_frame(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": 1000, "message": message, "data": {"code": code}},
        }
    )


def _bridge_result(frame: Any) -> bool:
    if not _is_record(frame) or not _is_bridge_id(frame.get("id")):
        return False
    bridge_id = frame["id"]
    with _state_lock:
        response_queue = _bridge_pending.get(bridge_id)
    if response_queue is None:
        return True
    if _exact_keys(frame, ("jsonrpc", "id", "result")) and frame["jsonrpc"] == "2.0":
        result = frame["result"]
        if (
            _is_record(result)
            and result.get("resultType") == "complete"
            and _is_record(result.get("_meta"))
            and _is_record(result["_meta"].get(SERVER_INFO_KEY))
        ):
            response_queue.put(("result", result.get("value", _MISSING)))
        else:
            response_queue.put(("error", "PROTOCOL_ERROR"))
        return True
    if _is_record(frame.get("error")) and frame["jsonrpc"] == "2.0":
        error = frame["error"]
        data = error.get("data")
        code = data.get("code") if _is_record(data) else None
        response_queue.put(("error", code if isinstance(code, str) else "BACKEND_UNAVAILABLE"))
        return True
    response_queue.put(("error", "PROTOCOL_ERROR"))
    return True


def _bridge_event(frame: Any) -> bool:
    if not _is_record(frame) or frame.get("method") != "navide/host/event":
        return False
    if (
        not _exact_keys(frame, ("jsonrpc", "method", "params"))
        or frame["jsonrpc"] != "2.0"
        or not _exact_keys(frame["params"], ("origin", "event", "payload"))
        or not _is_bridge_origin(frame["params"]["origin"])
        or not _is_method_name(frame["params"]["event"])
        or not _is_json_value(frame["params"]["payload"])
    ):
        raise ValueError("invalid Host Bridge event")
    origin = frame["params"]["origin"]
    if origin["kind"] == "subscription" and frame["params"]["event"] == "filesystem.changed":
        _emit("plans.changed", frame["params"]["payload"], origin["requestId"])
    return True


def _bridge_cancel(bridge_id: str, code: str = "USER_CANCELLED") -> None:
    with _state_lock:
        response_queue = _bridge_pending.get(bridge_id)
    if response_queue is not None:
        try:
            response_queue.put_nowait(("error", code))
        except queue.Full:
            pass


def _bridge_cancel_for_origin(origin: dict[str, Any]) -> None:
    key = _origin_key(origin)
    with _state_lock:
        bridge_ids = list(_bridge_origin_ids.get(key, set()))
    for bridge_id in bridge_ids:
        _bridge_cancel(bridge_id)
        _write_frame(
            {
                "jsonrpc": "2.0",
                "method": "notifications/cancelled",
                "params": {"requestId": bridge_id, "reason": "cancelled"},
            }
        )


def _bridge_call(origin: dict[str, Any], port: str, operation: str, arguments: Any) -> Any:
    bridge_id = f"bridge:{uuid.uuid4().hex}"
    response_queue: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)
    key = _origin_key(origin)
    with _state_lock:
        _bridge_pending[bridge_id] = response_queue
        _bridge_origin_ids.setdefault(key, set()).add(bridge_id)
    try:
        _write_frame(
            {
                "jsonrpc": "2.0",
                "id": bridge_id,
                "method": "navide/host/call",
                "params": {
                    "origin": {"kind": origin["kind"], "requestId": origin["requestId"]},
                    "port": port,
                    "operation": operation,
                    "arguments": arguments,
                },
            }
        )
        while True:
            try:
                kind, value = response_queue.get(timeout=0.25)
            except queue.Empty:
                with _state_lock:
                    if _closing:
                        raise BridgeFailure("BACKEND_UNAVAILABLE")
                continue
            if kind == "error":
                raise BridgeFailure(str(value))
            return None if value is _MISSING else value
    finally:
        with _state_lock:
            _bridge_pending.pop(bridge_id, None)
            ids = _bridge_origin_ids.get(key)
            if ids is not None:
                ids.discard(bridge_id)
                if not ids:
                    _bridge_origin_ids.pop(key, None)


def _acknowledge(subscription: dict[str, Any]) -> None:
    _write_frame(
        {
            "jsonrpc": "2.0",
            "method": "notifications/subscriptions/acknowledged",
            "params": {
                "_meta": {SUBSCRIPTION_ID_KEY: subscription["id"]},
                "notifications": {EVENT_FILTER_KEY: subscription["events"]},
            },
        }
    )


def _emit(event: str, payload: Any, target_subscription_id: Any = _MISSING) -> None:
    with _state_lock:
        subscriptions = [
            dict(subscription)
            for subscription in _subscriptions.values()
            if event in subscription["events"]
            and subscription["acknowledged"]
            and (
                target_subscription_id is _MISSING
                or subscription["id"] == target_subscription_id
            )
        ]
    for subscription in subscriptions:
        _write_frame(
            {
                "jsonrpc": "2.0",
                "method": "notifications/navide/event",
                "params": {
                    "_meta": {SUBSCRIPTION_ID_KEY: subscription["id"]},
                    "event": event,
                    "payload": payload,
                },
            }
        )


def _delay(request_id: Any, milliseconds: float) -> None:
    key = str(request_id)

    def complete() -> None:
        with _state_lock:
            _pending_delays.pop(key, None)
            if _closing:
                return
        _response(request_id, {"delayed": True})

    timer = threading.Timer(max(0.0, milliseconds) / 1000.0, complete)
    timer.daemon = True
    with _state_lock:
        _pending_delay_intents.discard(key)
        if key in _pre_cancelled_delays:
            _pre_cancelled_delays.remove(key)
            return
        _pending_delays[key] = timer
    timer.start()


def _cancel(request_id: Any) -> None:
    global _cancelled_count
    key = str(request_id)
    with _state_lock:
        timer = _pending_delays.pop(key, None)
        if timer is not None:
            timer.cancel()
            _cancelled_count += 1
        elif key in _pending_delay_intents:
            _pending_delay_intents.remove(key)
            _pre_cancelled_delays.add(key)
            _cancelled_count += 1
        if _subscriptions.pop(key, None) is not None:
            _cancelled_count += 1
    if _is_bridge_id(request_id):
        _bridge_cancel(str(request_id))
        return
    if _is_request_id(request_id):
        _bridge_cancel_for_origin({"kind": "call", "requestId": request_id})
        _bridge_cancel_for_origin({"kind": "subscription", "requestId": request_id})


def _start_plan_watchers(root: str) -> None:
    with _state_lock:
        subscriptions = [
            subscription
            for subscription in _subscriptions.values()
            if "plans.changed" in subscription["events"] and not subscription["watch_started"]
        ]
        for subscription in subscriptions:
            subscription["watch_started"] = True
            subscription["workspace_path"] = root

    def watch(subscription: dict[str, Any]) -> None:
        origin = {"kind": "subscription", "requestId": subscription["id"]}
        try:
            _bridge_call(origin, "filesystem", "watch", {"rel_path": ""})
        except (BridgeFailure, BrokenPipeError):
            with _state_lock:
                current = _subscriptions.pop(str(subscription["id"]), None)
            if current is not None:
                _response(subscription["id"], subscription_id=subscription["id"])

    for subscription in subscriptions:
        thread = threading.Thread(target=watch, args=(subscription,), daemon=True)
        thread.start()


def _valid_request(frame: Any, method: str, params_keys: tuple[str, ...]) -> bool:
    return (
        _exact_keys(frame, ("jsonrpc", "id", "method", "params"))
        and frame["jsonrpc"] == "2.0"
        and _is_request_id(frame["id"])
        and frame["method"] == method
        and _exact_keys(frame["params"], params_keys)
        and _is_client_meta(frame["params"].get("_meta"))
    )


def _handle(frame: Any) -> None:
    if _bridge_result(frame) or _bridge_event(frame):
        return
    if (
        _is_record(frame)
        and frame.get("jsonrpc") == "2.0"
        and frame.get("method") == "notifications/cancelled"
    ):
        if (
            not _exact_keys(frame, ("jsonrpc", "method", "params"))
            or not _is_record(frame["params"])
            or "requestId" not in frame["params"]
            or any(key not in {"requestId", "reason"} for key in frame["params"])
            or not _is_request_id(frame["params"]["requestId"])
            or ("reason" in frame["params"] and not isinstance(frame["params"]["reason"], str))
        ):
            _protocol_error()
            return
        _cancel(frame["params"]["requestId"])
        return

    if _valid_request(frame, "navide/health", ("_meta",)):
        metadata = frame["params"]["_meta"]
        _response(
            frame["id"],
            {
                "method": "navide/health",
                "protocolVersion": metadata["io.modelcontextprotocol/protocolVersion"],
                "requestIdIsNonNull": frame["id"] is not None,
                "clientCapabilities": metadata["io.modelcontextprotocol/clientCapabilities"],
            },
        )
        return

    if _valid_request(
        frame,
        "subscriptions/listen",
        ("_meta", "notifications", "runtime"),
    ):
        notifications = frame["params"]["notifications"]
        runtime = frame["params"]["runtime"]
        if (
            not _exact_keys(notifications, (EVENT_FILTER_KEY,))
            or not isinstance(notifications[EVENT_FILTER_KEY], list)
            or not notifications[EVENT_FILTER_KEY]
            or len(set(notifications[EVENT_FILTER_KEY])) != len(notifications[EVENT_FILTER_KEY])
            or not all(_is_method_name(event) for event in notifications[EVENT_FILTER_KEY])
            or not _is_runtime(runtime)
        ):
            _protocol_error(frame["id"])
            return
        subscription = {
            "id": frame["id"],
            "events": list(notifications[EVENT_FILTER_KEY]),
            "acknowledged": True,
            "watch_started": False,
            "workspace_path": None,
        }
        with _state_lock:
            _subscriptions[str(frame["id"])] = subscription
        _acknowledge(subscription)
        return

    if not _valid_request(frame, "navide/call", ("_meta", "name", "arguments", "runtime")):
        _protocol_error(frame.get("id", _MISSING) if _is_record(frame) else _MISSING)
        return

    name = frame["params"]["name"]
    arguments = frame["params"]["arguments"]
    runtime = frame["params"]["runtime"]
    if not _is_method_name(name) or not _is_runtime(runtime) or not _is_json_value(arguments):
        _protocol_error(frame["id"])
        return

    if name == "plans.resolve_root":
        if not _is_record(arguments) or not isinstance(arguments.get("workspace_path"), str):
            _protocol_error(frame["id"])
            return
        try:
            root_result = _bridge_call(
                {"kind": "call", "requestId": frame["id"]},
                "filesystem",
                "resolve_root",
                {},
            )
            if not _is_record(root_result) or not isinstance(root_result.get("root"), str):
                raise BridgeFailure("PROTOCOL_ERROR")
            root = root_result["root"]
        except BridgeFailure as error:
            _plugin_error(frame["id"], error.code)
            return
        _response(frame["id"], {"ok": True, "root": root})
        _emit("plans.changed", {"workspace_path": root})
        _start_plan_watchers(root)
        return

    if name == "fixture.echo":
        _response(frame["id"], {"arguments": arguments, "runtime": runtime})
        return

    if name == "fixture.cancelcount":
        with _state_lock:
            count = _cancelled_count
        _response(frame["id"], count)
        return

    if name == "fixture.delay":
        milliseconds = (
            arguments.get("milliseconds", 100)
            if _is_record(arguments)
            else 100
        )
        if isinstance(milliseconds, bool) or not isinstance(milliseconds, (int, float)):
            milliseconds = 100
        _delay(frame["id"], float(milliseconds))
        return

    if name == "fixture.emit":
        requested_id = arguments.get("subscriptionId") if _is_record(arguments) else None
        with _state_lock:
            subscription = (
                _subscriptions.get(str(requested_id))
                if _is_request_id(requested_id)
                else next(iter(_subscriptions.values()), None)
            )
        event = arguments.get("event") if _is_record(arguments) else None
        payload = arguments.get("payload") if _is_record(arguments) else None
        if (
            subscription is None
            or not _is_record(arguments)
            or not _is_method_name(event)
            or not _is_json_value(payload)
        ):
            _protocol_error(frame["id"])
            return
        _write_frame(
            {
                "jsonrpc": "2.0",
                "method": "notifications/navide/event",
                "params": {
                    "_meta": {SUBSCRIPTION_ID_KEY: subscription["id"]},
                    "event": event,
                    "payload": payload,
                },
            }
        )
        _response(frame["id"], {"ok": True})
        return

    if name == "fixture.progress":
        requested_id = arguments.get("subscriptionId") if _is_record(arguments) else None
        with _state_lock:
            subscription = (
                _subscriptions.get(str(requested_id))
                if _is_request_id(requested_id)
                else next(iter(_subscriptions.values()), None)
            )
        if subscription is None:
            _protocol_error(frame["id"])
            return
        _write_frame(
            {
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": {
                    "progressToken": subscription["id"],
                    "progress": 1,
                    "total": 2,
                    "message": "fixture progress",
                },
            }
        )
        _response(frame["id"], {"ok": True})
        return

    if name == "fixture.close":
        requested_id = arguments.get("subscriptionId") if _is_record(arguments) else None
        with _state_lock:
            subscription = (
                _subscriptions.get(str(requested_id))
                if _is_request_id(requested_id)
                else next(iter(_subscriptions.values()), None)
            )
            if subscription is not None:
                _subscriptions.pop(str(subscription["id"]), None)
        if subscription is None:
            _protocol_error(frame["id"])
            return
        _response(subscription["id"], subscription_id=subscription["id"])
        _response(frame["id"], {"ok": True})
        return

    if name == "fixture.forgedevent":
        _write_frame(
            {
                "jsonrpc": "2.0",
                "method": "notifications/navide/event",
                "params": {
                    "_meta": {SUBSCRIPTION_ID_KEY: "forged-subscription"},
                    "event": "fixture.changed",
                    "payload": {"forged": True},
                },
            }
        )
        _response(frame["id"], {"ok": True})
        return

    if name == "fixture.duplicateevent":
        with _state_lock:
            subscription = next(iter(_subscriptions.values()), None)
        subscription_id = json.dumps(
            subscription["id"] if subscription is not None else "forged-subscription",
            separators=(",", ":"),
        )
        _write_raw(
            '{"jsonrpc":"2.0","method":"notifications/navide/event","params":'
            '{"_meta":{"io.modelcontextprotocol/subscriptionId":'
            + subscription_id
            + ',"io.modelcontextprotocol/subscriptionId":'
            + subscription_id
            + '},"event":"fixture.changed","payload":{}}}\n'
        )
        return

    if name == "fixture.unknownnotification":
        _write_frame({"jsonrpc": "2.0", "method": "notifications/unknown", "params": {}})
        return

    if name == "fixture.lateresponse":
        request_id = arguments.get("requestId") if _is_record(arguments) else None
        if not _is_request_id(request_id):
            _protocol_error(frame["id"])
            return
        _response(request_id, {"late": True})
        _response(frame["id"], {"ok": True})
        return

    if name == "fixture.exit":
        os._exit(17)

    if name == "fixture.stderr":
        sys.stderr.write("fixture diagnostic: /private/internal/path\n")
        sys.stderr.flush()
        _response(frame["id"], {"ok": True})
        return

    if name == "fixture.badversion":
        _write_raw(
            json.dumps(
                {
                    "jsonrpc": "2.1",
                    "id": frame["id"],
                    "result": {
                        "resultType": "complete",
                        "value": True,
                        "_meta": {SERVER_INFO_KEY: SERVER_INFO},
                    },
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        return

    if name == "fixture.duplicatekeys":
        _write_raw(
            '{"jsonrpc":"2.0","id":'
            + json.dumps(frame["id"], separators=(",", ":"))
            + ',"result":{"resultType":"complete","value":true,"_meta":{"'
            + SERVER_INFO_KEY
            + '":{"name":"navide.plans","version":"0.1.92"}}},"result":{}}\n'
        )
        return

    if name == "fixture.multiline":
        _write_raw('{"jsonrpc":"2.0",\n')
        _write_raw(
            json.dumps(
                {
                    "id": frame["id"],
                    "result": {
                        "resultType": "complete",
                        "value": True,
                        "_meta": {SERVER_INFO_KEY: SERVER_INFO},
                    },
                },
                separators=(",", ":"),
            )[1:-1]
            + "}\n"
        )
        return

    if name == "fixture.unknownmethod":
        _write_frame({"jsonrpc": "2.0", "id": frame["id"], "method": "tools/list", "params": {}})
        return

    if name == "fixture.forgedruntime":
        _write_frame(
            {
                "jsonrpc": "2.0",
                "id": frame["id"],
                "runtime": {"pluginId": "forged.plugin"},
                "result": {
                    "resultType": "complete",
                    "value": True,
                    "_meta": {SERVER_INFO_KEY: SERVER_INFO},
                },
            }
        )
        return

    _write_frame(
        {
            "jsonrpc": "2.0",
            "id": frame["id"],
            "error": {"code": -32601, "message": "Method not found"},
        }
    )


def _fail_closed() -> None:
    global _closing
    with _state_lock:
        _closing = True
        timers = list(_pending_delays.values())
        _pending_delays.clear()
        _pending_delay_intents.clear()
        _pre_cancelled_delays.clear()
        _subscriptions.clear()
    for timer in timers:
        timer.cancel()
    raise SystemExit(2)


def main() -> int:
    try:
        for raw in sys.stdin.buffer:
            if not raw.endswith(b"\n"):
                _fail_closed()
            frame = parse_strict(raw[:-1])
            if _is_record(frame) and frame.get("method") == "navide/call":
                params = frame.get("params")
                if (
                    _valid_request(frame, "navide/call", ("_meta", "name", "arguments", "runtime"))
                    and _is_record(params)
                    and params.get("name") == "fixture.delay"
                ):
                    with _state_lock:
                        _pending_delay_intents.add(str(frame["id"]))
                threading.Thread(target=_handle, args=(frame,), daemon=True).start()
            else:
                _handle(frame)
    except (UnicodeDecodeError, DuplicateKeyError, ValueError, json.JSONDecodeError):
        _fail_closed()
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
