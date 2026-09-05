"""Two people, two machines, one code read aloud.

The pairing this replaces went one way: you picked another device out of a list,
typed four characters of its fingerprint, and that machine was now allowed to
drive the CLIs here — without anybody at that machine being asked, or even told.
Whoever was sitting there found out when something started running.

This is the short-authentication-string dance instead. Both sides contribute a
nonce, both derive the same six digits from *both signing keys and both nonces*,
and a person at each end confirms the digits match. Neither machine is pinned
until both have.

**Why the code is derived rather than sent.** The relay carries every one of
these messages and could rewrite any field in them. What it cannot do is make
two different key pairs hash to the same six digits: swap either public key on
the way past and the two ends compute different codes, so the people comparing
them see a mismatch. That is the whole of the protection, and it is why the SAS
covers the keys rather than only the nonces — a code over nonces alone would
match perfectly while the relay held a key of its own in the middle.

Six digits is 20 bits: a relay that guesses gets one attempt in a million per
try, and a mismatch ends the pairing rather than inviting another. That is the
usual trade — it is short enough for a person to read across a desk, which is
the property that makes anybody actually do it.

**What is deliberately not here.** No pairing survives a restart. The state is
in memory and a backend that comes back has forgotten every half-finished
exchange, which is the safe direction: the alternative is a pending request
somebody can confirm hours later without remembering what they started.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

#: The message kinds this exchange uses. They ride the ordinary encrypted
#: message channel, and the receiver picks them out before anything pane-shaped
#: happens to them — they address a machine, not a pane.
PAIR_REQUEST = "pair-request"
PAIR_RESPONSE = "pair-response"
PAIR_CONFIRM = "pair-confirm"
PAIR_REJECT = "pair-reject"
PAIR_REVOKED = "pair-revoked"

PAIR_KINDS = frozenset(
    {PAIR_REQUEST, PAIR_RESPONSE, PAIR_CONFIRM, PAIR_REJECT, PAIR_REVOKED}
)

#: The marker that tells a pairing message from somebody's chat. Deliberately
#: not a word anyone would type: the body is otherwise free text going to a CLI,
#: and a message that could be mistaken for this one would be a way to put a
#: pairing card on a stranger's screen.
ENVELOPE_MARKER = "navide/pair/v1"

#: How long a request stays answerable. Long enough to walk to the other
#: machine, short enough that a request nobody remembers starting cannot be
#: confirmed later.
REQUEST_TTL_S = 300.0

#: Where each side is. The two "waiting" states are different questions: one
#: side is waiting to be *asked*, the other has already been asked and is
#: waiting for its own person.
STATE_AWAITING_RESPONSE = "awaiting-response"   # we asked; they have not replied
STATE_AWAITING_LOCAL = "awaiting-local"         # both nonces known; our turn to confirm
STATE_AWAITING_REMOTE = "awaiting-remote"       # we confirmed; waiting on them

#: Which side started it. Only used to say the right sentence on screen —
#: nothing about the exchange itself depends on it.
ROLE_INITIATOR = "initiator"
ROLE_RESPONDER = "responder"

_lock = threading.Lock()


@dataclass
class Pairing:
    """One in-flight exchange with one device."""

    device_id: str
    device_name: str
    role: str
    state: str
    #: Their signing key, as carried in the message that started this. Never
    #: read from the directory: the directory is the relay's word, and the code
    #: below exists precisely to check the relay.
    their_key: str
    our_nonce: str
    their_nonce: str = ""
    started_at: float = field(default_factory=time.time)
    #: Set once this side's person has said the digits match.
    we_confirmed: bool = False
    #: Set when their ``pair-confirm`` arrives.
    peer_confirmed: bool = False

    def expired(self, now: float | None = None) -> bool:
        return (now or time.time()) - self.started_at > REQUEST_TTL_S


_pairings: dict[str, Pairing] = {}


# ---- the wire -----------------------------------------------------------------
#
# These ride the ordinary message channel as plain text rather than sealed.
# Nothing in them is a secret: the nonces and the public keys are meant to be
# seen, and the protection comes from the signature over the frame plus the
# digits two people compare. Sealing would need the other machine's encryption
# key before there is any relationship in which to have learned it, which is
# the problem this exchange exists to solve.


def envelope(kind: str, **fields: Any) -> str:
    """One pairing frame, as the text body of an ordinary message."""
    import json

    if kind not in PAIR_KINDS:
        raise PairingError(f"unknown pairing kind {kind!r}")
    return json.dumps({"marker": ENVELOPE_MARKER, "kind": kind, **fields}, sort_keys=True)


def parse(text: Any) -> dict[str, Any] | None:
    """The pairing frame in *text*, or None when it is not one.

    None for everything it cannot read, including well-formed JSON with the
    wrong marker: a body this build does not recognise as pairing has to fall
    through to being an ordinary message, or a future kind would silently
    vanish instead of being refused visibly.
    """
    import json

    if not isinstance(text, str) or ENVELOPE_MARKER not in text:
        return None
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("marker") != ENVELOPE_MARKER:
        return None
    if data.get("kind") not in PAIR_KINDS:
        return None
    return data


# ---- the code itself ---------------------------------------------------------


def new_nonce() -> str:
    """One side's contribution. 16 bytes, so neither end can steer the digits by
    grinding its own half: to force a chosen code a party would have to search
    the other's nonce space, and it does not get to choose that."""
    return base64.b64encode(secrets.token_bytes(16)).decode("ascii")


