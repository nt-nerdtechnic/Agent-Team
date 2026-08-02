from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from agent_team_backend import app as backend_app
from agent_team_backend.app import app
from agent_team_backend.plan_meta import parse_plan_meta
from agent_team_backend.plugins import wiring as plugin_wiring
from agent_team_backend.plugins.builtin.navide_plans import plan_mcp
from agent_team_backend.plugins.host import PluginHost


def _plan_html(meta: dict) -> str:
    payload = json.dumps(meta, indent=2)
    stage = meta.get("stage", "draft")
    todo_lis = "\n".join(
        f'<li data-status="{t["status"]}" data-todo-id="{t["id"]}">'
        f'<span class="st">{t["status"]}</span><span>{t.get("content", "")}</span></li>'
        for t in meta.get("todos", [])
    )
    return (
        f'<h1>Plan<span class="pill {stage}">{stage}</span></h1>\n'
        f'<script type="application/json" id="plan-meta">\n{payload}\n</script>\n'
        f'<ul class="todos">\n{todo_lis}\n</ul>\n'
        "<section>body</section>\n"
    )


async def _call(tool: str, args: dict):
    async with create_connected_server_and_client_session(plan_mcp.server) as session:
        return await session.call_tool(tool, args)


def _plans_dir(workspace: Path) -> Path:
    return workspace / ".agent-team" / "plans"


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    (plans / "alpha.html").write_text(
        _plan_html(
            {
                "name": "Alpha",
                "stage": "approved",
                "overview": "First plan",
                "todos": [
                    {"id": "t1", "status": "done"},
                    {"id": "t2", "status": "pending"},
                ],
            }
        ),
        encoding="utf-8",
    )
    (plans / "beta.html").write_text(
        _plan_html({"name": "Beta", "stage": "draft", "overview": "Second plan"}),
        encoding="utf-8",
    )
    # Provisioned assets and meta-less files must be skipped by plan_list.
    (plans / "_template.html").write_text("<h1>template</h1>", encoding="utf-8")
    (plans / "no-meta.html").write_text("<h1>not a plan</h1>", encoding="utf-8")
    # Target for the traversal test: exists, but outside the plans subtree.
    (tmp_path / ".agent-team" / "secret.html").write_text("secret", encoding="utf-8")
    return tmp_path


# The in-memory client-server session is opened inside each test body (not an
# async fixture): pytest-asyncio finalizes async gen fixtures in a different
# task, which breaks the anyio cancel scopes inside the SDK helper.


async def test_plan_list_returns_plans_with_meta(workspace: Path) -> None:
    async with create_connected_server_and_client_session(plan_mcp.server) as session:
        result = await session.call_tool("plan_list", {"workspace_path": str(workspace)})
    assert not result.isError
    plans = result.structuredContent["result"]
    # Workspace-relative paths: agents echo these into the terminal, where
    # cmd+click only recognizes the full .agent-team/plans/… form.
    assert [p["rel_path"] for p in plans] == [
        ".agent-team/plans/alpha.html",
        ".agent-team/plans/beta.html",
    ]
    alpha, beta = plans
    assert alpha["name"] == "Alpha"
    assert alpha["stage"] == "approved"
    assert alpha["overview"] == "First plan"
    assert alpha["todos"] == {"total": 2, "by_status": {"done": 1, "pending": 1}}
    assert isinstance(alpha["mtime"], float)
    assert beta["name"] == "Beta"
    assert beta["stage"] == "draft"
    assert beta["todos"] == {"total": 0, "by_status": {}}


async def test_plan_read_returns_meta_and_html(workspace: Path) -> None:
    async with create_connected_server_and_client_session(plan_mcp.server) as session:
        result = await session.call_tool(
            "plan_read", {"workspace_path": str(workspace), "rel_path": "alpha.html"}
        )
    assert not result.isError
    data = result.structuredContent
    assert data["rel_path"] == ".agent-team/plans/alpha.html"
    assert data["meta"]["name"] == "Alpha"
    assert data["meta"]["stage"] == "approved"
    assert 'id="plan-meta"' in data["html"]
    assert data["html"] == (
        workspace / ".agent-team" / "plans" / "alpha.html"
    ).read_text(encoding="utf-8")


