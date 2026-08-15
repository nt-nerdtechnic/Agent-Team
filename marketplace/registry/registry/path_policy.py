"""Pure path policy shared by Manifest v2 references and package archives."""

from __future__ import annotations

import re
import unicodedata
from typing import Literal

ArchivePathKind = Literal["regular", "directory"]

_PACKAGE_PATH_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


def _canonical_relative_path(path: str) -> str | None:
    if (
        not isinstance(path, str)
        or not path
        or "\x00" in path
        or path.startswith(("/", "\\"))
        or "\\" in path
        or (
            len(path) >= 2
            and path[0].isascii()
            and path[0].isalpha()
            and path[1] == ":"
        )
    ):
        return None

    segments = path.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        return None
    return path


def canonical_package_path(path: str) -> str | None:
    """Return a safe Manifest v2 package-relative file path, or None."""
    canonical = _canonical_relative_path(path)
    if canonical is None or _PACKAGE_PATH_RE.fullmatch(canonical) is None:
        return None
    return canonical


def canonical_html_path(path: str) -> str | None:
    """Return a safe Manifest v2 package-relative HTML path, or None."""
    canonical = canonical_package_path(path)
    if canonical is None or not canonical.endswith(".html"):
        return None
    return canonical


def canonical_archive_path(path: str, kind: ArchivePathKind) -> str | None:
    """Return a canonical archive key, or None when the entry is unsafe."""
    candidate = path[:-1] if kind == "directory" and path.endswith("/") else path
    return _canonical_relative_path(candidate)


def portable_archive_collision_key(path: str) -> str | None:
    """Return a portable preflight key without changing the extraction path."""
    segments = [
        unicodedata.normalize("NFC", segment).lower().rstrip(". ")
        for segment in path.split("/")
    ]
    if any(not segment for segment in segments):
        return None
    return "/".join(segments)
