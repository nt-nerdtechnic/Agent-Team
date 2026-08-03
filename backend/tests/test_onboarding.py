"""onboarding_deps — version detection (3 states), install whitelist, gate, flag."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from agent_team_backend import onboarding_deps as ob
from agent_team_backend.onboarding_deps import Dep


# ── detect_dep: ok / outdated / missing ──────────────────────────────────────
_NODE = Dep("node", "Node", "", "foundation", ["node", "--version"],
            r"v?(\d+\.\d+\.\d+)", min_version="22.0.0", install_cmd="brew install node@22")


def _fake_run(stdout: str):
    def run(*_a, **_k):
        return subprocess.CompletedProcess(_a[0] if _a else [], 0, stdout, "")
    return run


def test_detect_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/usr/bin/node")
    monkeypatch.setattr(ob.subprocess, "run", _fake_run("v22.3.0"))
    r = ob.detect_dep(_NODE)
    assert r["status"] == "ok" and r["version"] == "22.3.0"


def test_detect_outdated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/usr/bin/node")
    monkeypatch.setattr(ob.subprocess, "run", _fake_run("v18.0.0"))
    r = ob.detect_dep(_NODE)
    assert r["status"] == "outdated" and r["version"] == "18.0.0"


def test_detect_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: None)
    r = ob.detect_dep(_NODE)
    assert r["status"] == "missing" and r["version"] == ""


# ── install-method classification (picks which official command applies) ──────
def _home(monkeypatch: pytest.MonkeyPatch, home: Path) -> None:
    monkeypatch.setattr(ob.Path, "home", classmethod(lambda _cls: home))


def test_install_method_npm_wins_over_prefix(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _home(monkeypatch, tmp_path)
    npm_in_brew = "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"
    assert ob._install_method(npm_in_brew) == "npm"


def test_install_method_homebrew() -> None:
    assert ob._install_method("/opt/homebrew/bin/ollama") == "homebrew"
    assert ob._install_method("/usr/local/Cellar/uv/0.5.0/bin/uv") == "homebrew"


def test_install_method_native_vendor_installer(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _home(monkeypatch, tmp_path)
    assert ob._install_method(f"{tmp_path}/.local/share/claude/versions/2.1.219") == "native"


def test_install_method_vendor_script(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _home(monkeypatch, tmp_path)
    assert ob._install_method(f"{tmp_path}/.grok/bin/grok") == "script"
    assert ob._install_method(f"{tmp_path}/.local/bin/agy") == "script"


def test_install_method_unknown_is_not_guessed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _home(monkeypatch, tmp_path)
    assert ob._install_method("/usr/bin/claude") == "unknown"
    assert ob._install_method("") == ""


def test_detect_dep_exposes_official_maintenance_commands(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/usr/local/bin/claude")
    monkeypatch.setattr(ob.subprocess, "run", _fake_run("2.1.219 (Claude Code)"))
    r = ob.detect_dep(ob.DEPS_BY_ID["claude"])
    assert r["update_cmd"] == "claude update"
    assert r["doctor_cmd"] == "claude doctor"
    assert "install_method" in r


def test_registry_carries_update_command_or_docs_for_every_agent_cli() -> None:
    """Every agent CLI must offer an official update path or vendor docs —
    never a Navide-invented command."""
    for dep in ob.DEPS:
        if dep.group != "agent_cli":
            continue
        assert dep.update_cmd or dep.docs_url, dep.id


# ── gate computation ──────────────────────────────────────────────────────────
def _deps(found_ok: bool, cli_ok: bool, ollama_ok: bool) -> list[dict]:
    return [
        {"id": "node", "group": "foundation", "status": "ok" if found_ok else "missing"},
        {"id": "pnpm", "group": "foundation", "status": "ok"},
        {"id": "claude", "group": "agent_cli", "status": "ok" if cli_ok else "missing"},
        {"id": "codex", "group": "agent_cli", "status": "missing"},
        {"id": "ollama", "group": "analyzer", "status": "ok" if ollama_ok else "missing"},
    ]


def test_gate_all_ready() -> None:
    g = ob.compute_gate(_deps(True, True, True), models=["qwen2.5-coder"])
    assert g["all_required_ready"] is True
    assert g["foundation_ready"] and g["has_any_cli"] and g["analyzer_ready"]


def test_gate_blocks_without_cli() -> None:
    g = ob.compute_gate(_deps(True, False, True), models=["m"])
    assert g["has_any_cli"] is False and g["all_required_ready"] is False


def test_gate_analyzer_is_optional() -> None:
    """No model installed → analyzer not ready, but the gate must still open:
    forcing a multi-GB model download to use agent CLIs is not acceptable."""
    g = ob.compute_gate(_deps(True, True, True), models=[])
    assert g["analyzer_ready"] is False and g["all_required_ready"] is True


def test_gate_blocks_without_foundation() -> None:
    g = ob.compute_gate(_deps(False, True, True), models=["m"])
    assert g["foundation_ready"] is False and g["all_required_ready"] is False


# ── install whitelist ─────────────────────────────────────────────────────────
def test_install_unknown_id_rejected() -> None:
    r = ob.install_dep("rm-rf-everything")
    assert r["ok"] is False and "unknown" in r["error"].lower()


def test_install_needs_terminal_returns_command_without_running(monkeypatch: pytest.MonkeyPatch) -> None:
    # homebrew is needs_terminal → must NOT shell out, just hand back the command.
    called = {"ran": False}
    def boom(*_a, **_k):
        called["ran"] = True
        raise AssertionError("should not run")
    monkeypatch.setattr(ob.subprocess, "run", boom)
    r = ob.install_dep("homebrew")
    assert r["ok"] is True and r["needs_terminal"] is True and r["command"]
    assert called["ran"] is False


def test_python_install_uses_unversioned_formula() -> None:
    # Versioned kegs (python@3.12) only link `python3.12`, never `python3`,
    # so detection (`python3 --version`) would stay missing after a successful
    # install. The unversioned alias links `python3` into the brew prefix.
    assert ob.DEPS_BY_ID["python"].install_cmd == "brew install python3"


def test_node_install_uses_unversioned_formula() -> None:
    # node@22 is keg-only: it never links `node` into the brew prefix, so
    # detection (`node --version`) would stay missing after a successful install.
    assert ob.DEPS_BY_ID["node"].install_cmd == "brew install node"


def test_maintenance_command_returns_the_vendor_command(monkeypatch: pytest.MonkeyPatch) -> None:
    ran = []
    monkeypatch.setattr(ob.subprocess, "run", lambda *a, **k: ran.append(a))

    result = ob.maintenance_command("claude", "update")

    assert result == {"ok": True, "needs_terminal": True, "command": "claude update",
                      "docs_url": "https://docs.anthropic.com/claude-code"}
    assert ran == []  # resolving a command must never execute it


def test_maintenance_command_rejects_unknown_agent_and_action() -> None:
    assert ob.maintenance_command("nope", "update")["ok"] is False
    assert ob.maintenance_command("claude", "rm -rf /")["ok"] is False
    assert ob.maintenance_command("claude", "")["ok"] is False


def test_maintenance_command_points_at_docs_when_vendor_has_none() -> None:
    result = ob.maintenance_command("kimi", "update")
    assert result["ok"] is False
    assert result["docs_url"] == "https://moonshotai.github.io/kimi-cli/en/"
    assert "command" not in result


def test_pull_model_rejects_bad_name() -> None:
    assert ob.pull_model("evil; rm -rf /")["ok"] is False


# ── install: failure reporting + bootstrap gate + timeout reaping ─────────────
def _fake_popen(returncode: int, stdout: str = "", stderr: str = "", *, timeout: bool = False):
    """A Popen stand-in; `timeout=True` makes the FIRST communicate() time out."""
    class _P:
        pid = 424242

        def __init__(self, *_a: object, **_k: object) -> None:
            self.returncode = returncode
            self._timeout = timeout
            self.killed = False

        def communicate(self, timeout: float | None = None):  # noqa: ANN202
            if self._timeout:
                self._timeout = False
                raise subprocess.TimeoutExpired(cmd="install", timeout=timeout or 0)
            return stdout, stderr

        def kill(self) -> None:
            self.killed = True

    return _P


def _brew_present(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda name: f"/opt/homebrew/bin/{name}")


def test_install_failure_surfaces_output_as_error(monkeypatch: pytest.MonkeyPatch) -> None:
    # The frontend renders `error`; returning only `output` on failure is what
    # made every failed install read as "installation failed: unknown".
    _brew_present(monkeypatch)
    monkeypatch.setattr(
        ob.subprocess, "Popen", _fake_popen(1, "", "Error: node: no bottle available")
    )
    r = ob.install_dep("node")
    assert r["ok"] is False
    assert "no bottle available" in r["error"]
    assert "no bottle available" in r["output"]


def test_install_failure_without_output_still_names_the_exit_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _brew_present(monkeypatch)
    monkeypatch.setattr(ob.subprocess, "Popen", _fake_popen(127, "", ""))
    r = ob.install_dep("node")
    assert r["ok"] is False and "127" in r["error"]


def test_install_success_returns_output(monkeypatch: pytest.MonkeyPatch) -> None:
    _brew_present(monkeypatch)
    monkeypatch.setattr(ob.subprocess, "Popen", _fake_popen(0, "==> Pouring node\n"))
    r = ob.install_dep("node")
    assert r["ok"] is True and "Pouring" in r["output"]


def test_install_blocked_when_bootstrap_binary_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Fresh Mac without Homebrew: `brew install node` only ever produced a bare
    # exit 127, so the wizard has to name the real blocker instead of running it.
    monkeypatch.setattr(ob.shutil, "which", lambda _x: None)

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("must not shell out when a requirement is missing")

    monkeypatch.setattr(ob.subprocess, "Popen", boom)
    r = ob.install_dep("node")
    assert r["ok"] is False
    assert r["missing_requirements"] == ["brew"]
    assert "brew" in r["error"]


def test_install_bootstrap_gate_precedes_the_terminal_handoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # claude is needs_terminal: without the gate the app reported success while
    # the terminal it opened just printed "npm: command not found".
    monkeypatch.setattr(ob.shutil, "which", lambda _x: None)
    r = ob.install_dep("claude")
    assert r["ok"] is False
    assert r["missing_requirements"] == ["npm"]
    assert "needs_terminal" not in r


def test_every_brew_or_npm_install_declares_its_bootstrap_binary() -> None:
    for dep in ob.DEPS:
        if dep.install_cmd.startswith("brew "):
            assert "brew" in dep.requires_binaries, dep.id
        if dep.install_cmd.startswith("npm "):
            assert "npm" in dep.requires_binaries, dep.id


def test_install_timeout_reaps_the_whole_process_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # shell=True puts brew one level below /bin/sh: killing only the direct
    # child leaves it running and keeps the inherited pipes open.
    signals: list[int] = []
    _brew_present(monkeypatch)
    monkeypatch.setattr(ob.subprocess, "Popen", _fake_popen(0, timeout=True))
    monkeypatch.setattr(ob.os, "getpgid", lambda _pid: 424242)
    monkeypatch.setattr(ob.os, "killpg", lambda _pgid, sig: signals.append(sig))
    r = ob.install_dep("node")
    assert r["ok"] is False and "timed out" in r["error"]
    assert signals[:1] == [ob.signal.SIGTERM]


# ── ollama: installed ≠ serving ───────────────────────────────────────────────
def _ollama_list(returncode: int, stdout: str = "", stderr: str = ""):
    def run(*a: object, **_k: object):
        return subprocess.CompletedProcess(a[0] if a else [], returncode, stdout, stderr)
    return run


def test_ollama_status_separates_service_down_from_no_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `ollama list` fails when the daemon is down, which used to be reported
    # identically to "no models installed".
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(
        ob.subprocess, "run", _ollama_list(1, "", "could not connect to ollama app")
    )
    r = ob.detect_ollama_status()
    assert r["reachable"] is False and r["models"] == []
    assert "connect" in r["detail"]


def test_ollama_status_lists_models_when_reachable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(
        ob.subprocess, "run", _ollama_list(0, "NAME\tID\nqwen2.5-coder:7b\tabc\n")
    )
    r = ob.detect_ollama_status()
    assert r["reachable"] is True and r["models"] == ["qwen2.5-coder:7b"]
    assert ob.detect_ollama_models() == ["qwen2.5-coder:7b"]


def test_gate_reports_analyzer_blocked_when_service_is_down() -> None:
    deps = [{"id": "ollama", "group": "analyzer", "status": "ok", "optional": False}]
    gate = ob.compute_gate(deps, ["qwen2.5-coder:7b"], False)
    assert gate["ollama_ok"] is True
    assert gate["ollama_service_up"] is False
    assert gate["analyzer_ready"] is False


def test_pull_model_allows_namespaced_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(ob, "ollama_reachable", lambda: True)
    r = ob.pull_model("hf.co/user/repo:q4")
    assert r["ok"] is True and r["command"].endswith("hf.co/user/repo:q4")


def test_pull_model_rejects_traversal_flags_and_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(ob, "ollama_reachable", lambda: True)
    assert ob.pull_model("../../etc/passwd")["ok"] is False
    assert ob.pull_model("-rf")["ok"] is False
    assert ob.pull_model("")["ok"] is False


def test_pull_model_blocked_while_the_service_is_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(ob, "ollama_reachable", lambda: False)
    r = ob.pull_model("qwen2.5-coder:7b")
    assert r["ok"] is False and r["needs_service"] is True


def test_start_ollama_service_hands_back_the_official_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda name: f"/opt/homebrew/bin/{name}")
    assert ob.start_ollama_service() == {
        "ok": True,
        "needs_terminal": True,
        "command": "brew services start ollama",
    }


def test_start_ollama_service_requires_ollama(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: None)
    assert ob.start_ollama_service()["ok"] is False


def test_local_bin_is_a_path_fallback() -> None:
    # aider / opencode / cursor / kimi install scripts land in ~/.local/bin and
    # export it from a shell rc file the 3s probe can miss.
    assert any(p.endswith("/.local/bin") for p in ob._FALLBACK_PATH_DIRS)


# ── completion flag ───────────────────────────────────────────────────────────
def _patch_flag_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> tuple[Path, Path]:
    """Point both the new and the legacy flag path into tmp_path."""
    flag = tmp_path / "app-data" / "onboarding.json"
    legacy = tmp_path / "legacy" / "onboarding.json"
    monkeypatch.setattr(ob, "_flag_path", lambda: flag)
    monkeypatch.setattr(ob, "_legacy_flag_path", lambda: legacy)
    monkeypatch.delenv("AGENT_TEAM_SKIP_ONBOARDING", raising=False)
    return flag, legacy


def test_complete_flag_roundtrip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.is_complete() is False
    ob.set_complete(True)
    assert ob.is_complete() is True


def test_skip_env_forces_complete(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    monkeypatch.setenv("AGENT_TEAM_SKIP_ONBOARDING", "1")
    assert ob.is_complete() is True


def test_legacy_flag_migrated_to_new_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Existing user with only the legacy flag must not see onboarding again."""
    flag, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"complete": true}', encoding="utf-8")
    assert ob.is_complete() is True
    # First read seeds the stored state, so the legacy file is no longer needed.
    legacy.unlink()
    assert ob.is_complete() is True


