"""CopilotLogReader: cumulative modelMetrics deltas + workspace.yaml cwd
+ dir-name session id + has_session + incremental + attribution binding.

Fixture event shapes were captured live against copilot-cli 1.0.75.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import TokenUsage
from agent_team_backend.log_readers.copilot import (
    CopilotLogReader,
    _metrics_totals,
    copilot_root,
)

_SID = "e6495800-dfd4-4a75-b2ab-d70980f83b89"
_CWD = "/Users/me/proj"
_TS = "2026-07-27T18:34:04.138Z"


def _event(etype: str, data: dict, eid: str = "ev-1", ts: str = _TS) -> dict:
    """One events.jsonl line: {type, data, id, timestamp, parentId}."""
    return {"type": etype, "data": data, "id": eid, "timestamp": ts,
            "parentId": None}


def _session_start(cwd: str = _CWD, sid: str = _SID) -> dict:
    return _event("session.start", {
        "sessionId": sid, "version": 1, "copilotVersion": "1.0.75",
        "context": {"cwd": cwd},
    }, eid="ev-start")


def _user(content: str = "hi", eid: str = "ev-user") -> dict:
    return _event("user.message", {
        "content": content,
        "transformedContent": f"<current_datetime>t</current_datetime>\n\n{content}",
        "attachments": [],
    }, eid=eid)


def _assistant(content: str = "ok", eid: str = "ev-asst") -> dict:
    return _event("assistant.message", {
        "messageId": "m-1", "model": "claude-haiku-4.5", "content": content,
        "toolRequests": [], "outputTokens": 39,
    }, eid=eid)


def _buckets(input: int, cache_read: int, cache_write: int, output: int) -> dict:  # noqa: A002
    return {
        "input": {"tokenCount": input},
        "cache_read": {"tokenCount": cache_read},
        "cache_write": {"tokenCount": cache_write},
        "output": {"tokenCount": output},
    }


def _shutdown(*, model: str = "claude-haiku-4.5", input: int = 9,  # noqa: A002
              cache_read: int = 0, cache_write: int = 19889, output: int = 39,
              reasoning: int = 20, extra_models: dict | None = None,
              eid: str = "ev-shutdown") -> dict:
    """session.shutdown as captured: modelMetrics.<model>.usage.inputTokens
    ALREADY includes cache read+write; outputTokens already includes
    reasoning; top-level tokenDetails carries the same split buckets."""
    metrics = {
        model: {
            "requests": {"count": 1, "cost": 0.33},
            "usage": {
                "inputTokens": input + cache_read + cache_write,
                "outputTokens": output,
                "cacheReadTokens": cache_read,
                "cacheWriteTokens": cache_write,
                "reasoningTokens": reasoning,
            },
            "tokenDetails": _buckets(input, cache_read, cache_write, output),
        },
    }
    metrics.update(extra_models or {})
    return _event("session.shutdown", {
        "shutdownType": "routine",
        "tokenDetails": _buckets(input, cache_read, cache_write, output),
        "modelMetrics": metrics,
        "currentModel": model,
    }, eid=eid)


def _write_session(root: Path, sid: str = _SID, cwd: str = _CWD,
                   events: list[dict] | None = None) -> Path:
    d = root / "session-state" / sid
    d.mkdir(parents=True, exist_ok=True)
    (d / "workspace.yaml").write_text(
        f"id: {sid}\ncwd: {cwd}\nclient_name: github/cli\n"
        "name: 'Reply with the single word: ok'\nuser_named: false\n",
        encoding="utf-8",
    )
    f = d / "events.jsonl"
    with f.open("w", encoding="utf-8") as fh:
        for rec in events or []:
            fh.write(json.dumps(rec) + "\n")
    return f


def _append(path: Path, records: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


@pytest.fixture
def fake_copilot_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "copilot-home"
    monkeypatch.setenv("COPILOT_HOME", str(root))
    return root


# ─────────────────────────── root / layout ───────────────────────────────────

def test_root_env_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COPILOT_HOME", "/tmp/cop")
    assert copilot_root() == Path("/tmp/cop")
    monkeypatch.delenv("COPILOT_HOME")
    assert copilot_root() == Path.home() / ".copilot"


def test_missing_root_and_files_are_tolerated(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    ghost = fake_copilot_root / "session-state" / "ghost" / "events.jsonl"
    assert reader.project_dirs() == []
    assert reader.session_files() == []
    assert reader.session_files_for_workspace(_CWD) == []
    assert reader.has_session("ghost") is False
    assert reader.parse_session_file(ghost, set()) == []
    assert reader.parse_activity(ghost, set()) == []
    assert reader.cwd_from_file(ghost) == ""


def test_session_files_and_workspace_scoping(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    f_a = _write_session(fake_copilot_root, sid="sid-a", cwd="/proj/a")
    f_b = _write_session(fake_copilot_root, sid="sid-b", cwd="/proj/b")
    found = reader.session_files()
    assert f_a in found and f_b in found
    only_a = reader.session_files_for_workspace("/proj/a")
    assert f_a in only_a
    assert f_b not in only_a


def test_session_id_is_dir_name_and_siblings_are_ignored(
    fake_copilot_root: Path,
) -> None:
    """Id = the session dir name (`copilot --resume=<id>`); sibling files
    (session.db, workspace.yaml) must never coin bogus resume ids."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root)
    assert reader.session_id_from_path(f) == _SID
    assert reader.session_id_from_path(f.parent / "session.db") == ""
    assert reader.session_id_from_path(f.parent / "workspace.yaml") == ""
    stray = fake_copilot_root / "session-state" / "events.jsonl"
    assert reader.session_id_from_path(stray) == ""


