"""Wire the plugin host into backend startup/shutdown.

Discovers backend plugin directories (the bundled ``builtin/`` dir plus
``AGENT_TEAM_PLUGINS_DIR``), loads them into a :class:`PluginHost`, activates
the ones declaring ``onStartup``, and tears everything down on shutdown. Also
applies what activated plugins registered on their context: HTTP routes,
startup/shutdown hooks, and pane spawn-command transformers. Pure-function
module; app.py calls into it inside guarded blocks. Every per-plugin failure
is isolated: one broken plugin must never block the others or backend startup.
"""

from __future__ import annotations

import inspect
import logging
import os
from pathlib import Path
from typing import Any

from ..applog import backend_port_file
from .host import PluginHost

log = logging.getLogger("agent_team_backend.plugins.wiring")

PLUGINS_DIR_ENV = "AGENT_TEAM_PLUGINS_DIR"


def builtin_plugins_root() -> Path:
    """Bundled builtin plugins directory (ships inside the package)."""
    return Path(__file__).parent / "builtin"


def plugins_root() -> Path | None:
    """Plugins root directory from the environment (absent/empty -> None)."""
    raw = os.environ.get(PLUGINS_DIR_ENV, "").strip()
    return Path(raw) if raw else None


def discover_backend_plugin_dirs(root: Path) -> list[Path]:
    """Direct child dirs of ``root`` containing both plugin.json and backend.py.

    A dir with only ``manifest.json`` is a frontend-only install package and
    is skipped. A nonexistent root yields ``[]``.
    """
    if not root.is_dir():
        return []
    dirs: list[Path] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        if (child / "plugin.json").is_file() and (child / "backend.py").is_file():
            dirs.append(child)
        elif (child / "manifest.json").is_file():
            log.debug("skipping frontend-only plugin dir %s", child)
    return dirs


def startup(host: PluginHost, root: Path | None = None) -> list[str]:
    """Load every discovered plugin and activate the ``onStartup`` ones.

    With no explicit ``root``, scans the bundled builtin dir first, then the
    external ``AGENT_TEAM_PLUGINS_DIR`` (env absent -> builtin only). An
    explicit ``root`` scans exactly that directory. Per-plugin failures are
    logged and isolated; a plugin whose activation fails is unloaded again so
    no half-started state lingers. Returns the ids of the plugins successfully
    activated.
    """
    if root is not None:
        roots = [root]
    else:
        roots = [builtin_plugins_root()]
        external = plugins_root()
        if external is None:
            log.info(
                "%s not set; skipping external backend plugin discovery",
                PLUGINS_DIR_ENV,
            )
        else:
            roots.append(external)
    activated: list[str] = []
    for directory in (d for r in roots for d in discover_backend_plugin_dirs(r)):
        try:
            loaded = host.load(directory)
        except Exception as err:  # noqa: BLE001 - isolate broken plugins
            log.warning("failed to load plugin from %s: %s", directory, err)
            continue
        plugin_id = loaded.manifest.id
        log.info("loaded backend plugin %s from %s", plugin_id, directory)
        if "onStartup" not in loaded.manifest.activationEvents:
            continue
        try:
            host.activate(plugin_id)
        except Exception as err:  # noqa: BLE001 - isolate broken plugins
            log.warning("failed to activate plugin %s: %s", plugin_id, err)
            try:
                host.unload(plugin_id)
            except Exception as unload_err:  # noqa: BLE001
                log.warning(
                    "failed to unload plugin %s after activation failure: %s",
                    plugin_id,
                    unload_err,
                )
            continue
        activated.append(plugin_id)
    return activated


