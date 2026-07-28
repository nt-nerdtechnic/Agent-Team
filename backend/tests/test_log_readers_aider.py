"""AiderLogReader: Markdown section parsing + last-section marker binding.

Aider appends every session to ONE per-project Markdown history file
(`<git-root>/.aider.chat.history.md`) and has no session-id concept — the
reader coins ids from the `# aider chat started at …` section headers. These
tests pin: loose token-count parsing (`1,234` / `12k` / `1.2k`), incremental
offset resume + truncation restart, last-section-only marker binding, the
git-root history path, and the activity semantics (turn_complete per usage
line, carrying the turn's accumulated assistant text).
"""

from __future__ import annotations

from pathlib import Path

from agent_team_backend.log_readers import AiderLogReader
from agent_team_backend.log_readers.aider import HISTORY_NAME, aider_history_path
from agent_team_backend.log_readers.attribution import Attribution

_SECTION_1 = """# aider chat started at 2026-07-27 10:00:00

#### hello aider
#### second line of the same message

Sure — here is the plan.

> Tokens: 1,234 sent, 567 received. Cost: $0.01 message, $0.01 session.
"""

_SECTION_2 = """
# aider chat started at 2026-07-28 21:30:45

#### kickoff for the new pane

Working on it.

> Tokens: 12k sent, 1.2k received. Cost: $0.05 message, $0.06 session.
"""


def _history(ws: Path, text: str) -> Path:
    ws.mkdir(parents=True, exist_ok=True)
    p = ws / HISTORY_NAME
    p.write_text(text, encoding="utf-8")
    return p


# ── history path ─────────────────────────────────────────────────────────────

