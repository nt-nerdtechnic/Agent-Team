"""Attribution layer: workspace-folder association + pane lookup.

After Design B switch:
  - Workspace must be registered first; events outside any registered
    workspace return workspace_path=None (sink drops them).
  - Pane lookup is best-effort for current-run "By Pane" attribution.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.log_readers.claude import encode_claude_cwd


class FakeReader(LogReader):
    def __init__(self, vendor: str, root: Path) -> None:
        self.vendor = vendor
        self.root = root

    def project_dirs(self) -> list[Path]:
        return [self.root] if self.root.is_dir() else []

    def session_files(self) -> list[Path]:
        if not self.root.is_dir():
            return []
        return sorted(self.root.rglob("*.jsonl"))

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return []


def _make_usage(vendor: str, *, session_id: str, file_path: str,
                cwd: str = "", input_t: int = 10, output_t: int = 5) -> TokenUsage:
    return TokenUsage(
        vendor=vendor, input_tokens=input_t, output_tokens=output_t,
        cwd=cwd, session_id=session_id, file_path=file_path,
        dedup_key=f"{session_id}::{file_path}",
    )


@pytest.fixture
def claude_attr(tmp_path: Path) -> tuple[Attribution, Path]:
    root = tmp_path / "claude_projects"
    root.mkdir()
    reader = FakeReader("claude", root)
    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    return attr, root


# ─────────────────────────── workspace gating ───────────────────────────────

def test_unregistered_workspace_returns_none(claude_attr: tuple[Attribution, Path]) -> None:
    attr, root = claude_attr
    proj_dir = root / "-Users-me-proj"; proj_dir.mkdir()
    f = proj_dir / "s.jsonl"; f.write_text("")
    usage = _make_usage("claude", session_id="s", file_path=str(f))
    result = attr.attribute(usage)
    # No workspace registered yet → external.
    assert result.workspace_path is None
    assert result.pane_id is None


def test_register_workspace_then_attribute_succeeds(claude_attr: tuple[Attribution, Path]) -> None:
    attr, root = claude_attr
    cwd = "/Users/me/proj"
    attr.register_workspace(cwd)
    proj_dir = root / "-Users-me-proj"; proj_dir.mkdir()
    f = proj_dir / "s.jsonl"; f.write_text("")
    usage = _make_usage("claude", session_id="s", file_path=str(f))
    result = attr.attribute(usage)
    assert result.workspace_path == cwd


def test_register_workspace_survives_a_database_write_failure(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    """A failed persistence write degrades like the old JSON file store:
    the registration keeps working in memory, the failure is only logged."""
    import sqlite3

    root = tmp_path / "claude_projects"
    root.mkdir()
    attr = Attribution([FakeReader("claude", root)], workspaces_path=tmp_path / "ws.json")

    def boom(*args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(attr._db, "kv_set", boom)
    ws = str(tmp_path / "wsA")
    with caplog.at_level("WARNING"):
        attr.register_workspace(ws)
    assert ws in attr.known_workspaces()
    assert any(
        "workspace-associations save failed" in r.message for r in caplog.records
    )


def test_workspace_persists_across_restarts(tmp_path: Path) -> None:
    """Workspace-associations round-trip through the database."""
    root = tmp_path / "claude_projects"; root.mkdir()
    ws_path = "/Users/me/proj"

    # Run 1: register
    attr1 = Attribution([FakeReader("claude", root)], workspaces_path=tmp_path / "ws.json")
    attr1.register_workspace(ws_path)
    assert ws_path in attr1.known_workspaces()

    # Run 2: load from disk
    attr2 = Attribution([FakeReader("claude", root)], workspaces_path=tmp_path / "ws.json")
    assert ws_path in attr2.known_workspaces()
    # Attribute also works without re-registering
    proj_dir = root / "-Users-me-proj"; proj_dir.mkdir()
    f = proj_dir / "s.jsonl"; f.write_text("")
    result = attr2.attribute(_make_usage("claude", session_id="s", file_path=str(f)))
    assert result.workspace_path == ws_path


def test_legacy_workspace_json_imported_once_and_retired(tmp_path: Path) -> None:
    root = tmp_path / "claude_projects"; root.mkdir()
    ws_json = tmp_path / "ws.json"
    ws_path = "/Users/me/proj"
    ws_json.write_text(
        json.dumps({ws_path: {"claude_dir": str(root / "-Users-me-proj"), "registered_at": 1.0}}),
        encoding="utf-8",
    )
    attr = Attribution([FakeReader("claude", root)], workspaces_path=ws_json)
    assert ws_path in attr.known_workspaces()
    assert not ws_json.exists()
    assert ws_json.with_name(ws_json.name + ".migrated-v1").exists()
    # Second instance loads from the database, not the retired file.
    attr2 = Attribution([FakeReader("claude", root)], workspaces_path=ws_json)
    assert ws_path in attr2.known_workspaces()


def test_workspace_only_matches_files_under_its_folder(claude_attr: tuple[Attribution, Path]) -> None:
    attr, root = claude_attr
    attr.register_workspace("/Users/me/proj-A")
    # File belongs to a DIFFERENT workspace
    other = root / "-Users-me-proj-B"; other.mkdir()
    f = other / "s.jsonl"; f.write_text("")
    result = attr.attribute(_make_usage("claude", session_id="s", file_path=str(f)))
    assert result.workspace_path is None


def test_register_workspace_is_idempotent(claude_attr: tuple[Attribution, Path]) -> None:
    attr, _ = claude_attr
    attr.register_workspace("/x")
    attr.register_workspace("/x")
    attr.register_workspace("/x")
    assert attr.known_workspaces() == ["/x"]


# ─────────────────────────── codex via session_meta cwd ──────────────────────

def test_codex_workspace_via_cwd(tmp_path: Path) -> None:
    codex_root = tmp_path / "codex"; codex_root.mkdir()
    attr = Attribution(
        [FakeReader("codex", codex_root)], workspaces_path=tmp_path / "ws.json",
    )
    cwd = "/Users/me/code"
    attr.register_workspace(cwd)
    usage = _make_usage("codex", session_id="s", file_path=str(codex_root / "any.jsonl"), cwd=cwd)
    result = attr.attribute(usage)
    assert result.workspace_path == cwd


def test_codex_different_cwd_not_attributed(tmp_path: Path) -> None:
    codex_root = tmp_path / "codex"; codex_root.mkdir()
    attr = Attribution(
        [FakeReader("codex", codex_root)], workspaces_path=tmp_path / "ws.json",
    )
    attr.register_workspace("/A")
    usage = _make_usage("codex", session_id="s",
                        file_path=str(codex_root / "x.jsonl"), cwd="/B")
    assert attr.attribute(usage).workspace_path is None


# ─────────────────────────── pane lookup within current run ──────────────────

def test_pane_attribution_within_run(claude_attr: tuple[Attribution, Path]) -> None:
    attr, root = claude_attr
    cwd = "/x"
    proj_dir = root / "-x"; proj_dir.mkdir()
    # register_pane also implicitly registers the workspace
    attr.register_pane("pane-1", vendor="claude", cwd=cwd,
                       workspace_path=cwd, stage_id="01")
    f = proj_dir / "s.jsonl"; f.write_text("")
    result = attr.attribute(_make_usage("claude", session_id="s", file_path=str(f)))
    assert result.workspace_path == cwd
    assert result.pane_id == "pane-1"
    assert result.stage_id == "01"


def test_register_pane_scopes_baseline_to_workspace_folder(tmp_path: Path) -> None:
    """register_pane must enumerate only the pane's workspace folder, not the
    whole session tree. On a large ~/.claude the whole-tree scan stat'd ~1500
    files on every spawn; the baseline only needs files that could belong to
    this pane's cwd, so a reader that can scope by workspace must be used."""
    root = tmp_path / "claude_projects"
    (root / "ws_a").mkdir(parents=True)
    (root / "ws_b").mkdir(parents=True)
    (root / "ws_a" / "a.jsonl").write_text("{}")
    (root / "ws_b" / "b.jsonl").write_text("{}")
    calls = {"full": 0, "scoped": 0}

    class ScopingReader(FakeReader):
        def session_files(self) -> list[Path]:
            calls["full"] += 1
            return super().session_files()

        def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
            calls["scoped"] += 1
            return [self.root / "ws_a" / "a.jsonl"] if workspace_path == "/ws/a" else []

    attr = Attribution([ScopingReader("claude", root)], workspaces_path=tmp_path / "ws.json")
    attr.register_pane("p", vendor="claude", cwd="/ws/a", workspace_path="/ws/a")

    reg = attr._panes["p"]
    assert (root / "ws_a" / "a.jsonl") in reg.baseline_files   # own folder scanned
    assert (root / "ws_b" / "b.jsonl") not in reg.baseline_files  # other workspace scoped out
    assert calls["scoped"] == 1
    assert calls["full"] == 0  # whole-tree enumeration avoided


