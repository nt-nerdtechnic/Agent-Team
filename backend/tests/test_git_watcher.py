"""GitWatcher: noise filtering + debounced on_change(ws_path) on disk changes."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent_team_backend.git_watcher import GitWatcher, _RepoHandler


def _handler(root: Path) -> _RepoHandler:
    return _RepoHandler(root.resolve(), str(root), lambda _ws: None)


def test_working_tree_file_is_relevant(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    assert h._is_relevant(str(tmp_path / "src" / "main.py")) is True


def test_is_plan_doc_covers_all_supported_dirs(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    valid_paths = [
        ".agent-team/plans/feature.html",
        ".agent-team/plans/legacy.plan.md",
        ".agent-team/reports/summary.html",
        ".agent-team/reports/notes.md",
        ".claude/loop-reports/loop1.html",
        ".claude/plans/task.md",
        ".cursor/plans/arch.plan.md",
        "docs/plans/roadmap.md",
        "docs/reports/analysis.html",
    ]
    for p in valid_paths:
        assert h._is_plan_doc(str(tmp_path / p)) is True, p

    invalid_paths = [
        ".agent-team/plans/_spec.md",       # infra file
        ".agent-team/plans/.hidden.md",     # dot file
        ".agent-team/other/doc.md",         # unsupported sub-dir
        "other/plans/doc.md",               # root dir not in allowed list
        ".agent-team/plans/sub/deep.md",    # nested sub-dir
    ]
    for p in invalid_paths:
        assert h._is_plan_doc(str(tmp_path / p)) is False, p


def test_build_dirs_are_ignored(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    for noise in ("node_modules/x/y.js", ".venv/lib/z.py", "dist/bundle.js",
                  "__pycache__/m.pyc"):
        assert h._is_relevant(str(tmp_path / noise)) is False, noise


def test_laravel_storage_churn_is_scoped(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    for noise in ("storage/framework/sessions/abc", "storage/logs/laravel.log"):
        assert h._is_relevant(str(tmp_path / noise)) is False, noise
    # Other storage/ content (e.g. tracked uploads) must still be reported —
    # the scoping must not swallow a whole "storage" dir in unrelated projects.
    assert h._is_relevant(str(tmp_path / "storage" / "app" / "upload.jpg")) is True


def test_git_state_files_are_relevant(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    for state in (".git/index", ".git/HEAD", ".git/MERGE_HEAD",
                  ".git/refs/heads/main", ".git/packed-refs"):
        assert h._is_relevant(str(tmp_path / state)) is True, state


def test_git_internal_churn_is_ignored(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    for churn in (".git/index.lock", ".git/objects/ab/cdef",
                  ".git/logs/HEAD", ".git/refs/heads/main.lock"):
        assert h._is_relevant(str(tmp_path / churn)) is False, churn


@pytest.mark.asyncio
async def test_on_change_fires_debounced_on_file_write(tmp_path: Path) -> None:
    fired: list[str] = []

    async def sink(ws: str) -> None:
        fired.append(ws)

    watcher = GitWatcher(sink, debounce_s=0.1)
    watcher.start()
    try:
        watcher.watch(str(tmp_path))
        # Burst of writes should coalesce into a single on_change call.
        for i in range(5):
            (tmp_path / f"f{i}.txt").write_text("x")
        await asyncio.sleep(0.5)
        assert fired == [str(tmp_path)]
    finally:
        watcher.stop()


@pytest.mark.asyncio
async def test_noise_write_does_not_fire(tmp_path: Path) -> None:
    fired: list[str] = []

    async def sink(ws: str) -> None:
        fired.append(ws)

    watcher = GitWatcher(sink, debounce_s=0.1)
    watcher.start()
    try:
        watcher.watch(str(tmp_path))
        nm = tmp_path / "node_modules" / "pkg"; nm.mkdir(parents=True)
        (nm / "index.js").write_text("x")
        await asyncio.sleep(0.4)
        assert fired == []
    finally:
        watcher.stop()