async def test_plan_read_accepts_the_full_workspace_relative_path(workspace: Path) -> None:
    """Both input forms resolve to the same plan (the other test passes a filename)."""
    async with create_connected_server_and_client_session(plan_mcp.server) as session:
        result = await session.call_tool(
            "plan_read",
            {"workspace_path": str(workspace), "rel_path": ".agent-team/plans/alpha.html"},
        )
    assert not result.isError
    assert result.structuredContent["rel_path"] == ".agent-team/plans/alpha.html"
    assert result.structuredContent["meta"]["name"] == "Alpha"


async def test_plan_read_rejects_path_traversal(workspace: Path) -> None:
    async with create_connected_server_and_client_session(plan_mcp.server) as session:
        result = await session.call_tool(
            "plan_read", {"workspace_path": str(workspace), "rel_path": "../secret.html"}
        )
    assert result.isError


async def test_plan_read_rejects_missing_file(workspace: Path) -> None:
    async with create_connected_server_and_client_session(plan_mcp.server) as session:
        result = await session.call_tool(
            "plan_read", {"workspace_path": str(workspace), "rel_path": "nope.html"}
        )
    assert result.isError


async def test_plan_create_writes_plan_and_lists_it(workspace: Path) -> None:
    plans = _plans_dir(workspace)
    # The fixture's fake _template.html has no plan-meta island; remove it so
    # plan_create falls back to provisioning the real bundled template.
    (plans / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "My New Plan",
            "overview": "Test overview.",
            "todos": ["First task", {"id": "phase-b", "content": "Second task"}],
        },
    )
    assert not result.isError
    data = result.structuredContent
    assert re.fullmatch(r"\.agent-team/plans/my-new-plan_[0-9a-f]{6}\.html", data["rel_path"])
    assert data["name"] == "My New Plan"
    assert data["stage"] == "draft"
    # No pane workspaces are known in this test, so no advisory warning fires.
    assert "warning" not in data

    html = (workspace / data["rel_path"]).read_text(encoding="utf-8")
    meta = parse_plan_meta(html)
    assert meta["schemaVersion"] == 1
    assert meta["name"] == "My New Plan"
    assert meta["overview"] == "Test overview."
    assert meta["stage"] == "draft"
    assert meta["approvedAt"] is None
    assert meta["todos"] == [
        {"id": "t1", "content": "First task", "status": "pending"},
        {"id": "phase-b", "content": "Second task", "status": "pending"},
    ]
    assert meta["reviewNotes"] == []
    # Visible markup carries the same data and no leftover template scaffolding.
    assert "My New Plan" in html
    assert 'data-todo-id="t1"' in html and "First task" in html
    assert 'data-todo-id="phase-b"' in html and "Second task" in html
    assert "{{" not in html
    # The provisioned template itself stays a pristine template.
    assert "{{PLAN_NAME}}" in (plans / "_template.html").read_text(encoding="utf-8")

    listed = await _call("plan_list", {"workspace_path": str(workspace)})
    rels = [p["rel_path"] for p in listed.structuredContent["result"]]
    assert data["rel_path"] in rels
    assert ".agent-team/plans/_template.html" not in rels


async def test_plan_update_stage_updates_island_and_pill(workspace: Path) -> None:
    result = await _call(
        "plan_update_stage",
        {"workspace_path": str(workspace), "rel_path": "beta.html", "stage": "in-review"},
    )
    assert not result.isError
    assert result.structuredContent == {"stage": "in-review", "approvedAt": None}
    html = (_plans_dir(workspace) / "beta.html").read_text(encoding="utf-8")
    assert parse_plan_meta(html)["stage"] == "in-review"
    assert '<span class="pill in-review">in-review</span>' in html


