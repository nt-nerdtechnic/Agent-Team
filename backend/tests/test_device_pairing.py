"""The six digits, and the state machine around them.

The pairing this replaced went one way: you picked a device out of a list, typed
four characters of its fingerprint, and it was allowed to drive the CLIs on your
machine — without anybody at that machine being asked or told. What follows pins
down the exchange that replaced it, and the property the whole thing rests on:
the relay carries every frame and can rewrite any field, but it cannot make two
different key pairs produce the same six digits.
"""

from __future__ import annotations

import time

import pytest

from agent_team_backend import device_pairing


@pytest.fixture(autouse=True)
def _clean():
    device_pairing._reset_for_test()
    yield
    device_pairing._reset_for_test()


KEY_A = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQT0="
KEY_B = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI9"
NONCE_A = "bm9uY2UtYQ=="
NONCE_B = "bm9uY2UtYg=="


# ---- the code ----------------------------------------------------------------


def test_both_ends_derive_the_same_code_from_opposite_points_of_view() -> None:
    """Neither machine knows which of them is "a". The code has to come out the
    same anyway, or every honest pairing would look like an attack."""
    mine = device_pairing.sas(key_a=KEY_A, key_b=KEY_B, nonce_a=NONCE_A, nonce_b=NONCE_B)
    theirs = device_pairing.sas(key_a=KEY_B, key_b=KEY_A, nonce_a=NONCE_B, nonce_b=NONCE_A)
    assert mine == theirs
    assert mine


def test_a_known_input_gives_a_known_code() -> None:
    """A fixed answer, because every other test here compares the function with
    itself.

    Change the marker or the separator and all of them still pass — the two ends
    are computed by the same code, so they agree on whatever it now produces.
    What they would not agree with is a *peer running the previous build*, and
    the symptom is two people staring at different digits with no idea why. This
    is the one assertion that notices.
    """
    assert device_pairing.sas(
        key_a=KEY_A, key_b=KEY_B, nonce_a=NONCE_A, nonce_b=NONCE_B
    ) == "159 755"


def test_the_code_is_six_digits_a_person_can_read_aloud() -> None:
    code = device_pairing.sas(key_a=KEY_A, key_b=KEY_B, nonce_a=NONCE_A, nonce_b=NONCE_B)
    assert len(code) == 7 and code[3] == " "
    assert code.replace(" ", "").isdigit()


def test_swapping_a_key_makes_the_two_ends_disagree() -> None:
    """The whole protection, in one assertion.

    The relay carries every frame and can rewrite any field. What it cannot do
    is hold a key of its own in the middle *and* have both people see the same
    digits: change either public key and the two ends compute different codes,
    which is what the comparison catches.
    """
    honest = device_pairing.sas(key_a=KEY_A, key_b=KEY_B, nonce_a=NONCE_A, nonce_b=NONCE_B)
    relay_key = "UkVMQVlSRUxBWVJFTEFZUkVMQVlSRUxBWVJFTEFZUkU9"
    # What the initiator computes when the relay substitutes its own key on the
    # way to it, while the responder still believes it is talking to the peer.
    tampered = device_pairing.sas(
        key_a=KEY_A, key_b=relay_key, nonce_a=NONCE_A, nonce_b=NONCE_B
    )
    assert tampered != honest


def test_changing_either_nonce_changes_the_code() -> None:
    """Both sides contribute, so neither can pick the digits on its own."""
    base = device_pairing.sas(key_a=KEY_A, key_b=KEY_B, nonce_a=NONCE_A, nonce_b=NONCE_B)
    assert device_pairing.sas(
        key_a=KEY_A, key_b=KEY_B, nonce_a="b3RoZXI=", nonce_b=NONCE_B
    ) != base
    assert device_pairing.sas(
        key_a=KEY_A, key_b=KEY_B, nonce_a=NONCE_A, nonce_b="b3RoZXI="
    ) != base


def test_a_nonce_cannot_be_moved_to_the_other_key() -> None:
    """The nonces travel with their keys rather than being sorted separately.

    Sorted apart, a relay could pair one side's nonce with the other's key and
    still land on the same digest — the digits would match while the two ends
    were describing different pairings.
    """
    honest = device_pairing.sas(key_a=KEY_A, key_b=KEY_B, nonce_a=NONCE_A, nonce_b=NONCE_B)
    crossed = device_pairing.sas(key_a=KEY_A, key_b=KEY_B, nonce_a=NONCE_B, nonce_b=NONCE_A)
    assert crossed != honest