def test_legacy_fallback_read_when_copy_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Even if the copy fails, is_complete() falls back to reading the legacy path."""
    _, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"complete": true}', encoding="utf-8")
    monkeypatch.setattr(ob, "_migrate_legacy_flag", lambda: None)
    assert ob.is_complete() is True


def test_new_flag_wins_over_legacy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A flag already present at the new path is read as-is (no legacy override)."""
    flag, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text('{"complete": false}', encoding="utf-8")
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"complete": true}', encoding="utf-8")
    assert ob.is_complete() is False


def test_set_complete_writes_new_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    flag, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    ob.set_complete(True)
    # State lands in the app-data database, never in the legacy home file.
    assert (flag.parent / "navide.db").exists()
    assert not legacy.exists()
    assert ob.is_complete() is True


def test_legacy_app_data_json_imported_once_and_retired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    flag, _legacy = _patch_flag_paths(monkeypatch, tmp_path)
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text(
        '{"complete": true, "dismissed_cli_health": "0123456789abcdef"}',
        encoding="utf-8",
    )
    assert ob.is_complete() is True
    assert ob._dismissed_cli_health_fingerprint() == "0123456789abcdef"
    assert not flag.exists()
    assert flag.with_name(flag.name + ".migrated-v1").exists()
    # Data survives the retired source file.
    assert ob.is_complete() is True


