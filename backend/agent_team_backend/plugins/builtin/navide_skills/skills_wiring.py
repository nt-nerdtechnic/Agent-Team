"""Expose enabled app-managed skills to a pane's CLI agent at spawn time.

Every CLI that has skills discovers them from directories, so the shape is
always the same: build a view directory of symlinks for this agent, then hand
the CLI that path in whatever way it accepts one. The per-vendor part — which
flag, which config key, which layout — is declared in each vendor's
``SkillsWiring`` spec rather than branched on here.

Two rules the vendor specs exist to keep:

- **The user's own skills are never displaced.** Managed names that collide
  with a native ``~/.claude/skills`` entry are dropped from the view, and a
  flag that replaces the CLI's own discovery (kimi's ``--skills-dir``) gets
  the discovery roots passed back alongside ours.
- **A spawn never breaks over skills.** Every failure path returns the command
  unchanged; the worst outcome is a pane without managed skills.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
import shutil
import tempfile
from pathlib import Path
from typing import Any

from agent_team_backend.applog import app_data_dir
from agent_team_backend.cli_vendors.base import SkillsWiring
from agent_team_backend.cli_vendors.registry import vendor
from agent_team_backend.skills_store import SkillsStore

log = logging.getLogger("agent_team_backend.plugins.builtin.navide_skills.skills_wiring")

VIEWS_DIR = "skills-views"
#: Shared with pane_home: a vendor that needs a shim for both MCP and skills
#: must end up with one, not two.
PANES_DIR_NAME = ".navide-panes"
#: Same guard pane_home applies — the lookahead rejects "." and ".." on their
#: own, which would otherwise resolve a shim onto a directory we do not own.
_SAFE_PANE_ID = re.compile(r"^(?!\.+$)[A-Za-z0-9_.:-]+$")


def views_root() -> Path:
    return app_data_dir() / "runtime" / VIEWS_DIR


def agent_view_root(agent_key: str) -> Path:
    return views_root() / agent_key


def skills_wiring(agent_key: str) -> SkillsWiring | None:
    spec = vendor(agent_key)
    return spec.skills_wiring if spec is not None else None


def prepare_view(
    agent_key: str,
    wiring: SkillsWiring,
    *,
    store: SkillsStore | None = None,
    native_root: Path | None = None,
    view_root: Path | None = None,
) -> Path | None:
    """Build this agent's view of the managed library, or None when empty.

    The view is rebuilt from scratch and swapped in atomically, so a removed
    or newly-targeted skill can never linger. Returns the path the CLI should
    be pointed at — the view root, with the vendor's required layout already
    materialised inside it.
    """
    try:
        view_root = view_root or agent_view_root(agent_key)
        sources = _managed_sources(agent_key, store, native_root)
        _replace_view(view_root, sources, wiring.view_layout)
        return view_root if sources else None
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Managed-skills view for %s failed: %s", agent_key, err)
        return None


def discovery_roots(wiring: SkillsWiring, cwd: str) -> list[Path]:
    """Roots the CLI would have discovered itself, for a replacing flag.

    Only existing directories are returned: passing a path the CLI would not
    have found is a behaviour change, not a restoration.
    """
    roots: list[Path] = []
    if not wiring.replaces_discovery:
        return roots
    try:
        home = Path.home()
    except (OSError, RuntimeError):
        home = None
    bases = [(home, wiring.discovery_home)]
    if cwd:
        bases.append((Path(cwd), wiring.discovery_project))
    for base, relatives in bases:
        if base is None:
            continue
        for relative in relatives:
            candidate = base.joinpath(*relative)
            try:
                if candidate.is_dir():
                    roots.append(candidate)
            except OSError:
                continue
    return roots


def flag_values(wiring: SkillsWiring, view: Path, cwd: str) -> list[str]:
    """Every path this CLI's flag should be repeated over."""
    leaf = view.joinpath(*wiring.view_layout)
    if wiring.flag_takes == "each":
        try:
            entries = sorted(leaf.iterdir(), key=lambda path: path.name)
        except OSError:
            return []
        paths = [str(entry) for entry in entries]
    else:
        paths = [str(leaf)]
    return paths + [str(root) for root in discovery_roots(wiring, cwd)]


