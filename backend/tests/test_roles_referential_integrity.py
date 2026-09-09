"""A stage slot must never point at a role that no longer exists.

Deleting a role used to leave the slot's role_key dangling. The renderer looks
the role up by key before it injects (App.vue: `rolesApi.find(pane.roleKey)`);
a miss marks the pane failed and returns *before* the kickoff step, so that
stage's agent sits at an empty prompt forever with only a pipeline-log line to
explain it. An empty role_key, by contrast, is a state the renderer handles —
role injection is skipped and the kickoff still goes out.

So the two shapes of role removal are handled differently:

* roles.delete is a single deliberate act and can be refused: it answers
  ROLE_IN_USE with the slots that would break.
* roles.reset and settings.bundle.import replace the whole set and cannot be
  refused, so they blank the slots whose role_key did not survive.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.roles_store import ROLES_FILE, RolesStore
from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore


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


def _slot(role_key: str, label: str = "A") -> dict:
    return {
        "agent_key": "claude",
        "role_key": role_key,
        "label": label,
        "kickoff_body": "",
        "is_commander": False,
    }


def _stage(stage_id: str, *slots: dict) -> dict:
    return {
        "id": stage_id,
        "title": f"{stage_id} title",
        "short_title": stage_id,
        "question": "?",
        "description": "",
        "recommended_roles": [],
        "sentinel": "---DONE---",
        "slots": list(slots),
    }


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Real RolesStore and StagesStore, stubbed broadcast."""
    roles = RolesStore(tmp_path / ROLES_FILE)
    stages = StagesStore(tmp_path / PIPELINES_FILE)
    events: list = []

    async def fake_broadcast(event: dict) -> None:
        events.append(event)

    monkeypatch.setattr(app_module, "roles_store", roles, raising=False)
    monkeypatch.setattr(app_module, "stages_store", stages, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(app_module, "_settings_paths", lambda: {}, raising=False)
    # Nothing here starts a run, but the stage handlers' guard reads it.
    monkeypatch.setattr(
        app_module, "project_store", SimpleNamespace(peek=lambda _p: None), raising=False
    )

    # A pipeline whose slots name real roles, so "used" and "unused" are both
    # reachable without depending on the seed content.
    pid = stages.create_pipeline("Custom")["id"]
    stages.upsert(_stage("s-01", _slot("pm", "Planner"), _slot("qa", "Tester")), pid)
    stages.upsert(_stage("s-02", _slot("backend", "Builder")), pid)
    return SimpleNamespace(roles=roles, stages=stages, events=events, pipeline_id=pid)


def _role_keys_in(stages: StagesStore, pipeline_id: str) -> list[str]:
    return [
        slot.get("role_key", "")
        for stage in stages.list(pipeline_id)
        for slot in stage.get("slots") or []
    ]


# ── (a) roles.delete is refused while a slot still names the role ──────────────

class TestDeleteRefusedWhenInUse:
    async def test_delete_answers_role_in_use(self, wired):
        session = _Session()
        await ws_handlers.roles_delete(session, "1", "roles.delete", {"key": "pm"})
        assert session.last["ok"] is False
        assert session.last["error"]["code"] == "ROLE_IN_USE"

    async def test_the_role_survives_the_refusal(self, wired):
        session = _Session()
        await ws_handlers.roles_delete(session, "1", "roles.delete", {"key": "pm"})
        assert wired.roles.get("pm") is not None

    async def test_the_error_names_pipeline_stage_and_slot(self, wired):
        session = _Session()
        await ws_handlers.roles_delete(session, "1", "roles.delete", {"key": "pm"})
        usages = session.last["error"]["details"]["usages"]
        assert session.last["error"]["details"]["role_key"] == "pm"
        mine = [u for u in usages if u["pipeline_id"] == wired.pipeline_id]
        assert mine == [
            {
                "pipeline_id": wired.pipeline_id,
                "pipeline_name": "Custom",
                "stage_id": "s-01",
                "stage_title": "s-01 title",
                "slot_label": "Planner",
            }
        ]

    async def test_every_using_slot_is_listed(self, wired):
        """The seed pipelines use "qa" too, so the list must span pipelines."""
        session = _Session()
        await ws_handlers.roles_delete(session, "1", "roles.delete", {"key": "qa"})
        usages = session.last["error"]["details"]["usages"]
        assert len(usages) > 1
        assert wired.pipeline_id in {u["pipeline_id"] for u in usages}

    async def test_an_unused_role_still_deletes(self, wired):
        wired.roles.upsert(
            key="spare", label="Spare", one_line="", system_prompt="unused"
        )
        session = _Session()
        await ws_handlers.roles_delete(session, "1", "roles.delete", {"key": "spare"})
        assert session.last["ok"] is True
        assert wired.roles.get("spare") is None
        assert any(e["type"] == "roles.changed" for e in wired.events)


# ── (b) wholesale replacement blanks the references it invalidated ─────────────

class TestResetClearsDanglingReferences:
    async def test_reset_blanks_slots_whose_role_is_gone(self, wired):
        wired.roles.upsert(
            key="custom", label="Custom", one_line="", system_prompt="x"
        )
        wired.stages.upsert(_stage("s-03", _slot("custom", "Custom slot")), wired.pipeline_id)

        session = _Session()
        await ws_handlers.roles_reset(session, "1", "roles.reset", {})

        assert session.last["ok"] is True
        assert wired.roles.get("custom") is None
        stage = next(
            s for s in wired.stages.list(wired.pipeline_id) if s["id"] == "s-03"
        )
        assert stage["slots"][0]["role_key"] == ""

    async def test_reset_leaves_still_valid_references_alone(self, wired):
        session = _Session()
        await ws_handlers.roles_reset(session, "1", "roles.reset", {})
        # pm/qa/backend are all in the seed set, so nothing should be blanked.
        assert _role_keys_in(wired.stages, wired.pipeline_id) == ["pm", "qa", "backend"]

    async def test_reset_broadcasts_the_cleaned_stages(self, wired):
        wired.roles.upsert(key="custom", label="Custom", one_line="", system_prompt="x")
        wired.stages.upsert(_stage("s-03", _slot("custom", "Custom slot")), wired.pipeline_id)

        session = _Session()
        await ws_handlers.roles_reset(session, "1", "roles.reset", {})

        changed = [
            e for e in wired.events
            if e["type"] == "stages.changed"
            and e["payload"]["pipeline_id"] == wired.pipeline_id
        ]
        assert changed, "the renderer must be told the slots were rewritten"
        stage = next(s for s in changed[-1]["payload"]["stages"] if s["id"] == "s-03")
        assert stage["slots"][0]["role_key"] == ""


class TestBundleImportClearsDanglingReferences:
    async def test_import_blanks_slots_the_new_role_set_dropped(self, wired):
        session = _Session()
        await ws_handlers.settings_bundle_import(
            session,
            "1",
            "settings.bundle.import",
            {
                "bundle": {
                    "roles": [
                        {
                            "key": "pm",
                            "label": "Product Manager",
                            "one_line": "",
                            "system_prompt": "kept",
                        }
                    ]
                }
            },
        )

        assert session.last["ok"] is True
        # "pm" survived the import; "qa" and "backend" did not.
        assert _role_keys_in(wired.stages, wired.pipeline_id) == ["pm", "", ""]

    async def test_import_broadcasts_the_cleaned_stages(self, wired):
        session = _Session()
        await ws_handlers.settings_bundle_import(
            session,
            "1",
            "settings.bundle.import",
            {
                "bundle": {
                    "roles": [
                        {
                            "key": "pm",
                            "label": "Product Manager",
                            "one_line": "",
                            "system_prompt": "kept",
                        }
                    ]
                }
            },
        )
        changed = [
            e for e in wired.events
            if e["type"] == "stages.changed"
            and e["payload"]["pipeline_id"] == wired.pipeline_id
        ]
        assert changed

    async def test_a_document_only_bundle_is_cleaned_too(self, wired):
        """A bundle with no roles at all still imports slots that may name keys
        this machine has never had — the cleanup gate used to ask only whether
        roles were applied, so this combination walked straight past it."""
        incoming_doc = {
            "version": 2,
            "active_pipeline_id": "imported",
            "pipelines": [
                {
                    "id": "imported",
                    "name": "Imported",
                    "builtin": False,
                    "stages": [_stage("i-01", _slot("ghost", "Ghost"), _slot("pm", "Keep"))],
                }
            ],
        }
        session = _Session()
        await ws_handlers.settings_bundle_import(
            session,
            "1",
            "settings.bundle.import",
            {"bundle": {"pipelines_document": incoming_doc}},
        )

        assert session.last["ok"] is True
        assert _role_keys_in(wired.stages, "imported") == ["", "pm"]

    async def test_cleanup_runs_after_the_pipelines_document_lands(self, wired):
        """A bundle carrying both parts must be cleaned against the document it
        imported, not the one it replaced — the roles branch runs first, so a
        cleanup wired there would miss the incoming slots entirely."""
        incoming_doc = {
            "version": 2,
            "active_pipeline_id": "imported",
            "pipelines": [
                {
                    "id": "imported",
                    "name": "Imported",
                    "builtin": False,
                    "stages": [_stage("i-01", _slot("ghost", "Ghost"), _slot("pm", "Keep"))],
                }
            ],
        }
        session = _Session()
        await ws_handlers.settings_bundle_import(
            session,
            "1",
            "settings.bundle.import",
            {
                "bundle": {
                    "roles": [
                        {
                            "key": "pm",
                            "label": "Product Manager",
                            "one_line": "",
                            "system_prompt": "kept",
                        }
                    ],
                    "pipelines_document": incoming_doc,
                }
            },
        )

        assert session.last["ok"] is True
        assert _role_keys_in(wired.stages, "imported") == ["", "pm"]


# ── renaming a role must not be a dead end ────────────────────────────────────

class TestRename:
    """Refusing roles.delete closed the only route a rename had.

    The renderer renames by saving under the new key and deleting the old one.
    Once the delete is refused for the slots that name it, that sequence stops
    halfway: both keys in the registry, the slots still on the old one, and
    retrying the delete refused for the same reason. Every seed role except
    "pm" (whose key field is disabled) reaches this, so it is the default path,
    not an edge case.
    """

    async def test_the_old_two_step_rename_really_is_a_dead_end(self, wired):
        """Characterises the trap the handler exists to avoid — not a claim
        that roles.delete is wrong. Its refusal is correct; the rename just
        cannot be built out of it."""
        wired.roles.upsert(key="tester", label="Tester", one_line="", system_prompt="x")
        session = _Session()
        await ws_handlers.roles_delete(session, "1", "roles.delete", {"key": "qa"})
        assert session.last["error"]["code"] == "ROLE_IN_USE"
        # Both keys now exist and the slots still name the old one.
        assert wired.roles.get("qa") is not None
        assert wired.roles.get("tester") is not None
        assert "qa" in _role_keys_in(wired.stages, wired.pipeline_id)

    async def test_rename_moves_the_slots_and_retires_the_old_key(self, wired):
        session = _Session()
        await ws_handlers.roles_rename(
            session,
            "1",
            "roles.rename",
            {
                "old_key": "qa",
                "new_key": "tester",
                "label": "Tester",
                "one_line": "",
                "system_prompt": "still the QA prompt",
            },
        )
        assert session.last["ok"] is True
        assert wired.roles.get("qa") is None
        assert wired.roles.get("tester")["system_prompt"] == "still the QA prompt"
        assert _role_keys_in(wired.stages, wired.pipeline_id) == ["pm", "tester", "backend"]

    async def test_rename_carries_every_pipeline_not_just_one(self, wired):
        """The seed pipelines use "qa" as well, so a rename that only fixed the
        pipeline in front of the user would strand the rest."""
        session = _Session()
        await ws_handlers.roles_rename(
            session,
            "1",
            "roles.rename",
            {"old_key": "qa", "new_key": "tester", "label": "Tester",
             "one_line": "", "system_prompt": "x"},
        )
        doc = wired.stages.export_document()
        leftover = [
            (p["id"], s["id"])
            for p in doc["pipelines"]
            for s in p.get("stages", [])
            for slot in s.get("slots") or []
            if slot.get("role_key") == "qa"
        ]
        assert leftover == []
        assert len(session.last["payload"]["repointed_pipeline_ids"]) > 1

    async def test_rename_recovers_a_half_finished_two_step_attempt(self, wired):
        """The state a user is already stuck in must be reachable back out of."""
        wired.roles.upsert(key="tester", label="Tester", one_line="", system_prompt="x")
        session = _Session()
        await ws_handlers.roles_rename(
            session,
            "1",
            "roles.rename",
            {"old_key": "qa", "new_key": "tester", "label": "Tester",
             "one_line": "", "system_prompt": "x"},
        )
        # "tester" already existing is refused (it would merge two roles), but
        # the slots are still on "qa", so roles.delete now clears the way.
        assert session.last["error"]["code"] == "ROLE_KEY_EXISTS"

    async def test_rename_onto_an_existing_key_is_refused(self, wired):
        session = _Session()
        await ws_handlers.roles_rename(
            session,
            "1",
            "roles.rename",
            {"old_key": "qa", "new_key": "backend", "label": "X",
             "one_line": "", "system_prompt": "x"},
        )
        assert session.last["error"]["code"] == "ROLE_KEY_EXISTS"
        assert session.last["error"]["details"]["role_key"] == "backend"
        # Nothing moved.
        assert wired.roles.get("qa") is not None
        assert _role_keys_in(wired.stages, wired.pipeline_id) == ["pm", "qa", "backend"]

    async def test_renaming_a_role_that_does_not_exist_is_refused(self, wired):
        session = _Session()
        await ws_handlers.roles_rename(
            session,
            "1",
            "roles.rename",
            {"old_key": "ghost", "new_key": "tester", "label": "X",
             "one_line": "", "system_prompt": "x"},
        )
        assert session.last["error"]["code"] == "ROLE_NOT_FOUND"
        assert wired.roles.get("tester") is None

    async def test_same_key_is_an_edit_not_a_rename(self, wired):
        session = _Session()
        await ws_handlers.roles_rename(
            session,
            "1",
            "roles.rename",
            {"old_key": "qa", "new_key": "qa", "label": "QA",
             "one_line": "", "system_prompt": "rewritten"},
        )
        assert session.last["ok"] is True
        assert wired.roles.get("qa")["system_prompt"] == "rewritten"
        assert session.last["payload"]["repointed_pipeline_ids"] == []
        assert _role_keys_in(wired.stages, wired.pipeline_id) == ["pm", "qa", "backend"]

    async def test_rename_of_an_unused_role_touches_no_pipeline(self, wired):
        wired.roles.upsert(key="spare", label="Spare", one_line="", system_prompt="x")
        session = _Session()
        await ws_handlers.roles_rename(
            session,
            "1",
            "roles.rename",
            {"old_key": "spare", "new_key": "spare2", "label": "Spare",
             "one_line": "", "system_prompt": "x"},
        )
        assert session.last["ok"] is True
        assert session.last["payload"]["repointed_pipeline_ids"] == []
        assert wired.roles.get("spare") is None

    async def test_rename_broadcasts_roles_and_the_moved_stages(self, wired):
        session = _Session()
        await ws_handlers.roles_rename(
            session,
            "1",
            "roles.rename",
            {"old_key": "qa", "new_key": "tester", "label": "Tester",
             "one_line": "", "system_prompt": "x"},
        )
        assert any(
            e["type"] == "roles.changed" and e["payload"]["reason"] == "rename"
            for e in wired.events
        )
        moved = [
            e for e in wired.events
            if e["type"] == "stages.changed"
            and e["payload"]["pipeline_id"] == wired.pipeline_id
        ]
        assert moved
        stage = next(s for s in moved[-1]["payload"]["stages"] if s["id"] == "s-01")
        assert [slot["role_key"] for slot in stage["slots"]] == ["pm", "tester"]


# ── the store method the handlers lean on ─────────────────────────────────────

class TestStoreHelpers:
    def test_clearing_reports_only_the_pipelines_it_touched(self, wired):
        doc = wired.stages.export_document()
        every_key_in_use = {
            slot.get("role_key", "")
            for pipeline in doc["pipelines"]
            for stage in pipeline.get("stages", [])
            for slot in stage.get("slots") or []
        }
        assert wired.stages.clear_missing_role_references(every_key_in_use) == []

    def test_clearing_never_blanks_a_key_that_is_still_valid(self, wired):
        wired.stages.clear_missing_role_references({"pm"})
        assert _role_keys_in(wired.stages, wired.pipeline_id) == ["pm", "", ""]

    def test_find_role_usages_ignores_empty_keys(self, wired):
        wired.stages.upsert(_stage("s-04", _slot("", "Roleless")), wired.pipeline_id)
        assert wired.stages.find_role_usages("") == []
