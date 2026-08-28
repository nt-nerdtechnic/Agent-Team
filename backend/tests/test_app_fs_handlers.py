"""fs.* / search.* WS handlers — worker-thread offload + payload pass-through."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, fs_service


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_fs_delete_handler_runs_in_worker_thread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """fs.delete must go through asyncio.to_thread because moving a large
    directory to the filesystem Trash may block the shared event loop."""
    (tmp_path / "junk").mkdir()
    (tmp_path / "junk" / "a.txt").write_text("x", encoding="utf-8")
    # Redirect trash to a real removal so the test stays deterministic and
    # doesn't move fixtures into the developer's actual Trash.
    monkeypatch.setattr(fs_service, "send2trash", lambda p: shutil.rmtree(p))
    threaded_fns: list[Any] = []
    orig_to_thread = asyncio.to_thread

    async def spy(fn: Any, *args: Any, **kwargs: Any) -> Any:
        threaded_fns.append(fn)
        return await orig_to_thread(fn, *args, **kwargs)

    monkeypatch.setattr(app.asyncio, "to_thread", spy)
    session = _session()

    await app.handle_message(session, {
        "id": "d1",
        "type": "fs.delete",
        "payload": {"workspace_path": str(tmp_path), "rel_path": "junk"},
    })

    assert fs_service.delete in threaded_fns
    assert not (tmp_path / "junk").exists()
    assert session.websocket.sent[0]["payload"]["ok"] is True  # type: ignore[attr-defined]
    await asyncio.sleep(0)  # let the git.changed broadcast task run out


@pytest.mark.asyncio
async def test_fs_list_dir_offloads_the_plan_watch_registration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Registering a plan watch resolves the workspace and schedules a recursive
    observer — blocking syscalls that stall for minutes on a wedged mount, so
    they must not run on the event loop (issue #24)."""
    (tmp_path / ".agent-team" / "plans").mkdir(parents=True)
    threaded_fns: list[Any] = []
    orig_to_thread = asyncio.to_thread

    async def spy(fn: Any, *args: Any, **kwargs: Any) -> Any:
        threaded_fns.append(fn)
        return await orig_to_thread(fn, *args, **kwargs)

    monkeypatch.setattr(app.asyncio, "to_thread", spy)
    session = _session()

    await app.handle_message(session, {
        "id": "l1",
        "type": "fs.list_dir",
        "payload": {"workspace_path": str(tmp_path), "rel_path": ".agent-team/plans"},
    })

    assert app._watch_plans_workspace in threaded_fns
    # The watch has to be registered before the scan it makes observable.
    assert threaded_fns.index(app._watch_plans_workspace) < threaded_fns.index(
        fs_service.list_dir
    )
    assert session.websocket.sent[0]["payload"]["ok"] is True  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_fs_delete_handler_reports_trash_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "keep.txt"
    target.write_text("keep", encoding="utf-8")

    def fail_trash(path: str) -> None:
        raise OSError("trash unavailable")

    monkeypatch.setattr(fs_service, "send2trash", fail_trash)
    session = _session()

    await app.handle_message(session, {
        "id": "d2",
        "type": "fs.delete",
        "payload": {"workspace_path": str(tmp_path), "rel_path": "keep.txt"},
    })

    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload == {"ok": False, "error": "trash unavailable"}
    assert target.read_text(encoding="utf-8") == "keep"


@pytest.mark.asyncio
async def test_fs_write_file_handler_reports_conflict(tmp_path: Path) -> None:
    """Handler passes expected_mtime through; a stale value must refuse the
    write and surface the conflict payload."""
    target = tmp_path / "a.txt"
    target.write_text("old", encoding="utf-8")
    session = _session()

    await app.handle_message(session, {
        "id": "w1",
        "type": "fs.write_file",
        "payload": {
            "workspace_path": str(tmp_path),
            "rel_path": "a.txt",
            "content": "new",
            "expected_mtime": target.stat().st_mtime - 5.0,
        },
    })

    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["ok"] is False
    assert payload["conflict"] is True
    assert payload["mtime"] == target.stat().st_mtime
    assert target.read_text(encoding="utf-8") == "old"


