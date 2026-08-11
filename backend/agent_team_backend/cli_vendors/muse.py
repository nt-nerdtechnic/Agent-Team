"""Meta Muse Code — spawn, install detection and resume-command parsing.

Muse Code is a terminal coding agent Meta released in beta for macOS and
Linux; it installs from a shell script rather than a package manager and is
driven by the ``muse`` binary (``muse exec`` for headless runs).

Meta's public documentation (https://dev.meta.ai/docs/muse-code/, checked
2026-08-11) now covers auth, permissions, interactive use, configuration and
headless operation, so the one resume fact it states exactly is wired up:
resuming from the CLI is the subcommand ``muse resume <id>``, which is the
shape ``resume_id_from_command`` parses back out.

Every other capability stays at its default, which the app reads as
"unsupported for this vendor" and degrades gracefully around:

* ``session_path`` / ``session_exists`` — the docs describe a session as an
  append-only JSONL event log and offer ``--no-session-log`` to skip it, but
  they never state where that log lands, and the layout reported outside the
  docs (``sessions/<Y>/<M>/<D>/<opaque-dir>/session.jsonl``) gives no rule for
  locating a KNOWN id's file. A preflight that guesses wrong vetoes resumes
  that would have worked, which is worse than no preflight; with both unset
  the check passes through instead.
* ``make_log_reader`` — no real ``session.jsonl`` sample exists here to
  validate fields against, and a guessed reader emits plausible-looking but
  wrong activity/token signals. Deferred until a sample from a real
  installation is available.
* credential fields, ``login_home_env``, ``fetch_usage`` — Meta documents
  ``META_API_KEY``, ``muse auth set`` and ``muse logout``, but not where a
  stored credential lives, and no env var relocating the config home
  (settings are read from ``~/.config/muse/settings.json``). Quota is a web
  dashboard only; there is no CLI usage command to call.
"""

import re

from .base import Dep, VendorSpec, command_text

# ---- resume / session ------------------------------------------------------

_RESUME_RE = re.compile(r"^muse\s+resume\s+(\S+)")


def _resume_id_from_command(command) -> str:
    """Session id from a `muse resume <id> ...` command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


# ---- vendor spec -----------------------------------------------------------

SPEC = VendorSpec(
    key="muse",
    label="Muse Code",
    resume_id_from_command=_resume_id_from_command,
    install_dep=Dep(
        "muse", "Muse Code", "Meta Muse Code CLI", "agent_cli",
        ["muse", "--version"],
        install_cmd="curl -fsSL https://dev.meta.ai/install.sh | sh",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://developer.meta.com/ai/products/muse-code/"),
)