def test_register_pane_falls_back_to_full_tree_when_unscopable(claude_attr: tuple[Attribution, Path]) -> None:
    """A reader that can't scope by workspace (session_files_for_workspace → None,
    e.g. Grok's shared DB) must still register — fall back to the full list."""
    attr, root = claude_attr  # FakeReader does not override the scoped method
    proj = root / "-x"; proj.mkdir()
    f = proj / "s.jsonl"; f.write_text("")
    attr.register_pane("p", vendor="claude", cwd="/x", workspace_path="/x")
    assert f in attr._panes["p"].baseline_files


def test_two_unclaimed_panes_same_workspace_claim_nothing(claude_attr: tuple[Attribution, Path]) -> None:
    """Several unclaimed same-cwd panes = ambiguous provenance. Pre-fix the
    oldest registration claimed the session (a guess that could route one
    pane's session to a sibling, which the frontend then persisted — silently
    replacing that pane's session). Now: do nothing rather than guess."""
    attr, root = claude_attr
    cwd = "/x"
    proj = root / "-x"; proj.mkdir()
    attr.register_pane("p1", vendor="claude", cwd=cwd, workspace_path=cwd)
    time.sleep(0.01)
    attr.register_pane("p2", vendor="claude", cwd=cwd, workspace_path=cwd)
    f1 = proj / "s1.jsonl"; f1.write_text("")
    f2 = proj / "s2.jsonl"; f2.write_text("")
    r1 = attr.attribute(_make_usage("claude", session_id="s1", file_path=str(f1)))
    r2 = attr.attribute(_make_usage("claude", session_id="s2", file_path=str(f2)))
    # Workspace attribution still works; pane attribution is refused for both,
    # and the refusal must not consume either pane (no side-effect claims).
    assert r1.workspace_path == r2.workspace_path == cwd
    assert r1.pane_id is None
    assert r2.pane_id is None
    assert attr.pane_for_session("s1") == (None, None, None)
    assert attr.pane_for_session("s2") == (None, None, None)


