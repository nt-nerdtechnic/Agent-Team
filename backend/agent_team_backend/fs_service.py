"""Filesystem service — safe, workspace-rooted directory listing + CRUD.

Backs the Explorer pane. Every operation is resolved relative to
``workspace_path`` and must stay inside it; the internal ``.agent-team`` dir is
protected, and high-noise dirs (node_modules / .git / …) are flagged so the UI
can avoid auto-expanding them. This is NOT a gitignore filter — real on-disk
contents are listed; git status is only an overlay decided elsewhere.
"""

from __future__ import annotations

import base64
import logging
import os
import stat as stat_mod
import tarfile
import zipfile
from pathlib import Path
from typing import Any

import mammoth
import openpyxl
from send2trash import send2trash

try:
    import chardet as _chardet
    _HAVE_CHARDET = True
except ImportError:
    _HAVE_CHARDET = False

from .projects import PROJECT_DIR_NAME
from .git_security import is_git_internal_path

_log = logging.getLogger(__name__)

# User-facing plan documents live under <workspace>/.agent-team/plans/ and reports
# live under <workspace>/.agent-team/reports/ (see plan_provisioning).
# These subtrees are exempt from the internal-dir protection.
_ALLOWED_AGENT_TEAM_SUBDIRS = frozenset({"plans", "reports"})

# High-noise dirs the UI should not auto-expand (performance, NOT gitignore).
# Mirrors git_watcher._IGNORE_SEGMENTS, plus `.git`.
_NOISE_SEGMENTS = frozenset({
    "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
    "target", ".next", ".nuxt", ".turbo", ".cache", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".idea", ".gradle", ".git",
})

_MAX_DIR_ENTRIES = 2_000  # cap to avoid hanging on huge dirs (e.g. node_modules)


class FsError(Exception):
    """Raised on invalid or unsafe filesystem operations."""


def _resolve_safe(
    workspace_path: str, rel_path: str, *, allow_internal_root: bool = False
) -> Path:
    """Resolve ``rel_path`` under the workspace root, rejecting any escape.

    Guards against ``..`` traversal, absolute-path escapes, symlink escapes
    (via ``resolve()``), and operations touching the internal ``.agent-team``
    directory — except its user-facing ``plans/`` subtree, which is allowed.
    """
    if not workspace_path:
        raise FsError("no workspace selected")
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        raise FsError("workspace not found")

    rel = (rel_path or "").strip().replace("\\", "/").lstrip("/")
    target = (root / rel).resolve()

    if target != root and root not in target.parents:
        raise FsError("path escapes workspace")

    # Listing the workspace's OWN internal dir is allowed so the file tree can
    # show it. The exemption is keyed on the root, not on the directory name:
    # a caller that names `<ws>/.agent-team` as its root does not match this
    # (its `internal_root` would be one level deeper), so the guard below still
    # rejects it — that route is how a caller could otherwise enumerate the
    # internal state. Nothing under the dir opens up either; every child except
    # the allowed subtrees fails the guard on its own path.
    if allow_internal_root and _same_path(target, root / PROJECT_DIR_NAME):
        return target
    _reject_protected_internal_dir(target)
    return target


def _same_path(a: Path, b: Path) -> bool:
    """Whether two paths name the same directory entry on disk.

    ``==`` compares strings, and on a case-insensitive filesystem (APFS by
    default) ``.Agent-Team`` and ``.agent-team`` are different strings for the
    same directory — ``Path.resolve()`` does not fold case, so a string
    comparison lets the internal-dir guard be walked around by capitalising
    one letter. ``samefile`` asks the filesystem, which also covers a symlink
    that points into the internal dir. Either path missing means "not the
    same" — the caller still gets its 404 later, but never a false pass.
    """
    if a == b:
        return True
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _internal_dir_index(parts: tuple[str, ...]) -> int | None:
    """Index of the ``.agent-team`` component in an absolute, resolved path.

    Matched by identity on disk, not by name: for each prefix of the path,
    ask whether it is the same entry as ``<parent>/.agent-team``. A name that
    differs only in case, in Unicode normalisation, or by way of a symlink
    still lands on the internal dir and is still caught.
    """
    for i, part in enumerate(parts):
        if part == PROJECT_DIR_NAME:
            return i
        if i == 0:
            continue
        prefix = Path(*parts[: i + 1])
        candidate = prefix.parent / PROJECT_DIR_NAME
        if _same_path(prefix, candidate):
            return i
    return None


