from __future__ import annotations

import importlib.util
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
                _reply_bridge(
                    backend_process,
                    frame,
                    {"exists": arguments.get("rel_path") == ".agent-team/plans"},
                )
            elif operation == "list_dir":
                if arguments.get("rel_path") == "":
                    _reply_bridge(backend_process, frame, {"entries": []})
                else:
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


def test_lists_and_reads_legacy_plans_across_doc_dirs(
    backend_process: subprocess.Popen[bytes],
) -> None:
    legacy_path = ".cursor/plans/feature.plan.md"
    legacy_content = (
        "---\n"
        "title: Legacy Cursor Feature\n"
        "overview: A legacy feature plan\n"
        "todos:\n"
        "  - id: t1\n"
        "    content: Step 1\n"
        "    status: completed\n"
        "---\n"
        "# Legacy Cursor Feature\n\n"
        "Details here.\n"
    )
    stored = {legacy_path: legacy_content}
    mtimes = {legacy_path: 200.0}

    def service_until_response(request_id: str) -> dict[str, Any]:
        while True:
            frame = _read(backend_process)
            if frame.get("id") == request_id:
                return frame
            assert frame.get("method") == "navide/host/call"
            params = frame["params"]
            operation = params["operation"]
            arguments = params["arguments"]
            if operation == "stat_path":
                _reply_bridge(
                    backend_process,
                    frame,
                    {"exists": arguments.get("rel_path") == ".cursor/plans"},
                )
            elif operation == "list_dir":
                if arguments.get("rel_path") == "":
                    _reply_bridge(backend_process, frame, {"entries": []})
                else:
                    assert arguments == {"rel_path": ".cursor/plans"}
                    _reply_bridge(backend_process, frame, {"entries": ["feature.plan.md"]})
            elif operation == "read_file":
                rel_path = arguments["rel_path"]
                assert rel_path in stored
                _reply_bridge(
                    backend_process,
                    frame,
                    {"content": stored[rel_path], "mtime": mtimes[rel_path]},
                )
            else:
                raise AssertionError(f"unexpected operation: {operation}")

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "list-legacy-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.list",
                "arguments": {},
                "runtime": RUNTIME,
            },
        },
    )
    listed = service_until_response("list-legacy-1")
    assert listed["result"]["value"] == [
        {
            "rel_path": legacy_path,
            "name": "Legacy Cursor Feature",
            "stage": "done",
            "overview": "A legacy feature plan",
            "todos": {"total": 1, "by_status": {"done": 1}},
            "mtime": 200.0,
            "kind": "plan",
            "meta": {
                "schemaVersion": 1,
                "title": "Legacy Cursor Feature",
                "name": "Legacy Cursor Feature",
                "stage": "done",
                "overview": "A legacy feature plan",
                "approvedAt": None,
                "archivedAt": None,
                "todos": [{"id": "t1", "content": "Step 1", "status": "done"}],
                "reviewNotes": [],
            },
        }
    ]

    # Reading the legacy plan directly by its relative path
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "read-legacy-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.read",
                "arguments": {"rel_path": legacy_path},
                "runtime": RUNTIME,
            },
        },
    )
    read_resp = service_until_response("read-legacy-1")
    assert read_resp["result"]["value"]["rel_path"] == legacy_path
    assert read_resp["result"]["value"]["meta"]["name"] == "Legacy Cursor Feature"
    assert read_resp["result"]["value"]["meta"]["stage"] == "done"