def _make_executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def _claude_status(path: Path, *, ok: bool = True) -> dict:
    return {
        "id": "claude",
        "status": "ok" if ok else "missing",
        "version": "2.1.210" if ok else "",
        "binary_path": str(path),
        "resolved_path": str(path.resolve()),
        "exit_code": 0 if ok else -9,
        "signal": "" if ok else "SIGKILL",
        "duration_ms": 42,
    }


def test_cli_health_reports_distinct_duplicate_installations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = _make_executable(tmp_path / "nvm" / "claude")
    second = _make_executable(tmp_path / "homebrew" / "claude")
    monkeypatch.setenv("PATH", f"{first.parent}:{second.parent}")
    monkeypatch.setattr(
        ob,
        "_probe_alternate",
        lambda _dep, _path: {
            "version": "2.1.168", "status": "ok", "exit_code": 0,
            "signal": "", "duration_ms": 10,
        },
    )
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(first)])

    duplicate = next(f for f in health["findings"] if f["type"] == "duplicate_install")
    assert duplicate["agent_key"] == "claude"
    assert [c["version"] for c in duplicate["candidates"]] == ["2.1.210", "2.1.168"]
    assert health["needs_attention"] is True
    assert len(health["fingerprint"]) == 16


def _make_npm_claude_install(prefix: Path) -> tuple[Path, Path, Path]:
    """Create an npm-owned claude install; returns (npm, binary, target)."""
    npm = _make_executable(prefix / "bin" / "npm")
    target = _make_executable(
        prefix / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
    )
    binary = prefix / "bin" / "claude"
    binary.symlink_to(target)
    return npm, binary, target


