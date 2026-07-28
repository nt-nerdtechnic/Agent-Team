"""CLI conversation-log readers.

Replaces the PTY-output regex approach (vendor_parsers) with direct reads
of the CLI's own JSONL conversation logs. See docs/cli-log-formats.md
for the three formats this module supports.
"""

from .aider import AiderLogReader
from .antigravity import AntigravityLogReader
from .base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenSinkResult,
    TokenUsage,
)
from .claude import ClaudeLogReader
from .codex import CodexLogReader
from .copilot import CopilotLogReader
from .cursor import CursorLogReader
from .grok import GrokLogReader
from .kilo import KiloLogReader
from .kimi import KimiLogReader
from .opencode import OpencodeLogReader
from .pi import PiLogReader
from .qwen import QwenLogReader
from .watcher import LogWatcher

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
