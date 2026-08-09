"""Provision plan-document infrastructure into a workspace.

Called from the workspace-registration funnel (app._register_workspace_and_
backfill), which every workspace-open path passes through. Copies the bundled
``plan_assets/_spec.md`` and ``_template.html`` into
``<workspace>/.agent-team/plans/`` so any CLI agent opened in the workspace
can discover the plan rules. Idempotent: existing files are never overwritten,
only missing ones are filled in. Failures are logged and swallowed so
provisioning can never block opening a workspace.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .plan_index import resolve_plan_root
from .projects import ensure_workspace_data_dir

logger = logging.getLogger(__name__)

_ASSETS_DIR = Path(__file__).parent / "plan_assets"
SPEC_FILENAME = "_spec.md"
TEMPLATE_FILENAME = "_template.html"
_WORKSPACE_NAME_PLACEHOLDER = "{{WORKSPACE_NAME}}"


def plan_spec_exists(workspace_path: str) -> bool:
    """True when the workspace's plan root has a provisioned (or hand-installed) spec.

    Resolved the same way :func:`ensure_plan_assets` provisions it, so opening a
    subdirectory of a provisioned project does not report the spec as missing.
    """
    if not workspace_path:
        return False
    try:
        return (
            Path(resolve_plan_root(workspace_path)) / ".agent-team" / "plans" / SPEC_FILENAME
        ).is_file()
    except OSError:
        return False


def ensure_plan_assets(workspace_path: str) -> bool:
    """Idempotently copy missing plan assets into the workspace's plan root.

    The assets land in the project root (:func:`resolve_plan_root`), not in
    whatever subdirectory was opened: a spec file is what tells a CLI agent
    where plans belong, so provisioning one per opened folder is what scatters
    a project's plans across several piles in the first place.

    Returns True when the spec file exists afterwards. Never raises and never
    overwrites an existing file.
    """
    if not workspace_path:
        return False
    workspace_path = resolve_plan_root(workspace_path)
    try:
        if not Path(workspace_path).is_dir():
            return False
        plans_dir = ensure_workspace_data_dir(workspace_path) / "plans"
        plans_dir.mkdir(exist_ok=True)
        for name in (SPEC_FILENAME, TEMPLATE_FILENAME):
            target = plans_dir / name
            if target.exists():
                continue
            content = (_ASSETS_DIR / name).read_text(encoding="utf-8")
            if name == TEMPLATE_FILENAME:
                content = content.replace(
                    _WORKSPACE_NAME_PLACEHOLDER, Path(workspace_path).name
                )
            target.write_text(content, encoding="utf-8")
        return (plans_dir / SPEC_FILENAME).is_file()
    except OSError:
        logger.warning(
            "plan asset provisioning failed for %s", workspace_path, exc_info=True
        )
        return False
