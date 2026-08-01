"""Plugin manifest model for the marketplace registry.

The core fields and validation mirror the in-app plugin host manifest
(`backend/agent_team_backend/plugins/manifest.py`) so a package the registry
accepts is also loadable by the app. A small set of optional presentation
fields (displayName, description, categories, icon) is added for marketplace
discovery -- an additive superset, not a divergent schema.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, ValidationError, field_validator

KNOWN_CAPABILITIES: frozenset[str] = frozenset(
    {"fs", "git", "terminal", "search", "chat", "ui", "issues", "plans"}
)

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$")
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
_ACTIVATION_RE = re.compile(r"^(onStartup|onView:.+|onCommand:.+)$")


class ManifestError(ValueError):
    """Raised when a manifest fails to parse or validate."""


class ViewContribution(BaseModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)


class CommandContribution(BaseModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)


class Contributes(BaseModel):
    views: list[ViewContribution] = Field(default_factory=list)
    commands: list[CommandContribution] = Field(default_factory=list)


class Manifest(BaseModel):
    # Core fields -- identical to the in-app plugin manifest.
    id: str
    name: str = Field(min_length=1)
    version: str
    publisher: str = Field(min_length=1)
    engines: dict[str, str] = Field(min_length=1)
    entry: str | None = None
    contributes: Contributes | None = None
    requires: list[str] = Field(default_factory=list)
    activationEvents: list[str] = Field(default_factory=list)

    # Marketplace presentation fields -- optional additive superset.
    displayName: str | None = None
    description: str | None = None
    categories: list[str] = Field(default_factory=list)
    icon: str | None = None

    @field_validator("id")
    @classmethod
    def _check_id(cls, value: str) -> str:
        if not _ID_RE.match(value):
            raise ValueError(
                "must be '<namespace>.<name>' in lowercase "
                "(e.g. 'navide.mini-ide')"
            )
        return value

    @field_validator("version")
    @classmethod
    def _check_version(cls, value: str) -> str:
        if not _SEMVER_RE.match(value):
            raise ValueError("must be semver MAJOR.MINOR.PATCH (e.g. '0.1.0')")
        return value

    @field_validator("requires")
    @classmethod
    def _check_requires(cls, value: list[str]) -> list[str]:
        unknown = [c for c in value if c not in KNOWN_CAPABILITIES]
        if unknown:
            known = ", ".join(sorted(KNOWN_CAPABILITIES))
            raise ValueError(
                f"unknown capabilities {unknown}; known are: {known}"
            )
        return value

    @field_validator("activationEvents")
    @classmethod
    def _check_activation(cls, value: list[str]) -> list[str]:
        bad = [e for e in value if not _ACTIVATION_RE.match(e)]
        if bad:
            raise ValueError(
                f"invalid activation events {bad}; expected 'onStartup', "
                "'onView:<id>' or 'onCommand:<id>'"
            )
        return value

    @property
    def namespace(self) -> str:
        """Publisher namespace derived from the id (`namespace.name`)."""
        return self.id.split(".", 1)[0]

    @property
    def extension_name(self) -> str:
        """Extension name derived from the id (`namespace.name`)."""
        return self.id.split(".", 1)[1]


def _format_validation_error(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "<root>"
        parts.append(f"{loc}: {err['msg']}")
    return "; ".join(parts)


def parse_manifest(data: dict) -> Manifest:
    """Validate a manifest dict, raising ManifestError on failure."""
    try:
        return Manifest.model_validate(data)
    except ValidationError as exc:
        raise ManifestError(_format_validation_error(exc)) from exc
