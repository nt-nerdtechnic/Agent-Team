from __future__ import annotations

import json
import select
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ENTRY = REPOSITORY_ROOT / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
PROTOCOL_REVISION = "2026-07-28"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId"
EVENT_FILTER_KEY = "dev.navide/pluginEvents"

CLIENT_META = {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {"name": "navide-plans-test", "version": "1"},
}
RUNTIME = {
    "pluginId": "navide.plans",
    "packageVersion": "0.1.0",
    "workspaceId": "workspace-hash",
    "instanceId": "instance-1",
    "contributionKey": "navide.plans.mcp",
    "hostWindowId": None,
    "initiator": {"kind": "agent", "source": "mcp", "id": "agent-1"},
}


def _send(process: subprocess.Popen[bytes], frame: dict[str, Any]) -> None:
    assert process.stdin is not None
    process.stdin.write(json.dumps(frame, separators=(",", ":")).encode() + b"\n")
    process.stdin.flush()


def _read(process: subprocess.Popen[bytes], timeout: float = 2.0) -> dict[str, Any]:
    assert process.stdout is not None
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready:
        raise AssertionError(f"Backend Wire child produced no frame within {timeout}s")
    line = process.stdout.readline()
    if not line:
        stderr = process.stderr.read().decode(errors="replace") if process.stderr else ""
        raise AssertionError(f"Backend Wire child exited without a frame: {stderr}")
    return json.loads(line)


def _reply_bridge(process: subprocess.Popen[bytes], request: dict[str, Any], value: Any) -> None:
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": {
                "resultType": "complete",
                "value": value,
                "_meta": {SERVER_INFO_KEY: {"name": "host-test", "version": "1"}},
            },
        },
    )


def _error_bridge(process: subprocess.Popen[bytes], request: dict[str, Any], code: str) -> None:
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {
                "code": 1000,
                "message": "Host bridge test error",
                "data": {"code": code},
            },
        },
    )


