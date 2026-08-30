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
import re
import sys
import threading
from pathlib import Path
from typing import Any

PROTOCOL_REVISION = "2026-07-28"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId"
EVENT_FILTER_KEY = "dev.navide/pluginEvents"
MAX_FRAME_BYTES = 1_048_576
METHOD_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$")
_MAX_ROOT_ASCENT = 6

SERVER_INFO = {"name": "navide.plans", "version": "0.1.92"}
_MISSING = object()
_write_lock = threading.Lock()
_state_lock = threading.Lock()
_pending_delays: dict[str, threading.Timer] = {}
_subscriptions: dict[str, dict[str, Any]] = {}
_cancelled_count = 0
_closing = False


class DuplicateKeyError(ValueError):
    pass


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
    )


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


def _emit(event: str, payload: Any) -> None:
    with _state_lock:
        subscriptions = [
            dict(subscription)
            for subscription in _subscriptions.values()
            if event in subscription["events"] and subscription["acknowledged"]
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


def _resolve_plan_root(workspace_path: str) -> str:
    """Mirror ``plan_index.resolve_plan_root`` for the packaged test child.

    This is intentionally a small standalone copy because the PyInstaller
    fixture cannot import the application backend package. Keep the algorithm
    and ``_MAX_ROOT_ASCENT`` in parity with
    ``backend/agent_team_backend/plan_index.py``; the backend test suite runs a
    shared corpus against both implementations.
    """
    if not workspace_path:
        return workspace_path
    try:
        current = Path(workspace_path).resolve()
        if not current.is_dir():
            return workspace_path
    except (OSError, RuntimeError):
        return workspace_path

    try:
        home = Path.home().resolve()
    except (OSError, RuntimeError):
        home = None
    for _ in range(_MAX_ROOT_ASCENT + 1):
        if current == home or current.parent == current:
            break
        if (current / ".git").exists():
            return str(current)
        current = current.parent
    return workspace_path


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
        if _subscriptions.pop(key, None) is not None:
            _cancelled_count += 1


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
        root = _resolve_plan_root(arguments["workspace_path"])
        _response(frame["id"], {"ok": True, "root": root})
        _emit("plans.changed", {"workspace_path": root})
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
        _subscriptions.clear()
    for timer in timers:
        timer.cancel()
    raise SystemExit(2)


def main() -> int:
    try:
        for raw in sys.stdin.buffer:
            if not raw.endswith(b"\n"):
                _fail_closed()
            _handle(parse_strict(raw[:-1]))
    except (UnicodeDecodeError, DuplicateKeyError, ValueError, json.JSONDecodeError):
        _fail_closed()
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