@pytest.mark.asyncio
async def test_fs_write_file_handler_passes_encoding(tmp_path: Path) -> None:
    target = tmp_path / "b.txt"
    session = _session()

    await app.handle_message(session, {
        "id": "w2",
        "type": "fs.write_file",
        "payload": {
            "workspace_path": str(tmp_path),
            "rel_path": "b.txt",
            "content": "中文",
            "encoding": "big5",
        },
    })

    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["ok"] is True
    assert "mtime" in payload
    assert target.read_bytes() == "中文".encode("big5")
    await asyncio.sleep(0)  # let the git.changed broadcast task run out


@pytest.mark.asyncio
async def test_fs_write_file_success_broadcasts_git_changed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A successful fs.write_file must broadcast git.changed so the frontend
    Explorer/Git panes stay in sync. This behaviour contract is load-bearing."""
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()

    await app.handle_message(session, {
        "id": "w3",
        "type": "fs.write_file",
        "payload": {
            "workspace_path": str(tmp_path),
            "rel_path": "c.txt",
            "content": "hello",
        },
    })

    assert session.websocket.sent[0]["payload"]["ok"] is True  # type: ignore[attr-defined]
    await asyncio.sleep(0)  # let the git.changed broadcast task run
    assert len(events) == 1
    assert events[0]["type"] == "git.changed"
    assert events[0]["payload"]["workspace_path"] == str(tmp_path)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("msg_type", "payload"),
    [
        ("fs.mkdir", {"rel_path": ".git/new-dir"}),
        ("fs.create_file", {"rel_path": ".git/new-file", "content": "x"}),
        ("fs.write_file", {"rel_path": ".git/config", "content": "x"}),
        ("fs.rename", {"src_path": "keep.txt", "dst_path": ".git/moved"}),
        ("fs.rename", {"src_path": ".git/config", "dst_path": "moved"}),
        ("fs.delete", {"rel_path": ".git/config"}),
    ],
)
async def test_fs_handlers_reject_git_internal_mutations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, msg_type: str, payload: dict[str, str]
) -> None:
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "config").write_text("original", encoding="utf-8")
    keep = tmp_path / "keep.txt"
    keep.write_text("keep", encoding="utf-8")
    trash_calls: list[str] = []
    monkeypatch.setattr(fs_service, "send2trash", lambda path: trash_calls.append(path))
    session = _session()

    await app.handle_message(session, {
        "id": "git-mutation",
        "type": msg_type,
        "payload": {"workspace_path": str(tmp_path), **payload},
    })

    response = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert (git_dir / "config").read_text(encoding="utf-8") == "original"
    assert keep.exists()
    assert trash_calls == []


@pytest.mark.asyncio
async def test_new_search_cancels_previous_in_flight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A second search.find_in_files from the same session must set the first
    search's cancel_event so its scan stops instead of stacking up."""
    events: list[Any] = []

    def fake_find(ws: str, query: str, **kwargs: Any) -> dict[str, Any]:
        ev = kwargs["cancel_event"]
        events.append(ev)
        if query == "slow":
            # Simulates a long rg scan; only released by cancellation.
            assert ev.wait(timeout=5), "superseded search was never cancelled"
            return {"ok": False, "error": "cancelled"}
        return {"ok": True, "results": [], "total": 0, "truncated": False}

    monkeypatch.setattr(app.search_service, "find_in_files", fake_find)
    session = _session()

    first = asyncio.create_task(app.handle_message(session, {
        "id": "s1",
        "type": "search.find_in_files",
        "payload": {"workspace_path": str(tmp_path), "query": "slow"},
    }))
    await asyncio.sleep(0.05)  # first search is now blocked in its thread
    await app.handle_message(session, {
        "id": "s2",
        "type": "search.find_in_files",
        "payload": {"workspace_path": str(tmp_path), "query": "fast"},
    })
    await first

    assert len(events) == 2
    assert events[0].is_set()      # superseded search was cancelled
    assert not events[1].is_set()  # latest search kept running
