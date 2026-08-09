"""Per-pane shim homes for the CLIs whose only MCP surface is a home-dir file.

kimi, grok and antigravity have no MCP flag and no variable that carries a
config document, so wiring them means giving each pane its own copy of the
directory holding one. Done naively that logs the user out — their credentials
live in the same tree. So a shim mirrors the real directory by symlink and
materialises *only* the MCP config as a real file: credentials, sessions and
history stay links to the user's own, and writes go straight through to them.

Two shapes, picked by what the CLI offers:

- kimi has a dedicated config-dir variable (``KIMI_CODE_HOME``), so its shim is
  just that directory and ``$HOME`` is left alone.
- grok and antigravity have none (their config root is hardcoded to
  ``Path.home()``), so theirs is a whole HOME shim: the top level of ``$HOME``
  mirrored by symlink with the vendor directory rebuilt inside it. This is the
  shape credential_vault already uses for grok login panes.

grok is the awkward one: its MCP servers and its API key live in the *same*
file (``~/.grok/user-settings.json``), so that file alone cannot be a symlink
and is copied instead. A grok pane therefore runs against a snapshot of the
credential taken at spawn — re-copied on the next spawn, but an account switch
does not reach a pane already running.

Every failure here is non-fatal: prepare() returns None and the pane spawns
unwired rather than not at all.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(
    "agent_team_backend.plugins.builtin.navide_plans.pane_home"
)

PANES_DIR_NAME = ".navide-panes"

# Pane ids are UUIDs from the frontend, but they reach us as untrusted payload
# and become a path segment — same guard codex's per-pane homes use.
_SAFE_PANE_ID = re.compile(r"^[A-Za-z0-9_.:-]+$")


@dataclass(frozen=True)
class ShimSpec:
    """How one vendor's shim is assembled.

    ``config_relpath`` is relative to the vendor directory, and every level of
    it is rebuilt as a real directory so that only the leaf is ours.
    """

    env_var: str
    vendor_dir: str
    config_relpath: tuple[str, ...]
    shims_home: bool
    url_key: str


SHIM_SPECS: dict[str, ShimSpec] = {
    # url without a transport field is read as streamable HTTP.
    "kimi": ShimSpec("KIMI_CODE_HOME", ".kimi-code", ("mcp.json",), False, "url"),
    # Shares ~/.gemini with the Antigravity IDE. "url"/"httpUrl" are rejected
    # as legacy — a remote server is keyed by serverUrl.
    "antigravity": ShimSpec(
        "HOME", ".gemini", ("config", "mcp_config.json"), True, "serverUrl"
    ),
    # Servers are a list under mcp.servers, not a map (see _grok_document).
    "grok": ShimSpec("HOME", ".grok", ("user-settings.json",), True, "url"),
}


def real_home() -> Path:
    """The user's home — the single seam tests redirect to a tmp_path."""
    return Path.home()


def panes_root() -> Path:
    """Parent of every shim home: ``~/.navide-panes/<agent>/<pane>``."""
    return real_home() / PANES_DIR_NAME


def shim_root(agent_key: str, pane_id: str) -> Path | None:
    """Where ``pane_id``'s shim for ``agent_key`` lives, if both are usable."""
    if agent_key not in SHIM_SPECS or not _SAFE_PANE_ID.match(pane_id or ""):
        return None
    return panes_root() / agent_key / pane_id


def _mirror(dst: Path, src: Path, skip: set[str]) -> None:
    """Symlink every entry of ``src`` into ``dst``, minus ``skip``.

    Re-run on every spawn: entries added to the real directory since last time
    appear, and links whose target has since been deleted are dropped (a
    dangling link would otherwise shadow a name the CLI wants to create).
    """
    dst.mkdir(parents=True, exist_ok=True)
    try:
        for entry in dst.iterdir():
            if entry.is_symlink() and not entry.exists():
                entry.unlink(missing_ok=True)
    except OSError as err:
        log.warning("pruning stale links in %s failed: %s", dst, err)
    try:
        sources = list(src.iterdir())
    except OSError:
        return  # real dir absent (fresh install) — an empty shim is still valid
    for item in sources:
        if item.name in skip:
            continue
        link = dst / item.name
        if link.exists() or link.is_symlink():
            continue
        try:
            link.symlink_to(item, target_is_directory=item.is_dir())
        except OSError as err:
            log.warning("shim symlink %s -> %s failed: %s", link, item, err)