@pytest.fixture
def backend_process() -> subprocess.Popen[bytes]:
    process = subprocess.Popen(
        [sys.executable, str(BACKEND_ENTRY)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        yield process
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def test_health_and_agent_create_update_read_round_trip(
    backend_process: subprocess.Popen[bytes],
) -> None:
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "health-1",
            "method": "navide/health",
            "params": {"_meta": CLIENT_META},
        },
    )
    health = _read(backend_process)
    assert health["result"]["value"] == {
        "method": "navide/health",
        "protocolVersion": PROTOCOL_REVISION,
        "requestIdIsNonNull": True,
        "clientCapabilities": {},
    }

    stored: dict[str, str] = {
        ".agent-team/plans/_template.html": (
            REPOSITORY_ROOT / "backend" / "agent_team_backend" / "plan_assets" / "_template.html"
        ).read_text(encoding="utf-8")
    }
    mtime = 100.0

    def service_until_response(request_id: str) -> dict[str, Any]:
        nonlocal mtime
        while True:
            frame = _read(backend_process)
            if frame.get("id") == request_id:
                return frame
            assert frame.get("method") == "navide/host/call"
            params = frame["params"]
            assert params["port"] == "filesystem"
            assert params["origin"] == {"kind": "call", "requestId": request_id}
            operation = params["operation"]
            arguments = params["arguments"]
            assert "workspace_path" not in arguments
            if operation == "read_file":
                rel_path = arguments["rel_path"]
                if rel_path in stored:
                    _reply_bridge(backend_process, frame, {"content": stored[rel_path], "mtime": mtime})
                else:
                    _error_bridge(backend_process, frame, "BACKEND_UNAVAILABLE")
            elif operation == "write_file":
                stored[arguments["rel_path"]] = arguments["content"]
                expected = arguments.get("expected_mtime")
                if expected is not None:
                    assert expected == mtime
                mtime += 1
                _reply_bridge(backend_process, frame, {"ok": True, "mtime": mtime})
            else:
                raise AssertionError(f"unexpected filesystem operation: {operation}")

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "create-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.create",
                "arguments": {"name": "Agent plan", "overview": "Round trip", "todos": ["Verify"]},
                "runtime": RUNTIME,
            },
        },
    )
    created = service_until_response("create-1")
    assert created["result"]["value"] == {
        "rel_path": created["result"]["value"]["rel_path"],
        "name": "Agent plan",
        "stage": "draft",
    }
    rel_path = created["result"]["value"]["rel_path"]
    assert rel_path.startswith(".agent-team/plans/agent-plan_")
    assert stored[rel_path].find('"name": "Agent plan"') >= 0
    assert "--bg:" in stored[rel_path]
    assert "{{PLAN_NAME}}" not in stored[rel_path]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "create-done-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.create",
                "arguments": {
                    "name": "Completed report",
                    "overview": "Already finished",
                    "stage": "done",
                    "todos": [{"id": "verify", "content": "Verify", "owner": "user"}],
                },
                "runtime": RUNTIME,
            },
        },
    )
    completed = service_until_response("create-done-1")
    assert completed["result"]["value"]["stage"] == "done"
    completed_path = completed["result"]["value"]["rel_path"]
    assert '"stage": "done"' in stored[completed_path]
    assert '"status": "done"' in stored[completed_path]
    assert '"owner": "user"' in stored[completed_path]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "update-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.update_stage",
                "arguments": {"rel_path": rel_path, "stage": "in-progress"},
                "runtime": RUNTIME,
            },
        },
    )
    updated = service_until_response("update-1")
    assert updated["result"]["value"]["stage"] == "in-progress"
    assert '"stage": "in-progress"' in stored[rel_path]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "update-todo-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.update_todo",
                "arguments": {
                    "rel_path": rel_path,
                    "todo_id": "t1",
                    "status": "in-progress",
                    "owner": "user",
                },
                "runtime": RUNTIME,
            },
        },
    )
    updated_todo = service_until_response("update-todo-1")
    assert updated_todo["result"]["value"]["status"] == "in-progress"
    assert updated_todo["result"]["value"]["owner"] == "user"
    assert 'data-status="pending" data-todo-id="t1"' not in stored[rel_path]
    assert '<span class="st">in-progress</span>' in stored[rel_path]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "update-todo-owner-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.update_todo",
                "arguments": {
                    "rel_path": rel_path,
                    "todo_id": "t1",
                    "status": "done",
                    "owner": "agent",
                },
                "runtime": RUNTIME,
            },
        },
    )
    reassigned_todo = service_until_response("update-todo-owner-1")
    assert reassigned_todo["result"]["value"]["status"] == "done"
    assert "owner" not in reassigned_todo["result"]["value"]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "read-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.read",
                "arguments": {"rel_path": rel_path},
                "runtime": RUNTIME,
            },
        },
    )
    read = service_until_response("read-1")
    assert read["result"]["value"]["rel_path"] == rel_path
    assert read["result"]["value"]["meta"]["stage"] == "in-progress"


def test_create_rejects_a_missing_host_provisioned_template(
    backend_process: subprocess.Popen[bytes],
) -> None:
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "create-missing-template-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.create",
                "arguments": {"name": "No template", "overview": "", "todos": []},
                "runtime": RUNTIME,
            },
        },
    )

    operations: list[str] = []
    while True:
        frame = _read(backend_process)
        if frame.get("id") == "create-missing-template-1":
            response = frame
            break
        assert frame.get("method") == "navide/host/call"
        operations.append(frame["params"]["operation"])
        assert frame["params"]["operation"] == "read_file"
        _error_bridge(backend_process, frame, "BACKEND_UNAVAILABLE")

    assert response["error"]["data"] == {"code": "BACKEND_UNAVAILABLE"}
    assert operations.count("read_file") == 2


def test_filesystem_bridge_event_becomes_plans_changed(
    backend_process: subprocess.Popen[bytes],
) -> None:
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "subscription-1",
            "method": "subscriptions/listen",
            "params": {
                "_meta": CLIENT_META,
                "notifications": {EVENT_FILTER_KEY: ["plans.changed"]},
                "runtime": RUNTIME,
            },
        },
    )

    watch_request: dict[str, Any] | None = None
    acknowledged = False
    deadline = time.monotonic() + 2
    while not acknowledged or watch_request is None:
        assert time.monotonic() < deadline
        frame = _read(backend_process, max(0.01, deadline - time.monotonic()))
        if frame.get("method") == "notifications/subscriptions/acknowledged":
            acknowledged = frame["params"]["_meta"][SUBSCRIPTION_ID_KEY] == "subscription-1"
        elif frame.get("method") == "navide/host/call":
            watch_request = frame
            assert frame["params"] == {
                "origin": {"kind": "subscription", "requestId": "subscription-1"},
                "port": "filesystem",
                "operation": "watch",
                "arguments": {"rel_path": ""},
            }
        else:
            raise AssertionError(f"unexpected subscription frame: {frame}")

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "method": "navide/host/event",
            "params": {
                "origin": {"kind": "subscription", "requestId": "subscription-1"},
                "event": "filesystem.changed",
                "payload": {"changes": [{"path": ".agent-team/plans/new.html", "kind": "created"}]},
            },
        },
    )
    event = _read(backend_process)
    assert event == {
        "jsonrpc": "2.0",
        "method": "notifications/navide/event",
        "params": {
            "_meta": {SUBSCRIPTION_ID_KEY: "subscription-1"},
            "event": "plans.changed",
            "payload": {"changes": [{"path": ".agent-team/plans/new.html", "kind": "created"}]},
        },
    }