def test_lists_nested_plan_roots_accepts_git_directory_and_rejects_git_file(
    backend_process: subprocess.Popen[bytes],
) -> None:
    stored = {
        ".agent-team/plans/top.html": "<html><head><script id='plan-meta' type='application/json'>{\"schemaVersion\":1,\"name\":\"Top Plan\",\"overview\":\"Top\",\"stage\":\"draft\",\"approvedAt\":null,\"todos\":[],\"reviewNotes\":[]}</script></head><body></body></html>",
        "nested_repo/.agent-team/plans/nested.html": "<html><head><script id='plan-meta' type='application/json'>{\"schemaVersion\":1,\"name\":\"Nested Plan\",\"overview\":\"Nested\",\"stage\":\"approved\",\"approvedAt\":\"2026-09-04T00:00:00Z\",\"todos\":[],\"reviewNotes\":[]}</script></head><body></body></html>",
        "submodule_dir/.agent-team/plans/sub.html": "<html><head><script id='plan-meta' type='application/json'>{\"schemaVersion\":1,\"name\":\"Sub Plan\",\"overview\":\"Sub\",\"stage\":\"draft\",\"approvedAt\":null,\"todos\":[],\"reviewNotes\":[]}</script></head><body></body></html>",
        "submodule_dir/inner_repo/.agent-team/plans/inner.html": "<html><head><script id='plan-meta' type='application/json'>{\"schemaVersion\":1,\"name\":\"Inner Plan\",\"overview\":\"Inner\",\"stage\":\"done\",\"approvedAt\":\"2026-09-04T00:00:00Z\",\"todos\":[],\"reviewNotes\":[]}</script></head><body></body></html>",
    }
    mtime = 300.0

    def service_until_response(request_id: str) -> dict[str, Any]:
        while True:
            frame = _read(backend_process)
            if frame.get("id") == request_id:
                return frame
            assert frame.get("method") == "navide/host/call"
            params = frame["params"]
            operation = params["operation"]
            arguments = params["arguments"]
            if operation == "stat_path":
                rel = arguments.get("rel_path", "")
                if rel in stored:
                    _reply_bridge(backend_process, frame, {"exists": True, "isDirectory": False})
                elif rel in {
                    ".agent-team/plans",
                    "nested_repo",
                    "nested_repo/.git",
                    "nested_repo/.agent-team/plans",
                    "submodule_dir",
                    "submodule_dir/inner_repo",
                    "submodule_dir/inner_repo/.git",
                    "submodule_dir/inner_repo/.agent-team/plans",
                }:
                    _reply_bridge(backend_process, frame, {"exists": True, "isDirectory": True})
                elif rel == "submodule_dir/.git":
                    _reply_bridge(backend_process, frame, {"exists": True, "isDirectory": False})
                else:
                    _reply_bridge(backend_process, frame, {"exists": False, "isDirectory": False})
            elif operation == "list_dir":
                rel = arguments.get("rel_path", "")
                if rel == "":
                    _reply_bridge(backend_process, frame, {"entries": ["nested_repo", "submodule_dir"]})
                elif rel == "submodule_dir":
                    _reply_bridge(backend_process, frame, {"entries": ["inner_repo"]})
                elif rel == ".agent-team/plans":
                    _reply_bridge(backend_process, frame, {"entries": ["top.html"]})
                elif rel == "nested_repo/.agent-team/plans":
                    _reply_bridge(backend_process, frame, {"entries": ["nested.html"]})
                elif rel == "submodule_dir/inner_repo/.agent-team/plans":
                    _reply_bridge(backend_process, frame, {"entries": ["inner.html"]})
                else:
                    _reply_bridge(backend_process, frame, {"entries": []})
            elif operation == "read_file":
                rel = arguments["rel_path"]
                if rel in stored:
                    _reply_bridge(backend_process, frame, {"content": stored[rel], "mtime": mtime})
                else:
                    _error_bridge(backend_process, frame, "BACKEND_UNAVAILABLE")
            else:
                raise AssertionError(f"unexpected operation: {operation}")

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "list-nested-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.list",
                "arguments": {},
                "runtime": RUNTIME,
            },
        },
    )
    listed = service_until_response("list-nested-1")
    rel_paths = [doc["rel_path"] for doc in listed["result"]["value"]]
    assert ".agent-team/plans/top.html" in rel_paths
    assert "nested_repo/.agent-team/plans/nested.html" in rel_paths
    assert "submodule_dir/inner_repo/.agent-team/plans/inner.html" in rel_paths
    assert "submodule_dir/.agent-team/plans/sub.html" not in rel_paths


def test_plans_backend_fixture_triple_parity() -> None:
    """Triple-parity: packaged plans_backend.py, legacy plan_index.py, and pure data fixture."""
    fixture_path = REPOSITORY_ROOT / "docs" / "plugin-contracts" / "plan-document-locations-v1.json"
    assert fixture_path.exists(), f"Missing fixture at {fixture_path}"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    # Load packaged plans_backend.py
    spec = importlib.util.spec_from_file_location("plans_backend_parity_check", BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    backend_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend_module)

    # Load legacy plan_index.py
    from agent_team_backend import plan_index

    # 1. Directory inventory
    assert list(backend_module.PLAN_DOC_DIRS) == list(plan_index.PLAN_DOC_DIRS) == fixture["directoryInventory"]
    assert len(backend_module.PLAN_DOC_DIRS) == 7
    assert len(set(backend_module.PLAN_DOC_DIRS)) == len(backend_module.PLAN_DOC_DIRS)

    # 2. Supported extensions
    assert list(backend_module.DOC_SUFFIXES) == list(plan_index._DOC_SUFFIXES) == fixture["supportedExtensions"]
    assert len(backend_module.DOC_SUFFIXES) == 3

    # 3. Discovery limits
    assert backend_module._MAX_ROOT_DEPTH == plan_index._MAX_ROOT_DEPTH == fixture["maxNestedDepth"] == 2
    assert backend_module._MAX_NESTED_ROOTS == plan_index._MAX_NESTED_ROOTS == fixture["maxNestedRoots"] == 50

    # 4. Noise segments
    assert sorted(backend_module._NOISE_SEGMENTS) == sorted(plan_index._NOISE_SEGMENTS) == sorted(fixture["noiseSegments"])
    assert len(backend_module._NOISE_SEGMENTS) == 17

    # 5. Traversal sort order
    assert fixture["traversalSortOrder"] == "utf8_bytes_ascending"

    # 6. Max directory entries cap
    assert (
        backend_module._MAX_DIRECTORY_ENTRIES
        == plan_index._MAX_DIRECTORY_ENTRIES
        == fixture["maxDirectoryEntries"]
        == 2000
    )


