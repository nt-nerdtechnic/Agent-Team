"""Strict Pydantic models for the public Manifest v2 contract."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .path_policy import canonical_html_path, canonical_package_path
from .versions import _V2_VERSION_RE

_V2_CATEGORY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
_V2_DISPLAY_TEXT_RE = r"^[^\r\n<>]+$"
_V2_PERMISSION_ACCESS: dict[str, frozenset[str]] = {
    "fs": frozenset({"read"}),
    "ui": frozenset({"openInEditor", "openExternal"}),
}
# Manifest-level guard for recognizable source/script filenames. Proving that
# archive bytes are the correct target executable belongs to the B8 packager.
_KNOWN_SOURCE_BACKEND_SCRIPT_EXTENSIONS = frozenset(
    {
        ".py",
        ".pyw",
        ".js",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
        ".sh",
        ".bash",
        ".zsh",
        ".fish",
        ".ps1",
        ".cmd",
        ".bat",
    }
)


class ManifestV2Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="before")
    @classmethod
    def _reject_explicit_nulls(cls, value: Any) -> Any:
        if isinstance(value, Mapping):
            null_fields = [str(key) for key, item in value.items() if item is None]
            if null_fields:
                raise ValueError(
                    "explicit null is not allowed for field(s): "
                    + ", ".join(null_fields)
                )
        return value


class ManifestV2Engines(ManifestV2Model):
    navide: str = Field(min_length=1)


class ManifestV2Marketplace(ManifestV2Model):
    description: str = Field(min_length=1, max_length=280, pattern=r"^[^\r\n<>]+$")
    license: str = Field(
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9.()+ -]*$",
    )
    repository: str | None = Field(
        default=None, max_length=2048, pattern=r"^https://[^\s]+$"
    )
    homepage: str | None = Field(
        default=None, max_length=2048, pattern=r"^https://[^\s]+$"
    )
    categories: list[str] = Field(default_factory=list, max_length=5)
    icon: str | None = Field(default=None, min_length=1)

    @field_validator("description")
    @classmethod
    def _check_description(cls, value: str) -> str:
        if "\r" in value or "\n" in value or "<" in value or ">" in value:
            raise ValueError("must not contain newlines or angle brackets")
        return value

    @field_validator("categories")
    @classmethod
    def _check_categories(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("must contain unique values")
        bad = [category for category in value if not _V2_CATEGORY_RE.fullmatch(category)]
        if bad:
            raise ValueError(f"contains invalid category slugs {bad}")
        return value

    @field_validator("icon")
    @classmethod
    def _check_icon(cls, value: str | None) -> str | None:
        if value is not None and canonical_package_path(value) is None:
            raise ValueError("must be a safe package-relative path")
        return value


class ManifestV2View(ManifestV2Model):
    id: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    kind: Literal["custom"]
    location: Literal["top", "bottom", "right", "left", "main", "window"]
    title: str = Field(min_length=1, max_length=80, pattern=_V2_DISPLAY_TEXT_RE)
    icon: str | None = Field(default=None, min_length=1)
    entry: str = Field(min_length=1)

    @field_validator("icon")
    @classmethod
    def _check_icon(cls, value: str | None) -> str | None:
        if value is not None and canonical_package_path(value) is None:
            raise ValueError("must be a safe package-relative path")
        return value

    @field_validator("entry")
    @classmethod
    def _check_entry(cls, value: str) -> str:
        if canonical_html_path(value) is None:
            raise ValueError("must be a safe package-relative HTML path")
        return value


class ManifestV2Contributes(ManifestV2Model):
    views: list[ManifestV2View] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def _check_unique_view_ids(self) -> ManifestV2Contributes:
        ids = [view.id for view in self.views]
        if len(set(ids)) != len(ids):
            raise ValueError("contributes.views must contain unique ids")
        return self


class ManifestV2Backend(ManifestV2Model):
    entry: str = Field(min_length=1)
    protocolVersion: Literal[1]
    activation: Literal["startup"]

    @field_validator("protocolVersion", mode="before")
    @classmethod
    def _reject_bool_protocol_version(cls, value: Any) -> Any:
        # bool is a subclass of int in Python, but JSON true is not protocol 1.
        if isinstance(value, bool):
            raise ValueError("must be integer 1, not boolean")
        return value

    @field_validator("entry")
    @classmethod
    def _check_entry(cls, value: str) -> str:
        if canonical_package_path(value) is None:
            raise ValueError("must be a safe package-relative path")
        suffix = "." + value.rsplit("/", 1)[-1].rsplit(".", 1)[-1].lower()
        if suffix in _KNOWN_SOURCE_BACKEND_SCRIPT_EXTENSIONS:
            raise ValueError("must reference a packaged executable, not a raw script")
        return value


class ManifestV2(ManifestV2Model):
    schemaVersion: Literal[2]
    apiVersion: str = Field(pattern=r"^[~^]?\d+\.\d+\.\d+$")
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$")
    name: str = Field(min_length=1, max_length=80, pattern=_V2_DISPLAY_TEXT_RE)
    version: str = Field(pattern=_V2_VERSION_RE.pattern)
    publisher: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$")
    engines: ManifestV2Engines | None = None
    permissions: dict[str, list[str]]
    marketplace: ManifestV2Marketplace
    contributes: ManifestV2Contributes | None = None
    backend: ManifestV2Backend | None = None

    @field_validator("permissions")
    @classmethod
    def _check_permissions(cls, value: dict[str, list[str]]) -> dict[str, list[str]]:
        unknown = sorted(set(value) - set(_V2_PERMISSION_ACCESS))
        if unknown:
            raise ValueError(f"unknown permissions {unknown}")
        for permission, accesses in value.items():
            if not accesses:
                raise ValueError(f"permissions.{permission} must not be empty")
            if len(set(accesses)) != len(accesses):
                raise ValueError(f"permissions.{permission} must contain unique values")
            allowed = _V2_PERMISSION_ACCESS[permission]
            bad = sorted(set(accesses) - allowed)
            if bad:
                raise ValueError(
                    f"permissions.{permission} contains unknown accesses {bad}"
                )
            if permission == "fs" and accesses != ["read"]:
                raise ValueError("permissions.fs only accepts ['read']")
        return value

    @model_validator(mode="after")
    def _check_runtime_surface(self) -> ManifestV2:
        if self.contributes is None and self.backend is None:
            raise ValueError("manifest must declare contributes or backend")
        return self

    @property
    def namespace(self) -> str:
        return self.id.split(".", 1)[0]

    @property
    def extension_name(self) -> str:
        return self.id.split(".", 1)[1]