def test_rejects_absolute_plan_path_before_host_bridge(
    backend_process: subprocess.Popen[bytes],
) -> None:
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "scope-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.read",
                "arguments": {"rel_path": "/private/tmp/outside.html"},
                "runtime": RUNTIME,
            },
        },
    )
    response = _read(backend_process)
    assert response["error"]["data"] == {"code": "WORKSPACE_SCOPE_VIOLATION"}


def test_lists_metadata_less_documents_and_promotes_markdown_without_corrupting_body(
    backend_process: subprocess.Popen[bytes],
) -> None:
    document_path = ".agent-team/plans/README.md"
    stored = {document_path: "# README\n\nA workspace document.\n"}
    mtimes = {document_path: 100.0}

    def service_until_response(request_id: str) -> dict[str, Any]:
        while True:
            frame = _read(backend_process)
            if frame.get("id") == request_id:
                return frame
            assert frame.get("method") == "navide/host/call"
            params = frame["params"]
            assert params["port"] == "filesystem"
            assert params["origin"] == {"kind": "call", "requestId": request_id}
            operation = params["operation"]
            arguments = params["arguments"]
            assert "workspace_path" not in arguments
            if operation == "stat_path":
                assert arguments == {"rel_path": ".agent-team/plans"}
                _reply_bridge(backend_process, frame, {"exists": True})
            elif operation == "list_dir":
                assert arguments == {"rel_path": ".agent-team/plans"}
                _reply_bridge(backend_process, frame, {"entries": ["README.md"]})
            elif operation == "read_file":
                rel_path = arguments["rel_path"]
                if rel_path not in stored:
                    _error_bridge(backend_process, frame, "BACKEND_UNAVAILABLE")
                else:
                    _reply_bridge(
                        backend_process,
                        frame,
                        {"content": stored[rel_path], "mtime": mtimes[rel_path]},
                    )
            elif operation == "write_file":
                rel_path = arguments["rel_path"]
                assert arguments["expected_mtime"] == mtimes[rel_path]
                stored[rel_path] = arguments["content"]
                mtimes[rel_path] += 1
                _reply_bridge(backend_process, frame, {"ok": True, "mtime": mtimes[rel_path]})
            else:
                raise AssertionError(f"unexpected filesystem operation: {operation}")

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "list-documents-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.list",
                "arguments": {},
                "runtime": RUNTIME,
            },
        },
    )
    listed = service_until_response("list-documents-1")
    assert listed["result"]["value"] == [
        {
            "rel_path": document_path,
            "name": "README.md",
            "stage": None,
            "overview": "",
            "todos": {"total": 0, "by_status": {}},
            "mtime": 100.0,
            "kind": "document",
            "meta": None,
        }
    ]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "promote-document-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.promote",
                "arguments": {"rel_path": document_path},
                "runtime": RUNTIME,
            },
        },
    )
    promoted = service_until_response("promote-document-1")
    assert promoted["result"]["value"]["promoted"] is True
    assert stored[document_path].startswith("---\n")
    assert "\n---\n# README\n" in stored[document_path]
    assert "---# README" not in stored[document_path]


def test_host_bridge_cancellation_settles_the_child_call(
    backend_process: subprocess.Popen[bytes],
) -> None:
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "read-cancel-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.read",
                "arguments": {"rel_path": ".agent-team/plans/cancel.html"},
                "runtime": RUNTIME,
            },
        },
    )
    bridge_request = _read(backend_process)
    assert bridge_request["method"] == "navide/host/call"

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": {"requestId": bridge_request["id"], "reason": "timeout"},
        },
    )
    response = _read(backend_process)
    assert response["id"] == "read-cancel-1"
    assert response["error"]["data"] == {"code": "USER_CANCELLED"}
