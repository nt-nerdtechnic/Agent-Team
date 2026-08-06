"""CLI conversation-log readers.

Replaces the PTY-output regex approach (vendor_parsers) with direct reads
of the CLI's own JSONL conversation logs. See docs/cli-log-formats.md
for the three formats this module supports.
"""

from .base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenSinkResult,
    TokenUsage,
)
from .claude import ClaudeLogReader
from .codex import CodexLogReader
from .grok import GrokLogReader
from .kimi import KimiLogReader
from .watcher import LogWatcher

# Readers migrated to cli_vendors/ resolve lazily (PEP 562): their vendor
# module imports .base from THIS package, so an eager import here would
# re-enter a vendor module that is still executing when the import chain
# starts from cli_vendors.registry. Deferring until first use lets both
# packages finish initializing first.
_MIGRATED_READERS = {
    "AiderLogReader": "aider",
    "AntigravityLogReader": "antigravity",
    "CopilotLogReader": "copilot",
    "CursorLogReader": "cursor",
    "KiloLogReader": "kilo",
    "OpencodeLogReader": "opencode",
    "PiLogReader": "pi",
    "QwenLogReader": "qwen",
}


def __getattr__(name: str):
    vendor_module = _MIGRATED_READERS.get(name)
    if vendor_module is not None:
        import importlib

        module = importlib.import_module(
            f"..cli_vendors.{vendor_module}", __name__
        )
        return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "ActivityEvent",
    "IncrementalParseResult",
    "LogReader",
    "TokenUsage",
    "TokenSinkResult",
    "AiderLogReader",
    "AntigravityLogReader",
    "ClaudeLogReader",
    "CodexLogReader",
    "CopilotLogReader",
    "CursorLogReader",
    "GrokLogReader",
    "KiloLogReader",
    "KimiLogReader",
    "OpencodeLogReader",
    "PiLogReader",
    "QwenLogReader",
    "LogWatcher",
]
