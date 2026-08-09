"""Plan version history: snapshot plan documents on stage transitions.

Snapshots live in ``<workspace>/.agent-team/plans/.history/<plan-stem>/`` and
are named ``<YYYYMMDDTHHMMSS>_<stage><suffix>`` where the suffix follows the
source document: ``.html`` for HTML plans and ``.plan.md`` for markdown plans.
The stage recorded in the newest snapshot filename is the last-seen stage for
that plan; a new snapshot is taken whenever the stage currently on disk differs
(or when the plan has no history yet — the baseline). Detection is
filesystem-driven (see the plans sink wired to GitWatcher in app.py), so it
works for every writer: App-side ``fs.write_file`` calls and agent CLIs editing
the file directly.

Only ``.agent-team/plans/`` is scanned; ``.cursor/plans`` stays frozen legacy
per ``_spec.md`` and is intentionally out of scope (new plans land in
``.agent-team/plans``). Both HTML and markdown snapshots gate on "has a stage",
so stage-less legacy docs are never snapshotted regardless of location.

The ``.history`` directory starts with a dot, so ``fs_service.list_dir``
hides it from default listings and the PlansPane never shows it as a plan.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
from datetime import datetime
from pathlib import Path

from .plan_index import find_nested_plan_roots
from .projects import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.plan_history")

_PLANS_DIR_NAME = "plans"
HISTORY_DIR_NAME = ".history"
MAX_SNAPSHOTS_PER_PLAN = 20

# Python port of the frontend PLAN_META_RE (usePlanHtml.ts): the single
# machine-readable island. Attribute-order tolerant; the `\s` before `id`
# keeps `data-id="plan-meta"` from matching.
_PLAN_META_RE = re.compile(
    r"<script\b[^>]*\s(?:id=\"plan-meta\"|id='plan-meta')[^>]*>([\s\S]*?)</script>",
    re.IGNORECASE,
)

# Stage enum from `.agent-team/plans/_spec.md` (schema v1).
_STAGES = frozenset({"draft", "in-review", "approved", "in-progress", "done", "abandoned"})

_TS_FORMAT = "%Y%m%dT%H%M%S"
_HTML_SUFFIX = ".html"
_MD_SUFFIX = ".plan.md"

# Top-level `stage:` line inside YAML frontmatter. Anchored at line start
# (MULTILINE) so an indented `stage:` nested under some other key can never
# match — only the document-level stage counts.
_MD_FRONTMATTER_RE = re.compile(r"^---\r?\n(.*?)\r?\n---", re.DOTALL)
_MD_STAGE_LINE_RE = re.compile(r"^stage:[ \t]*(.+?)[ \t]*$", re.MULTILINE)


def parse_plan_stage(content: str) -> str | None:
    """Extract the ``stage`` from a plan document's plan-meta JSON island.

    Returns ``None`` when the island is missing, the JSON is malformed, or
    the stage is not one of the spec's values — callers treat such files as
    plain docs and never snapshot them.
    """
    match = _PLAN_META_RE.search(content)
    if match is None:
        return None
    try:
        raw = json.loads(match.group(1))
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    stage = raw.get("stage")
    if isinstance(stage, str) and stage in _STAGES:
        return stage
    return None


def parse_plan_stage_md(content: str) -> str | None:
    """Extract the ``stage`` from a ``.plan.md`` file's YAML frontmatter.

    Robust line parse (no yaml dependency): the frontmatter is the block
    between the leading ``---`` and the next ``---`` line, and the stage is the
    value of the top-level ``stage:`` key. Returns ``None`` when there is no
    frontmatter, no ``stage`` key, or the value is not a spec stage — the
    markdown analogue of "no stage → no snapshot", keeping legacy ``.plan.md``
    files (which carry no stage) safe.
    """
    if not content.startswith("---"):
        return None
    fm = _MD_FRONTMATTER_RE.match(content)
    if fm is None:
        return None
    line = _MD_STAGE_LINE_RE.search(fm.group(1))
    if line is None:
        return None
    stage = line.group(1).strip().strip("\"'")
    return stage if stage in _STAGES else None


def _snapshot_stage(name: str, suffix: str) -> str | None:
    """Stage encoded in a snapshot filename ``<ts>_<stage><suffix>``."""
    if not name.endswith(suffix) or "_" not in name:
        return None
    return name[: -len(suffix)].split("_", 1)[1]


def snapshot_plans(workspace_path: str) -> list[str]:
    """Scan every plans dir in the workspace; snapshot each plan whose current
    stage differs from its newest recorded snapshot (or that has no history yet).

    Covers the workspace's own plans dir and those of nested plan roots, matching
    what the plans list surfaces — a plan the user can see and stage must get a
    snapshot like any other.

    Returns workspace-relative POSIX paths of the snapshots created. Never
    raises: unreadable or meta-less files are skipped.
    """
    root = Path(workspace_path)
    created: list[str] = []
    for rel_root in ["", *find_nested_plan_roots(root)]:
        base = root / rel_root if rel_root else root
        created.extend(_snapshot_plans_dir(base / PROJECT_DIR_NAME / _PLANS_DIR_NAME, root))
    return created


def _snapshot_plans_dir(plans_dir: Path, workspace_root: Path) -> list[str]:
    """Snapshot every staged plan in one plans directory."""
    if not plans_dir.is_dir():
        return []
    created: list[str] = []
    # (path, suffix, stage-parser) for both plan formats, ordered by filename so
    # snapshot creation is deterministic. `.plan.md` files never match `*.html`
    # and vice-versa, so the two globs are disjoint.
    plans: list[tuple[Path, str]] = [
        (p, _HTML_SUFFIX) for p in plans_dir.glob("*.html")
    ] + [(p, _MD_SUFFIX) for p in plans_dir.glob("*.plan.md")]
    for plan, suffix in sorted(plans, key=lambda t: t[0].name):
        name = plan.name
        if name.startswith(("_", ".")) or not plan.is_file():
            continue
        try:
            content = plan.read_bytes().decode("utf-8", errors="replace")
        except OSError:
            continue
        stage = parse_plan_stage(content) if suffix == _HTML_SUFFIX else parse_plan_stage_md(content)
        if stage is None:
            continue
        stem = name[: -len(suffix)]
        history_dir = plans_dir / HISTORY_DIR_NAME / stem
        snapshots = sorted(p.name for p in history_dir.glob(f"*{suffix}")) if history_dir.is_dir() else []
        if snapshots and _snapshot_stage(snapshots[-1], suffix) == stage:
            continue
        ts = datetime.now().astimezone().strftime(_TS_FORMAT)
        target = history_dir / f"{ts}_{stage}{suffix}"
        try:
            history_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(plan, target)
        except OSError as err:
            log.warning("plan snapshot failed for %s: %s", plan, err)
            continue
        created.append(target.relative_to(workspace_root).as_posix())
        _prune(history_dir, suffix)
    return created


def _prune(history_dir: Path, suffix: str) -> None:
    """Keep at most MAX_SNAPSHOTS_PER_PLAN snapshots (of this format) in the
    history dir, dropping the oldest."""
    snapshots = sorted(history_dir.glob(f"*{suffix}"))
    for stale in snapshots[: max(0, len(snapshots) - MAX_SNAPSHOTS_PER_PLAN)]:
        try:
            stale.unlink()
        except OSError:
            pass