def _resolve_mutation_safe(workspace_path: str, rel_path: str) -> Path:
    """Resolve a path and reject writes to Git's internal directory.

    Host Explorer is allowed to inspect ``.git``. The stronger Git-internal
    guard belongs only on filesystem mutation paths, where changing Git's
    metadata could alter the execution policy or repository state.
    """
    target = _resolve_safe(workspace_path, rel_path)
    root = Path(workspace_path).resolve()
    if is_git_internal_path(root, target):
        raise FsError("the Git internal directory is protected")
    return target


def _reject_git_internal_tree(target: Path) -> None:
    """Reject moving/removing a directory that contains a nested Git dir."""
    if not target.is_dir():
        return
    try:
        if any(child.name == ".git" for child in target.rglob(".git")):
            raise FsError("the Git internal directory is protected")
    except OSError as exc:
        raise FsError("cannot verify Git internal directory protection") from exc


def _reject_protected_internal_dir(target: Path) -> None:
    """Reject paths inside an internal ``.agent-team`` dir, wherever it sits.

    The check walks the whole absolute path rather than only the part below the
    root: a caller may name any existing directory as its root (that is how
    files outside a workspace are opened), and rooting at
    ``<ws>/.agent-team`` would otherwise leave the guard looking at a filename
    where it expects the internal dir. Only the user-facing ``plans/`` and
    ``reports/`` subtrees are allowed through, exactly as before.
    """
    parts = target.parts
    i = _internal_dir_index(parts)
    if i is None:
        return
    # `target` is already resolve()d, so a traversal like
    # `.agent-team/plans/../chat-threads.json` normalizes to a protected
    # path before reaching this check.
    nxt = parts[i + 1] if i + 1 < len(parts) else None
    if nxt not in _ALLOWED_AGENT_TEAM_SUBDIRS:
        raise FsError("the internal directory is protected")


def _entry(root: Path, parent: Path, name: str, is_dir: bool) -> dict[str, Any]:
    child = parent / name
    return {
        "name": name,
        "rel_path": str(child.relative_to(root)),
        "is_dir": is_dir,
        "is_hidden": name.startswith("."),
        # Noise dirs are shown as nodes but the UI should not auto-expand them.
        "is_noise": is_dir and name in _NOISE_SEGMENTS,
    }


def list_dir(workspace_path: str, rel_path: str = "", show_hidden: bool = False) -> dict[str, Any]:
    """List a single directory level (lazy; never recurses).

    Dirs first, then files, each alphabetical. Dotfiles are excluded unless
    ``show_hidden`` is True — including ``.agent-team``, which is surfaced as a
    normal hidden dir but shows only its user-facing ``plans/`` and
    ``reports/`` subtrees; the rest of its contents (the live SQLite database,
    logs, migration leftovers) stay unlistable and unopenable.
    """
    try:
        target = _resolve_safe(workspace_path, rel_path, allow_internal_root=True)
    except FsError as exc:
        return {"ok": False, "error": str(exc)}
    if not target.is_dir():
        return {"ok": False, "error": "not a directory"}

    root = Path(workspace_path).resolve()
    entries: list[dict[str, Any]] = []
    truncated = False
    try:
        # os.scandir() caches is_dir() from the readdir result — no extra stat() per entry.
        with os.scandir(target) as it:
            scan = sorted(it, key=lambda e: (not e.is_dir(), e.name.lower()))
        if len(scan) > _MAX_DIR_ENTRIES:
            scan = scan[:_MAX_DIR_ENTRIES]
            truncated = True
        internal_root = root / PROJECT_DIR_NAME
        for de in scan:
            name = de.name
            if _same_path(target, internal_root) and name not in _ALLOWED_AGENT_TEAM_SUBDIRS:
                continue  # internal state — only the user-facing subtrees show
            if name.startswith(".") and not show_hidden:
                continue
            entries.append(_entry(root, target, name, de.is_dir()))
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    result: dict[str, Any] = {
        "ok": True,
        "entries": entries,
        "rel_path": str(target.relative_to(root)) if target != root else "",
    }
    if truncated:
        result["truncated"] = True
    return result