def config_document(wiring: SkillsWiring, existing: str, view: Path) -> str:
    """``existing`` config document with our view added to its skills paths.

    The variable is shared with MCP wiring, so this merges into whatever is
    already there instead of replacing it, and keeps any path the user's own
    document already registered.
    """
    try:
        document = json.loads(existing) if existing.strip() else {}
    except json.JSONDecodeError:
        document = {}
    if not isinstance(document, dict):
        document = {}
    node: dict[str, Any] = document
    for step in wiring.config_paths_key[:-1]:
        child = node.get(step)
        child = dict(child) if isinstance(child, dict) else {}
        node[step] = child
        node = child
    leaf = wiring.config_paths_key[-1]
    current = node.get(leaf)
    paths = [item for item in current if isinstance(item, str)] if isinstance(current, list) else []
    target = str(view.joinpath(*wiring.view_layout))
    if target not in paths:
        paths.append(target)
    node[leaf] = paths
    return json.dumps(document)


def real_home() -> Path:
    """The user's home, read the way pane_home reads it.

    ``Path.home()`` prefers ``$HOME``, and launching Navide from inside a
    shimmed pane makes the backend inherit that pane's HOME — building a shim
    under it would mirror links to links.
    """
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (ImportError, AttributeError, KeyError, OSError):
        return Path.home()


def panes_root() -> Path:
    """Same tree pane_home uses, so a vendor needing both gets one shim."""
    return real_home() / PANES_DIR_NAME


def owns_its_shim(agent_key: str) -> bool:
    """Whether MCP wiring already builds this vendor's per-pane home.

    Those vendors are ridden, never created for: the MCP side skips its own
    work when the variable is already set, so creating the root here first
    would silently cost the pane its MCP server.
    """
    spec = vendor(agent_key)
    mcp = spec.mcp_wiring if spec is not None else None
    return bool(mcp is not None and mcp.config_dir)


def prepare_root(
    agent_key: str,
    wiring: SkillsWiring,
    pane_id: str,
    env: dict[str, str],
    *,
    store: SkillsStore | None = None,
    native_root: Path | None = None,
    home: Path | None = None,
) -> str | None:
    """Materialise this CLI's own skills directory inside a per-pane root.

    The root mirrors the real one entry by entry, so the pane keeps every
    credential, session and setting the user has; only the skills directory on
    the way down is rebuilt as ours. Returns the value ``root_env`` should
    carry, or None when nothing should be wired.
    """
    if not _SAFE_PANE_ID.match(pane_id or ""):
        return None
    try:
        home = home or real_home()
        existing = env.get(wiring.root_env)
        if existing:
            root = Path(existing)
            # Someone else's shim: it does its own reconciliation, and a
            # directory *it* built (its MCP config dir) is not ours to move
            # into the user's home just because the name is free there.
            ours = False
        elif owns_its_shim(agent_key):
            # MCP builds this vendor's shim; without it there is nowhere safe
            # to put the directory, and creating one would displace MCP.
            return None
        else:
            root = panes_root() / agent_key / pane_id
            ours = True
        real_root = home.joinpath(*wiring.root_home)
        sources = _managed_sources(agent_key, store, native_root)
        suppressed = [home.joinpath(*rel) for rel in wiring.discovery_home]
        _materialise(root, real_root, wiring.skills_rel, sources, suppressed, adopt=ours)
        return str(root)
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Managed-skills root for %s failed: %s", agent_key, err)
        return None


def sync_project_dir(
    agent_key: str,
    wiring: SkillsWiring,
    cwd: str,
    *,
    store: SkillsStore | None = None,
    native_root: Path | None = None,
) -> bool:
    """Keep our links in the workspace's skill directory up to date.

    The last-resort surface, for a CLI with no relocation variable: the
    directory belongs to the user's repository, so only links that point into
    our own view tree are ever written or removed. Anything else found there
    is the user's and is left untouched.
    """
    if not cwd:
        return False
    try:
        target = Path(cwd).joinpath(*wiring.project_rel)
        sources = _managed_sources(agent_key, store, native_root)
        managed_root = _managed_root(store)
        if not sources and not target.is_dir():
            return False
        target.mkdir(parents=True, exist_ok=True)
        wanted = {source.name: source for source in sources}
        for entry in target.iterdir():
            if entry.name in wanted:
                continue
            if _points_into(entry, managed_root):
                entry.unlink(missing_ok=True)
        for name, source in wanted.items():
            link = target / name
            if link.is_symlink():
                if _resolve(link) == _resolve(source):
                    continue
                if not _points_into(link, managed_root):
                    continue  # the user's own link wins
                link.unlink(missing_ok=True)
            elif link.exists():
                continue  # a real directory here is the user's skill
            link.symlink_to(source, target_is_directory=True)
        _exclude_from_git(target)
        return bool(sources)
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Managed-skills project directory for %s failed: %s", agent_key, err)
        return False


