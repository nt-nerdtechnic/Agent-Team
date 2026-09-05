"""Production ``navide.plans`` Backend Wire v1 child.

The executable is intentionally self-contained.  It owns plan-domain parsing
and mutation, while every workspace effect is a Host-private
``navide/host/call`` through the authenticated filesystem bridge.  stdout is
reserved for compact protocol frames; diagnostics belong on stderr.
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
from datetime import datetime, timezone
from html import escape as html_escape
from typing import Any

import yaml

PROTOCOL_REVISION = "2026-07-28"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId"
EVENT_FILTER_KEY = "dev.navide/pluginEvents"
MAX_FRAME_BYTES = 1_048_576
METHOD_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$")
PLAN_META_RE = re.compile(
    r"<script\b[^>]*\s(?:id=\"plan-meta\"|id='plan-meta')[^>]*>([\s\S]*?)</script>",
    re.IGNORECASE,
)
STAGE_PILL_RE = re.compile(
    r"(<span\b[^>]*\bclass=[\"'][^\"']*\bpill\b)([^\"']*)([\"'][^>]*>)[^<]*(</span>)",
    re.IGNORECASE,
)
TODO_ROW_RE = re.compile(
    r"(<li\b[^>]*\bdata-status=[\"'])([^\"']+)([\"'][^>]*\bdata-todo-id=[\"'])([^\"']+)([\"'][^>]*>)",
    re.IGNORECASE,
)
TODO_STATUS_SPAN_RE = re.compile(
    r"(<span\b[^>]*\bclass=[\"'][^\"']*\bst\b[^\"']*[\"'][^>]*>)[^<]*(</span>)",
    re.IGNORECASE,
)
TODO_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]*$")
NOTE_ID_RE = re.compile(r"^n(\d+)$")
PLAN_STAGES = {"draft", "in-review", "approved", "in-progress", "done", "abandoned"}
TODO_STATUSES = {"pending", "in-progress", "done", "skipped"}
TODO_OWNERS = {"user", "agent"}
PLAN_REL_DIR = ".agent-team/plans"
PLAN_DOC_DIRS: tuple[str, ...] = (
    ".agent-team/plans",
    ".agent-team/reports",
    ".claude/loop-reports",
    ".claude/plans",
    ".cursor/plans",
    "docs/plans",
    "docs/reports",
)
DOC_SUFFIXES = (".html", ".plan.md", ".md")
_MAX_ROOT_DEPTH = 2
_MAX_NESTED_ROOTS = 50
_MAX_DIRECTORY_ENTRIES = 2000
_NOISE_SEGMENTS = frozenset({
    "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
    "target", ".next", ".nuxt", ".turbo", ".cache", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".idea", ".gradle",
})


def is_plan_doc_name(name: str) -> bool:
    if not isinstance(name, str) or name.startswith(("_", ".")):
        return False
    lowered = name.lower()
    return any(lowered.endswith(suffix) for suffix in DOC_SUFFIXES)

_MISSING = object()
_write_lock = threading.Lock()
_state_lock = threading.Lock()
_closing = False
_subscriptions: dict[str, dict[str, Any]] = {}
_bridge_pending: dict[str, queue.Queue[tuple[str, Any]]] = {}
_bridge_origin_ids: dict[str, set[str]] = {}
_bridge_watch_origins: set[str] = set()

SERVER_INFO = {"name": "navide.plans", "version": "0.1.0"}


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


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _exact_keys(value: Any, keys: tuple[str, ...]) -> bool:
    return _is_record(value) and set(value) == set(keys) and len(value) == len(keys)


def _is_request_id(value: Any) -> bool:
    return (isinstance(value, str) and bool(value)) or (
        isinstance(value, int) and not isinstance(value, bool)
    )


def _is_bridge_id(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("bridge:") and len(value) > 7


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
            and bool(client_info["name"])
            and isinstance(client_info["version"], str)
            and bool(client_info["version"])
        ):
            return False
    return "progressToken" not in value or _is_request_id(value["progressToken"])


def _is_initiator(value: Any) -> bool:
    if not _is_record(value):
        return False
    if value.get("kind") == "user":
        return _exact_keys(value, ("kind", "id")) and isinstance(value["id"], str) and bool(value["id"])
    return (
        value.get("kind") == "agent"
        and value.get("source") == "mcp"
        and _exact_keys(value, ("kind", "source", "id"))
        and isinstance(value["id"], str)
        and bool(value["id"])
    )


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
        and bool(value["pluginId"])
        and isinstance(value["packageVersion"], str)
        and bool(value["packageVersion"])
        and all(
            value[key] is None or isinstance(value[key], str)
            for key in ("workspaceId", "instanceId", "contributionKey", "hostWindowId")
        )
        and _is_initiator(value["initiator"])
    )


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


def _parse_strict(line: bytes) -> Any:
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


def _write_frame(frame: Any) -> None:
    encoded = json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if b"\n" in encoded or b"\r" in encoded:
        raise ValueError("frame contains a line break")
    with _write_lock:
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()


def _protocol_error(request_id: Any = _MISSING) -> None:
    frame: dict[str, Any] = {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid request"}}
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


def _plugin_error(request_id: Any, code: str) -> None:
    _write_frame(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": 1000,
                "message": "Plugin request failed.",
                "data": {"code": code},
            },
        }
    )


def _origin_key(origin: dict[str, Any]) -> str:
    return f"{origin['kind']}:{type(origin['requestId']).__name__}:{origin['requestId']}"


def _subscription_key(request_id: Any) -> str:
    return _origin_key({"kind": "subscription", "requestId": request_id})


def _deliver_bridge_result(response_queue: queue.Queue[tuple[str, Any]], kind: str, value: Any) -> None:
    try:
        response_queue.put_nowait((kind, value))
    except queue.Full:
        # Cancellation and a Host response may cross in flight. The first
        # terminal result wins; a duplicate must not crash the child.
        pass


def _bridge_result(frame: Any) -> bool:
    if not _is_record(frame) or not _is_bridge_id(frame.get("id")):
        return False
    bridge_id = frame["id"]
    with _state_lock:
        response_queue = _bridge_pending.get(bridge_id)
    if response_queue is None:
        return True
    if (
        _exact_keys(frame, ("jsonrpc", "id", "result"))
        and frame["jsonrpc"] == "2.0"
        and _is_record(frame["result"])
        and frame["result"].get("resultType") == "complete"
        and _is_record(frame["result"].get("_meta"))
        and _is_record(frame["result"]["_meta"].get(SERVER_INFO_KEY))
    ):
        _deliver_bridge_result(response_queue, "result", frame["result"].get("value", _MISSING))
        return True
    if _is_record(frame.get("error")) and frame.get("jsonrpc") == "2.0":
        data = frame["error"].get("data")
        code = data.get("code") if _is_record(data) else None
        _deliver_bridge_result(
            response_queue,
            "error",
            code if isinstance(code, str) else "BACKEND_UNAVAILABLE",
        )
        return True
    _deliver_bridge_result(response_queue, "error", "PROTOCOL_ERROR")
    return True


def _bridge_event(frame: Any) -> bool:
    if not _is_record(frame) or frame.get("method") != "navide/host/event":
        return False
    params = frame.get("params")
    if (
        not _exact_keys(frame, ("jsonrpc", "method", "params"))
        or frame["jsonrpc"] != "2.0"
        or not _exact_keys(params, ("origin", "event", "payload"))
        or not _is_record(params["origin"])
        or not _exact_keys(params["origin"], ("kind", "requestId"))
        or params["origin"].get("kind") not in {"call", "subscription"}
        or not _is_request_id(params["origin"].get("requestId"))
        or not _is_method_name(params["event"])
        or not _is_json_value(params["payload"])
    ):
        raise ValueError("invalid Host Bridge event")
    if params["origin"]["kind"] == "subscription" and params["event"] == "filesystem.changed":
        _emit("plans.changed", params["payload"], params["origin"]["requestId"])
    return True


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


def _emit(event: str, payload: Any, target_subscription_id: Any = _MISSING) -> None:
    with _state_lock:
        subscriptions = [
            dict(subscription)
            for subscription in _subscriptions.values()
            if event in subscription["events"]
            and subscription["acknowledged"]
            and (target_subscription_id is _MISSING or subscription["id"] == target_subscription_id)
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


def _cancel(request_id: Any) -> None:
    if isinstance(request_id, str) and request_id.startswith("bridge:"):
        with _state_lock:
            response_queue = _bridge_pending.get(request_id)
        if response_queue is not None:
            _deliver_bridge_result(response_queue, "error", "USER_CANCELLED")
        return
    key = _subscription_key(request_id)
    with _state_lock:
        subscription = _subscriptions.pop(key, None)
        bridge_ids = list(_bridge_origin_ids.get(f"call:{type(request_id).__name__}:{request_id}", set()))
        bridge_ids += list(_bridge_origin_ids.get(f"subscription:{type(request_id).__name__}:{request_id}", set()))
    if subscription is not None:
        _bridge_watch_origins.discard(_origin_key({"kind": "subscription", "requestId": request_id}))
    for bridge_id in bridge_ids:
        with _state_lock:
            response_queue = _bridge_pending.get(bridge_id)
        if response_queue is not None:
            _deliver_bridge_result(response_queue, "error", "USER_CANCELLED")
        try:
            _write_frame(
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/cancelled",
                    "params": {"requestId": bridge_id, "reason": "cancelled"},
                }
            )
        except BrokenPipeError:
            return


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


def _start_watch(subscription: dict[str, Any]) -> None:
    origin = {"kind": "subscription", "requestId": subscription["id"]}
    origin_key = _origin_key(origin)
    with _state_lock:
        if origin_key in _bridge_watch_origins:
            return
        _bridge_watch_origins.add(origin_key)

    def watch() -> None:
        try:
            _bridge_call(origin, "filesystem", "watch", {"rel_path": ""})
        except (BridgeFailure, BrokenPipeError):
            with _state_lock:
                current = _subscriptions.pop(_subscription_key(subscription["id"]), None)
            if current is not None:
                try:
                    _response(subscription["id"], subscription_id=subscription["id"])
                except BrokenPipeError:
                    pass
        finally:
            _bridge_watch_origins.discard(origin_key)

    threading.Thread(target=watch, daemon=True).start()


def _bridge_read(origin: dict[str, Any], rel_path: str, include_mtime: bool = False) -> tuple[str, float | None]:
    arguments: dict[str, Any] = {"rel_path": rel_path}
    if include_mtime:
        arguments["include_mtime"] = True
    result = _bridge_call(origin, "filesystem", "read_file", arguments)
    if not _is_record(result) or not isinstance(result.get("content"), str):
        raise BridgeFailure("PROTOCOL_ERROR")
    mtime = result.get("mtime")
    if mtime is not None and (isinstance(mtime, bool) or not isinstance(mtime, (int, float))):
        raise BridgeFailure("PROTOCOL_ERROR")
    return result["content"], float(mtime) if mtime is not None else None


def _bridge_write(origin: dict[str, Any], rel_path: str, content: str, expected_mtime: float | None = None) -> float | None:
    arguments: dict[str, Any] = {"rel_path": rel_path, "content": content}
    if expected_mtime is not None:
        arguments["expected_mtime"] = expected_mtime
    result = _bridge_call(origin, "filesystem", "write_file", arguments)
    if not _is_record(result) or result.get("ok") is not True:
        if _is_record(result) and result.get("conflict") is True:
            raise BridgeFailure("CONFLICT")
        raise BridgeFailure("BACKEND_UNAVAILABLE")
    mtime = result.get("mtime")
    return float(mtime) if isinstance(mtime, (int, float)) and not isinstance(mtime, bool) else None


def _plan_path(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BridgeFailure("INVALID_ARGUMENT")
    cleaned = value.strip().replace("\\", "/")
    if cleaned.startswith("/") or (len(cleaned) >= 3 and cleaned[1:3] == ":/"):
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
    segments = cleaned.split("/")
    if any(seg in ("", ".", "..") for seg in segments):
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")

    if len(segments) == 1:
        filename = segments[0]
        if not is_plan_doc_name(filename):
            raise BridgeFailure("INVALID_ARGUMENT")
        return f"{PLAN_REL_DIR}/{filename}"

    filename = segments[-1]
    parent = "/".join(segments[:-1])
    if not is_plan_doc_name(filename):
        raise BridgeFailure("INVALID_ARGUMENT")

    matched = False
    for plan_dir in PLAN_DOC_DIRS:
        if parent == plan_dir or parent.endswith("/" + plan_dir):
            matched = True
            break
    if not matched:
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")

    return cleaned


def _parse_plan_meta(content: str) -> dict[str, Any] | None:
    match = PLAN_META_RE.search(content)
    if not match:
        return _parse_markdown_meta(content)
    try:
        meta = json.loads(match.group(1).strip())
    except (ValueError, TypeError):
        return None
    if not _is_record(meta) or meta.get("schemaVersion") != 1 or not isinstance(meta.get("name"), str) or not meta["name"].strip():
        return None
    normalized = dict(meta)
    if normalized.get("stage") not in PLAN_STAGES:
        normalized["stage"] = "draft"
    todos = normalized.get("todos")
    normalized["todos"] = todos if isinstance(todos, list) else []
    notes = normalized.get("reviewNotes")
    normalized["reviewNotes"] = notes if isinstance(notes, list) else []
    return normalized


def _normalize_todo_status(value: Any) -> str:
    if not isinstance(value, str):
        return "pending"
    v = value.strip().lower().replace("_", "-")
    if v in ("done", "completed", "complete", "finished"):
        return "done"
    if v in ("in-progress", "inprogress", "active"):
        return "in-progress"
    if v in ("skipped", "skip"):
        return "skipped"
    return "pending"


def _parse_markdown_meta(content: str) -> dict[str, Any] | None:
    if not content.startswith("---"):
        return None
    end = content.find("\n---", 3)
    if end < 0:
        return None
    try:
        parsed = yaml.safe_load(content[3:end])
    except yaml.YAMLError:
        return None
    if not isinstance(parsed, dict):
        return None
    name = parsed.get("name") if isinstance(parsed.get("name"), str) else parsed.get("title")
    if not isinstance(name, str) or not name.strip():
        return None

    raw_todos = parsed.get("todos")
    todos: list[dict[str, Any]] = []
    if isinstance(raw_todos, list):
        for idx, item in enumerate(raw_todos):
            if isinstance(item, str):
                todos.append({"id": f"t{idx + 1}", "content": item, "status": "pending"})
            elif isinstance(item, dict):
                todo_id = str(item.get("id") or f"t{idx + 1}")
                content_str = str(item.get("content") or "")
                status_str = _normalize_todo_status(item.get("status"))
                entry = dict(item)
                entry["id"] = todo_id
                entry["content"] = content_str
                entry["status"] = status_str
                todos.append(entry)

    raw_stage = parsed.get("stage")
    if isinstance(raw_stage, str) and raw_stage in PLAN_STAGES:
        stage = raw_stage
    else:
        stage = "done" if (todos and all(t.get("status") == "done" for t in todos)) else "draft"

    fields = dict(parsed)
    fields["schemaVersion"] = 1
    fields["name"] = name.strip()
    fields["stage"] = stage
    fields["overview"] = parsed.get("overview") if isinstance(parsed.get("overview"), str) else (
        parsed.get("description") if isinstance(parsed.get("description"), str) else ""
    )
    fields["approvedAt"] = parsed.get("approvedAt") if isinstance(parsed.get("approvedAt"), str) else None
    fields["archivedAt"] = parsed.get("archivedAt") if isinstance(parsed.get("archivedAt"), str) else None
    fields["todos"] = todos
    fields["reviewNotes"] = parsed.get("reviewNotes") if isinstance(parsed.get("reviewNotes"), list) else []
    return fields


def _write_plan_meta(content: str, meta: dict[str, Any]) -> str:
    match = PLAN_META_RE.search(content)
    block = json.dumps(meta, ensure_ascii=False, indent=2).replace("<", "\\u003c")
    if match is None:
        return f'<script type="application/json" id="plan-meta">\n{block}\n</script>\n{content}'
    return f"{content[:match.start(1)]}\n{block}\n{content[match.end(1):]}"


def _write_markdown_meta(content: str, meta: dict[str, Any]) -> str:
    """Replace or prepend YAML frontmatter while preserving the markdown body."""
    end = content.find("\n---", 3) if content.startswith("---") else -1
    body = content[end + 4 :] if end >= 0 else content
    frontmatter = yaml.safe_dump(
        meta,
        allow_unicode=True,
        default_flow_style=False,
        sort_keys=False,
    ).rstrip("\n")
    separator = "" if body.startswith("\n") else "\n"
    return f"---\n{frontmatter}\n---{separator}{body}"


def _write_meta_for_path(
    rel_path: str,
    content: str,
    meta: dict[str, Any],
    *,
    stage: str | None = None,
    todo_id: str | None = None,
    todo_status: str | None = None,
) -> str:
    if not rel_path.endswith(".html"):
        return _write_markdown_meta(content, meta)
    updated = _write_plan_meta(content, meta)
    if stage is not None:
        updated = _sync_stage_markup(updated, stage)
    if todo_id is not None and todo_status is not None:
        updated = _sync_todo_markup(updated, todo_id, todo_status)
    return updated


def _todo_summary(meta: dict[str, Any]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    total = 0
    for todo in meta.get("todos", []):
        if not _is_record(todo):
            continue
        total += 1
        status = todo.get("status") if isinstance(todo.get("status"), str) else "unknown"
        counts[status or "unknown"] = counts.get(status or "unknown", 0) + 1
    return {"total": total, "by_status": counts}


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:60].rstrip("-") or "plan"


def _normalize_todos(value: Any, status: str = "pending") -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise BridgeFailure("INVALID_ARGUMENT")
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        owner = ""
        if isinstance(item, str):
            todo_id, text = "", item
        elif _is_record(item):
            todo_id, text = str(item.get("id") or ""), str(item.get("content") or "")
            owner = str(item.get("owner") or "")
        else:
            raise BridgeFailure("INVALID_ARGUMENT")
        text = text.strip()
        todo_id = todo_id.strip() or f"t{index + 1}"
        if (
            not text
            or TODO_ID_RE.fullmatch(todo_id) is None
            or todo_id in seen
            or (owner and owner not in TODO_OWNERS)
        ):
            raise BridgeFailure("INVALID_ARGUMENT")
        seen.add(todo_id)
        entry = {"id": todo_id, "content": text, "status": status}
        if owner == "user":
            entry["owner"] = owner
        result.append(entry)
    return result


def _sync_stage_markup(content: str, stage: str) -> str:
    def replace(match: re.Match[str]) -> str:
        classes = match.group(2)
        classes = re.sub(r"\b(?:draft|in-review|approved|in-progress|done|abandoned)\b", stage, classes)
        return f"{match.group(1)}{classes}{match.group(3)}{stage}{match.group(4)}"

    return STAGE_PILL_RE.sub(replace, content, count=1)


def _sync_todo_markup(content: str, todo_id: str, status: str) -> str:
    def replace(match: re.Match[str]) -> str:
        if match.group(4) != todo_id:
            return match.group(0)
        return f"{match.group(1)}{status}{match.group(3)}{match.group(4)}{match.group(5)}"

    updated = TODO_ROW_RE.sub(replace, content)
    row_re = re.compile(
        rf"(<li\b[^>]*\bdata-todo-id=[\"']{re.escape(todo_id)}[\"'][^>]*>)([\s\S]*?)(</li>)",
        re.IGNORECASE,
    )

    def replace_status_span(match: re.Match[str]) -> str:
        return f"{match.group(1)}{status}{match.group(2)}"

    return row_re.sub(
        lambda match: (
            f"{match.group(1)}"
            f"{TODO_STATUS_SPAN_RE.sub(replace_status_span, match.group(2), count=1)}"
            f"{match.group(3)}"
        ),
        updated,
        count=1,
    )


def _find_nested_plan_roots(origin: dict[str, Any]) -> list[str]:
    found: list[str] = []
    frontier: list[tuple[str, int]] = [("", 0)]
    while frontier and len(found) < _MAX_NESTED_ROOTS:
        current_rel, depth = frontier.pop(0)
        if depth >= _MAX_ROOT_DEPTH:
            continue
        try:
            listing = _bridge_call(origin, "filesystem", "list_dir", {"rel_path": current_rel, "mode": "discovery"})
        except BridgeFailure:
            continue
        entries = listing.get("entries") if _is_record(listing) else None
        if not isinstance(entries, list):
            continue
        # If truncated is True, the listing was capped by Host at _MAX_DIRECTORY_ENTRIES (2000).
        # We also enforce candidates[:_MAX_DIRECTORY_ENTRIES] defensively.
        candidates = sorted(
            (
                name
                for name in entries
                if isinstance(name, str)
                and not name.startswith(".")
                and name not in _NOISE_SEGMENTS
            ),
            key=lambda s: s.encode("utf-8"),
        )[:_MAX_DIRECTORY_ENTRIES]
        for name in candidates:
            if len(found) >= _MAX_NESTED_ROOTS:
                break
            child_rel = f"{current_rel}/{name}" if current_rel else name
            try:
                stat = _bridge_call(origin, "filesystem", "stat_path", {"rel_path": child_rel})
                if not _is_record(stat) or stat.get("exists") is not True or stat.get("isDirectory") is not True:
                    continue
                git_stat = _bridge_call(origin, "filesystem", "stat_path", {"rel_path": f"{child_rel}/.git"})
                if _is_record(git_stat) and git_stat.get("exists") is True and git_stat.get("isDirectory") is True:
                    found.append(child_rel)
                else:
                    frontier.append((child_rel, depth + 1))
            except BridgeFailure:
                continue
    return found


def _list_plans(origin: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _scan_dir(rel_dir: str) -> None:
        try:
            stat = _bridge_call(origin, "filesystem", "stat_path", {"rel_path": rel_dir})
            if not _is_record(stat) or stat.get("exists") is not True:
                return
            listing = _bridge_call(origin, "filesystem", "list_dir", {"rel_path": rel_dir})
            names = listing.get("entries") if _is_record(listing) else None
            if not isinstance(names, list):
                return
        except BridgeFailure as error:
            if error.code == "BACKEND_UNAVAILABLE":
                return
            raise
        for name in sorted((n for n in names if isinstance(n, str)), key=lambda s: s.lower()):
            if not is_plan_doc_name(name):
                continue
            rel_path = f"{rel_dir}/{name}"
            if rel_path in seen:
                continue
            seen.add(rel_path)
            try:
                content, mtime = _bridge_read(origin, rel_path, include_mtime=True)
                meta = _parse_plan_meta(content)
            except BridgeFailure:
                continue
            entries.append(
                {
                    "rel_path": rel_path,
                    "name": meta.get("name") if meta is not None else name,
                    "stage": meta.get("stage") if meta is not None else None,
                    "overview": meta.get("overview", "") if meta is not None else "",
                    "todos": _todo_summary(meta) if meta is not None else {"total": 0, "by_status": {}},
                    "mtime": mtime,
                    "kind": "plan" if meta is not None else "document",
                    "meta": meta,
                }
            )

    for rel_dir in PLAN_DOC_DIRS:
        _scan_dir(rel_dir)

    for nested_root in _find_nested_plan_roots(origin):
        for plan_dir in PLAN_DOC_DIRS:
            _scan_dir(f"{nested_root}/{plan_dir}")

    return entries


def _read_plan(origin: dict[str, Any], rel_path: Any) -> dict[str, Any]:
    normalized = _plan_path(rel_path)
    content, mtime = _bridge_read(origin, normalized, include_mtime=True)
    return {"rel_path": normalized, "meta": _parse_plan_meta(content), "html": content, "mtime": mtime}


def _load_for_write(origin: dict[str, Any], rel_path: Any) -> tuple[str, str, dict[str, Any], float]:
    normalized = _plan_path(rel_path)
    content, mtime = _bridge_read(origin, normalized, include_mtime=True)
    meta = _parse_plan_meta(content)
    if meta is None or mtime is None:
        raise BridgeFailure("INVALID_ARGUMENT")
    return normalized, content, meta, mtime


def _create_plan(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    name = arguments.get("name")
    overview = arguments.get("overview", "")
    stage = arguments.get("stage", "draft")
    if (
        not isinstance(name, str)
        or not name.strip()
        or not isinstance(overview, str)
        or stage not in PLAN_STAGES
    ):
        raise BridgeFailure("INVALID_ARGUMENT")
    todos = _normalize_todos(arguments.get("todos"), "done" if stage == "done" else "pending")
    slug = _slug(name.strip())
    # A random suffix keeps concurrent agent creates independent without an
    # existence probe that could become a side channel across workspaces.
    for _ in range(16):
        filename = f"{slug}_{uuid.uuid4().hex[:6]}.html"
        rel_path = f"{PLAN_REL_DIR}/{filename}"
        try:
            _bridge_read(origin, rel_path)
        except BridgeFailure as error:
            if error.code == "BACKEND_UNAVAILABLE":
                break
            raise
    else:
        raise BridgeFailure("RESOURCE_LIMIT")
    template, _ = _bridge_read(origin, f"{PLAN_REL_DIR}/_template.html")
    content = template
    replacements = {
        "{{PLAN_NAME}}": html_escape(name.strip()),
        "{{ONE_SENTENCE_OVERVIEW}}": html_escape(overview.strip()),
        "{{PHASE_A_TITLE}}": "Todos",
    }
    for source, replacement in replacements.items():
        content = content.replace(source, replacement)
    content = re.sub(r"\{\{[^{}]*\}\}", "TBD", content)
    if "data-todo-id=" in content:
        rows = "\n".join(
            f'<li data-status="{todo["status"]}" data-todo-id="{html_escape(todo["id"])}">'
            f'<span class="st">{todo["status"]}</span> <span>{html_escape(todo["content"])}</span></li>'
            for todo in todos
        )
        content = re.sub(r"<li\b[^>]*data-todo-id=[\"']phase-a[\"'][^>]*>[\s\S]*?</li>", rows, content, count=1)
    meta = {
        "schemaVersion": 1,
        "name": name.strip(),
        "overview": overview.strip(),
        "stage": stage,
        "approvedAt": (
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            if stage in {"approved", "in-progress", "done"}
            else None
        ),
        "todos": todos,
        "reviewNotes": [],
    }
    _bridge_write(origin, rel_path, _write_meta_for_path(rel_path, content, meta, stage=stage))
    return {"rel_path": rel_path, "name": name.strip(), "stage": stage}


def _update_stage(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    stage = arguments.get("stage")
    if stage not in PLAN_STAGES:
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    meta["stage"] = stage
    if stage == "approved":
        meta["approvedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _bridge_write(origin, rel_path, _write_meta_for_path(rel_path, content, meta, stage=stage), mtime)
    return {"stage": stage, "approvedAt": meta.get("approvedAt")}


def _update_todo(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    status = arguments.get("status")
    todo_id = arguments.get("todo_id")
    owner = arguments.get("owner", "")
    if (
        status not in TODO_STATUSES
        or not isinstance(todo_id, str)
        or not todo_id
        or owner not in {"", *TODO_OWNERS}
    ):
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    target = next((todo for todo in meta["todos"] if _is_record(todo) and todo.get("id") == todo_id), None)
    if target is None:
        raise BridgeFailure("INVALID_ARGUMENT")
    target["status"] = status
    if owner == "user":
        target["owner"] = owner
    elif owner == "agent":
        target.pop("owner", None)
    updated = _write_meta_for_path(
        rel_path,
        content,
        meta,
        todo_id=todo_id,
        todo_status=status,
    )
    _bridge_write(origin, rel_path, updated, mtime)
    return dict(target)


def _add_note(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    text = arguments.get("text")
    author = arguments.get("author", "ai")
    if not isinstance(text, str) or not text.strip() or author not in {"user", "ai"}:
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    notes = meta["reviewNotes"]
    max_num = 0
    for note in notes:
        if _is_record(note):
            match = NOTE_ID_RE.fullmatch(str(note.get("id") or ""))
            if match:
                max_num = max(max_num, int(match.group(1)))
    note = {"id": f"n{max_num + 1}", "author": author, "text": text.strip(), "resolved": False, "reply": ""}
    notes.append(note)
    _bridge_write(origin, rel_path, _write_meta_for_path(rel_path, content, meta), mtime)
    return note


def _manual_review_note(origin: dict[str, Any], arguments: dict[str, Any], action: str) -> dict[str, Any]:
    # Retained PlanStore retries one optimistic-lock conflict against fresh
    # bytes. The mutation (including a new note id) must be recomputed too.
    for attempt in range(2):
        try:
            return _manual_review_note_once(origin, arguments, action)
        except BridgeFailure as error:
            if error.code != "CONFLICT" or attempt == 1:
                raise
    raise AssertionError("unreachable")


def _manual_review_note_once(origin: dict[str, Any], arguments: dict[str, Any], action: str) -> dict[str, Any]:
    required = {
        "add": {"rel_path", "text", "anchor"}, "edit": {"rel_path", "note_id", "text"},
        "resolve": {"rel_path", "note_id"}, "delete": {"rel_path", "note_id"},
    }[action]
    if set(arguments) != required:
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    notes = meta["reviewNotes"]
    if action == "add":
        text = arguments.get("text")
        if not isinstance(text, str) or not text.strip():
            raise BridgeFailure("INVALID_ARGUMENT")
        max_num = max((int(match.group(1)) for note in notes if _is_record(note) and (match := NOTE_ID_RE.fullmatch(str(note.get("id") or "")))), default=0)
        anchor = arguments.get("anchor")
        if not isinstance(anchor, str):
            raise BridgeFailure("INVALID_ARGUMENT")
        note = {"id": f"n{max_num + 1}", "author": "user", "text": text.strip(), "resolved": False, "reply": "", "anchor": anchor}
        notes.append(note)
    else:
        note_id = arguments.get("note_id")
        if not isinstance(note_id, str) or not note_id:
            raise BridgeFailure("INVALID_ARGUMENT")
        note = next((item for item in notes if _is_record(item) and item.get("id") == note_id), None)
        if note is None:
            raise BridgeFailure("INVALID_ARGUMENT")
        if action == "edit":
            text = arguments.get("text")
            if note.get("author") != "user" or not isinstance(text, str) or not text.strip():
                raise BridgeFailure("INVALID_ARGUMENT")
            note["text"] = text.strip()
        elif action == "resolve":
            note["resolved"] = True
        else:
            notes.remove(note)
    updated = _write_meta_for_path(rel_path, content, meta)
    # Match retained setNoteTextMarkup/removeNoteMarkup: synchronize a row
    # only when the document already contains it. Never materialize notes.
    if rel_path.endswith(".html") and action == "edit":
        row = re.compile(
            rf"(<li\b[^>]*data-note-id=[\"']{re.escape(note['id'])}[\"'][^>]*>"
            r"[\s\S]*?<span\b[^>]*\bclass=[\"']who[\"'][^>]*>[\s\S]*?</span>)"
            r"([\s\S]*?)(<div\b[^>]*\bclass=[\"']reply|</li>)", re.IGNORECASE,
        )
        updated = row.sub(lambda match: match[1] + html_escape(note["text"], quote=False) + match[3], updated, count=1)
    elif rel_path.endswith(".html") and action == "delete":
        row = re.compile(
            rf"[^\S\n]*<li\b[^>]*data-note-id=[\"']{re.escape(note['id'])}[\"'][\s\S]*?</li>[^\S\n]*\n?",
            re.IGNORECASE,
        )
        updated = row.sub("", updated, count=1)
    _bridge_write(origin, rel_path, updated, mtime)
    return dict(note)


def _manual_document(origin: dict[str, Any], arguments: dict[str, Any], action: str) -> dict[str, Any]:
    """Transport the retained PlanStore's bytes and optimistic-lock result.

    Only the manual Host allowlist exposes these adapters. Paths remain
    relative to the Host-bound plan root; history is read-only, and Git
    sharing is limited to the retained .plans/<document> destination.
    """
    required = {"rel_path", "content"} if action == "write" else {"rel_path"}
    optional = {"expected_mtime"} if action == "write" else set()
    if not required <= set(arguments) or set(arguments) - required - optional:
        raise BridgeFailure("INVALID_ARGUMENT")
    path = arguments["rel_path"]
    if not isinstance(path, str) or not path or "\\" in path:
        raise BridgeFailure("INVALID_ARGUMENT")
    segments = path.split("/")
    if any(part in {"", ".", ".."} for part in segments) or ":" in path:
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
    if "/.history/" in path:
        parent, remainder = path.split("/.history/", 1)
        parts = remainder.split("/")
        _plan_path(f"{parent}/{parts[0]}.html")
        if action == "write" or len(parts) != (1 if action == "list" else 2):
            raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
        if action == "read" and not is_plan_doc_name(parts[-1]):
            raise BridgeFailure("INVALID_ARGUMENT")
    elif action == "list":
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
    elif len(segments) == 2 and segments[0] == ".plans" and is_plan_doc_name(segments[1]):
        pass
    else:
        path = _plan_path(path)

    if action == "read":
        content, mtime = _bridge_read(origin, path, include_mtime=True)
        return {"ok": True, "content": content, **({"mtime": mtime} if mtime is not None else {})}
    if action == "list":
        result = _bridge_call(origin, "filesystem", "list_dir", {"rel_path": path})
        if not _is_record(result) or not isinstance(result.get("entries"), list):
            raise BridgeFailure("PROTOCOL_ERROR")
        return {"ok": True, "entries": [
            {"name": entry["name"], "is_dir": bool(entry.get("isDirectory", entry.get("is_dir", False)))}
            for entry in result["entries"] if _is_record(entry) and isinstance(entry.get("name"), str)
        ]}
    content = arguments["content"]
    mtime = arguments.get("expected_mtime")
    if not isinstance(content, str) or (
        mtime is not None and (isinstance(mtime, bool) or not isinstance(mtime, (int, float)) or not math.isfinite(mtime))
    ):
        raise BridgeFailure("INVALID_ARGUMENT")
    try:
        _bridge_write(origin, path, content, mtime)
    except BridgeFailure as error:
        if error.code == "CONFLICT":
            return {"ok": False, "conflict": True}
        raise
    return {"ok": True}


def _document_title(rel_path: str, content: str) -> str:
    filename = rel_path.rsplit("/", 1)[-1]
    if rel_path.endswith(".html"):
        match = re.search(r"<title\b[^>]*>([\s\S]*?)</title>", content, re.IGNORECASE)
        if match:
            title = re.sub(r"<[^>]+>", "", match.group(1)).strip()
            if title:
                return title
        return re.sub(r"\.html$", "", filename, flags=re.IGNORECASE) or "Untitled plan"
    heading = re.search(r"^#\s+(.+?)\s*$", content, re.MULTILINE)
    if heading and heading.group(1).strip():
        return heading.group(1).strip()
    return re.sub(r"\.(?:plan\.md|md)$", "", filename, flags=re.IGNORECASE) or "Untitled plan"


def _document_overview(content: str) -> str:
    for block in re.split(r"\n\s*\n", content):
        text = block.strip()
        if text and not text.startswith("#") and not text.startswith("---"):
            return re.sub(r"\s+", " ", text)
    return ""


def _promote(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    normalized = _plan_path(arguments.get("rel_path"))
    content, mtime = _bridge_read(origin, normalized, include_mtime=True)
    existing = _parse_plan_meta(content)
    if existing is not None:
        return {"ok": True, "promoted": False, "rel_path": normalized, "meta": existing}
    name = _document_title(normalized, content)
    meta: dict[str, Any] = {
        "schemaVersion": 1,
        "name": name,
        "overview": "" if normalized.endswith(".html") else _document_overview(content),
        "stage": "draft",
        "approvedAt": None,
        "archivedAt": None,
        "todos": [],
        "reviewNotes": [],
    }
    updated = _write_plan_meta(content, meta) if normalized.endswith(".html") else _write_markdown_meta(content, meta)
    _bridge_write(origin, normalized, updated, mtime)
    return {"ok": True, "promoted": True, "rel_path": normalized, "meta": meta}


def _update_archive(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    archived_at = arguments.get("archived_at")
    if archived_at is not None and (not isinstance(archived_at, str) or not archived_at.strip()):
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    meta["archivedAt"] = archived_at
    _bridge_write(origin, rel_path, _write_meta_for_path(rel_path, content, meta), mtime)
    return {"archivedAt": archived_at}


def _rename(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    source = _plan_path(arguments.get("from"))
    target = _plan_path(arguments.get("to"))
    _bridge_call(origin, "filesystem", "rename", {"from": source, "to": target})
    return {"ok": True, "from": source, "to": target}


def _delete(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    rel_path = _plan_path(arguments.get("rel_path"))
    _bridge_call(origin, "filesystem", "delete", {"rel_path": rel_path})
    return {"ok": True, "rel_path": rel_path}


def _valid_request(frame: Any, method: str, keys: tuple[str, ...]) -> bool:
    return (
        _exact_keys(frame, ("jsonrpc", "id", "method", "params"))
        and frame["jsonrpc"] == "2.0"
        and _is_request_id(frame["id"])
        and frame["method"] == method
        and _exact_keys(frame["params"], keys)
        and _is_client_meta(frame["params"].get("_meta"))
    )


def _handle(frame: Any) -> None:
    if _bridge_result(frame) or _bridge_event(frame):
        return
    if _is_record(frame) and frame.get("method") == "notifications/cancelled":
        params = frame.get("params")
        if (
            not _exact_keys(frame, ("jsonrpc", "method", "params"))
            or frame["jsonrpc"] != "2.0"
            or not _is_record(params)
            or "requestId" not in params
            or any(key not in {"requestId", "reason"} for key in params)
            or not _is_request_id(params["requestId"])
        ):
            _protocol_error()
            return
        _cancel(params["requestId"])
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

    if _valid_request(frame, "subscriptions/listen", ("_meta", "notifications", "runtime")):
        notifications = frame["params"]["notifications"]
        runtime = frame["params"]["runtime"]
        events = notifications.get(EVENT_FILTER_KEY) if _is_record(notifications) else None
        if (
            not _is_record(notifications)
            or set(notifications) != {EVENT_FILTER_KEY}
            or not isinstance(events, list)
            or not events
            or len(set(events)) != len(events)
            or not all(_is_method_name(event) for event in events)
            or not _is_runtime(runtime)
        ):
            _protocol_error(frame["id"])
            return
        subscription = {"id": frame["id"], "events": events, "acknowledged": True}
        with _state_lock:
            _subscriptions[_subscription_key(frame["id"])] = subscription
        _acknowledge(subscription)
        if "plans.changed" in events:
            _start_watch(subscription)
        return

    if not _valid_request(frame, "navide/call", ("_meta", "name", "arguments", "runtime")):
        _protocol_error(frame.get("id", _MISSING) if _is_record(frame) else _MISSING)
        return
    name = frame["params"]["name"]
    arguments = frame["params"]["arguments"]
    runtime = frame["params"]["runtime"]
    if not _is_method_name(name) or not _is_runtime(runtime) or not _is_json_value(arguments) or not _is_record(arguments):
        _protocol_error(frame["id"])
        return
    origin = {"kind": "call", "requestId": frame["id"]}
    try:
        if name == "plans.resolve_root":
            if set(arguments) - {"workspace_path"}:
                raise BridgeFailure("INVALID_ARGUMENT")
            root = _bridge_call(origin, "filesystem", "resolve_root", {})
            if not _is_record(root) or not isinstance(root.get("root"), str):
                raise BridgeFailure("PROTOCOL_ERROR")
            result = {"ok": True, "root": root["root"]}
        elif name in {"plans.list", "plans.list_docs"}:
            if arguments:
                raise BridgeFailure("INVALID_ARGUMENT")
            result = _list_plans(origin)
        elif name == "plans.read":
            result = _read_plan(origin, arguments.get("rel_path"))
        elif name == "plans.read_document":
            result = _manual_document(origin, arguments, "read")
        elif name == "plans.write_document":
            result = _manual_document(origin, arguments, "write")
        elif name == "plans.list_directory":
            result = _manual_document(origin, arguments, "list")
        elif name == "plans.cache_put":
            result = {"ok": True}
        elif name == "plans.create":
            result = _create_plan(origin, arguments)
        elif name == "plans.update_stage":
            result = _update_stage(origin, arguments)
        elif name == "plans.update_todo":
            result = _update_todo(origin, arguments)
        elif name == "plans.add_note":
            result = _add_note(origin, arguments)
        elif name == "plans.review_note_add":
            result = _manual_review_note(origin, arguments, "add")
        elif name == "plans.review_note_edit":
            result = _manual_review_note(origin, arguments, "edit")
        elif name == "plans.review_note_resolve":
            result = _manual_review_note(origin, arguments, "resolve")
        elif name == "plans.review_note_delete":
            result = _manual_review_note(origin, arguments, "delete")
        elif name == "plans.update_archive":
            result = _update_archive(origin, arguments)
        elif name == "plans.promote":
            result = _promote(origin, arguments)
        elif name == "plans.rename":
            result = _rename(origin, arguments)
        elif name == "plans.delete":
            result = _delete(origin, arguments)
        else:
            _write_frame({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": -32601, "message": "Method not found"}})
            return
    except BridgeFailure as error:
        _plugin_error(frame["id"], error.code)
        return
    _response(frame["id"], result)


def _fail_closed() -> None:
    global _closing
    with _state_lock:
        _closing = True
        _subscriptions.clear()
        pending = list(_bridge_pending.values())
    for response_queue in pending:
        try:
            response_queue.put_nowait(("error", "BACKEND_UNAVAILABLE"))
        except queue.Full:
            pass
    raise SystemExit(2)


def main() -> int:
    try:
        for raw in sys.stdin.buffer:
            if not raw.endswith(b"\n"):
                _fail_closed()
            frame = _parse_strict(raw[:-1])
            if _is_record(frame) and frame.get("method") in {"navide/call", "subscriptions/listen"}:
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
