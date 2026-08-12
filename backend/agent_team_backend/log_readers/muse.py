"""Re-export shim — muse's reader lives in ``cli_vendors.muse`` (one file per
vendor). Lazy for the same reason as the qwen shim: an eager re-import would
re-enter the vendor module mid-initialization when the import chain starts
from the registry.
"""

from __future__ import annotations

from typing import Any

_EXPORTS = (
    "MuseLogReader",
    "muse_data_root",
    "muse_sessions_root",
)

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import muse as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
