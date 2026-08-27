"""p2p.account.*: signing in to a Navide-Server account from the Settings pane.

The transport (a throwaway connection to an unauthenticated endpoint) is
server_link's; these tests own the handler layer — what is required before
anything is sent, which failures keep the server's own code and which collapse
into a link error, and what is allowed to reach the vault and the settings.

The distinction these tests exist to protect: a *credential* failure tells the
user to retype something, a *link* failure tells them the server is unreachable.
Reporting one as the other sends them to change a password that was correct.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, server_link, ws_handlers


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


async def _call(msg_type: str, payload: dict) -> dict:
    session = _session()
    await app.handle_message(session, {"id": "x1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


class FakeSettings:
    """Enough of ui_settings_store for these handlers: set() returns the delta."""

    def __init__(self) -> None:
        self.values: dict[str, Any] = {}

    def get(self) -> dict[str, Any]:
        return dict(self.values)

    def set(self, delta: dict[str, Any]) -> dict[str, Any]:
        applied: dict[str, Any] = {}
        for key, value in delta.items():
            if value is None:
                self.values.pop(key, None)
            else:
                self.values[key] = value
            applied[key] = value
        return applied


GOOD_ACCOUNT = {
    "tenantId": "tn-abc",
    "tenantName": "Neil 的網路",
    "memberId": "m-1",
    "displayName": "neil",
    "email": "neil@example.com",
    "role": "admin",
    "token": "tok-long-lived",
}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch):
    """Wire the handlers to fakes and record what each layer was asked to do."""
    settings = FakeSettings()
    tokens: list[str | None] = []
    requests: list[tuple[str, str, dict]] = []
    reconfigured: list[int] = []

    async def fake_account_request(url: str, msg_type: str, payload: dict) -> dict:
        requests.append((url, msg_type, payload))
        return dict(GOOD_ACCOUNT)

    def fake_set_token(token: str | None) -> None:
        tokens.append(token)

    async def fake_reconfigure() -> None:
        reconfigured.append(1)

    async def fake_status() -> dict:
        return {"state": "connected", "serverUrl": "ws://s/ws", "hasToken": bool(tokens and tokens[-1])}

    async def fake_broadcast(_event: Any) -> None:
        return None

    monkeypatch.setattr(app, "ui_settings_store", settings)
    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    monkeypatch.setattr(server_link, "account_request", fake_account_request)
    monkeypatch.setattr(server_link, "set_access_token", fake_set_token)
    monkeypatch.setattr(server_link, "reconfigure", fake_reconfigure)
    monkeypatch.setattr(server_link, "status", fake_status)
    return {
        "settings": settings,
        "tokens": tokens,
        "requests": requests,
        "reconfigured": reconfigured,
    }


LOGIN = {"serverUrl": " ws://s/ws ", "email": " neil@example.com ", "password": "passw0rd!"}


# ---- happy path -------------------------------------------------------------


async def test_login_stores_token_and_reconnects(env) -> None:
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert resp["ok"] is True
    assert env["tokens"] == ["tok-long-lived"]
    assert env["reconfigured"] == [1]
    # url and email are trimmed on the way in; the account row echoes the server
    url, verb, sent = env["requests"][0]
    assert (url, verb) == ("ws://s/ws", "auth.login")
    assert sent["email"] == "neil@example.com"


async def test_login_never_echoes_the_password(env) -> None:
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert "passw0rd!" not in repr(resp)


async def test_login_persists_url_and_email_but_not_token(env) -> None:
    await _call("p2p.account.login", dict(LOGIN))
    stored = env["settings"].get()
    assert stored[server_link.SERVER_URL_SETTING] == "ws://s/ws"
    assert stored[server_link.ACCOUNT_EMAIL_SETTING] == "neil@example.com"
    # The long-lived credential belongs in the vault, never in plain settings.
    assert "tok-long-lived" not in repr(stored)


async def test_register_forwards_optional_names(env) -> None:
    await _call(
        "p2p.account.register",
        {**LOGIN, "displayName": " Neil ", "tenantName": " 我的網路 "},
    )
    _url, verb, sent = env["requests"][0]
    assert verb == "auth.register"
    assert sent["displayName"] == "Neil"
    assert sent["tenantName"] == "我的網路"


async def test_register_omits_blank_optional_names(env) -> None:
    await _call("p2p.account.register", {**LOGIN, "displayName": "   ", "tenantName": ""})
    _url, _verb, sent = env["requests"][0]
    assert "displayName" not in sent and "tenantName" not in sent


async def test_login_answers_with_status_and_account(env) -> None:
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert resp["payload"]["status"]["state"] == "connected"
    assert resp["payload"]["account"]["tenantName"] == "Neil 的網路"
    assert resp["payload"]["account"]["role"] == "admin"


# ---- refusals before anything is sent ---------------------------------------


@pytest.mark.parametrize("missing", ["serverUrl", "email", "password"])
async def test_required_fields(env, missing: str) -> None:
    payload = dict(LOGIN)
    payload[missing] = "   "
    resp = await _call("p2p.account.login", payload)
    assert resp["ok"] is False
    assert resp["error"]["code"] == "BAD_REQUEST"
    # Nothing may reach the server, the vault, or the settings on a bad request.
    assert env["requests"] == [] and env["tokens"] == [] and env["settings"].get() == {}


# ---- failures: credential vs link -------------------------------------------


async def test_server_refusal_keeps_its_own_code(env, monkeypatch: pytest.MonkeyPatch) -> None:
    async def taken(url: str, msg_type: str, payload: dict) -> dict:
        raise server_link.AccountError("EMAIL_TAKEN", "already registered")

    monkeypatch.setattr(server_link, "account_request", taken)
    resp = await _call("p2p.account.register", dict(LOGIN))
    assert resp["error"]["code"] == "EMAIL_TAKEN"
    # A refused registration must not disturb what is already configured.
    assert env["tokens"] == [] and env["settings"].get() == {}


async def test_unreachable_server_is_a_link_error_not_a_credential_error(
    env, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def down(url: str, msg_type: str, payload: dict) -> dict:
        raise ConnectionError("connection refused")

    monkeypatch.setattr(server_link, "account_request", down)
    resp = await _call("p2p.account.login", dict(LOGIN))
    # Not AUTH_REJECTED: the password was never judged, so telling the user it
    # was wrong sends them to change something that is already correct.
    assert resp["error"]["code"] == "LINK_OFFLINE"


async def test_reply_without_a_token_is_rejected(env, monkeypatch: pytest.MonkeyPatch) -> None:
    async def tokenless(url: str, msg_type: str, payload: dict) -> dict:
        return {"memberId": "m-1"}

    monkeypatch.setattr(server_link, "account_request", tokenless)
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert resp["error"]["code"] == "SERVER_ERROR"
    assert env["tokens"] == []


async def test_vault_write_failure_is_reported(env, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(token: str | None) -> None:
        raise RuntimeError("keychain locked")

    monkeypatch.setattr(server_link, "set_access_token", boom)
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert resp["error"]["code"] == "P2P_TOKEN_WRITE_FAILED"
    assert env["reconfigured"] == []


# ---- logout -----------------------------------------------------------------


async def test_logout_clears_credential_and_email(env) -> None:
    await _call("p2p.account.login", dict(LOGIN))
    resp = await _call("p2p.account.logout", {})
    assert resp["ok"] is True
    assert env["tokens"][-1] is None
    assert server_link.ACCOUNT_EMAIL_SETTING not in env["settings"].get()


async def test_logout_keeps_the_server_url(env) -> None:
    await _call("p2p.account.login", dict(LOGIN))
    await _call("p2p.account.logout", {})
    # Signing out is "not right now", not "never again" — making the user retype
    # the address every time is the friction that gets a feature abandoned.
    assert env["settings"].get()[server_link.SERVER_URL_SETTING] == "ws://s/ws"


async def test_logout_reconnects_so_the_link_drops(env) -> None:
    await _call("p2p.account.login", dict(LOGIN))
    env["reconfigured"].clear()
    await _call("p2p.account.logout", {})
    assert env["reconfigured"] == [1]


def test_handlers_are_registered() -> None:
    for name in ("p2p.account.register", "p2p.account.login", "p2p.account.logout"):
        assert ws_handlers.lookup(name) is not None
