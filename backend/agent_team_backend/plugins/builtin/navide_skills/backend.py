"""Backend entry for managed-Skills spawn wiring."""

from __future__ import annotations

from typing import Any

from agent_team_backend.plugins.builtin.navide_skills import skills_wiring


def activate(context: Any) -> None:
    context.register_spawn_transformer(skills_wiring.wire_command)


def deactivate() -> None:
    pass
