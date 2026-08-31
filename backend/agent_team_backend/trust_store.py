"""What this machine has decided to believe about the other ones, on disk.

Three pieces of state decide whether a cross-device message is honoured, and
before this module all three lived in a Python attribute that a restart erased:

*Which signing key belongs to which device.* Without it a signature proves only
that *somebody* holds *a* key — and the relay can mint keys all day. Pinned on
first sight (trust on first use), and a device whose key later changes is
refused rather than re-pinned.

*The highest policy sequence this device has ever signed.* The pane policy is
stored by the server, so the server chooses which version to hand back; without
a locally held high-water mark it can hand back an older one, or none, and
nothing notices.

*Which peers have ever been sent ciphertext.* ``server_link`` refuses to fall
back to plaintext for a peer it has seen a key for, which is the right rule and
was, until now, forgotten on every backend restart — so the relay could get
plaintext simply by dropping a key from the directory and waiting for the next
restart, which is a daily event.

**Why two storage systems.** The state itself goes in the credential vault (the
Keychain on macOS, a 0600 file elsewhere), and a bare "this machine has been
initialised" marker goes in ``navide.db``. They are deliberately in different
places, because the failure this design exists to prevent is *silent* reset: if
both lived together, one `rm` would take the marker with the state and the next
start would look exactly like a first start. Split, a missing state file with
the marker present is a state this machine can recognise and refuse to work in.

**Fail closed, and no upgrade grace.** Marker present but state unreadable means
cross-device traffic stops and the user is told, rather than the pins quietly
starting over. There is no "old installs get one free pass" allowance either: a
grace period is an attacker-reachable reset, repeatable as often as they like,
and the population it would serve does not exist — no shipped build has ever
written any of this.

**The marker records who wrote it, and that is not a loophole.** The first thing
ever to trip this lock was our own verification script, which used to run
against the real app-data directory: it left a marker with no state behind, and
the symptom — cross-device traffic stopping in both directions — is exactly what
a real attacker deleting the state would produce. Someone who did not happen to
know what they had run ten minutes earlier would have investigated the wrong
thing. So the marker carries the program and the time that created it, and the
lock message quotes them. This changes no decision: the lock holds whatever the
provenance says, and nothing here treats a marker as dismissible. It only means
the person reading the message is told a fact instead of having to guess, which
is the same problem as a warning buried under noise — the defence is intact and
the part where *a human finds out* is what got damaged.

The judgement behind all of it: losing a *private key* breaks things visibly, so
it can be regenerated. Losing a *pin* breaks nothing visible and removes a
protection, so it must not be regenerated. Anything that would fail silently is
treated here as an error.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
from pathlib import Path
from typing import Any

from agent_team_backend import device_signing

log = logging.getLogger(__name__)

#: The vault entry holding the state document, and the navide.db key holding
#: the "we have been here before" marker. See the module note on why they are
#: not the same store.
SECRET_NAME = "navide-device-trust"
INITIALISED_KEY = "p2p.trust.initialised"

STATE_VERSION = 1

#: How many remote devices this machine will pin. The directory is filled by
#: other machines, so it is only as small as they are well behaved. At the cap
#: new devices stop being pinnable — which denies them, rather than evicting an
#: existing pin, because an evicted pin is a protection that disappears without
#: anything going wrong on screen.
MAX_DEVICES = 200

#: Notices waiting to be read. The *refusal* a notice describes comes from the
#: pin and is never dropped, so the cap costs visibility rather than protection
#: — but visibility is the whole job here, so what gets evicted is not
#: whichever is oldest. See ``_record_locked``.
MAX_NOTICES = 50

#: Bounds on the delivered-message ledger. Same shape and reasoning as the
#: in-memory version it replaces: a map fed by a remote peer needs a ceiling,
#: and a delivered message stops being interesting once no sender would retry.
MAX_SEEN_MESSAGES = 500
SEEN_MESSAGE_TTL_S = 3600

#: How long recording a delivery may stay in memory before it reaches disk.
#:
#: Without this, every inbound message rewrites the whole state document into
#: the Keychain — on the delivery path, so the cost lands as latency before the
#: message reaches a pane.
#:
#: The trade is worth stating rather than assuming: a process killed with
#: unflushed keys forgets them, so those messages could be replayed once. That
#: is acceptable because this ledger defends against replay after a *clean*
#: restart — which a relay can simply wait for — not after a crash, which it
#: cannot arrange and which loses at most a few seconds of keys.
SEEN_FLUSH_AFTER = 25
SEEN_FLUSH_SECONDS = 10.0

NOTICE_FIRST_SEEN = "device-first-seen"
NOTICE_KEY_CHANGED = "device-key-changed"
NOTICE_POLICY_UNVERIFIED = "policy-unverified"
NOTICE_MEMBER_CHANGED = "member-changed"
#: A peer that has been encrypting sent plaintext, and this machine refused it.
#: The send side has refused to *emit* plaintext to such a peer since the
#: downgrade record was made durable; this is the other half — without it, a
#: relay that wants cleartext only has to ask the far end for it, because the
#: far end had no rule against accepting.
NOTICE_PLAINTEXT_REFUSED = "plaintext-refused"

#: Only a first sighting may be dismissed. A key change is not a notification
#: to acknowledge — it is a refusal in force, and a button that made it go away
#: would let the answer to "somebody may be standing in for that machine" be one
#: click, which is the click an attacker is counting on.
#:
#: A refused downgrade is the same shape and stays for the same reason: it says
#: a message was dropped, and dropped messages are exactly what a person needs
#: to keep seeing while they work out why.
DISMISSIBLE = frozenset({NOTICE_FIRST_SEEN})

#: Every kind this module can record. Exists so the renderer's union can be
#: checked against it: a kind the UI has no branch for does not fail to render,
#: it falls through to whichever branch is last — which is how `member-changed`
#: came to be displayed as "first seen this device", a sentence that is not
#: merely unhelpful but false. Type systems cannot catch that: the values
#: arrive as JSON, so a union missing a member is perfectly legal TypeScript.
ALL_NOTICE_KINDS = frozenset({
    NOTICE_FIRST_SEEN,
    NOTICE_KEY_CHANGED,
    NOTICE_POLICY_UNVERIFIED,
    NOTICE_MEMBER_CHANGED,
    NOTICE_PLAINTEXT_REFUSED,
})


class TrustStoreLocked(RuntimeError):
    """The state was initialised once and cannot be read now.

    Never resolved by starting over: that is precisely the outcome an attacker
    who can delete a file would be buying.
    """


class TrustStoreFull(RuntimeError):
    """The device cap is reached, so a new pin cannot be taken."""


_lock = threading.RLock()
_state: dict[str, Any] | None = None
_locked_reason = ""


# ---- storage -----------------------------------------------------------------


def _vault():
    # Late import for the same reason server_link does it: app imports both, and
    # tests swap the app-wide vault wholesale to stay off the real Keychain.
    from . import app

    return app.credential_vault


def _database():
    from . import app

    return app.database


def _blank() -> dict[str, Any]:
    return {
        "v": STATE_VERSION,
        # credential fingerprint -> the member id that credential means. A map
        # rather than one entry because signing out of one account and back into
        # another is ordinary, and a single slot would let the second sign-in
        # overwrite the first pin — so returning to the first account would take
        # whatever the server said that day.
        "ownMembers": {},
        "pins": {},
        # deviceId -> the highest policy sequence this machine ever signed for
        # that device. Keyed rather than flat because the sequence belongs to
        # the policy document, and a document names the device it governs: a
        # single counter would make one device's write look like a rollback of
        # another's. In production this map holds exactly one entry.
        "policySeqs": {},
        "encryptedPeers": [],
        # msg_key -> unix seconds when it was first delivered. Persisted because
        # the in-memory version expired at every restart, and a backend restart
        # is a daily event rather than something a relay has to arrange — so
        # "we already delivered that" was a promise anyone could simply wait out.
        "seenMessages": {},
        "notices": [],
    }


def _parse(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        doc = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(doc, dict) or doc.get("v") != STATE_VERSION:
        return None
    for key, kind in (
        ("ownMembers", dict),
        ("pins", dict),
        ("encryptedPeers", list),
        ("notices", list),
    ):
        if not isinstance(doc.get(key), kind):
            return None
    # Fields added after v1 shipped. Absent means "this state file predates the
    # field", which has to read as the empty value rather than as a parse
    # failure: every other guarantee in this module — the pins (C1), the policy
    # sequences (C2), the downgrade list (H1/H2) — is read out of this same
    # document. A missing ledger costs replay protection for one restart; an
    # unreadable document costs all four at once.
    for later, empty in (("policySeqs", {}), ("seenMessages", {})):
        value = doc.get(later)
        if value is None:
            doc[later] = empty
        elif not isinstance(value, type(empty)):
            return None
    return doc


def _write(state: dict[str, Any]) -> None:
    # One line, always: `_keychain_write` refuses a multi-line payload outright,
    # and a payload that got past it truncated at the first newline would leave
    # a state document that parses as far as "{" and locks this machine out.
    _vault().write_app_secret(
        SECRET_NAME, json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    )


def _load_locked() -> dict[str, Any]:
    """Read the state, or raise. Caller holds ``_lock``."""
    global _state, _locked_reason
    if _state is not None:
        return _state
    if _locked_reason:
        raise TrustStoreLocked(_locked_reason)

    database = _database()
    marker = database.kv_get(INITIALISED_KEY)
    try:
        raw = _vault().read_app_secret(SECRET_NAME)
    except Exception as err:  # noqa: BLE001 - a vault that will not answer is a lock
        if marker is not None:
            _locked_reason = f"the device trust store could not be read ({err})"
            raise TrustStoreLocked(_locked_reason) from err
        raw = None
    parsed = _parse(raw)

    if marker is not None:
        if parsed is None:
            _locked_reason = (
                "this machine has a cross-device trust record but its contents are "
                "missing or unreadable"
                + _provenance(marker)
            )
            raise TrustStoreLocked(_locked_reason)
        _state = parsed
        return _state

    # No marker: a first start. An existing, readable document is adopted rather
    # than replaced — the marker is written after the document, so a crash
    # between the two lands here, and starting over would throw away real pins
    # for a reason nobody would ever see.
    if raw and parsed is None:
        log.warning(
            "a device trust document exists but is unreadable and this machine was "
            "never marked initialised; starting a new one"
        )
    _state = parsed if parsed is not None else _blank()
    _write(_state)
    database.kv_set(
        INITIALISED_KEY,
        # See the module note: this is read back into the lock message so the
        # person looking at a stopped link is told what created the record
        # rather than having to remember. It decides nothing.
        {"at": int(time.time()), "by": Path(sys.argv[0] or "?").name},
        now=int(time.time()),
    )
    return _state


def _provenance(marker: Any) -> str:
    """Where the lock came from, as a clause to append to the reason.

    Deliberately just a statement of what was recorded. It does not suggest an
    action and nothing branches on it: a marker written by a test is exactly as
    locking as one written by the app, because a program name is not evidence
    about whether pins were lost.
    """
    if not isinstance(marker, dict):
        return ""
    by = str(marker.get("by") or "")
    at = marker.get("at")
    when = ""
    if isinstance(at, int) and not isinstance(at, bool):
        when = time.strftime(" on %Y-%m-%d at %H:%M", time.localtime(at))
    if not by and not when:
        return ""
    return f" (the record was created by {by or 'an unknown program'}{when})"


def load() -> dict[str, Any]:
    """The state document. Blocking (Keychain); call off the event loop."""
    with _lock:
        return dict(_load_locked())


def locked_reason() -> str:
    """Why cross-device traffic must be refused, or "" when all is well.

    Never raises: every caller of this is deciding what to tell somebody, and a
    status read that could itself fail would leave them with nothing to say.
    """
    with _lock:
        if _state is not None:
            return ""
        try:
            _load_locked()
        except TrustStoreLocked as err:
            return str(err)
        except Exception as err:  # noqa: BLE001
            return f"the device trust store could not be opened ({err})"
        return ""


def _save_locked(state: dict[str, Any]) -> None:
    _write(state)


def _state_for_read() -> dict[str, Any]:
    """The state, for every public read. Caller holds ``_lock``.

    Exists because four separate readers each answered from an empty cache, and
    each of those answers was the permissive one: no pin, no downgrade rule, no
    notices, sequence zero. The writes had always loaded; only the reads had
    not, so every durable guarantee in this module was conditional on the order
    in which the process happened to warm up. Two of them reopened a CRITICAL
    that way — `pin_for` gave the relay back key substitution (C1), `policy_seq`
    gave it back policy rollback (C2).

    Fixing them one at a time would have left the fifth reader to be written
    wrong later, so the cache is no longer reachable from a read: there is one
    door and it loads. A new reader gets a loaded state without having to know
    that it must.
    """
    return _load_locked() if _state is None else _state


def _try_load() -> dict[str, Any] | None:
    """The state, or None when it cannot be had. Caller holds ``_lock``.

    For the writes that only *record* something. Those run on paths that are
    already refusing a message, and a raise from one of them would turn a
    refusal — which is the intended outcome — into a dropped connection, which
    is not. The writes that decide something (pins, sequences, the
    no-downgrade list) still raise, because carrying on without them is what
    this module exists to prevent.
    """
    try:
        return _load_locked()
    except Exception:  # noqa: BLE001
        return None


# ---- this account's own member id --------------------------------------------


def _token_fingerprint(url: str, token: str) -> str:
    """Which account a credential names, as far as this machine is concerned.

    The address is part of it, not just the token: the same string presented to
    a different server is a different account, and treating the two as one would
    make an ordinary second deployment look like a server changing its mind.
    Both halves are chosen by this machine, never by the far side.
    """
    import hashlib

    return hashlib.sha256(f"{url}\x00{token}".encode("utf-8")).hexdigest()[:32]


def adopt_own_member(url: str, token: str, member_id: str) -> str:
    """Pin the member id this credential belongs to, and return the pinned one.

    ``auth.hello`` answers with a member id, and until now that answer *was*
    this machine's identity — so a relay could name any id it liked and then
    send messages "from" it, which the delivery path read as one of the user's
    own machines. Pinning it per credential closes that: the same token may
    only ever mean the same member.

    Keyed on the credential rather than stored flat because signing in with a
    different account is an ordinary thing to do and must not read as an attack.
    A *different* id under the *same* credential is not ordinary, and raises.
    """
    with _lock:
        state = _load_locked()
        owners = state["ownMembers"]
        fingerprint = _token_fingerprint(url, token)
        pinned = str(owners.get(fingerprint) or "")
        if pinned:
            if pinned != member_id:
                _record_locked(
                    state,
                    NOTICE_MEMBER_CHANGED,
                    device_id="",
                    detail={"pinned": pinned, "offered": member_id},
                )
                _save_locked(state)
                raise TrustStoreLocked(
                    "the server answered this credential with a different member id "
                    f"than the one pinned here ({pinned})"
                )
            return pinned
        owners[fingerprint] = member_id
        _save_locked(state)
        return member_id


# ---- device pins -------------------------------------------------------------


def pin_for(device_id: str) -> dict[str, Any] | None:
    """The pinned key and member for *device_id*, from memory. Never raises: the
    delivery path calls this per message and has already checked the lock."""
    with _lock:
        if not device_id:
            return None
        # Load rather than answer from an empty cache. Returning None here means
        # "never seen this device", and the caller answers that by trusting the
        # key the relay advertises — so a cold cache silently handed the relay
        # back the substitution that pinning exists to stop, for as long as it
        # took something else to touch the store. The writes have always loaded;
        # only the reads did not, which made the durable half of TOFU
        # conditional on the order in which the process happened to warm up.
        pin = (_state_for_read().get("pins") or {}).get(device_id)
        return dict(pin) if isinstance(pin, dict) else None


def pin_device(
    device_id: str, *, sign_key: str, member_id: str, own_member_id: str = ""
) -> dict[str, Any]:
    """Take a first pin for *device_id*. Blocking; call off the event loop.

    Only ever called after the message actually verified against *sign_key*, so
    the relay cannot fill this map with keys nobody can sign for. That is a
    smaller guarantee than it sounds — the relay can generate a keypair and sign
    with it — and it is why a first sighting is surfaced rather than silent.
    """
    with _lock:
        state = _load_locked()
        pins = state["pins"]
        existing = pins.get(device_id)
        if isinstance(existing, dict):
            return dict(existing)
        if len(pins) >= MAX_DEVICES:
            raise TrustStoreFull(f"this machine already pins {len(pins)} devices")
        pin = {
            "signKey": sign_key,
            "memberId": member_id,
            "at": int(time.time()),
        }
        pins[device_id] = pin
        _record_locked(
            state,
            NOTICE_FIRST_SEEN,
            device_id=device_id,
            detail={
                "memberId": member_id,
                "fingerprint": device_signing.fingerprint(sign_key),
                # Whether this pin puts the device in the own-device ring, which
                # consults no rules at all. That makes it the one first sighting
                # a person has to actually look at, so it is stated rather than
                # left to be worked out from the member id.
                "own": bool(member_id) and member_id == own_member_id,
            },
        )
        _save_locked(state)
        return dict(pin)


def note_key_change(device_id: str, *, pinned_key: str, offered_key: str, member_id: str) -> None:
    """Record that a pinned device is now offering a different key.

    The refusal itself does not depend on this being written — it comes from the
    pin, which is not touched here. This only makes the refusal *visible*, with
    both fingerprints, because "they reinstalled" and "somebody is standing in
    for them" look identical from the wire and only a person can tell them apart.
    """
    with _lock:
        state = _try_load()
        if state is None:
            return
        for notice in state["notices"]:
            if notice.get("kind") == NOTICE_KEY_CHANGED and notice.get("deviceId") == device_id:
                return
        _record_locked(
            state,
            NOTICE_KEY_CHANGED,
            device_id=device_id,
            detail={
                "memberId": member_id,
                "pinnedFingerprint": device_signing.fingerprint(pinned_key),
                "offeredFingerprint": device_signing.fingerprint(offered_key),
            },
        )
        _save_locked(state)


# ---- the pane policy's sequence ----------------------------------------------


def policy_seq(device_id: str) -> int:
    """The highest policy sequence accepted for *device_id*, or 0.

    Reads through ``_state_for_read``. Answering 0 from a cold cache made the
    monotonicity check (``offered < seq`` in server_link) vacuous, so a relay
    could replay any older but properly signed policy — the permissive one from
    before the user tightened it, say — and the acceptance would then write that
    lower number back as the new high-water mark.
    """
    with _lock:
        return int((_state_for_read().get("policySeqs") or {}).get(device_id) or 0)


def reserve_policy_seq(device_id: str) -> int:
    """Claim the next sequence for a policy about to be written, and persist it
    before it is used.

    Persisting first means a write that fails leaves a number burned rather than
    reusable: the next attempt takes a higher one. A burned sequence costs a
    re-save (until then the stored policy verifies but reads as stale, and this
    machine denies); reusing one would let a relay replay the older document
    that shares it, which costs the whole check.
    """
    with _lock:
        state = _load_locked()
        seqs = state["policySeqs"]
        seq = int(seqs.get(device_id) or 0) + 1
        seqs[device_id] = seq
        _save_locked(state)
        return seq


def note_policy_seq(device_id: str, seq: int) -> None:
    """Adopt a sequence read back from the server, when it moves forward."""
    with _lock:
        state = _load_locked()
        seqs = state["policySeqs"]
        if seq > int(seqs.get(device_id) or 0):
            seqs[device_id] = seq
            _save_locked(state)


def note_policy_unverified(reason: str, *, device_id: str = "", seq: Any = None) -> None:
    with _lock:
        state = _try_load()
        if state is None:
            return
        for notice in state["notices"]:
            if notice.get("kind") == NOTICE_POLICY_UNVERIFIED:
                return
        _record_locked(
            state,
            NOTICE_POLICY_UNVERIFIED,
            device_id=device_id,
            detail={
                "reason": reason,
                "seq": seq,
                "expected": (state.get("policySeqs") or {}).get(device_id, 0),
            },
        )
        _save_locked(state)


def clear_policy_notice() -> None:
    """Drop the "policy could not be verified" notice once one verifies again.

    Deliberately *not* converted to ``_state_for_read``. Its cold-cache
    behaviour is "do not clear the warning", which fails toward keeping a notice
    that should have gone — the harmless direction. Every other reader failed
    the other way, which is why they were changed and this one was not.
    """
    with _lock:
        if _state is None:
            return
        keep = [n for n in _state["notices"] if n.get("kind") != NOTICE_POLICY_UNVERIFIED]
        if len(keep) != len(_state["notices"]):
            _state["notices"] = keep
            _save_locked(_state)


# ---- peers that have been sent ciphertext ------------------------------------


def is_encrypted_peer(device_id: str) -> bool:
    """Whether this peer has been sent — or has sent — sealed traffic before.

    Loads on a cold cache, for the same reason ``pin_for`` does: False here
    means "no downgrade rule applies", and both sides of the rule read this
    one function. Answering from an empty cache made the refusal expire at
    every restart — which is precisely the property the record was moved to
    disk to remove.
    """
    with _lock:
        return device_id in set(_state_for_read().get("encryptedPeers") or [])


def note_encrypted_peer(device_id: str) -> None:
    """Remember that this machine has sealed a message for *device_id*.

    Across restarts, deliberately. Held only in memory this was a promise that
    expired every time the backend came back up, and a backend restart is a
    daily event, not an attack the relay has to arrange.
    """
    with _lock:
        state = _load_locked()
        peers = state["encryptedPeers"]
        if device_id in peers:
            return
        if len(peers) >= MAX_DEVICES:
            # Refusing to record is what keeps the promise honest: an unrecorded
            # peer would be eligible for a plaintext fallback on the next send.
            raise TrustStoreFull(f"this machine already tracks {len(peers)} encrypted peers")
        peers.append(device_id)
        _save_locked(state)


# ---- notices -----------------------------------------------------------------


def _record_locked(state: dict[str, Any], kind: str, *, device_id: str, detail: dict) -> None:
    notices = state["notices"]
    notices.append(
        {
            "key": f"{kind}:{device_id}:{int(time.time() * 1000)}",
            "kind": kind,
            "deviceId": device_id,
            "at": int(time.time()),
            **detail,
        }
    )
    # Evict the oldest *dismissible* notice first, and only fall back to the
    # oldest of any kind when nothing dismissible is left.
    #
    # Plain oldest-first was wrong in a way worth naming: a first sighting is
    # recorded whenever an unknown device id signs a message, and the party that
    # chooses device ids is the relay. So it could introduce fifty devices and
    # push a "this pinned device changed its key" notice off the end — the
    # refusal would stay in force, because that comes from the pin, but the only
    # thing that tells a person about it would be gone. A warning an attacker
    # can flush is a warning with a hole in it.
    while len(notices) > MAX_NOTICES:
        index = next(
            (i for i, n in enumerate(notices) if n.get("kind") in DISMISSIBLE), 0
        )
        notices.pop(index)


def note_plaintext_refused(device_id: str, *, msg_key: str) -> None:
    """Record that a message from *device_id* was dropped for arriving in the
    clear from a peer that had been encrypting.

    Recorded even though the sender is also told, because the two audiences
    learn different things: the sender is told its message was refused, which a
    hostile sender already knew; the person at this machine is told that
    something asked them to accept cleartext, which is the part worth seeing.
    """
    with _lock:
        state = _load_locked()
        _record_locked(state, NOTICE_PLAINTEXT_REFUSED,
                       device_id=device_id, detail={"msgKey": msg_key})
        _save_locked(state)


# ---- messages already delivered ----------------------------------------------

#: Keys recorded but not yet written out. See SEEN_FLUSH_AFTER.
_seen_pending: dict[str, int] = {}
_seen_last_flush: float = 0.0


def has_seen_message(msg_key: str) -> bool:
    """Whether this message was already delivered.

    Loads on a cold cache — answering False from an empty one would put the
    ledger back where it was before it was persisted, which is the whole bug.

    But it does not *raise* on a store that cannot be opened, which the other
    readers do. This one runs earlier than they do: it is the first thing the
    inbound path asks, ahead of the check that refuses everything while the pins
    are unreadable. Raising here would turn that refusal — the intended outcome
    — into a dropped connection before the refusal could be sent. False is safe
    precisely because the very next check says no anyway.
    """
    with _lock:
        if msg_key in _seen_pending:
            return True
        state = _try_load() if _state is None else _state
        return msg_key in ((state or {}).get("seenMessages") or {})


def note_seen_message(msg_key: str) -> None:
    """Record a delivery, writing out in batches rather than per message.

    Recorded in memory immediately — so a duplicate arriving in the same second
    is still refused — and flushed once a batch or a few seconds have passed.
    """
    global _seen_last_flush
    with _lock:
        now = time.time()
        _seen_pending[msg_key] = int(now)
        if _seen_last_flush == 0.0:
            _seen_last_flush = now
        if (
            len(_seen_pending) >= SEEN_FLUSH_AFTER
            or now - _seen_last_flush >= SEEN_FLUSH_SECONDS
        ):
            _flush_seen_locked(now)


def flush_seen_messages() -> None:
    """Write out whatever is pending. For shutdown, and for tests that need the
    ledger on disk without waiting for a batch to fill."""
    with _lock:
        if _seen_pending:
            _flush_seen_locked(time.time())


def _flush_seen_locked(now: float) -> None:
    global _seen_last_flush
    state = _try_load()
    if state is None:
        # Keep the keys in memory rather than dropping them: this runs while a
        # message is being delivered, and raising would turn a delivery into a
        # dropped connection.
        return
    seen = state.setdefault("seenMessages", {})
    seen.update(_seen_pending)
    _seen_pending.clear()
    _seen_last_flush = now
    cutoff = int(now) - SEEN_MESSAGE_TTL_S
    for key in [k for k, at in seen.items() if int(at or 0) < cutoff]:
        del seen[key]
    # Sorted by recorded time, not insertion order: a flush merges a batch with
    # dict.update, after which insertion order is no longer delivery order.
    if len(seen) > MAX_SEEN_MESSAGES:
        for key in sorted(seen, key=lambda k: int(seen[k] or 0))[: len(seen) - MAX_SEEN_MESSAGES]:
            del seen[key]
    _save_locked(state)


def notices() -> list[dict[str, Any]]:
    """Every recorded notice. Never raises: this feeds a panel, and a status
    read that could fail would leave it with nothing to say. But it does load —
    an empty list from a cold cache reads as "nothing has happened", which is
    the most reassuring thing this function can say and the least likely to be
    checked."""
    with _lock:
        # _try_load, not _state_for_read: this one promises never to raise —
        # it feeds a panel, and a status read that could fail leaves it with
        # nothing to say. It still loads; it just tolerates not being able to.
        state = _try_load() if _state is None else _state
        return [dict(n) for n in (state or {}).get("notices") or []]


def dismiss_notice(key: str) -> bool:
    """Drop one notice. Only a first sighting may go — see ``DISMISSIBLE``."""
    with _lock:
        state = _load_locked()
        for index, notice in enumerate(state["notices"]):
            if notice.get("key") != key:
                continue
            if notice.get("kind") not in DISMISSIBLE:
                return False
            state["notices"].pop(index)
            _save_locked(state)
            return True
        return False


def _reset_for_test() -> None:
    """Forget the process cache and the marker. Tests run against a throwaway
    vault and a throwaway data dir, so this touches nothing real."""
    global _state, _locked_reason, _seen_last_flush
    with _lock:
        _state = None
        _locked_reason = ""
        # Module-level too, and just as much part of "this process has seen
        # nothing". Left behind, a batch recorded by one test is still pending
        # when the next starts and lands in its state document instead.
        _seen_pending.clear()
        _seen_last_flush = 0.0
        # A JSON null reads back as "no marker" (kv_get's default), which is
        # what the marker's absence means; the kv store has no delete.
        _database().kv_set(INITIALISED_KEY, None, now=0)