def list_files_flat(
    workspace_path: str,
    query: str = "",
    max_results: int = 100,
) -> dict[str, Any]:
    """Return a flat list of file rel_paths matching *query* (case-insensitive substring).

    Skips noise directories, hidden files, and binary-ish extensions.
    Used by the AI chat @file autocomplete.
    """
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return {"ok": False, "error": "workspace not found"}
    lower_q = query.lower()
    results: list[str] = []
    _BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
                   ".ttf", ".eot", ".mp4", ".mp3", ".zip", ".gz", ".tar", ".pdf", ".bin",
                   ".lock", ".pyc"}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _NOISE_SEGMENTS and not d.startswith(".")]
        for fn in sorted(filenames):
            if fn.startswith("."):
                continue
            if Path(fn).suffix.lower() in _BINARY_EXT:
                continue
            if lower_q and lower_q not in fn.lower():
                continue
            fp = Path(dirpath) / fn
            try:
                rel = str(fp.relative_to(root))
            except ValueError:
                continue
            results.append(rel)
            if len(results) >= max_results:
                return {"ok": True, "files": results, "truncated": True}
    return {"ok": True, "files": results, "truncated": False}


def glob_files(
    workspace_path: str,
    pattern: str,
    max_results: int = 50,
) -> dict[str, Any]:
    """Return rel_paths matching *pattern* (glob) under the workspace root.

    Noise directories are excluded. At most *max_results* files are returned.
    """
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return {"ok": False, "error": "workspace not found"}
    if not pattern:
        return {"ok": False, "error": "pattern required"}
    # Reject patterns with .. components or absolute paths to prevent traversal.
    pattern_parts = pattern.replace("\\", "/").split("/")
    if ".." in pattern_parts or pattern.startswith("/") or pattern.startswith("\\"):
        return {"ok": False, "error": "invalid pattern"}

    _BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
                   ".ttf", ".eot", ".mp4", ".mp3", ".zip", ".gz", ".tar", ".pdf",
                   ".bin", ".lock", ".pyc"}
    root_str = str(root) + os.sep
    try:
        matches: list[str] = []
        for fp in sorted(root.glob(pattern)):
            if not fp.is_file():
                continue
            # Verify the resolved path stays inside the workspace (guards symlinks).
            try:
                real = fp.resolve(strict=True)
            except OSError:
                continue
            if not (str(real) == str(root) or str(real).startswith(root_str)):
                continue
            # skip noise dirs inside the match
            parts = fp.relative_to(root).parts
            if any(p in _NOISE_SEGMENTS or p.startswith(".") for p in parts[:-1]):
                continue
            if fp.suffix.lower() in _BINARY_EXT:
                continue
            matches.append(str(fp.relative_to(root)))
            if len(matches) >= max_results:
                return {"ok": True, "files": matches, "truncated": True}
        return {"ok": True, "files": matches, "truncated": False}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def mkdir(workspace_path: str, rel_path: str) -> dict[str, Any]:
    try:
        target = _resolve_mutation_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("invalid name")
        if target.exists():
            raise FsError("already exists")
        target.mkdir(parents=True, exist_ok=False)
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def create_file(workspace_path: str, rel_path: str, content: str = "") -> dict[str, Any]:
    try:
        target = _resolve_mutation_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("invalid name")
        if target.exists():
            raise FsError("already exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def rename(workspace_path: str, src_rel: str, dst_rel: str) -> dict[str, Any]:
    try:
        src = _resolve_mutation_safe(workspace_path, src_rel)
        dst = _resolve_mutation_safe(workspace_path, dst_rel)
        if src == Path(workspace_path).resolve():
            raise FsError("cannot rename the workspace root")
        _reject_git_internal_tree(src)
        _reject_git_internal_tree(dst)
        if src == dst:
            raise FsError("source and destination are the same path")
        if not src.exists():
            raise FsError("source not found")
        if dst.exists():
            raise FsError("destination already exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


_BINARY_EXTENSIONS = {
    # Images
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".svg",
    ".avif", ".heic", ".heif", ".raw",
    # Audio / Video
    ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".webm", ".mkv", ".avi",
    ".mov", ".wmv",
    # Fonts
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    # Archives / compiled
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".ear",
    ".pyc", ".pyo", ".class", ".so", ".dylib", ".dll", ".exe", ".bin", ".a", ".o",
    # Documents
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    # Database
    ".db", ".sqlite", ".sqlite3",
}

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".svg", ".avif"}

_ENCODINGS_TO_TRY = [
    "utf-8-sig",   # UTF-8 with BOM  (must come before utf-8)
    "utf-16",      # UTF-16 with BOM (auto-detects LE/BE)
    "utf-8",
    "latin-1",     # always succeeds — last resort for Western text
]

# Normalise encoding name for display (match VS Code labels).
_ENC_DISPLAY: dict[str, str] = {
    "utf_8": "UTF-8", "utf_8_sig": "UTF-8 with BOM",
    "utf_16": "UTF-16", "utf_16_le": "UTF-16 LE", "utf_16_be": "UTF-16 BE",
    "latin_1": "Latin-1", "latin-1": "Latin-1",
    "cp1252": "Windows 1252", "cp1251": "Windows 1251",
    "gb2312": "GB2312", "gbk": "GBK", "big5": "Big5",
    "shift_jis": "Shift JIS", "euc_jp": "EUC-JP", "euc_kr": "EUC-KR",
}
# Reverse map so write_file also accepts the display labels read_file returns.
_ENC_FROM_LABEL: dict[str, str] = {v: k for k, v in _ENC_DISPLAY.items()}


def _detect_encoding(raw: bytes) -> str:
    """Return the best encoding guess for *raw* bytes."""
    if _HAVE_CHARDET:
        result = _chardet.detect(raw[:65536])
        enc = (result.get("encoding") or "").lower().replace("-", "_")
        confidence = result.get("confidence", 0) or 0
        if enc and confidence >= 0.70:
            # Normalise common aliases
            enc = {
                "ascii": "utf_8",
                "utf_8_sig": "utf_8_sig",
                "utf_16_le": "utf_16",
                "utf_16_be": "utf_16",
                "iso_8859_1": "latin_1",
                "windows_1252": "cp1252",
                "windows_1251": "cp1251",
                "gb2312": "gb2312",
                "gbk": "gbk",
                "big5": "big5",
                "shift_jis": "shift_jis",
                "euc_jp": "euc_jp",
                "euc_kr": "euc_kr",
            }.get(enc, enc)
            return enc
    # BOM detection fallback
    if raw[:3] == b"\xef\xbb\xbf":
        return "utf_8_sig"
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return "utf_16"
    return "utf_8"


def _is_binary_content(raw: bytes) -> bool:
    """Heuristic: if > 0.3% of first 8 KB are null bytes, treat as binary."""
    sample = raw[:8192]
    if not sample:
        return False
    null_count = sample.count(b"\x00")
    return null_count / len(sample) > 0.003


_READ_SIZE_LIMIT = 5 * 1024 * 1024  # 5 MB — cap editor reads; bigger payloads stall WS serialization


def read_file(workspace_path: str, rel_path: str, encoding_override: str | None = None) -> dict[str, Any]:
    """Read a file, auto-detecting encoding.

    If *encoding_override* is given, skip detection and decode with that codec.


    Returns:
        ok=True  → {"ok": True, "content": str, "encoding": str, "bom": bool,
                     "mtime": float}
        ok=False → {"ok": False, "error": str, "is_binary": bool,
                     "size": int, "ext": str}
    """
    try:
        target = _resolve_safe(workspace_path, rel_path)
        if not target.is_file():
            raise FsError("not a file")
        st = target.stat()
        size = st.st_size
        ext = target.suffix.lower()

        # Fast-path: known binary extension
        if ext in _BINARY_EXTENSIONS:
            return {
                "ok": False,
                "error": "binary file",
                "is_binary": True,
                "is_image": ext in _IMAGE_EXTENSIONS,
                "size": size,
                "ext": ext,
            }

        if size > _READ_SIZE_LIMIT:
            return {
                "ok": False,
                "error": f"file too large ({size / (1024 * 1024):.1f} MB > 5 MB)",
                "is_binary": False,
                "size": size,
                "ext": ext,
            }

        raw = target.read_bytes()

        # Heuristic binary check
        if _is_binary_content(raw):
            return {
                "ok": False,
                "error": "binary file",
                "is_binary": True,
                "is_image": False,
                "size": size,
                "ext": ext,
            }

        # Encoding detection + decode
        if encoding_override:
            detected = encoding_override.replace("-", "_").lower()
        else:
            detected = _detect_encoding(raw)
        bom = detected in ("utf_8_sig", "utf_16")

        # Try detected encoding first, then fallbacks
        order = [detected] + ([e for e in _ENCODINGS_TO_TRY if e.replace("-", "_") != detected.replace("-", "_")] if not encoding_override else [])
        content: str | None = None
        used_enc = detected
        for enc in order:
            try:
                content = raw.decode(enc)
                used_enc = enc
                break
            except (UnicodeDecodeError, LookupError):
                continue

        if content is None:
            # latin-1 never fails — absolute last resort
            content = raw.decode("latin-1", errors="replace")
            used_enc = "latin-1"

        enc_label = _ENC_DISPLAY.get(used_enc.replace("-", "_"), used_enc.upper())

        return {
            "ok": True, "content": content, "encoding": enc_label, "bom": bom,
            "mtime": st.st_mtime,
        }

    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc), "is_binary": False, "size": 0, "ext": ""}