def wire_command(
    agent_key: str,
    command: Any,
    _port: int | None,
    pane_id: str = "",
    env: dict[str, str] | None = None,
    cwd: str = "",
) -> Any:
    """Point one pane spawn at the managed skills library.

    No-op for a CLI with no skills wiring, an empty command, a spawn already
    carrying our view, or a library with nothing targeted at this agent.
    """
    wiring = skills_wiring(agent_key)
    if wiring is None:
        return command
    text = _command_text(command)
    if not text.strip():
        return command
    if wiring.root_env:
        if env is not None:
            root = prepare_root(agent_key, wiring, pane_id, env)
            if root is not None:
                env[wiring.root_env] = root
        return command
    if wiring.project_rel:
        sync_project_dir(agent_key, wiring, cwd)
        return command
    try:
        view = prepare_view(agent_key, wiring)
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Managed-skills wiring for %s failed: %s", agent_key, err)
        return command
    if view is None:
        return command
    if wiring.config_env:
        if env is not None:
            env[wiring.config_env] = config_document(
                wiring, env.get(wiring.config_env, ""), view
            )
        return command
    if not wiring.flag or str(view) in text:
        return command
    suffix = " ".join(
        f"{wiring.flag} {shlex.quote(value)}" for value in flag_values(wiring, view, cwd)
    )
    return _append_to_command(command, suffix) if suffix else command


def _managed_root(store: SkillsStore | None) -> Path:
    return (store or SkillsStore()).runtime_root


def _managed_sources(
    agent_key: str,
    store: SkillsStore | None,
    native_root: Path | None,
) -> list[Path]:
    """Enabled skills targeted at this agent, minus native-name collisions."""
    store = store or SkillsStore()
    managed_root = store.rebuild_runtime_projection()
    native_root = native_root or (Path.home() / ".claude" / "skills")
    native_names = _directory_names(native_root)
    sources = [
        managed_root / name
        for name in store.targets_for(agent_key)
        if name not in native_names
    ]
    return [source for source in sources if source.is_dir() or source.is_symlink()]


def _materialise(
    root: Path,
    real_root: Path,
    skills_rel: tuple[str, ...],
    sources: list[Path],
    suppressed: list[Path] | None = None,
    *,
    adopt: bool = True,
) -> None:
    """Rebuild only the skills directory inside ``root``; mirror the rest.

    Every level on the way down is a real directory whose other entries are
    links back to the user's, so a pane sees its own skills view and the
    user's everything-else.

    ``suppressed`` are roots the CLI scans only while the variable is unset —
    relocating it would silently cost the user those skills, so their contents
    are linked into the leaf as well. Verified on copilot: with COPILOT_HOME
    set, ``~/.agents/skills`` stops being scanned.
    """
    root.mkdir(parents=True, exist_ok=True)
    src, dst = real_root, root
    for name in skills_rel:
        # adopt on the way down only: a real entry the CLI created in the shim
        # (a fresh login, a new session dir) belongs in the user's tree, not
        # trapped in one pane. The leaf below is ours and is never adopted —
        # that would copy managed links into the user's own skills directory.
        _mirror_into(dst, src, skip={name}, adopt=adopt)
        src, dst = src / name, dst / name
        # Only the leaf may be ours, and every level above it must be a real
        # directory of our own. A link here — left by an MCP shim that mirrored
        # the whole home — would make every write below reach through into the
        # user's real tree, planting managed links in their own skills folder.
        if dst.is_symlink():
            dst.unlink()
        dst.mkdir(parents=True, exist_ok=True)
    # The user's own skills in that directory keep working, and keep winning:
    # they are linked first and a managed name never replaces one.
    _mirror_into(dst, src, skip=set())
    for extra in suppressed or []:
        _mirror_into(dst, extra, skip=set())
    for source in sources:
        link = dst / source.name
        if link.exists() or link.is_symlink():
            continue
        link.symlink_to(source, target_is_directory=True)