def test_rolled_session_id_never_claims_a_pinned_sibling(claude_attr: tuple[Attribution, Path]) -> None:
    """/clear rolls a NEW session id in the same cwd. Every pane that pinned an
    explicit --session-id is excluded from the fresh-claim heuristic, so the
    rolled id must claim NO pane (deterministic provenance absent → do
    nothing), never a sibling."""
    attr, root = claude_attr
    cwd = "/x"
    proj = root / "-x"; proj.mkdir()
    attr.register_pane("p1", vendor="claude", cwd=cwd, workspace_path=cwd,
                       explicit_session_id="sess-a")
    attr.register_pane("p2", vendor="claude", cwd=cwd, workspace_path=cwd,
                       explicit_session_id="sess-b")
    rolled = proj / "sess-z.jsonl"; rolled.write_text("")
    r = attr.attribute(_make_usage("claude", session_id="sess-z", file_path=str(rolled)))
    assert r.workspace_path == cwd
    assert r.pane_id is None
    # The siblings' own sessions still route deterministically afterwards.
    fa = proj / "sess-a.jsonl"; fa.write_text("")
    assert attr.attribute(_make_usage("claude", session_id="sess-a", file_path=str(fa))).pane_id == "p1"


def test_event_without_matching_pane_still_attributed_to_workspace(claude_attr: tuple[Attribution, Path]) -> None:
    """User opens Claude Code directly in the workspace — no Agent-Team pane,
    but the workspace is registered → event still counts toward workspace."""
    attr, root = claude_attr
    cwd = "/x"
    attr.register_workspace(cwd)
    proj = root / "-x"; proj.mkdir()
    f = proj / "external.jsonl"; f.write_text("")
    r = attr.attribute(_make_usage("claude", session_id="s", file_path=str(f)))
    assert r.workspace_path == cwd
    assert r.pane_id is None    # no live pane to claim — counts globally but no pane


def test_unregister_pane_keeps_workspace(claude_attr: tuple[Attribution, Path]) -> None:
    attr, root = claude_attr
    cwd = "/x"
    proj = root / "-x"; proj.mkdir()
    attr.register_pane("p", vendor="claude", cwd=cwd, workspace_path=cwd)
    f = proj / "s.jsonl"; f.write_text("")
    attr.attribute(_make_usage("claude", session_id="s", file_path=str(f)))
    attr.unregister_pane("p")
    # New event for same session after pane removed: still workspace-attributed
    r = attr.attribute(_make_usage("claude", session_id="s", file_path=str(f)))
    assert r.workspace_path == cwd
    assert r.pane_id is None


