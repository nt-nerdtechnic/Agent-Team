"""A second check on the six actions that change who this machine trusts.

``ws_auth`` answers *may you open this socket*. Everything past that point is
equally allowed to send anything, and among the things it can send are "approve
this device", "block that one" and "replace the authorization rules". Navide
itself hands that socket to more than the window a person is looking at: the
plugin broker holds one, and the MCP server reaches the same handlers on behalf
of a CLI agent — an agent that may be taking instructions from a remote peer.
That is the hole this closes: **a remote peer must not be able to talk an agent
into changing trust state on the machine it is trying to reach.**

The confirmation is a short-lived token that only the main process can mint. It
binds the action name, the device it names, and — where the device is not the
whole story — a *subject*: the canonical text of the policy document being
written, the key of the knock being approved, the member being (un)blocked. A
token minted to approve one machine cannot be replayed to block another, one
minted to sign one rule set cannot sign a different one, and each is spent once.

**What the subject does not cover, and why that is fine.** ``pair.start``,
``pair.confirm``, ``device.defer`` and ``device.unpair`` name exactly one device
and nothing else the handler acts on, so the device binding already says all
there is to say. ``rebuild`` has no subject: it is the same act whoever asks.
``block`` binds the member; the device name and reason it also stores are
labels the user reads, not anything the policy engine consults.

**What this does not do.** It does not stop a process running as the same user.
Such a process can read the message the renderer sends, attach to the main
process, or simply act as the user in a hundred other ways; no secret this
program holds is out of its reach. The bar it raises is a real one and worth
naming exactly: from *anything that can open the local socket* to *code running
inside the main or backend process*. The key never touches the disk and never
touches the environment — it is handed over stdin once at spawn and lives only
in memory here — because the two things a CLI agent trivially can do are read a
file and read ``ps -E``.

**Not bound to the socket it arrives on.** Doing that would need the backend to
tell clients their session id, which is a new fact on the wire for one check;
one-time use plus a thirty-second life already means a captured token is spent
or expired before it is worth carrying to another connection.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time

log = logging.getLogger(__name__)

#: How long a freshly minted token stays usable. Long enough that a click and a
#: round trip never race it, short enough that one lifted off the wire is stale
#: before it can be carried anywhere.
TOKEN_TTL_S = 30.0

#: Nonces are remembered for a little longer than a token can live, so a replay
#: cannot succeed by arriving in the gap between expiry and forgetting.
_NONCE_MEMORY_S = TOKEN_TTL_S * 2

_key: bytes = b""
_spent: dict[str, float] = {}


def set_key(raw: str) -> bool:
    """Adopt the signing key the main process handed over. Returns whether one
    was actually set, so startup can say which mode it is in."""
    global _key
    material = (raw or "").strip()
    if not material:
        return False
    _key = material.encode("utf-8")
    return True


def configured() -> bool:
    return bool(_key)


def _mac(*, nonce: str, expires: str, action: str, device_id: str, subject: str) -> str:
    # The separator cannot occur in any of the fields — nonce and expiry are
    # generated, action and device are matched against fixed sets, and the
    # subject is either an id or canonical JSON (which escapes control
    # characters) — so no two different tuples produce the same signed string.
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expires, action, device_id, subject))
    return hmac.new(_key, payload.encode("utf-8"), hashlib.sha256).hexdigest()


def canonical_json(value: object) -> str:
    """The one spelling of a JSON document both sides can compute.

    Sorted keys, no whitespace, every non-ASCII character escaped — the same
    rules ``src/shared/canonicalJson.ts`` implements, and a fixture test on each
    side pins the two to one literal so they cannot drift apart unnoticed.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _forget_old(now: float) -> None:
    for nonce, seen in list(_spent.items()):
        if now - seen > _NONCE_MEMORY_S:
            _spent.pop(nonce, None)


def check(token: object, *, action: str, device_id: str, subject: str = "") -> str:
    """Empty when this action may proceed, else a short reason for the caller.

    Fails closed when no key was ever set. A backend that did not receive one is
    not a backend a person's window is driving — the main process hands it over
    before anything else — so the honest answer there is to refuse rather than to
    quietly become the surface this module exists to remove.
    """
    if not _key:
        return "this backend received no confirmation key at startup"
    if not isinstance(token, dict):
        return "this action needs a confirmation from the app window"
    nonce = str(token.get("nonce") or "")
    expires = str(token.get("expires") or "")
    mac = str(token.get("mac") or "")
    if not nonce or not expires or not mac:
        return "the confirmation is incomplete"
    expected = _mac(nonce=nonce, expires=expires, action=action, device_id=device_id, subject=subject)
    # compare_digest because the obvious comparison leaks the length of the
    # matching prefix through timing, and forging one byte at a time is exactly
    # what that would allow.
    if not hmac.compare_digest(mac, expected):
        return "the confirmation does not match this action"
    try:
        deadline = float(expires)
    except ValueError:
        return "the confirmation has no usable expiry"
    now = time.time()
    if now > deadline:
        return "the confirmation has expired"
    _forget_old(now)
    if nonce in _spent:
        return "the confirmation was already used"
    _spent[nonce] = now
    return ""


def _reset_for_test(key: str = "") -> None:
    global _key
    _key = key.encode("utf-8") if key else b""
    _spent.clear()