def test_cwd_from_workspace_yaml(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, cwd="/Users/x/my proj")
    assert reader.cwd_from_file(f) == "/Users/x/my proj"


def test_has_session_checks_events_file(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    _write_session(fake_copilot_root, sid="sid-live")
    assert reader.has_session("sid-live") is True
    assert reader.has_session("missing") is False
    assert reader.has_session("") is False
    assert reader.has_session("../session-state") is False


# ─────────────────────────── token parsing ───────────────────────────────────

def test_token_mapping_from_model_metrics(fake_copilot_root: Path) -> None:
    """inputTokens already folds cache read+write, outputTokens already folds
    reasoning — the buckets pass straight through into TokenUsage."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _session_start(), _user(), _assistant(),
        _shutdown(input=9, cache_read=0, cache_write=19889, output=39),
    ])
    events = reader.parse_session_file(f, set())
    assert len(events) == 1
    ev = events[0]
    assert ev.vendor == "copilot"
    assert ev.input_tokens == 9 + 19889
    assert ev.output_tokens == 39
    assert ev.cwd == _CWD
    assert ev.session_id == _SID
    assert ev.model == "claude-haiku-4.5"
    assert ev.timestamp == _TS


def test_token_totals_sum_across_models(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    extra = {
        "gpt-5": {
            "usage": {"inputTokens": 100, "outputTokens": 10,
                      "cacheReadTokens": 0, "cacheWriteTokens": 0,
                      "reasoningTokens": 0},
        },
    }
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=9, cache_read=0, cache_write=19889, output=39,
                  extra_models=extra),
    ])
    events = reader.parse_session_file(f, set())
    assert len(events) == 1
    assert events[0].input_tokens == 9 + 19889 + 100
    assert events[0].output_tokens == 39 + 10


def test_cumulative_deltas_and_shrink_reset(fake_copilot_root: Path) -> None:
    """Totals are snapshots: a later, larger snapshot emits only the delta;
    a shrinking snapshot (resumed run restarting its counters) resets the
    baseline silently — never a negative or double count."""
    reader = CopilotLogReader()
    seen: set[str] = set()
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=100, cache_read=0, cache_write=0, output=10,
                  eid="ev-s1"),
    ])
    first = reader.parse_session_file(f, seen)
    assert [(e.input_tokens, e.output_tokens) for e in first] == [(100, 10)]
    # Same file again: no new snapshot → nothing.
    assert reader.parse_session_file(f, seen) == []
    # Larger snapshot → delta only.
    _append(f, [_shutdown(input=160, cache_read=0, cache_write=0, output=25,
                          eid="ev-s2")])
    second = reader.parse_session_file(f, seen)
    assert [(e.input_tokens, e.output_tokens) for e in second] == [(60, 15)]
    # Shrunk snapshot → baseline reset, no event.
    _append(f, [_shutdown(input=30, cache_read=0, cache_write=0, output=5,
                          eid="ev-s3")])
    assert reader.parse_session_file(f, seen) == []
    # Growth from the new baseline emits again.
    _append(f, [_shutdown(input=50, cache_read=0, cache_write=0, output=9,
                          eid="ev-s4")])
    third = reader.parse_session_file(f, seen)
    assert [(e.input_tokens, e.output_tokens) for e in third] == [(20, 4)]


def test_token_details_fallback_without_model_metrics(
    fake_copilot_root: Path,
) -> None:
    """A metrics event without modelMetrics still counts via its top-level
    tokenDetails buckets (cache read+write folded into input)."""
    reader = CopilotLogReader()
    rec = _event("session.compaction_complete", {
        "tokenDetails": _buckets(50, 200, 30, 7),
    }, eid="ev-comp")
    f = _write_session(fake_copilot_root, events=[rec])
    events = reader.parse_session_file(f, set())
    assert [(e.input_tokens, e.output_tokens) for e in events] == [
        (50 + 200 + 30, 7),
    ]


def test_usageless_model_buckets_are_not_zero_totals() -> None:
    """modelMetrics entries carrying no usage dict are not a "totals are zero"
    reading — fall through to tokenDetails, else report no totals at all."""
    assert _metrics_totals({"modelMetrics": {"gpt-x": {}}}) is None
    assert _metrics_totals({
        "modelMetrics": {"gpt-x": {}},
        "tokenDetails": _buckets(50, 200, 30, 7),
    }) == (50 + 200 + 30, 7)


def test_malformed_and_metricless_lines_skipped(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root)
    with f.open("w", encoding="utf-8") as fh:
        fh.write("{not valid json\n")
        fh.write(json.dumps(_event("session.usage_checkpoint", {
            "totalNanoAiu": 2506525000, "totalPremiumRequests": 0.33,
        }, eid="ev-cp")) + "\n")
        fh.write(json.dumps(_shutdown(input=7, cache_read=0, cache_write=0,
                                      output=3)) + "\n")
    events = reader.parse_session_file(f, set())
    assert [(e.input_tokens, e.output_tokens) for e in events] == [(7, 3)]


# ─────────────────────────── incremental parsing ─────────────────────────────

def test_incremental_parse_offset_advances(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _session_start(), _user(), _assistant(),
        _shutdown(input=100, cache_read=0, cache_write=0, output=50,
                  eid="ev-s1"),
    ])
    parsed1 = reader.parse_incremental(f, {})
    assert [(e.input_tokens, e.output_tokens) for e in parsed1.events] == [(100, 50)]
    assert parsed1.events[0].session_id == _SID
    assert parsed1.events[0].cwd == _CWD
    first_offset = parsed1.checkpoint["offset"]

    _append(f, [_shutdown(input=140, cache_read=0, cache_write=0, output=65,
                          eid="ev-s2")])
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(40, 15)]
    assert parsed2.checkpoint["offset"] > first_offset
    # Tail-only: nothing new → nothing emitted.
    assert reader.parse_incremental(f, parsed2.checkpoint).events == []


def test_incremental_replacement_resets_baseline(fake_copilot_root: Path) -> None:
    """A replaced file (new inode) is a new generation — the persisted totals
    baseline resets so the re-read never produces a bogus delta."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=100, cache_read=0, cache_write=0, output=50,
                  eid="ev-s1"),
    ])
    parsed1 = reader.parse_incremental(f, {})
    assert len(parsed1.events) == 1

    tmp = f.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(json.dumps(_shutdown(input=100, cache_read=0, cache_write=0,
                                      output=50, eid="ev-s1")) + "\n")
        fh.write(json.dumps(_shutdown(input=130, cache_read=0, cache_write=0,
                                      output=58, eid="ev-s2")) + "\n")
    os.replace(tmp, f)
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(130, 58)]