def sas(*, key_a: str, key_b: str, nonce_a: str, nonce_b: str) -> str:
    """The six digits both machines show, as ``"482 913"``.

    The keys are sorted so that the two ends — which disagree about which of
    them is "a" — hash the same bytes. The nonces are ordered to match their
    keys rather than sorted independently, or a relay could pair one side's
    nonce with the other's key and still land on a matching digest.

    Empty on missing input rather than hashing whatever is there: a code
    computed from half an exchange would be a code two people could still
    successfully compare.
    """
    if not (key_a and key_b and nonce_a and nonce_b):
        return ""
    first, second = (
        ((key_a, nonce_a), (key_b, nonce_b))
        if key_a <= key_b
        else ((key_b, nonce_b), (key_a, nonce_a))
    )
    payload = "\x00".join(
        (ENVELOPE_MARKER, first[0], second[0], first[1], second[1])
    ).encode("utf-8")
    digest = hashlib.sha256(payload).digest()
    code = int.from_bytes(digest[:4], "big") % 1_000_000
    text = f"{code:06d}"
    return f"{text[:3]} {text[3:]}"


def code_for(pairing: Pairing, *, our_key: str) -> str:
    return sas(
        key_a=our_key,
        key_b=pairing.their_key,
        nonce_a=pairing.our_nonce,
        nonce_b=pairing.their_nonce,
    )


# ---- the state machine -------------------------------------------------------


class PairingError(Exception):
    """A transition that must not happen. Carries a short reason for the wire."""


def _sweep(now: float) -> None:
    for device_id, pairing in list(_pairings.items()):
        if pairing.expired(now):
            log.info("pairing with %s expired before it was confirmed", device_id)
            _pairings.pop(device_id, None)


def get(device_id: str) -> Pairing | None:
    with _lock:
        _sweep(time.time())
        return _pairings.get(device_id)


def active() -> list[Pairing]:
    with _lock:
        _sweep(time.time())
        return list(_pairings.values())


def begin(device_id: str, *, device_name: str, their_key: str = "") -> Pairing:
    """Start asking *device_id* to pair. Raises when one is already in flight.

    One at a time per device, because two exchanges would produce two codes for
    the same pair of machines and the person comparing them has no way to tell
    which card belongs to which.
    """
    with _lock:
        now = time.time()
        _sweep(now)
        if device_id in _pairings:
            raise PairingError("a pairing with that device is already in progress")
        pairing = Pairing(
            device_id=device_id,
            device_name=device_name,
            role=ROLE_INITIATOR,
            state=STATE_AWAITING_RESPONSE,
            their_key=their_key,
            our_nonce=new_nonce(),
        )
        _pairings[device_id] = pairing
        return pairing


