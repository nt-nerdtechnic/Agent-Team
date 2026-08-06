"""Re-export shim — claude's reader moved to ``cli_vendors.claude`` (R12 of
the one-file-per-vendor refactor). Deleted in the cleanup round; lazy like
the other vendor shims. ``encode_claude_cwd`` itself lives in
``log_readers.base`` (shared with qwen)."""

from __future__ import annotations

from typing import Any

from .base import encode_claude_cwd  # noqa: F401

_EXPORTS = ("ClaudeLogReader", "first_user_prompts")

__all__ = ["encode_claude_cwd", *_EXPORTS]


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import claude as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
