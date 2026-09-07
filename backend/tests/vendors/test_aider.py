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

import hashlib
from pathlib import Path

from agent_team_backend.log_readers import AiderLogReader
from agent_team_backend.log_readers.aider import (
    HISTORY_NAME,
    aider_history_path,
    aider_pane_history_path,
    history_namespace,
    pane_history_name,
)
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import activity_high_water

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


def _pane_history(ws: Path, pane_id: str, text: str) -> Path:
    ws.mkdir(parents=True, exist_ok=True)
    p = ws / pane_history_name(pane_id)
    p.write_text(text, encoding="utf-8")
    return p


def _sid(p: Path, stamp: str) -> str:
    """The namespaced session id the reader coins for started-at `stamp`
    (`YYYYMMDD-HHMMSS`) inside history file `p`."""
    return f"aider-{history_namespace(p)}-{stamp}"


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
    assert reader.session_id_from_path(p) == _sid(p, "20260728-213045")
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
        (_sid(p, "20260727-100000"), 1234, 567),
        (_sid(p, "20260728-213045"), 12000, 1200),
    ]
    ev = result.events[0]
    assert ev.vendor == "aider"
    assert ev.cwd == str(ws)
    assert ev.timestamp == "2026-07-27T10:00:00"
    assert result.checkpoint["section"] == _sid(p, "20260728-213045")

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
        (_sid(p, "20260728-213045"), 8500, 42),
    ]


def test_parse_incremental_truncation_restarts_from_zero(tmp_path: Path) -> None:
    reader = AiderLogReader()
    p = _history(tmp_path / "ws", _SECTION_1 + _SECTION_2)
    checkpoint = reader.parse_incremental(p, {}).checkpoint

    # File replaced by a shorter generation → restart, stale section dropped.
    p.write_text(_SECTION_1, encoding="utf-8")
    result = reader.parse_incremental(p, checkpoint)
    assert [(e.session_id, e.input_tokens) for e in result.events] == [
        (_sid(p, "20260727-100000"), 1234),
    ]
    assert result.checkpoint["section"] == _sid(p, "20260727-100000")


