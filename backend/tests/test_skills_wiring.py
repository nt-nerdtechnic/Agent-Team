from __future__ import annotations

import shlex
from pathlib import Path

import pytest

from agent_team_backend.plugins.builtin.navide_skills import skills_wiring


def _skill(root: Path, name: str) -> Path:
    path = root / name
    path.mkdir(parents=True)
    return path


def test_prepare_claude_add_dir_uses_documented_project_skill_layout(
    tmp_path: Path,
) -> None:
    native = tmp_path / "native"
    managed = tmp_path / "managed"
    _skill(native, "same")
    _skill(managed, "managed")
    _skill(managed, "same")
    add_dir = tmp_path / "claude-add-dir"

    result = skills_wiring.prepare_claude_add_dir(
        managed_root=managed,
        native_root=native,
        add_dir_root=add_dir,
    )

    assert result == add_dir
    projected = add_dir / ".claude" / "skills"
    assert sorted(path.name for path in projected.iterdir()) == ["managed"]
    assert (projected / "managed").resolve() == (managed / "managed").resolve()


def test_prepare_claude_add_dir_reserves_native_regular_file_names(
    tmp_path: Path,
) -> None:
    native = tmp_path / "native"
    native.mkdir()
    (native / "same").write_text("reserved", encoding="utf-8")
    managed = tmp_path / "managed"
    _skill(managed, "same")
    add_dir = tmp_path / "claude-add-dir"

    result = skills_wiring.prepare_claude_add_dir(
        managed_root=managed,
        native_root=native,
        add_dir_root=add_dir,
    )

    assert result is None
    assert list((add_dir / ".claude" / "skills").iterdir()) == []


def test_prepare_claude_add_dir_returns_none_and_clears_disabled_view(
    tmp_path: Path,
) -> None:
    managed = tmp_path / "managed"
    _skill(managed, "enabled")
    add_dir = tmp_path / "claude-add-dir"
    assert skills_wiring.prepare_claude_add_dir(
        managed_root=managed, native_root=tmp_path / "native", add_dir_root=add_dir
    ) == add_dir

    (managed / "enabled").rmdir()
    assert skills_wiring.prepare_claude_add_dir(
        managed_root=managed, native_root=tmp_path / "native", add_dir_root=add_dir
    ) is None

    assert list((add_dir / ".claude" / "skills").iterdir()) == []


def test_wire_command_is_idempotent_and_preserves_shell_wrapper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_dir = tmp_path / "dir with spaces"
    monkeypatch.setattr(skills_wiring, "prepare_claude_add_dir", lambda: add_dir)
    command = ["/bin/zsh", "-ilc", "claude resume abc"]

    once = skills_wiring.wire_command("claude", command, None)
    twice = skills_wiring.wire_command("claude", once, None)

    assert once[:-1] == command[:-1]
    assert once[-1] == f"claude resume abc --add-dir {shlex.quote(str(add_dir))}"
    assert twice == once


@pytest.mark.parametrize("agent_key", ["codex", "kimi", "grok", "opencode", "terminal"])
def test_wire_command_noops_for_unsupported_agents(
    agent_key: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail_if_called():
        raise AssertionError("Claude projection should not be prepared")

    monkeypatch.setattr(skills_wiring, "prepare_claude_add_dir", fail_if_called)
    command = ["/bin/zsh", "-ilc", agent_key]

    assert skills_wiring.wire_command(agent_key, command, None) is command


def test_wire_command_failure_does_not_block_spawn(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail():
        raise OSError("disk unavailable")

    monkeypatch.setattr(skills_wiring, "prepare_claude_add_dir", fail)

    assert skills_wiring.wire_command("claude", "claude", None) == "claude"