def shutdown(host: PluginHost) -> None:
    """Deactivate and unload every plugin, isolating per-plugin failures.

    ``host.unload()`` re-runs deactivate for an activated plugin, and a
    raising deactivate hook leaves ``activated`` True -- which would make
    unload raise again. So: deactivate first, force the flag off on failure,
    then unload.
    """
    for manifest in list(host.list_loaded()):
        plugin_id = manifest.id
        try:
            host.deactivate(plugin_id)
        except Exception as err:  # noqa: BLE001 - isolate broken plugins
            log.warning("plugin %s failed to deactivate: %s", plugin_id, err)
            loaded = host.get(plugin_id)
            if loaded is not None:
                loaded.activated = False
        try:
            host.unload(plugin_id)
        except Exception as err:  # noqa: BLE001 - isolate broken plugins
            log.warning("plugin %s failed to unload: %s", plugin_id, err)


# -- application of plugin registrations (routes, hooks, spawn wiring) --------


def apply_routes(host: PluginHost, router: Any) -> None:
    """Append every plugin-registered route to the app router.

    Uses a Route (raw ASGI endpoint) instead of a Mount so the slashless path
    is served directly — a Mount would 307-redirect it.
    """
    from starlette.routing import Route

    for registered in host.registered_routes():
        try:
            router.routes.append(
                Route(
                    registered.path,
                    endpoint=registered.asgi_app,
                    methods=registered.methods,
                )
            )
        except Exception as err:  # noqa: BLE001 - isolate broken plugins
            log.warning("failed to mount plugin route %s: %s", registered.path, err)


async def _run_hooks(pairs: list, kind: str) -> None:
    for plugin_id, hook in pairs:
        try:
            result = hook()
            if inspect.isawaitable(result):
                await result
        except Exception as err:  # noqa: BLE001 - isolate broken plugins
            log.warning("plugin %s %s hook failed: %s", plugin_id, kind, err)


async def run_startup_hooks(host: PluginHost) -> None:
    """Run every registered startup hook, isolating per-hook failures."""
    await _run_hooks(host.startup_hooks(), "startup")


async def run_shutdown_hooks(host: PluginHost) -> None:
    """Run every registered shutdown hook, isolating per-hook failures."""
    await _run_hooks(host.shutdown_hooks(), "shutdown")


def backend_port() -> int | None:
    """Current backend port from the discovery file (absent/invalid -> None)."""
    try:
        text = backend_port_file().read_text(encoding="utf-8").strip()
        return int(text) if text else None
    except (OSError, ValueError):
        return None


def _call_transformer(
    transformer: Any, agent_key: str, command: Any, port: int | None, pane_id: str
) -> Any:
    """Call a spawn transformer, tolerating the pre-pane_id 3-argument shape.

    Third-party plugins were written against the older contract; passing them a
    fourth argument would raise TypeError, which the caller swallows as "broken
    plugin" — their wiring would stop applying with only a log line to show for
    it.
    """
    try:
        params = list(inspect.signature(transformer).parameters.values())
    except (TypeError, ValueError):
        params = []
    takes_varargs = any(p.kind is inspect.Parameter.VAR_POSITIONAL for p in params)
    if params and len(params) < 4 and not takes_varargs:
        return transformer(agent_key, command, port)
    return transformer(agent_key, command, port, pane_id)


def apply_spawn_wiring(
    host: PluginHost, agent_key: str, command: Any, pane_id: str = ""
) -> Any:
    """Run every plugin spawn transformer over a pane spawn command.

    Each transformer is called as ``(agent_key, command, port, pane_id)`` and
    returns the (possibly unchanged) command; ``port`` is the backend's current
    HTTP port from the discovery file (None when unknown), and ``pane_id``
    identifies the pane being spawned so a plugin can hand the CLI a
    pane-specific endpoint. A failing transformer is skipped — a spawn must
    never break over plugin wiring.
    """
    port = backend_port()
    for plugin_id, transformer in host.spawn_transformers():
        try:
            command = _call_transformer(transformer, agent_key, command, port, pane_id)
        except Exception as err:  # noqa: BLE001 - isolate broken plugins
            log.warning("plugin %s spawn transformer failed: %s", plugin_id, err)
    return command
