"""Stage edits are refused for the pipeline a run is using, and they publish
the pipeline summaries again.

Two defects:

1. The PIPELINE_RUNNING guard on stages.upsert/reorder/delete only fired when
   the request omitted ``pipeline_id``, so naming the running pipeline
   explicitly walked past it and edited the flow mid-run; stages.reset had no
   guard at all. The guard now compares against the pipeline the run recorded
   (``Project.pipeline_id``, set by pipeline.start) whether or not the request
   names one.
2. Those handlers broadcast stages.changed only. ``PipelineSummary.stage_count``
   ("N stages" in the pipeline list) is carried by pipelines.changed, so adding
   or deleting a stage left a stale count on screen until the next reconnect.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore

RUNNING_WS = "/tmp/does-not-need-to-exist"


class _Session:
    """Minimal stand-in for app.Session — the handlers only send on it."""

    def __init__(self) -> None:
        self.sent: list = []

    @property
    def last(self) -> dict:
        assert self.sent, "the handler must answer the request"
        return self.sent[-1]

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


def _stage(stage_id: str) -> dict:
    return {
        "id": stage_id,
        "title": stage_id,
        "short_title": stage_id,
        "question": "?",
        "description": "",
        "recommended_roles": [],
        "sentinel": "---DONE---",
        "slots": [
            {
                "agent_key": "claude",
                "role_key": "",
                "label": "A",
                "kickoff_body": "",
                "is_commander": False,
            }
        ],
    }


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Real StagesStore, stubbed project store and broadcast."""
    store = StagesStore(tmp_path / PIPELINES_FILE)
    events: list = []
    running: dict = {"project": None}

    async def fake_broadcast(event: dict) -> None:
        events.append(event)

    def peek(workspace_path: str):
        project = running["project"]
        if project is None or workspace_path != project.workspace_path:
            return None
        return project

    monkeypatch.setattr(app_module, "stages_store", store, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(
        app_module, "project_store", SimpleNamespace(peek=peek), raising=False
    )

    def set_running(pipeline_id: str, state: str = "running") -> None:
        running["project"] = SimpleNamespace(
            workspace_path=RUNNING_WS, state=state, pipeline_id=pipeline_id
        )

    return SimpleNamespace(store=store, events=events, set_running=set_running)


def _error_code(message: dict) -> str:
    return (message.get("error") or {}).get("code", "")


def _reasons(events: list, event_type: str) -> list[str]:
    return [e["payload"].get("reason") for e in events if e["type"] == event_type]


# ── 1. the running pipeline cannot be edited, named or not ─────────────────────

class TestRunningGuard:
    async def test_upsert_refused_when_the_named_pipeline_is_running(self, wired):
        wired.set_running("default")
        session = _Session()
        await ws_handlers.stages_upsert(
            session,
            "1",
            "stages.upsert",
            {
                "stage": _stage("sneaky"),
                "pipeline_id": "default",
                "workspace_path": RUNNING_WS,
            },
        )
        assert _error_code(session.last) == "PIPELINE_RUNNING"
        assert not any(s["id"] == "sneaky" for s in wired.store.list("default"))

    async def test_delete_refused_when_the_named_pipeline_is_running(self, wired):
        wired.set_running("default")
        before = [s["id"] for s in wired.store.list("default")]
        session = _Session()
        await ws_handlers.stages_delete(
            session,
            "1",
            "stages.delete",
            {"id": before[0], "pipeline_id": "default", "workspace_path": RUNNING_WS},
        )
        assert _error_code(session.last) == "PIPELINE_RUNNING"
        assert [s["id"] for s in wired.store.list("default")] == before

    async def test_reorder_refused_when_the_named_pipeline_is_running(self, wired):
        wired.set_running("default")
        before = [s["id"] for s in wired.store.list("default")]
        session = _Session()
        await ws_handlers.stages_reorder(
            session,
            "1",
            "stages.reorder",
            {
                "ids": list(reversed(before)),
                "pipeline_id": "default",
                "workspace_path": RUNNING_WS,
            },
        )
        assert _error_code(session.last) == "PIPELINE_RUNNING"
        assert [s["id"] for s in wired.store.list("default")] == before

    async def test_reset_refused_when_the_named_pipeline_is_running(self, wired):
        wired.set_running("default")
        wired.store.delete("01", "default")
        before = [s["id"] for s in wired.store.list("default")]
        session = _Session()
        await ws_handlers.stages_reset(
            session,
            "1",
            "stages.reset",
            {"pipeline_id": "default", "workspace_path": RUNNING_WS},
        )
        assert _error_code(session.last) == "PIPELINE_RUNNING"
        assert [s["id"] for s in wired.store.list("default")] == before

    async def test_a_different_pipeline_stays_editable_during_a_run(self, wired):
        wired.set_running("default")
        session = _Session()
        await ws_handlers.stages_upsert(
            session,
            "1",
            "stages.upsert",
            {
                "stage": _stage("m-new"),
                "pipeline_id": "maintenance",
                "workspace_path": RUNNING_WS,
            },
        )
        assert session.last["ok"] is True
        assert any(s["id"] == "m-new" for s in wired.store.list("maintenance"))

    async def test_omitted_pipeline_id_is_still_refused(self, wired):
        """The original guard shape: no pipeline_id means the active pipeline."""
        wired.set_running("")
        session = _Session()
        await ws_handlers.stages_upsert(
            session,
            "1",
            "stages.upsert",
            {"stage": _stage("sneaky"), "workspace_path": RUNNING_WS},
        )
        assert _error_code(session.last) == "PIPELINE_RUNNING"

    async def test_an_idle_project_blocks_nothing(self, wired):
        wired.set_running("default", state="idle")
        session = _Session()
        await ws_handlers.stages_upsert(
            session,
            "1",
            "stages.upsert",
            {
                "stage": _stage("fine"),
                "pipeline_id": "default",
                "workspace_path": RUNNING_WS,
            },
        )
        assert session.last["ok"] is True


# ── 1b. reset_builtin is a stage edit too ──────────────────────────────────────

class TestResetBuiltinRunningGuard:
    """Restoring a builtin pipeline replaces every stage it has, so it needs the
    same guard as the single-stage edits — it had none at all."""

    async def test_refused_while_that_pipeline_is_running(self, wired):
        wired.set_running("default")
        wired.store.delete("01", "default")
        before = [s["id"] for s in wired.store.list("default")]
        session = _Session()
        await ws_handlers.pipelines_reset_builtin(
            session,
            "1",
            "pipelines.reset_builtin",
            {"pipeline_id": "default", "workspace_path": RUNNING_WS},
        )
        assert _error_code(session.last) == "PIPELINE_RUNNING"
        assert [s["id"] for s in wired.store.list("default")] == before

    async def test_the_error_shape_matches_the_stage_handlers(self, wired):
        wired.set_running("default")
        session = _Session()
        await ws_handlers.pipelines_reset_builtin(
            session,
            "1",
            "pipelines.reset_builtin",
            {"pipeline_id": "default", "workspace_path": RUNNING_WS},
        )
        refusal = session.last
        assert refusal["ok"] is False
        assert refusal["payload"] is None
        assert refusal["error"]["code"] == "PIPELINE_RUNNING"
        assert refusal["error"]["message"]

    async def test_a_different_builtin_stays_resettable(self, wired):
        wired.set_running("default")
        wired.store.delete("m01", "maintenance")
        session = _Session()
        await ws_handlers.pipelines_reset_builtin(
            session,
            "1",
            "pipelines.reset_builtin",
            {"pipeline_id": "maintenance", "workspace_path": RUNNING_WS},
        )
        assert session.last["ok"] is True
        assert any(s["id"] == "m01" for s in wired.store.list("maintenance"))

    async def test_without_a_workspace_path_nothing_is_blocked(self, wired):
        """A caller that sends no workspace_path must keep working exactly as it
        did — the guard is an addition, not a new requirement."""
        wired.set_running("default")
        wired.store.delete("01", "default")
        session = _Session()
        await ws_handlers.pipelines_reset_builtin(
            session, "1", "pipelines.reset_builtin", {"pipeline_id": "default"}
        )
        assert session.last["ok"] is True
        assert any(s["id"] == "01" for s in wired.store.list("default"))

    async def test_an_idle_project_blocks_nothing(self, wired):
        wired.set_running("default", state="idle")
        wired.store.delete("01", "default")
        session = _Session()
        await ws_handlers.pipelines_reset_builtin(
            session,
            "1",
            "pipelines.reset_builtin",
            {"pipeline_id": "default", "workspace_path": RUNNING_WS},
        )
        assert session.last["ok"] is True
        assert any(s["id"] == "01" for s in wired.store.list("default"))


# ── 2. stage_count reaches the pipeline list ───────────────────────────────────

class TestStageCountBroadcast:
    async def test_upsert_republishes_the_pipeline_summaries(self, wired):
        session = _Session()
        await ws_handlers.stages_upsert(
            session, "1", "stages.upsert", {"stage": _stage("extra"), "pipeline_id": "default"}
        )
        changed = [e for e in wired.events if e["type"] == "pipelines.changed"]
        assert changed, "the pipeline list carries stage_count and must be refreshed"
        summary = next(p for p in changed[-1]["payload"]["pipelines"] if p["id"] == "default")
        assert summary["stage_count"] == len(wired.store.list("default"))

    async def test_delete_republishes_the_pipeline_summaries(self, wired):
        first = wired.store.list("default")[0]["id"]
        session = _Session()
        await ws_handlers.stages_delete(
            session, "1", "stages.delete", {"id": first, "pipeline_id": "default"}
        )
        changed = [e for e in wired.events if e["type"] == "pipelines.changed"]
        assert changed
        summary = next(p for p in changed[-1]["payload"]["pipelines"] if p["id"] == "default")
        assert summary["stage_count"] == len(wired.store.list("default"))

    async def test_reset_republishes_the_pipeline_summaries(self, wired):
        wired.store.delete("01", "default")
        session = _Session()
        await ws_handlers.stages_reset(
            session, "1", "stages.reset", {"pipeline_id": "default"}
        )
        changed = [e for e in wired.events if e["type"] == "pipelines.changed"]
        assert changed
        summary = next(p for p in changed[-1]["payload"]["pipelines"] if p["id"] == "default")
        assert summary["stage_count"] == len(wired.store.list("default"))

    async def test_stages_changed_is_still_broadcast(self, wired):
        session = _Session()
        await ws_handlers.stages_upsert(
            session, "1", "stages.upsert", {"stage": _stage("extra"), "pipeline_id": "default"}
        )
        assert _reasons(wired.events, "stages.changed") == ["upsert"]
