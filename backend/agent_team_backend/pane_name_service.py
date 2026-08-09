"""LLM-generated titles for CLI panes.

Talks to the same local Ollama endpoint the commit-message generator uses, so
this needs no API key and makes no outbound network call. It is deliberately a
best-effort upgrade: the renderer has already titled the pane with its string
heuristic by the time a request lands here, so every failure path returns a
structured error and the pane simply keeps the heuristic title.

Two things separate this from generate_commit_message, and both come from the
trigger being automatic rather than a button press:

* a semaphore, because restoring a workspace can start a dozen panes at once
  and they would otherwise hit Ollama simultaneously;
* a cooldown, because when Ollama is absent or too slow every new pane would
  otherwise pay for discovering that again.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from . import pane_name_prompt

log = logging.getLogger(__name__)

# Naming is never on a critical path — the pane already has a title. A budget
# this short keeps a stalled Ollama from holding a slot for long.
_BUDGET_S = 20.0

# Titles are tiny; this is roughly 4x the longest legitimate answer and exists
# only to stop a rambling model from streaming for the whole budget.
_NUM_PREDICT = 48

# Low temperature: naming wants the obvious answer, not a creative one.
_TEMPERATURE = 0.1

# Workspace restore can spawn many panes at once. Two at a time keeps the
# local model responsive for the interactive features that share it.
_MAX_CONCURRENCY = 2

# After this many consecutive failures, stop trying for _COOLDOWN_S. Any
# success resets the counter.
_FAILURES_BEFORE_COOLDOWN = 3
_COOLDOWN_S = 120.0


class _Cooldown:
    """Short-circuits requests once the backend has proved unreachable."""

    def __init__(self) -> None:
        self._failures = 0
        self._until = 0.0

    def blocked(self) -> bool:
        return time.monotonic() < self._until

    def record_success(self) -> None:
        self._failures = 0
        self._until = 0.0

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= _FAILURES_BEFORE_COOLDOWN:
            self._until = time.monotonic() + _COOLDOWN_S
            self._failures = 0
            log.info("pane auto-name: backend unreachable, pausing %.0fs", _COOLDOWN_S)

    def reset(self) -> None:
        """Test seam — clears both the counter and an active cooldown."""
        self._failures = 0
        self._until = 0.0


_cooldown = _Cooldown()
_semaphore: asyncio.Semaphore | None = None


def _get_semaphore() -> asyncio.Semaphore:
    # Created lazily so the module imports without a running event loop.
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(_MAX_CONCURRENCY)
    return _semaphore


async def generate_pane_name(
    material: str,
    ollama_url: str,
    model: str,
) -> dict[str, Any]:
    """Return ``{"ok": True, "name": str}`` or ``{"ok": False, "error": str}``.

    Never raises: the caller's fallback is "leave the heuristic title alone",
    so an exception here would only turn a cosmetic miss into a lost message.
    """
    material = (material or "").strip()
    if not material:
        return {"ok": False, "error": "no material", "name": ""}
    if _cooldown.blocked():
        return {"ok": False, "error": "cooling down", "name": ""}

    system = pane_name_prompt.SYSTEM_PROMPT
    prompt = pane_name_prompt.build_user_prompt(material)

    try:
        async with _get_semaphore():
            async with httpx.AsyncClient(
                base_url=ollama_url.rstrip("/"), timeout=_BUDGET_S
            ) as client:
                resp = await client.post("/api/generate", json={
                    "model": model,
                    "system": system,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": _TEMPERATURE,
                        "num_predict": _NUM_PREDICT,
                    },
                })
                resp.raise_for_status()
                data = resp.json()
    except Exception as exc:
        _cooldown.record_failure()
        log.debug("pane auto-name generation failed: %s", exc)
        return {"ok": False, "error": str(exc), "name": ""}

    # Reaching here means the backend answered, so it is up even if this
    # particular answer is unusable — don't count that toward the cooldown.
    _cooldown.record_success()
    name = pane_name_prompt.parse_title(data.get("response") or "")
    if not name:
        return {"ok": False, "error": "no usable title in response", "name": ""}
    return {"ok": True, "name": name}
