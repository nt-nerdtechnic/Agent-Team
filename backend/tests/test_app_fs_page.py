"""Tests for the GET /fs/page/{ws_b64}/{rel:path} HTTP endpoint.

Path-addressed variant of /fs/raw so relative subresources resolve; adds
text/css and font mimes to the inline allowlist.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app as app_module
from agent_team_backend.app import app


@pytest.fixture()
def client() -> TestClient:
    # No context manager: startup events (watchers/MCP) must not run in tests.
    # base_url pinned to loopback: the default "testserver" Host is exactly
    # what reject_foreign_host refuses.
    return TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture()
def workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "page.html").write_text('<link rel="stylesheet" href="./sub/style.css">')
    (ws / "style.css").write_text("body { margin: 0 }")
    (ws / "font.woff2").write_bytes(b"wOF2fake")
    (ws / "script.js").write_text("alert(1)")
    (ws / "sub").mkdir()
    (ws / "sub" / "style.css").write_text("h1 { color: red }")
    (tmp_path / "outside.txt").write_text("outside")
    return ws


def _ws_b64(ws) -> str:
    # Unpadded, as the frontend sends it; the route must re-pad.
    return base64.urlsafe_b64encode(str(ws).encode()).decode().rstrip("=")


def _get(client, ws, rel, **kwargs):
    return client.get(f"/fs/page/{_ws_b64(ws)}/{rel}", **kwargs)


def test_page_html_inline_with_csp_sandbox(client, workspace):
    resp = _get(client, workspace, "page.html")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "content-disposition" not in resp.headers
    assert resp.headers["content-security-policy"] == "sandbox"
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_page_agent_team_plans_html_served(client, workspace):
    # Plan preview: the iframe loads plan HTML from .agent-team/plans via
    # this route; the plans subtree is exempt from the internal-dir guard.
    plans = workspace / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    (plans / "plan.html").write_text("<h1>plan</h1>")
    resp = _get(client, workspace, ".agent-team/plans/plan.html")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert resp.headers["content-security-policy"] == "sandbox"


def test_page_agent_team_root_still_protected(client, workspace):
    (workspace / ".agent-team").mkdir(exist_ok=True)
    (workspace / ".agent-team" / "secret.txt").write_text("internal")
    resp = _get(client, workspace, ".agent-team/secret.txt")
    assert resp.status_code == 400


def test_page_css_inline(client, workspace):
    # /fs/page difference vs /fs/raw: stylesheets load inline so relative
    # ./style.css subresources work in the sandboxed HTML preview.
    resp = _get(client, workspace, "style.css")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/css")
    assert "content-disposition" not in resp.headers
    assert resp.headers["content-security-policy"] == "sandbox"


def test_page_font_inline(client, workspace):
    resp = _get(client, workspace, "font.woff2")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "font/woff2"
    assert "content-disposition" not in resp.headers
    assert resp.headers["content-security-policy"] == "sandbox"


def test_page_js_downgraded_to_attachment(client, workspace):
    # Scripts stay blocked: same XSS policy as /fs/raw.
    resp = _get(client, workspace, "script.js")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/octet-stream"
    assert resp.headers["content-disposition"].startswith("attachment")
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_page_subdirectory_rel_path(client, workspace):
    resp = _get(client, workspace, "sub/style.css")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/css")
    assert resp.text == "h1 { color: red }"


def test_page_path_escape_rejected(client, workspace):
    # Encoded %2F so the client does not dot-normalize the segment away;
    # starlette decodes it into the rel path param.
    resp = _get(client, workspace, "..%2Foutside.txt")
    assert resp.status_code == 400


def test_page_bad_base64_returns_400(client, workspace):
    resp = client.get("/fs/page/!!!invalid!!!/style.css")
    assert resp.status_code == 400


def test_page_padded_base64_accepted(client, workspace):
    padded = base64.urlsafe_b64encode(str(workspace).encode()).decode()
    resp = client.get(f"/fs/page/{padded}/style.css")
    assert resp.status_code == 200


def test_page_missing_file_returns_404(client, workspace):
    resp = _get(client, workspace, "nope.css")
    assert resp.status_code == 404


def test_page_offloads_the_blocking_helper(client, workspace, monkeypatch):
    """Same reason as /fs/raw: the blocking stat work must leave the loop."""
    threaded_fns: list[Any] = []
    orig_to_thread = asyncio.to_thread

    async def spy(fn: Any, *args: Any, **kwargs: Any) -> Any:
        threaded_fns.append(fn)
        return await orig_to_thread(fn, *args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", spy)
    resp = _get(client, workspace, "style.css")

    assert resp.status_code == 200
    assert app_module._serve_workspace_file in threaded_fns
