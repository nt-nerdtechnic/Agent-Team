"""Re-export shim — cursor's reader moved to ``cli_vendors.cursor`` (R3 of
the one-file-per-vendor refactor). Deleted in the cleanup round. Lazy for the
same reason as the aider shim (registry-first import chains re-enter the
vendor module mid-initialization otherwise)."""

from __future__ import annotations

from typing import Any

_EXPORTS = (
    "CursorLogReader",
    "cursor_project_hash",
)

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import cursor as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
