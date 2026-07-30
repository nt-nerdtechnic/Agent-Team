"""ProjectStore.set_ui_state — per-workspace run-group records + active tab.

The run-group tab records are renderer-owned UI state persisted on the
Project. Covers round-trips through disk, partial updates, the None/[] field
semantics (None = never persisted → frontend runs legacy migration; [] = the
user deleted every group), peek semantics, and backward-compatible defaults
for old project.json files without the fields.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from agent_team_backend.projects import ProjectStore


def _store_with_project(ws: Path) -> ProjectStore:
    store = ProjectStore()
    store.save(store.load_or_create(str(ws)))
    return store


GROUPS = [
    {"id": "rg-default", "name": "預設", "createdAt": 1},
    {"id": "rg-2", "name": "Run 2", "createdAt": 2},
]


def test_run_groups_round_trip_through_disk(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    result = store.set_ui_state(str(tmp_path), run_groups=GROUPS)
    assert result is not None
    assert result.ui_run_groups == GROUPS
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == GROUPS


def test_active_tab_round_trip_through_disk(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), active_tab="rg-2")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_active_tab == "rg-2"


def test_partial_update_leaves_other_field_untouched(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), run_groups=GROUPS, active_tab="rg-2")
    store.set_ui_state(str(tmp_path), active_tab="manual")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == GROUPS
    assert fresh.ui_active_tab == "manual"


def test_git_tab_repo_round_trip_through_disk(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), git_tab_repo="/ws/sub/repo")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_git_tab_repo == "/ws/sub/repo"


def test_spawn_history_round_trip_through_disk(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace-a"
    other_workspace = tmp_path / "workspace-b"
    workspace.mkdir()
    other_workspace.mkdir()
    store = _store_with_project(workspace)
    _store_with_project(other_workspace)
    history = [{
        "paneId": "pane-1",
        "agentKey": "codex",
        "agentLabel": "Codex",
        "customName": "Workspace title",
        "workspacePath": str(workspace),
    }]
    store.set_ui_state(str(workspace), spawn_history=history)
    fresh = ProjectStore().peek(str(workspace))
    assert fresh is not None
    assert fresh.ui_spawn_history == history
    other = ProjectStore().peek(str(other_workspace))
    assert other is not None
    assert other.ui_spawn_history is None


def test_empty_spawn_history_is_distinct_from_legacy_missing_field(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), spawn_history=[])
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_spawn_history == []


def test_git_tab_repo_partial_update_leaves_other_fields_untouched(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), run_groups=GROUPS, active_tab="rg-2")
    store.set_ui_state(str(tmp_path), git_tab_repo="/ws/repo-a")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == GROUPS
    assert fresh.ui_active_tab == "rg-2"
    assert fresh.ui_git_tab_repo == "/ws/repo-a"


def test_empty_list_is_stored_distinct_from_never_set(tmp_path: Path) -> None:
    """[] (user deleted all groups) must survive a reload — not decay to None."""
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), run_groups=[])
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == []


def test_no_arguments_is_a_no_op(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    assert store.set_ui_state(str(tmp_path)) is None
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups is None


def test_no_project_returns_none_and_creates_nothing(tmp_path: Path) -> None:
    """peek semantics: setting UI state must never create a project.json."""
    store = ProjectStore()
    assert store.set_ui_state(str(tmp_path), active_tab="rg-1") is None
    assert not store.project_file(str(tmp_path)).exists()


def test_legacy_project_json_without_fields_defaults(tmp_path: Path) -> None:
    """Backward compat: legacy project.json without the fields → None / ''."""
    legacy = tmp_path / ".agent-team" / "project.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(json.dumps({
        "id": "p1", "name": "x", "workspace_path": str(tmp_path),
        "created_at": "t", "updated_at": "t",
    }), encoding="utf-8")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups is None
    assert fresh.ui_active_tab == ""
    assert fresh.ui_git_tab_repo == ""
    assert fresh.ui_spawn_history is None


# ── event-loop offload (project.set_ui_state must not lose state) ────────────


async def test_set_ui_state_handler_offloads_and_round_trips(
    tmp_path: Path, monkeypatch
) -> None:
    """The ws handler path (asyncio.to_thread → store) still persists and acks."""
    from agent_team_backend import app, ws_handlers

    store = _store_with_project(tmp_path)
    monkeypatch.setattr(app, "project_store", store)

    async def no_broadcast(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(app, "broadcast", no_broadcast)

    class FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []

        async def send_json(self, payload: dict[str, Any]) -> None:
            self.sent.append(payload)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.set_ui_state")
    assert fn is not None
    await fn(session, "m1", "project.set_ui_state", {
        "workspace_path": str(tmp_path),
        "run_groups": GROUPS,
        "active_tab": "rg-2",
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"] == {"ok": True}
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == GROUPS
    assert fresh.ui_active_tab == "rg-2"


async def test_set_ui_state_handler_merges_full_spawn_history_store(
    tmp_path: Path, monkeypatch
) -> None:
    """spawn_history payloads land in the full store (workspace db,
    upsert-only) while the project document keeps its 100-entry mirror."""
    from agent_team_backend import app, ws_handlers
    from agent_team_backend.spawn_history import read_stored_entries

    store = _store_with_project(tmp_path)
    # Pre-existing mirror from before the full store existed → seeds it.
    store.set_ui_state(str(tmp_path), spawn_history=[{"paneId": "legacy-1"}])
    monkeypatch.setattr(app, "project_store", store)

    async def no_broadcast(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(app, "broadcast", no_broadcast)

    class FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []

        async def send_json(self, payload: dict[str, Any]) -> None:
            self.sent.append(payload)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.set_ui_state")
    assert fn is not None
    # 150 entries: the mirror truncates to the newest 100, the full store keeps all.
    history = [{"paneId": f"p{i}"} for i in range(150)]
    await fn(session, "m1", "project.set_ui_state", {
        "workspace_path": str(tmp_path),
        "spawn_history": history,
    })

    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_spawn_history == history[-100:]
    stored = read_stored_entries(str(tmp_path))
    # legacy-1 was seeded from the old mirror, then all 150 merged after it.
    assert [e["paneId"] for e in stored] == ["legacy-1"] + [f"p{i}" for i in range(150)]

    # A later windowed snapshot never deletes older full-store entries.
    await fn(session, "m2", "project.set_ui_state", {
        "workspace_path": str(tmp_path),
        "spawn_history": [{"paneId": "p149", "customName": "Renamed"}],
    })
    stored = read_stored_entries(str(tmp_path))
    assert len(stored) == 151
    assert stored[-1] == {"paneId": "p149", "customName": "Renamed"}


async def test_set_ui_state_handler_filters_foreign_spawn_history(
    tmp_path: Path, monkeypatch
) -> None:
    """Workspace isolation at the write layer: entries whose workspacePath
    belongs to another workspace reach neither the project mirror nor
    the full store."""
    from agent_team_backend import app, ws_handlers
    from agent_team_backend.spawn_history import read_stored_entries

    store = _store_with_project(tmp_path)
    monkeypatch.setattr(app, "project_store", store)

    async def no_broadcast(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(app, "broadcast", no_broadcast)

    class FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []

        async def send_json(self, payload: dict[str, Any]) -> None:
            self.sent.append(payload)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.set_ui_state")
    assert fn is not None
    await fn(session, "m1", "project.set_ui_state", {
        "workspace_path": str(tmp_path),
        "spawn_history": [
            {"paneId": "mine", "workspacePath": str(tmp_path)},
            {"paneId": "foreign", "workspacePath": str(tmp_path / "other")},
        ],
    })

    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_spawn_history is not None
    assert [e["paneId"] for e in fresh.ui_spawn_history] == ["mine"]
    stored = read_stored_entries(str(tmp_path))
    assert [e["paneId"] for e in stored] == ["mine"]


async def test_concurrent_offloaded_saves_serialize(tmp_path: Path) -> None:
    """Concurrent set_ui_state calls on worker threads (the ws handler offloads
    via asyncio.to_thread) must serialize: each writer's field pair lands
    atomically (no torn read-modify-write)."""
    store = _store_with_project(tmp_path)
    # Bulk payload widens the write window so unserialized saves would tear.
    filler = [{"paneId": f"p{i}", "agentLabel": "x" * 200} for i in range(50)]

    def write(i: int) -> None:
        store.set_ui_state(
            str(tmp_path),
            run_groups=[{"id": f"rg-{i}"}],
            active_tab=f"rg-{i}",
            spawn_history=filler,
        )

    await asyncio.gather(*(asyncio.to_thread(write, i) for i in range(30)))

    # Last-writer-wins, but the winning writer's two fields must be from the
    # SAME call, and a fresh store must read a consistent document back.
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == [{"id": fresh.ui_active_tab}]
    assert fresh.ui_active_tab.startswith("rg-")
    assert fresh.ui_spawn_history == filler
