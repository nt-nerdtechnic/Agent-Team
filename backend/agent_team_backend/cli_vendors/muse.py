"""Meta Muse Code — spawn and install detection only.

Muse Code is a terminal coding agent Meta released in beta for macOS and
Linux; it installs from a shell script rather than a package manager and is
driven by the ``muse`` binary (``muse exec`` for headless runs).

Every capability beyond identity and install detection is deliberately left
at its default, which the app reads as "unsupported for this vendor" and
degrades gracefully around. The vendor's public documentation covers install
and login only: the credential file layout, the config-home env var, the
resume syntax behind ``muse replay``, the conversation-log format and any
quota interface are all unverified. Filling them in from guesses would give
the resume preflight, the credential vault and the log watcher paths that do
not exist, so they wait for a probe against a real installation.
"""

from .base import Dep, VendorSpec

SPEC = VendorSpec(
    key="muse",
    label="Muse Code",
    install_dep=Dep(
        "muse", "Muse Code", "Meta Muse Code CLI", "agent_cli",
        ["muse", "--version"],
        install_cmd="curl -fsSL https://dev.meta.ai/install.sh | sh",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://developer.meta.com/ai/products/muse-code/"),
)