async def test_plan_update_stage_approved_sets_approved_at(workspace: Path) -> None:
    result = await _call(
        "plan_update_stage",
        {"workspace_path": str(workspace), "rel_path": "beta.html", "stage": "approved"},
    )
    assert not result.isError
    data = result.structuredContent
    assert data["stage"] == "approved"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", data["approvedAt"])
    meta = parse_plan_meta((_plans_dir(workspace) / "beta.html").read_text(encoding="utf-8"))
    assert meta["stage"] == "approved"
    assert meta["approvedAt"] == data["approvedAt"]


async def test_plan_update_stage_rejects_invalid_stage(workspace: Path) -> None:
    result = await _call(
        "plan_update_stage",
        {"workspace_path": str(workspace), "rel_path": "beta.html", "stage": "bogus"},
    )
    assert result.isError


async def test_plan_update_todo_updates_island_and_li(workspace: Path) -> None:
    result = await _call(
        "plan_update_todo",
        {
            "workspace_path": str(workspace),
            "rel_path": "alpha.html",
            "todo_id": "t2",
            "status": "in-progress",
        },
    )
    assert not result.isError
    assert result.structuredContent == {"id": "t2", "status": "in-progress"}
    html = (_plans_dir(workspace) / "alpha.html").read_text(encoding="utf-8")
    todos = {t["id"]: t["status"] for t in parse_plan_meta(html)["todos"]}
    assert todos == {"t1": "done", "t2": "in-progress"}
    assert (
        '<li data-status="in-progress" data-todo-id="t2">'
        '<span class="st">in-progress</span>' in html
    )


async def test_plan_update_todo_rejects_unknown_id(workspace: Path) -> None:
    result = await _call(
        "plan_update_todo",
        {
            "workspace_path": str(workspace),
            "rel_path": "alpha.html",
            "todo_id": "nope",
            "status": "done",
        },
    )
    assert result.isError
    # The error lists the plan's valid todo ids.
    assert "t1" in result.content[0].text and "t2" in result.content[0].text


async def test_plan_add_note_appends_sequential_notes(workspace: Path) -> None:
    first = await _call(
        "plan_add_note",
        {"workspace_path": str(workspace), "rel_path": "beta.html", "text": "Looks unclear"},
    )
    assert not first.isError
    assert first.structuredContent == {
        "id": "n1",
        "author": "ai",
        "text": "Looks unclear",
        "resolved": False,
        "reply": "",
    }
    second = await _call(
        "plan_add_note",
        {
            "workspace_path": str(workspace),
            "rel_path": "beta.html",
            "text": "Second note",
            "author": "user",
        },
    )
    assert not second.isError
    assert second.structuredContent["id"] == "n2"
    assert second.structuredContent["author"] == "user"
    meta = parse_plan_meta((_plans_dir(workspace) / "beta.html").read_text(encoding="utf-8"))
    assert [n["id"] for n in meta["reviewNotes"]] == ["n1", "n2"]
    assert all(n["resolved"] is False for n in meta["reviewNotes"])


async def test_plan_update_stage_rejects_path_traversal(workspace: Path) -> None:
    result = await _call(
        "plan_update_stage",
        {
            "workspace_path": str(workspace),
            "rel_path": "../secret.html",
            "stage": "draft",
        },
    )
    assert result.isError
    assert (workspace / ".agent-team" / "secret.html").read_text(encoding="utf-8") == "secret"


# ── dispatch tools ──────────────────────────────────────────────────────────


class _FakeTerminalService:
    """Stand-in for TerminalService: same write() contract (sync, KeyError on
    unknown session) and the _sessions dict list_dispatch_targets snapshots."""

    def __init__(self, sessions: list[SimpleNamespace]) -> None:
        self._sessions = {s.id: s for s in sessions}
        self.writes: list[tuple[str, str]] = []

    def write(self, session_id: str, data: str) -> None:
        if session_id not in self._sessions:
            raise KeyError(f"unknown terminal session: {session_id}")
        self.writes.append((session_id, data))