def test_half_an_exchange_produces_no_code_at_all() -> None:
    """A code over missing input would still be six digits, and two people could
    still successfully compare it."""
    assert device_pairing.sas(key_a=KEY_A, key_b="", nonce_a=NONCE_A, nonce_b=NONCE_B) == ""
    assert device_pairing.sas(key_a=KEY_A, key_b=KEY_B, nonce_a="", nonce_b=NONCE_B) == ""


def test_nonces_are_not_predictable() -> None:
    assert len({device_pairing.new_nonce() for _ in range(50)}) == 50


# ---- the state machine -------------------------------------------------------


def test_the_initiator_walks_request_response_confirm() -> None:
    pairing = device_pairing.begin("dev-b", device_name="M3")
    assert pairing.state == device_pairing.STATE_AWAITING_RESPONSE
    assert pairing.role == device_pairing.ROLE_INITIATOR
    assert pairing.our_nonce and not pairing.their_nonce

    device_pairing.accept_response("dev-b", their_key=KEY_B, their_nonce=NONCE_B)
    assert device_pairing.get("dev-b").state == device_pairing.STATE_AWAITING_LOCAL

    device_pairing.confirm("dev-b")
    assert device_pairing.get("dev-b").state == device_pairing.STATE_AWAITING_REMOTE


def test_the_responder_starts_with_both_nonces_and_its_own_turn() -> None:
    pairing = device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_nonce=NONCE_A
    )
    assert pairing.role == device_pairing.ROLE_RESPONDER
    assert pairing.state == device_pairing.STATE_AWAITING_LOCAL
    assert pairing.their_nonce == NONCE_A and pairing.our_nonce


def test_only_one_exchange_per_device_at_a_time() -> None:
    """Two would put two codes on screen for the same pair of machines, and the
    person comparing has no way to tell which card belongs to which."""
    device_pairing.begin("dev-b", device_name="M3")
    with pytest.raises(device_pairing.PairingError):
        device_pairing.begin("dev-b", device_name="M3")
    with pytest.raises(device_pairing.PairingError):
        device_pairing.accept_request(
            "dev-b", device_name="M3", their_key=KEY_B, their_nonce=NONCE_B
        )


def test_a_request_expires_and_stops_being_answerable() -> None:
    """A request nobody remembers starting must not be confirmable later."""
    pairing = device_pairing.begin("dev-b", device_name="M3")
    pairing.started_at = time.time() - device_pairing.REQUEST_TTL_S - 1

    assert device_pairing.get("dev-b") is None
    with pytest.raises(device_pairing.PairingError):
        device_pairing.confirm("dev-b")


def test_a_response_out_of_order_is_refused() -> None:
    device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_nonce=NONCE_A
    )
    with pytest.raises(device_pairing.PairingError):
        device_pairing.accept_response("dev-a", their_key=KEY_A, their_nonce=NONCE_A)


def test_a_response_cannot_revise_the_key_the_request_carried() -> None:
    """Otherwise the relay could wait until the code was on screen and then swap
    the key it covers."""
    device_pairing.begin("dev-b", device_name="M3", their_key=KEY_B)
    with pytest.raises(device_pairing.PairingError):
        device_pairing.accept_response("dev-b", their_key=KEY_A, their_nonce=NONCE_B)


def test_confirming_twice_is_refused() -> None:
    device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_nonce=NONCE_A
    )
    device_pairing.confirm("dev-a")
    with pytest.raises(device_pairing.PairingError):
        device_pairing.confirm("dev-a")


def test_cancelling_leaves_nothing_to_confirm() -> None:
    device_pairing.begin("dev-b", device_name="M3")
    assert device_pairing.cancel("dev-b") is not None
    assert device_pairing.cancel("dev-b") is None
    with pytest.raises(device_pairing.PairingError):
        device_pairing.confirm("dev-b")


# ---- the wire ----------------------------------------------------------------


def test_a_frame_survives_the_round_trip() -> None:
    text = device_pairing.envelope(
        device_pairing.PAIR_REQUEST, nonce=NONCE_A, signKey=KEY_A
    )
    frame = device_pairing.parse(text)
    assert frame["kind"] == device_pairing.PAIR_REQUEST
    assert frame["nonce"] == NONCE_A and frame["signKey"] == KEY_A


def test_an_ordinary_message_is_not_mistaken_for_a_frame() -> None:
    """The body is otherwise free text going to a CLI. Something a person could
    plausibly type must never put a pairing card on somebody's screen."""
    for text in (
        "please review the diff",
        '{"kind": "pair-request"}',
        '{"marker": "something-else", "kind": "pair-request"}',
        "navide/pair/v1",
        "",
    ):
        assert device_pairing.parse(text) is None


