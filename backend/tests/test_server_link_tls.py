"""TLS trust for the outbound Navide-Server link.

A packaged backend carries no OpenSSL default CA path that exists on the user's
machine, so every ``wss://`` dial failed CERTIFICATE_VERIFY_FAILED and surfaced
as "Cannot reach the server" — an unreachable-server message on a reachable
server. These pin the store the dial actually uses.
"""

from __future__ import annotations

import ssl
import threading
import time

import certifi
import pytest

from agent_team_backend import server_link
from agent_team_backend.server_link import ServerLink, ServerLinkConfig


class _Recorder:
    """Stands in for ``websockets.connect``, keeping what it was handed."""

    def __init__(self) -> None:
        self.url: str | None = None
        self.kwargs: dict | None = None

    def __call__(self, url, **kwargs):
        self.url = url
        self.kwargs = kwargs
        return object()


@pytest.fixture(autouse=True)
def _fresh_context():
    # Held by reference: a test may monkeypatch the module attribute with a
    # plain function, which has no cache to clear.
    cached = server_link._tls_context
    cached.cache_clear()
    yield
    cached.cache_clear()


def test_tls_context_loads_real_roots():
    context = server_link._tls_context()

    # The failure this guards is an empty trust store, not a wrong flag: with
    # no roots loaded, verification cannot succeed against any server.
    assert context.get_ca_certs(), "no CA roots loaded"
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True


def test_tls_context_adds_certifi_on_top_of_the_default_roots(monkeypatch):
    calls: list = []

    def _defaults(self, purpose=ssl.Purpose.SERVER_AUTH):
        calls.append("default")

    def _certifi(self, cafile=None, capath=None, cadata=None):
        calls.append(("certifi", cafile))

    monkeypatch.setattr(ssl.SSLContext, "load_default_certs", _defaults)
    monkeypatch.setattr(ssl.SSLContext, "load_verify_locations", _certifi)

    server_link._tls_context()

    # Both, in that order. certifi alone would drop a private root out of the
    # Keychain or a corporate proxy's CA — the mirror image of the bug this
    # whole file exists to fix, and wearing the same error message.
    assert calls == ["default", ("certifi", certifi.where())]


def test_wss_dial_carries_the_trust_store(monkeypatch):
    recorder = _Recorder()
    monkeypatch.setattr(server_link.websockets, "connect", recorder)

    server_link._dial("wss://server.navide.dev/ws")

    assert recorder.url == "wss://server.navide.dev/ws"
    assert recorder.kwargs["ssl"] is server_link._tls_context()


def test_plaintext_dial_gets_no_ssl_argument(monkeypatch):
    recorder = _Recorder()
    monkeypatch.setattr(server_link.websockets, "connect", recorder)

    server_link._dial("ws://localhost:8787/ws")

    # websockets rejects an ssl argument on a plaintext URL, so local
    # development against ws:// must not receive one.
    assert "ssl" not in recorder.kwargs


def test_link_dials_through_the_tls_connector():
    assert ServerLink()._connect is server_link._dial


def test_injected_connector_is_left_alone():
    injected = _Recorder()

    assert ServerLink(connect=injected)._connect is injected


async def test_warming_builds_the_store_off_the_event_loop(monkeypatch):
    threads: list[threading.Thread] = []

    def _spy():
        threads.append(threading.current_thread())
        return ssl.create_default_context(cafile=certifi.where())

    monkeypatch.setattr(server_link, "_tls_context", _spy)

    await server_link._warm_tls("wss://server.navide.dev/ws")

    # Parsing the bundle is 200-500ms of blocking work; the loop it would
    # otherwise block carries every terminal's output.
    assert threads, "the trust store was never built"
    assert threads[0] is not threading.main_thread()


async def test_warming_skips_plaintext_urls(monkeypatch):
    called = False

    def _spy():
        nonlocal called
        called = True
        return ssl.create_default_context()

    monkeypatch.setattr(server_link, "_tls_context", _spy)

    await server_link._warm_tls("ws://localhost:8787/ws")

    assert called is False


async def test_account_request_warms_before_it_dials(monkeypatch):
    order: list[str] = []

    async def _warm(url):
        order.append("warm")

    class _Conn:
        async def __aenter__(self):
            order.append("dial")
            raise RuntimeError("stop here")

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(server_link, "_warm_tls", _warm)
    monkeypatch.setattr(server_link, "_link", None)
    monkeypatch.setattr(server_link, "_dial", lambda url, **kw: _Conn())

    with pytest.raises(RuntimeError):
        await server_link.account_request(
            "wss://server.navide.dev/ws", "auth.login", {}
        )

    assert order == ["warm", "dial"]


async def test_link_session_warms_before_it_dials(monkeypatch):
    order: list[str] = []

    async def _warm(url):
        order.append(f"warm:{url}")

    class _Conn:
        async def __aenter__(self):
            order.append("dial")
            raise RuntimeError("stop here")

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(server_link, "_warm_tls", _warm)
    link = ServerLink(connect=lambda url, **kw: _Conn())

    with pytest.raises(RuntimeError):
        await link._session(ServerLinkConfig(url="wss://server.navide.dev/ws", token="t"))

    assert order == ["warm:wss://server.navide.dev/ws", "dial"]


async def test_warming_gives_up_rather_than_hanging(monkeypatch):
    monkeypatch.setattr(server_link, "DIAL_TIMEOUT_S", 0.05)

    def _stuck():
        time.sleep(0.5)

    monkeypatch.setattr(server_link, "_tls_context", _stuck)

    # to_thread runs on the shared executor, and a starved executor is a
    # failure this repo has had before. Unbounded, the link would sit in
    # STATE_CONNECTING for ever instead of landing in _run's backoff.
    with pytest.raises(TimeoutError):
        await server_link._warm_tls("wss://server.navide.dev/ws")
