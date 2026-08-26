"""Droid vendor: cwd encoding, session lookup, resume parsing, log reading.

The fixtures mirror droid 0.204.0's real on-disk shapes — a `session_start`
first line, Anthropic-shaped content blocks, and the separate
`agent_turn_outcome` record that marks a turn's end.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import droid
from agent_team_backend.cli_vendors.droid import (
    DroidLogReader,
    encode_droid_cwd,
)


# ---- cwd encoding ---------------------------------------------------------

def test_encode_replaces_only_separators() -> None:
    """The whole point of not reusing encode_claude_cwd: droid keeps hyphens
    and dots, Claude's encoder would flatten them."""
    assert encode_droid_cwd("/Users/me/Desktop/Agent-Team") == (
        "-Users-me-Desktop-Agent-Team"
    )
    assert encode_droid_cwd("/Users/me/my.proj") == "-Users-me-my.proj"
    assert encode_droid_cwd("/Users/me/a_b") == "-Users-me-a_b"


def test_encode_strips_trailing_and_collapses_runs() -> None:
    assert encode_droid_cwd("/Users/me/proj/") == "-Users-me-proj"
    assert encode_droid_cwd("/Users//me///proj") == "-Users-me-proj"


def test_encode_matches_the_real_directory_on_disk() -> None:
    """Regression anchor: this exact pair was read off a real droid install."""
    assert encode_droid_cwd("/Users/neillu/Desktop/Agent-Team") == (
        "-Users-neillu-Desktop-Agent-Team"
    )


# ---- fixtures -------------------------------------------------------------

def _write_session(
    root: Path, cwd: str, session_id: str, lines: list[dict]
) -> Path:
    d = root / encode_droid_cwd(cwd)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{session_id}.jsonl"
    path.write_text(
        "".join(json.dumps(rec) + "\n" for rec in lines), encoding="utf-8"
    )
    return path


def _session_start(session_id: str, cwd: str, **extra) -> dict:
    return {
        "type": "session_start",
        "id": session_id,
        "title": "t",
        "owner": "me",
        "version": 2,
        "cwd": cwd,
        **extra,
    }


def _msg(role: str, content, **extra) -> dict:
    return {
        "type": "message",
        "id": f"m-{role}-{len(str(content))}",
        "timestamp": "2026-08-26T17:58:46.446Z",
        "message": {"role": role, "content": content, **extra},
    }


@pytest.fixture()
def sessions_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / ".factory" / "sessions"
    root.mkdir(parents=True)
    monkeypatch.setenv("FACTORY_HOME_OVERRIDE", str(tmp_path / ".factory"))
    return root


# ---- root resolution ------------------------------------------------------

def test_root_honours_home_override(sessions_root: Path) -> None:
    assert droid.droid_sessions_root() == sessions_root


def test_root_is_none_when_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FACTORY_HOME_OVERRIDE", str(tmp_path / "nope"))
    assert droid.droid_sessions_root() is None


# ---- file discovery -------------------------------------------------------

def test_session_files_covers_all_three_layouts(sessions_root: Path) -> None:
    _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    (sessions_root / "flat.jsonl").write_text("", encoding="utf-8")
    btw = sessions_root / "btw"
    btw.mkdir()
    (btw / "forked.jsonl").write_text("", encoding="utf-8")

    names = {p.name for p in DroidLogReader().session_files()}
    assert names == {"a.jsonl", "flat.jsonl", "forked.jsonl"}


def test_session_files_ignores_the_settings_sidecar(
    sessions_root: Path,
) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    (path.parent / "a.settings.json").write_text("{}", encoding="utf-8")
    assert [p.name for p in DroidLogReader().session_files()] == ["a.jsonl"]


def test_session_files_for_workspace_scopes_to_one_directory(
    sessions_root: Path,
) -> None:
    _write_session(sessions_root, "/w/one", "a", [_session_start("a", "/w/one")])
    _write_session(sessions_root, "/w/two", "b", [_session_start("b", "/w/two")])

    got = DroidLogReader().session_files_for_workspace("/w/one")
    assert [p.name for p in got] == ["a.jsonl"]


# ---- cwd from file --------------------------------------------------------

def test_cwd_comes_from_session_start(sessions_root: Path) -> None:
    path = _write_session(
        sessions_root, "/w/proj", "a", [_session_start("a", "/w/proj")]
    )
    assert DroidLogReader().cwd_from_file(path) == "/w/proj"


def test_last_cwd_wins_over_cwd(sessions_root: Path) -> None:
    """droid itself prefers lastCwd — cwd is only where the session is filed."""
    path = _write_session(
        sessions_root, "/w/proj", "a",
        [_session_start("a", "/w/proj", lastCwd="/w/moved")],
    )
    assert DroidLogReader().cwd_from_file(path) == "/w/moved"


def test_cwd_survives_a_hyphenated_directory(sessions_root: Path) -> None:
    """The reason cwd is READ rather than reversed from the directory name:
    '-w-Agent-Team' cannot be reversed unambiguously."""
    path = _write_session(
        sessions_root, "/w/Agent-Team", "a", [_session_start("a", "/w/Agent-Team")]
    )
    assert DroidLogReader().cwd_from_file(path) == "/w/Agent-Team"


