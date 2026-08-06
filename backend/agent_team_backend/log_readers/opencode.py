"""Re-export shim — opencode's reader moved to ``cli_vendors.opencode`` (R6
of the one-file-per-vendor refactor). Deleted in the cleanup round; lazy for
the same reason as the other vendor shims. kilo's reader (an OpenCode fork)
keeps inheriting through here until its own round."""

from __future__ import annotations

from typing import Any

_EXPORTS = ("OpencodeLogReader",)

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import opencode as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