def test_cross_vendor_isolation(tmp_path: Path) -> None:
    claude_root = tmp_path / "claude"; claude_root.mkdir()
    codex_root = tmp_path / "codex"; codex_root.mkdir()
    attr = Attribution(
        [FakeReader("claude", claude_root), FakeReader("codex", codex_root)],
        workspaces_path=tmp_path / "ws.json",
    )
    cwd = "/x"
    attr.register_workspace(cwd)
    # Claude session under the registered workspace
    proj = claude_root / "-x"; proj.mkdir()
    f = proj / "s.jsonl"; f.write_text("")
    r = attr.attribute(_make_usage("claude", session_id="s", file_path=str(f)))
    assert r.workspace_path == cwd
    # Codex session with mismatched cwd
    r2 = attr.attribute(_make_usage("codex", session_id="s2",
                                    file_path=str(codex_root / "x.jsonl"), cwd="/elsewhere"))
    assert r2.workspace_path is None


def test_register_pane_with_unknown_vendor_is_safe(claude_attr: tuple[Attribution, Path]) -> None:
    attr, _ = claude_attr
    # No reader for "mystery" — should not raise.
    attr.register_pane("p", vendor="mystery", cwd="/x", workspace_path="/x")
    # Workspace gets registered as a side-effect; but the usage's vendor has
    # no folder mapping, so unless cwd matches workspace via codex rules
    # we return None for unknown vendor.
    r = attr.attribute(_make_usage("mystery", session_id="s", file_path="/whatever"))
    assert r.workspace_path is None


# ─────────────────── explicit_session_id (pane mis-attribution fix) ──────────

def test_explicit_session_id_routes_to_correct_pane(claude_attr: tuple[Attribution, Path]) -> None:
    """Two panes share one workspace; each has a pinned --session-id.
    Events must be routed to the correct pane without mis-attribution
    (regression: pre-fix, first-come claim could assign both to pane-1)."""
    attr, root = claude_attr
    cwd = "/ws"
    proj = root / "-ws"; proj.mkdir()
    f1 = proj / "sess-a.jsonl"; f1.write_text("")
    f2 = proj / "sess-b.jsonl"; f2.write_text("")

    attr.register_pane("pane-1", vendor="claude", cwd=cwd, workspace_path=cwd,
                       explicit_session_id="sess-a")
    attr.register_pane("pane-2", vendor="claude", cwd=cwd, workspace_path=cwd,
                       explicit_session_id="sess-b")

    r1 = attr.attribute(_make_usage("claude", session_id="sess-a", file_path=str(f1)))
    r2 = attr.attribute(_make_usage("claude", session_id="sess-b", file_path=str(f2)))

    assert r1.pane_id == "pane-1", f"sess-a should map to pane-1, got {r1.pane_id}"
    assert r2.pane_id == "pane-2", f"sess-b should map to pane-2, got {r2.pane_id}"




def test_pane_for_session_returns_correct_pane_after_explicit_register(
    claude_attr: tuple[Attribution, Path],
) -> None:
    """pane_for_session() (used by stop-hook path) must resolve the exact pane
    after explicit_session_id registration — this is the stop-hook pane_id
    look-up that was always returning '' before the fix."""
    attr, root = claude_attr
    cwd = "/ws2"
    attr.register_pane("pane-x", vendor="claude", cwd=cwd, workspace_path=cwd,
                       explicit_session_id="my-session")

    pane_id, ws, _ = attr.pane_for_session("my-session")
    assert pane_id == "pane-x"
    assert ws == cwd


def test_pane_for_session_race_returns_none(claude_attr: tuple[Attribution, Path]) -> None:
    """Stop hook arriving before JSONL claims the session → (None, None, None).
    The caller should fall back gracefully, not crash."""
    attr, _ = claude_attr
    pane_id, ws, stage = attr.pane_for_session("not-yet-known")
    assert pane_id is None
    assert ws is None
    assert stage is None


def test_explicit_session_id_takes_priority_over_file_claim(
    claude_attr: tuple[Attribution, Path],
) -> None:
    """If a session is pinned to pane-A via explicit_session_id, a later
    file-path claim attempt from pane-B must NOT override it."""
    attr, root = claude_attr
    cwd = "/shared"
    proj = root / "-shared"; proj.mkdir()
    f = proj / "shared-sess.jsonl"; f.write_text("")

    attr.register_pane("pane-A", vendor="claude", cwd=cwd, workspace_path=cwd,
                       explicit_session_id="shared-sess")
    # pane-B registered AFTER — without explicit id, so it would normally claim
    # the next unclaimed session via the file-path heuristic.
    attr.register_pane("pane-B", vendor="claude", cwd=cwd, workspace_path=cwd)

    r = attr.attribute(_make_usage("claude", session_id="shared-sess", file_path=str(f)))
    assert r.pane_id == "pane-A", (
        f"pinned session must stay on pane-A even after pane-B registered; got {r.pane_id}"
    )


# ─────────────────── session_marker (Codex/Antigravity resume capture) ───────