# MIME type per image extension. The renderer renders the returned data URL in
# an <img>, which works in dev (http origin) and prod (file:// origin) alike —
# unlike a raw file:// src, which webSecurity blocks from the dev http origin.
_IMAGE_MIME: dict[str, str] = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
    ".ico": "image/x-icon", ".svg": "image/svg+xml", ".avif": "image/avif",
}


_IMAGE_SIZE_LIMIT = 20 * 1024 * 1024  # 20 MB — cap previews; base64+WS framing of bigger blobs stalls the app


def read_image(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Read an image file and return it as a base64 ``data:`` URL.

    Returns:
        ok=True  → {"ok": True, "data_url": str, "mime": str, "size": int}
        ok=False → {"ok": False, "error": str}

    Rejects non-image extensions and images larger than 20 MB.
    """
    try:
        target = _resolve_safe(workspace_path, rel_path)
        if not target.is_file():
            raise FsError("not a file")
        ext = target.suffix.lower()
        mime = _IMAGE_MIME.get(ext)
        if mime is None:
            return {"ok": False, "error": "not an image"}
        size = target.stat().st_size
        if size > _IMAGE_SIZE_LIMIT:
            return {"ok": False, "error": f"image too large ({size / (1024 * 1024):.1f} MB > 20 MB)"}
        b64 = base64.b64encode(target.read_bytes()).decode("ascii")
        return {"ok": True, "data_url": f"data:{mime};base64,{b64}", "mime": mime, "size": size}
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


_ARCHIVE_SIZE_LIMIT = 100 * 1024 * 1024  # 100 MB — cap archive listing reads
_ARCHIVE_MAX_ENTRIES = 2_000  # cap entries returned per archive listing


def list_archive(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """List entries of a .zip / .tar / .tar.gz / .tgz archive.

    Returns:
        ok=True  → {"ok": True, "entries": [{"name", "size", "is_dir"}],
                     "total_entries": int, "truncated": bool}
        ok=False → {"ok": False, "error": str}

    At most 2000 entries are returned (truncated=True beyond that); archives
    larger than 100 MB are rejected.
    """
    try:
        target = _resolve_safe(workspace_path, rel_path)
        if not target.is_file():
            raise FsError("not a file")
        size = target.stat().st_size
        if size > _ARCHIVE_SIZE_LIMIT:
            return {"ok": False, "error": f"archive too large ({size / (1024 * 1024):.1f} MB > 100 MB)"}

        name = target.name.lower()
        entries: list[dict[str, Any]] = []
        total = 0
        if name.endswith(".zip"):
            with zipfile.ZipFile(target) as zf:
                for info in zf.infolist():
                    if info.flag_bits & 0x1:
                        return {"ok": False, "error": "archive is encrypted"}
                    total += 1
                    if len(entries) < _ARCHIVE_MAX_ENTRIES:
                        entries.append({
                            "name": info.filename,
                            "size": info.file_size,
                            "is_dir": info.is_dir(),
                        })
        elif name.endswith((".tar", ".tar.gz", ".tgz")):
            with tarfile.open(target, "r:*") as tf:
                for member in tf:
                    total += 1
                    if len(entries) < _ARCHIVE_MAX_ENTRIES:
                        entries.append({
                            "name": member.name,
                            "size": member.size,
                            "is_dir": member.isdir(),
                        })
        else:
            return {"ok": False, "error": "unsupported archive type (expected .zip, .tar, .tar.gz or .tgz)"}
        return {
            "ok": True,
            "entries": entries,
            "total_entries": total,
            "truncated": total > len(entries),
        }
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    except (zipfile.BadZipFile, tarfile.TarError) as exc:
        return {"ok": False, "error": f"corrupted archive: {exc}"}


_OFFICE_SIZE_LIMIT = 10 * 1024 * 1024  # 10 MB — cap office conversion reads
_XLSX_MAX_ROWS = 1_000  # per sheet
_XLSX_MAX_COLS = 100  # per row


def convert_office(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Convert an office document for preview.

    Returns:
        .docx → {"ok": True, "kind": "docx", "html": str}  (mammoth)
        .xlsx → {"ok": True, "kind": "xlsx",
                  "sheets": [{"name", "rows": list[list[str]], "truncated"}]}
                 (openpyxl read-only; 1000 rows × 100 cols per sheet)
        ok=False → {"ok": False, "error": str}

    Files larger than 10 MB are rejected.
    """
    try:
        target = _resolve_safe(workspace_path, rel_path)
        if not target.is_file():
            raise FsError("not a file")
        size = target.stat().st_size
        if size > _OFFICE_SIZE_LIMIT:
            return {"ok": False, "error": f"file too large ({size / (1024 * 1024):.1f} MB > 10 MB)"}
        ext = target.suffix.lower()
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}

    if ext == ".docx":
        try:
            with target.open("rb") as fh:
                result = mammoth.convert_to_html(fh)
        except Exception as exc:  # noqa: BLE001 — mammoth raises many zip/xml error types
            return {"ok": False, "error": f"cannot convert docx: {exc}"}
        return {"ok": True, "kind": "docx", "html": result.value}

    if ext == ".xlsx":
        wb = None
        try:
            wb = openpyxl.load_workbook(target, read_only=True, data_only=True)
            sheets: list[dict[str, Any]] = []
            for sheet in wb.worksheets:
                rows: list[list[str]] = []
                truncated = False
                for row in sheet.iter_rows(values_only=True):
                    if len(rows) >= _XLSX_MAX_ROWS:
                        truncated = True
                        break
                    if len(row) > _XLSX_MAX_COLS:
                        truncated = True
                        row = row[:_XLSX_MAX_COLS]
                    rows.append(["" if cell is None else str(cell) for cell in row])
                sheets.append({"name": sheet.title, "rows": rows, "truncated": truncated})
        except Exception as exc:  # noqa: BLE001 — openpyxl raises many zip/xml error types
            return {"ok": False, "error": f"cannot read xlsx: {exc}"}
        finally:
            if wb is not None:
                wb.close()
        return {"ok": True, "kind": "xlsx", "sheets": sheets}

    return {"ok": False, "error": "unsupported office file type (expected .docx or .xlsx)"}