def _fake_session(
    session_id: str,
    agent_key: str | None = "claude",
    cwd: str = "/ws/a",
    metadata: dict | None = None,
    closed: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=session_id,
        pane_id=f"pane-{session_id}",
        agent_key=agent_key,
        cwd=cwd,
        metadata=metadata if metadata is not None else {},
        closed=closed,
    )


@pytest.fixture
def fake_terminals(monkeypatch: pytest.MonkeyPatch) -> _FakeTerminalService:
    fake = _FakeTerminalService(
        [
            _fake_session("s1", agent_key="claude", cwd="/ws/a"),
            _fake_session(
                "s2",
                agent_key="codex",
                cwd="/ws/b/sub",
                metadata={"workspace_path": "/ws/b"},
            ),
            _fake_session("s3", agent_key="claude", cwd="/ws/b", closed=True),
        ]
    )
    monkeypatch.setattr(backend_app, "get_terminals", lambda: fake)
    return fake


async def test_plan_create_warns_when_no_pane_uses_the_workspace(
    workspace: Path, fake_terminals: _FakeTerminalService
) -> None:
    """The plan window resolves plans against a pane's workspace, so writing to
    a root no pane uses produces a file Navide can never open."""
    (_plans_dir(workspace) / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Orphan Plan",
            "overview": "",
            "todos": ["Task"],
        },
    )
    assert not result.isError
    warning = result.structuredContent["warning"]
    assert str(workspace) in warning
    # Live pane workspaces are listed so the agent can retry against one; the
    # closed session's workspace (/ws/b via s3) is not a live pane on its own.
    assert "/ws/a" in warning and "/ws/b" in warning


async def test_plan_create_does_not_warn_when_a_pane_matches(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _FakeTerminalService([_fake_session("s1", cwd=str(workspace))])
    monkeypatch.setattr(backend_app, "get_terminals", lambda: fake)
    (_plans_dir(workspace) / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Matched Plan",
            "overview": "",
            "todos": ["Task"],
        },
    )
    assert not result.isError
    assert "warning" not in result.structuredContent


_ALPHA_PROMPT = (
    "Execute the approved plan document at .agent-team/plans/alpha.html "
    "(workspace-relative path). "
    "Read the plan first, then implement it by its todos phase by phase. "
    "Update the plan-meta todo status (and the matching visible markup) "
    "as you complete each phase. "
    'Set the plan-meta stage to "done" when all todos are complete.'
)


async def test_plan_dispatch_writes_prompt_then_enter(
    workspace: Path, fake_terminals: _FakeTerminalService
) -> None:
    result = await _call(
        "plan_dispatch",
        {
            "workspace_path": str(workspace),
            "plan_rel_path": "alpha.html",
            "session_id": "s1",
        },
    )
    assert not result.isError
    # Same wording as the frontend template (planExecutePrompt.ts).
    assert fake_terminals.writes == [("s1", _ALPHA_PROMPT), ("s1", "\r")]
    assert result.structuredContent == {
        "plan_rel_path": ".agent-team/plans/alpha.html",
        "session_id": "s1",
        "submitted": True,
        "prompt": _ALPHA_PROMPT,
    }


async def test_plan_dispatch_submit_false_skips_enter(
    workspace: Path, fake_terminals: _FakeTerminalService
) -> None:
    result = await _call(
        "plan_dispatch",
        {
            "workspace_path": str(workspace),
            "plan_rel_path": "alpha.html",
            "session_id": "s1",
            "submit": False,
        },
    )
    assert not result.isError
    assert fake_terminals.writes == [("s1", _ALPHA_PROMPT)]
    assert result.structuredContent["submitted"] is False


