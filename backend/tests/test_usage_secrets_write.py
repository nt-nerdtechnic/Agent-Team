"""usage.secrets.write: the maintainer button that persists Antigravity's
OAuth constants to ~/navide-signing/usage_secrets.py."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def test_registry_has_usage_secrets_write() -> None:
    assert ws_handlers.lookup("usage.secrets.write") is not None


@pytest.mark.asyncio
async def test_writes_secrets_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    session = _session()

    await app.handle_message(session, {
        "id": "s1",
        "type": "usage.secrets.write",
        "payload": {"client_id": "id-123.apps.googleusercontent.com",
                    "client_secret": "GOCSPX-abc"},
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["ok"] is True
    target = tmp_path / "navide-signing" / "usage_secrets.py"
    assert target.exists()
    # The generated module must define exactly the values we passed in.
    ns: dict[str, Any] = {}
    exec(compile(target.read_text(encoding="utf-8"), str(target), "exec"), ns)
    assert ns["ANTIGRAVITY_CLIENT_ID"] == "id-123.apps.googleusercontent.com"
    assert ns["ANTIGRAVITY_CLIENT_SECRET"] == "GOCSPX-abc"


@pytest.mark.asyncio
async def test_pasted_value_cannot_inject_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    session = _session()
    # A hostile value that would break out of a naive f-string literal.
    hostile = 'x"\nimport os\nos.environ["PWNED"] = "1"\n_ = "'

    await app.handle_message(session, {
        "id": "s2",
        "type": "usage.secrets.write",
        "payload": {"client_id": hostile, "client_secret": "GOCSPX-ok"},
    })

    assert session.websocket.sent[0]["ok"] is True  # type: ignore[attr-defined]
    target = tmp_path / "navide-signing" / "usage_secrets.py"
    ns: dict[str, Any] = {}
    exec(compile(target.read_text(encoding="utf-8"), str(target), "exec"), ns)
    # The value round-trips verbatim and nothing was executed.
    assert ns["ANTIGRAVITY_CLIENT_ID"] == hostile
    assert "PWNED" not in ns


@pytest.mark.asyncio
async def test_missing_values_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    session = _session()

    await app.handle_message(session, {
        "id": "s3",
        "type": "usage.secrets.write",
        "payload": {"client_id": "  ", "client_secret": ""},
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["ok"] is False
    assert not (tmp_path / "navide-signing" / "usage_secrets.py").exists()
