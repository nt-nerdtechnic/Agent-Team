"""Legacy plugin manifest model used by the registry compatibility path."""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator

KNOWN_CAPABILITIES: frozenset[str] = frozenset(
    {
        "fs",
        "git",
        "terminal",
        "search",
        "chat",
        "ui",
        "issues",
        "plans",
    }
)
# Keep the named alias for callers that distinguish the legacy compatibility
# model from the broader manifest module facade.
LEGACY_KNOWN_CAPABILITIES: frozenset[str] = KNOWN_CAPABILITIES

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$")
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
_ACTIVATION_RE = re.compile(r"^(onStartup|onView:.+|onCommand:.+)$")


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
    """Pre-schemaVersion manifest retained for installed-plugin compatibility."""

    id: str
    name: str = Field(min_length=1)
    version: str
    publisher: str = Field(min_length=1)
    engines: dict[str, str] = Field(min_length=1)
    entry: str | None = None
    contributes: Contributes | None = None
    requires: list[str] = Field(default_factory=list)
    activationEvents: list[str] = Field(default_factory=list)

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
        unknown = [capability for capability in value if capability not in LEGACY_KNOWN_CAPABILITIES]
        if unknown:
            known = ", ".join(sorted(LEGACY_KNOWN_CAPABILITIES))
            raise ValueError(f"unknown capabilities {unknown}; known are: {known}")
        return value

    @field_validator("activationEvents")
    @classmethod
    def _check_activation(cls, value: list[str]) -> list[str]:
        bad = [event for event in value if not _ACTIVATION_RE.match(event)]
        if bad:
            raise ValueError(
                f"invalid activation events {bad}; expected 'onStartup', "
                "'onView:<id>' or 'onCommand:<id>'"
            )
        return value

    @property
    def namespace(self) -> str:
        return self.id.split(".", 1)[0]

    @property
    def extension_name(self) -> str:
        return self.id.split(".", 1)[1]