async def test_plan_dispatch_unknown_session_errors(
    workspace: Path, fake_terminals: _FakeTerminalService
) -> None:
    result = await _call(
        "plan_dispatch",
        {
            "workspace_path": str(workspace),
            "plan_rel_path": "alpha.html",
            "session_id": "nope",
        },
    )
    assert result.isError
    assert "unknown terminal session" in result.content[0].text
    assert fake_terminals.writes == []


async def test_plan_dispatch_missing_plan_errors(
    workspace: Path, fake_terminals: _FakeTerminalService
) -> None:
    result = await _call(
        "plan_dispatch",
        {
            "workspace_path": str(workspace),
            "plan_rel_path": "nope.html",
            "session_id": "s1",
        },
    )
    assert result.isError
    assert fake_terminals.writes == []


async def test_plan_dispatch_rejects_path_traversal(
    workspace: Path, fake_terminals: _FakeTerminalService
) -> None:
    result = await _call(
        "plan_dispatch",
        {
            "workspace_path": str(workspace),
            "plan_rel_path": "../secret.html",
            "session_id": "s1",
        },
    )
    assert result.isError
    assert fake_terminals.writes == []


async def test_plan_dispatch_terminal_service_unavailable(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom() -> None:
        raise RuntimeError("no event loop")

    monkeypatch.setattr(backend_app, "get_terminals", _boom)
    result = await _call(
        "plan_dispatch",
        {
            "workspace_path": str(workspace),
            "plan_rel_path": "alpha.html",
            "session_id": "s1",
        },
    )
    assert result.isError
    assert "terminal service unavailable" in result.content[0].text


async def test_list_dispatch_targets_returns_session_metadata(
    fake_terminals: _FakeTerminalService,
) -> None:
    result = await _call("list_dispatch_targets", {})
    assert not result.isError
    targets = {t["session_id"]: t for t in result.structuredContent["result"]}
    assert set(targets) == {"s1", "s2", "s3"}
    assert targets["s1"] == {
        "session_id": "s1",
        "pane_id": "pane-s1",
        "agent_key": "claude",
        "cwd": "/ws/a",
        "workspace_path": "/ws/a",  # falls back to cwd without metadata
        "alive": True,
    }
    # Explicit workspace metadata wins over cwd; closed sessions report alive=False.
    assert targets["s2"]["workspace_path"] == "/ws/b"
    assert targets["s3"]["alive"] is False


async def test_list_dispatch_targets_filters(
    fake_terminals: _FakeTerminalService,
) -> None:
    by_agent = await _call("list_dispatch_targets", {"agent_key": "codex"})
    assert [t["session_id"] for t in by_agent.structuredContent["result"]] == ["s2"]
    by_workspace = await _call("list_dispatch_targets", {"workspace": "/ws/b"})
    assert [t["session_id"] for t in by_workspace.structuredContent["result"]] == ["s2", "s3"]
    both = await _call(
        "list_dispatch_targets", {"agent_key": "claude", "workspace": "/ws/b"}
    )
    assert [t["session_id"] for t in both.structuredContent["result"]] == ["s3"]


async def test_mounted_endpoint_serves_mcp(workspace: Path) -> None:
    # Full plugin path: activate the builtin plugin, apply its registered
    # route to the real app router, run its startup hooks, then speak MCP.
    host = PluginHost()
    host.load(plugin_wiring.builtin_plugins_root() / "navide_plans")
    host.activate("navide.plans")
    routes_before = list(app.router.routes)
    plugin_wiring.apply_routes(host, app.router)
    await plugin_wiring.run_startup_hooks(host)
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            resp = await client.post(
                "/plan-mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "test", "version": "0"},
                    },
                },
                headers={"accept": "application/json, text/event-stream"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["result"]["serverInfo"]["name"] == "navide-plans"
    finally:
        await plugin_wiring.run_shutdown_hooks(host)
        app.router.routes[:] = routes_before
        host.unload("navide.plans")
