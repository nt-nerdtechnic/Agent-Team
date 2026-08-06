"""Re-export shim — copilot's reader moved to ``cli_vendors.copilot`` (R4 of
the one-file-per-vendor refactor). Deleted in the cleanup round; lazy for the
same reason as the other vendor shims."""

from __future__ import annotations

from typing import Any

_EXPORTS = (
    "CopilotLogReader",
    "copilot_root",
)

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import copilot as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