def test_history_path_prefers_git_root(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    (root / ".git").mkdir(parents=True)
    nested = root / "src" / "deep"
    nested.mkdir(parents=True)
    assert aider_history_path(str(nested)) == root / HISTORY_NAME
    # No git root anywhere above → the cwd itself.
    loose = tmp_path / "loose"
    loose.mkdir()
    assert aider_history_path(str(loose)) == loose / HISTORY_NAME


def test_reader_claims_only_the_history_filename(tmp_path: Path) -> None:
    reader = AiderLogReader()
    assert reader.claims_path(tmp_path / "anywhere" / HISTORY_NAME) is True
    assert reader.claims_path(tmp_path / "notes.md") is False
    # No global roots: discovery is workspace-driven.
    assert reader.project_dirs() == []
    assert reader.session_files() == []


def test_session_files_for_workspace_is_the_single_history_file(
    tmp_path: Path,
) -> None:
    reader = AiderLogReader()
    ws = tmp_path / "ws"
    assert reader.session_files_for_workspace(str(ws)) == []
    p = _history(ws, _SECTION_1)
    assert reader.session_files_for_workspace(str(ws)) == [p]


# ── session id ───────────────────────────────────────────────────────────────

def test_session_id_is_the_last_section_slug(tmp_path: Path) -> None:
    reader = AiderLogReader()
    p = _history(tmp_path / "ws", _SECTION_1 + _SECTION_2)
    assert reader.session_id_from_path(p) == "aider-20260728-213045"
    # Non-history files are never session files.
    other = tmp_path / "ws" / "README.md"
    other.write_text("# aider chat started at 2026-07-28 21:30:45\n")
    assert reader.session_id_from_path(other) == ""


# ── token parsing ────────────────────────────────────────────────────────────

def test_parse_incremental_sections_and_number_formats(tmp_path: Path) -> None:
    reader = AiderLogReader()
    ws = tmp_path / "ws"
    p = _history(ws, _SECTION_1 + _SECTION_2)

    result = reader.parse_incremental(p, {})
    assert [(e.session_id, e.input_tokens, e.output_tokens) for e in result.events] == [
        ("aider-20260727-100000", 1234, 567),
        ("aider-20260728-213045", 12000, 1200),
    ]
    ev = result.events[0]
    assert ev.vendor == "aider"
    assert ev.cwd == str(ws)
    assert ev.timestamp == "2026-07-27T10:00:00"
    assert result.checkpoint["section"] == "aider-20260728-213045"

    # Re-parse from the returned checkpoint: nothing new.
    again = reader.parse_incremental(p, result.checkpoint)
    assert again.events == []


def test_parse_incremental_appends_resume_mid_section(tmp_path: Path) -> None:
    reader = AiderLogReader()
    p = _history(tmp_path / "ws", _SECTION_1 + _SECTION_2)
    checkpoint = reader.parse_incremental(p, {}).checkpoint

    # A later assistant message appends another usage line to the SAME
    # section; the checkpoint's section id must attribute it correctly.
    with p.open("a", encoding="utf-8") as fh:
        fh.write("\nMore output.\n\n> Tokens: 8.5k sent, 42 received. Cost: $0.02 message.\n")
    result = reader.parse_incremental(p, checkpoint)
    assert [(e.session_id, e.input_tokens, e.output_tokens) for e in result.events] == [
        ("aider-20260728-213045", 8500, 42),
    ]


def test_parse_incremental_truncation_restarts_from_zero(tmp_path: Path) -> None:
    reader = AiderLogReader()
    p = _history(tmp_path / "ws", _SECTION_1 + _SECTION_2)
    checkpoint = reader.parse_incremental(p, {}).checkpoint

    # File replaced by a shorter generation → restart, stale section dropped.
    p.write_text(_SECTION_1, encoding="utf-8")
    result = reader.parse_incremental(p, checkpoint)
    assert [(e.session_id, e.input_tokens) for e in result.events] == [
        ("aider-20260727-100000", 1234),
    ]
    assert result.checkpoint["section"] == "aider-20260727-100000"


def test_parse_session_file_dedups_via_seen_keys(tmp_path: Path) -> None:
    reader = AiderLogReader()
    p = _history(tmp_path / "ws", _SECTION_1)
    seen: set[str] = set()
    first = reader.parse_session_file(p, seen)
    assert [(e.session_id, e.input_tokens, e.output_tokens) for e in first] == [
        ("aider-20260727-100000", 1234, 567),
    ]
    assert reader.parse_session_file(p, seen) == []


# ── marker binding (attribution) ─────────────────────────────────────────────

def _bind_usage(reader: AiderLogReader, p: Path):
    """The placeholder usage app._on_session_file builds for a file change."""
    from agent_team_backend.log_readers import TokenUsage

    return TokenUsage(
        vendor="aider", input_tokens=0, output_tokens=0,
        cwd=reader.cwd_from_file(p),
        session_id=reader.session_id_from_path(p),
        file_path=str(p), dedup_key="",
    )


def test_marker_binds_only_in_the_last_section(tmp_path: Path) -> None:
    reader = AiderLogReader()
    ws = tmp_path / "ws"
    marker = "at-pane:pane-aider-1"

    # Marker text present ONLY in a historic (non-last) section → no bind.
    stale = _SECTION_1.replace("#### hello aider", f"#### {marker} hello") + _SECTION_2
    p = _history(ws, stale)
    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-aider-1", vendor="aider", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )
    assert attr.maybe_announce_session(_bind_usage(reader, p)) is None

    # Marker lands in the LAST section (multi-line input continuation) → bind.
    with p.open("a", encoding="utf-8") as fh:
        fh.write(f"\n#### please continue  \n#### {marker}\n")
    binding = attr.maybe_announce_session(_bind_usage(reader, p))
    assert binding is not None
    assert binding.pane_id == "pane-aider-1"
    # The "resume id" is the last section's started-at slug (informational —
    # aider's actual resume is the id-less `--restore-chat-history`).
    assert binding.resume_id == "aider-20260728-213045"
    assert binding.workspace_path == str(ws)
    # Binding is a transition: the same file event never re-announces.
    assert attr.maybe_announce_session(_bind_usage(reader, p)) is None


def test_bound_session_attributes_to_pane_and_workspace(tmp_path: Path) -> None:
    reader = AiderLogReader()
    ws = tmp_path / "ws"
    marker = "at-pane:pane-aider-2"
    p = _history(ws, _SECTION_2.lstrip("\n").replace(
        "#### kickoff for the new pane", f"#### {marker} kickoff"
    ))

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-aider-2", vendor="aider", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )
    assert attr.maybe_announce_session(_bind_usage(reader, p)) is not None

    attributed = attr.attribute(_bind_usage(reader, p))
    assert attributed.workspace_path == str(ws)
    assert attributed.pane_id == "pane-aider-2"


def test_workspace_registered_at_subdir_still_matches_git_root_file(
    tmp_path: Path,
) -> None:
    """A workspace opened at <root>/sub maps to the root's history file —
    aider always writes at the git root, not the pane cwd."""
    reader = AiderLogReader()
    root = tmp_path / "proj"
    (root / ".git").mkdir(parents=True)
    sub = root / "sub"
    sub.mkdir()
    p = _history(root, _SECTION_1)

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_workspace(str(sub))

    attributed = attr.attribute(_bind_usage(reader, p))
    assert attributed.workspace_path == str(sub)


# ── activity ─────────────────────────────────────────────────────────────────

def test_activity_prompt_output_and_turn_complete(tmp_path: Path) -> None:
    reader = AiderLogReader()
    p = _history(tmp_path / "ws", _SECTION_1)
    seen: set[str] = set()

    events = reader.parse_activity(p, seen)
    kinds = [(e.event_type, e.detail) for e in events]
    # One coalesced prompt (two consecutive `#### ` lines), one coalesced
    # output signal, one turn_complete on the usage line.
    assert kinds == [
        ("agent_active", "prompt"),
        ("agent_active", "output"),
        ("turn_complete", "usage"),
    ]
    done = events[-1]
    assert done.session_id == "aider-20260727-100000"
    assert "Sure — here is the plan." in done.text
    # Usage/blockquote lines never leak into the turn text.
    assert "Tokens:" not in done.text

    # Dedup: a second walk over the unchanged file emits nothing.
    assert reader.parse_activity(p, seen) == []


def test_activity_turn_text_survives_split_poll_batches(tmp_path: Path) -> None:
    """Assistant text and its usage line landing in different poll batches
    still delivers the text on turn_complete (pending text is persisted in
    the watcher-owned seen_keys set)."""
    reader = AiderLogReader()
    ws = tmp_path / "ws"
    p = _history(ws, "# aider chat started at 2026-07-28 21:30:45\n\n#### go\n\nHalf an answer.\n")
    seen: set[str] = set()
    first = reader.parse_activity(p, seen)
    assert [e.event_type for e in first] == ["agent_active", "agent_active"]

    with p.open("a", encoding="utf-8") as fh:
        fh.write("\n> Tokens: 100 sent, 50 received. Cost: $0.01 message.\n")
    second = reader.parse_activity(p, seen)
    assert [e.event_type for e in second] == ["turn_complete"]
    assert "Half an answer." in second[0].text