def accept_request(device_id: str, *, device_name: str, their_key: str, their_nonce: str) -> Pairing:
    """Record an incoming request. This side now owes a response and a decision."""
    if not their_key or not their_nonce:
        raise PairingError("the request carries no key or no nonce")
    with _lock:
        now = time.time()
        _sweep(now)
        if device_id in _pairings:
            # Their request and ours crossed, or they asked twice. Either way the
            # earlier exchange is the one with a code already on somebody's
            # screen, so the new request is refused rather than silently
            # replacing it.
            raise PairingError("a pairing with that device is already in progress")
        pairing = Pairing(
            device_id=device_id,
            device_name=device_name,
            role=ROLE_RESPONDER,
            state=STATE_AWAITING_LOCAL,
            their_key=their_key,
            our_nonce=new_nonce(),
            their_nonce=their_nonce,
        )
        _pairings[device_id] = pairing
        return pairing


def accept_response(device_id: str, *, their_key: str, their_nonce: str) -> Pairing:
    """The other side answered our request. Both nonces are now known."""
    with _lock:
        _sweep(time.time())
        pairing = _pairings.get(device_id)
        if pairing is None:
            raise PairingError("no pairing with that device is in progress")
        if pairing.state != STATE_AWAITING_RESPONSE:
            raise PairingError(f"a response does not belong in state {pairing.state}")
        if not their_nonce:
            raise PairingError("the response carries no nonce")
        # Their key is fixed by the first message that carried one. Letting a
        # later frame revise it would let the relay wait until the code was on
        # screen and then swap the key it covers.
        if pairing.their_key and their_key and their_key != pairing.their_key:
            raise PairingError("the response offers a different signing key")
        pairing.their_key = pairing.their_key or their_key
        pairing.their_nonce = their_nonce
        pairing.state = STATE_AWAITING_LOCAL
        return pairing


def confirm(device_id: str) -> Pairing:
    """This side's person says the digits match. Not yet a pairing."""
    with _lock:
        _sweep(time.time())
        pairing = _pairings.get(device_id)
        if pairing is None:
            raise PairingError("no pairing with that device is in progress")
        if pairing.state != STATE_AWAITING_LOCAL:
            raise PairingError(f"nothing to confirm in state {pairing.state}")
        pairing.we_confirmed = True
        pairing.state = STATE_AWAITING_REMOTE
        return pairing


def note_peer_confirmed(device_id: str) -> Pairing | None:
    """Their ``pair-confirm`` arrived. Returns the exchange, or None when there
    is nothing in flight — a confirm for something this side already forgot is
    not an error, it is late."""
    with _lock:
        _sweep(time.time())
        pairing = _pairings.get(device_id)
        if pairing is None:
            return None
        pairing.peer_confirmed = True
        return pairing


def complete(device_id: str) -> Pairing | None:
    """The finished exchange, or None while it is still waiting on somebody.

    **Who still has to answer depends on which side this is**, and that is the
    one asymmetry in the whole exchange:

    *The responder* needs both. Somebody asked to come in; a person here says
    whether the digits match, and until they do nothing is written. This is the
    half that carries the security property — the initiator's own click could
    never be the check, because the initiator is the party being authenticated.

    *The initiator* needs only theirs. Comparing the digits is one act performed
    by one person looking at two screens, and pressing "Pair with…" already
    said what this side wants. A second button here asked the same person the
    same question twice.

    **The cost, stated plainly because it is real**: somebody can press Pair and
    walk away, and whoever is standing at the other machine can complete the
    pairing without them. That is the trade the second button was buying, and it
    was bought at the price of a step most people would learn to click through.
    """
    with _lock:
        _sweep(time.time())
        pairing = _pairings.get(device_id)
        if pairing is None:
            return None
        needed = (
            pairing.peer_confirmed
            if pairing.role == ROLE_INITIATOR
            else pairing.we_confirmed and pairing.peer_confirmed
        )
        if not needed:
            return None
        _pairings.pop(device_id, None)
        return pairing


def cancel(device_id: str) -> Pairing | None:
    """Drop an exchange: refused here, refused there, or expired."""
    with _lock:
        return _pairings.pop(device_id, None)


def _reset_for_test() -> None:
    with _lock:
        _pairings.clear()