def _mirror_into(dst: Path, src: Path, *, skip: set[str], adopt: bool = False) -> None:
    """Link every entry of ``src`` into ``dst``, minus ``skip``.

    Re-run on every spawn: links whose target is gone are dropped first, so a
    dangling one can never shadow a name the CLI wants to create, and — where
    ``adopt`` is set — real entries the CLI made in the shim are moved back
    into ``src`` so they are shared with every other pane instead of living
    and dying in this one.
    """
    dst.mkdir(parents=True, exist_ok=True)
    for entry in dst.iterdir():
        if entry.is_symlink() and not entry.exists():
            entry.unlink(missing_ok=True)
            continue
        # A name on the way to our leaf is a directory we built, not something
        # the CLI left behind — adopting it would try to push our own view into
        # the user's tree on every spawn.
        if adopt and not entry.is_symlink() and entry.name not in skip:
            _adopt(entry, src / entry.name)
    if not src.is_dir():
        return
    for entry in src.iterdir():
        if entry.name in skip:
            continue
        link = dst / entry.name
        if link.exists() or link.is_symlink():
            continue
        link.symlink_to(entry, target_is_directory=entry.is_dir())


def _adopt(entry: Path, target: Path) -> None:
    """Move a real entry out of the shim and into the user's tree.

    A name that exists on both sides is a genuine conflict: the shim copy is
    left where it is rather than overwriting the user's, and reported.
    """
    if target.exists() or target.is_symlink():
        log.warning("%s exists in both the shim and the real tree; keeping the shim copy", target)
        return
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(entry, target)
    except OSError as err:
        log.warning("could not adopt %s into %s: %s", entry, target, err)


def _resolve(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path


def _points_into(entry: Path, root: Path) -> bool:
    """Whether ``entry`` is a link we planted (a link into our view tree).

    The containment check is what keeps the workspace surface safe: a link the
    user made, or a real directory, is never ours to remove.
    """
    if not entry.is_symlink():
        return False
    try:
        _resolve(entry).relative_to(_resolve(root))
    except ValueError:
        return False
    return True


def _exclude_from_git(target: Path) -> None:
    """Keep our links out of the user's git status, best effort."""
    root = target
    for candidate in [target, *target.parents]:
        if (candidate / ".git").is_dir():
            root = candidate
            break
    else:
        return
    exclude = root / ".git" / "info" / "exclude"
    try:
        rel = target.relative_to(root).as_posix()
    except ValueError:
        return
    line = f"/{rel}/"
    try:
        existing = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
        if line in existing.splitlines():
            return
        exclude.parent.mkdir(parents=True, exist_ok=True)
        prefix = "" if not existing or existing.endswith("\n") else "\n"
        with exclude.open("a", encoding="utf-8") as handle:
            handle.write(f"{prefix}{line}\n")
    except OSError as err:
        log.warning("could not add %s to git exclude: %s", target, err)


def _replace_view(view_root: Path, sources: list[Path], layout: tuple[str, ...]) -> None:
    parent = view_root.parent
    parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{view_root.name}-", dir=parent))
    backup = parent / f".{view_root.name}.old"
    try:
        leaf = tmp.joinpath(*layout) if layout else tmp
        leaf.mkdir(parents=True, exist_ok=True)
        for source in sources:
            (leaf / source.name).symlink_to(source, target_is_directory=True)
        if backup.exists() or backup.is_symlink():
            _remove_generated_path(backup)
        if view_root.exists() or view_root.is_symlink():
            os.replace(view_root, backup)
        os.replace(tmp, view_root)
        if backup.exists() or backup.is_symlink():
            _remove_generated_path(backup)
    except Exception:
        _remove_generated_path(tmp)
        if not view_root.exists() and backup.exists():
            os.replace(backup, view_root)
        raise


def _directory_names(root: Path) -> set[str]:
    if not root.is_dir():
        return set()
    return {
        entry.name
        for entry in root.iterdir()
        if entry.is_dir() or entry.is_file() or entry.is_symlink()
    }


def _command_text(command: Any) -> str:
    if isinstance(command, list):
        return str(command[-1]) if command else ""
    return str(command or "")


def _append_to_command(command: Any, suffix: str) -> Any:
    if isinstance(command, list):
        updated = list(command)
        updated[-1] = f"{updated[-1]} {suffix}"
        return updated
    return f"{command} {suffix}"


def _remove_generated_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)
