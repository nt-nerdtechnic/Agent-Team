"""Expose enabled app-managed skills to Claude Code at pane spawn time.

Claude Code's ``--add-dir`` adds another project directory. Skills belonging
to that directory are discovered below ``.claude/skills``, so this module
materializes exactly that layout and appends the additive flag. Native
``~/.claude/skills`` entries are not copied; matching managed names are
excluded so the native skill remains authoritative.
"""

from __future__ import annotations

import logging
import os
import shlex
import shutil
import tempfile
from pathlib import Path
from typing import Any

from agent_team_backend.applog import app_data_dir
from agent_team_backend.skills_store import SkillsStore

log = logging.getLogger("agent_team_backend.plugins.builtin.navide_skills.skills_wiring")


def claude_add_dir_root() -> Path:
    return app_data_dir() / "runtime" / "claude-managed-skills"


def prepare_claude_add_dir(
    *,
    managed_root: Path | None = None,
    native_root: Path | None = None,
    add_dir_root: Path | None = None,
) -> Path | None:
    """Build a native-collision-free ``<root>/.claude/skills`` view.

    With the default managed root, refresh the SkillsStore projection first so
    external edits and enable changes are reflected. Returns ``None`` when no
    managed skill remains visible or when preparation fails.
    """
    try:
        if managed_root is None:
            store = SkillsStore()
            managed_root = store.rebuild_runtime_projection()
        native_root = native_root or (Path.home() / ".claude" / "skills")
        add_dir_root = add_dir_root or claude_add_dir_root()
        native_names = _directory_names(native_root)
        managed = [
            entry
            for entry in sorted(managed_root.iterdir(), key=lambda path: path.name)
            if (entry.is_dir() or entry.is_symlink()) and entry.name not in native_names
        ] if managed_root.is_dir() else []
        _replace_claude_view(add_dir_root, managed)
        return add_dir_root if managed else None
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Claude managed-skills view failed: %s", err)
        return None


def wire_command(agent_key: str, command: Any, _port: int | None) -> Any:
    """Append one idempotent Claude ``--add-dir`` flag; all other agents no-op."""
    if agent_key != "claude":
        return command
    text = _command_text(command)
    if not text.strip():
        return command
    try:
        add_dir = prepare_claude_add_dir()
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Claude managed-skills command wiring failed: %s", err)
        return command
    if add_dir is None or os.fspath(add_dir) in text:
        return command
    return _append_to_command(command, f"--add-dir {shlex.quote(os.fspath(add_dir))}")


def _replace_claude_view(add_dir_root: Path, managed: list[Path]) -> None:
    parent = add_dir_root.parent
    parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{add_dir_root.name}-", dir=parent))
    backup = parent / f".{add_dir_root.name}.old"
    try:
        skills_dir = tmp / ".claude" / "skills"
        skills_dir.mkdir(parents=True)
        for source in managed:
            (skills_dir / source.name).symlink_to(source, target_is_directory=True)
        if backup.exists() or backup.is_symlink():
            _remove_generated_path(backup)
        if add_dir_root.exists() or add_dir_root.is_symlink():
            os.replace(add_dir_root, backup)
        os.replace(tmp, add_dir_root)
        if backup.exists() or backup.is_symlink():
            _remove_generated_path(backup)
    except Exception:
        _remove_generated_path(tmp)
        if not add_dir_root.exists() and backup.exists():
            os.replace(backup, add_dir_root)
        raise


def _directory_names(root: Path) -> set[str]:
    if not root.is_dir():
        return set()
    return {
        entry.name
        for entry in root.iterdir()
        if entry.is_dir() or entry.is_file() or entry.is_symlink()
    }


def _command_text(command: Any) -> str:
    if isinstance(command, list):
        return str(command[-1]) if command else ""
    return str(command or "")


def _append_to_command(command: Any, suffix: str) -> Any:
    if isinstance(command, list):
        updated = list(command)
        updated[-1] = f"{updated[-1]} {suffix}"
        return updated
    return f"{command} {suffix}"


def _remove_generated_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)