def test_packaged_plans_backend_nested_roots_deterministic_50_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """Packaged plans_backend._find_nested_plan_roots enforces deterministic 50-root limit in UTF-8 byte order."""
    spec = importlib.util.spec_from_file_location("plans_backend_test_roots", BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    backend_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend_module)

    # 49 repos R00..R48 + Repo-Alpha + repo-alpha = 51 entries
    entries = [f"R{i:02d}" for i in range(49)] + ["Repo-Alpha", "repo-alpha"]
    shuffled_entries = list(reversed(entries))

    def fake_bridge_call(origin: dict, service: str, op: str, args: dict) -> dict:
        if op == "list_dir" and args.get("rel_path") == "":
            return {"entries": shuffled_entries}
        if op == "stat_path":
            return {"exists": True, "isDirectory": True}
        return {}

    monkeypatch.setattr(backend_module, "_bridge_call", fake_bridge_call)
    roots = backend_module._find_nested_plan_roots({"token": "fake"})
    assert len(roots) == 50
    assert "Repo-Alpha" in roots
    assert "repo-alpha" not in roots


def test_packaged_plans_backend_nested_roots_2000_entry_wire_truncation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Production-shaped wire test: bridge returns 2,000 entries (capped) with truncated: True."""
    spec = importlib.util.spec_from_file_location("plans_backend_test_cap_wire", BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    backend_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend_module)

    requested_modes: list[str | None] = []
    # 1,999 non-repo directories + 1 repo at 2,000th slot
    entries = [f"d{i:04d}" for i in range(1999)] + ["r0000-within"]
    shuffled_entries = list(reversed(entries))

    def fake_bridge_call(origin: dict, service: str, op: str, args: dict) -> dict:
        if op == "list_dir":
            requested_modes.append(args.get("mode"))
            if args.get("rel_path") == "":
                return {"entries": shuffled_entries, "truncated": True}
            return {"entries": []}
        if op == "stat_path":
            rel = args.get("rel_path", "")
            if rel in ("r0000-within", "r0000-within/.git"):
                return {"exists": True, "isDirectory": True}
            if rel.endswith("/.git"):
                return {"exists": False, "isDirectory": False}
            return {"exists": True, "isDirectory": True}
        return {}

    monkeypatch.setattr(backend_module, "_bridge_call", fake_bridge_call)
    roots = backend_module._find_nested_plan_roots({"token": "fake"})
    assert roots == ["r0000-within"]
    assert len(requested_modes) == 2000
    assert all(m == "discovery" for m in requested_modes)


def test_packaged_plans_backend_nested_roots_defensive_2000_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Defensive fallback test: abnormal bridge returns 2,001 entries; plans_backend caps internally."""
    spec = importlib.util.spec_from_file_location("plans_backend_test_defensive_cap", BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    backend_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend_module)

    requested_modes: list[str | None] = []
    # 1,999 non-repo + r0000-within + z0000-beyond = 2,001 entries
    entries = [f"d{i:04d}" for i in range(1999)] + ["r0000-within", "z0000-beyond"]
    shuffled_entries = list(reversed(entries))

    def fake_bridge_call(origin: dict, service: str, op: str, args: dict) -> dict:
        if op == "list_dir":
            requested_modes.append(args.get("mode"))
            if args.get("rel_path") == "":
                return {"entries": shuffled_entries, "truncated": False}
            return {"entries": []}
        if op == "stat_path":
            rel = args.get("rel_path", "")
            if rel in ("r0000-within", "r0000-within/.git", "z0000-beyond", "z0000-beyond/.git"):
                return {"exists": True, "isDirectory": True}
            if rel.endswith("/.git"):
                return {"exists": False, "isDirectory": False}
            return {"exists": True, "isDirectory": True}
        return {}

    monkeypatch.setattr(backend_module, "_bridge_call", fake_bridge_call)
    roots = backend_module._find_nested_plan_roots({"token": "fake"})
    assert roots == ["r0000-within"]
    assert len(requested_modes) == 2000
    assert all(m == "discovery" for m in requested_modes)
