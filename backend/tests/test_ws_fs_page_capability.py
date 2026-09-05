"""fs.page_capability: the socket hands out the per-workspace cap for /fs/page.

Only a client that already holds the ws token reaches this handler; what it
returns is scoped to one workspace's URL segment and is what the renderer
puts in the /fs/page path instead of the token.
"""

from __future__ import annotations

import base64

import pytest

from agent_team_backend import ws_auth
from agent_team_backend import ws_handlers


class _Session:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, msg: dict) -> None:
        self.sent.append(msg)


@pytest.fixture(autouse=True)
def ws_token():
    ws_auth._reset_for_test("test-ws-token")
    yield
    ws_auth._reset_for_test("")


@pytest.mark.asyncio
async def test_it_returns_the_segment_and_a_cap_that_verifies_for_it():
    s = _Session()
    await ws_handlers.fs_page_capability(s, "m1", "fs.page_capability", {"workspace_path": "/Users/dev/客戶名單"})
    payload = s.sent[0]["payload"]
    assert payload["ok"] is True
    expected_b64 = base64.urlsafe_b64encode("/Users/dev/客戶名單".encode()).decode().rstrip("=")
    assert payload["ws_b64"] == expected_b64
    assert ws_auth.page_capability_matches(expected_b64, payload["cap"])
    assert payload["cap"] != "test-ws-token"


@pytest.mark.asyncio
async def test_the_cap_is_not_derivable_without_the_token():
    # A different token yields a different cap: the cap is bound to this run.
    s = _Session()
    await ws_handlers.fs_page_capability(s, "m1", "fs.page_capability", {"workspace_path": "/ws"})
    cap_a = s.sent[0]["payload"]["cap"]
    ws_auth._reset_for_test("another-token")
    assert not ws_auth.page_capability_matches("L3dz", cap_a)


@pytest.mark.asyncio
async def test_an_empty_workspace_is_refused():
    s = _Session()
    await ws_handlers.fs_page_capability(s, "m1", "fs.page_capability", {})
    assert s.sent[0].get("ok") is False or "error" in s.sent[0]


def test_no_token_means_no_capability():
    ws_auth._reset_for_test("")
    assert ws_auth.page_capability("L3dz") == ""
    assert not ws_auth.page_capability_matches("L3dz", "")
