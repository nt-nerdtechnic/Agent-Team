"""Pipeline runs mirror their state onto the recent-workspaces entry.

Nothing else writes last_known_state/last_known_task, so before this every
Welcome entry fell through to the 'spawn-only' default badge. The handler tests
drive the real pipeline.* handlers rather than the helper, so dropping the
_mirror_pipeline_state call from any of them fails here.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.projects import Project
from agent_team_backend.recent_workspaces import RecentWorkspacesStore


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[RecentWorkspacesStore, list]:
    store = RecentWorkspacesStore(path=tmp_path / "recent-workspaces.json")
    events: list = []

    async def fake_broadcast(event: dict) -> None:
        events.append(event)

    monkeypatch.setattr(app_module, "recent_workspaces_store", store, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    return store, events


def _project(tmp_path: Path, state: str, task: str = "ship the thing") -> Project:
    ws = tmp_path / "ws"
    ws.mkdir(exist_ok=True)
    return Project(
        id="proj_test",
        name="ws",
        workspace_path=str(ws),
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
        task_description=task,
        state=state,
    )


class _Session:
    """Minimal stand-in for app.Session — the handlers only send on it."""

    def __init__(self) -> None:
        self.sent: list = []

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


@pytest.fixture
def stub_app(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub the collaborators the pipeline handlers touch besides recents."""
    monkeypatch.setattr(
        app_module,
        "tokens_store",
        SimpleNamespace(
            start_run=lambda *a, **k: None,
            end_run=lambda *a, **k: None,
            snapshot=lambda *a, **k: {},
        ),
        raising=False,
    )
    monkeypatch.setattr(
        app_module, "stages_store", SimpleNamespace(get_active_pipeline_id=lambda: ""), raising=False
    )
    monkeypatch.setattr(
        app_module, "_register_workspace_and_backfill", lambda *a, **k: None, raising=False
    )
    monkeypatch.setattr(app_module, "_project_payload", lambda p: {"project": p.id}, raising=False)


# ── The helper itself ────────────────────────────────────────────────────────
async def test_mirrors_state_and_task_onto_recent_entry(
    tmp_path: Path, wired: tuple[RecentWorkspacesStore, list]
) -> None:
    store, _ = wired
    ws_handlers._mirror_pipeline_state(_project(tmp_path, "running"))
    entry = store.list()[0]
    assert entry["last_known_state"] == "running"
    assert entry["last_known_task"] == "ship the thing"


async def test_later_run_overwrites_the_earlier_state(
    tmp_path: Path, wired: tuple[RecentWorkspacesStore, list]
) -> None:
    store, _ = wired
    ws_handlers._mirror_pipeline_state(_project(tmp_path, "running"))
    ws_handlers._mirror_pipeline_state(_project(tmp_path, "completed"))
    recent = store.list()
    assert len(recent) == 1
    assert recent[0]["last_known_state"] == "completed"


async def test_a_plain_open_does_not_clear_the_badge(
    tmp_path: Path, wired: tuple[RecentWorkspacesStore, list]
) -> None:
    """Opening the folder normally sends empty state/task; the store's `if
    state:` guard is what keeps the pipeline outcome on screen."""
    store, _ = wired
    ws_handlers._mirror_pipeline_state(_project(tmp_path, "completed"))
    store.touch(str(tmp_path / "ws"))
    entry = store.list()[0]
    assert entry["last_known_state"] == "completed"
    assert entry["last_known_task"] == "ship the thing"


async def test_store_failure_never_reaches_the_pipeline_handler(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Boom:
        def touch(self, *args: object, **kwargs: object) -> None:
            raise RuntimeError("db locked")

        def list(self) -> list:
            raise AssertionError("must not be reached")

    monkeypatch.setattr(app_module, "recent_workspaces_store", Boom(), raising=False)
    # The badge is decoration; a store failure must not answer pipeline.start
    # with an error for a run that actually started.
    ws_handlers._mirror_pipeline_state(_project(tmp_path, "running"))


async def test_broadcasts_recent_changed_so_welcome_reflows(
    tmp_path: Path, wired: tuple[RecentWorkspacesStore, list]
) -> None:
    _, events = wired
    ws_handlers._mirror_pipeline_state(_project(tmp_path, "aborted"))
    await asyncio.sleep(0)  # let the create_task'd broadcast run
    assert len(events) == 1
    assert events[0]["type"] == "workspace.recent_changed"
    assert events[0]["payload"]["reason"] == "pipeline"
    assert events[0]["payload"]["recent"][0]["last_known_state"] == "aborted"


# ── The handlers are actually wired to it ────────────────────────────────────
async def test_pipeline_start_records_running(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    wired: tuple[RecentWorkspacesStore, list],
    stub_app: None,
) -> None:
    store, _ = wired
    project = _project(tmp_path, "running")
    monkeypatch.setattr(
        app_module,
        "project_store",
        SimpleNamespace(start_pipeline=lambda *a, **k: project),
        raising=False,
    )
    session = _Session()
    await ws_handlers.pipeline_start(
        session, "1", "pipeline.start", {"workspace_path": project.workspace_path}
    )
    assert store.list()[0]["last_known_state"] == "running"
    assert session.sent, "the handler must still answer the request"


async def test_pipeline_complete_records_completed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    wired: tuple[RecentWorkspacesStore, list],
    stub_app: None,
) -> None:
    store, _ = wired
    project = _project(tmp_path, "completed")
    monkeypatch.setattr(
        app_module,
        "project_store",
        SimpleNamespace(complete_pipeline=lambda p: project),
        raising=False,
    )
    session = _Session()
    await ws_handlers.pipeline_complete(
        session, "1", "pipeline.complete", {"workspace_path": project.workspace_path}
    )
    assert store.list()[0]["last_known_state"] == "completed"
    assert session.sent


async def test_pipeline_abort_records_aborted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    wired: tuple[RecentWorkspacesStore, list],
    stub_app: None,
) -> None:
    store, _ = wired
    project = _project(tmp_path, "aborted")
    monkeypatch.setattr(
        app_module,
        "project_store",
        SimpleNamespace(abort_pipeline=lambda p, reason="user": project),
        raising=False,
    )
    session = _Session()
    await ws_handlers.pipeline_abort(
        session, "1", "pipeline.abort", {"workspace_path": project.workspace_path}
    )
    assert store.list()[0]["last_known_state"] == "aborted"
    assert session.sent


async def test_pipeline_resume_records_running(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    wired: tuple[RecentWorkspacesStore, list],
    stub_app: None,
) -> None:
    store, _ = wired
    project = _project(tmp_path, "running")
    monkeypatch.setattr(
        app_module,
        "project_store",
        SimpleNamespace(resume_pipeline=lambda p: (project, 2)),
        raising=False,
    )
    session = _Session()
    await ws_handlers.pipeline_resume(
        session, "1", "pipeline.resume", {"workspace_path": project.workspace_path}
    )
    assert store.list()[0]["last_known_state"] == "running"
    assert session.sent
