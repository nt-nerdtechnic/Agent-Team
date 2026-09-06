"""This machine's stable device identity.

Cross-device agent messaging addresses a *device*, not a person: one member
may run Navide on several machines, and a message A sends to B must not be
echoed back to A — an agent that receives its own message answers it and
loops. That requires an id which stays the same across restarts, so a remote
roster never accumulates ghost devices and a peer's cached addressing keeps
resolving.

**Two things, not one.** ``machine_id`` names this physical machine and never
changes. A ``node`` id names *this machine inside one account*, and there is one
per member id.

They were the same value once, and that made a machine something an account
could claim: register a second account from a machine already known to the
server and ``auth.hello`` answers ``DEVICE_CONFLICT`` for ever, because the id
belongs to the first member. The account view showed "access token rejected",
which sent people back to retype a password that was never wrong. What the
server refuses is not the credential and not the machine — it is the *pair*, and
so the pair is what carries an id. (Tailscale splits the same way: a machine key
that never leaves the device, and a node key per tailnet.)

Ids are UUID4s stored in ``device-identity.json`` under the app data dir
(device-level, not per-workspace: it identifies the machine, not a project).
They are generated on demand and written back immediately. A missing, empty,
truncated or otherwise unparseable file is regenerated rather than fatal —
the backend must still start — but every generation is logged, because to a
peer a new id means a new machine.

Like plan_mcp_auth there is no in-memory cache: the file is tiny, and reading
through keeps ``AGENT_TEAM_DATA_DIR`` isolation honest for tests.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Any

from agent_team_backend.applog import app_data_dir

log = logging.getLogger(__name__)

IDENTITY_FILENAME = "device-identity.json"

_lock = threading.Lock()


def device_identity_path() -> Path:
    return app_data_dir() / IDENTITY_FILENAME


def _valid(value: Any) -> str:
    """*value* if it is a UUID string, else "". Never raises."""
    if not isinstance(value, str):
        return ""
    try:
        uuid.UUID(value)
    except ValueError:
        return ""
    return value


def _read_doc() -> dict[str, Any]:
    """The identity file as a dict, or {} when it is missing or unusable."""
    path = device_identity_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        log.warning("device identity file %s is unreadable (%s)", path, exc)
        return {}
    return raw if isinstance(raw, dict) else {}


def _read() -> str:
    """Return the stored legacy device id, or "" if missing or unusable."""
    value = _valid(_read_doc().get("device_id"))
    if not value:
        log.debug("device identity file has no usable device_id")
    return value


def _write_doc(doc: dict[str, Any]) -> None:
    """Persist *doc*, replacing the file atomically.

    Not for secrecy — an id is not a credential, the server only recognises
    one and never issues it — but a half-written file would read back as
    corrupt and mint new ids, which every peer sees as a different machine.
    """
    path = device_identity_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def device_id() -> str:
    """The legacy machine-wide id, generating and persisting it on first use.

    Still the answer for everything that is not talking to a server: local
    addressing (``agent_messaging.is_local_device``) asks "is this segment this
    machine", and that question has nothing to do with which account is signed
    in. Anything reaching a Navide-Server wants ``node_id`` instead.
    """
    existing = _read()
    if existing:
        return existing
    with _lock:
        # Re-read under the lock: a concurrent caller may have just written it.
        existing = _read()
        if existing:
            return existing
        value = str(uuid.uuid4())
        doc = _read_doc()
        doc["device_id"] = value
        _write_doc(doc)
        log.info("generated a new device id %s at %s", value, device_identity_path())
        return value


def machine_id() -> str:
    """This physical machine, for as long as the file survives.

    Never sent to a server and never used for addressing. It exists so that a
    future "which accounts is this machine signed into" view has something to
    group by, and so that the node ids below have an owner that outlives them.
    Seeded from the legacy id when there is one, which keeps a machine that has
    been running for months recognisably the same machine.
    """
    with _lock:
        doc = _read_doc()
        existing = _valid(doc.get("machine_id"))
        if existing:
            return existing
        value = _valid(doc.get("device_id")) or str(uuid.uuid4())
        doc["machine_id"] = value
        _write_doc(doc)
        return value


def node_id_for(member_id: str) -> str:
    """The id to present to a server when authenticating as *member_id*.

    **Nothing is written here.** An id only becomes this machine's node in an
    account once the server has accepted it — see ``claim_node_id`` — because
    recording it first would burn one on every refused attempt, and the server
    caps a member at ten devices.

    Three answers, in order:

    1. The id already recorded for this member. Stable across restarts, which is
       what a peer's pin depends on.
    2. The legacy machine-wide id, if no member has claimed it yet. This is what
       keeps every existing pairing alive across the upgrade: peers pinned this
       machine under that id and a pin cannot be re-keyed from here — the other
       machine holds it. So the account that was already working keeps working.
    3. A fresh one, because the legacy id belongs to another account now.
    """
    doc = _read_doc()
    nodes = doc.get("nodes")
    nodes = nodes if isinstance(nodes, dict) else {}
    if member_id:
        existing = _valid(nodes.get(member_id))
        if existing:
            return existing
    legacy = _valid(doc.get("device_id"))
    if legacy and legacy not in nodes.values():
        return legacy
    return str(uuid.uuid4())


def claim_node_id(member_id: str, value: str) -> None:
    """Record *value* as this machine's node in *member_id*'s account.

    Called only after ``auth.hello`` has accepted it, so the file never holds an
    id the server refused. Writing the same value twice is a no-op, which is the
    ordinary case: every reconnect claims what it already had.
    """
    if not member_id or not _valid(value):
        return
    with _lock:
        doc = _read_doc()
        nodes = doc.get("nodes")
        nodes = nodes if isinstance(nodes, dict) else {}
        if nodes.get(member_id) == value:
            return
        nodes[member_id] = value
        doc["nodes"] = nodes
        doc.setdefault("machine_id", _valid(doc.get("device_id")) or str(uuid.uuid4()))
        _write_doc(doc)
        log.info("this machine is node %s in member %s", value, member_id)


def fresh_node_id() -> str:
    """An id this machine has never presented. Unrecorded, like ``node_id_for``.

    The ``DEVICE_CONFLICT`` recovery: the server says the id we offered belongs
    to somebody else, which it can only say about an id we have never
    successfully authenticated with under this credential. So there is nothing
    to lose by moving — no pairing exists under a member that never had a
    working link, and no policy either.
    """
    return str(uuid.uuid4())
