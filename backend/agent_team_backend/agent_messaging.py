"""Cross-workspace inter-CLI messaging registry.

Renderer windows mirror their local pane handles here. The backend is the only
process that sees every workspace at once, so it owns target resolution for
`to: <folder>/<pane>` addresses. Delivery itself stays in the frontend
(injectPane), so the idle gate, per-pair rate limit, queue cap and message log
all keep working exactly as before.

Name uniqueness is per workspace — the same handle may exist in two different
workspaces, and a bare `to: <name>` still resolves only within the sender's own
workspace, which is today's behaviour unchanged.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass
class RegisteredPane:
    pane_id: str
    name: str
    workspace_path: str
    agent_key: str
    #: True while the pane's agent is mid-turn. Reported by the owning window on
    #: turn start/end, so it lags reality by one event at worst — good enough to
    #: tell a caller "it is working, your message will wait", not a lock.
    busy: bool = False

    @property
    def workspace_label(self) -> str:
        """Folder basename used in `<folder>/<pane>` addresses."""
        return os.path.basename(self.workspace_path.rstrip("/")) or self.workspace_path

    @property
    def qualified_name(self) -> str:
        return f"{self.workspace_label}/{self.name}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "pane_id": self.pane_id,
            "name": self.name,
            "workspace_path": self.workspace_path,
            "workspace_label": self.workspace_label,
            "qualified_name": self.qualified_name,
            "agent_key": self.agent_key,
            "busy": self.busy,
        }


@dataclass
class ResolveResult:
    pane: RegisteredPane | None = None
    error: str | None = None
    cross_workspace: bool = False


# pane_id -> RegisteredPane
_PANES: dict[str, RegisteredPane] = {}
# pane_id -> owning WS connection (opaque; only identity is used)
_OWNERS: dict[str, Any] = {}


def _normalize_workspace(path: str) -> str:
    return (path or "").rstrip("/") or (path or "")


def register(
    pane_id: str,
    name: str,
    workspace_path: str,
    agent_key: str = "",
    owner: Any = None,
) -> RegisteredPane:
    """Mirror one window's pane handle. Re-registering the same pane replaces
    its entry, which is how renames propagate."""
    previous = _PANES.get(pane_id)
    entry = RegisteredPane(
        pane_id=pane_id,
        name=name,
        workspace_path=_normalize_workspace(workspace_path),
        agent_key=agent_key,
        # A re-register is a rename or a reconnect, not a state change.
        busy=previous.busy if previous else False,
    )
    _PANES[pane_id] = entry
    if owner is not None:
        _OWNERS[pane_id] = owner
    return entry


def unregister(pane_id: str, owner: Any = None) -> bool:
    """Forget a pane. With ``owner`` given, the entry is kept when another window
    has since claimed the same pane id — which is what a detach does: the child
    window registers the pane before the parent gets around to unregistering it.
    Returns whether the entry was removed."""
    if owner is not None and pane_id in _OWNERS and _OWNERS[pane_id] is not owner:
        return False
    _PANES.pop(pane_id, None)
    _OWNERS.pop(pane_id, None)
    return True


def drop_owner(owner: Any) -> list[str]:
    """Forget every pane mirrored by a disconnecting window. Returns the dropped
    pane ids."""
    dropped = [pane_id for pane_id, own in _OWNERS.items() if own is owner]
    for pane_id in dropped:
        unregister(pane_id)
    return dropped


def get(pane_id: str) -> RegisteredPane | None:
    return _PANES.get(pane_id)


def set_busy(pane_id: str, busy: bool) -> bool:
    """Record whether a pane's agent is mid-turn. Returns whether it changed."""
    entry = _PANES.get(pane_id)
    if entry is None or entry.busy == busy:
        return False
    entry.busy = busy
    return True


def list_panes(workspace_path: str | None = None) -> list[RegisteredPane]:
    """Every mirrored pane, or only those in one workspace. Sorted for stable
    autocomplete ordering."""
    entries = list(_PANES.values())
    if workspace_path is not None:
        target = _normalize_workspace(workspace_path)
        entries = [e for e in entries if e.workspace_path == target]
    return sorted(entries, key=lambda e: (e.workspace_label, e.name))


def workspaces() -> list[str]:
    return sorted({e.workspace_path for e in _PANES.values()})


def _match_workspaces(ws_part: str) -> list[str]:
    """Workspaces addressable as `ws_part`: exact path, folder basename, or a
    trailing path segment run (`parent/proj`)."""
    want = _normalize_workspace(ws_part)
    if not want:
        return []
    exact = [ws for ws in workspaces() if ws == want]
    if exact:
        return exact
    matched: list[str] = []
    for ws in workspaces():
        label = os.path.basename(ws) or ws
        if label == want or ws.endswith("/" + want):
            matched.append(ws)
    return matched


def resolve(from_pane_id: str, to: str) -> ResolveResult:
    """Resolve a `to:` target as seen from the sending pane.

    A bare `name` only ever looks inside the sender's own workspace — the
    existing single-workspace behaviour. A `folder/name` target selects the
    workspace first; an unknown or ambiguous folder is an error rather than a
    silent fallback, so a typo can never inject into the wrong project.
    """
    target = (to or "").strip()
    if not target:
        return ResolveResult(error="empty target")

    sender = _PANES.get(from_pane_id)

    if "/" not in target:
        if sender is None:
            return ResolveResult(error=f'unknown target "{target}"')
        for entry in _PANES.values():
            if entry.workspace_path == sender.workspace_path and entry.name == target:
                return ResolveResult(pane=entry)
        return ResolveResult(error=f'unknown target "{target}"')

    # From here on the target is workspace-qualified.

    ws_part, _, name = target.rpartition("/")
    name = name.strip()
    if not name:
        return ResolveResult(error=f'missing pane name in "{target}"')

    candidates = _match_workspaces(ws_part)
    if not candidates:
        return ResolveResult(error=f'unknown workspace "{ws_part}"')
    if len(candidates) > 1:
        return ResolveResult(
            error=f'ambiguous workspace "{ws_part}" ({len(candidates)} matches) '
            f"— use the full path"
        )

    workspace = candidates[0]
    # Two windows can hold the same workspace path (a detached run group), and
    # each derives handles from its own local registry — so the same name can
    # legitimately appear twice. Refuse to pick one rather than injecting an
    # instruction into whichever pane happened to register first.
    hits = [e for e in _PANES.values() if e.workspace_path == workspace and e.name == name]
    if not hits:
        return ResolveResult(error=f'unknown target "{name}" in workspace "{ws_part}"')
    if len(hits) > 1:
        return ResolveResult(
            error=f'ambiguous target "{name}" in workspace "{ws_part}" '
            f"({len(hits)} panes share that name) — rename one of them"
        )
    entry = hits[0]
    cross = sender is None or sender.workspace_path != entry.workspace_path
    return ResolveResult(pane=entry, cross_workspace=cross)


def sender_display(from_pane_id: str, fallback: str) -> str:
    """How the sender should be shown to a cross-workspace recipient: always
    `<folder>/<pane>` so a reply can address it back."""
    sender = _PANES.get(from_pane_id)
    return sender.qualified_name if sender else fallback


def _reset_for_test() -> None:
    _PANES.clear()
    _OWNERS.clear()
