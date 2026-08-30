"""Parse/serialize layer for the ``plan-meta`` JSON island in plan HTML files.

Lives in the plugin because the plan document format is the plugin's own:
nothing in core reads or writes this island, and only ``plan_tools`` imports
this module. Core keeps ``plan_index`` (which the Plan window's WS handlers
need) and ``plan_provisioning`` (which app.py runs at workspace registration).

Python equivalent of the frontend ``usePlanHtml.ts`` composable, scoped to the
two operations backend callers need:

- :func:`parse_plan_meta` — extract and JSON-parse the single
  ``<script type="application/json" id="plan-meta">`` island.
- :func:`write_plan_meta` — replace only the island's JSON payload (every byte
  outside it is preserved verbatim), then re-sync the visible markup that the
  spec (``.agent-team/plans/_spec.md``, "Update discipline") requires to mirror
  the meta: the header stage pill, each todo's ``data-status`` attribute and
  ``<span class="st">`` pill, and each review note's ``data-resolved`` flag.

Unknown/extra fields in the meta dict round-trip unchanged — the island is
serialized from the caller's dict as-is (2-space indent, non-ASCII preserved),
matching the frontend's ``JSON.stringify(meta, null, 2)`` output shape.
"""

from __future__ import annotations

import json
import re
from typing import Any

# Python port of the frontend PLAN_META_RE (usePlanHtml.ts): the single
# machine-readable island. Attribute-order tolerant; the `\s` before `id`
# keeps `data-id="plan-meta"` from matching.
_PLAN_META_RE = re.compile(
    r"<script\b[^>]*\s(?:id=\"plan-meta\"|id='plan-meta')[^>]*>([\s\S]*?)</script>",
    re.IGNORECASE,
)

# Enums from `.agent-team/plans/_spec.md` (schema v1). Markup sync is gated on
# these so an unexpected meta value can never be injected into HTML; the JSON
# island itself still stores whatever the caller passed.
PLAN_STAGES = frozenset({"draft", "in-review", "approved", "in-progress", "done", "abandoned"})
TODO_STATUSES = frozenset({"pending", "in-progress", "done", "skipped"})
#: Who a todo is waiting on. "agent" is the default and is never written — an
#: absent key means the agent will do it. "user" marks the things nobody else
#: can: a manual verification, a decision, a credential only they hold. Without
#: this, a finished document whose last item is "verify on a real machine" is
#: indistinguishable from an untouched plan.
TODO_OWNERS = frozenset({"agent", "user"})

# Header stage pill: `<span class="pill STAGE">STAGE</span>` (first occurrence).
_STAGE_PILL_RE = re.compile(
    r"(<span\b[^>]*class=[\"']pill\s+)[a-z-]+([\"'][^>]*>)[\s\S]*?(</span>)",
    re.IGNORECASE,
)

_DATA_STATUS_RE = re.compile(r"data-status=[\"'][^\"']*[\"']", re.IGNORECASE)
_DATA_RESOLVED_RE = re.compile(r"data-resolved=[\"'][^\"']*[\"']", re.IGNORECASE)
_ST_SPAN_RE = re.compile(
    r"(<span\b[^>]*class=[\"']st[\"'][^>]*>)[\s\S]*?(</span>)",
    re.IGNORECASE,
)


def parse_plan_meta(html: str) -> dict[str, Any] | None:
    """Extract and JSON-parse the ``plan-meta`` island.

    Returns ``None`` when the island is missing, the JSON is malformed, or the
    payload is not an object — never raises on bad input.
    """
    match = _PLAN_META_RE.search(html)
    if match is None:
        return None
    try:
        raw = json.loads(match.group(1))
    except ValueError:
        return None
    return raw if isinstance(raw, dict) else None


def write_plan_meta(html: str, meta: dict[str, Any]) -> str:
    """Serialize ``meta`` into the island, then re-sync the visible markup.

    Only the island's inner JSON is replaced (surrounding HTML preserved
    byte-for-byte); markup sync is best-effort and skips anything it cannot
    find — the island stays authoritative per the spec. Returns ``html``
    unchanged when no island exists.
    """
    match = _PLAN_META_RE.search(html)
    if match is None:
        return html
    # JSON-escape every "<" (unicode escape) so strings like "</script>" in the
    # meta cannot terminate the script block early; json.loads decodes it back.
    payload = json.dumps(meta, indent=2, ensure_ascii=False).replace("<", "\\u003c")
    content = f"{html[: match.start(1)]}\n{payload}\n{html[match.end(1) :]}"

    stage = meta.get("stage")
    if isinstance(stage, str) and stage in PLAN_STAGES:
        content = _sync_stage_markup(content, stage)

    todos = meta.get("todos")
    if isinstance(todos, list):
        for todo in todos:
            if not isinstance(todo, dict):
                continue
            todo_id, status = todo.get("id"), todo.get("status")
            if isinstance(todo_id, str) and todo_id and isinstance(status, str) and status in TODO_STATUSES:
                content = _sync_todo_markup(content, todo_id, status)

    notes = meta.get("reviewNotes")
    if isinstance(notes, list):
        for note in notes:
            if not isinstance(note, dict):
                continue
            note_id = note.get("id")
            if isinstance(note_id, str) and note_id:
                content = _sync_note_resolved_markup(content, note_id, note.get("resolved") is True)

    return content


def _sync_stage_markup(content: str, stage: str) -> str:
    """Rewrite the first header stage pill's class token and visible text."""
    return _STAGE_PILL_RE.sub(rf"\g<1>{stage}\g<2>{stage}\g<3>", content, count=1)


def _sync_todo_markup(content: str, todo_id: str, status: str) -> str:
    """Update a todo row: ``data-status`` on its ``<li>`` and the ``.st`` pill text."""
    li_re = re.compile(
        rf"<li\b[^>]*data-todo-id=[\"']{re.escape(todo_id)}[\"'][^>]*>", re.IGNORECASE
    )
    match = li_re.search(content)
    if match is None:
        return content
    open_tag = _DATA_STATUS_RE.sub(f'data-status="{status}"', match.group(0), count=1)
    after_tag = match.end()
    close_idx = content.find("</li>", after_tag)
    scope_end = len(content) if close_idx == -1 else close_idx
    scope = _ST_SPAN_RE.sub(rf"\g<1>{status}\g<2>", content[after_tag:scope_end], count=1)
    return content[: match.start()] + open_tag + scope + content[scope_end:]


def _sync_note_resolved_markup(content: str, note_id: str, resolved: bool) -> str:
    """Update ``data-resolved`` on a review note's ``<li data-note-id>``."""
    li_re = re.compile(
        rf"<li\b[^>]*data-note-id=[\"']{re.escape(note_id)}[\"'][^>]*>", re.IGNORECASE
    )
    match = li_re.search(content)
    if match is None:
        return content
    value = "true" if resolved else "false"
    open_tag = _DATA_RESOLVED_RE.sub(f'data-resolved="{value}"', match.group(0), count=1)
    return content[: match.start()] + open_tag + content[match.end() :]