def _read_json_object(path: Path) -> dict[str, Any]:
    """The user's config as a dict; empty for absent, unreadable or non-object.

    Unparseable input is treated as empty rather than propagated: the result
    is written to the shim copy, never back over the user's file, so the worst
    case is a pane that starts with only our server configured.
    """
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return {}
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("%s is not valid JSON — shim starts from an empty config", path)
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _map_document(existing: dict[str, Any], server_name: str, url: str, url_key: str) -> dict[str, Any]:
    """Merge our entry into the ``mcpServers`` map kimi and antigravity use."""
    document = dict(existing)
    servers = document.get("mcpServers")
    document["mcpServers"] = {
        **(servers if isinstance(servers, dict) else {}),
        server_name: {url_key: url},
    }
    return document


def _grok_document(existing: dict[str, Any], server_name: str, url: str) -> dict[str, Any]:
    """Merge our entry into grok's ``mcp.servers`` *list*.

    Keyed by ``id``, so a previous run's entry is replaced rather than
    accumulating a duplicate each spawn.
    """
    document = dict(existing)
    section = document.get("mcp")
    section = dict(section) if isinstance(section, dict) else {}
    servers = section.get("servers")
    kept = [
        item
        for item in (servers if isinstance(servers, list) else [])
        if isinstance(item, dict) and item.get("id") != server_name
    ]
    kept.append(
        {
            "id": server_name,
            "label": "Navide Plans",
            "enabled": True,
            "transport": "http",
            "url": url,
        }
    )
    section["servers"] = kept
    document["mcp"] = section
    return document


def _write_config(path: Path, document: dict[str, Any]) -> None:
    """Atomically write the shim's config, 0600 (grok's carries an API key)."""
    content = json.dumps(document, indent=2) + "\n"
    try:
        if path.read_text(encoding="utf-8") == content:
            return
    except OSError:
        pass
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


def prepare(agent_key: str, pane_id: str, url: str, server_name: str) -> tuple[str, str] | None:
    """Build (or refresh) the pane's shim and return ``(env_var, path)``.

    None when the vendor has no shim, the pane id is unusable as a path
    segment, or the filesystem work fails — the caller then spawns unwired.
    Blocking I/O: call off the event loop.
    """
    spec = SHIM_SPECS.get(agent_key)
    root = shim_root(agent_key, pane_id)
    if spec is None or root is None:
        return None
    home = real_home()
    real_vendor = home / spec.vendor_dir
    try:
        if spec.shims_home:
            # PANES_DIR_NAME is skipped alongside the vendor dir: it lives in
            # the real home too, and mirroring it would point every shim at the
            # tree that contains it.
            _mirror(root, home, {spec.vendor_dir, PANES_DIR_NAME})
            vendor_root = root / spec.vendor_dir
        else:
            vendor_root = root
        # Rebuild each directory on the way to the config file, so only the
        # leaf is ours and every sibling stays a link to the user's.
        src, dst = real_vendor, vendor_root
        for name in spec.config_relpath:
            _mirror(dst, src, {name})
            src, dst = src / name, dst / name
        existing = _read_json_object(src)
        document = (
            _grok_document(existing, server_name, url)
            if agent_key == "grok"
            else _map_document(existing, server_name, url, spec.url_key)
        )
        _write_config(dst, document)
        os.chmod(root, 0o700)
    except OSError as err:
        log.warning("could not prepare %s shim home for pane %s: %s", agent_key, pane_id, err)
        return None
    return spec.env_var, str(root)