@pytest.fixture
def codex_attr(tmp_path: Path) -> tuple[Attribution, Path]:
    root = tmp_path / "codex"; root.mkdir()
    attr = Attribution([FakeReader("codex", root)], workspaces_path=tmp_path / "ws.json")
    return attr, root


def _codex_file(root: Path, name: str, *, marker: str, meta_id: str) -> Path:
    """A minimal Codex rollout: session_meta (carries the real resume id) + a
    user message containing the kickoff marker."""
    f = root / name
    f.write_text(
        json.dumps({"type": "session_meta", "payload": {"id": meta_id, "cwd": "/ws"}}) + "\n" +
        json.dumps({"type": "response_item", "payload": {
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": f"hi <!-- agent-team-session: {marker} -->"}],
        }}) + "\n"
    )
    return f


def test_marker_binds_two_codex_panes_and_returns_resume_id(codex_attr: tuple[Attribution, Path]) -> None:
    """Two Codex panes in one workspace spawn near-simultaneously; the marker in
    each session file resolves the right pane (the case the racy heuristic fails),
    and the returned resume id is session_meta.id — NOT the filename stem."""
    attr, root = codex_attr
    cwd = "/ws"
    attr.register_pane("p1", vendor="codex", cwd=cwd, workspace_path=cwd, session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="codex", cwd=cwd, workspace_path=cwd, session_marker="at-pane:p2")
    f1 = _codex_file(root, "rollout-T1-uuid1.jsonl", marker="at-pane:p1", meta_id="uuid-1")
    f2 = _codex_file(root, "rollout-T2-uuid2.jsonl", marker="at-pane:p2", meta_id="uuid-2")

    # session_id passed in is the stem (what the reader emits); resume id comes from session_meta.
    assert attr.maybe_bind_by_marker(_make_usage("codex", session_id="rollout-T2-uuid2", file_path=str(f2), cwd=cwd)) == ("p2", "uuid-2")
    assert attr.maybe_bind_by_marker(_make_usage("codex", session_id="rollout-T1-uuid1", file_path=str(f1), cwd=cwd)) == ("p1", "uuid-1")
    # attribution still routes by the reader's session_id (for tokens).
    assert attr.pane_for_session("rollout-T1-uuid1")[0] == "p1"
    assert attr.pane_for_session("rollout-T2-uuid2")[0] == "p2"