def _candidate_entry(path: Path, resolved: Path | None = None) -> dict:
    return {
        "path": str(path),
        "resolved_path": str(resolved if resolved is not None else path),
        "aliases": [str(path)],
    }


def _probe_ok(_dep: object, _path: str) -> dict:
    return {"version": "2.1.214", "status": "ok", "exit_code": 0, "signal": "", "duration_ms": 10}


def _probe_failed(_dep: object, _path: str) -> dict:
    return {"version": "", "status": "failed", "exit_code": 1, "signal": "", "duration_ms": 10}


def test_cli_health_builds_confirmed_npm_removal_for_owned_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    npm, binary, target = _make_npm_claude_install(tmp_path / "node")
    other = _make_executable(tmp_path / "native" / "claude")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(other),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary)])
    candidate = health["entries"][0]["candidates"][0]

    assert candidate["install_manager"] == "npm"
    assert str(npm) in candidate["removal_command"]
    assert "uninstall -g @anthropic-ai/claude-code" in candidate["removal_command"]
    assert "Continue? [y/N]" in candidate["removal_command"]


def test_cli_health_never_offers_removal_for_the_only_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
    ])
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary)])
    candidate = health["entries"][0]["candidates"][0]

    assert candidate["removal_command"] == ""
    assert candidate["install_manager"] == ""


