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
import time
from dataclasses import dataclass
from typing import Any

#: How long a disconnected window's panes stay in the registry, flagged offline,
#: before they are forgotten for good. The renderer's reconnect backoff is
#: capped at 30s (`reconnectMaxMs` in src/shared/wsClient.ts), so this has to
#: outlast a couple of those attempts — a window that is merely reloading or
#: riding out a network blip must not have its panes reported as non-existent.
OFFLINE_GRACE_S = 90.0


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
    #: Monotonic timestamp of when the owning window's WS connection dropped, or
    #: None while it is connected. The pane itself survives that disconnect (its
    #: PTY is owned by the backend), so the entry is kept and flagged instead of
    #: deleted — "offline" and "does not exist" need different answers.
    offline_since: float | None = None

    @property
    def offline(self) -> bool:
        return self.offline_since is not None

    def offline_seconds(self) -> int:
        return 0 if self.offline_since is None else int(time.monotonic() - self.offline_since)

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
            "offline": self.offline,
        }


@dataclass
class ResolveResult:
    pane: RegisteredPane | None = None
    error: str | None = None
    #: Stable machine code for the same failure, plus its substitutions. `error`
    #: stays the English sentence — it is what the MCP tools hand back to a
    #: calling agent — while the UI localizes from the code instead of parsing
    #: that sentence.
    code: str | None = None
    params: dict[str, str] | None = None
    cross_workspace: bool = False


def _resolve_error(code: str, error: str, **params: object) -> ResolveResult:
    return ResolveResult(
        error=error, code=code, params={k: str(v) for k, v in params.items()}
    )


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
        # A reconnecting window re-runs agent_msg.register for every pane it
        # mirrors, which is what clears the offline flag drop_owner set:
        # offline_since starts at None on the fresh entry.
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
    """Flag every pane mirrored by a disconnecting window as offline.

    A dropped WS connection is usually transient — the window reconnects with a
    backoff capped at 30s and re-registers everything — while the panes it
    mirrored keep running the whole time. Deleting the entries here made a
    caller hear "unknown target", i.e. "that pane does not exist", for a pane
    that was merely unreachable. So the entries survive, marked with the moment
    the window went away, and are removed only once OFFLINE_GRACE_S has passed
    without it coming back (see purge_expired).

    The owner mapping is cleared: this connection can never claim the pane
    again, and leaving it in place would make unregister's owner check reject a
    later window's cleanup. Returns the pane ids taken offline.
    """
    now = time.monotonic()
    affected = [pane_id for pane_id, own in _OWNERS.items() if own is owner]
    for pane_id in affected:
        _OWNERS.pop(pane_id, None)
        entry = _PANES.get(pane_id)
        if entry is not None and entry.offline_since is None:
            entry.offline_since = now
    return affected


def purge_expired() -> list[str]:
    """Forget offline panes whose grace period has run out.

    Called from every read path rather than from a timer: the registry is only
    ever consulted synchronously, so a lazy sweep is enough and there is no
    background task to keep alive. Returns the pane ids removed.
    """
    now = time.monotonic()
    expired = [
        pane_id
        for pane_id, entry in _PANES.items()
        if entry.offline_since is not None and now - entry.offline_since >= OFFLINE_GRACE_S
    ]
    for pane_id in expired:
        _PANES.pop(pane_id, None)
        _OWNERS.pop(pane_id, None)
    return expired


