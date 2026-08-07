"""workspace.list_orphan_sessions + pane.reconnect_session RPC handlers.

list_orphan_sessions enumerates a workspace's Claude transcripts (locating them
via the CJK-dash-encoded project dir), excludes any id a live pane still holds,
attaches preview/size/mtime, and sorts newest first. pane.reconnect_session
refuses a session id with no transcript and, for a real one, rebinds the pane
and returns the project payload.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.log_readers.claude import encode_claude_cwd
from agent_team_backend.projects import PaneRecord


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> "app.Session":
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def _sent(session: "app.Session") -> dict[str, Any]:
    return session.websocket.sent[0]  # type: ignore[attr-defined]


def _user_line(text: str) -> str:
    return json.dumps(
        {"type": "user", "message": {"role": "user", "content": text}},
        ensure_ascii=False,
    ) + "\n"


def _make_transcript(projects_dir: Path, session_id: str, mtime: float) -> Path:
    f = projects_dir / f"{session_id}.jsonl"
    f.write_text(_user_line(f"prompt for {session_id}"), encoding="utf-8")
    os.utime(f, (mtime, mtime))
    return f


@pytest.fixture()
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, Path]:
    """A CJK-named workspace with a redirected ~/.claude and its encoded dir."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    ws_dir = tmp_path / "測試專案"
    ws_dir.mkdir()
    ws = str(ws_dir)
    encoded = encode_claude_cwd(ws)
    # Lock the encoding: every CJK char in the leaf becomes one "-".
    assert encoded.endswith("-" * len("測試專案"))
    projects_dir = tmp_path / ".claude" / "projects" / encoded
    projects_dir.mkdir(parents=True)
    return ws, projects_dir


@pytest.mark.asyncio
async def test_list_orphan_sessions_excludes_live_and_sorts_newest_first(
    workspace: tuple[str, Path],
) -> None:
    ws, projects_dir = workspace
    _make_transcript(projects_dir, "live-sess", mtime=1000.0)
    _make_transcript(projects_dir, "orphan-old", mtime=2000.0)
    _make_transcript(projects_dir, "orphan-new", mtime=3000.0)

    project = app.project_store.load_or_create(ws)
    project.panes = [
        PaneRecord(pane_id="P", origin="manual", session_id="live-sess", spawn_status="spawned")
    ]
    app.project_store.save(project)

    session = _session()
    await app.handle_message(session, {
        "id": "r1",
        "type": "workspace.list_orphan_sessions",
        "payload": {"workspace_path": ws},
    })

    resp = _sent(session)
    assert resp["type"] == "workspace.list_orphan_sessions.result"
    orphans = resp["payload"]["orphans"]
    # live-sess excluded; remaining sorted newest mtime first.
    assert [o["session_id"] for o in orphans] == ["orphan-new", "orphan-old"]
    newest = orphans[0]
    assert newest["preview"] == ["prompt for orphan-new"]
    assert newest["size_bytes"] > 0
    assert newest["mtime"] == 3000.0
    assert newest["resumable"] is True


@pytest.mark.asyncio
async def test_list_orphan_sessions_still_offers_a_pending_stubs_session(
    workspace: tuple[str, Path],
) -> None:
    """A pending record is a stub whose spawn never landed (see
    record_manual_pane_session). Its session has no live pane holding it, so
    reconnect must still offer it — treating the stub as live would hide the
    transcript forever."""
    ws, projects_dir = workspace
    _make_transcript(projects_dir, "stub-sess", mtime=1000.0)

    project = app.project_store.load_or_create(ws)
    project.panes = [PaneRecord(pane_id="P", origin="manual", session_id="stub-sess")]
    assert project.panes[0].spawn_status == "pending"
    app.project_store.save(project)

    session = _session()
    await app.handle_message(session, {
        "id": "r1",
        "type": "workspace.list_orphan_sessions",
        "payload": {"workspace_path": ws},
    })

    orphans = _sent(session)["payload"]["orphans"]
    assert [o["session_id"] for o in orphans] == ["stub-sess"]


@pytest.mark.asyncio
async def test_reconnect_session_refuses_missing_transcript(
    workspace: tuple[str, Path],
) -> None:
    ws, _projects_dir = workspace
    project = app.project_store.load_or_create(ws)
    project.panes = [PaneRecord(pane_id="P", origin="manual", session_id="")]
    app.project_store.save(project)

    session = _session()
    await app.handle_message(session, {
        "id": "r2",
        "type": "pane.reconnect_session",
        "payload": {"workspace_path": ws, "pane_id": "P", "session_id": "no-such"},
    })

    resp = _sent(session)
    assert resp["ok"] is False
    assert resp["error"]["code"] == "NO_TRANSCRIPT"


@pytest.mark.asyncio
async def test_reconnect_session_rebinds_and_returns_payload(
    workspace: tuple[str, Path],
) -> None:
    ws, projects_dir = workspace
    _make_transcript(projects_dir, "target-sess", mtime=1000.0)
    project = app.project_store.load_or_create(ws)
    project.panes = [PaneRecord(pane_id="P", origin="manual", session_id="old")]
    app.project_store.save(project)

    session = _session()
    await app.handle_message(session, {
        "id": "r3",
        "type": "pane.reconnect_session",
        "payload": {"workspace_path": ws, "pane_id": "P", "session_id": "target-sess"},
    })

    resp = _sent(session)
    assert resp["ok"] is True
    panes = resp["payload"]["project"]["panes"]
    assert next(p for p in panes if p["pane_id"] == "P")["session_id"] == "target-sess"