def test_cli_health_offers_removal_only_for_the_broken_duplicate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, primary_binary, primary_target = _make_npm_claude_install(tmp_path / "node_a")
    _, broken_binary, broken_target = _make_npm_claude_install(tmp_path / "node_b")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(primary_binary, primary_target),
        _candidate_entry(broken_binary, broken_target),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_failed)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(primary_binary)])
    candidates = health["entries"][0]["candidates"]
    working = next(c for c in candidates if c["status"] == "ok")
    broken = next(c for c in candidates if c["status"] != "ok")

    assert working["removal_command"] == ""
    assert "uninstall -g @anthropic-ai/claude-code" in broken["removal_command"]


def test_cli_health_allows_removing_a_broken_sole_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
    ])
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary, ok=False)])
    candidate = health["entries"][0]["candidates"][0]

    # Removing a broken install cannot lose a working CLI, so guided removal
    # stays available even without a working backup.
    assert "uninstall -g @anthropic-ai/claude-code" in candidate["removal_command"]


def test_cli_health_blocks_removal_when_backup_is_same_physical_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    wrapper = _make_executable(
        tmp_path / "node" / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "cli-wrapper.cjs"
    )
    alias = tmp_path / "node" / "bin" / "claude-alias"
    alias.symlink_to(wrapper)
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(alias, wrapper),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary)])
    candidates = health["entries"][0]["candidates"]

    # Both PATH entries live in the same npm prefix: one uninstall removes
    # both, so neither may count the other as a working backup.
    assert [c["removal_command"] for c in candidates] == ["", ""]


