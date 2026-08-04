"""Guided-install flow: alternate binaries, prompt opt-out, install context.

Covers what the install prompt itself depends on — a CLI installed under its
legacy name must not read as missing, declining forever must survive a restart,
and every install result must name the dep it belongs to.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agent_team_backend import app as app_mod
from agent_team_backend import onboarding_deps as ob
from agent_team_backend.onboarding_deps import Dep


_ALIASED = Dep("cursor", "Cursor CLI", "", "agent_cli", ["agent", "--version"],
               r"(\d+\.\d+\.\d+)", alt_commands=("cursor-agent",),
               install_cmd="curl https://example.invalid/install | bash")


def _which(available: dict[str, str]):
    return lambda name: available.get(Path(name).name)


# ── alternate executables ────────────────────────────────────────────────────
def test_resolve_prefers_the_primary_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", _which({
        "agent": "/opt/bin/agent", "cursor-agent": "/opt/bin/cursor-agent",
    }))
    assert ob.resolve_executable(_ALIASED) == "/opt/bin/agent"


def test_resolve_falls_back_to_the_legacy_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", _which({"cursor-agent": "/opt/bin/cursor-agent"}))
    assert ob.resolve_executable(_ALIASED) == "/opt/bin/cursor-agent"


def test_detect_finds_a_cli_installed_under_its_legacy_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The whole point: a machine carrying only `cursor-agent` used to be told
    # "not installed" and offered an install it did not need.
    monkeypatch.setattr(ob.shutil, "which", _which({"cursor-agent": "/opt/bin/cursor-agent"}))
    probed: list[list[str]] = []

    def run(cmd, *_a, **_k):
        probed.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, "2026.1.5", "")

    monkeypatch.setattr(ob.subprocess, "run", run)
    result = ob.detect_dep(_ALIASED)
    assert result["status"] == "ok" and result["version"] == "2026.1.5"
    assert probed == [["/opt/bin/cursor-agent", "--version"]]


def test_registry_declares_the_cursor_alias() -> None:
    assert ob.DEPS_BY_ID["cursor"].alt_commands == ("cursor-agent",)


def test_deps_without_an_alias_are_unaffected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", _which({}))
    assert ob.resolve_executable(ob.DEPS_BY_ID["claude"]) == ""


# ── spawn command rewriting ──────────────────────────────────────────────────
def test_spawn_command_switches_to_the_installed_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app_mod.shutil, "which", _which({"agent": "/opt/bin/agent"}))
    monkeypatch.setattr(ob.shutil, "which", _which({"agent": "/opt/bin/agent"}))
    command = ["/bin/zsh", "-ilc", "cursor-agent --resume abc"]
    assert app_mod._command_with_installed_cli_alias("cursor", command) == [
        "/bin/zsh", "-ilc", "/opt/bin/agent --resume abc",
    ]


def test_spawn_command_untouched_when_the_requested_name_exists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    available = {"cursor-agent": "/opt/bin/cursor-agent", "agent": "/opt/bin/agent"}
    monkeypatch.setattr(app_mod.shutil, "which", _which(available))
    monkeypatch.setattr(ob.shutil, "which", _which(available))
    command = ["/bin/zsh", "-ilc", "cursor-agent --resume abc"]
    assert app_mod._command_with_installed_cli_alias("cursor", command) == command


def test_spawn_command_untouched_for_a_cli_without_aliases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app_mod.shutil, "which", _which({}))
    command = ["/bin/zsh", "-ilc", "claude --dangerously-skip-permissions"]
    assert app_mod._command_with_installed_cli_alias("claude", command) == command


def test_spawn_command_untouched_when_nothing_is_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app_mod.shutil, "which", _which({}))
    monkeypatch.setattr(ob.shutil, "which", _which({}))
    command = ["/bin/zsh", "-ilc", "cursor-agent"]
    assert app_mod._command_with_installed_cli_alias("cursor", command) == command


def test_spawn_probe_accepts_the_legacy_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app_mod.shutil, "which", _which({"cursor-agent": "/opt/bin/cursor-agent"}))
    monkeypatch.setattr(ob.shutil, "which", _which({"cursor-agent": "/opt/bin/cursor-agent"}))
    monkeypatch.setattr(
        app_mod.subprocess, "run",
        lambda cmd, *_a, **_k: subprocess.CompletedProcess(cmd, 0, "2026.1.5", ""),
    )
    probe = app_mod._probe_agent_cli_for_spawn("cursor", "cursor-agent")
    assert probe is not None and probe["binary_path"] == "/opt/bin/cursor-agent"


# ── install result context ───────────────────────────────────────────────────
def test_install_result_names_the_dep(monkeypatch: pytest.MonkeyPatch) -> None:
    # The dialog renders label + docs link from the result itself, so every
    # branch has to carry them — including the ones that fail.
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/opt/homebrew/bin/brew")
    result = ob.install_dep("claude")
    assert result["label"] == "Claude Code"
    assert result["docs_url"] == ob.DEPS_BY_ID["claude"].docs_url
    assert result["dep_id"] == "claude"


def test_missing_bootstrap_result_still_names_the_dep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: None)
    result = ob.install_dep("claude")
    assert result["ok"] is False
    assert result["missing_requirements"] == ["npm"]
    assert result["label"] == "Claude Code" and result["docs_url"]


def test_curl_installers_declare_their_bootstrap_binary() -> None:
    # Without this the bootstrap gate silently skipped every script install.
    for dep in ob.DEPS:
        if dep.install_cmd.lstrip().startswith("curl") or "$(curl" in dep.install_cmd:
            assert "curl" in dep.requires_binaries, dep.id


# ── per-CLI prompt opt-out ───────────────────────────────────────────────────
def _isolate_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_flag_path", lambda: tmp_path / "app-data" / "onboarding.json")
    monkeypatch.setattr(ob, "_legacy_flag_path", lambda: tmp_path / "legacy" / "onboarding.json")
    monkeypatch.delenv("AGENT_TEAM_SKIP_ONBOARDING", raising=False)


def test_install_prompt_dismissal_roundtrip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _isolate_state(monkeypatch, tmp_path)
    assert ob.install_prompt_dismissals() == []
    assert ob.set_install_prompt_dismissed("qwen", True)["ok"] is True
    assert ob.install_prompt_dismissals() == ["qwen"]
    ob.set_install_prompt_dismissed("qwen", False)
    assert ob.install_prompt_dismissals() == []


def test_install_prompt_dismissal_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _isolate_state(monkeypatch, tmp_path)
    ob.set_install_prompt_dismissed("qwen", True)
    ob.set_install_prompt_dismissed("qwen", True)
    assert ob.install_prompt_dismissals() == ["qwen"]


def test_install_prompt_dismissal_rejects_unknown_deps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _isolate_state(monkeypatch, tmp_path)
    result = ob.set_install_prompt_dismissed("../evil", True)
    assert result["ok"] is False
    assert ob.install_prompt_dismissals() == []


def test_dismissals_survive_alongside_the_completion_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Both live in the same KV document — one must not clobber the other.
    _isolate_state(monkeypatch, tmp_path)
    ob.set_install_prompt_dismissed("kilo", True)
    ob.set_complete(True)
    assert ob.is_complete() is True
    assert ob.install_prompt_dismissals() == ["kilo"]


def test_ids_that_left_the_registry_are_dropped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _isolate_state(monkeypatch, tmp_path)
    ob._write_state({"install_prompt_dismissed": ["kilo", "gemini", 7]})
    assert ob.install_prompt_dismissals() == ["kilo"]


def test_status_reports_the_dismissals(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The renderer decides whether to auto-open the prompt from this field.
    _isolate_state(monkeypatch, tmp_path)
    monkeypatch.setattr(ob, "detect_dep", lambda dep: {"id": dep.id, "group": dep.group, "status": "missing"})
    monkeypatch.setattr(ob, "detect_ollama_status", lambda: {"models": [], "detail": "", "reachable": False})
    monkeypatch.setattr(ob, "_refresh_path_from_login_shell", lambda: None)
    monkeypatch.setattr(ob, "build_cli_health", lambda deps: {})
    ob.set_install_prompt_dismissed("kilo", True)
    assert ob.get_status()["install_prompt_dismissed"] == ["kilo"]


# ── WS wiring ────────────────────────────────────────────────────────────────
class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_install_prompt_handler_persists_the_choice(monkeypatch: pytest.MonkeyPatch) -> None:
    recorded: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        ob, "set_install_prompt_dismissed",
        lambda dep_id, dismissed: (recorded.append((dep_id, dismissed)), {"ok": True})[1],
    )
    session = app_mod.Session(_FakeWebSocket())  # type: ignore[arg-type]
    await app_mod.handle_message(session, {
        "id": "p1",
        "type": "onboarding.install_prompt",
        "payload": {"dep_id": "kilo", "dismissed": True},
    })
    assert recorded == [("kilo", True)]
    assert session.websocket.sent[0]["payload"] == {"ok": True}  # type: ignore[attr-defined]