def test_an_unknown_kind_is_not_a_frame() -> None:
    """A body this build cannot read has to fall through to being an ordinary
    message, or a future kind would vanish instead of being refused visibly."""
    assert device_pairing.parse('{"marker": "navide/pair/v1", "kind": "pair-later"}') is None


def test_an_unknown_kind_cannot_be_sent_either() -> None:
    with pytest.raises(device_pairing.PairingError):
        device_pairing.envelope("pair-whatever")


# ---- both sides, or neither --------------------------------------------------


def test_the_responder_alone_cannot_finish_it() -> None:
    """The half that carries the security property.

    Somebody asked to come in; a person here says whether the digits match. The
    asking side's own click could never be that check — it is the party being
    authenticated — so a responder that confirmed and then heard nothing back
    must still not be paired.
    """
    device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_nonce=NONCE_A
    )
    device_pairing.confirm("dev-a")

    assert device_pairing.complete("dev-a") is None
    assert device_pairing.get("dev-a").state == device_pairing.STATE_AWAITING_REMOTE


def test_the_peer_confirming_does_not_answer_for_the_responder() -> None:
    """If their confirm alone finished it, the person at this end could still be
    looking at the card when the pin was written — and "refuse" would mean
    nothing, because the answer had already been given for them."""
    device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_nonce=NONCE_A
    )
    device_pairing.note_peer_confirmed("dev-a")

    assert device_pairing.complete("dev-a") is None
    assert device_pairing.get("dev-a") is not None


def test_the_initiator_is_not_finished_by_the_other_side_alone() -> None:
    """The asymmetry this replaced was a CRITICAL, and the reason is the relay.

    It used to finish on the far end's confirm alone, reasoning that comparing
    digits is one act by one person at two screens. That holds when there *is*
    another machine and another person. A relay can decline to forward the
    request and answer with its own key — the first frame of an exchange is
    verified against the key it carries — and the initiator would pin it,
    approved, having compared nothing with nobody.

    The digits cannot rescue it either: the SAS comes from two public keys and
    two nonces, and a relay supplies half and receives the other half, so it
    knows them. Only a person reading two screens is outside its reach.
    """
    device_pairing.begin("dev-b", device_name="M3")
    device_pairing.accept_response("dev-b", their_key=KEY_B, their_nonce=NONCE_B)

    # The far side answers. On its own that used to be enough.
    device_pairing.note_peer_confirmed("dev-b")
    assert device_pairing.complete("dev-b") is None, "nobody here compared anything yet"

    device_pairing.confirm("dev-b")
    finished = device_pairing.complete("dev-b")
    assert finished is not None and finished.their_key == KEY_B
    assert finished.we_confirmed and finished.peer_confirmed


def test_the_initiator_grants_nothing_while_it_waits() -> None:
    """What the extra step buys: pressing Pair and walking away is safe.

    Not "less is granted" — *nothing* is. No pin, so no ring and no policy
    exception; a message from that device is refused as unpaired like any
    stranger's.
    """
    device_pairing.begin("dev-wait", device_name="M3")
    device_pairing.accept_response("dev-wait", their_key=KEY_B, their_nonce=NONCE_B)
    device_pairing.note_peer_confirmed("dev-wait")

    assert device_pairing.complete("dev-wait") is None
    pending = device_pairing.get("dev-wait")
    assert pending is not None and pending.we_confirmed is False
    # And the digits are on the card, which is the whole point of the wait.
    assert device_pairing.code_for(pending, our_key=KEY_A)


def test_both_confirming_pairs_the_responder_once_in_either_order() -> None:
    for first_is_peer in (False, True):
        device_pairing._reset_for_test()
        device_pairing.accept_request(
            "dev-a", device_name="M4", their_key=KEY_A, their_nonce=NONCE_A
        )
        if first_is_peer:
            device_pairing.note_peer_confirmed("dev-a")
            device_pairing.confirm("dev-a")
        else:
            device_pairing.confirm("dev-a")
            device_pairing.note_peer_confirmed("dev-a")

        finished = device_pairing.complete("dev-a")
        assert finished is not None and finished.their_key == KEY_A
        # Gone, so a duplicate confirm cannot pin a second time.
        assert device_pairing.complete("dev-a") is None


def test_a_late_peer_confirm_finds_nothing_to_agree_with() -> None:
    """Their confirm for an exchange this side already dropped — a refusal here,
    or an expiry — must not resurrect it."""
    device_pairing.begin("dev-b", device_name="M3")
    device_pairing.cancel("dev-b")

    assert device_pairing.note_peer_confirmed("dev-b") is None
    assert device_pairing.complete("dev-b") is None