def test_cwd_is_empty_for_a_malformed_first_line(sessions_root: Path) -> None:
    d = sessions_root / encode_droid_cwd("/w")
    d.mkdir(parents=True)
    path = d / "a.jsonl"
    path.write_text("not json\n", encoding="utf-8")
    assert DroidLogReader().cwd_from_file(path) == ""


# ---- activity -------------------------------------------------------------

def test_turn_outcome_emits_turn_complete_with_the_assistant_text(
    sessions_root: Path,
) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("user", [{"type": "text", "text": "hello"}]),
        _msg("assistant", [{"type": "text", "text": "hi there"}]),
        {"type": "agent_turn_outcome", "turnId": "t1", "reason": "completed",
         "resultKind": "text"},
    ])
    events = DroidLogReader().parse_activity(path, set())

    done = [e for e in events if e.event_type == "turn_complete"]
    assert len(done) == 1
    assert done[0].detail == "completed"
    assert done[0].text == "hi there"
    assert done[0].cwd == "/w"
    assert done[0].session_id == "a"


@pytest.mark.parametrize(
    "reason", ["cancelled", "error", "permission_rejected", "process_exit"]
)
def test_an_aborted_turn_still_completes(
    sessions_root: Path, reason: str
) -> None:
    """A cancelled turn has still STOPPED. Withholding turn_complete here is
    what strands a pane in mid-turn forever."""
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        {"type": "agent_turn_outcome", "turnId": "t1", "reason": reason},
    ])
    events = DroidLogReader().parse_activity(path, set())
    done = [e for e in events if e.event_type == "turn_complete"]
    assert [e.detail for e in done] == [reason]


def test_user_prompt_text_is_carried_for_pane_naming(
    sessions_root: Path,
) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("user", [{"type": "text", "text": "rename this pane"}]),
    ])
    events = DroidLogReader().parse_activity(path, set())
    user = [e for e in events if e.detail == "user"]
    assert [e.text for e in user] == ["rename this pane"]


def test_tool_results_carry_no_prompt_text(sessions_root: Path) -> None:
    """droid files tool results under role=user; naming a pane after one would
    show a command's output as the pane title."""
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("user", [
            {"type": "tool_result", "tool_use_id": "tu1", "content": "README.md"}
        ]),
    ])
    events = DroidLogReader().parse_activity(path, set())
    assert [e.text for e in events if e.detail == "user"] == [""]


def test_hook_records_carry_no_prompt_text(sessions_root: Path) -> None:
    """Every hook invocation is persisted as a role=user message; a pane must
    not be named after a shell snippet."""
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("user", [], hookEventName="SessionStart", hookMatcher="startup"),
    ])
    events = DroidLogReader().parse_activity(path, set())
    assert [e.text for e in events if e.detail == "user"] == [""]


def test_assistant_lines_report_activity(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("assistant", [
            {"type": "tool_use", "id": "tu1", "name": "Execute",
             "input": {"command": "ls"}}
        ]),
    ])
    events = DroidLogReader().parse_activity(path, set())
    assert [e.detail for e in events if e.event_type == "agent_active"] == [
        "assistant"
    ]


def test_activity_does_not_re_emit_on_a_second_poll(
    sessions_root: Path,
) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("assistant", [{"type": "text", "text": "hi"}]),
        {"type": "agent_turn_outcome", "turnId": "t1", "reason": "completed"},
    ])
    reader = DroidLogReader()
    seen: set[str] = set()
    assert reader.parse_activity(path, seen)
    assert reader.parse_activity(path, seen) == []


def test_a_half_written_final_line_is_re_read_next_poll(
    sessions_root: Path,
) -> None:
    """Stepping over an unterminated line loses it for good — and when the lost
    line is the turn outcome, the pane never leaves mid-turn (GitHub #21)."""
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("assistant", [{"type": "text", "text": "hi"}]),
    ])
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"type":"agent_turn_outcome","turnId":"t1","reason":"comp')

    reader = DroidLogReader()
    seen: set[str] = set()
    first = reader.parse_activity(path, seen)
    assert [e.event_type for e in first] == ["agent_active"]

    with path.open("a", encoding="utf-8") as fh:
        fh.write('leted"}\n')
    second = reader.parse_activity(path, seen)
    assert [e.event_type for e in second] == ["turn_complete"]


def test_unknown_record_types_are_ignored(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        {"type": "compaction_state", "id": "c1", "summaryText": "x"},
        {"type": "something_new", "id": "z"},
    ])
    assert DroidLogReader().parse_activity(path, set()) == []


# ---- token usage ----------------------------------------------------------

def _write_sidecar(path: Path, **usage) -> None:
    (path.parent / f"{path.stem}.settings.json").write_text(
        json.dumps({"model": "claude-opus-5", "tokenUsage": {
            "inputTokens": 0, "outputTokens": 0, "cacheCreationTokens": 0,
            "cacheReadTokens": 0, "thinkingTokens": 0, **usage,
        }}),
        encoding="utf-8",
    )


