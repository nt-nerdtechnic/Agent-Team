"""AI Code Review streaming service — structured JSON output."""

from __future__ import annotations

import logging
from typing import AsyncIterator

log = logging.getLogger("agent_team_backend.review_service")

_MAX_REVIEW_DIFF_CHARS = 30_000

REVIEW_SYSTEM_PROMPT = """\
You are a senior software engineer conducting a thorough code review.
Analyse the provided git diff, then respond with ONLY a JSON object wrapped in a ```json code block.

Schema (all fields required):
{
  "summary": "<2-3 sentence overview of overall change quality>",
  "findings": [
    {
      "id": "<short kebab-case slug, unique within this response>",
      "file": "<relative file path, or empty string for cross-cutting issues>",
      "line": <integer line number or null>,
      "severity": "critical" | "warning" | "suggestion",
      "title": "<one-line description>",
      "body": "<detailed explanation with actionable advice>"
    }
  ],
  "verdict": "approve" | "approve_with_comments" | "request_changes"
}

Severity guide:
- critical: must fix before merging (correctness bugs, security vulnerabilities)
- warning: should fix (performance, architecture, maintainability concerns)
- suggestion: optional improvement (naming, style, minor refactor)

Emit an empty findings array [] when there are no notable issues.
Return NO text outside the ```json block.\
"""


async def stream_review(
    diff: str,
    truncated: bool = False,
    workspace_path: str = "",
) -> AsyncIterator[str]:
    """Yield the AI code review text for *diff* (JSON in a ```json block).

    Runs a one-shot Claude CLI prompt and yields the whole answer once (the
    AsyncIterator shape is kept so the caller's collect loop is unchanged).
    *truncated* signals that *diff* was cut by the caller before being passed in.
    """
    from .ai_chat_cli_engine import run_cli_text

    if not diff.strip():
        yield '```json\n{"summary":"No changes to review.","findings":[],"verdict":"approve"}\n```'
        return

    truncated_diff = diff[:_MAX_REVIEW_DIFF_CHARS]
    truncation_note = (
        f"\n\n*(diff truncated to {_MAX_REVIEW_DIFF_CHARS} chars — some changes not shown)*"
        if (truncated or len(diff) > _MAX_REVIEW_DIFF_CHARS)
        else ""
    )

    prompt = (
        f"Please review the following git diff:{truncation_note}\n\n"
        f"```diff\n{truncated_diff}\n```"
    )

    yield await run_cli_text(
        prompt,
        system_prompt=REVIEW_SYSTEM_PROMPT,
        workspace_path=workspace_path,
        timeout=300.0,
    )
