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

grok is the awkward one: its MCP servers and its BYO API key live in the *same*
file (``~/.grok/user-settings.json``), so that file alone cannot be a symlink
and is copied instead. Which copy a spawn builds on is decided by mtime (see
_base_config): a pane that rotated its own key keeps it, and an account switch
reaches the pane on its next spawn but never one already running. Its OAuth
credential is a separate file and stays linked, so this affects the BYO key and
preferences only.

Every failure here is non-fatal: prepare() returns None and the pane spawns
unwired rather than not at all.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(
    "agent_team_backend.plugins.builtin.navide_plans.pane_home"
)

PANES_DIR_NAME = ".navide-panes"

# Our in-progress writes. Distinct enough to recognise as ours on the next
# spawn, since a crash between mkstemp and os.replace leaves one behind.
TMP_PREFIX = ".navide-tmp-"

# Pane ids are UUIDs from the frontend, but they reach us as untrusted payload
# and become a path segment. Separators are excluded by the character class;
# the lookahead additionally rejects "." and ".." on their own, which would
# otherwise pass it and resolve the shim onto a directory we do not own.
_SAFE_PANE_ID = re.compile(r"^(?!\.+$)[A-Za-z0-9_.:-]+$")


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
    # Entries inside the vendor dir linked from the first spawn, by creating
    # the real one empty when the CLI has not made it yet. _adopt() would move
    # them back on the *next* spawn anyway, but that leaves the first pane's
    # whole run pane-local — invisible to the log readers, which look under
    # the real home. Only empty-safe names belong here: a directory, or a
    # sqlite file (empty is a valid empty database, which is why
    # credential_vault's grok shim seeds the same three). Never a credential
    # file the CLI parses — an empty one there reads as corrupt, not absent.
    seeded_dirs: tuple[str, ...] = ()
    seeded_files: tuple[str, ...] = ()
    # Names that are rebuildable scratch, discarded from the shim on conflict
    # instead of being kept. Keeping a pane-local sqlite -wal beside a linked
    # (shared) database is worse than having none: SQLite replays a valid WAL
    # header, so stale frames would be written into the user's real database.
    volatile: tuple[str, ...] = ()


SHIM_SPECS: dict[str, ShimSpec] = {
    # url without a transport field is read as streamable HTTP.
    "kimi": ShimSpec(
        "KIMI_CODE_HOME",
        ".kimi-code",
        ("mcp.json",),
        False,
        "url",
        seeded_dirs=("sessions", "credentials", "oauth"),
    ),
    # Shares ~/.gemini with the Antigravity IDE. "url"/"httpUrl" are rejected
    # as legacy — a remote server is keyed by serverUrl.
    "antigravity": ShimSpec(
        "HOME",
        ".gemini",
        ("config", "mcp_config.json"),
        True,
        "serverUrl",
        seeded_dirs=("antigravity-cli",),
    ),
    # Servers are a list under mcp.servers, not a map (see _grok_document).
    # The sqlite sidecars are seeded for the same reason credential_vault's
    # grok shim lists them explicitly: they are absent after a clean shutdown,
    # so "link it only if it already exists" would leave them pane-local.
    "grok": ShimSpec(
        "HOME",
        ".grok",
        ("user-settings.json",),
        True,
        "url",
        seeded_files=("grok.db", "grok.db-wal", "grok.db-shm"),
        volatile=("grok.db-wal", "grok.db-shm"),
    ),
}


def real_home() -> Path:
    """The user's home — the single seam tests redirect to a tmp_path.

    Read from the password database rather than ``Path.home()``, which prefers
    ``$HOME``. Launching Navide from a terminal inside a shimmed pane makes the
    backend inherit that pane's ``$HOME``, and building a shim under it would
    mirror links to links; the passwd entry is immune to that for every kind of
    shim, not just this module's.
    """
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (ImportError, AttributeError, KeyError, OSError):
        return Path.home()


def panes_root() -> Path:
    """Parent of every shim home: ``~/.navide-panes/<agent>/<pane>``."""
    return real_home() / PANES_DIR_NAME


def shim_root(agent_key: str, pane_id: str) -> Path | None:
    """Where ``pane_id``'s shim for ``agent_key`` lives, if both are usable."""
    if agent_key not in SHIM_SPECS or not _SAFE_PANE_ID.match(pane_id or ""):
        return None
    return panes_root() / agent_key / pane_id


def _remove(entry: Path) -> None:
    try:
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink(missing_ok=True)
    except OSError as err:
        log.warning("could not remove %s: %s", entry, err)


def _adopt(entry: Path, target: Path) -> bool:
    """Move a real entry the CLI created in the shim out to the real tree.

    A name the real directory did not have when the shim was built is created
    *inside* it — a session dir, a fresh oauth token. Left alone it would stay
    pane-local forever, because the link pass below skips any name already
    present. Moving it out and letting it be re-linked is what keeps a pane's
    sessions visible to the log readers and its login shared with every other
    pane. A name that exists on both sides is a genuine conflict: it is left in
    the shim rather than overwriting the user's, and reported.
    """
    if target.exists() or target.is_symlink():
        log.warning(
            "%s exists in both the shim and the real tree; leaving the shim copy",
            target,
        )
        return False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(entry, target)
    except OSError as err:
        log.warning("could not adopt %s into %s: %s", entry, target, err)
        return False
    return True


