"""Per-pane CODEX_HOME management for Codex CLI sessions."""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

log = logging.getLogger("agent_team_backend.codex_home")

_SAFE_HOME_ID = re.compile(r"^[A-Za-z0-9_.:-]+$")


class CodexHomeManager:
    """Create isolated CODEX_HOME dirs while sharing stable user config."""

    def __init__(self, *, real_home: Path | None = None, panes_root: Path | None = None) -> None:
        self.real_home = real_home or (Path.home() / ".codex")
        self.panes_root = panes_root or (Path.home() / ".codex-panes")
        self.shared_entries = (
            "auth.json",
            "config.toml",
            "AGENTS.md",
            "skills",
            "plugins",
            "rules",
            "memories",
        )

    def prepare(self, home_id: str, *, source_home: Path | None = None) -> Path:
        """Create the per-pane home, symlinking shared entries from
        ``source_home`` (a CLI account profile home) or the real ~/.codex."""
        source = source_home or self.real_home
        safe_id = self._safe_home_id(home_id)
        pane_home = self.panes_root / safe_id
        pane_home.mkdir(parents=True, exist_ok=True)
        for name in self.shared_entries:
            src = source / name
            dst = pane_home / name
            if not src.exists() or dst.exists() or dst.is_symlink():
                continue
            try:
                dst.symlink_to(src, target_is_directory=src.is_dir())
            except OSError as err:
                log.warning("codex home symlink %s -> %s failed: %s", dst, src, err)
        return pane_home

    def find_session_home(self, resume_id: str) -> Path | None:
        """Locate the CODEX_HOME that recorded this session, if any.

        `codex resume <id>` only finds a session inside the home it was
        recorded under (rollout file + that home's own state db). Checks the
        real ~/.codex first (sessions predating per-pane homes), then every
        per-pane home (covers persisted home ids that drifted from the dir
        actually holding the session). Returns None when no home has it.
        """
        rid = resume_id.strip()
        if not _SAFE_HOME_ID.match(rid):
            return None
        pattern = f"rollout-*{rid}.jsonl"
        default_sessions = self.real_home / "sessions"
        if default_sessions.is_dir():
            try:
                if next(default_sessions.rglob(pattern), None) is not None:
                    return self.real_home
            except OSError:
                pass
        if self.panes_root.is_dir():
            try:
                for pane_home in sorted(self.panes_root.iterdir()):
                    sessions = pane_home / "sessions"
                    if not sessions.is_dir():
                        continue
                    if next(sessions.rglob(pattern), None) is not None:
                        return pane_home
            except OSError:
                pass
        return None

    def cleanup(self, home_id: str) -> bool:
        safe_id = self._safe_home_id(home_id)
        pane_home = (self.panes_root / safe_id).resolve()
        root = self.panes_root.resolve()
        try:
            pane_home.relative_to(root)
        except ValueError:
            raise ValueError(f"refusing to clean path outside codex panes root: {pane_home}")
        if pane_home == root:
            raise ValueError("refusing to clean codex panes root")
        if not pane_home.exists() and not pane_home.is_symlink():
            return False
        if pane_home.is_symlink():
            pane_home.unlink()
            return True
        shutil.rmtree(pane_home)
        return True

    def _safe_home_id(self, home_id: str) -> str:
        value = home_id.strip()
        if not value or not _SAFE_HOME_ID.match(value):
            raise ValueError(f"invalid codex home id: {home_id!r}")
        return value