def test_incremental_dip_never_lowers_the_baseline(
    fake_copilot_root: Path,
) -> None:
    """Cumulative snapshots can blip downward; the persisted baseline is a
    high-water mark, so the dip emits nothing AND the following rise emits
    only what is genuinely new (total credited == the true total)."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=100000, cache_read=0, cache_write=0, output=10000,
                  eid="ev-s1"),
    ])
    p1 = reader.parse_incremental(f, {})
    _append(f, [_shutdown(input=30000, cache_read=0, cache_write=0,
                          output=3000, eid="ev-s2")])
    p2 = reader.parse_incremental(f, p1.checkpoint)
    _append(f, [_shutdown(input=250000, cache_read=0, cache_write=0,
                          output=25000, eid="ev-s3")])
    p3 = reader.parse_incremental(f, p2.checkpoint)

    emitted = p1.events + p2.events + p3.events
    assert sum(e.input_tokens for e in emitted) == 250000
    assert sum(e.output_tokens for e in emitted) == 25000


# ─────────────────────────── activity ────────────────────────────────────────

def test_parse_activity_messages_tools_and_turn_end(
    fake_copilot_root: Path,
) -> None:
    """user/assistant messages and tool executions are agent_active;
    assistant.turn_end is the explicit turn_complete boundary and carries
    the turn's last assistant text."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _session_start(),
        _user("do the thing"),
        _event("tool.execution_start", {"toolName": "bash"}, eid="ev-t1"),
        _event("tool.execution_complete", {"toolName": "bash"}, eid="ev-t2"),
        _assistant("all done"),
        _event("assistant.turn_end", {"turnId": "0"}, eid="ev-te"),
    ])
    events = reader.parse_activity(f, set())
    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"),
        ("agent_active", "tool.execution_start"),
        ("agent_active", "tool.execution_complete"),
        ("agent_active", "assistant"),
        ("turn_complete", "turn_end"),
    ]
    assert events[-1].text == "all done"
    assert all(e.session_id == _SID and e.cwd == _CWD for e in events)