def test_cli_health_fingerprint_ignores_removal_gating(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    npm, binary, target = _make_npm_claude_install(tmp_path / "node")
    other = _make_executable(tmp_path / "native" / "claude")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(other),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    with_removal = ob.build_cli_health([_claude_status(binary)])
    npm.unlink()  # removal becomes unavailable; probes are unchanged
    without_removal = ob.build_cli_health([_claude_status(binary)])

    assert with_removal["entries"][0]["candidates"][0]["removal_command"] != ""
    assert without_removal["entries"][0]["candidates"][0]["removal_command"] == ""
    assert with_removal["fingerprint"] == without_removal["fingerprint"]


def test_cli_health_collapses_aliases_to_same_physical_binary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = _make_executable(tmp_path / "package" / "claude.exe")
    first = tmp_path / "bin-a" / "claude"
    second = tmp_path / "bin-b" / "claude"
    first.parent.mkdir()
    second.parent.mkdir()
    first.symlink_to(target)
    second.symlink_to(target)
    monkeypatch.setenv("PATH", f"{first.parent}:{second.parent}")
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(first)])

    assert health["findings"] == []
    claude = next(entry for entry in health["entries"] if entry["agent_key"] == "claude")
    assert len(claude["candidates"]) == 1
    assert claude["candidates"][0]["aliases"] == [str(first), str(second)]


def test_cli_health_reports_failed_primary_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary = _make_executable(tmp_path / "bin" / "claude")
    monkeypatch.setenv("PATH", str(binary.parent))
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary, ok=False)])

    failed = next(f for f in health["findings"] if f["type"] == "probe_failed")
    assert failed["primary"]["signal"] == "SIGKILL"
    assert health["needs_attention"] is True


def test_cli_health_dismissal_is_fingerprint_scoped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    ob.set_complete(True)
    fingerprint = "0123456789abcdef"
    ob.dismiss_cli_health(fingerprint)

    assert ob._dismissed_cli_health_fingerprint() == fingerprint
    assert ob.is_complete() is True

    ob.dismiss_cli_health("invalid")
    assert ob._dismissed_cli_health_fingerprint() == fingerprint


def test_cli_binary_selection_persists_path_and_fingerprint_atomically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    flag, _legacy = _patch_flag_paths(monkeypatch, tmp_path)
    prefix = tmp_path / "node"
    target = _make_executable(
        prefix / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
    )
    binary = prefix / "bin" / "claude"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.symlink_to(target)
    monkeypatch.setenv("PATH", str(binary.parent))
    ob.set_complete(True)

    result = ob.select_cli_binary("claude", str(binary), "0123456789abcdef")

    assert result == {"ok": True, "agent_key": "claude", "path": str(binary)}
    assert ob.cli_binary_override("claude") == str(binary)
    assert ob._dismissed_cli_health_fingerprint() == "0123456789abcdef"
    assert ob._read_state() == {
        "complete": True,
        "cli_binary_overrides": {"claude": str(binary)},
        "dismissed_cli_health": "0123456789abcdef",
    }


# ── update state: read back what the CLI itself recorded ─────────────────────
def _write_update_result(home: Path, **fields: object) -> None:
    home.mkdir(parents=True, exist_ok=True)
    record = {"timestamp": "2026-07-25T00:07:12.372Z", "path": "native",
              "outcome": "failed", "status": "install_failed",
              "version_from": "2.1.219", "version_to": None}
    record.update(fields)
    (home / ".last-update-result.json").write_text(json.dumps(record), encoding="utf-8")


def _patch_homes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[Path, Path]:
    """Return (default claude home, profiles root for claude)."""
    _home(monkeypatch, tmp_path)
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    root = tmp_path / ".navide" / "cli-profiles"
    monkeypatch.setattr(ob, "default_profiles_root", lambda: root)
    return tmp_path / ".claude", root / "claude"


def test_read_update_state_covers_default_and_profile_homes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    default_home, profiles = _patch_homes(monkeypatch, tmp_path)
    _write_update_result(default_home, timestamp="2026-07-24T17:37:51.096Z",
                         outcome="success", status="success", version_to="2.1.211")
    _write_update_result(profiles / "4ad13e88")

    records = ob.read_update_state(ob.DEPS_BY_ID["claude"])

    assert [r["scope"] for r in records] == ["profile:4ad13e88", "default"]  # newest first
    assert records[0]["status"] == "install_failed"