def _mirror(
    dst: Path,
    src: Path,
    skip: set[str],
    *,
    adopt: bool = False,
    volatile: tuple[str, ...] = (),
) -> None:
    """Symlink every entry of ``src`` into ``dst``, minus ``skip``.

    Re-run on every spawn, in two passes. First the shim is reconciled: links
    whose target has since been deleted are dropped (a dangling link would
    shadow a name the CLI wants to create), and — where ``adopt`` is set —
    real entries the CLI made are moved back into ``src``. Then everything in
    ``src`` is linked, which picks up both those adoptions and anything the
    user added since.

    ``adopt`` is off by default and deliberately off for the ``$HOME`` level:
    a shimmed home is the pane's whole home, so anything a tool inside it
    writes to ``~`` lands there — a cloned repo, a shell rc file the user does
    not have. Promoting those into the real home is not this module's business
    and would be a way for pane content to reach the user's login shell. Only
    the vendor directory, whose contents are the sessions and credentials the
    shim exists to share, is adopted.
    """
    dst.mkdir(parents=True, exist_ok=True)
    try:
        existing = list(dst.iterdir())
    except OSError as err:
        log.warning("cannot read shim dir %s: %s", dst, err)
        existing = []
    for entry in existing:
        if entry.name in skip:
            continue  # ours to own (the MCP config), never adopted away
        if entry.is_symlink():
            if not entry.exists():
                entry.unlink(missing_ok=True)
            continue
        if entry.name.startswith(TMP_PREFIX):
            # Our own crashed write. Distinctly named so it is cleaned up here
            # rather than adopted into the real tree — for grok that would
            # strand a copy of the API key there.
            _remove(entry)
            continue
        if not adopt:
            continue
        target = src / entry.name
        if entry.name in volatile and (target.exists() or target.is_symlink()):
            _remove(entry)  # rebuildable scratch: the shared one wins outright
            continue
        _adopt(entry, target)
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


def _seed_link_targets(spec: ShimSpec, real_vendor: Path) -> None:
    """Create the empty real targets the seeded names need to be linkable."""
    if not real_vendor.is_dir():
        # The CLI has never run. Creating its config directory here would put
        # Navide's fingerprints in the home of a tool the user does not have,
        # and there is nothing to share on a first spawn anyway — _adopt()
        # picks the entries up once the directory genuinely exists.
        return
    for name in spec.seeded_dirs:
        target = real_vendor / name
        if target.exists() or target.is_symlink():
            continue
        try:
            target.mkdir(parents=True, exist_ok=True)
        except OSError as err:
            log.warning("could not seed %s: %s", target, err)
    for name in spec.seeded_files:
        target = real_vendor / name
        if target.exists() or target.is_symlink():
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        except OSError as err:
            log.warning("could not seed %s: %s", target, err)


def _base_config(real: Path, shim: Path) -> dict[str, Any]:
    """The document our entry is merged into: the newer of the two copies.

    grok keeps its API key in the same file as its MCP servers, so a login or
    a token rotation done inside a pane lives only in the shim copy — always
    rebuilding from the real file would throw it away on the next spawn, and
    the user would be asked to log in again. When the real file is the newer
    one (the user switched accounts or edited it) that one wins instead.
    """
    try:
        shim_mtime = shim.stat().st_mtime
    except OSError:
        return _read_json_object(real)
    try:
        real_mtime = real.stat().st_mtime
    except OSError:
        return _read_json_object(shim)
    # Strictly newer, so a tie goes to the real file: coarse filesystem
    # timestamps (1s on HFS+ and exFAT) make ties real, and silently shadowing
    # an account switch is the worse of the two failures.
    return _read_json_object(shim if shim_mtime > real_mtime else real)


def _write_config(path: Path, document: dict[str, Any]) -> None:
    """Atomically write the shim's config, 0600 (grok's carries an API key)."""
    content = json.dumps(document, indent=2) + "\n"
    try:
        if path.read_text(encoding="utf-8") == content:
            return
    except OSError:
        pass
    # mkstemp, not a fixed ".tmp" name: it creates the file 0600 with no
    # world-readable window for grok's key, and two panes preparing at the
    # same moment must not race over one temp path.
    handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=TMP_PREFIX)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(content)
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
    if PANES_DIR_NAME in home.parts:
        # The backend was launched from inside a shimmed pane and inherited its
        # HOME, so "the real home" is another pane's shim. Nesting one shim in
        # another would mirror links to links; refuse instead.
        log.warning("home %s is itself a shim — not preparing another", home)
        return None
    real_vendor = home / spec.vendor_dir
    try:
        # Created before anything is written into them: a grok shim holds a
        # copy of the API key, so no part of the path may be world-readable,
        # even briefly.
        for directory in (panes_root(), root.parent, root):
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, 0o700)
        _seed_link_targets(spec, real_vendor)
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
            _mirror(dst, src, {name}, adopt=True, volatile=spec.volatile)
            src, dst = src / name, dst / name
        existing = _base_config(src, dst)
        document = (
            _grok_document(existing, server_name, url)
            if agent_key == "grok"
            else _map_document(existing, server_name, url, spec.url_key)
        )
        _write_config(dst, document)
    except OSError as err:
        log.warning("could not prepare %s shim home for pane %s: %s", agent_key, pane_id, err)
        return None
    return spec.env_var, str(root)
