"""Tests for the bound-account credential auto-answer path (Phase B).

When a git operation is given a `credential` (from the main-process
safeStorage account store, decrypted just for that op), git_service must
auto-answer the GIT_ASKPASS prompts from it -- with NO frontend modal -- and
disable inherited credential helpers so git actually falls through to askpass.

These tests drive git_service._askpass_env() directly, simulating what
git_askpass_helper.py does over the wire, without spawning a real git process.
"""
from __future__ import annotations

import asyncio
import json
import socket

import pytest

from agent_team_backend import git_service


def _send_request(port: int, token: str, prompt: str) -> dict:
    """Connect like the helper script would, send one JSON line, return the reply."""
    with socket.create_connection(("127.0.0.1", port), timeout=5.0) as sock:
        sock.sendall((json.dumps({"token": token, "prompt": prompt}) + "\n").encode("utf-8"))
        with sock.makefile("rb") as reader:
            line = reader.readline()
    return json.loads(line.decode("utf-8"))


class TestPureHelpers:
    def test_field_for_prompt_classifies_username_and_password(self):
        assert git_service._field_for_prompt("Username for 'https://github.com': ") == "username"
        assert git_service._field_for_prompt("Password for 'https://github.com': ") == "password"
        # Anything not clearly a username prompt is treated as a password prompt.
        assert git_service._field_for_prompt("Enter passphrase: ") == "password"

    def test_git_base_disables_helper_only_with_credential(self):
        assert git_service._git_base(None) == ["git"]
        assert git_service._git_base({"username": "u", "token": "t"}) == [
            "git",
            "-c",
            "credential.helper=",
        ]

    def test_credential_hosts_accept_idna_but_reject_nfkc_compatibility_characters(self):
        assert git_service._canonical_credential_host("bücher.example") == "xn--bcher-kva.example"
        assert git_service._canonical_credential_host("xn--bcher-kva.example") == "xn--bcher-kva.example"
        assert git_service._canonical_credential_host("ｇｉｔｈｕｂ．ｃｏｍ") is None
        assert git_service._canonical_https_prompt_host(
            "Password for 'https://ｇｉｔｈｕｂ．ｃｏｍ/repo':"
        ) is None


class TestAutoAnswer:
    @pytest.mark.asyncio
    async def test_credential_auto_answers_without_using_emitter(self):
        # The interactive emitter must NOT fire when a bound credential is present
        # (no broadcast, no modal); prompts are answered straight from the token.
        emitter_calls: list[tuple[str, str]] = []

        async def emitter(request_id: str, prompt: str) -> None:
            emitter_calls.append((request_id, prompt))

        credential = {"username": "alice", "token": "ghp_secret"}
        async with git_service._askpass_env(emitter, None, credential) as env:
            assert env is not None
            port = int(env["NAVIDE_ASKPASS_PORT"])
            token = env["NAVIDE_ASKPASS_TOKEN"]

            loop = asyncio.get_running_loop()
            user_resp = await loop.run_in_executor(
                None, _send_request, port, token, "Username for 'https://github.com':"
            )
            pass_resp = await loop.run_in_executor(
                None, _send_request, port, token, "Password for 'https://github.com':"
            )

        assert user_resp == {"value": "alice"}
        assert pass_resp == {"value": "ghp_secret"}
        assert emitter_calls == []

    @pytest.mark.asyncio
    async def test_no_credential_and_no_emitter_yields_none_env(self):
        # Byte-for-byte the pre-feature behavior: callers get None (inherit env).
        async with git_service._askpass_env(None, None) as env:
            assert env is None

    @pytest.mark.asyncio
    async def test_emitter_used_when_no_credential(self):
        # Without a bound credential, the interactive flow still forwards prompts
        # to the emitter (existing modal behavior is unchanged).
        received: list[tuple[str, str]] = []

        async def emitter(request_id: str, prompt: str) -> None:
            received.append((request_id, prompt))
            git_service.resolve_credential(request_id, "typed-by-user")

        async with git_service._askpass_env(emitter, None, None) as env:
            assert env is not None
            port = int(env["NAVIDE_ASKPASS_PORT"])
            token = env["NAVIDE_ASKPASS_TOKEN"]

            loop = asyncio.get_running_loop()
            resp = await loop.run_in_executor(
                None, _send_request, port, token, "Password for 'https://github.com':"
            )

        assert resp == {"value": "typed-by-user"}
        assert len(received) == 1
