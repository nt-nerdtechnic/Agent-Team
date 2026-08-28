"""Full-session backfill of the live "THIS SESSION" tally.

The live tally is process-lifetime only, so after a backend restart a resumed
CLI session showed 0 while the CLI's own footer showed its whole total. When a
pane binds a known session id we re-derive that total from the vendor log and
fold it in — WITHOUT going through record(), whose dedup/checkpoint machinery
already accounted for those events in cumulative/global.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from agent_team_backend import app
from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.tokens_store import TokensStore


@pytest.fixture
def store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "global-tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
    )


@pytest.fixture
def workspace(tmp_path: Path) -> str:
    ws = tmp_path / "ws"
    ws.mkdir()
    return str(ws)


# ── TokensStore.seed_live ────────────────────────────────────────────────


def test_seed_live_fills_an_empty_live_bucket(store: TokensStore, workspace: str) -> None:
    already = store.live_seed_state(workspace, "pane-a", "sess-1")
    assert already == {"input": 0, "output": 0, "calls": 0}

    assert store.seed_live(
        workspace, "pane-a", "sess-1",
        {"input": 908039, "output": 825, "calls": 42}, already,
    )
    live = store.snapshot(workspace)["workspace"]["live_by_pane"]
    assert live == {"pane-a::sess-1": {"input": 908039, "output": 825, "calls": 42}}


def test_seed_live_never_touches_cumulative_global_or_checkpoints(
    store: TokensStore, workspace: str, tmp_path: Path
) -> None:
    """The backfilled events are historic — already in the durable tallies."""
    session_file = str(tmp_path / "sess-1.jsonl")
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20, dedup_key="e1",
        ingestion_file=session_file,
        ingestion_checkpoint={"kind": "jsonl", "offset": 100, "identity": "1:2"},
    )
    before = store.snapshot(workspace)
    ckpt_before = store.get_ingestion_checkpoint(session_file, workspace)

    already = store.live_seed_state(workspace, "pane-a", "sess-1")
    store.seed_live(
        workspace, "pane-a", "sess-1",
        {"input": 5000, "output": 400, "calls": 9}, already,
    )
    after = store.snapshot(workspace)

    assert after["workspace"]["cumulative"] == before["workspace"]["cumulative"]
    assert after["global"] == before["global"]
    assert store.get_ingestion_checkpoint(session_file, workspace) == ckpt_before


def test_seed_live_subtracts_what_the_live_bucket_already_held(
    store: TokensStore, workspace: str
) -> None:
    """The scan covers the whole session, including events this process
    already ingested — those must not be counted twice."""
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=100, output_tokens=10, dedup_key="e1",
    )
    already = store.live_seed_state(workspace, "pane-a", "sess-1")
    assert already == {"input": 100, "output": 10, "calls": 1}

    # Whole-session scan: 900 in / 90 out over 9 calls, the last of which is
    # the event above.
    store.seed_live(
        workspace, "pane-a", "sess-1",
        {"input": 900, "output": 90, "calls": 9}, already,
    )
    live = store.snapshot(workspace)["workspace"]["live_by_pane"]
    assert live["pane-a::sess-1"] == {"input": 900, "output": 90, "calls": 9}


def test_seed_live_keeps_increments_that_landed_during_the_scan(
    store: TokensStore, workspace: str
) -> None:
    """record() keeps feeding the bucket while the (slow) scan runs; applying
    the seed as a delta rather than an overwrite preserves those."""
    already = store.live_seed_state(workspace, "pane-a", "sess-1")

    # ... scan is running; a new turn is ingested meanwhile ...
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=7, output_tokens=3, dedup_key="fresh",
    )

    store.seed_live(
        workspace, "pane-a", "sess-1",
        {"input": 900, "output": 90, "calls": 9}, already,
    )
    live = store.snapshot(workspace)["workspace"]["live_by_pane"]
    assert live["pane-a::sess-1"] == {"input": 907, "output": 93, "calls": 10}


def test_seed_live_is_one_shot_per_pane_and_session(
    store: TokensStore, workspace: str
) -> None:
    total = {"input": 900, "output": 90, "calls": 9}
    assert store.seed_live(workspace, "pane-a", "sess-1", total, None)
    assert store.live_seed_state(workspace, "pane-a", "sess-1") is None
    assert not store.seed_live(workspace, "pane-a", "sess-1", total, None)

    live = store.snapshot(workspace)["workspace"]["live_by_pane"]
    assert live["pane-a::sess-1"] == total

    # A different session on the same pane is a separate one-shot.
    assert store.seed_live(workspace, "pane-a", "sess-2", total, None)


def test_seed_live_marks_clear_when_the_pane_is_forgotten(
    store: TokensStore, workspace: str
) -> None:
    store.seed_live(workspace, "pane-a", "sess-1", {"input": 9, "output": 1, "calls": 1}, None)
    store.forget_pane("pane-a")
    assert store.snapshot(workspace)["workspace"]["live_by_pane"] == {}
    # A pane id reused for a fresh bucket must be able to seed again.
    assert store.live_seed_state(workspace, "pane-a", "sess-1") is not None


def test_seed_live_requires_a_workspace_and_pane(store: TokensStore, workspace: str) -> None:
    total = {"input": 9, "output": 1, "calls": 1}
    assert not store.seed_live("", "pane-a", "sess-1", total, None)
    assert not store.seed_live(workspace, "", "sess-1", total, None)
    assert store.live_seed_state("", "pane-a", "sess-1") is None


# ── LogReader.total_usage_for_session ────────────────────────────────────


def _claude_line(msg_id: str, req: str, inp: int, out: int) -> str:
    return json.dumps({
        "type": "assistant",
        "requestId": req,
        "message": {
            "id": msg_id,
            "model": "claude-opus-5",
            "usage": {"input_tokens": inp, "output_tokens": out,
                      "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        },
    })


def test_total_usage_sums_the_whole_claude_session_file(tmp_path: Path) -> None:
    path = tmp_path / "sess-abc.jsonl"
    path.write_text("\n".join([
        _claude_line("m1", "r1", 100, 10),
        "not json at all",
        _claude_line("m2", "r2", 200, 20),
        json.dumps({"type": "user", "message": {"content": "hi"}}),
        _claude_line("m3", "r3", 300, 30),
    ]) + "\n", encoding="utf-8")

    assert ClaudeLogReader().total_usage_for_session(path, "sess-abc") == {
        "input": 600, "output": 60, "calls": 3,
    }


class _SharedSourceReader(LogReader):
    """Stands in for the vendors whose sessions share one source file/DB."""

    vendor = "shared"

    def project_dirs(self) -> list[Path]:
        return []

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return [
            TokenUsage(vendor="shared", input_tokens=n * 10, output_tokens=n,
                       cwd="", session_id=sid, file_path=str(path), dedup_key=f"k{n}")
            for n, sid in enumerate(["s1", "s2", "s1"], start=1)
        ]


def test_total_usage_filters_a_shared_source_by_session(tmp_path: Path) -> None:
    reader = _SharedSourceReader()
    path = tmp_path / "shared.db"
    assert reader.total_usage_for_session(path, "s1") == {
        "input": 40, "output": 4, "calls": 2,
    }
    assert reader.total_usage_for_session(path, "s2") == {
        "input": 20, "output": 2, "calls": 1,
    }
    # No filter: everything.
    assert reader.total_usage_for_session(path, "")["calls"] == 3


# ── app.schedule_live_token_backfill ─────────────────────────────────────


@pytest.fixture(autouse=True)
def _fast_debounce(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(app, "_TOKENS_BROADCAST_DEBOUNCE_SEC", 0.01)
    app._pending_tokens_broadcast.clear()
    yield
    app._pending_tokens_broadcast.clear()


@pytest.mark.asyncio
async def test_backfill_seeds_and_broadcasts_off_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seeded: list[tuple] = []
    scan_threads: list[str] = []
    import threading

    def fake_scan(vendor, ws, session_id, session_file):
        scan_threads.append(threading.current_thread().name)
        return {"input": 908039, "output": 825, "calls": 42}

    monkeypatch.setattr(app, "_scan_session_total", fake_scan)
    monkeypatch.setattr(
        app.tokens_store, "live_seed_state",
        lambda ws, pane, sid: {"input": 0, "output": 0, "calls": 0},
    )
    monkeypatch.setattr(
        app.tokens_store, "seed_live",
        lambda ws, pane, sid, total, already: seeded.append((ws, pane, sid, total)) or True,
    )
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})

    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        app.schedule_live_token_backfill(
            workspace_path="/ws/a", pane_id="pane-a", bucket_pane_key="pane-a",
            vendor="claude", session_id="sess-1",
        )
        # The call returns immediately — the scan has not even started.
        assert seeded == []
        await asyncio.sleep(0.1)

    assert seeded == [("/ws/a", "pane-a", "sess-1", {"input": 908039, "output": 825, "calls": 42})]
    # The heavy parse ran on the dedicated pool, never on the loop thread.
    assert scan_threads and all(n.startswith("tokens-backfill") for n in scan_threads)
    mock_broadcast.assert_called_once()
    assert mock_broadcast.call_args.args[0]["type"] == "tokens.changed"


@pytest.mark.asyncio
async def test_backfill_skips_without_a_session_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """A brand-new session has nothing to backfill (its total is 0)."""
    calls: list = []
    monkeypatch.setattr(
        app, "_scan_session_total", lambda *a: calls.append(a) or None
    )
    for kwargs in (
        {"workspace_path": "/ws/a", "bucket_pane_key": "pane-a", "session_id": ""},
        {"workspace_path": "", "bucket_pane_key": "pane-a", "session_id": "s1"},
        {"workspace_path": "/ws/a", "bucket_pane_key": "", "session_id": "s1"},
    ):
        app.schedule_live_token_backfill(pane_id="pane-a", vendor="claude", **kwargs)
    await asyncio.sleep(0.05)
    assert calls == []


@pytest.mark.asyncio
async def test_backfill_skips_an_already_seeded_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list = []
    monkeypatch.setattr(app, "_scan_session_total", lambda *a: calls.append(a) or None)
    monkeypatch.setattr(app.tokens_store, "live_seed_state", lambda ws, pane, sid: None)
    app.schedule_live_token_backfill(
        workspace_path="/ws/a", pane_id="pane-a", bucket_pane_key="pane-a",
        vendor="claude", session_id="sess-1",
    )
    await asyncio.sleep(0.05)
    assert calls == []


@pytest.mark.asyncio
async def test_backfill_survives_a_scan_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a):
        raise OSError("log unreadable")

    monkeypatch.setattr(app, "_scan_session_total", boom)
    monkeypatch.setattr(
        app.tokens_store, "live_seed_state", lambda ws, pane, sid: {"input": 0, "output": 0, "calls": 0}
    )
    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        app.schedule_live_token_backfill(
            workspace_path="/ws/a", pane_id="pane-a", bucket_pane_key="pane-a",
            vendor="claude", session_id="sess-1",
        )
        await asyncio.sleep(0.1)
    mock_broadcast.assert_not_called()


def test_scan_locates_the_session_file_by_id(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No file hint (Claude pins its id at spawn): find it by matching ids,
    scoped to the workspace folder when the vendor's layout allows it."""
    wanted = tmp_path / "sess-abc.jsonl"
    wanted.write_text(_claude_line("m1", "r1", 100, 10) + "\n", encoding="utf-8")
    other = tmp_path / "sess-zzz.jsonl"
    other.write_text(_claude_line("m9", "r9", 999, 99) + "\n", encoding="utf-8")

    reader = ClaudeLogReader()
    monkeypatch.setattr(
        reader, "session_files_for_workspace", lambda ws: [other, wanted]
    )
    monkeypatch.setattr(app, "_readers", [reader])

    assert app._scan_session_total("claude", str(tmp_path), "sess-abc", "") == {
        "input": 100, "output": 10, "calls": 1,
    }


def test_scan_returns_none_for_an_unknown_vendor_or_missing_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(app, "_readers", [])
    assert app._scan_session_total("nope", str(tmp_path), "s1", "") is None

    reader = ClaudeLogReader()
    monkeypatch.setattr(reader, "session_files_for_workspace", lambda ws: [])
    monkeypatch.setattr(app, "_readers", [reader])
    assert app._scan_session_total("claude", str(tmp_path), "s1", "") is None
