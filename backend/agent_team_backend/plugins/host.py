"""Plugin host: load, activate, deactivate and unload backend plugins.

This is the loader skeleton that sits on top of the manifest module. It takes a
plugin directory, validates the manifest, checks host-API compatibility, imports
the plugin's backend entry module, and drives a small lifecycle:

    load -> activate -> deactivate -> unload

Load and activate are deliberately separate: ``load`` only reads the manifest and
imports the backend module; ``activate`` is what invokes the plugin's own
``activate(context)`` hook. This mirrors how VS Code separates registration from
activation.

Capabilities (fs/git/terminal access granted per ``manifest.requires``) are
granted at load time, before activation: :meth:`PluginHost.load` calls
``_grant_capabilities`` to populate :attr:`PluginContext.capabilities` with only
the capability objects the plugin declared. See :mod:`.capabilities`.

Backend entry convention
------------------------
A plugin directory must contain:

* ``plugin.json`` -- the manifest (see :mod:`.manifest`).
* ``backend.py``  -- the backend entry module. Optional hooks:
    - ``activate(context)`` -- called on :meth:`PluginHost.activate`.
    - ``deactivate()``      -- called on :meth:`PluginHost.deactivate`.

The fixed ``backend.py`` filename keeps the manifest untouched (its ``entry``
field addresses the *frontend* bundle). If ``backend.py`` is missing, load fails.
"""

from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from packaging.version import InvalidVersion, Version

from .capabilities import build_capabilities
from .manifest import Manifest, ManifestError, load_manifest

# Version of the API this host exposes to plugins. A plugin declares the host
# version it targets via ``engines.navide`` in its manifest; load rejects a
# plugin whose requirement is not satisfied by this value.
HOST_API_VERSION = "0.1.0"

# Manifest filename and backend entry filename expected inside a plugin dir.
_MANIFEST_FILENAME = "plugin.json"
_BACKEND_ENTRY_FILENAME = "backend.py"

# Manifest engines key naming the host API a plugin targets.
_ENGINE_KEY = "navide"

# Import namespace for loaded backend modules, keyed by a sanitized plugin id.
_MODULE_PREFIX = "agent_team_backend._plugin_runtime."


class PluginError(Exception):
    """Raised when a plugin cannot be loaded, activated, or managed."""


@dataclass
class RegisteredRoute:
    """An HTTP route a plugin contributes: a raw ASGI app served at ``path``."""

    path: str
    asgi_app: Any
    methods: list[str]


@dataclass
class PluginContext:
    """What a plugin receives on activation.

    Minimal for now: identity via ``manifest`` and its on-disk ``plugin_dir``.

    ``capabilities`` maps a granted namespace (``"fs"``/``"git"``/``"terminal"``)
    to its capability object. The host fills this at load time from
    ``manifest.requires`` (see :func:`.capabilities.build_capabilities`), so a
    plugin only finds the capabilities it declared -- and nothing it did not.

    The ``register_*`` methods are how an ``activate(context)`` hook plugs into
    the backend without app.py knowing the plugin: HTTP routes, startup/shutdown
    hooks (sync or async), and pane spawn-command transformers. The wiring layer
    aggregates and applies them (see :mod:`.wiring`); registrations are cleared
    on deactivate.
    """

    manifest: Manifest
    plugin_dir: Path
    capabilities: dict[str, Any] = field(default_factory=dict)
    routes: list[RegisteredRoute] = field(default_factory=list)
    startup_hooks: list[Callable[[], Any]] = field(default_factory=list)
    shutdown_hooks: list[Callable[[], Any]] = field(default_factory=list)
    spawn_transformers: list[Callable[..., Any]] = field(default_factory=list)
    mcp_tool_installers: list[Callable[[Any], Any]] = field(default_factory=list)

    def register_route(self, path: str, asgi_app: Any, methods: list[str]) -> None:
        """Ask the host to serve ``asgi_app`` (raw ASGI) at ``path``."""
        self.routes.append(
            RegisteredRoute(path=path, asgi_app=asgi_app, methods=list(methods))
        )

    def register_startup(self, hook: Callable[[], Any]) -> None:
        """Register a callable (sync or async) run at backend startup."""
        self.startup_hooks.append(hook)

    def register_shutdown(self, hook: Callable[[], Any]) -> None:
        """Register a callable (sync or async) run at backend shutdown."""
        self.shutdown_hooks.append(hook)

    def register_spawn_transformer(self, transformer: Callable[..., Any]) -> None:
        """Register a ``(agent_key, command, port, pane_id, env) -> command``
        transformer applied to pane spawn commands at terminal.create time.

        ``env`` is the spawn environment and is mutated in place; the return
        value is the command. Transformers declaring fewer positional
        parameters keep being called with the older shapes they were written
        against (see plugins.wiring._call_transformer), so the signature is
        untyped here.
        """
        self.spawn_transformers.append(transformer)

    def register_mcp_tools(self, installer: Callable[[Any], Any]) -> None:
        """Register a callable that adds this plugin's tools to the core MCP server.

        The installer is handed the core ``FastMCP`` server and decorates its
        own tool functions onto it. This is the one way a plugin contributes to
        a service core owns rather than serving its own — a route gives a
        plugin a whole new endpoint, which is the wrong shape for tools that
        must appear in the same tool list as core's.

        Timing matters: installers run after every plugin is activated and
        before the server's session manager is built, so a plugin's tools are
        in the list every client sees. A tool registered later would be
        invisible to already-connected clients with no error anywhere.
        """
        self.mcp_tool_installers.append(installer)

    def clear_registrations(self) -> None:
        """Drop everything registered during activation (used on deactivate)."""
        self.routes.clear()
        self.startup_hooks.clear()
        self.shutdown_hooks.clear()
        self.spawn_transformers.clear()
        self.mcp_tool_installers.clear()


