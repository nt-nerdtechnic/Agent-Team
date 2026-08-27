"""server_link.account_request: the throwaway connection used before a token exists.

auth.register and auth.login are the server's only unauthenticated endpoints, so
they cannot ride the long-lived link (which dials only once a token is stored and
authenticates before carrying anything). Each call opens its own connection.

What these tests pin down: a server refusal keeps its code, an unreachable server
is a different kind of failure, and unrelated frames on the connection are not
mistaken for the reply.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from agent_team_backend import server_link


class FakeSocket:
    """A connection that replays a scripted list of frames."""

    def __init__(self, frames: list[Any]) -> None:
        self._frames = list(frames)
        self.sent: list[str] = []
        self.closed = False

    async def send(self, raw: str) -> None:
        self.sent.append(raw)

    async def recv(self) -> Any:
        if not self._frames:
            raise ConnectionError("closed")
        return self._frames.pop(0)

    async def __aenter__(self) -> "FakeSocket":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self.closed = True


def _connector(socket: FakeSocket):
    def connect(url: str) -> FakeSocket:
        socket.url = url  # type: ignore[attr-defined]
        return socket

    return connect


@pytest.fixture(autouse=True)
def no_global_link(monkeypatch: pytest.MonkeyPatch):
    """Default to no link installed, so the module falls back to websockets."""
    monkeypatch.setattr(server_link, "_link", None)


def _install(monkeypatch: pytest.MonkeyPatch, socket: FakeSocket) -> None:
    monkeypatch.setattr(server_link.websockets, "connect", _connector(socket))


async def test_returns_the_payload_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    sock = FakeSocket([json.dumps({"id": "acct-1", "ok": True, "payload": {"token": "t1"}})])
    _install(monkeypatch, sock)
    result = await server_link.account_request("ws://s/ws", "auth.login", {"email": "a@b.c"})
    assert result == {"token": "t1"}
    assert json.loads(sock.sent[0])["type"] == "auth.login"
    assert sock.closed is True


async def test_server_refusal_becomes_account_error_with_its_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sock = FakeSocket(
        [json.dumps({"id": "acct-1", "ok": False, "error": {"code": "EMAIL_TAKEN", "message": "nope"}})]
    )
    _install(monkeypatch, sock)
    with pytest.raises(server_link.AccountError) as caught:
        await server_link.account_request("ws://s/ws", "auth.register", {})
    assert caught.value.code == "EMAIL_TAKEN"
    assert caught.value.message == "nope"


async def test_unrelated_frames_are_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    # A server may push events onto any connection at any time; only the frame
    # answering this request counts, otherwise a push would be read as the reply.
    sock = FakeSocket(
        [
            json.dumps({"type": "presence.changed", "payload": {}}),
            "not json at all",
            json.dumps(["a list, not an object"]),
            json.dumps({"id": "someone-else", "ok": True, "payload": {"token": "wrong"}}),
            json.dumps({"id": "acct-1", "ok": True, "payload": {"token": "right"}}),
        ]
    )
    _install(monkeypatch, sock)
    assert await server_link.account_request("ws://s/ws", "auth.login", {}) == {"token": "right"}


async def test_missing_url_never_dials(monkeypatch: pytest.MonkeyPatch) -> None:
    sock = FakeSocket([])
    _install(monkeypatch, sock)
    with pytest.raises(ConnectionError):
        await server_link.account_request("   ", "auth.login", {})
    assert sock.sent == []


async def test_error_without_a_code_still_raises_account_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sock = FakeSocket([json.dumps({"id": "acct-1", "ok": False})])
    _install(monkeypatch, sock)
    with pytest.raises(server_link.AccountError) as caught:
        await server_link.account_request("ws://s/ws", "auth.login", {})
    assert caught.value.code == "SERVER_ERROR"


async def test_non_dict_payload_comes_back_as_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    sock = FakeSocket([json.dumps({"id": "acct-1", "ok": True, "payload": "surprise"})])
    _install(monkeypatch, sock)
    assert await server_link.account_request("ws://s/ws", "auth.login", {}) == {}


async def test_uses_the_links_connector_when_one_is_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tests inject a connector on the link; account_request must honour it,
    otherwise a test that thinks it is offline would dial a real socket."""
    sock = FakeSocket([json.dumps({"id": "acct-1", "ok": True, "payload": {"token": "via-link"}})])

    class StubLink:
        _connect = staticmethod(_connector(sock))

    monkeypatch.setattr(server_link, "_link", StubLink())

    def explode(_url: str) -> Any:  # pragma: no cover - must not be reached
        raise AssertionError("must not fall back to websockets.connect")

    monkeypatch.setattr(server_link.websockets, "connect", explode)
    assert await server_link.account_request("ws://s/ws", "auth.login", {}) == {"token": "via-link"}
