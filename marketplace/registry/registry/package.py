"""Reader/validator for `.vsix`-style plugin packages (see FORMAT.md)."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import stat
import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

from .manifest import (
    ManifestLike,
    ManifestError,
    is_manifest_v2,
    manifest_referenced_files,
    parse_manifest,
)
from .path_policy import (
    ArchivePathKind,
    canonical_archive_path,
    portable_archive_collision_key,
)

MANIFEST_NAME = "manifest.json"


class PackageError(ValueError):
    """Raised when an archive is not a valid plugin package."""


class DuplicateJsonKeyError(ValueError):
    """Raised when a manifest object repeats a JSON key."""


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKeyError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _assert_safe_archive_path(path: str, kind: ArchivePathKind) -> str:
    canonical = canonical_archive_path(path, kind)
    if canonical is None:
        raise PackageError(f"unsafe archive entry path: {path}")
    return canonical


def _validate_archive_entries(
    infos: list[zipfile.ZipInfo],
) -> list[tuple[zipfile.ZipInfo, str, str]]:
    seen: set[str] = set()
    regular_paths: set[str] = set()
    descendant_paths: set[str] = set()
    validated: list[tuple[zipfile.ZipInfo, str, str]] = []
    for info in infos:
        kind = _archive_entry_type(info)
        if kind == "directory":
            archive_kind: ArchivePathKind = "directory"
        elif kind == "regular":
            archive_kind = "regular"
        else:
            raise PackageError(f"archive entry is not a regular file: {info.filename}")
        path = _assert_safe_archive_path(info.filename, archive_kind)
        collision_key = portable_archive_collision_key(path)
        if collision_key is None:
            raise PackageError(f"unsafe archive entry path: {info.filename}")
        if collision_key in seen:
            raise PackageError(f"duplicate archive entry: {path}")
        seen.add(collision_key)
        if kind == "regular":
            regular_paths.add(collision_key)
        segments = collision_key.split("/")
        descendant_paths.update(
            "/".join(segments[:index]) for index in range(1, len(segments))
        )
        validated.append((info, path, kind))
    for path in regular_paths:
        if path in descendant_paths:
            raise PackageError(f"archive path collides with regular file ancestor: {path}")
    return validated


def _archive_entry_type(info: zipfile.ZipInfo) -> str:
    mode = ((info.external_attr >> 16) & 0xFFFF) if info.create_system == 3 else 0
    file_type = stat.S_IFMT(mode)
    if info.create_system == 3 and file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
        return "special"
    if info.create_system == 3 and file_type == stat.S_IFDIR:
        return "directory"
    if info.filename.endswith("/") or (
        info.create_system != 3 and (info.external_attr & 0x10) != 0
    ):
        return "directory"
    return "regular"


@dataclass(frozen=True)
class AssetRef:
    """A non-manifest file inside the package."""

    path: str
    size: int
    content_type: str


@dataclass
class LoadedPackage:
    manifest: ManifestLike
    digest: str
    """sha256 hex digest of the raw package bytes."""
    assets: list[AssetRef] = field(default_factory=list)
    raw: bytes = b""


def read_package(data: bytes) -> LoadedPackage:
    """Parse and validate a `.vsix`-style archive.

    Rejects malformed archives with a clear PackageError.
    """
    if not zipfile.is_zipfile(BytesIO(data)):
        raise PackageError("package is not a valid ZIP archive")

    with zipfile.ZipFile(BytesIO(data)) as zf:
        infos = zf.infolist()
        validated_entries = _validate_archive_entries(infos)
        entry_types = {path: kind for _info, path, kind in validated_entries}
        regular_names = {path for path, kind in entry_types.items() if kind == "regular"}
        if MANIFEST_NAME not in regular_names:
            raise PackageError(f"archive is missing {MANIFEST_NAME} at its root")

        manifest_info = next(
            info for info, path, kind in validated_entries if path == MANIFEST_NAME and kind == "regular"
        )
        try:
            manifest_bytes = zf.read(manifest_info)
        except KeyError as exc:  # pragma: no cover - guarded above
            raise PackageError(f"cannot read {MANIFEST_NAME}") from exc

        try:
            manifest_text = manifest_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PackageError(f"{MANIFEST_NAME} is not valid JSON: {exc}") from exc
        if manifest_text.startswith("\ufeff"):
            raise PackageError(f"{MANIFEST_NAME} must not contain UTF-8 BOM")
        try:
            manifest_data = json.loads(
                manifest_text, object_pairs_hook=_reject_duplicate_json_keys
            )
        except (DuplicateJsonKeyError, json.JSONDecodeError) as exc:
            raise PackageError(f"{MANIFEST_NAME} is not valid JSON: {exc}") from exc

        if not isinstance(manifest_data, dict):
            raise PackageError(f"{MANIFEST_NAME} must be a JSON object")

        try:
            manifest = parse_manifest(manifest_data)
        except ManifestError as exc:
            raise PackageError(f"invalid manifest: {exc}") from exc

        file_names = regular_names
        if is_manifest_v2(manifest):
            for path in manifest_referenced_files(manifest):
                if path not in file_names:
                    raise PackageError(
                        f"manifest referenced file '{path}' is not present in the archive"
                    )
        elif manifest.icon and entry_types.get(manifest.icon) != "regular":
            raise PackageError(
                f"manifest.icon '{manifest.icon}' is not present in the archive"
            )

        assets: list[AssetRef] = []
        for info, path, kind in validated_entries:
            if kind != "regular" or path == MANIFEST_NAME:
                continue
            content_type = (
                mimetypes.guess_type(path)[0]
                or "application/octet-stream"
            )
            assets.append(
                AssetRef(
                    path=path,
                    size=info.file_size,
                    content_type=content_type,
                )
            )

    digest = hashlib.sha256(data).hexdigest()
    return LoadedPackage(
        manifest=manifest,
        digest=digest,
        assets=sorted(assets, key=lambda a: a.path),
        raw=data,
    )


def build_package(src_dir: Path | str) -> bytes:
    """Build a `.vsix`-style ZIP from a plugin source directory.

    Zips `manifest.json` (required, at root) plus every other file under
    `src_dir`, then validates the result via `read_package` so a build that the
    reader would reject fails here instead. Returns the archive bytes.
    """
    root = Path(src_dir)
    manifest_path = root / MANIFEST_NAME
    if not manifest_path.is_file():
        raise PackageError(f"{MANIFEST_NAME} not found in {root}")

    files = sorted(p for p in root.rglob("*") if p.is_file())
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            arcname = path.relative_to(root).as_posix()
            zf.write(path, arcname)
    data = buffer.getvalue()
    # Validate the built archive (also surfaces a bad manifest early).
    read_package(data)
    return data
