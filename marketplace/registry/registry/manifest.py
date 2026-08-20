"""Compatibility façade for legacy and Manifest v2 registry models."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from .manifest_v1 import (
    KNOWN_CAPABILITIES,
    LEGACY_CAPABILITY_ORDER,
    LEGACY_KNOWN_CAPABILITIES,
    CommandContribution,
    Contributes,
    Manifest,
    ViewContribution,
)
from .manifest_v2 import (
    ManifestV2,
    ManifestV2Backend,
    ManifestV2Contributes,
    ManifestV2Engines,
    ManifestV2Marketplace,
    ManifestV2Model,
    ManifestV2Permissions,
    ManifestV2View,
)

__all__ = [
    "KNOWN_CAPABILITIES",
    "LEGACY_KNOWN_CAPABILITIES",
    "CommandContribution",
    "Contributes",
    "Manifest",
    "ManifestError",
    "ManifestLike",
    "ManifestV2",
    "ManifestV2Backend",
    "ManifestV2Contributes",
    "ManifestV2Engines",
    "ManifestV2Marketplace",
    "ManifestV2Model",
    "ManifestV2Permissions",
    "ManifestV2View",
    "ViewContribution",
    "is_manifest_v2",
    "manifest_capabilities",
    "manifest_icon",
    "manifest_referenced_files",
    "parse_manifest",
]


class ManifestError(ValueError):
    """Raised when a manifest fails to parse or validate."""


ManifestLike = Manifest | ManifestV2


def _format_validation_error(exc: ValidationError) -> str:
    parts = []
    for error in exc.errors():
        loc = ".".join(str(part) for part in error["loc"]) or "<root>"
        parts.append(f"{loc}: {error['msg']}")
    return "; ".join(parts)


def parse_manifest(data: dict[str, Any]) -> ManifestLike:
    """Validate a legacy or v2 manifest dict."""
    try:
        if any(key in data for key in ("schemaVersion", "permissions", "marketplace")):
            return ManifestV2.model_validate(data)
        return Manifest.model_validate(data)
    except ValidationError as exc:
        raise ManifestError(_format_validation_error(exc)) from exc


def is_manifest_v2(manifest: ManifestLike) -> bool:
    return isinstance(manifest, ManifestV2)


def manifest_capabilities(
    manifest: ManifestLike | Mapping[str, object],
) -> list[str]:
    """Project v2 permission namespaces and legacy requires to one API list."""
    if isinstance(manifest, ManifestV2):
        namespaces = list(manifest.permissions.system or [])
        if manifest.permissions.shell is not None:
            namespaces.append("shell")
        return namespaces
    if isinstance(manifest, Manifest):
        return list(manifest.requires)
    permissions = manifest.get("permissions")
    if isinstance(permissions, dict):
        system = permissions.get("system")
        if isinstance(system, list):
            capabilities = [str(value) for value in system]
            if permissions.get("shell") is not None:
                capabilities.append("shell")
            return capabilities

        # Bounded read-only adapter for legacy DB rows written before
        # permissions became namespaced. The legacy lists lived inside the
        # stored permissions object; strict manifest parsing never accepts
        # this shape and all new writes continue to use the canonical v2
        # object.
        legacy_namespaces = [
            key
            for key in LEGACY_CAPABILITY_ORDER
            if isinstance(permissions.get(key), list)
        ]
        if legacy_namespaces:
            return legacy_namespaces
        if permissions.get("shell") is not None:
            return ["shell"]
        return []
    requires = manifest.get("requires", [])
    if isinstance(requires, list):
        return [str(value) for value in requires]
    return []


def manifest_referenced_files(manifest: ManifestLike) -> list[str]:
    """Return v2 package files that must be present in the archive."""
    if not isinstance(manifest, ManifestV2):
        return []
    paths: set[str] = set()
    if manifest.contributes is not None:
        for view in manifest.contributes.views:
            paths.add(view.entry)
            if view.icon is not None:
                paths.add(view.icon)
    if manifest.marketplace.icon is not None:
        paths.add(manifest.marketplace.icon)
    if manifest.backend is not None:
        paths.add(manifest.backend.entry)
    return sorted(paths)


def manifest_icon(manifest: ManifestLike | Mapping[str, object]) -> str | None:
    """Read a marketplace icon from either a parsed or stored manifest."""
    if isinstance(manifest, ManifestV2):
        return manifest.marketplace.icon
    if isinstance(manifest, Manifest):
        return manifest.icon
    marketplace = manifest.get("marketplace")
    if isinstance(marketplace, dict):
        icon = marketplace.get("icon")
        return icon if isinstance(icon, str) else None
    icon = manifest.get("icon")
    return icon if isinstance(icon, str) else None