def test_codex_home_path_binds_to_session_home_id(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    root = tmp_path / ".codex-panes" / "home-old" / "sessions" / "2026" / "06" / "08"
    root.mkdir(parents=True)
    f = root / "rollout-2026-06-08T00-00-00-sid.jsonl"
    f.write_text(json.dumps({"type": "session_meta", "payload": {"id": "codex-resume-id", "cwd": "/ws"}}) + "\n")
    attr = Attribution([FakeReader("codex", tmp_path / ".codex")], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "live-pane", vendor="codex", cwd="/ws", workspace_path="/ws",
        session_home_id="home-old",
    )

    usage = _make_usage("codex", session_id=f.stem, file_path=str(f), cwd="/ws")
    binding = attr.maybe_announce_session(usage)

    assert binding is not None
    assert binding.pane_id == "live-pane"
    assert binding.resume_id == "codex-resume-id"
    assert attr.attribute(usage).pane_id == "live-pane"


def test_codex_home_path_rebinds_new_rollout_after_rotation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """In-pane login rotates Codex to a fresh rollout file; the new session
    must bind to the same pane and announce the new resume id (so the
    frontend re-pins instead of staying on the dead pre-login session)."""
    monkeypatch.setenv("HOME", str(tmp_path))
    root = tmp_path / ".codex-panes" / "home-old" / "sessions" / "2026" / "07" / "30"
    root.mkdir(parents=True)
    a = root / "rollout-2026-07-30T22-00-00-sid-a.jsonl"
    a.write_text(json.dumps({"type": "session_meta", "payload": {"id": "resume-a", "cwd": "/ws"}}) + "\n")
    attr = Attribution([FakeReader("codex", tmp_path / ".codex")], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "live-pane", vendor="codex", cwd="/ws", workspace_path="/ws",
        session_home_id="home-old",
    )
    first = attr.maybe_announce_session(
        _make_usage("codex", session_id=a.stem, file_path=str(a), cwd="/ws")
    )
    assert first is not None
    assert first.resume_id == "resume-a"

    b = root / "rollout-2026-07-30T22-30-11-sid-b.jsonl"
    b.write_text(json.dumps({"type": "session_meta", "payload": {"id": "resume-b", "cwd": "/ws"}}) + "\n")
    second = attr.maybe_announce_session(
        _make_usage("codex", session_id=b.stem, file_path=str(b), cwd="/ws")
    )
    assert second is not None
    assert second.pane_id == "live-pane"
    assert second.resume_id == "resume-b"


def test_codex_home_path_waits_for_session_meta(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A newly-created rollout must not publish its filename as a resume id."""
    monkeypatch.setenv("HOME", str(tmp_path))
    root = tmp_path / ".codex-panes" / "home-old" / "sessions"
    root.mkdir(parents=True)
    f = root / "rollout-2026-07-14T23-53-50-real-resume-id.jsonl"
    f.write_text("", encoding="utf-8")
    attr = Attribution(
        [FakeReader("codex", tmp_path / ".codex")],
        workspaces_path=tmp_path / "ws.json",
    )
    attr.register_pane(
        "live-pane", vendor="codex", cwd="/ws", workspace_path="/ws",
        session_home_id="home-old",
    )
    usage = _make_usage("codex", session_id=f.stem, file_path=str(f), cwd="/ws")

    assert attr.maybe_announce_session(usage) is None

    f.write_text(
        json.dumps({"type": "session_meta", "payload": {"id": "real-resume-id", "cwd": "/ws"}}) + "\n",
        encoding="utf-8",
    )
    binding = attr.maybe_announce_session(usage)
    assert binding is not None
    assert binding.resume_id == "real-resume-id"


def test_codex_marker_waits_for_session_meta(codex_attr: tuple[Attribution, Path]) -> None:
    attr, root = codex_attr
    attr.register_pane(
        "p1", vendor="codex", cwd="/ws", workspace_path="/ws",
        session_marker="at-pane:p1",
    )
    f = root / "rollout-2026-07-14T23-53-50-real-id.jsonl"
    marker_record = json.dumps({
        "type": "response_item",
        "payload": {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "<!-- agent-team-session: at-pane:p1 -->"}],
        },
    })
    f.write_text(marker_record + "\n", encoding="utf-8")
    usage = _make_usage("codex", session_id=f.stem, file_path=str(f), cwd="/ws")

    assert attr.maybe_bind_by_marker(usage) is None

    f.write_text(
        json.dumps({"type": "session_meta", "payload": {"id": "real-id", "cwd": "/ws"}})
        + "\n" + marker_record + "\n",
        encoding="utf-8",
    )
    assert attr.maybe_bind_by_marker(usage) == ("p1", "real-id")


def test_codex_home_path_prevents_same_cwd_first_claim(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    root = tmp_path / ".codex-panes"
    f1 = root / "home-a" / "sessions" / "rollout-a.jsonl"
    f2 = root / "home-b" / "sessions" / "rollout-b.jsonl"
    f1.parent.mkdir(parents=True)
    f2.parent.mkdir(parents=True)
    f1.write_text(json.dumps({"type": "session_meta", "payload": {"id": "resume-a", "cwd": "/ws"}}) + "\n")
    f2.write_text(json.dumps({"type": "session_meta", "payload": {"id": "resume-b", "cwd": "/ws"}}) + "\n")
    attr = Attribution([FakeReader("codex", tmp_path / ".codex")], workspaces_path=tmp_path / "ws.json")
    attr.register_pane("pane-a", vendor="codex", cwd="/ws", workspace_path="/ws", session_home_id="home-a")
    attr.register_pane("pane-b", vendor="codex", cwd="/ws", workspace_path="/ws", session_home_id="home-b")

    b2 = attr.maybe_announce_session(
        _make_usage("codex", session_id=f2.stem, file_path=str(f2), cwd="/ws")
    )
    b1 = attr.maybe_announce_session(
        _make_usage("codex", session_id=f1.stem, file_path=str(f1), cwd="/ws")
    )

    assert b2 is not None
    assert b1 is not None
    assert b2.pane_id == "pane-b"
    assert b2.resume_id == "resume-b"
    assert b1.pane_id == "pane-a"
    assert b1.resume_id == "resume-a"


def test_marker_returns_none_when_absent(codex_attr: tuple[Attribution, Path]) -> None:
    attr, root = codex_attr
    attr.register_pane("p1", vendor="codex", cwd="/ws", workspace_path="/ws", session_marker="at-pane:p1")
    f = root / "rollout.jsonl"; f.write_text('{"type":"session_meta","payload":{"id":"x"}}')
    assert attr.maybe_bind_by_marker(_make_usage("codex", session_id="s", file_path=str(f))) is None


def test_marker_binds_only_once(codex_attr: tuple[Attribution, Path]) -> None:
    attr, root = codex_attr
    attr.register_pane("p1", vendor="codex", cwd="/ws", workspace_path="/ws", session_marker="at-pane:p1")
    f = _codex_file(root, "rollout.jsonl", marker="at-pane:p1", meta_id="uuid-1")
    assert attr.maybe_bind_by_marker(_make_usage("codex", session_id="s", file_path=str(f))) == ("p1", "uuid-1")
    # Second event for the same (now-bound) session → no re-announce.
    assert attr.maybe_bind_by_marker(_make_usage("codex", session_id="s", file_path=str(f))) is None


def test_marker_ignored_for_claude(claude_attr: tuple[Attribution, Path]) -> None:
    """Claude uses --session-id, never markers — maybe_bind_by_marker is a no-op."""
    attr, root = claude_attr
    f = root / "s.jsonl"; f.write_text("at-pane:whatever")
    assert attr.maybe_bind_by_marker(_make_usage("claude", session_id="s", file_path=str(f))) is None


def test_marker_unregistered_after_pane_killed(codex_attr: tuple[Attribution, Path]) -> None:
    attr, root = codex_attr
    attr.register_pane("p1", vendor="codex", cwd="/ws", workspace_path="/ws", session_marker="at-pane:p1")
    attr.unregister_pane("p1")
    f = _codex_file(root, "rollout.jsonl", marker="at-pane:p1", meta_id="uuid-1")
    # Marker gone with the pane → nothing to bind.
    assert attr.maybe_bind_by_marker(_make_usage("codex", session_id="s", file_path=str(f))) is None


# ─────────────────────────── claude cwd encoding (CJK paths) ─────────────────

CJK_WS = "/Users/x/Desktop/客戶名單"
CJK_ENCODED = "-Users-x-Desktop-----"  # 4 Chinese chars + leading "/" → 5 dashes


def test_encode_claude_cwd_collapses_non_ascii_to_dashes() -> None:
    """The attribution encoder must match the real Claude CLI encoding."""
    assert encode_claude_cwd(CJK_WS) == CJK_ENCODED
    assert "客戶名單" not in encode_claude_cwd(CJK_WS)


def test_encode_claude_cwd_agrees_with_resume_preflight_encoder() -> None:
    """attribution and app.py must produce the SAME project dir for a cwd —
    a disagreement is exactly the bug that lost CJK workspaces' sessions."""
    from agent_team_backend.app import _session_lookup_path

    p = _session_lookup_path("claude", CJK_WS, "sid1")
    assert p.endswith(f"/{encode_claude_cwd(CJK_WS)}/sid1.jsonl")


def test_cwd_matches_dash_encoded_dir_for_cjk_workspace(
    claude_attr: tuple[Attribution, Path],
) -> None:
    attr, root = claude_attr
    f = root / CJK_ENCODED / "s.jsonl"
    usage = _make_usage("claude", session_id="s", file_path=str(f))
    assert attr._cwd_matches(CJK_WS, usage) is True


def test_register_cjk_workspace_attributes_dash_encoded_files(
    claude_attr: tuple[Attribution, Path],
) -> None:
    attr, root = claude_attr
    attr.register_workspace(CJK_WS)
    proj_dir = root / CJK_ENCODED; proj_dir.mkdir()
    f = proj_dir / "s.jsonl"; f.write_text("")
    result = attr.attribute(_make_usage("claude", session_id="s", file_path=str(f)))
    assert result.workspace_path == CJK_WS


def test_reregistration_corrects_stale_claude_dir(tmp_path: Path) -> None:
    """A claude_dir persisted by the old broken encoder (CJK preserved) must be
    overwritten with the dash-encoded dir on the next registration."""
    root = tmp_path / "claude_projects"; root.mkdir()
    ws_json = tmp_path / "ws.json"
    stale_dir = str(root / CJK_WS.replace("/", "-"))  # old encoder's output
    ws_json.write_text(
        json.dumps({CJK_WS: {"claude_dir": stale_dir, "registered_at": 1.0}}),
        encoding="utf-8",
    )

    attr = Attribution([FakeReader("claude", root)], workspaces_path=ws_json)
    attr.register_workspace(CJK_WS)

    data = attr._db.kv_get("workspace_associations")
    assert data[CJK_WS]["claude_dir"] == str(root / CJK_ENCODED)
    # And attribution now works against the corrected dir.
    proj_dir = root / CJK_ENCODED; proj_dir.mkdir()
    f = proj_dir / "s.jsonl"; f.write_text("")
    assert attr.attribute(
        _make_usage("claude", session_id="s", file_path=str(f))
    ).workspace_path == CJK_WS


# ──────────── new-session single-candidate fallback (Kimi/Antigravity) ───────

@pytest.fixture
def kimi_attr(tmp_path: Path) -> tuple[Attribution, Path]:
    root = tmp_path / "kimi_sessions"; root.mkdir()
    attr = Attribution([FakeReader("kimi", root)], workspaces_path=tmp_path / "ws.json")
    return attr, root


def _kimi_wire(root: Path, session_id: str, text: str = "") -> Path:
    d = root / "wd_ws" / session_id / "agents" / "main"
    d.mkdir(parents=True, exist_ok=True)
    f = d / "wire.jsonl"
    f.write_text(text or json.dumps({"type": "metadata"}) + "\n", encoding="utf-8")
    return f


def _kimi_usage(session_id: str, file_path: Path) -> TokenUsage:
    return _make_usage("kimi", session_id=session_id, file_path=str(file_path), cwd="/ws")


def test_kimi_fallback_binds_single_candidate_without_marker(
    kimi_attr: tuple[Attribution, Path],
) -> None:
    """Kimi's marker is typed into the TUI post-launch and can be silently lost
    to the startup timing race; a lone fresh pane must still capture its new
    session dir so resume-on-restart works."""
    attr, root = kimi_attr
    attr.register_pane("p1", vendor="kimi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    f = _kimi_wire(root, "session_abc")

    binding = attr.maybe_announce_session(_kimi_usage("session_abc", f))
    assert binding is not None
    assert binding.pane_id == "p1"
    assert binding.resume_id == "session_abc"
    assert binding.workspace_path == "/ws"
    assert attr.pane_for_session("session_abc")[0] == "p1"
    # Announce-once: a later watcher event for the same session is silent.
    assert attr.maybe_announce_session(_kimi_usage("session_abc", f)) is None


def test_kimi_fallback_leaves_multiple_candidates_unbound(
    kimi_attr: tuple[Attribution, Path],
) -> None:
    attr, root = kimi_attr
    attr.register_pane("p1", vendor="kimi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="kimi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f = _kimi_wire(root, "session_abc")
    assert attr.maybe_announce_session(_kimi_usage("session_abc", f)) is None


def test_kimi_fallback_ignores_baseline_sessions(
    kimi_attr: tuple[Attribution, Path],
) -> None:
    """A session file that predates the pane's spawn is another conversation —
    never fallback-bind it."""
    attr, root = kimi_attr
    f = _kimi_wire(root, "session_old")
    attr.register_pane("p1", vendor="kimi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    assert attr.maybe_announce_session(_kimi_usage("session_old", f)) is None


def test_kimi_resumed_sibling_does_not_block_fallback(
    kimi_attr: tuple[Attribution, Path],
) -> None:
    """A resumed pane claims its id at registration (explicit_session_id), so a
    fresh sibling in the same cwd remains the single fallback candidate."""
    attr, root = kimi_attr
    _kimi_wire(root, "session_old")
    attr.register_pane("p-resumed", vendor="kimi", cwd="/ws", workspace_path="/ws",
                       explicit_session_id="session_old")
    attr.register_pane("p-fresh", vendor="kimi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:pf")
    f = _kimi_wire(root, "session_new")
    binding = attr.maybe_announce_session(_kimi_usage("session_new", f))
    assert binding is not None
    assert binding.pane_id == "p-fresh"


def test_kimi_marker_binding_still_preferred(
    kimi_attr: tuple[Attribution, Path],
) -> None:
    """When the marker DID land in wire.jsonl, marker matching resolves the
    pane even with multiple candidates."""
    attr, root = kimi_attr
    attr.register_pane("p1", vendor="kimi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="kimi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f2 = _kimi_wire(root, "session_two", text=json.dumps({
        "type": "turn.prompt",
        "prompt": {"input": [{"text": "hi <!-- agent-team-session: at-pane:p2 -->"}]},
    }) + "\n")
    binding = attr.maybe_announce_session(_kimi_usage("session_two", f2))
    assert binding is not None
    assert binding.pane_id == "p2"
    assert binding.resume_id == "session_two"


def test_antigravity_fallback_unchanged_by_generalization(tmp_path: Path) -> None:
    """The single-candidate fallback still binds Antigravity conversations."""
    root = tmp_path / "agy"; root.mkdir()
    attr = Attribution(
        [FakeReader("antigravity", root)], workspaces_path=tmp_path / "ws.json"
    )
    attr.register_pane("pa", vendor="antigravity", cwd="/ws", workspace_path="/ws")
    f = root / "conv-1.jsonl"; f.write_text("")
    binding = attr.maybe_announce_session(
        _make_usage("antigravity", session_id="conv-1", file_path=str(f), cwd="/ws")
    )
    assert binding is not None
    assert binding.pane_id == "pa"