def get(pane_id: str) -> RegisteredPane | None:
    purge_expired()
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
    autocomplete ordering. Includes panes whose window is offline — they carry
    the flag, so a caller can see them without being told they are gone."""
    purge_expired()
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


def _prefer_online(hits: list[RegisteredPane]) -> list[RegisteredPane]:
    """A connected pane always wins over an offline one at the same address, so
    the entry a dropped connection left behind cannot shadow — or be mistaken as
    ambiguous with — a pane that is live under that name right now."""
    online = [e for e in hits if not e.offline]
    return online or hits


def _accept(entry: RegisteredPane, to: str, *, cross_workspace: bool = False) -> ResolveResult:
    """Turn a matched pane into a result, refusing it while its window is away.

    Reported separately from "unknown target" because the two demand opposite
    responses: an unknown target means the address is wrong, an offline one
    means the address is right and the answer is to wait or retry.
    """
    if entry.offline_since is None:
        return ResolveResult(pane=entry, cross_workspace=cross_workspace)
    seconds = entry.offline_seconds()
    return _resolve_error(
        "target-offline",
        f'target "{to}" is offline — the Navide window that owns it disconnected '
        f"{seconds}s ago and may be reconnecting. The pane itself still exists, so "
        f"retry instead of reopening it; it is forgotten only after "
        f"{OFFLINE_GRACE_S:.0f}s offline",
        to=to,
        seconds=seconds,
    )


def resolve(from_pane_id: str, to: str) -> ResolveResult:
    """Resolve a `to:` target as seen from the sending pane.

    A bare `name` only ever looks inside the sender's own workspace — the
    existing single-workspace behaviour. A `folder/name` target selects the
    workspace first; an unknown or ambiguous folder is an error rather than a
    silent fallback, so a typo can never inject into the wrong project.
    """
    target = (to or "").strip()
    if not target:
        return _resolve_error("empty-target", "empty target")

    purge_expired()
    sender = _PANES.get(from_pane_id)

    if "/" not in target:
        if sender is None:
            return _resolve_error("unknown-target", f'unknown target "{target}"', to=target)
        local = [
            entry
            for entry in _PANES.values()
            if entry.workspace_path == sender.workspace_path and entry.name == target
        ]
        if local:
            return _accept(_prefer_online(local)[0], target)
        return _resolve_error("unknown-target", f'unknown target "{target}"', to=target)

    # From here on the target is workspace-qualified.

    ws_part, _, name = target.rpartition("/")
    name = name.strip()
    if not name:
        return _resolve_error(
            "missing-pane-name", f'missing pane name in "{target}"', to=target
        )

    candidates = _match_workspaces(ws_part)
    if not candidates:
        return _resolve_error(
            "unknown-workspace", f'unknown workspace "{ws_part}"', ws=ws_part
        )
    if len(candidates) > 1:
        return _resolve_error(
            "ambiguous-workspace",
            f'ambiguous workspace "{ws_part}" ({len(candidates)} matches) '
            f"— use the full path",
            ws=ws_part,
            n=len(candidates),
        )

    workspace = candidates[0]
    # Two windows can hold the same workspace path (a detached run group), and
    # each derives handles from its own local registry — so the same name can
    # legitimately appear twice. Refuse to pick one rather than injecting an
    # instruction into whichever pane happened to register first.
    hits = _prefer_online(
        [e for e in _PANES.values() if e.workspace_path == workspace and e.name == name]
    )
    if not hits:
        return _resolve_error(
            "unknown-target-in-workspace",
            f'unknown target "{name}" in workspace "{ws_part}"',
            name=name,
            ws=ws_part,
        )
    if len(hits) > 1:
        return _resolve_error(
            "ambiguous-target",
            f'ambiguous target "{name}" in workspace "{ws_part}" '
            f"({len(hits)} panes share that name) — rename one of them",
            name=name,
            ws=ws_part,
            n=len(hits),
        )
    entry = hits[0]
    cross = sender is None or sender.workspace_path != entry.workspace_path
    return _accept(entry, target, cross_workspace=cross)


def sender_display(from_pane_id: str, fallback: str) -> str:
    """How the sender should be shown to a cross-workspace recipient: always
    `<folder>/<pane>` so a reply can address it back."""
    sender = _PANES.get(from_pane_id)
    return sender.qualified_name if sender else fallback


def _reset_for_test() -> None:
    _PANES.clear()
    _OWNERS.clear()
