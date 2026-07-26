"""Pane session-id persistence (resume-on-restart support).

PaneRecord is the unified record for both pipeline slots and manual panes.
These tests cover that session_id round-trips through project.json and that
all spawn / detect / unspawn write paths populate panes[] correctly.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.projects import Project, ProjectStore, SlotRecord, PaneRecord


def test_slot_record_session_id_defaults_empty() -> None:
    assert SlotRecord(label="X").session_id == ""


def test_pane_record_session_id_defaults_empty() -> None:
    assert PaneRecord(pane_id="x").session_id == ""
    assert PaneRecord(pane_id="x").session_home_id == ""


def test_slot_session_id_round_trips_through_panes() -> None:
    """Pipeline slot session_id is stored in panes[] and round-trips through dict."""
    proj = Project(
        id="p", name="n", workspace_path="/ws", created_at="t", updated_at="t",
    )
    from agent_team_backend.projects import StageRecord
    proj.stages = [StageRecord(stage_id="01")]
    proj.panes = [PaneRecord(pane_id="x", origin="pipeline",
                             stage_id="01", stage_index=0, slot_label="Build",
                             session_id="sess-123")]
    restored = Project.from_dict(proj.to_dict())
    pane = next((p for p in restored.panes if p.slot_label == "Build"), None)
    assert pane is not None
    assert pane.session_id == "sess-123"


def test_codex_session_home_id_round_trips_through_panes() -> None:
    proj = Project(
        id="p", name="n", workspace_path="/ws", created_at="t", updated_at="t",
    )
    proj.panes = [PaneRecord(
        pane_id="live-pane", origin="pipeline",
        stage_id="01", stage_index=0, slot_label="Build",
        session_id="codex-resume-id", session_home_id="home-old",
    )]
    restored = Project.from_dict(proj.to_dict())
    assert restored.panes[0].session_home_id == "home-old"


def test_old_project_json_without_panes_migrates_slots(tmp_path: Path) -> None:
    """Backward compat: old project.json with stages[].slots[] migrates to panes[]."""
    legacy = {
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
        "stages": [{"stage_id": "01", "slots": [
            {"label": "Build", "agent": "codex", "pane_id": "pane-1",
             "spawn_status": "spawned", "session_id": "old-sess"}
        ]}],
    }
    restored = Project.from_dict(legacy)
    assert len(restored.panes) == 1
    assert restored.panes[0].session_id == "old-sess"
    assert restored.panes[0].origin == "pipeline"
    assert restored.panes[0].slot_label == "Build"


def test_old_project_json_migrates_manual_panes(tmp_path: Path) -> None:
    """Backward compat: old manual_panes[] migrates to panes[]."""
    legacy = {
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
        "stages": [],
        "manual_panes": [
            {"pane_id": "mp-1", "agent": "claude", "role": "",
             "command": "claude", "spawn_status": "spawned", "session_id": "manual-sess"}
        ],
    }
    restored = Project.from_dict(legacy)
    assert len(restored.panes) == 1
    assert restored.panes[0].origin == "manual"
    assert restored.panes[0].session_id == "manual-sess"


@pytest.fixture
def store_with_stage(tmp_path: Path) -> tuple[ProjectStore, str]:
    ws = str(tmp_path)
    store = ProjectStore()
    store.start_pipeline(
        ws,
        task_description="t",
        total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    return store, ws


def test_record_slot_spawn_persists_session_id(store_with_stage: tuple[ProjectStore, str]) -> None:
    """Claude path: id known at spawn → persisted in panes[]."""
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude", session_id="claude-sess")
    project = store.peek(ws)
    assert project is not None
    pane = next((p for p in project.panes if p.slot_label == "Build"), None)
    assert pane is not None
    assert pane.session_id == "claude-sess"
    assert pane.spawn_status == "spawned"
    assert pane.origin == "pipeline"


def test_record_slot_spawn_persists_session_home_id(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(
        ws, stage_index=0, slot_label="Build",
        pane_id="pane-1", agent="codex", session_home_id="home-1",
    )
    pane = next((p for p in store.peek(ws).panes if p.slot_label == "Build"), None)
    assert pane is not None
    assert pane.session_home_id == "home-1"


def test_record_slot_session_fills_in_later(store_with_stage: tuple[ProjectStore, str]) -> None:
    """Codex/Antigravity path: spawn first with no id, detect + persist later."""
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="codex")
    pane = next(p for p in store.peek(ws).panes if p.slot_label == "Build")
    assert pane.session_id == ""

    store.record_slot_session(ws, stage_index=0, slot_label="Build", session_id="codex-sess")
    pane = next(p for p in store.peek(ws).panes if p.slot_label == "Build")
    assert pane.session_id == "codex-sess"


def test_record_slot_session_unknown_slot_is_noop(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_slot_session(ws, stage_index=0, slot_label="Nope", session_id="x")


def test_record_slot_unspawn_marks_removed_but_preserves_session(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="codex", session_id="sess-123")
    store.record_slot_unspawn(ws, stage_index=0, slot_label="Build")

    pane = next(p for p in store.peek(ws).panes if p.slot_label == "Build")
    assert pane.spawn_status == "removed"
    assert pane.kickoff_status == "none"
    assert pane.session_id == "sess-123"  # preserved on unspawn


def test_manual_pane_spawn_round_trips_and_can_be_rekeyed(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage

    store.record_manual_pane_spawn(ws, pane_id="pane-old", agent="claude",
                                   role="", command="claude", session_id="sess-1")
    store.record_manual_pane_spawn(ws, pane_id="pane-new", previous_pane_id="pane-old",
                                   agent="claude", role="", command="claude --resume sess-1",
                                   session_id="sess-1")

    project = store.peek(ws)
    manual = [p for p in project.panes if p.origin == "manual"]
    assert len(manual) == 1
    assert manual[0].pane_id == "pane-new"
    assert manual[0].spawn_status == "spawned"
    assert manual[0].session_id == "sess-1"


def test_manual_pane_spawn_persists_output_log_file(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(
        ws, pane_id="pane-1", agent="claude", output_log_file="/ws/.agent-team/manual/20260719/claude-abcd1234.log",
    )
    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.output_log_file == "/ws/.agent-team/manual/20260719/claude-abcd1234.log"


def test_output_log_file_round_trips_through_panes() -> None:
    proj = Project(id="p", name="n", workspace_path="/ws", created_at="t", updated_at="t")
    proj.panes = [PaneRecord(pane_id="x", origin="manual", output_log_file="/ws/.agent-team/manual/20260719/x.log")]
    restored = Project.from_dict(proj.to_dict())
    assert restored.panes[0].output_log_file == "/ws/.agent-team/manual/20260719/x.log"


def test_old_project_json_without_output_log_file_defaults_empty() -> None:
    """Backward compat: project.json written before output_log_file existed
    must still deserialize without error, defaulting the field to empty."""
    legacy = {
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
        "panes": [{"pane_id": "mp-1", "agent": "claude", "origin": "manual", "spawn_status": "spawned"}],
    }
    restored = Project.from_dict(legacy)
    assert restored.panes[0].output_log_file == ""


def test_manual_pane_spawn_persists_session_home_id(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(
        ws, pane_id="pane-1", agent="codex", session_home_id="home-1",
    )
    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.session_home_id == "home-1"


def test_manual_pane_spawn_persists_profile_id(store_with_stage: tuple[ProjectStore, str]) -> None:
    """The account pin survives to disk so a resume re-spawns on the same
    account regardless of the current active default."""
    store, ws = store_with_stage
    store.record_manual_pane_spawn(
        ws, pane_id="pane-1", agent="claude", profile_id="prof-A",
    )
    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.profile_id == "prof-A"
    # A later record for the same pane keeps the pin when none is passed.
    store.record_manual_pane_spawn(
        ws, pane_id="pane-1", previous_pane_id="pane-1", agent="claude",
    )
    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.profile_id == "prof-A"


def test_record_slot_spawn_persists_profile_id(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(
        ws, stage_index=0, slot_label="Build",
        pane_id="pane-1", agent="claude", profile_id="__default__",
    )
    pane = next(p for p in store.peek(ws).panes if p.slot_label == "Build")
    assert pane.profile_id == "__default__"


def test_pane_record_profile_id_defaults_empty() -> None:
    assert PaneRecord(pane_id="p").profile_id == ""


def test_manual_pane_unspawn_marks_removed(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="pane-1", agent="codex")
    store.record_manual_pane_unspawn(ws, pane_id="pane-1")

    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.spawn_status == "removed"


def test_manual_pane_unspawn_by_session_when_pane_id_drifted(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    # Record persisted under an old id; the live pane now has a different id
    # (id drift across restarts). Removing by the live id + stable session_id
    # must still mark the right record removed so it can't resurrect.
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="old-id", agent="claude", session_id="sess-x")
    store.record_manual_pane_unspawn(ws, pane_id="live-id", session_id="sess-x")

    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.spawn_status == "removed"


def test_manual_pane_unspawn_clears_duplicates_sharing_session(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    # Two spawned records share one session (legacy duplicate accumulation —
    # spawn now dedups by session, so seed the records directly): a single
    # unspawn by session must clear BOTH so neither resurrects.
    store, ws = store_with_stage
    project = store.load_or_create(ws)
    project.panes.append(PaneRecord(pane_id="dup-a", origin="manual",
                                    agent="claude", spawn_status="spawned", session_id="sess-d"))
    project.panes.append(PaneRecord(pane_id="dup-b", origin="manual",
                                    agent="claude", spawn_status="spawned", session_id="sess-d"))
    store.save(project)
    store.record_manual_pane_unspawn(ws, pane_id="dup-b", session_id="sess-d")

    manual = [p for p in store.peek(ws).panes if p.origin == "manual"]
    assert all(p.spawn_status == "removed" for p in manual)


def test_manual_pane_spawn_race_dedups_by_session(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    # Double-click rebuild race: two overlapping rebuilds (A→B, B→C) send
    # spawn records with no arrival-order guarantee. When the later hop
    # (C, previous=B) lands first, neither its pane_id nor previous_pane_id
    # matches the stored record (still A) — the shared session id must
    # collapse all hops onto one record so restore never spawns an extra pane.
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="pane-a", agent="claude", session_id="sess-r")
    store.record_manual_pane_spawn(ws, pane_id="pane-c", previous_pane_id="pane-b",
                                   agent="claude", session_id="sess-r")
    store.record_manual_pane_spawn(ws, pane_id="pane-b", previous_pane_id="pane-a",
                                   agent="claude", session_id="sess-r")

    manual = [p for p in store.peek(ws).panes if p.origin == "manual"]
    assert len(manual) == 1
    assert manual[0].session_id == "sess-r"
    assert manual[0].spawn_status == "spawned"


def test_manual_pane_resume_of_live_session_keeps_both_records(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    # The user may deliberately open a second pane resuming a session that is
    # already live in another pane (manual resume sends no previous_pane_id).
    # The session dedup must NOT hijack the live pane's record — both panes
    # keep their own record so both restore.
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="pane-1", agent="claude", session_id="sess-l")
    store.record_manual_pane_spawn(ws, pane_id="pane-2", agent="claude", session_id="sess-l")

    manual = [p for p in store.peek(ws).panes if p.origin == "manual"]
    assert sorted(p.pane_id for p in manual) == ["pane-1", "pane-2"]
    assert all(p.spawn_status == "spawned" for p in manual)


def test_manual_pane_rebuild_sweeps_legacy_duplicates(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    # Projects persisted before the dedup fix may hold several spawned records
    # sharing one session. A rebuild hop (previous_pane_id set) owns the
    # session: it re-keys its own record and retires the stale extras so they
    # stop restoring as ghost panes.
    store, ws = store_with_stage
    project = store.load_or_create(ws)
    project.panes.append(PaneRecord(pane_id="pane-a", origin="manual",
                                    agent="claude", spawn_status="spawned", session_id="sess-g"))
    project.panes.append(PaneRecord(pane_id="pane-stale", origin="manual",
                                    agent="claude", spawn_status="spawned", session_id="sess-g"))
    store.save(project)

    store.record_manual_pane_spawn(ws, pane_id="pane-b", previous_pane_id="pane-a",
                                   agent="claude", session_id="sess-g")

    manual = [p for p in store.peek(ws).panes if p.origin == "manual"]
    spawned = [p for p in manual if p.spawn_status == "spawned"]
    assert [p.pane_id for p in spawned] == ["pane-b"]
    assert next(p for p in manual if p.pane_id == "pane-stale").spawn_status == "removed"


def test_manual_pane_exact_match_beats_session_only_record(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    # An earlier record matching only by session must not shadow a later
    # record that matches previous_pane_id exactly — the exact match owns the
    # pane's identity (custom_name etc.); the session-only stale one is swept.
    store, ws = store_with_stage
    project = store.load_or_create(ws)
    project.panes.append(PaneRecord(pane_id="dup-early", origin="manual",
                                    agent="claude", spawn_status="spawned", session_id="sess-p"))
    project.panes.append(PaneRecord(pane_id="pane-a", origin="manual", agent="claude",
                                    spawn_status="spawned", session_id="sess-p",
                                    custom_name="keep-me"))
    store.save(project)

    store.record_manual_pane_spawn(ws, pane_id="pane-b", previous_pane_id="pane-a",
                                   agent="claude", session_id="sess-p")

    manual = [p for p in store.peek(ws).panes if p.origin == "manual"]
    spawned = [p for p in manual if p.spawn_status == "spawned"]
    assert [p.pane_id for p in spawned] == ["pane-b"]
    assert spawned[0].custom_name == "keep-me"


def test_manual_pane_unspawn_no_match_is_noop(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="keep", agent="claude", session_id="sess-keep")
    store.record_manual_pane_unspawn(ws, pane_id="ghost", session_id="sess-ghost")

    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.spawn_status == "spawned"  # untouched


def test_manual_pane_session_fills_in_later(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="pane-1", agent="codex")
    store.record_manual_pane_session(ws, pane_id="pane-1", session_id="codex-sess")

    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.session_id == "codex-sess"


def test_manual_pane_session_missing_pane_warns_once(
    store_with_stage: tuple[ProjectStore, str], caplog
) -> None:
    """A frontend that re-sends manual_pane.session on every activity event for a
    permanently-missing pane must not flood the log (and the event loop) — warn
    once per pane, not once per call."""
    store, ws = store_with_stage
    with caplog.at_level("WARNING"):
        for _ in range(50):
            store.record_manual_pane_session(ws, pane_id="ghost", session_id="s")
    warnings = [r for r in caplog.records if "not found" in r.getMessage()]
    assert len(warnings) == 1


def test_manual_pane_session_rewarns_after_recovery(
    store_with_stage: tuple[ProjectStore, str], caplog
) -> None:
    """A successful persist clears the once-warned mark, so if the pane later
    goes missing again the next miss warns afresh (not suppressed forever)."""
    store, ws = store_with_stage
    with caplog.at_level("WARNING"):
        store.record_manual_pane_session(ws, pane_id="pane-1", session_id="s1")  # miss → warn
        store.record_manual_pane_spawn(ws, pane_id="pane-1", agent="codex")       # record appears
        store.record_manual_pane_session(ws, pane_id="pane-1", session_id="s2")  # hit → clears mark
    # Directly drop the record to simulate a later disappearance without relying
    # on unspawn's mark-removed semantics.
    project = store.peek(ws)
    project.panes = [p for p in project.panes if p.pane_id != "pane-1"]
    store.save(project)
    with caplog.at_level("WARNING"):
        store.record_manual_pane_session(ws, pane_id="pane-1", session_id="s3")  # miss → warn again
    warnings = [r for r in caplog.records if "not found" in r.getMessage()]
    assert len(warnings) == 2


def test_manual_pane_session_can_be_cleared(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="pane-1", agent="claude", session_id="bad-sess")
    store.record_manual_pane_session(ws, pane_id="pane-1", session_id="")

    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.session_id == ""


def test_set_pane_run_group_reassigns_pipeline_pane(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="codex", run_group_id="rg-a")
    store.set_pane_run_group(ws, pane_id="pane-1", run_group_id="rg-b")

    pane = next(p for p in store.peek(ws).panes if p.pane_id == "pane-1")
    assert pane.run_group_id == "rg-b"


def test_set_pane_run_group_can_clear_group(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="mp-1", agent="claude", run_group_id="rg-a")
    store.set_pane_run_group(ws, pane_id="mp-1", run_group_id="")

    pane = next(p for p in store.peek(ws).panes if p.pane_id == "mp-1")
    assert pane.run_group_id == ""


def test_set_pane_run_group_unknown_pane_is_noop(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.set_pane_run_group(ws, pane_id="nope", run_group_id="rg-x")  # no raise


def test_ensure_dir_writes_self_ignoring_gitignore(tmp_path: Path) -> None:
    store = ProjectStore()
    d = store._ensure_dir(str(tmp_path))
    gi = d / ".gitignore"
    assert gi.exists()
    assert gi.read_text(encoding="utf-8").strip() == "*"


def test_ensure_dir_keeps_existing_gitignore(tmp_path: Path) -> None:
    store = ProjectStore()
    d = store.project_dir(str(tmp_path))
    d.mkdir(parents=True)
    (d / ".gitignore").write_text("# custom\n", encoding="utf-8")
    store._ensure_dir(str(tmp_path))
    assert (d / ".gitignore").read_text(encoding="utf-8") == "# custom\n"


def test_pane_record_custom_name_defaults_empty() -> None:
    assert PaneRecord(pane_id="x").custom_name == ""


def test_custom_name_round_trips_through_panes() -> None:
    proj = Project(id="p", name="n", workspace_path="/ws", created_at="t", updated_at="t")
    proj.panes = [PaneRecord(pane_id="x", origin="manual", custom_name="Frontend Lead")]
    restored = Project.from_dict(proj.to_dict())
    assert restored.panes[0].custom_name == "Frontend Lead"


def test_rename_pane_persists_custom_name(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude")
    store.rename_pane(ws, pane_id="pane-1", custom_name="Reviewer")
    pane = next((p for p in store.peek(ws).panes if p.pane_id == "pane-1"), None)
    assert pane is not None
    assert pane.custom_name == "Reviewer"


def test_rename_pane_empty_resets(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude")
    store.rename_pane(ws, pane_id="pane-1", custom_name="Reviewer")
    store.rename_pane(ws, pane_id="pane-1", custom_name="")
    pane = next(p for p in store.peek(ws).panes if p.pane_id == "pane-1")
    assert pane.custom_name == ""


def test_rename_pane_survives_respawn_with_new_id(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """Restart re-spawns a pipeline slot with a fresh pane_id; custom_name is keyed
    on the (stage_index, slot_label) record and must carry forward."""
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="old-id", agent="claude")
    store.rename_pane(ws, pane_id="old-id", custom_name="Architect")
    # Restore path: same slot re-spawns under a new runtime pane id.
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="new-id", agent="claude")
    pane = next(p for p in store.peek(ws).panes if p.slot_label == "Build")
    assert pane.pane_id == "new-id"
    assert pane.custom_name == "Architect"


def test_manual_rename_survives_rebuild_with_new_id(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """Rebuild relinks a manual pane through previous_pane_id without losing
    the custom title stored on the existing record."""
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="old-id", agent="codex")
    store.rename_pane(ws, pane_id="old-id", custom_name="Research Lead")

    store.record_manual_pane_spawn(
        ws,
        pane_id="new-id",
        previous_pane_id="old-id",
        agent="codex",
        session_id="session-1",
    )

    panes = [p for p in store.peek(ws).panes if p.origin == "manual"]
    assert len(panes) == 1
    assert panes[0].pane_id == "new-id"
    assert panes[0].custom_name == "Research Lead"


def test_rename_pane_unknown_workspace_returns_none(tmp_path: Path) -> None:
    store = ProjectStore()
    assert store.rename_pane(str(tmp_path), pane_id="x", custom_name="Y") is None


def test_rename_pane_before_record_exists_upserts(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """A manual-pane rename can arrive before manual_pane.spawn persists the
    PaneRecord (persist races the spawn). The name must land on a pending stub
    and survive the later spawn without producing a duplicate."""
    store, ws = store_with_stage
    # Rename first — no PaneRecord for this pane_id exists yet.
    store.rename_pane(ws, pane_id="race-pane", custom_name="風格")
    stub = next((p for p in store.peek(ws).panes if p.pane_id == "race-pane"), None)
    assert stub is not None
    assert stub.custom_name == "風格"
    # Pending stub is skipped by restore until the spawn upgrades it.
    assert stub.spawn_status == "pending"
    # The spawn arrives — it fills fields without clobbering custom_name.
    store.record_manual_pane_spawn(ws, pane_id="race-pane", agent="claude")
    panes = [p for p in store.peek(ws).panes if p.pane_id == "race-pane"]
    assert len(panes) == 1  # upserted, not duplicated
    assert panes[0].spawn_status == "spawned"
    assert panes[0].agent == "claude"
    assert panes[0].custom_name == "風格"


def test_rename_stub_merges_when_respawn_rekeys_manual_pane(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """A rename targeting the NEW pane_id can land while the restart re-key
    (previous_pane_id) is still in flight. The re-key must adopt the stub's
    name instead of leaving a duplicate pane_id that shadows it."""
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="old-id", agent="codex")
    store.rename_pane(ws, pane_id="old-id", custom_name="Old Name")
    # User renames the restored pane before its spawn message re-keys the record.
    store.rename_pane(ws, pane_id="new-id", custom_name="New Name")
    store.record_manual_pane_spawn(
        ws, pane_id="new-id", previous_pane_id="old-id", agent="codex"
    )
    panes = [p for p in store.peek(ws).panes if p.pane_id == "new-id"]
    assert len(panes) == 1  # stub folded, no shadowing duplicate
    assert panes[0].spawn_status == "spawned"
    assert panes[0].custom_name == "New Name"


def test_rename_stub_reset_wins_over_rekeyed_name(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """A reset (empty rename) racing the re-key is the user's latest intent and
    must clear the name carried over from the previous record."""
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="old-id", agent="codex")
    store.rename_pane(ws, pane_id="old-id", custom_name="Old Name")
    store.rename_pane(ws, pane_id="new-id", custom_name="")
    store.record_manual_pane_spawn(
        ws, pane_id="new-id", previous_pane_id="old-id", agent="codex"
    )
    panes = [p for p in store.peek(ws).panes if p.pane_id == "new-id"]
    assert len(panes) == 1
    assert panes[0].custom_name == ""


def test_rename_stub_merges_when_slot_respawn_rekeys(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """Same rename-vs-spawn race for pipeline slots: the slot record is matched
    by (stage_index, slot_label), so a stub keyed to the new pane_id would
    otherwise survive as a duplicate."""
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="old-id", agent="claude")
    store.rename_pane(ws, pane_id="new-id", custom_name="Architect")
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="new-id", agent="claude")
    panes = [p for p in store.peek(ws).panes if p.pane_id == "new-id"]
    assert len(panes) == 1
    assert panes[0].origin == "pipeline"
    assert panes[0].custom_name == "Architect"


def test_rename_pane_patches_history_mirror(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """rename_pane keeps ui_spawn_history's customName in sync so the Agent
    History list can't show a stale/missing title after a restart (detached
    windows never persist the mirror; the renderer snapshot is debounced)."""
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="codex")
    store.set_ui_state(ws, spawn_history=[
        {"paneId": "p1", "agentLabel": "Codex", "customName": "Before"},
        {"paneId": "p2", "agentLabel": "Claude"},
    ])
    store.rename_pane(ws, pane_id="p1", custom_name="After")
    history = store.peek(ws).ui_spawn_history
    assert history[0]["customName"] == "After"
    assert "customName" not in history[1]  # other entries untouched
    # Empty rename resets the mirror entry too.
    store.rename_pane(ws, pane_id="p1", custom_name="")
    history = store.peek(ws).ui_spawn_history
    assert "customName" not in history[0]


def test_pane_record_auto_name_defaults_empty() -> None:
    assert PaneRecord(pane_id="x").auto_name == ""


def test_old_pane_dict_without_auto_name_loads() -> None:
    """Old project.json panes lack auto_name — no migration, default empty."""
    proj = Project.from_dict({
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
        "panes": [{"pane_id": "x", "origin": "manual", "custom_name": "Old"}],
    })
    assert proj.panes[0].auto_name == ""
    assert proj.panes[0].custom_name == "Old"


def test_set_pane_auto_name_persists(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude")
    project, changed = store.set_pane_auto_name(ws, pane_id="pane-1", auto_name="Fix login bug")
    assert project is not None
    assert changed is True
    # Re-read project.json through a fresh store — the name survived the disk trip.
    pane = next(p for p in ProjectStore().peek(ws).panes if p.pane_id == "pane-1")
    assert pane.auto_name == "Fix login bug"


def test_set_pane_auto_name_set_once(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude")
    store.set_pane_auto_name(ws, pane_id="pane-1", auto_name="First")
    project, changed = store.set_pane_auto_name(ws, pane_id="pane-1", auto_name="Second")
    assert project is not None
    assert changed is False
    pane = next(p for p in store.peek(ws).panes if p.pane_id == "pane-1")
    assert pane.auto_name == "First"


def test_set_pane_auto_name_ignored_when_custom_name_exists(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude")
    store.rename_pane(ws, pane_id="pane-1", custom_name="User Name")
    project, changed = store.set_pane_auto_name(ws, pane_id="pane-1", auto_name="Auto")
    assert project is not None
    assert changed is False
    pane = next(p for p in store.peek(ws).panes if p.pane_id == "pane-1")
    assert pane.custom_name == "User Name"
    assert pane.auto_name == ""


def test_rename_pane_still_overrides_after_auto_name(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """auto_name never blocks a manual rename; both fields coexist."""
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude")
    store.set_pane_auto_name(ws, pane_id="pane-1", auto_name="Auto")
    store.rename_pane(ws, pane_id="pane-1", custom_name="Manual")
    pane = next(p for p in store.peek(ws).panes if p.pane_id == "pane-1")
    assert pane.custom_name == "Manual"
    assert pane.auto_name == "Auto"


def test_set_pane_auto_name_empty_is_noop(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude")
    project, changed = store.set_pane_auto_name(ws, pane_id="pane-1", auto_name="")
    assert project is not None
    assert changed is False
    pane = next(p for p in store.peek(ws).panes if p.pane_id == "pane-1")
    assert pane.auto_name == ""


def test_set_pane_auto_name_unknown_workspace_returns_none(tmp_path: Path) -> None:
    project, changed = ProjectStore().set_pane_auto_name(
        str(tmp_path), pane_id="x", auto_name="Y"
    )
    assert project is None
    assert changed is False


def test_set_pane_auto_name_before_record_exists_upserts(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """An auto-name can race manual_pane.spawn — it lands on a pending stub
    and survives the later spawn without producing a duplicate."""
    store, ws = store_with_stage
    project, changed = store.set_pane_auto_name(ws, pane_id="race-pane", auto_name="Auto Title")
    assert changed is True
    stub = next(p for p in store.peek(ws).panes if p.pane_id == "race-pane")
    assert stub.auto_name == "Auto Title"
    assert stub.spawn_status == "pending"
    store.record_manual_pane_spawn(ws, pane_id="race-pane", agent="claude")
    panes = [p for p in store.peek(ws).panes if p.pane_id == "race-pane"]
    assert len(panes) == 1  # upserted, not duplicated
    assert panes[0].spawn_status == "spawned"
    assert panes[0].auto_name == "Auto Title"


def test_set_pane_auto_name_leaves_history_mirror_untouched(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    """Unlike rename_pane, auto_name is not mirrored into ui_spawn_history."""
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="codex")
    store.set_ui_state(ws, spawn_history=[{"paneId": "p1", "agentLabel": "Codex"}])
    store.set_pane_auto_name(ws, pane_id="p1", auto_name="Auto")
    history = store.peek(ws).ui_spawn_history
    assert history == [{"paneId": "p1", "agentLabel": "Codex"}]