def test_parse_session_file_dedups_via_seen_keys(tmp_path: Path) -> None:
    reader = AiderLogReader()
    p = _history(tmp_path / "ws", _SECTION_1)
    seen: set[str] = set()
    first = reader.parse_session_file(p, seen)
    assert [(e.session_id, e.input_tokens, e.output_tokens) for e in first] == [
        (_sid(p, "20260727-100000"), 1234, 567),
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
    assert binding.resume_id == _sid(p, "20260728-213045")
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
    assert done.session_id == _sid(p, "20260727-100000")
    assert "Sure — here is the plan." in done.text
    # Usage/blockquote lines never leak into the turn text.
    assert "Tokens:" not in done.text

    # Dedup: a second walk over the unchanged file emits nothing.
    assert reader.parse_activity(p, seen) == []


def test_activity_prompt_carries_first_prompt_line_text(tmp_path: Path) -> None:
    """The coalesced prompt event carries the first `#### ` line's text
    (truncated to 500 chars) for pane naming; the injected "<...>"-prefixed
    session-marker bootstrap and output events stay text-less."""
    reader = AiderLogReader()
    p = _history(
        tmp_path / "ws",
        "# aider chat started at 2026-07-28 21:30:45\n\n"
        "#### <!-- agent-team-session: at-pane:p1 -->\n\nsome output\n\n"
        "#### fix the login bug\n#### second line\n\nmore output\n\n"
        f"#### {'p' * 600}\n",
    )
    events = reader.parse_activity(p, set())
    prompts = [e for e in events if e.detail == "prompt"]
    assert [e.text for e in prompts] == ["", "fix the login bug", "p" * 500]
    assert all(e.text == "" for e in events if e.detail == "output")


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


def _long_history(tmp_path: Path, turns: int) -> Path:
    """A history file with `turns` complete prompt/answer/usage cycles."""
    body = "".join(
        f"#### ask {i}\n\nanswer {i}\n\n"
        "> Tokens: 100 sent, 50 received. Cost: $0.01 message.\n\n"
        for i in range(turns)
    )
    return _history(
        tmp_path / "ws", "# aider chat started at 2026-07-28 21:30:45\n\n" + body
    )


def test_activity_leaves_a_half_written_last_line_for_next_poll(tmp_path: Path) -> None:
    """A poll that catches aider mid-write on the trailing usage line must
    not mark it seen: that line is aider's only turn_complete signal, and
    losing it strands the pane mid-turn forever (GitHub #21)."""
    reader = AiderLogReader()
    p = _history(
        tmp_path / "ws",
        "# aider chat started at 2026-07-28 21:30:45\n\n#### go\n\nHalf an answer.\n",
    )
    seen: set[str] = set()
    first = reader.parse_activity(p, seen)
    assert [e.event_type for e in first] == ["agent_active", "agent_active"]
    line_count = len(p.read_text(encoding="utf-8").splitlines())

    full_line = "> Tokens: 100 sent, 50 received. Cost: $0.01 message.\n"
    with p.open("a", encoding="utf-8") as fh:
        fh.write(full_line[:20])  # aider is still writing this line
    assert reader.parse_activity(p, seen) == []
    assert activity_high_water(seen) == line_count, \
        "must not advance past the half-written line"

    with p.open("a", encoding="utf-8") as fh:
        fh.write(full_line[20:])
    events = reader.parse_activity(p, seen)
    assert [e.event_type for e in events] == ["turn_complete"]
    assert "Half an answer." in events[0].text


def test_activity_seen_keys_stay_constant_size(tmp_path: Path) -> None:
    """seen_keys lives as long as the watched file, so a walk of a long
    history must leave ONE high-water mark in it, not a key per line
    (GitHub #23)."""
    reader = AiderLogReader()
    p = _long_history(tmp_path, 120)
    seen: set[str] = set()

    reader.parse_activity(p, seen)

    assert [k for k in seen if k.startswith("act:")] == []
    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    line_count = len(p.read_text(encoding="utf-8").splitlines())
    assert line_count > 500
    assert activity_high_water(seen) == line_count


def test_activity_high_water_stops_a_reparse(tmp_path: Path) -> None:
    reader = AiderLogReader()
    p = _long_history(tmp_path, 120)
    seen: set[str] = set()

    assert reader.parse_activity(p, seen) != []
    assert reader.parse_activity(p, seen) == []


def test_activity_appended_lines_keep_their_dedup_keys(tmp_path: Path) -> None:
    """Incremental delivery still works, and the keys the frontend dedups on
    are still line-relative."""
    reader = AiderLogReader()
    p = _long_history(tmp_path, 3)
    seen: set[str] = set()
    reader.parse_activity(p, seen)
    line_count = len(p.read_text(encoding="utf-8").splitlines())

    with p.open("a", encoding="utf-8") as fh:
        fh.write("#### one more question\n")
    fresh = reader.parse_activity(p, seen)

    assert [(e.event_type, e.detail) for e in fresh] == [("agent_active", "prompt")]
    assert fresh[0].dedup_key == f"act:{line_count + 1}"
    assert fresh[0].text == "one more question"
    assert activity_high_water(seen) == line_count + 1


def test_activity_pending_text_sentinel_coexists_with_the_mark(
    tmp_path: Path,
) -> None:
    """The pending-turn text lives in the same bag as prefixed sentinels; the
    high-water mark must neither evict it nor be evicted by it."""
    reader = AiderLogReader()
    ws = tmp_path / "ws"
    p = _history(
        ws, "# aider chat started at 2026-07-28 21:30:45\n\n#### go\n\nHalf an answer.\n"
    )
    seen: set[str] = set()
    reader.parse_activity(p, seen)
    assert [k for k in seen if k.startswith("aider_text::")]
    assert len([k for k in seen if k.startswith("act_hw::")]) == 1

    with p.open("a", encoding="utf-8") as fh:
        fh.write("\n> Tokens: 100 sent, 50 received. Cost: $0.01 message.\n")
    done = reader.parse_activity(p, seen)

    assert [e.event_type for e in done] == ["turn_complete"]
    assert "Half an answer." in done[0].text


# ── per-pane history files ───────────────────────────────────────────────────

def test_claims_path_accepts_per_pane_files_and_rejects_siblings(
    tmp_path: Path,
) -> None:
    """The per-pane pattern is anchored to exactly 8 lowercase hex chars, so
    aider's other dotfiles (and user backups) are never claimed."""
    reader = AiderLogReader()
    assert reader.claims_path(tmp_path / HISTORY_NAME) is True
    assert reader.claims_path(tmp_path / ".aider.chat.history.a1b2c3d4.md") is True
    for name in (
        ".aider.input.history",
        ".aider.llm.history",
        ".aider.tags.cache.v3",
        ".aider.chat.history.md.bak",
        ".aider.chat.history.backup.md",
        ".aider.chat.history.A1B2C3D4.md",
        "aider.chat.history.a1b2c3d4.md",
        ".aider.chat.history.a1b2c3d4.markdown",
    ):
        assert reader.claims_path(tmp_path / name) is False, name


def test_session_files_for_workspace_includes_per_pane_files(
    tmp_path: Path,
) -> None:
    reader = AiderLogReader()
    root = tmp_path / "repo"
    (root / ".git").mkdir(parents=True)
    sub = root / "sub"
    sub.mkdir()
    assert reader.session_files_for_workspace(str(sub)) == []

    legacy = _history(root, _SECTION_1)
    pane_file = _pane_history(root, "a1b2c3d4-e5f6-4777-8888-999999999999", _SECTION_1)
    (root / ".aider.input.history").write_text("noise", encoding="utf-8")
    assert reader.session_files_for_workspace(str(sub)) == [legacy, pane_file]
    assert pane_file == aider_pane_history_path(
        str(sub), "a1b2c3d4-e5f6-4777-8888-999999999999"
    )


def test_two_panes_in_one_repo_keep_their_tokens_apart(tmp_path: Path) -> None:
    """BUG-1: both panes appended to `<git-root>/.aider.chat.history.md`, so
    every `> Tokens:` line was attributed to whichever section came last and
    the two panes' usage merged into one bucket. With a per-pane history file
    each pane's usage stays in its own bucket even when the two sessions start
    in the SAME second in the SAME repo."""
    reader = AiderLogReader()
    root = tmp_path / "repo"
    (root / ".git").mkdir(parents=True)
    pane_a = "aaaaaaaa-1111-4222-8333-444444444444"
    pane_b = "bbbbbbbb-1111-4222-8333-444444444444"
    marker_a, marker_b = f"at-pane:{pane_a}", f"at-pane:{pane_b}"
    header = "# aider chat started at 2026-07-29 09:00:00\n\n"

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    for pid, marker in ((pane_a, marker_a), (pane_b, marker_b)):
        attr.register_pane(
            pid, vendor="aider", cwd=str(root),
            workspace_path=str(root), session_marker=marker,
        )
    fa = _pane_history(root, pane_a, header + (
        f"#### {marker_a} go\n\nA answer.\n\n"
        "> Tokens: 1,000 sent, 100 received. Cost: $0.01 message.\n"
    ))
    fb = _pane_history(root, pane_b, header + (
        f"#### {marker_b} go\n\nB answer.\n\n"
        "> Tokens: 2,000 sent, 200 received. Cost: $0.02 message.\n"
    ))

    assert reader.session_id_from_path(fa) != reader.session_id_from_path(fb)
    assert attr.maybe_announce_session(_bind_usage(reader, fa)).pane_id == pane_a
    assert attr.maybe_announce_session(_bind_usage(reader, fb)).pane_id == pane_b

    buckets: dict[str | None, int] = {}
    for f in (fa, fb):
        for ev in reader.parse_incremental(f, {}).events:
            attributed = attr.attribute(ev)
            assert attributed.workspace_path == str(root)
            buckets[attributed.pane_id] = (
                buckets.get(attributed.pane_id, 0) + ev.input_tokens
            )
    assert buckets == {pane_a: 1000, pane_b: 2000}


def test_pane_with_its_own_file_never_claims_the_legacy_shared_file(
    tmp_path: Path,
) -> None:
    """Backward compatibility both ways: a pane with no per-pane file still
    owns the legacy shared file, while a pane that has one never claims it."""
    reader = AiderLogReader()
    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")

    legacy_ws = tmp_path / "legacy"
    legacy_ws.mkdir()
    attr.register_pane(
        "legacy-pane", vendor="aider", cwd=str(legacy_ws),
        workspace_path=str(legacy_ws),
    )
    legacy = _history(legacy_ws, _SECTION_1)
    legacy_ev = reader.parse_incremental(legacy, {}).events[0]
    assert attr.attribute(legacy_ev).pane_id == "legacy-pane"

    own_ws = tmp_path / "own"
    own_ws.mkdir()
    pane = "cccccccc-1111-4222-8333-444444444444"
    attr.register_pane(
        pane, vendor="aider", cwd=str(own_ws), workspace_path=str(own_ws),
    )
    _pane_history(own_ws, pane, _SECTION_1)
    stray = _history(own_ws, _SECTION_2.lstrip("\n"))
    stray_ev = reader.parse_incremental(stray, {}).events[0]
    attributed = attr.attribute(stray_ev)
    assert attributed.workspace_path == str(own_ws)
    assert attributed.pane_id is None


def test_same_second_in_two_workspaces_binds_both_panes(tmp_path: Path) -> None:
    """BUG-2: `aider-YYYYMMDD-HHMMSS` carried no path namespace, so two panes
    started in the same second in DIFFERENT workspaces coined the same session
    id; the second one short-circuited on the session_owner check and its
    tokens were routed to the first pane."""
    reader = AiderLogReader()
    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    body = (
        "# aider chat started at 2026-07-29 09:00:00\n\n"
        "#### {marker} go\n\nOK.\n\n"
        "> Tokens: 1,000 sent, 100 received. Cost: $0.01 message.\n"
    )

    bound: list[tuple[Path, str, str]] = []
    for name in ("ws-a", "ws-b"):
        ws = tmp_path / name
        ws.mkdir()
        pane_id, marker = f"pane-{name}", f"at-pane:pane-{name}"
        attr.register_pane(
            pane_id, vendor="aider", cwd=str(ws),
            workspace_path=str(ws), session_marker=marker,
        )
        p = _history(ws, body.format(marker=marker))
        binding = attr.maybe_announce_session(_bind_usage(reader, p))
        assert binding is not None, f"{pane_id} failed to bind"
        assert binding.pane_id == pane_id
        bound.append((p, pane_id, binding.resume_id))

    assert bound[0][2] != bound[1][2]
    for p, pane_id, _ in bound:
        ev = reader.parse_incremental(p, {}).events[0]
        assert attr.attribute(ev).pane_id == pane_id


def test_namespace_derivation_and_slug_assembly_are_literal(
    tmp_path: Path,
) -> None:
    """Pins the namespace derivation itself with literal expectations (the
    `_sid` helper above is a convenience and would follow any regression in
    `history_namespace`). Per-pane file → the token from its own name; legacy
    file → md5(resolved path)[:8]; id → `aider-<ns>-<stamp>`."""
    reader = AiderLogReader()
    ws = tmp_path / "ns"
    ws.mkdir()
    header = "# aider chat started at 2026-07-29 09:00:00\n"

    per_pane = ws / ".aider.chat.history.a1b2c3d4.md"
    per_pane.write_text(header, encoding="utf-8")
    assert history_namespace(per_pane) == "a1b2c3d4"
    assert reader.session_id_from_path(per_pane) == "aider-a1b2c3d4-20260729-090000"

    legacy = ws / HISTORY_NAME
    legacy.write_text(header, encoding="utf-8")
    expected_ns = hashlib.md5(
        str(legacy.resolve()).encode("utf-8")
    ).hexdigest()[:8]
    assert history_namespace(legacy) == expected_ns
    assert reader.session_id_from_path(legacy) == (
        f"aider-{expected_ns}-20260729-090000"
    )
    # The two files sit in ONE directory: their namespaces must still differ.
    assert history_namespace(legacy) != history_namespace(per_pane)
