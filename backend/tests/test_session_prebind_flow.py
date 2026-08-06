from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.projects import ProjectStore


class FakeReader(LogReader):
    def __init__(self, vendor: str, root: Path) -> None:
        self.vendor = vendor
        self.root = root
        from agent_team_backend.cli_vendors.registry import vendor as _v
        _spec = _v(getattr(self, "vendor", "") or "")
        if _spec is not None and _spec.make_log_reader is not None:
            _real = _spec.make_log_reader()
            self.binds_by_marker_file = _real.binds_by_marker_file
            self.binds_shared_db_by_marker = _real.binds_shared_db_by_marker
            self.binds_new_session_single_candidate = _real.binds_new_session_single_candidate
            self.emits_session_sink = _real.emits_session_sink
            self.requires_real_resume_id = _real.requires_real_resume_id
            self.workspace_match = _real.workspace_match
            self.pane_cwd_match = _real.pane_cwd_match
            self.path_identity = _real.path_identity
            self.pane_home_id = _real.pane_home_id
            self.resume_id_from_session_text = _real.resume_id_from_session_text

    def project_dirs(self) -> list[Path]:
        return [self.root] if self.root.is_dir() else []

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return []


def _usage(vendor: str, session_id: str, path: Path, cwd: str) -> TokenUsage:
    return TokenUsage(
        vendor=vendor,
        input_tokens=1,
        output_tokens=1,
        cwd=cwd,
        session_id=session_id,
        file_path=str(path),
        dedup_key=f"{vendor}:{session_id}:{path}",
    )


def test_pipeline_prebind_detects_and_persists_three_codex_panes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    ws = str(workspace)

    store = ProjectStore()
    store.start_pipeline(
        ws,
        task_description="session prebind smoke",
        total_stages=1,
        stage_blueprint=[{
            "stage_id": "01",
            "title": "Build",
            "slots": [
                {"label": "Codex A", "agent": "codex"},
                {"label": "Codex B", "agent": "codex"},
                {"label": "Codex C", "agent": "codex"},
            ],
        }],
    )
    store.record_slot_spawn(ws, stage_index=0, slot_label="Codex A", pane_id="pane-a", agent="codex", session_home_id="home-a")
    store.record_slot_spawn(ws, stage_index=0, slot_label="Codex B", pane_id="pane-b", agent="codex", session_home_id="home-b")
    store.record_slot_spawn(ws, stage_index=0, slot_label="Codex C", pane_id="pane-c", agent="codex", session_home_id="home-c")

    attr = Attribution(
        [
            FakeReader("codex", tmp_path / ".codex"),
        ],
        workspaces_path=tmp_path / "ws.json",
    )
    attr.register_pane("pane-a", vendor="codex", cwd=ws, workspace_path=ws, session_home_id="home-a")
    attr.register_pane("pane-b", vendor="codex", cwd=ws, workspace_path=ws, session_home_id="home-b")
    attr.register_pane("pane-c", vendor="codex", cwd=ws, workspace_path=ws, session_home_id="home-c")

    codex_a = tmp_path / ".codex-panes" / "home-a" / "sessions" / "rollout-a.jsonl"
    codex_b = tmp_path / ".codex-panes" / "home-b" / "sessions" / "rollout-b.jsonl"
    codex_c = tmp_path / ".codex-panes" / "home-c" / "sessions" / "rollout-c.jsonl"
    codex_a.parent.mkdir(parents=True)
    codex_b.parent.mkdir(parents=True)
    codex_c.parent.mkdir(parents=True)
    codex_a.write_text(json.dumps({"type": "session_meta", "payload": {"id": "resume-a", "cwd": ws}}) + "\n", encoding="utf-8")
    codex_b.write_text(json.dumps({"type": "session_meta", "payload": {"id": "resume-b", "cwd": ws}}) + "\n", encoding="utf-8")
    codex_c.write_text(json.dumps({"type": "session_meta", "payload": {"id": "resume-c", "cwd": ws}}) + "\n", encoding="utf-8")

    for label, usage in [
        ("Codex B", _usage("codex", codex_b.stem, codex_b, ws)),
        ("Codex C", _usage("codex", codex_c.stem, codex_c, ws)),
        ("Codex A", _usage("codex", codex_a.stem, codex_a, ws)),
    ]:
        binding = attr.maybe_announce_session(usage)
        assert binding is not None
        store.record_slot_session(ws, stage_index=0, slot_label=label, session_id=binding.resume_id)

    project = store.peek(ws)
    assert project is not None
    sessions = {pane.slot_label: pane.session_id for pane in project.panes}
    assert sessions == {
        "Codex A": "resume-a",
        "Codex B": "resume-b",
        "Codex C": "resume-c",
    }
    assert attr.attribute(_usage("codex", codex_a.stem, codex_a, ws)).pane_id == "pane-a"
    assert attr.attribute(_usage("codex", codex_b.stem, codex_b, ws)).pane_id == "pane-b"
