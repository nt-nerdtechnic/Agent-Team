"""Re-export shim — qwen's reader moved to ``cli_vendors.qwen`` (R2 of the
one-file-per-vendor refactor). Deleted in the cleanup round. Lazy for the
same reason as the aider shim: an eager re-import would re-enter the vendor
module mid-initialization when the import chain starts from the registry.
"""

from __future__ import annotations

from typing import Any

_EXPORTS = (
    "QwenLogReader",
    "qwen_root",
)

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import qwen as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
