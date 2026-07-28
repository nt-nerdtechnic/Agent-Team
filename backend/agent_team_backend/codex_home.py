"""Per-pane CODEX_HOME management for Codex CLI sessions."""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

from .applog import app_data_dir
from .skills_store import SkillsStore

log = logging.getLogger("agent_team_backend.codex_home")

_SAFE_HOME_ID = re.compile(r"^[A-Za-z0-9_.:-]+$")


class CodexHomeManager:
    """Create isolated CODEX_HOME dirs while sharing stable user config."""

    def __init__(
        self,
        *,
        real_home: Path | None = None,
        panes_root: Path | None = None,
        managed_skills_root: Path | None = None,
    ) -> None:
        self.real_home = real_home or (Path.home() / ".codex")
        self.panes_root = panes_root or (Path.home() / ".codex-panes")
        self.managed_skills_root = managed_skills_root or (app_data_dir() / "runtime" / "skills")
        self._refresh_managed_skills = managed_skills_root is None
        self.shared_entries = (
            "auth.json",
            "config.toml",
            "AGENTS.md",
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
        self._prepare_skills_view(pane_home, source / "skills")
        return pane_home

    def _prepare_skills_view(self, pane_home: Path, native_root: Path) -> None:
        """Expose native and enabled managed skills under ``CODEX_HOME/skills``.

        The generated view is rebuilt on every prepare so disabled managed
        skills disappear on the next spawn. Native entries are linked first;
        a managed skill with the same name is skipped. Every failure is logged
        and contained so optional skill wiring can never block a pane spawn.
        """
        view = pane_home / ".navide-skills"
        skills_link = pane_home / "skills"
        tmp: Path | None = None
        backup = pane_home / ".navide-skills.old"
        try:
            managed_root = self.managed_skills_root
            if self._refresh_managed_skills:
                try:
                    managed_root = SkillsStore().rebuild_runtime_projection()
                except Exception as err:  # noqa: BLE001 - optional wiring cannot block spawn
                    log.warning("refreshing managed Skills projection failed: %s", err)
                    managed_root = pane_home / ".navide-skills-unavailable"
            tmp = Path(tempfile.mkdtemp(prefix=".navide-skills-", dir=pane_home))
            native_entries = (
                sorted(native_root.iterdir(), key=lambda path: path.name)
                if native_root.is_dir()
                else []
            )
            native_names = {
                entry.name
                for entry in native_entries
                if entry.is_dir() or entry.is_file() or entry.is_symlink()
            }
            for entry in native_entries:
                if entry.is_dir():
                    (tmp / entry.name).symlink_to(entry, target_is_directory=True)
            if managed_root.is_dir():
                for entry in sorted(managed_root.iterdir(), key=lambda path: path.name):
                    if not entry.is_dir() or entry.name in native_names:
                        continue
                    (tmp / entry.name).symlink_to(entry, target_is_directory=True)

            if backup.exists() or backup.is_symlink():
                self._remove_generated_path(backup)
            if view.exists() or view.is_symlink():
                os.replace(view, backup)
            os.replace(tmp, view)
            tmp = None

            if skills_link.is_symlink():
                if os.readlink(skills_link) != os.fspath(view):
                    skills_link.unlink()
            elif skills_link.exists():
                log.warning("leaving real Codex skills directory unmodified: %s", skills_link)
                return
            if not skills_link.is_symlink():
                skills_link.symlink_to(view, target_is_directory=True)
            if backup.exists() or backup.is_symlink():
                self._remove_generated_path(backup)
        except OSError as err:
            log.warning("codex managed-skills view failed for %s: %s", pane_home, err)
            if not view.exists() and backup.exists():
                try:
                    os.replace(backup, view)
                except OSError:
                    pass
            if not skills_link.exists() and not skills_link.is_symlink() and native_root.is_dir():
                try:
                    skills_link.symlink_to(native_root, target_is_directory=True)
                except OSError:
                    pass
        finally:
            if tmp is not None:
                self._remove_generated_path(tmp)

    @staticmethod
    def _remove_generated_path(path: Path) -> None:
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path)

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
                        self._prepare_skills_view(pane_home, self.real_home / "skills")
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