_WRITE_SIZE_LIMIT = 50 * 1024 * 1024  # 50 MB — prevent disk-fill via AI tool


def write_file(
    workspace_path: str,
    rel_path: str,
    content: str,
    encoding: str = "utf-8",
    expected_mtime: float | None = None,
) -> dict[str, Any]:
    """Overwrite (or create) a text file with `content`.

    ``encoding`` is the codec used to encode ``content`` (read_file's display
    labels, e.g. "UTF-8 with BOM", are accepted too). When ``expected_mtime``
    is given and the file on disk has a different mtime, the write is refused
    with ``conflict=True`` so the caller can surface a conflict dialog.
    Success responses include the file's new ``mtime``.
    """
    try:
        target = _resolve_mutation_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("invalid path")
        if target.exists() and target.is_dir():
            raise FsError("path is a directory")
        codec = _ENC_FROM_LABEL.get(encoding, encoding)
        try:
            encoded = content.encode(codec)
        except (LookupError, UnicodeEncodeError) as exc:
            return {"ok": False, "error": f"cannot encode content as {encoding}: {exc}"}
        if len(encoded) > _WRITE_SIZE_LIMIT:
            raise FsError(f"content too large ({len(encoded) // 1024} KB; limit 50 MB)")
        orig_mode: int | None = None
        if target.exists():
            st = target.stat()
            orig_mode = st.st_mode
            if expected_mtime is not None and abs(st.st_mtime - expected_mtime) > 1e-4:
                return {
                    "ok": False,
                    "conflict": True,
                    "mtime": st.st_mtime,
                    "error": "file changed on disk",
                }
        target.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: write to a temp file then rename so a crash can't
        # leave the target half-written/truncated.
        tmp = target.with_suffix(target.suffix + ".tmp")
        try:
            tmp.write_bytes(encoded)
            if orig_mode is not None:
                # os.replace swaps the inode; keep the original permission
                # bits (e.g. a script's executable bit) on the replacement.
                os.chmod(tmp, stat_mod.S_IMODE(orig_mode))
            os.replace(tmp, target)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "mtime": target.stat().st_mtime}


def stat_path(abs_path: str) -> dict[str, Any]:
    """Check whether an absolute filesystem path exists as a regular file.

    Intentionally bypasses the workspace restriction — terminal output may
    reference files anywhere on disk (e.g. system libraries, other projects).
    Read-only: no content is returned, only existence.
    """
    try:
        # expanduser: terminal output often prints '~/...' paths verbatim.
        p = Path(abs_path).expanduser().resolve()
        return {"ok": True, "exists": p.is_file()}
    except Exception:
        return {"ok": True, "exists": False}


def delete(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Move a file or directory (including non-empty ones) to the OS Trash.

    Recoverable by design: an accidental delete can be restored from the
    system Trash/Recycle Bin instead of being gone forever. If the trash is
    unavailable, leave the original in place and return an error.
    """
    try:
        target = _resolve_mutation_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("cannot delete the workspace root")
        _reject_git_internal_tree(target)
        if not target.exists():
            raise FsError("not found")
        try:
            send2trash(str(target))
        except Exception as trash_exc:  # noqa: BLE001 -- log any trash failure before propagating
            _log.warning(
                "send2trash failed for %s (%s); keeping original",
                target,
                trash_exc,
            )
            raise
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}
