"""Plugin manifest schema plus pure parsing/validation helpers.

A manifest is how a plugin describes itself to the host: identity, host-API
compatibility, what it contributes to the UI, which capabilities it requests,
and when it should activate. The shape is a trimmed-down take on the VS Code
extension manifest, kept to only the fields this project needs today.

Parsing is a pure function with no side effects: ``parse_manifest`` validates a
plain ``dict`` and returns a structured :class:`Manifest`; ``load_manifest``
adds file/JSON reading on top. Any validation failure raises
:class:`ManifestError` with a clear message.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, ValidationError, field_validator

# Capability namespaces the host is able to authorize. These map to the
# ws_handlers registry prefixes (``fs.*``, ``git.*``, terminal handlers) that a
# future plugin host will grant to a plugin. Extend as new contracts land.
KNOWN_CAPABILITIES: frozenset[str] = frozenset(
    {"fs", "git", "terminal", "search", "chat", "ui", "issues", "plans"}
)

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$")
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
_ACTIVATION_RE = re.compile(r"^(onStartup|onView:.+|onCommand:.+)$")


class ManifestError(ValueError):
    """Raised when a manifest is missing, malformed, or fails validation."""


class ViewContribution(BaseModel):
    """A side-bar panel a plugin contributes."""

    id: str = Field(min_length=1)
    title: str = Field(min_length=1)


class CommandContribution(BaseModel):
    """A command a plugin contributes."""

    id: str = Field(min_length=1)
    title: str = Field(min_length=1)


class Contributes(BaseModel):
    """UI contribution points declared by a plugin."""

    views: list[ViewContribution] = Field(default_factory=list)
    commands: list[CommandContribution] = Field(default_factory=list)


class Manifest(BaseModel):
    """A parsed, validated plugin manifest."""

    id: str
    name: str = Field(min_length=1)
    version: str
    publisher: str = Field(min_length=1)
    engines: dict[str, str] = Field(min_length=1)
    entry: str | None = None
    contributes: Contributes | None = None
    requires: list[str] = Field(default_factory=list)
    activationEvents: list[str] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        if not _ID_RE.match(value):
            raise ValueError(
                f"id must be '<publisher>.<name>' (lowercase, e.g. 'navide.mini-ide'), got {value!r}"
            )
        return value

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        if not _SEMVER_RE.match(value):
            raise ValueError(f"version must be semver MAJOR.MINOR.PATCH, got {value!r}")
        return value

    @field_validator("requires")
    @classmethod
    def _validate_requires(cls, values: list[str]) -> list[str]:
        for cap in values:
            if cap not in KNOWN_CAPABILITIES:
                known = ", ".join(sorted(KNOWN_CAPABILITIES))
                raise ValueError(f"unknown capability {cap!r} in requires (known: {known})")
        return values

    @field_validator("activationEvents")
    @classmethod
    def _validate_activation_events(cls, values: list[str]) -> list[str]:
        for event in values:
            if not _ACTIVATION_RE.match(event):
                raise ValueError(
                    f"invalid activationEvent {event!r} "
                    "(expected 'onStartup', 'onView:<id>' or 'onCommand:<id>')"
                )
        return values


def parse_manifest(data: dict[str, Any]) -> Manifest:
    """Validate ``data`` and return a structured :class:`Manifest`.

    Raises :class:`ManifestError` with a clear message on any failure.
    """
    if not isinstance(data, dict):
        raise ManifestError("manifest must be a JSON object")
    try:
        return Manifest.model_validate(data)
    except ValidationError as err:
        raise ManifestError(_format_validation_error(err)) from err


def load_manifest(path: str | Path) -> Manifest:
    """Read a manifest JSON file and parse it.

    Raises :class:`ManifestError` if the file is missing, unreadable, contains
    invalid JSON, or fails validation.
    """
    manifest_path = Path(path)
    try:
        raw = manifest_path.read_text(encoding="utf-8")
    except FileNotFoundError as err:
        raise ManifestError(f"manifest file not found: {manifest_path}") from err
    except OSError as err:
        raise ManifestError(f"could not read manifest file {manifest_path}: {err}") from err
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as err:
        raise ManifestError(f"manifest file {manifest_path} is not valid JSON: {err}") from err
    return parse_manifest(data)


def _format_validation_error(err: ValidationError) -> str:
    parts: list[str] = []
    for detail in err.errors():
        loc = ".".join(str(item) for item in detail["loc"]) or "<root>"
        parts.append(f"{loc}: {detail['msg']}")
    return "; ".join(parts)
