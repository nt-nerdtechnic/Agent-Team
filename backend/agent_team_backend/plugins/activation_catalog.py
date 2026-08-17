"""Validate the Host-bound catalog of approved Manifest v2 backends.

The Electron Host verifies Registry evidence and extracted package content. It
then projects only approved backend contributions into this narrow catalog and
binds the exact bytes to the child process through a SHA-256 value in the spawn
environment. The Python service validates that projection but does not import
or spawn v2 backend binaries; process supervision remains an Electron-owned
lifecycle seam.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

ACTIVATION_CATALOG_PATH_ENV = "AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG"
ACTIVATION_CATALOG_DIGEST_ENV = "AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG_SHA256"

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$")
# Keep this grammar byte-for-byte aligned with Manifest v2's SemVer 2.0.0
# validator in marketplace/registry/registry/versions.py.
_SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class ActivationCatalogError(ValueError):
    """The Host activation projection is absent, malformed, or unbound."""


@dataclass(frozen=True)
class ApprovedBackendActivation:
    """One Host-approved v2 backend contribution awaiting its supervisor."""

    plugin_id: str
    package_version: str
    package_dir: Path
    artifact_digest: str
    entry_file: Path
    protocol_version: int
    activation: str


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ActivationCatalogError(f"duplicate JSON key {key!r}")
        value[key] = item
    return value


def _json_object(payload: bytes, label: str) -> dict[str, Any]:
    try:
        decoded = payload.decode("utf-8")
        value = json.loads(decoded, object_pairs_hook=_reject_duplicate_keys)
    except ActivationCatalogError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ActivationCatalogError(f"{label} is not strict UTF-8 JSON: {err}") from err
    if not isinstance(value, dict):
        raise ActivationCatalogError(f"{label} must be a JSON object")
    return value


def _exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        details: list[str] = []
        if missing:
            details.append(f"missing {missing}")
        if unknown:
            details.append(f"unknown {unknown}")
        raise ActivationCatalogError(f"{label} fields are invalid: {', '.join(details)}")


def _regular_file(path: Path, label: str, *, owner_only: bool = False) -> bytes:
    if not path.is_absolute():
        raise ActivationCatalogError(f"{label} path must be absolute")
    try:
        info = path.lstat()
    except OSError as err:
        raise ActivationCatalogError(f"{label} is unavailable: {err}") from err
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ActivationCatalogError(f"{label} must be a regular non-symlink file")
    if owner_only and os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
        raise ActivationCatalogError(f"{label} must be owner-only")
    try:
        return path.read_bytes()
    except OSError as err:
        raise ActivationCatalogError(f"{label} could not be read: {err}") from err


def _manifest_identity(
    package_dir: Path,
    plugin_id: str,
    package_version: str,
    entry_file: Path,
) -> None:
    manifest_path = package_dir / "manifest.json"
    payload = _regular_file(manifest_path, "installed manifest")
    manifest = _json_object(payload, "installed manifest")
    backend = manifest.get("backend")
    if not isinstance(backend, dict):
        raise ActivationCatalogError("installed manifest has no backend contribution")
    entry = backend.get("entry")
    if (
        manifest.get("schemaVersion") != 2
        or manifest.get("id") != plugin_id
        or manifest.get("version") != package_version
        or not isinstance(entry, str)
        or package_dir / entry != entry_file
        or backend.get("protocolVersion") != 1
        or backend.get("activation") != "startup"
    ):
        raise ActivationCatalogError("catalog and installed manifest identity do not match")


def _parse_package(value: Any, plugins_root: Path) -> ApprovedBackendActivation:
    if not isinstance(value, dict):
        raise ActivationCatalogError("catalog package must be a JSON object")
    _exact_keys(
        value,
        {
            "pluginId",
            "packageVersion",
            "packageDir",
            "provenance",
            "artifactDigest",
            "backend",
        },
        "catalog package",
    )
    plugin_id = value["pluginId"]
    package_version = value["packageVersion"]
    artifact_digest = value["artifactDigest"]
    if not isinstance(plugin_id, str) or not _ID_RE.fullmatch(plugin_id):
        raise ActivationCatalogError("catalog package has invalid pluginId")
    if not isinstance(package_version, str) or not _SEMVER_RE.fullmatch(package_version):
        raise ActivationCatalogError("catalog package has invalid packageVersion")
    if not isinstance(artifact_digest, str) or not _SHA256_RE.fullmatch(artifact_digest):
        raise ActivationCatalogError("catalog package has invalid artifactDigest")
    if value["provenance"] != "official-registry":
        raise ActivationCatalogError(
            "catalog provenance must be official-registry; developer-local backends "
            "remain disabled until the explicit child-process supervisor exists"
        )

    raw_package_dir = value["packageDir"]
    if not isinstance(raw_package_dir, str):
        raise ActivationCatalogError("catalog packageDir must be a string")
    package_dir = Path(raw_package_dir)
    if not package_dir.is_absolute():
        raise ActivationCatalogError("catalog packageDir must be absolute")
    try:
        package_info = package_dir.lstat()
        resolved_package_dir = package_dir.resolve(strict=True)
    except OSError as err:
        raise ActivationCatalogError(f"catalog package directory is unavailable: {err}") from err
    if stat.S_ISLNK(package_info.st_mode) or not stat.S_ISDIR(package_info.st_mode):
        raise ActivationCatalogError("catalog package directory must be a non-symlink directory")
    if resolved_package_dir.parent != plugins_root or resolved_package_dir.name != plugin_id:
        raise ActivationCatalogError(
            "catalog package directory must be the plugin-id direct child of the catalog root"
        )

    backend = value["backend"]
    if not isinstance(backend, dict):
        raise ActivationCatalogError("catalog backend must be a JSON object")
    _exact_keys(backend, {"entryFile", "protocolVersion", "activation"}, "catalog backend")
    raw_entry = backend["entryFile"]
    if not isinstance(raw_entry, str):
        raise ActivationCatalogError("catalog backend entryFile must be a string")
    entry_file = Path(raw_entry)
    try:
        entry_info = entry_file.lstat()
        resolved_entry = entry_file.resolve(strict=True)
        resolved_entry.relative_to(resolved_package_dir)
    except (OSError, ValueError) as err:
        raise ActivationCatalogError("catalog backend entry must stay inside its package") from err
    if stat.S_ISLNK(entry_info.st_mode) or not stat.S_ISREG(entry_info.st_mode):
        raise ActivationCatalogError("catalog backend entry must be a regular non-symlink file")
    if backend["protocolVersion"] != 1 or backend["activation"] != "startup":
        raise ActivationCatalogError("catalog backend protocol or activation is unsupported")

    _manifest_identity(
        resolved_package_dir,
        plugin_id,
        package_version,
        resolved_entry,
    )
    return ApprovedBackendActivation(
        plugin_id=plugin_id,
        package_version=package_version,
        package_dir=resolved_package_dir,
        artifact_digest=artifact_digest,
        entry_file=resolved_entry,
        protocol_version=1,
        activation="startup",
    )


def load_activation_catalog(
    environ: Mapping[str, str] | None = None,
) -> tuple[ApprovedBackendActivation, ...]:
    """Load the exact Host-approved backend projection from spawn environment.

    Missing path and digest means that no external backend is approved. One
    without the other, a digest mismatch, or any invalid record fails closed.
    """

    source = os.environ if environ is None else environ
    raw_path = source.get(ACTIVATION_CATALOG_PATH_ENV, "").strip()
    expected_digest = source.get(ACTIVATION_CATALOG_DIGEST_ENV, "").strip()
    if not raw_path and not expected_digest:
        return ()
    if not raw_path or not expected_digest:
        raise ActivationCatalogError("activation catalog path and digest must be set together")
    if not _SHA256_RE.fullmatch(expected_digest):
        raise ActivationCatalogError("activation catalog digest must be lowercase SHA-256")

    path = Path(raw_path)
    payload = _regular_file(path, "activation catalog", owner_only=True)
    actual_digest = hashlib.sha256(payload).hexdigest()
    if not hmac.compare_digest(actual_digest, expected_digest):
        raise ActivationCatalogError("activation catalog digest does not match Host binding")
    document = _json_object(payload, "activation catalog")
    _exact_keys(document, {"schemaVersion", "packages"}, "activation catalog")
    if document["schemaVersion"] != 1 or not isinstance(document["packages"], list):
        raise ActivationCatalogError("activation catalog schemaVersion/packages are invalid")

    plugins_root = path.resolve(strict=True).parent
    entries = tuple(_parse_package(item, plugins_root) for item in document["packages"])
    identities: set[tuple[str, str]] = set()
    for entry in entries:
        identity = (entry.plugin_id, entry.package_version)
        if identity in identities:
            raise ActivationCatalogError(
                f"duplicate activation for {entry.plugin_id}@{entry.package_version}"
            )
        identities.add(identity)
    return entries
