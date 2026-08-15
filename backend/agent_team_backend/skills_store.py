"""App-managed Skills library with safe persistence and runtime projection."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

import yaml
from send2trash import send2trash

from .applog import app_data_dir

log = logging.getLogger("agent_team_backend.skills_store")

SKILLS_DIR = "skills"
SKILLS_STATE_FILE = "skills.json"
SKILLS_RUNTIME_DIR = "runtime/skills"
SKILL_FILE = "SKILL.md"
SKILL_FILE_SIZE_LIMIT = 1_000_000
_STATE_FILE_SIZE_LIMIT = 1_000_000
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_FRONTMATTER_RE = re.compile(
    r"\A---[ \t]*\r?\n(?P<yaml>.*?)^---[ \t]*(?:\r?\n|\Z)(?P<body>.*)\Z",
    re.MULTILINE | re.DOTALL,
)


def agent_targets() -> list[dict[str, Any]]:
    """Every CLI vendor and what the managed library can actually do with it.

    Three states, because "off" and "impossible" must not look alike in the
    UI: ``wired`` (a spawn carries the library to it), ``planned`` (the CLI
    has skills but Navide does not wire them yet), ``unsupported`` (no skills
    mechanism exists to wire).
    """
    from .cli_vendors.registry import VENDORS

    agents: list[dict[str, Any]] = []
    for key in sorted(VENDORS):
        spec = VENDORS[key]
        if spec.skills_wiring is not None:
            state = "wired"
        elif spec.skills_supported:
            state = "planned"
        else:
            state = "unsupported"
        agents.append({"key": key, "label": spec.label, "state": state})
    return agents


class SkillsStoreError(Exception):
    """Base error for managed Skills operations."""


class SkillNotFoundError(SkillsStoreError):
    """Raised when a managed skill does not exist."""


class SkillConflictError(SkillsStoreError):
    """Raised when a caller attempts to overwrite a stale revision."""


class SkillValidationError(SkillsStoreError):
    """Raised for invalid names, paths, files, or frontmatter."""


class SkillsStore:
    def __init__(
        self,
        root: Path | None = None,
        state_path: Path | None = None,
        runtime_root: Path | None = None,
        native_roots: list[Path] | tuple[Path, ...] | None = None,
    ) -> None:
        data_root = app_data_dir()
        requested_root = root or (data_root / SKILLS_DIR)
        self._root = requested_root.parent.resolve() / requested_root.name
        self._state_path = state_path or (data_root / SKILLS_STATE_FILE)
        self._runtime_root = runtime_root or (data_root / SKILLS_RUNTIME_DIR)
        if native_roots is not None:
            self._native_roots = tuple(native_roots)
        else:
            try:
                user_home = Path.home()
                self._native_roots = (
                    user_home / ".claude" / "skills",
                    user_home / ".codex" / "skills",
                )
            except (OSError, RuntimeError):
                self._native_roots = ()

    @property
    def root(self) -> Path:
        return self._root

    @property
    def state_path(self) -> Path:
        return self._state_path

    @property
    def runtime_root(self) -> Path:
        return self._runtime_root

    def list_skills(self) -> dict[str, Any]:
        self._ensure_safe_root()
        state = self._read_state()
        targets = self._read_targets()
        skills: list[dict[str, Any]] = []
        if self._root.exists():
            if self._root.is_symlink() or not self._root.is_dir():
                raise SkillValidationError("skills root must be a directory, not a symlink")
            for entry in sorted(self._root.iterdir(), key=lambda path: path.name):
                if not entry.is_dir() and not entry.is_symlink():
                    continue
                try:
                    name = self._validate_name(entry.name)
                    skill = self._read_skill(name, state, targets)
                    skills.append(self._summary(skill))
                except SkillsStoreError as exc:
                    if _NAME_RE.fullmatch(entry.name):
                        skills.append(
                            {
                                "name": entry.name,
                                "description": "",
                                "enabled": bool(state.get(entry.name, True)),
                                "native_conflict": self._native_conflict(entry.name),
                                "targets": targets.get(entry.name),
                                "valid": False,
                                "error": str(exc),
                                "path": str(entry),
                            }
                        )
        return {"skills": skills, "root": str(self._root), "agents": agent_targets()}

    def get_skill(self, name: str) -> dict[str, Any]:
        self._ensure_safe_root()
        return {"skill": self._read_skill(name, self._read_state(), self._read_targets())}

    def create_skill(self, name: str, description: str = "") -> dict[str, Any]:
        self._ensure_safe_root()
        name = self._validate_name(name)
        if not isinstance(description, str):
            raise SkillValidationError("description must be a string")
        skill_dir = self._skill_dir(name)
        if skill_dir.exists() or skill_dir.is_symlink():
            raise SkillValidationError(f"skill already exists: {name}")

        self._root.mkdir(parents=True, exist_ok=True)
        skill_dir.mkdir()
        try:
            self._write_skill_file(skill_dir / SKILL_FILE, {"name": name, "description": description}, "")
            state = self._read_state()
            state[name] = True
            self._write_state(state)
        except Exception:
            shutil.rmtree(skill_dir, ignore_errors=True)
            raise
        self._refresh_runtime_projection()
        return self.get_skill(name)

    def save_skill(
        self,
        name: str,
        fields: dict[str, Any],
        body: str,
        expected_revision: str,
    ) -> dict[str, Any]:
        self._ensure_safe_root()
        if not isinstance(fields, dict):
            raise SkillValidationError("fields must be an object")
        if not isinstance(body, str):
            raise SkillValidationError("body must be a string")
        if not isinstance(expected_revision, str) or not expected_revision:
            raise SkillValidationError("expected_revision is required")

        current = self._read_skill(name, self._read_state())
        if current["revision"] != expected_revision:
            raise SkillConflictError("skill changed on disk; reload before saving")

        merged_fields = dict(current["fields"])
        merged_fields.update(fields)
        merged_fields["name"] = current["name"]
        self._validate_fields(merged_fields)
        self._write_skill_file(self._skill_file(name), merged_fields, body)
        self._refresh_runtime_projection()
        return self.get_skill(name)

    def set_enabled(self, name: str, enabled: bool) -> dict[str, Any]:
        self._ensure_safe_root()
        name = self._validate_name(name)
        if not isinstance(enabled, bool):
            raise SkillValidationError("enabled must be a boolean")
        self._require_safe_skill_dir(name)
        state = self._read_state()
        state[name] = enabled
        self._write_state(state, self._read_targets())
        self._refresh_runtime_projection()
        return self.get_skill(name)

    def set_targets(self, name: str, agents: list[str] | None) -> dict[str, Any]:
        """Restrict ``name`` to ``agents``, or to every wired agent when None.

        Stored beside the enabled flags rather than in SKILL.md: which of the
        user's CLIs a skill goes to is this machine's routing, not part of the
        portable skill, and writing it into the file would make an exported
        skill carry another machine's agent list.
        """
        self._ensure_safe_root()
        name = self._validate_name(name)
        self._require_safe_skill_dir(name)
        targets = self._read_targets()
        if agents is None:
            targets.pop(name, None)
        else:
            targets[name] = self._validate_agents(agents)
        self._write_state(self._read_state(), targets)
        return self.get_skill(name)

    def targets_for(self, agent_key: str) -> list[str]:
        """Enabled skill names this agent receives, in directory order."""
        self._ensure_safe_root()
        state = self._read_state()
        targets = self._read_targets()
        names: list[str] = []
        if not self._root.is_dir():
            return names
        for entry in sorted(self._root.iterdir(), key=lambda path: path.name):
            name = entry.name
            if not _NAME_RE.fullmatch(name) or not state.get(name, True):
                continue
            allowed = targets.get(name)
            if allowed is not None and agent_key not in allowed:
                continue
            names.append(name)
        return names

    def delete_skill(self, name: str) -> dict[str, Any]:
        self._ensure_safe_root()
        name = self._validate_name(name)
        skill_dir = self._require_safe_skill_dir(name)
        state = self._read_state()
        try:
            send2trash(str(skill_dir))
        except Exception as exc:  # noqa: BLE001
            log.warning("send2trash failed for skill %s (%s); keeping original", name, exc)
            raise SkillsStoreError(f"could not move skill to trash: {name}") from exc

        state.pop(name, None)
        self._write_state(state)
        self._refresh_runtime_projection()
        return {"name": name, "deleted": True}

    def rebuild_runtime_projection(self) -> Path:
        """Atomically replace the enabled-only runtime directory."""
        self._ensure_safe_root()
        state = self._read_state()
        runtime_parent = self._runtime_root.parent
        runtime_parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix=f".{self._runtime_root.name}-", dir=runtime_parent))
        backup = runtime_parent / f".{self._runtime_root.name}.old"
        try:
            if self._root.exists():
                for entry in sorted(self._root.iterdir(), key=lambda path: path.name):
                    if not _NAME_RE.fullmatch(entry.name) or not state.get(entry.name, True):
                        continue
                    try:
                        source = self._require_safe_skill_dir(entry.name)
                        self._read_skill(entry.name, state)
                    except SkillsStoreError as exc:
                        log.warning("Skipping invalid skill %s in runtime projection: %s", entry.name, exc)
                        continue
                    os.symlink(source, tmp / entry.name, target_is_directory=True)

            if backup.exists() or backup.is_symlink():
                self._remove_projection_path(backup)
            if self._runtime_root.exists() or self._runtime_root.is_symlink():
                os.replace(self._runtime_root, backup)
            os.replace(tmp, self._runtime_root)
            if backup.exists() or backup.is_symlink():
                self._remove_projection_path(backup)
        except Exception:
            self._remove_projection_path(tmp)
            if not self._runtime_root.exists() and backup.exists():
                os.replace(backup, self._runtime_root)
            raise
        return self._runtime_root

    def _refresh_runtime_projection(self) -> None:
        try:
            self.rebuild_runtime_projection()
        except Exception as exc:  # noqa: BLE001 - projection is derived and retryable
            log.warning("Managed Skills saved but runtime projection refresh failed: %s", exc)

    def _read_skill(
        self,
        name: str,
        state: dict[str, bool],
        targets: dict[str, list[str]] | None = None,
    ) -> dict[str, Any]:
        name = self._validate_name(name)
        skill_dir = self._require_safe_skill_dir(name)
        skill_file = skill_dir / SKILL_FILE
        if skill_file.is_symlink() or not skill_file.is_file():
            raise SkillValidationError(f"{SKILL_FILE} must be a regular file")
        if skill_file.stat().st_size > SKILL_FILE_SIZE_LIMIT:
            raise SkillValidationError(f"{SKILL_FILE} exceeds the 1 MB size limit")

        raw = skill_file.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SkillValidationError(f"{SKILL_FILE} must be UTF-8") from exc
        fields, body = self._parse_skill_file(text)
        if fields.get("name") != name:
            raise SkillValidationError("frontmatter name must match the skill directory")
        attachments = self._list_attachments(skill_dir)
        return {
            "name": name,
            "description": fields.get("description", ""),
            "fields": fields,
            "body": body,
            "enabled": bool(state.get(name, True)),
            "native_conflict": self._native_conflict(name),
            "targets": (targets or {}).get(name),
            "revision": hashlib.sha256(raw).hexdigest(),
            "valid": True,
            "path": str(skill_dir),
            "attachments": attachments,
        }

    def _parse_skill_file(self, text: str) -> tuple[dict[str, Any], str]:
        match = _FRONTMATTER_RE.match(text)
        if not match:
            raise SkillValidationError(f"{SKILL_FILE} requires YAML frontmatter")
        try:
            fields = yaml.safe_load(match.group("yaml"))
        except yaml.YAMLError as exc:
            raise SkillValidationError(f"invalid YAML frontmatter: {exc}") from exc
        if not isinstance(fields, dict):
            raise SkillValidationError("frontmatter must be an object")
        self._validate_fields(fields)
        return fields, match.group("body")

    def _validate_fields(self, fields: dict[str, Any]) -> None:
        name = fields.get("name")
        if not isinstance(name, str):
            raise SkillValidationError("frontmatter name must be a string")
        self._validate_name(name)
        description = fields.get("description", "")
        if not isinstance(description, str):
            raise SkillValidationError("frontmatter description must be a string")
        try:
            yaml.safe_dump(fields, allow_unicode=True, sort_keys=False)
        except yaml.YAMLError as exc:
            raise SkillValidationError(f"frontmatter is not YAML-safe: {exc}") from exc

    def _write_skill_file(self, path: Path, fields: dict[str, Any], body: str) -> None:
        self._validate_fields(fields)
        yaml_text = yaml.safe_dump(fields, allow_unicode=True, sort_keys=False).rstrip("\n")
        payload = f"---\n{yaml_text}\n---\n{body}"
        encoded = payload.encode("utf-8")
        if len(encoded) > SKILL_FILE_SIZE_LIMIT:
            raise SkillValidationError(f"{SKILL_FILE} exceeds the 1 MB size limit")
        self._atomic_write(path, encoded)

    def _read_state_document(self) -> dict[str, Any]:
        if not self._state_path.exists():
            return {}
        if self._state_path.is_symlink() or not self._state_path.is_file():
            raise SkillValidationError("skills state must be a regular file")
        if self._state_path.stat().st_size > _STATE_FILE_SIZE_LIMIT:
            raise SkillValidationError("skills state exceeds the 1 MB size limit")
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SkillValidationError(f"invalid skills state: {exc}") from exc
        return raw if isinstance(raw, dict) else {}

    def _read_state(self) -> dict[str, bool]:
        raw = self._read_state_document()
        if not raw:
            return {}
        enabled = raw.get("enabled")
        if not isinstance(enabled, dict):
            raise SkillValidationError("skills state must contain an enabled object")
        clean: dict[str, bool] = {}
        for name, value in enabled.items():
            self._validate_name(name)
            if not isinstance(value, bool):
                raise SkillValidationError("skills enabled values must be booleans")
            clean[name] = value
        return clean

    def _read_targets(self) -> dict[str, list[str]]:
        """Per-skill agent allow-lists; a missing entry means "every agent"."""
        raw = self._read_state_document().get("targets")
        if raw is None:
            return {}
        if not isinstance(raw, dict):
            raise SkillValidationError("skills targets must be an object")
        clean: dict[str, list[str]] = {}
        for name, agents in raw.items():
            self._validate_name(name)
            clean[name] = self._validate_agents(agents)
        return clean

    @staticmethod
    def _validate_agents(agents: Any) -> list[str]:
        if not isinstance(agents, list):
            raise SkillValidationError("skill targets must be a list of agent keys")
        clean: list[str] = []
        for agent in agents:
            if not isinstance(agent, str) or not _AGENT_RE.fullmatch(agent):
                raise SkillValidationError("invalid agent key in skill targets")
            if agent not in clean:
                clean.append(agent)
        return clean

    def _write_state(
        self, state: dict[str, bool], targets: dict[str, list[str]] | None = None
    ) -> None:
        document: dict[str, Any] = {"enabled": state}
        if targets:
            document["targets"] = targets
        payload = json.dumps(document, indent=2, ensure_ascii=False).encode("utf-8")
        self._atomic_write(self._state_path, payload)

    def _atomic_write(self, path: Path, payload: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    def _skill_dir(self, name: str) -> Path:
        candidate = self._root / self._validate_name(name)
        if candidate.parent != self._root:
            raise SkillValidationError("skill path escapes the managed root")
        return candidate

    def _ensure_safe_root(self) -> None:
        if self._root.is_symlink():
            raise SkillValidationError("skills root must be a directory, not a symlink")
        if self._root.exists() and not self._root.is_dir():
            raise SkillValidationError("skills root must be a directory, not a symlink")

    def _native_conflict(self, name: str) -> bool:
        """Return whether a user-owned native skills root contains ``name``.

        Native roots can be unreadable or disappear while being inspected;
        those failures must not make the managed Skills library unusable.
        """
        for root in self._native_roots:
            try:
                entry = root / name
                if entry.is_dir() or entry.is_file() or entry.is_symlink():
                    return True
            except OSError:
                continue
        return False

    @staticmethod
    def _validate_name(name: str) -> str:
        if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
            raise SkillValidationError(
                "skill name must be lowercase letters, digits, underscores, or dashes"
            )
        return name

    def _skill_file(self, name: str) -> Path:
        return self._require_safe_skill_dir(name) / SKILL_FILE

    def _require_safe_skill_dir(self, name: str) -> Path:
        skill_dir = self._skill_dir(name)
        if skill_dir.is_symlink():
            raise SkillValidationError("skill directory must not be a symlink")
        if not skill_dir.is_dir():
            raise SkillNotFoundError(f"skill not found: {name}")
        try:
            skill_dir.resolve().relative_to(self._root)
        except ValueError as exc:
            raise SkillValidationError("skill path escapes the managed root") from exc
        return skill_dir

    def _list_attachments(self, skill_dir: Path) -> list[dict[str, Any]]:
        attachments: list[dict[str, Any]] = []
        for path in sorted(skill_dir.rglob("*")):
            if path.is_symlink():
                raise SkillValidationError("skill attachments must not contain symlinks")
            if path.is_file() and path.name != SKILL_FILE:
                attachments.append(
                    {"path": path.relative_to(skill_dir).as_posix(), "size": path.stat().st_size}
                )
        return attachments

    @staticmethod
    def _summary(skill: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in skill.items() if key not in {"fields", "body"}}

    @staticmethod
    def _remove_projection_path(path: Path) -> None:
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path)