def test_usage_folds_cache_into_input(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    _write_sidecar(
        path, inputTokens=10, cacheCreationTokens=5, cacheReadTokens=7,
        outputTokens=3,
    )
    events = DroidLogReader().parse_session_file(path, set())
    assert len(events) == 1
    assert events[0].input_tokens == 22
    assert events[0].output_tokens == 3
    assert events[0].model == "claude-opus-5"
    assert events[0].cwd == "/w"


def test_usage_reports_deltas_not_running_totals(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    _write_sidecar(path, inputTokens=10, outputTokens=3)
    reader = DroidLogReader()
    seen: set[str] = set()
    first = reader.parse_session_file(path, seen)
    assert (first[0].input_tokens, first[0].output_tokens) == (10, 3)

    _write_sidecar(path, inputTokens=25, outputTokens=8)
    second = reader.parse_session_file(path, seen)
    assert (second[0].input_tokens, second[0].output_tokens) == (15, 5)


def test_usage_is_silent_when_nothing_moved(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    _write_sidecar(path, inputTokens=10, outputTokens=3)
    reader = DroidLogReader()
    seen: set[str] = set()
    reader.parse_session_file(path, seen)
    assert reader.parse_session_file(path, seen) == []


def test_a_shrinking_sidecar_rebaselines_instead_of_going_negative(
    sessions_root: Path,
) -> None:
    """A replaced sidecar (fork, reset) is not a token refund."""
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    _write_sidecar(path, inputTokens=100, outputTokens=50)
    reader = DroidLogReader()
    seen: set[str] = set()
    reader.parse_session_file(path, seen)

    _write_sidecar(path, inputTokens=10, outputTokens=5)
    assert reader.parse_session_file(path, seen) == []

    _write_sidecar(path, inputTokens=30, outputTokens=11)
    again = reader.parse_session_file(path, seen)
    assert (again[0].input_tokens, again[0].output_tokens) == (20, 6)


def test_usage_without_a_sidecar_is_empty(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    assert DroidLogReader().parse_session_file(path, set()) == []


def test_usage_survives_a_malformed_sidecar(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    (path.parent / "a.settings.json").write_text("{oops", encoding="utf-8")
    assert DroidLogReader().parse_session_file(path, set()) == []


def test_token_marker_does_not_accumulate(sessions_root: Path) -> None:
    """seen_keys must not grow with the session — see log_readers.base."""
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    reader = DroidLogReader()
    seen: set[str] = set()
    for n in range(1, 6):
        _write_sidecar(path, inputTokens=n * 10, outputTokens=n)
        reader.parse_session_file(path, seen)
    marks = [k for k in seen if k.startswith("droid_tok::")]
    assert len(marks) == 1


# ---- resume ---------------------------------------------------------------

@pytest.mark.parametrize("command,expected", [
    ("droid --resume abc-123", "abc-123"),
    ("droid -r abc-123", "abc-123"),
    ("droid --auto high --resume abc-123", "abc-123"),
    ("droid", ""),
    ("claude --resume abc-123", ""),
])
def test_resume_id_from_command(command: str, expected: str) -> None:
    assert droid.SPEC.resume_id_from_command(command) == expected


def test_resume_id_from_a_wrapped_command() -> None:
    """The frontend wraps agent commands as [shell, '-ilc', '<cmd>']."""
    wrapped = ["/bin/zsh", "-ilc", "droid --resume abc-123"]
    assert droid.SPEC.resume_id_from_command(wrapped) == "abc-123"


def test_session_path_points_at_the_workspace_directory(
    sessions_root: Path,
) -> None:
    got = droid.SPEC.session_path("/w/proj", "abc")
    assert got == sessions_root / "-w-proj" / "abc.jsonl"


def test_session_exists_finds_the_workspace_file(sessions_root: Path) -> None:
    _write_session(sessions_root, "/w/proj", "abc", [_session_start("abc", "/w/proj")])
    assert droid.SPEC.session_exists("/w/proj", "abc") is True
    assert droid.SPEC.session_exists("/w/proj", "nope") is False


def test_session_exists_accepts_a_forked_session(sessions_root: Path) -> None:
    """A fork lands in sessions/btw/ — reporting it missing would discard the
    pane's saved conversation and start a fresh one."""
    btw = sessions_root / "btw"
    btw.mkdir()
    (btw / "forked.jsonl").write_text("", encoding="utf-8")
    assert droid.SPEC.session_exists("/w/proj", "forked") is True


# ---- spec identity --------------------------------------------------------

def test_spec_strips_the_child_session_marker() -> None:
    """Inherited, DROID_PARENT_SESSION_ID makes a fresh pane a child of the
    session that spawned Navide — the droid twin of the CLAUDE_CODE_CHILD_
    SESSION bug."""
    assert "DROID_PARENT_SESSION_ID" in droid.SPEC.home_env_vars
    assert "FACTORY_HOME_OVERRIDE" in droid.SPEC.home_env_vars


def test_reader_binding_flags() -> None:
    assert DroidLogReader.emits_session_sink is True
    assert DroidLogReader.binds_by_marker_file is True
    assert DroidLogReader.binds_new_session_single_candidate is True
