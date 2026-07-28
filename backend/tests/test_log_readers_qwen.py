"""QwenLogReader: usageMetadata mapping + chats/archive layout + attribution."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.claude import encode_claude_cwd
from agent_team_backend.log_readers.base import TokenUsage
from agent_team_backend.log_readers.qwen import QwenLogReader

_SID = "1f0b9d5e-2f4a-4c0e-9b7d-3a5c8e9f0a1b"
_CWD = "/Users/me/proj"


def _rec(rtype: str, uuid: str, cwd: str = _CWD, **extra) -> dict:
    rec = {
        "uuid": uuid,
        "parentUuid": None,
        "sessionId": _SID,
        "timestamp": "2026-07-27T10:00:00.000Z",
        "type": rtype,
        "cwd": cwd,
        "version": "0.21.0",
        "gitBranch": "main",
    }
    rec.update(extra)
    return rec


def _assistant(uuid: str, prompt: int = 100, candidates: int = 20,
               cached: int = 0, thoughts: int = 0,
               model: str = "qwen3-coder-plus", cwd: str = _CWD) -> dict:
    return _rec("assistant", uuid, cwd=cwd, model=model, usageMetadata={
        "promptTokenCount": prompt,
        "candidatesTokenCount": candidates,
        "cachedContentTokenCount": cached,
        "thoughtsTokenCount": thoughts,
        "totalTokenCount": prompt + candidates + thoughts,
    })


def _user(uuid: str, text: str = "hi", subtype: str = "", cwd: str = _CWD) -> dict:
    rec = _rec("user", uuid, cwd=cwd,
               message={"role": "user", "parts": [{"text": text}]})
    if subtype:
        rec["subtype"] = subtype
    return rec


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def fake_qwen_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / ".qwen"
    monkeypatch.setenv("QWEN_RUNTIME_DIR", str(root))
    return root


def _chat_file(root: Path, cwd: str = _CWD, session_id: str = _SID,
               archive: bool = False) -> Path:
    d = root / "projects" / encode_claude_cwd(cwd) / "chats"
    if archive:
        d = d / "archive"
    return d / f"{session_id}.jsonl"


# ─────────────────────────── token parsing ───────────────────────────────────

def test_token_mapping_prompt_input_candidates_plus_thoughts_output(
    fake_qwen_root: Path,
) -> None:
    """input = promptTokenCount (cache already included); output =
    candidatesTokenCount + thoughtsTokenCount."""
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1"),
        _assistant("a1", prompt=1500, candidates=200, cached=900, thoughts=44),
    ])
    events = reader.parse_session_file(f, set())
    assert len(events) == 1
    ev = events[0]
    # cachedContentTokenCount is NOT added again — prompt already includes it.
    assert ev.input_tokens == 1500
    assert ev.output_tokens == 200 + 44
    assert ev.vendor == "qwen"
    assert ev.cwd == _CWD
    assert ev.session_id == _SID
    assert ev.model == "qwen3-coder-plus"
    assert ev.dedup_key == "a1"


def test_reparse_same_file_dedups_by_uuid(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    seen: set[str] = set()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_assistant("a1")])
    assert len(reader.parse_session_file(f, seen)) == 1
    assert reader.parse_session_file(f, seen) == []


def test_zero_usage_and_missing_uuid_skipped(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    no_uuid = _assistant("a1")
    del no_uuid["uuid"]
    _write_jsonl(f, [
        _assistant("a0", prompt=0, candidates=0, thoughts=0),
        no_uuid,
    ])
    assert reader.parse_session_file(f, set()) == []


def test_malformed_lines_do_not_abort(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(
        "{not valid json\n"
        + json.dumps(_assistant("a1", prompt=50, candidates=25)) + "\n"
        + "garbage\n",
        encoding="utf-8",
    )
    events = reader.parse_session_file(f, set())
    assert len(events) == 1
    assert events[0].input_tokens == 50


# ─────────────────────────── layout / discovery ──────────────────────────────

def test_session_files_includes_archive(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    live = _chat_file(fake_qwen_root, session_id="live-1")
    archived = _chat_file(fake_qwen_root, session_id="old-1", archive=True)
    _write_jsonl(live, [_assistant("a1")])
    _write_jsonl(archived, [_assistant("a2")])
    found = reader.session_files()
    assert live in found
    assert archived in found


def test_session_files_for_workspace_scopes_to_encoded_dir(
    fake_qwen_root: Path,
) -> None:
    reader = QwenLogReader()
    f_a = _chat_file(fake_qwen_root, cwd="/proj/a", session_id="sa")
    f_b = _chat_file(fake_qwen_root, cwd="/proj/b", session_id="sb")
    _write_jsonl(f_a, [_assistant("a1", cwd="/proj/a")])
    _write_jsonl(f_b, [_assistant("a2", cwd="/proj/b")])
    only_a = reader.session_files_for_workspace("/proj/a")
    assert f_a in only_a
    assert f_b not in only_a


def test_cwd_from_file_reads_record_cwd(fake_qwen_root: Path) -> None:
    """The cwd comes from the record itself, not from decoding the dir name —
    so a path with '-' or '.' survives round-tripping."""
    reader = QwenLogReader()
    cwd = "/Users/me/my-app.v2"
    f = _chat_file(fake_qwen_root, cwd=cwd)
    _write_jsonl(f, [_user("u1", cwd=cwd), _assistant("a1", cwd=cwd)])
    assert reader.cwd_from_file(f) == cwd


def test_session_id_from_path_only_for_chats_jsonl(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    live = _chat_file(fake_qwen_root, session_id="sid-live")
    archived = _chat_file(fake_qwen_root, session_id="sid-old", archive=True)
    assert reader.session_id_from_path(live) == "sid-live"
    assert reader.session_id_from_path(archived) == "sid-old"
    # Sibling non-session files never coin bogus resume ids.
    lock = live.parent / "sid-live.lock"
    assert reader.session_id_from_path(lock) == ""
    stray = fake_qwen_root / "projects" / "-proj" / "notes.jsonl"
    assert reader.session_id_from_path(stray) == ""


def test_has_session_accepts_live_and_archived_rejects_bogus(
    fake_qwen_root: Path,
) -> None:
    reader = QwenLogReader()
    _write_jsonl(_chat_file(fake_qwen_root, session_id="live-1"), [_assistant("a1")])
    _write_jsonl(
        _chat_file(fake_qwen_root, session_id="old-1", archive=True),
        [_assistant("a2")],
    )
    assert reader.has_session("live-1") is True
    assert reader.has_session("old-1") is True
    assert reader.has_session("") is False
    assert reader.has_session("missing") is False


# ─────────────────────────── incremental parsing ─────────────────────────────

def test_incremental_parse_offset_advances(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_assistant("a1", prompt=100, candidates=50)])
    parsed1 = reader.parse_incremental(f, {})
    assert [(e.input_tokens, e.output_tokens) for e in parsed1.events] == [(100, 50)]
    first_offset = parsed1.checkpoint["offset"]

    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_assistant("a2", prompt=40, candidates=15)) + "\n")
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(40, 15)]
    assert parsed2.checkpoint["offset"] > first_offset


def test_incremental_parse_reads_only_the_tail(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_assistant("a1")])
    parsed1 = reader.parse_incremental(f, {})
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert parsed2.events == []


# ─────────────────────────── activity ────────────────────────────────────────

def test_parse_activity_filters_automated_user_subtypes(
    fake_qwen_root: Path,
) -> None:
    """Real user prompts and assistant records are activity; automated user
    records (mid_turn_user_message / cron / notification) are not. Qwen logs
    carry no end-of-turn signal, so no turn_complete is ever emitted."""
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1", "do the thing"),
        _assistant("a1"),
        _user("u2", subtype="mid_turn_user_message"),
        _user("u3", subtype="cron"),
        _user("u4", subtype="notification"),
        _rec("system", "s1", subtype="ui_telemetry"),
    ])
    events = reader.parse_activity(f, set())
    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"),
        ("agent_active", "assistant"),
    ]


def test_parse_activity_reparse_does_not_reemit(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    seen: set[str] = set()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_user("u1"), _assistant("a1")])
    assert len(reader.parse_activity(f, seen)) == 2
    assert reader.parse_activity(f, seen) == []


# ─────────────────────────── attribution binding ─────────────────────────────

def _usage(session_id: str, file_path: Path, cwd: str = "/ws") -> TokenUsage:
    """Shape of the session-sink probe usage (_on_session_file)."""
    return TokenUsage(
        vendor="qwen", input_tokens=0, output_tokens=0, cwd=cwd,
        session_id=session_id, file_path=str(file_path), dedup_key="",
    )


@pytest.fixture
def qwen_attr(fake_qwen_root: Path, tmp_path: Path) -> tuple[Attribution, Path]:
    attr = Attribution([QwenLogReader()], workspaces_path=tmp_path / "ws.json")
    return attr, fake_qwen_root


def test_marker_in_user_text_binds_pane(qwen_attr: tuple[Attribution, Path]) -> None:
    """Qwen preserves user text verbatim, so the kickoff's at-pane marker lands
    in the session jsonl; marker matching resolves the pane even with multiple
    candidates, and the resume id is the file stem `qwen --resume` accepts."""
    attr, root = qwen_attr
    attr.register_pane("p1", vendor="qwen", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="qwen", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f = _chat_file(root, cwd="/ws", session_id="sess-two")
    _write_jsonl(f, [_user("u1", "hi <!-- agent-team-session: at-pane:p2 -->")])

    binding = attr.maybe_announce_session(_usage("sess-two", f))
    assert binding is not None
    assert binding.pane_id == "p2"
    assert binding.resume_id == "sess-two"
    assert binding.workspace_path == "/ws"


def test_single_candidate_fallback_binds_without_marker(
    qwen_attr: tuple[Attribution, Path],
) -> None:
    """A lone fresh pane still captures its new session file when the marker
    injection lost the startup timing race."""
    attr, root = qwen_attr
    attr.register_pane("p1", vendor="qwen", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    f = _chat_file(root, cwd="/ws", session_id="sess-new")
    _write_jsonl(f, [_user("u1", "no marker here")])

    binding = attr.maybe_announce_session(_usage("sess-new", f))
    assert binding is not None
    assert binding.pane_id == "p1"
    assert binding.resume_id == "sess-new"
    # Announce-once: a later watcher event for the same session is silent.
    assert attr.maybe_announce_session(_usage("sess-new", f)) is None


def test_fallback_ignores_baseline_sessions(
    qwen_attr: tuple[Attribution, Path],
) -> None:
    """A session file that predates the pane's spawn is another conversation —
    never fallback-bind it."""
    attr, root = qwen_attr
    f = _chat_file(root, cwd="/ws", session_id="sess-old")
    _write_jsonl(f, [_user("u1")])
    attr.register_pane("p1", vendor="qwen", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    assert attr.maybe_announce_session(_usage("sess-old", f)) is None


def test_workspace_attribution_via_record_cwd(
    qwen_attr: tuple[Attribution, Path],
) -> None:
    """Token events attribute to the registered workspace by usage.cwd
    equality (the reader emits the record's exact cwd)."""
    attr, root = qwen_attr
    attr.register_workspace("/ws")
    f = _chat_file(root, cwd="/ws", session_id="sess-x")
    _write_jsonl(f, [_assistant("a1", cwd="/ws")])
    reader = QwenLogReader()
    usage = reader.parse_session_file(f, set())[0]
    assert attr.attribute(usage).workspace_path == "/ws"
    # An event from an unregistered cwd is dropped by the sink layer.
    f2 = _chat_file(root, cwd="/elsewhere", session_id="sess-y")
    _write_jsonl(f2, [_assistant("a2", cwd="/elsewhere")])
    usage2 = reader.parse_session_file(f2, set())[0]
    assert attr.attribute(usage2).workspace_path is None
