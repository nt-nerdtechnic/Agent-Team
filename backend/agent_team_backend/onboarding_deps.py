"""Onboarding dependency registry + detection.

Single source of truth for the first-run environment wizard. Each `Dep`
describes how to detect a tool and (where safe) how to install it. The frontend
only renders backend-computed status — it never hardcodes commands. Install is
driven by `dep_id` against this whitelist, mirroring the git-config allowlist
security model.

macOS-only by design (matches the project's platform assumption).
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import shlex
import shutil
import signal
import sqlite3
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .applog import app_data_dir
from .db import DB_FILENAME, Database
from .profiles_store import default_profiles_root


@dataclass(frozen=True)
class Dep:
    id: str
    label: str
    description: str
    group: str                       # 'foundation' | 'agent_cli' | 'analyzer'
    check_cmd: list[str]             # e.g. ['node', '--version']
    version_regex: str = r"(\d+\.\d+(?:\.\d+)?)"
    min_version: str = ""            # '' = any version is fine
    install_cmd: str = ""            # shell command (whitelist); '' = no auto-install
    needs_terminal: bool = False     # interactive (sudo / OAuth) → external Terminal
    optional: bool = False
    docs_url: str = ""
    # Maintenance — the CLI's OWN official commands. Navide never wraps, parses
    # or replaces them; it only surfaces and runs them. '' = the vendor ships no
    # such command, in which case the UI points at docs_url instead of guessing.
    update_cmd: str = ""             # e.g. 'claude update'
    doctor_cmd: str = ""             # e.g. 'claude doctor'
    npm_package: str = ""            # npm package name when installable via npm
    # Where the CLI itself records the outcome of its own auto-update. Navide
    # only reads what the vendor already wrote to disk.
    update_state_file: str = ""      # relative to a config home, e.g. '.last-update-result.json'
    config_home_env: str = ""        # env var overriding the config home, e.g. 'CLAUDE_CONFIG_DIR'
    config_home_default: str = ""    # default config home relative to $HOME, e.g. '.claude'
    autoupdate_env: str = ""         # vendor's own opt-out env var, e.g. 'DISABLE_AUTOUPDATER'


# ── Registry ──────────────────────────────────────────────────────────────────
# NOTE: Agent-CLI install commands are best-effort and may change upstream; they
# are marked needs_terminal so the user runs/authenticates them interactively.
DEPS: list[Dep] = [
    # Step 1 — Foundation
    Dep("homebrew", "Homebrew", "macOS package manager", "foundation",
        ["brew", "--version"], r"Homebrew (\d+\.\d+\.\d+)",
        install_cmd='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        needs_terminal=True, docs_url="https://brew.sh"),
    # Unversioned formula on purpose: node@22 is keg-only, so `node` would
    # stay off PATH after a successful install and detection would never pass.
    Dep("node", "Node.js", "JavaScript runtime (≥ 22)", "foundation",
        ["node", "--version"], r"v?(\d+\.\d+\.\d+)", min_version="22.0.0",
        install_cmd="brew install node", docs_url="https://nodejs.org"),
    Dep("pnpm", "pnpm", "Package manager", "foundation",
        ["pnpm", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="brew install pnpm", docs_url="https://pnpm.io"),
    # Unversioned formula on purpose: versioned kegs (python@3.12) only link
    # `python3.12`, never `python3`, so detection (`python3 --version`) would
    # keep failing after a successful install.
    Dep("python", "Python", "Python 3.12+", "foundation",
        ["python3", "--version"], r"Python (\d+\.\d+\.\d+)", min_version="3.12.0",
        install_cmd="brew install python3", docs_url="https://python.org"),
    Dep("uv", "uv", "Python package and environment manager", "foundation",
        ["uv", "--version"], r"uv (\d+\.\d+\.\d+)",
        install_cmd="brew install uv", docs_url="https://docs.astral.sh/uv"),

    # Step 2 — Agent CLIs (≥ 1 required) + Analyzer
    Dep("claude", "Claude Code", "Anthropic Claude CLI", "agent_cli",
        ["claude", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @anthropic-ai/claude-code", needs_terminal=True,
        optional=True, docs_url="https://docs.anthropic.com/claude-code",
        update_cmd="claude update", doctor_cmd="claude doctor",
        npm_package="@anthropic-ai/claude-code",
        update_state_file=".last-update-result.json",
        config_home_env="CLAUDE_CONFIG_DIR", config_home_default=".claude",
        autoupdate_env="DISABLE_AUTOUPDATER"),
    Dep("codex", "Codex", "OpenAI Codex CLI", "agent_cli",
        ["codex", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @openai/codex", needs_terminal=True,
        optional=True, docs_url="",
        update_cmd="codex update", doctor_cmd="codex doctor",
        npm_package="@openai/codex"),
    Dep("antigravity", "Antigravity", "Google Antigravity CLI", "agent_cli",
        ["agy", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://antigravity.google/cli/install.sh | bash",
        needs_terminal=True, optional=True,
        docs_url="https://antigravity.google/docs/cli-getting-started",
        update_cmd="agy update"),
    Dep("grok", "Grok CLI", "superagent-ai Grok coding agent", "agent_cli",
        ["grok", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash",
        needs_terminal=True, optional=True, docs_url="https://grokcli.io",
        update_cmd="grok update"),
    # Kimi Code ships `kimi doctor` but no update subcommand — update_cmd stays
    # empty so the UI sends the user to the vendor docs instead of inventing one.
    Dep("kimi", "Kimi Code", "Moonshot AI Kimi Code CLI", "agent_cli",
        ["kimi", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
        needs_terminal=True, optional=True, docs_url="https://moonshotai.github.io/kimi-cli/en/",
        doctor_cmd="kimi doctor"),
    # OpenCode ships `opencode upgrade` but no doctor subcommand.
    Dep("opencode", "OpenCode", "OpenCode terminal coding agent", "agent_cli",
        ["opencode", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://opencode.ai/install | bash",
        needs_terminal=True, optional=True, docs_url="https://opencode.ai/docs",
        update_cmd="opencode upgrade",
        npm_package="opencode-ai",
        config_home_env="OPENCODE_CONFIG_DIR",
        autoupdate_env="OPENCODE_DISABLE_AUTOUPDATE"),
    # Kilo Code (OpenCode fork) ships `kilo upgrade` but no doctor subcommand
    # (`kilo debug` is diagnostics-adjacent, not a doctor — no invented command).
    Dep("kilo", "Kilo Code", "Kilo Code terminal coding agent (OpenCode fork)", "agent_cli",
        ["kilo", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @kilocode/cli",
        needs_terminal=True, optional=True,
        docs_url="https://kilo.ai/docs/code-with-ai/platforms/cli",
        update_cmd="kilo upgrade",
        npm_package="@kilocode/cli",
        config_home_env="KILO_CONFIG_DIR",
        autoupdate_env="KILO_DISABLE_AUTOUPDATE"),
    # Qwen Code ships `qwen update` but no doctor subcommand; its autoupdate
    # opt-out is a settings.json key, not an env var — autoupdate_env stays empty.
    Dep("qwen", "Qwen Code", "Alibaba Qwen Code coding agent CLI", "agent_cli",
        ["qwen", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @qwen-code/qwen-code", needs_terminal=True,
        optional=True, docs_url="https://qwenlm.github.io/qwen-code-docs/",
        update_cmd="qwen update",
        npm_package="@qwen-code/qwen-code"),
    # Pi ships `pi update` but no doctor subcommand; PI_SKIP_VERSION_CHECK is
    # its own opt-out for the startup version check.
    Dep("pi", "Pi", "Pi coding agent CLI", "agent_cli",
        ["pi", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @earendil-works/pi-coding-agent",
        needs_terminal=True, optional=True, docs_url="https://pi.dev/docs",
        update_cmd="pi update",
        npm_package="@earendil-works/pi-coding-agent",
        config_home_env="PI_CODING_AGENT_DIR",
        autoupdate_env="PI_SKIP_VERSION_CHECK"),
    # Copilot CLI ships `copilot update` but no doctor subcommand;
    # COPILOT_AUTO_UPDATE=false is its autoupdate opt-out and COPILOT_HOME
    # relocates its config/session root.
    Dep("copilot", "Copilot CLI", "GitHub Copilot coding agent CLI", "agent_cli",
        ["copilot", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="brew install --cask copilot-cli",
        needs_terminal=True, optional=True,
        docs_url="https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli",
        update_cmd="copilot update",
        npm_package="@github/copilot",
        config_home_env="COPILOT_HOME",
        autoupdate_env="COPILOT_AUTO_UPDATE"),
    # Cursor CLI (closed source; binary `agent`, legacy installs `cursor-agent`)
    # ships `agent update` but no doctor subcommand. Autoupdate is on by default
    # with no confirmed opt-out env, and its data home is fixed at ~/.cursor
    # (no config-home env) — both stay empty. Dep detection probes a single
    # executable, so only the current `agent` binary is checked (no
    # cursor-agent fallback — the dataclass has no alternate-binary support).
    Dep("cursor", "Cursor CLI", "Cursor terminal coding agent CLI", "agent_cli",
        ["agent", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl https://cursor.com/install -fsS | bash",
        needs_terminal=True, optional=True,
        docs_url="https://cursor.com/docs/cli",
        update_cmd="agent update"),
    # Aider updates via the `--upgrade` FLAG (not a subcommand) and ships no
    # doctor. AIDER_CHECK_UPDATE=false is its own startup update-check
    # opt-out; its global state home is fixed at ~/.aider (no relocating
    # env), so config_home_env stays empty. `aider --version` prints
    # `aider X.Y.Z`.
    Dep("aider", "Aider", "Aider AI pair-programming CLI", "agent_cli",
        ["aider", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -LsSf https://aider.chat/install.sh | sh",
        needs_terminal=True, optional=True,
        docs_url="https://aider.chat",
        update_cmd="aider --upgrade",
        autoupdate_env="AIDER_CHECK_UPDATE"),
    Dep("ollama", "Ollama", "Local LLM runtime (required for Analyzer)", "analyzer",
        ["ollama", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="brew install ollama", docs_url="https://ollama.com"),
]

DEPS_BY_ID: dict[str, Dep] = {d.id: d for d in DEPS}

# A model whose presence satisfies the analyzer requirement is any installed
# Ollama model; we surface the list so the UI can offer a pull if empty.
_SUGGESTED_MODEL = "qwen2.5-coder:7b"

# Curated catalog of analyzer-suitable Ollama models surfaced in the wizard so
# the common choices are one-click. Any installed model satisfies the gate; the
# user may still pull an arbitrary (validated) name via the custom field. Sizes
# are approximate download sizes for the default quantization.
MODEL_CATALOG: list[dict[str, Any]] = [
    {"name": "qwen2.5-coder:7b", "size": "~4.7 GB",
     "desc": "Recommended · Best balance for code analysis", "recommended": True},
    {"name": "qwen2.5-coder:1.5b", "size": "~1.0 GB",
     "desc": "Lightweight · Low memory, fast", "recommended": False},
    {"name": "qwen2.5-coder:3b", "size": "~2.0 GB",
     "desc": "Lightweight+ · Balance of size and quality", "recommended": False},
    {"name": "qwen2.5-coder:14b", "size": "~9.0 GB",
     "desc": "High quality · Requires more memory", "recommended": False},
    {"name": "qwen2.5-coder:32b", "size": "~20 GB",
     "desc": "Best quality · Requires large memory", "recommended": False},
    {"name": "deepseek-coder-v2:16b", "size": "~8.9 GB",
     "desc": "Alternative · Strong code comprehension", "recommended": False},
    {"name": "llama3.1:8b", "size": "~4.7 GB",
     "desc": "General purpose · Broad conversation and analysis", "recommended": False},
]


def _path_probe_command() -> list[str]:
    """The shell invocation used to read the user's real PATH.

    Uses $SHELL, not bash: installers write PATH exports into the user's own
    shell config. For zsh that file is ~/.zshrc, which zsh only reads in
    INTERACTIVE mode — a plain login shell (-lc) misses it (real case: grok's
    installer writes to ~/.zshrc; `zsh -lc` couldn't see it, so both detection
    and spawn kept failing with command-not-found after install).
    """
    shell = os.environ.get("SHELL") or "/bin/bash"
    if os.path.basename(shell) == "zsh":
        return [shell, "-ilc", "echo $PATH"]
    return [shell, "-lc", "echo $PATH"]


# Standard install prefixes merged into PATH even when the login-shell probe
# fails (slow shell config hits the 3s timeout, GUI launches get launchd's
# minimal PATH) — otherwise brew itself is invisible to detection and installs.
_FALLBACK_PATH_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")


def _refresh_path_from_login_shell() -> None:
    """Merge PATH from a login shell into os.environ so newly-installed CLIs are visible.

    POSIX-only, best-effort: all failures are swallowed silently.
    """
    if os.name != "posix":
        return
    shell_paths: list[str] = []
    try:
        proc = subprocess.run(
            _path_probe_command(),
            capture_output=True,
            text=True,
            timeout=3,
        )
        raw = proc.stdout or ""
        # Take the last non-empty line (login shells may emit banner text first)
        lines = [l for l in raw.splitlines() if l.strip()]
        if lines:
            shell_paths = lines[-1].split(":")
    except Exception:  # noqa: BLE001
        pass
    shell_paths.extend(d for d in _FALLBACK_PATH_DIRS if os.path.isdir(d))
    current_paths = os.environ.get("PATH", "").split(":")
    current_set = set(current_paths)
    seen: set[str] = set()
    new_paths: list[str] = []
    for p in shell_paths:
        if p and p not in current_set and p not in seen:
            seen.add(p)
            new_paths.append(p)
    if new_paths:
        os.environ["PATH"] = ":".join(new_paths + current_paths)


def _parse_version(text: str, regex: str) -> str:
    m = re.search(regex, text)
    return m.group(1) if m else ""


def _version_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(p) for p in re.findall(r"\d+", v)) or (0,)


def _meets_min(version: str, min_version: str) -> bool:
    if not min_version:
        return True
    if not version:
        return False
    return _version_tuple(version) >= _version_tuple(min_version)


def _install_method(resolved_path: str) -> str:
    """Classify HOW a binary got installed, from where it physically lives.

    Drives which official maintenance command applies, so it must not guess:
    anything unrecognised stays 'unknown' and the UI falls back to vendor docs.

        npm       .../node_modules/<pkg>/...   (nvm, brew-node, system npm alike)
        homebrew  /opt/homebrew/... | /usr/local/Cellar/...
        native    ~/.local/share/<tool>/...    (vendor's own installer)
        script    ~/.<tool>/bin/... | ~/.local/bin/...  (vendor install script)
    """
    if not resolved_path:
        return ""
    if "/node_modules/" in resolved_path:
        return "npm"
    if resolved_path.startswith(("/opt/homebrew/", "/usr/local/Cellar/")):
        return "homebrew"
    home = str(Path.home())
    if resolved_path.startswith(f"{home}/.local/share/"):
        return "native"
    if resolved_path.startswith(f"{home}/.") and "/bin/" in resolved_path:
        return "script"
    return "unknown"


def detect_dep(dep: Dep) -> dict[str, Any]:
    """Run the dep's check_cmd and classify ok | missing | outdated."""
    binary_path = shutil.which(dep.check_cmd[0]) or ""
    exit_code: int | None = None
    signal_name = ""
    duration_ms: int | None = None
    if not binary_path:
        status = "missing"
        version = ""
    else:
        started = time.monotonic()
        try:
            proc = subprocess.run(
                dep.check_cmd, capture_output=True, text=True, timeout=8
            )
            duration_ms = max(0, round((time.monotonic() - started) * 1000))
            exit_code = proc.returncode
            if proc.returncode < 0:
                try:
                    signal_name = signal.Signals(-proc.returncode).name
                except ValueError:
                    signal_name = f"SIG{-proc.returncode}"
            out = (proc.stdout or "") + (proc.stderr or "")
            version = _parse_version(out, dep.version_regex)
            if version and not _meets_min(version, dep.min_version):
                status = "outdated"
            elif proc.returncode == 0 or version:
                status = "ok"
            else:
                status = "missing"
        except (subprocess.SubprocessError, OSError):
            duration_ms = max(0, round((time.monotonic() - started) * 1000))
            status = "missing"
            version = ""
    return {
        "id": dep.id,
        "label": dep.label,
        "description": dep.description,
        "group": dep.group,
        "status": status,
        "version": version,
        "min_version": dep.min_version,
        "optional": dep.optional,
        "needs_terminal": dep.needs_terminal,
        "can_install": bool(dep.install_cmd),
        "docs_url": dep.docs_url,
        "binary_path": binary_path,
        "resolved_path": os.path.realpath(binary_path) if binary_path else "",
        "install_method": _install_method(os.path.realpath(binary_path) if binary_path else ""),
        "update_cmd": dep.update_cmd,
        "doctor_cmd": dep.doctor_cmd,
        "autoupdate_env": dep.autoupdate_env,
        "autoupdate_policy": cli_autoupdate_policy(dep.id) if dep.autoupdate_env else "",
        "exit_code": exit_code,
        "signal": signal_name,
        "duration_ms": duration_ms,
    }


def _distinct_executables(command: str) -> list[dict[str, Any]]:
    """Executable PATH entries collapsed by physical file identity."""
    grouped: dict[tuple[int, int] | tuple[str, str], dict[str, Any]] = {}
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if not directory:
            continue
        candidate = Path(directory).expanduser() / command
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            continue
        try:
            stat = candidate.stat()
            identity: tuple[int, int] | tuple[str, str] = (stat.st_dev, stat.st_ino)
            resolved = str(candidate.resolve())
        except OSError:
            identity = ("path", str(candidate))
            resolved = os.path.realpath(candidate)
        entry = grouped.setdefault(identity, {"path": str(candidate), "resolved_path": resolved, "aliases": []})
        if str(candidate) not in entry["aliases"]:
            entry["aliases"].append(str(candidate))
    return list(grouped.values())


def _probe_alternate(dep: Dep, executable: str) -> dict[str, Any]:
    started = time.monotonic()
    exit_code: int | None = None
    signal_name = ""
    version = ""
    status = "failed"
    try:
        proc = subprocess.run(
            [executable, *dep.check_cmd[1:]],
            capture_output=True,
            text=True,
            timeout=3,
        )
        exit_code = proc.returncode
        output = (proc.stdout or "") + (proc.stderr or "")
        version = _parse_version(output, dep.version_regex)
        if proc.returncode < 0:
            try:
                signal_name = signal.Signals(-proc.returncode).name
            except ValueError:
                signal_name = f"SIG{-proc.returncode}"
        status = "ok" if proc.returncode == 0 or version else "failed"
    except (subprocess.SubprocessError, OSError):
        pass
    return {
        "version": version,
        "status": status,
        "exit_code": exit_code,
        "signal": signal_name,
        "duration_ms": max(0, round((time.monotonic() - started) * 1000)),
    }


def _same_npm_install(first: dict[str, Any], second: dict[str, Any], package: str) -> bool:
    """True when both candidates resolve into the same npm prefix of `package`."""
    if not package:
        return False
    marker = f"/node_modules/{package}/"
    first_resolved = str(first.get("resolved_path") or "")
    second_resolved = str(second.get("resolved_path") or "")
    if marker not in first_resolved or marker not in second_resolved:
        return False
    return first_resolved.split(marker, 1)[0] == second_resolved.split(marker, 1)[0]


def _candidate_removal(candidate: dict[str, Any], dep: Dep, version: str) -> dict[str, str]:
    """Return a confirmed removal command only when ownership is unambiguous."""
    package = dep.npm_package
    resolved = str(candidate.get("resolved_path") or "")
    path = str(candidate.get("path") or "")
    package_marker = f"/node_modules/{package}/" if package else ""
    npm = Path(path).parent / "npm"
    if not package_marker or package_marker not in resolved or not npm.is_file() or not os.access(npm, os.X_OK):
        return {"manager": "", "command": ""}

    uninstall = f"{shlex.quote(str(npm))} uninstall -g {shlex.quote(package)}"
    description = f"Remove {dep.label} {version or ''} from {path}".replace("  ", " ")
    confirmed = (
        f"printf '%s\\n' {shlex.quote(description)}; "
        "printf 'Continue? [y/N] '; read -r answer; "
        f"case \"$answer\" in [Yy]*) {uninstall} ;; *) echo 'Cancelled.' ;; esac"
    )
    return {"manager": "npm", "command": confirmed}


def _config_homes(dep: Dep) -> list[tuple[str, Path]]:
    """Every config home where ``dep`` may have written state, deduped by path.

    A CLI writes its update result into whichever config home the run used, so
    a profile pane's failure lands in that profile's home and is invisible from
    the default one — all of them have to be checked.
    """
    homes: list[tuple[str, Path]] = []
    if dep.config_home_default:
        homes.append(("default", Path.home() / dep.config_home_default))
    env_home = os.environ.get(dep.config_home_env, "") if dep.config_home_env else ""
    if env_home:
        homes.append(("env", Path(env_home)))
    try:
        for entry in sorted((default_profiles_root() / dep.id).iterdir()):
            if entry.is_dir():
                homes.append((f"profile:{entry.name}", entry))
    except OSError:
        pass  # no profiles for this agent
    seen: set[str] = set()
    unique: list[tuple[str, Path]] = []
    for scope, home in homes:
        key = os.path.realpath(home)
        if key in seen:
            continue
        seen.add(key)
        unique.append((scope, home))
    return unique


def read_update_state(dep: Dep) -> list[dict[str, Any]]:
    """The CLI's own last-update records across its config homes, newest first.

    Pure read-back of what the vendor already wrote — Navide never authors these
    files and never infers an outcome the CLI did not record.
    """
    if not dep.update_state_file:
        return []
    records: list[dict[str, Any]] = []
    for scope, home in _config_homes(dep):
        try:
            data = json.loads((home / dep.update_state_file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        records.append({
            "scope": scope,
            "home": str(home),
            "timestamp": str(data.get("timestamp") or ""),
            "outcome": str(data.get("outcome") or ""),
            "status": str(data.get("status") or ""),
            "version_from": str(data.get("version_from") or ""),
            "version_to": str(data.get("version_to") or ""),
        })
    records.sort(key=lambda record: record["timestamp"], reverse=True)
    return records


def _stale_update_failure(record: dict[str, Any], current_version: str) -> bool:
    """True when a failure predates the version now installed (already moved on)."""
    recorded_from = str(record.get("version_from") or "")
    return bool(recorded_from and current_version and recorded_from != current_version)


def build_cli_health(dep_statuses: list[dict[str, Any]]) -> dict[str, Any]:
    """Build actionable health findings for installed agent CLIs."""
    status_by_id = {status["id"]: status for status in dep_statuses}
    cli_entries: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for dep in DEPS:
        if dep.group != "agent_cli":
            continue
        candidates = _distinct_executables(dep.check_cmd[0])
        if not candidates:
            continue  # Missing optional CLIs are handled by normal onboarding.
        dep_status = status_by_id.get(dep.id, {})
        primary_resolved = str(dep_status.get("resolved_path") or "")
        probed: list[tuple[dict[str, Any], dict[str, Any], bool]] = []
        for candidate in candidates:
            is_primary = candidate["resolved_path"] == primary_resolved
            probe = {
                "version": dep_status.get("version", ""),
                "status": "ok" if dep_status.get("status") == "ok" else "failed",
                "exit_code": dep_status.get("exit_code"),
                "signal": dep_status.get("signal", ""),
                "duration_ms": dep_status.get("duration_ms"),
            } if is_primary else _probe_alternate(dep, candidate["resolved_path"])
            probed.append((candidate, probe, is_primary))
        detailed_candidates: list[dict[str, Any]] = []
        for candidate, probe, is_primary in probed:
            # Removal must never target the last working install: broken
            # candidates are always removable (removing them cannot lose a
            # working CLI), working ones only when a different physical
            # install also probes ok.
            package = dep.npm_package
            removable = probe.get("status") != "ok" or any(
                other_probe.get("status") == "ok"
                and not _same_npm_install(candidate, other_candidate, package)
                for other_candidate, other_probe, _ in probed
                if other_candidate is not candidate
            )
            removal = (
                _candidate_removal(candidate, dep, str(probe.get("version") or ""))
                if removable
                else {"manager": "", "command": ""}
            )
            detailed_candidates.append({
                **candidate,
                **probe,
                "is_primary": is_primary,
                "install_method": _install_method(str(candidate.get("resolved_path") or "")),
                "install_manager": removal["manager"],
                "removal_command": removal["command"],
            })
        update_records = read_update_state(dep)
        entry = {
            "agent_key": dep.id,
            "label": dep.label,
            "diagnostic_command": dep.doctor_cmd or " ".join(dep.check_cmd),
            "update_command": dep.update_cmd,
            "docs_url": dep.docs_url,
            "update_state": update_records,
            "candidates": detailed_candidates,
        }
        cli_entries.append(entry)
        primary = next((candidate for candidate in detailed_candidates if candidate["is_primary"]), detailed_candidates[0])
        failed_updates = [
            record for record in update_records
            if record["outcome"] == "failed"
            and not _stale_update_failure(record, str(primary.get("version") or ""))
        ]
        if failed_updates:
            findings.append({
                "type": "update_failed",
                "agent_key": dep.id,
                "label": dep.label,
                "records": failed_updates,
            })
        if primary["status"] != "ok":
            findings.append({
                "type": "probe_failed",
                "agent_key": dep.id,
                "label": dep.label,
                "primary": primary,
            })
        if len(detailed_candidates) > 1:
            findings.append({
                "type": "duplicate_install",
                "agent_key": dep.id,
                "label": dep.label,
                "candidates": detailed_candidates,
            })

    fingerprint_source = [
        {
            "type": finding["type"],
            "agent_key": finding["agent_key"],
            # Only update_failed carries records; keeping the key absent
            # otherwise preserves existing fingerprints (and dismissals).
            **({"records": [
                {"home": record["home"], "timestamp": record["timestamp"],
                 "status": record["status"]}
                for record in finding["records"]
            ]} if finding.get("records") else {}),
            "candidates": [
                {
                    "resolved_path": candidate["resolved_path"],
                    "version": candidate["version"],
                    "status": candidate["status"],
                    "exit_code": candidate["exit_code"],
                    "signal": candidate["signal"],
                }
                for candidate in (
                    finding.get("candidates")
                    or ([finding["primary"]] if finding.get("primary") else [])
                )
            ],
        }
        for finding in findings
    ]
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_source, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16] if findings else ""
    dismissed = fingerprint != "" and _dismissed_cli_health_fingerprint() == fingerprint
    return {
        "entries": cli_entries,
        "findings": findings,
        "fingerprint": fingerprint,
        "dismissed": dismissed,
        "needs_attention": bool(findings) and not dismissed,
    }


def detect_ollama_models() -> list[str]:
    """Return installed Ollama model names (empty if ollama missing/unreachable)."""
    if shutil.which("ollama") is None:
        return []
    try:
        proc = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, timeout=8
        )
    except (subprocess.SubprocessError, OSError):
        return []
    models: list[str] = []
    for line in proc.stdout.splitlines()[1:]:  # skip header
        name = line.split()[0] if line.split() else ""
        if name:
            models.append(name)
    return models


def compute_gate(dep_statuses: list[dict[str, Any]], models: list[str]) -> dict[str, Any]:
    """Compute the hard-block gate from detected statuses."""
    by_group: dict[str, list[dict[str, Any]]] = {"foundation": [], "agent_cli": [], "analyzer": []}
    for s in dep_statuses:
        by_group.get(s["group"], []).append(s)

    foundation_ready = all(s["status"] == "ok" for s in by_group["foundation"] if not s.get("optional"))
    has_any_cli = any(s["status"] == "ok" for s in by_group["agent_cli"])
    ollama_ok = any(s["id"] == "ollama" and s["status"] == "ok" for s in by_group["analyzer"])
    analyzer_ready = ollama_ok and len(models) > 0

    # Analyzer (ollama + a multi-GB local model) is optional — it must not
    # hard-block first use. analyzer_ready is still reported so the wizard
    # can surface it as a recommended extra.
    all_required_ready = foundation_ready and has_any_cli
    return {
        "foundation_ready": foundation_ready,
        "has_any_cli": has_any_cli,
        "analyzer_ready": analyzer_ready,
        "ollama_ok": ollama_ok,
        "has_model": len(models) > 0,
        "all_required_ready": all_required_ready,
        "suggested_model": _SUGGESTED_MODEL,
    }


def get_status() -> dict[str, Any]:
    """Full onboarding status: every dep + installed models + gate."""
    _refresh_path_from_login_shell()
    # Probe every dep concurrently. Each detect_dep runs an independent
    # `--version` subprocess (up to 8s each), so serial execution scaled the
    # whole call with dep count — long enough that a concurrent WS request
    # (e.g. workspace.list_recent) could time out. Fan out so the total cost
    # is the slowest single probe, not their sum, and overlap the ollama probe.
    with ThreadPoolExecutor(
        max_workers=min(len(DEPS) + 1, 8), thread_name_prefix="dep-probe"
    ) as pool:
        models_future = pool.submit(detect_ollama_models)
        deps = list(pool.map(detect_dep, DEPS))
        models = models_future.result()
    return {
        "deps": deps,
        "models": models,
        "gate": compute_gate(deps, models),
        "model_catalog": MODEL_CATALOG,
        "cli_health": build_cli_health(deps),
    }


# ── Maintenance (registry-driven, official commands only) ────────────────────
MAINTENANCE_ACTIONS = ("update", "doctor", "install")


def maintenance_command(dep_id: str, action: str) -> dict[str, Any]:
    """Resolve the vendor's own maintenance command for ``dep_id``.

    The caller passes an action id, never a command string: everything runnable
    comes from the registry. A vendor that ships no such command yields an
    error plus its docs URL — Navide does not substitute one of its own.
    """
    dep = DEPS_BY_ID.get(dep_id)
    if dep is None:
        return {"ok": False, "error": f"unknown dependency: {dep_id!r}"}
    if action not in MAINTENANCE_ACTIONS:
        return {"ok": False, "error": f"unknown action: {action!r}"}
    command = {
        "update": dep.update_cmd,
        "doctor": dep.doctor_cmd,
        "install": dep.install_cmd,
    }[action]
    if not command:
        return {
            "ok": False,
            "error": f"{dep.label} has no official {action} command",
            "docs_url": dep.docs_url,
        }
    # Always interactive: an update may prompt, authenticate or need sudo, so it
    # belongs in a terminal the user can see and answer.
    return {"ok": True, "needs_terminal": True, "command": command, "docs_url": dep.docs_url}


# ── Install (whitelist-driven) ────────────────────────────────────────────────
def install_dep(dep_id: str) -> dict[str, Any]:
    """Install a dep by id. Only ids in the registry whitelist are accepted.

    Interactive deps (sudo / OAuth) are handed back to the caller so the main
    process can open an external Terminal; non-interactive ones run inline and
    return captured output.
    """
    dep = DEPS_BY_ID.get(dep_id)
    if dep is None:
        return {"ok": False, "error": f"unknown dependency: {dep_id!r}"}
    if not dep.install_cmd:
        return {"ok": False, "error": "no install command for this dependency"}
    if dep.needs_terminal:
        # Caller (frontend → main process) opens Terminal.app with this command.
        return {"ok": True, "needs_terminal": True, "command": dep.install_cmd}
    try:
        proc = subprocess.run(
            dep.install_cmd, shell=True, capture_output=True, text=True, timeout=900
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "install timed out"}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    output = (proc.stdout or "") + (proc.stderr or "")
    return {"ok": proc.returncode == 0, "output": output, "command": dep.install_cmd}


def pull_model(model: str) -> dict[str, Any]:
    """Pull an Ollama model. The model name is constrained to a safe charset."""
    if not re.fullmatch(r"[A-Za-z0-9._:\-]+", model or ""):
        return {"ok": False, "error": "invalid model name"}
    if shutil.which("ollama") is None:
        return {"ok": False, "error": "ollama not installed"}
    # Long download — hand to an external Terminal so progress is visible.
    return {"ok": True, "needs_terminal": True, "command": f"ollama pull {model}"}


# ── Completion flag ───────────────────────────────────────────────────────────
_KV_KEY = "onboarding"


def _flag_path() -> Path:
    return app_data_dir() / "onboarding.json"


_STATE_LOCK = threading.Lock()

# Lazily-opened database handle. The app injects its shared instance at
# startup (set_database); when the resolved flag dir changes (tests patch
# _flag_path per test) a fresh handle is opened for it.
_db: Database | None = None


def set_database(db: Database | None) -> None:
    """Share the app's Database instance instead of opening a second one."""
    global _db
    _db = db


def _get_db() -> Database:
    global _db
    path = _flag_path().parent / DB_FILENAME
    db = _db
    if db is None or db.path != path:
        db = Database(path)
        _db = db
    return db


def _import_legacy_state(cur: object, data: object) -> None:
    if isinstance(data, dict):
        _get_db().kv_set(_KV_KEY, data, now=int(time.time()))


def _kv_state() -> dict[str, Any] | None:
    """Stored onboarding document, importing the legacy app-data JSON once.

    None means "nothing stored yet" — distinct from an (imported) empty dict,
    so is_complete() knows when to fall back to the legacy home-dir flag.
    """
    db = _get_db()
    data = db.kv_get(_KV_KEY)
    if data is None:
        db.import_json(_KV_KEY, _flag_path(), _import_legacy_state)
        data = db.kv_get(_KV_KEY)
    return data if isinstance(data, dict) else None


def _read_state() -> dict[str, Any]:
    return _kv_state() or {}


def _write_state(data: dict[str, Any]) -> None:
    try:
        _get_db().kv_set(_KV_KEY, data, now=int(time.time()))
    except sqlite3.Error as err:
        # Callers guard with OSError, matching the old file-write contract.
        raise OSError(str(err)) from err


def _legacy_flag_path() -> Path:
    return Path.home() / ".agent-team" / "onboarding.json"


def _migrate_legacy_flag() -> None:
    """One-time seed of the stored state from ~/.agent-team/onboarding.json.

    Best-effort: existing users must not see onboarding again, so on seed
    failure `is_complete()` still falls back to reading the legacy path.
    """
    if _kv_state() is not None:
        return
    legacy = _legacy_flag_path()
    if not legacy.exists():
        return
    try:
        data = json.loads(legacy.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            _write_state(data)
    except (OSError, ValueError):
        pass


def should_skip() -> bool:
    return os.environ.get("AGENT_TEAM_SKIP_ONBOARDING", "") == "1"


def is_complete() -> bool:
    if should_skip():
        return True
    _migrate_legacy_flag()
    state = _kv_state()
    if state is not None:
        return bool(state.get("complete"))
    # Read-only fallback: the legacy home-dir flag (kept even though the seed
    # above normally captures it — a failed seed must not re-show onboarding).
    try:
        data = json.loads(_legacy_flag_path().read_text(encoding="utf-8"))
        return bool(data.get("complete"))
    except (OSError, ValueError):
        return False


def set_complete(value: bool) -> None:
    try:
        with _STATE_LOCK:
            data = _read_state()
            data["complete"] = value
            _write_state(data)
    except OSError:
        pass


def _dismissed_cli_health_fingerprint() -> str:
    _migrate_legacy_flag()
    return str(_read_state().get("dismissed_cli_health") or "")


def dismiss_cli_health(fingerprint: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{16}", fingerprint or ""):
        return
    _migrate_legacy_flag()
    try:
        with _STATE_LOCK:
            data = _read_state()
            data["dismissed_cli_health"] = fingerprint
            _write_state(data)
    except OSError:
        pass


def cli_binary_override(agent_key: str) -> str:
    """Return a persisted executable only while it still exists and is executable."""
    _migrate_legacy_flag()
    data = _read_state()
    overrides = data.get("cli_binary_overrides")
    if not isinstance(overrides, dict):
        return ""
    path = str(overrides.get(agent_key) or "")
    dep = DEPS_BY_ID.get(agent_key)
    if dep is None or Path(path).name != dep.check_cmd[0]:
        return ""
    return path if Path(path).is_file() and os.access(path, os.X_OK) else ""


def select_cli_binary(agent_key: str, path: str, fingerprint: str) -> dict[str, Any]:
    """Persist a verified CLI choice and its dismissal in one atomic transaction."""
    dep = DEPS_BY_ID.get(agent_key)
    if dep is None or dep.group != "agent_cli":
        return {"ok": False, "error": "unknown agent CLI"}
    if not re.fullmatch(r"[0-9a-f]{16}", fingerprint or ""):
        return {"ok": False, "error": "invalid fingerprint"}
    candidates = _distinct_executables(dep.check_cmd[0])
    selected = next((candidate for candidate in candidates if path in candidate.get("aliases", [])), None)
    if selected is None:
        return {"ok": False, "error": "binary is not an installed PATH candidate"}

    canonical_path = path
    _migrate_legacy_flag()
    try:
        with _STATE_LOCK:
            data = _read_state()
            overrides = data.get("cli_binary_overrides")
            if not isinstance(overrides, dict):
                overrides = {}
            overrides[agent_key] = canonical_path
            data["cli_binary_overrides"] = overrides
            data["dismissed_cli_health"] = fingerprint
            _write_state(data)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True, "agent_key": agent_key, "path": canonical_path}


# ── Auto-update policy (the vendor's own switch, not a Navide mechanism) ──────
AUTOUPDATE_POLICIES = ("vendor", "manual")


def cli_autoupdate_policy(agent_key: str) -> str:
    """'vendor' (default — the CLI updates itself as it always has) or 'manual'."""
    _migrate_legacy_flag()
    policies = _read_state().get("cli_autoupdate")
    if not isinstance(policies, dict):
        return "vendor"
    policy = str(policies.get(agent_key) or "")
    return policy if policy in AUTOUPDATE_POLICIES else "vendor"


def set_cli_autoupdate_policy(agent_key: str, policy: str) -> dict[str, Any]:
    dep = DEPS_BY_ID.get(agent_key)
    if dep is None or not dep.autoupdate_env:
        return {"ok": False, "error": "agent has no vendor auto-update switch"}
    if policy not in AUTOUPDATE_POLICIES:
        return {"ok": False, "error": f"unknown policy: {policy!r}"}
    _migrate_legacy_flag()
    try:
        with _STATE_LOCK:
            data = _read_state()
            policies = data.get("cli_autoupdate")
            if not isinstance(policies, dict):
                policies = {}
            policies[agent_key] = policy
            data["cli_autoupdate"] = policies
            _write_state(data)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True, "agent_key": agent_key, "policy": policy}


def spawn_env_for(agent_key: str) -> dict[str, str]:
    """Env the CLI's own auto-update switch needs for this spawn.

    Empty unless the user explicitly chose 'manual', so the default spawn stays
    byte-for-byte what the vendor expects.
    """
    dep = DEPS_BY_ID.get(agent_key)
    if dep is None or not dep.autoupdate_env:
        return {}
    return {dep.autoupdate_env: "1"} if cli_autoupdate_policy(agent_key) == "manual" else {}
