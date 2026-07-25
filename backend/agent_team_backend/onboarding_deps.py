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
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .applog import app_data_dir


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


# ── Registry ──────────────────────────────────────────────────────────────────
# NOTE: Agent-CLI install commands are best-effort and may change upstream; they
# are marked needs_terminal so the user runs/authenticates them interactively.
DEPS: list[Dep] = [
    # Step 1 — Foundation
    Dep("homebrew", "Homebrew", "macOS package manager", "foundation",
        ["brew", "--version"], r"Homebrew (\d+\.\d+\.\d+)",
        install_cmd='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        needs_terminal=True, docs_url="https://brew.sh"),
    Dep("node", "Node.js", "JavaScript runtime (≥ 22)", "foundation",
        ["node", "--version"], r"v?(\d+\.\d+\.\d+)", min_version="22.0.0",
        install_cmd="brew install node@22", docs_url="https://nodejs.org"),
    Dep("pnpm", "pnpm", "Package manager", "foundation",
        ["pnpm", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="brew install pnpm", docs_url="https://pnpm.io"),
    Dep("python", "Python", "Python 3.12+", "foundation",
        ["python3", "--version"], r"Python (\d+\.\d+\.\d+)", min_version="3.12.0",
        install_cmd="brew install python@3.12", docs_url="https://python.org"),
    Dep("uv", "uv", "Python package and environment manager", "foundation",
        ["uv", "--version"], r"uv (\d+\.\d+\.\d+)",
        install_cmd="brew install uv", docs_url="https://docs.astral.sh/uv"),

    # Step 2 — Agent CLIs (≥ 1 required) + Analyzer
    Dep("claude", "Claude Code", "Anthropic Claude CLI", "agent_cli",
        ["claude", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @anthropic-ai/claude-code", needs_terminal=True,
        optional=True, docs_url="https://docs.anthropic.com/claude-code"),
    Dep("codex", "Codex", "OpenAI Codex CLI", "agent_cli",
        ["codex", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @openai/codex", needs_terminal=True,
        optional=True, docs_url=""),
    Dep("antigravity", "Antigravity", "Google Antigravity CLI", "agent_cli",
        ["agy", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://antigravity.google/cli/install.sh | bash",
        needs_terminal=True, optional=True,
        docs_url="https://antigravity.google/docs/cli-getting-started"),
    Dep("grok", "Grok CLI", "superagent-ai Grok coding agent", "agent_cli",
        ["grok", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash",
        needs_terminal=True, optional=True, docs_url="https://grokcli.io"),
    Dep("kimi", "Kimi Code", "Moonshot AI Kimi Code CLI", "agent_cli",
        ["kimi", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
        needs_terminal=True, optional=True, docs_url="https://moonshotai.github.io/kimi-cli/en/"),
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


def _refresh_path_from_login_shell() -> None:
    """Merge PATH from a login shell into os.environ so newly-installed CLIs are visible.

    POSIX-only, best-effort: all failures are swallowed silently.
    """
    if os.name != "posix":
        return
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
        if not lines:
            return
        shell_paths = lines[-1].split(":")
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
    except Exception:  # noqa: BLE001
        pass


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


_NPM_AGENT_PACKAGES = {
    "claude": "@anthropic-ai/claude-code",
    "codex": "@openai/codex",
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
    package = _NPM_AGENT_PACKAGES.get(dep.id, "")
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
            package = _NPM_AGENT_PACKAGES.get(dep.id, "")
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
                "install_manager": removal["manager"],
                "removal_command": removal["command"],
            })
        entry = {
            "agent_key": dep.id,
            "label": dep.label,
            "diagnostic_command": f"{dep.check_cmd[0]} doctor" if dep.id == "claude" else " ".join(dep.check_cmd),
            "candidates": detailed_candidates,
        }
        cli_entries.append(entry)
        primary = next((candidate for candidate in detailed_candidates if candidate["is_primary"]), detailed_candidates[0])
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
def _flag_path() -> Path:
    return app_data_dir() / "onboarding.json"


_STATE_LOCK = threading.Lock()


def _read_state(path: Path | None = None) -> dict[str, Any]:
    target = path or _flag_path()
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_state(data: dict[str, Any], path: Path | None = None) -> None:
    """Atomically replace onboarding state so a restart cannot observe a partial write."""
    target = path or _flag_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(data), encoding="utf-8")
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _legacy_flag_path() -> Path:
    return Path.home() / ".agent-team" / "onboarding.json"


def _migrate_legacy_flag() -> None:
    """One-time copy of the legacy ~/.agent-team/onboarding.json to app_data_dir().

    Best-effort: existing users must not see onboarding again, so on copy
    failure `is_complete()` still falls back to reading the legacy path.
    """
    new = _flag_path()
    if new.exists():
        return
    legacy = _legacy_flag_path()
    if not legacy.exists():
        return
    try:
        new.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(legacy, new)
    except OSError:
        pass


def should_skip() -> bool:
    return os.environ.get("AGENT_TEAM_SKIP_ONBOARDING", "") == "1"


def is_complete() -> bool:
    if should_skip():
        return True
    _migrate_legacy_flag()
    for path in (_flag_path(), _legacy_flag_path()):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return bool(data.get("complete"))
        except (OSError, ValueError):
            continue
    return False


def set_complete(value: bool) -> None:
    path = _flag_path()
    try:
        with _STATE_LOCK:
            data = _read_state(path)
            data["complete"] = value
            _write_state(data, path)
    except OSError:
        pass


def _dismissed_cli_health_fingerprint() -> str:
    _migrate_legacy_flag()
    try:
        data = json.loads(_flag_path().read_text(encoding="utf-8"))
        return str(data.get("dismissed_cli_health") or "") if isinstance(data, dict) else ""
    except (OSError, ValueError):
        return ""


def dismiss_cli_health(fingerprint: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{16}", fingerprint or ""):
        return
    path = _flag_path()
    _migrate_legacy_flag()
    try:
        with _STATE_LOCK:
            data = _read_state(path)
            data["dismissed_cli_health"] = fingerprint
            _write_state(data, path)
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
    state_path = _flag_path()
    _migrate_legacy_flag()
    try:
        with _STATE_LOCK:
            data = _read_state(state_path)
            overrides = data.get("cli_binary_overrides")
            if not isinstance(overrides, dict):
                overrides = {}
            overrides[agent_key] = canonical_path
            data["cli_binary_overrides"] = overrides
            data["dismissed_cli_health"] = fingerprint
            _write_state(data, state_path)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True, "agent_key": agent_key, "path": canonical_path}