def test_parse_activity_reparse_does_not_reemit(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    seen: set[str] = set()
    f = _write_session(fake_copilot_root, events=[
        _user(), _assistant(),
        _event("assistant.turn_end", {"turnId": "0"}, eid="ev-te"),
    ])
    assert len(reader.parse_activity(f, seen)) == 3
    assert reader.parse_activity(f, seen) == []


def test_turn_text_survives_split_poll_batches(fake_copilot_root: Path) -> None:
    """An assistant.message and its turn_end can land in different polls —
    the text is stashed in seen_keys so turn_complete still carries it."""
    reader = CopilotLogReader()
    seen: set[str] = set()
    f = _write_session(fake_copilot_root, events=[_assistant("answer text")])
    reader.parse_activity(f, seen)
    _append(f, [_event("assistant.turn_end", {"turnId": "0"}, eid="ev-te")])
    events = reader.parse_activity(f, seen)
    assert [(e.event_type, e.text) for e in events] == [
        ("turn_complete", "answer text"),
    ]


def test_truncated_trailing_line_is_retried_once_complete(
    fake_copilot_root: Path,
) -> None:
    """Text iteration yields a still-being-written trailing line; marking it
    seen would drop the assistant.turn_end forever and stall /loop."""
    reader = CopilotLogReader()
    seen: set[str] = set()
    f = _write_session(fake_copilot_root, events=[])
    raw = json.dumps(_event("assistant.turn_end", {"turnId": "0"}, eid="ev-te"))
    f.write_text(raw[:20], encoding="utf-8")
    assert reader.parse_activity(f, seen) == []

    f.write_text(raw + "\n", encoding="utf-8")
    events = reader.parse_activity(f, seen)
    assert [(e.event_type, e.detail) for e in events] == [
        ("turn_complete", "turn_end"),
    ]


# ─────────────────────────── attribution binding ─────────────────────────────

def _usage(session_id: str, file_path: Path, cwd: str = "/ws") -> TokenUsage:
    """Shape of the session-sink probe usage (_on_session_file)."""
    return TokenUsage(
        vendor="copilot", input_tokens=0, output_tokens=0, cwd=cwd,
        session_id=session_id, file_path=str(file_path), dedup_key="",
    )


@pytest.fixture
def copilot_attr(fake_copilot_root: Path, tmp_path: Path) -> tuple[Attribution, Path]:
    attr = Attribution([CopilotLogReader()], workspaces_path=tmp_path / "ws.json")
    return attr, fake_copilot_root


def test_marker_in_user_message_binds_pane(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """Copilot preserves user text verbatim in user.message data.content, so
    the kickoff's at-pane marker lands in events.jsonl; marker matching
    resolves the pane even with multiple candidates, and the resume id is
    the session dir name `copilot --resume=<id>` accepts."""
    attr, root = copilot_attr
    attr.register_pane("p1", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f = _write_session(root, sid="sess-two", cwd="/ws", events=[
        _session_start(cwd="/ws", sid="sess-two"),
        _user("hi <!-- agent-team-session: at-pane:p2 -->"),
    ])

    binding = attr.maybe_announce_session(_usage("sess-two", f))
    assert binding is not None
    assert binding.pane_id == "p2"
    assert binding.resume_id == "sess-two"
    assert binding.workspace_path == "/ws"


def test_single_candidate_fallback_binds_without_marker(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """A lone fresh pane still captures its new session when the marker is
    absent (e.g. the injection lost the startup timing race)."""
    attr, root = copilot_attr
    attr.register_pane("p1", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    f = _write_session(root, sid="sess-new", cwd="/ws", events=[
        _session_start(cwd="/ws", sid="sess-new"), _user("no marker"),
    ])

    binding = attr.maybe_announce_session(_usage("sess-new", f))
    assert binding is not None
    assert binding.pane_id == "p1"
    assert binding.resume_id == "sess-new"
    # Announce-once: a later watcher event for the same session is silent.
    assert attr.maybe_announce_session(_usage("sess-new", f)) is None


def test_fallback_ignores_baseline_sessions(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """A session that predates the pane's spawn is another conversation —
    never fallback-bind it."""
    attr, root = copilot_attr
    f = _write_session(root, sid="sess-old", cwd="/ws", events=[
        _session_start(cwd="/ws", sid="sess-old"), _user(),
    ])
    attr.register_pane("p1", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    assert attr.maybe_announce_session(_usage("sess-old", f)) is None


def test_workspace_attribution_via_workspace_yaml_cwd(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """Token events attribute to the registered workspace by usage.cwd
    equality (the reader emits the workspace.yaml cwd)."""
    attr, root = copilot_attr
    attr.register_workspace("/ws")
    reader = CopilotLogReader()
    f = _write_session(root, sid="sess-x", cwd="/ws", events=[
        _shutdown(input=5, cache_read=0, cache_write=0, output=2),
    ])
    usage = reader.parse_session_file(f, set())[0]
    assert attr.attribute(usage).workspace_path == "/ws"
    # An event from an unregistered cwd is dropped by the sink layer.
    f2 = _write_session(root, sid="sess-y", cwd="/elsewhere", events=[
        _shutdown(input=5, cache_read=0, cache_write=0, output=2),
    ])
    usage2 = reader.parse_session_file(f2, set())[0]
    assert attr.attribute(usage2).workspace_path is None
