"""LogWatcher session_sink: fires for Codex/Antigravity session files so
session-id capture (resume-on-restart) works independent of token parsing."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.log_readers.watcher import LogWatcher


class _Reader(LogReader):
    def __init__(self, vendor: str, root: Path) -> None:
        self.vendor = vendor
        # Migrated vendors advertise capabilities on the reader; stubs
        # mirror the real flags so bridge behavior matches production.
        from agent_team_backend.cli_vendors.registry import vendor as _v
        spec = _v(vendor)
        if spec is not None and spec.make_log_reader is not None:
            real = spec.make_log_reader()
            self.binds_by_marker_file = real.binds_by_marker_file
            self.binds_shared_db_by_marker = real.binds_shared_db_by_marker
            self.binds_new_session_single_candidate = real.binds_new_session_single_candidate
            self.emits_session_sink = real.emits_session_sink
            # Behavioral hooks too — the pure-args ones a stub can borrow
            # from the real reader without sharing its state.
            self.workspace_match = real.workspace_match
            self.pane_cwd_match = real.pane_cwd_match
        self.root = root

    def project_dirs(self) -> list[Path]:
        return [self.root]

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return []


@pytest.mark.asyncio
async def test_session_sink_fires_for_codex(tmp_path: Path) -> None:
    root = tmp_path / "codex"; root.mkdir()
    seen: list[tuple[str, str]] = []

    async def sink(vendor: str, path: Path) -> None:
        seen.append((vendor, path.name))

    watcher = LogWatcher(sink=_noop, session_sink=sink, seen_path=tmp_path / "seen.json")
    watcher.add_reader(_Reader("codex", root))
    f = root / "rollout.jsonl"; f.write_text("{}")
    await watcher._process_path(f)  # noqa: SLF001 — exercise the routing directly
    assert seen == [("codex", "rollout.jsonl")]


@pytest.mark.asyncio
async def test_session_sink_fires_for_antigravity(tmp_path: Path) -> None:
    root = tmp_path / "antigravity"; root.mkdir()
    seen: list[tuple[str, str]] = []

    async def sink(vendor: str, path: Path) -> None:
        seen.append((vendor, path.name))

    watcher = LogWatcher(sink=_noop, session_sink=sink, seen_path=tmp_path / "seen.json")
    watcher.add_reader(_Reader("antigravity", root))
    f = root / "session.db"; f.write_text("")
    await watcher._process_path(f)  # noqa: SLF001
    assert seen == [("antigravity", "session.db")]


@pytest.mark.asyncio
async def test_session_sink_not_fired_for_claude(tmp_path: Path) -> None:
    root = tmp_path / "claude"; root.mkdir()
    seen: list[tuple[str, str]] = []

    async def sink(vendor: str, path: Path) -> None:
        seen.append((vendor, path.name))

    watcher = LogWatcher(sink=_noop, session_sink=sink, seen_path=tmp_path / "seen.json")
    watcher.add_reader(_Reader("claude", root))
    f = root / "s.jsonl"; f.write_text("{}")
    await watcher._process_path(f)  # noqa: SLF001
    assert seen == []  # Claude uses --session-id; no marker capture needed


async def _noop(_usage: TokenUsage) -> None:
    return None