def test_read_update_state_ignores_missing_and_corrupt_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    default_home, profiles = _patch_homes(monkeypatch, tmp_path)
    default_home.mkdir(parents=True)
    (default_home / ".last-update-result.json").write_text("{not json", encoding="utf-8")
    (profiles / "empty").mkdir(parents=True)

    assert ob.read_update_state(ob.DEPS_BY_ID["claude"]) == []


def test_read_update_state_is_empty_for_cli_without_state_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_homes(monkeypatch, tmp_path)
    assert ob.read_update_state(ob.DEPS_BY_ID["grok"]) == []


def _claude_health(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, version: str) -> dict:
    binary = _make_executable(tmp_path / "bin" / "claude")
    monkeypatch.setattr(ob, "_distinct_executables", lambda command: (
        [_candidate_entry(binary)] if command == "claude" else []
    ))
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")
    status = _claude_status(binary)
    status["version"] = version
    return ob.build_cli_health([status])


def test_cli_health_surfaces_a_failed_vendor_update(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _default, profiles = _patch_homes(monkeypatch, tmp_path)
    _write_update_result(profiles / "4ad13e88")

    health = _claude_health(monkeypatch, tmp_path, version="2.1.219")

    finding = next(f for f in health["findings"] if f["type"] == "update_failed")
    assert finding["records"][0]["status"] == "install_failed"
    assert finding["records"][0]["scope"] == "profile:4ad13e88"
    assert health["needs_attention"] is True
    entry = next(e for e in health["entries"] if e["agent_key"] == "claude")
    assert entry["update_state"][0]["outcome"] == "failed"


def test_cli_health_ignores_a_failure_the_cli_has_since_moved_past(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _default, profiles = _patch_homes(monkeypatch, tmp_path)
    _write_update_result(profiles / "4ad13e88", version_from="2.1.219")

    health = _claude_health(monkeypatch, tmp_path, version="2.1.230")

    assert [f["type"] for f in health["findings"]] == []
    assert health["needs_attention"] is False


def test_update_failure_fingerprint_changes_on_a_newer_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _default, profiles = _patch_homes(monkeypatch, tmp_path)
    _write_update_result(profiles / "4ad13e88")
    first = _claude_health(monkeypatch, tmp_path, version="2.1.219")["fingerprint"]

    _write_update_result(profiles / "4ad13e88", timestamp="2026-07-26T01:00:00.000Z")
    second = _claude_health(monkeypatch, tmp_path, version="2.1.219")["fingerprint"]

    assert first and second and first != second


# ── auto-update policy (the vendor's own switch) ─────────────────────────────
def test_autoupdate_defaults_to_vendor_behaviour(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.cli_autoupdate_policy("claude") == "vendor"
    assert ob.spawn_env_for("claude") == {}


def test_autoupdate_manual_injects_the_vendor_env_var(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.set_cli_autoupdate_policy("claude", "manual")["ok"] is True
    assert ob.cli_autoupdate_policy("claude") == "manual"
    assert ob.spawn_env_for("claude") == {"DISABLE_AUTOUPDATER": "1"}

    ob.set_cli_autoupdate_policy("claude", "vendor")
    assert ob.spawn_env_for("claude") == {}


def test_autoupdate_rejects_agents_without_a_vendor_switch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.set_cli_autoupdate_policy("grok", "manual")["ok"] is False
    assert ob.set_cli_autoupdate_policy("claude", "off")["ok"] is False
    assert ob.spawn_env_for("grok") == {}
    assert ob.spawn_env_for("unknown") == {}


def test_cli_health_entries_carry_registry_commands(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Entry commands come from the registry, never from a per-agent hardcode."""
    installed = {"kimi": _make_executable(tmp_path / "bin" / "kimi"),
                 "grok": _make_executable(tmp_path / "bin" / "grok")}
    monkeypatch.setattr(ob, "_distinct_executables", lambda command: (
        [_candidate_entry(installed[command])] if command in installed else []
    ))
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    entries = {e["agent_key"]: e for e in ob.build_cli_health([])["entries"]}

    # kimi ships a doctor but no update subcommand — no invented command.
    assert entries["kimi"]["diagnostic_command"] == "kimi doctor"
    assert entries["kimi"]["update_command"] == ""
    assert entries["kimi"]["docs_url"]
    # grok ships an update but no doctor — diagnostics fall back to the probe.
    assert entries["grok"]["update_command"] == "grok update"
    assert entries["grok"]["diagnostic_command"] == "grok --version"