@dataclass
class LoadedPlugin:
    """A plugin the host has loaded, plus its lifecycle state."""

    manifest: Manifest
    module: Any  # the imported backend entry module
    context: PluginContext
    activated: bool = False


class PluginHost:
    """Loads and drives the lifecycle of backend plugins."""

    def __init__(self) -> None:
        self._loaded: dict[str, LoadedPlugin] = {}

    def load(self, plugin_dir: str | Path) -> LoadedPlugin:
        """Validate, check compatibility, and import a plugin's backend module.

        Does NOT activate the plugin. Raises :class:`PluginError` on any failure
        (bad/incompatible manifest, duplicate id, missing backend entry, import
        error).
        """
        directory = Path(plugin_dir)
        try:
            manifest = load_manifest(directory / _MANIFEST_FILENAME)
        except ManifestError as err:
            raise PluginError(f"invalid plugin manifest in {directory}: {err}") from err

        if manifest.id in self._loaded:
            raise PluginError(f"plugin {manifest.id!r} is already loaded")

        self._check_engine_compatibility(manifest)

        module = self._import_backend_module(manifest, directory)
        context = PluginContext(manifest=manifest, plugin_dir=directory)
        self._grant_capabilities(context)
        loaded = LoadedPlugin(manifest=manifest, module=module, context=context)
        self._loaded[manifest.id] = loaded
        return loaded

    def activate(self, plugin_id: str) -> None:
        """Invoke the plugin's ``activate(context)`` hook (idempotent).

        A no-op if the plugin is already activated. Raises :class:`PluginError`
        if the plugin is not loaded or its ``activate`` hook raises.
        """
        loaded = self._require_loaded(plugin_id)
        if loaded.activated:
            return

        hook = getattr(loaded.module, "activate", None)
        if callable(hook):
            try:
                hook(loaded.context)
            except Exception as err:  # noqa: BLE001 - surface any plugin failure
                raise PluginError(
                    f"plugin {plugin_id!r} failed to activate: {err}"
                ) from err
        loaded.activated = True

    def deactivate(self, plugin_id: str) -> None:
        """Invoke the plugin's ``deactivate()`` hook (idempotent).

        A no-op if the plugin is not currently activated. Raises
        :class:`PluginError` if the plugin is not loaded or its ``deactivate``
        hook raises.
        """
        loaded = self._require_loaded(plugin_id)
        if not loaded.activated:
            return

        hook = getattr(loaded.module, "deactivate", None)
        if callable(hook):
            try:
                hook()
            except Exception as err:  # noqa: BLE001 - surface any plugin failure
                raise PluginError(
                    f"plugin {plugin_id!r} failed to deactivate: {err}"
                ) from err
        loaded.activated = False
        loaded.context.clear_registrations()

    def unload(self, plugin_id: str) -> None:
        """Deactivate (if needed) and remove the plugin from the host."""
        loaded = self._require_loaded(plugin_id)
        if loaded.activated:
            self.deactivate(plugin_id)
        del self._loaded[plugin_id]
        sys.modules.pop(_module_name(plugin_id), None)

    def get(self, plugin_id: str) -> LoadedPlugin | None:
        """Return the loaded plugin for ``plugin_id``, or ``None``."""
        return self._loaded.get(plugin_id)

    def list_loaded(self) -> list[Manifest]:
        """Return the manifests of all currently loaded plugins."""
        return [loaded.manifest for loaded in self._loaded.values()]

    # -- aggregates over activated plugins (applied by the wiring layer) ----

    def registered_routes(self) -> list[RegisteredRoute]:
        """Routes contributed by currently activated plugins, in load order."""
        return [route for lp in self._activated() for route in lp.context.routes]

    def registered_mcp_tool_installers(self) -> list[tuple[str, Callable[[Any], Any]]]:
        """``(plugin_id, installer)`` pairs from activated plugins, in load order."""
        return [
            (lp.manifest.id, installer)
            for lp in self._activated()
            for installer in lp.context.mcp_tool_installers
        ]

    def startup_hooks(self) -> list[tuple[str, Callable[[], Any]]]:
        """``(plugin_id, hook)`` pairs from activated plugins, in load order."""
        return [
            (lp.manifest.id, hook)
            for lp in self._activated()
            for hook in lp.context.startup_hooks
        ]

    def shutdown_hooks(self) -> list[tuple[str, Callable[[], Any]]]:
        """``(plugin_id, hook)`` pairs from activated plugins, in load order."""
        return [
            (lp.manifest.id, hook)
            for lp in self._activated()
            for hook in lp.context.shutdown_hooks
        ]

    def spawn_transformers(self) -> list[tuple[str, Callable[..., Any]]]:
        """``(plugin_id, transformer)`` pairs from activated plugins."""
        return [
            (lp.manifest.id, transformer)
            for lp in self._activated()
            for transformer in lp.context.spawn_transformers
        ]

    # -- internals ---------------------------------------------------------

    def _activated(self) -> list[LoadedPlugin]:
        return [lp for lp in self._loaded.values() if lp.activated]

    def _grant_capabilities(self, context: PluginContext) -> None:
        """Populate ``context.capabilities`` per the manifest's declared needs.

        Authorization is exactly ``manifest.requires``: only declared namespaces
        get a capability object; anything else is simply absent.
        """
        context.capabilities = build_capabilities(context.manifest.requires)

    def _require_loaded(self, plugin_id: str) -> LoadedPlugin:
        loaded = self._loaded.get(plugin_id)
        if loaded is None:
            raise PluginError(f"plugin {plugin_id!r} is not loaded")
        return loaded

    def _check_engine_compatibility(self, manifest: Manifest) -> None:
        requirement = manifest.engines.get(_ENGINE_KEY)
        if requirement is None:
            raise PluginError(
                f"plugin {manifest.id!r} does not declare an "
                f"'engines.{_ENGINE_KEY}' host requirement"
            )
        try:
            compatible = _engine_satisfied(requirement, HOST_API_VERSION)
        except InvalidVersion as err:
            raise PluginError(
                f"plugin {manifest.id!r} has an unparseable "
                f"engines.{_ENGINE_KEY} requirement {requirement!r}: {err}"
            ) from err
        if not compatible:
            raise PluginError(
                f"plugin {manifest.id!r} requires host API {requirement!r} "
                f"but this host is {HOST_API_VERSION}"
            )

    def _import_backend_module(self, manifest: Manifest, directory: Path) -> Any:
        entry_path = directory / _BACKEND_ENTRY_FILENAME
        if not entry_path.is_file():
            raise PluginError(
                f"plugin {manifest.id!r} is missing its backend entry "
                f"{_BACKEND_ENTRY_FILENAME!r} in {directory}"
            )
        module_name = _module_name(manifest.id)
        spec = importlib.util.spec_from_file_location(module_name, entry_path)
        if spec is None or spec.loader is None:
            raise PluginError(
                f"could not create import spec for plugin {manifest.id!r} "
                f"at {entry_path}"
            )
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as err:  # noqa: BLE001 - surface any import-time failure
            sys.modules.pop(module_name, None)
            raise PluginError(
                f"plugin {manifest.id!r} backend entry failed to import: {err}"
            ) from err
        return module


def _module_name(plugin_id: str) -> str:
    sanitized = plugin_id.replace(".", "_").replace("-", "_")
    return f"{_MODULE_PREFIX}{sanitized}"


def _engine_satisfied(requirement: str, host_version: str) -> bool:
    """Return whether ``host_version`` satisfies an npm-style ``requirement``.

    Supports a caret range (``^MAJOR.MINOR.PATCH``) and a plain exact version.
    Caret upper bound follows npm semver: it is fixed by the left-most non-zero
    component (``^1.2.3`` -> ``<2.0.0``; ``^0.2.3`` -> ``<0.3.0``;
    ``^0.0.3`` -> ``<0.0.4``).
    """
    host = Version(host_version)
    spec = requirement.strip()
    if spec.startswith("^"):
        base = Version(spec[1:])
        return base <= host < _caret_upper_bound(base)
    return host == Version(spec)


def _caret_upper_bound(base: Version) -> Version:
    release = base.release + (0, 0, 0)
    major, minor, patch = release[0], release[1], release[2]
    if major > 0:
        return Version(f"{major + 1}.0.0")
    if minor > 0:
        return Version(f"0.{minor + 1}.0")
    return Version(f"0.0.{patch + 1}")
