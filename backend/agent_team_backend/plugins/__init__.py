"""Plugin infrastructure for decoupling the mini-IDE (and future plugins).

The manifest module defines how a plugin describes itself; the host loader
(a later step) consumes those manifests to mount capabilities.
"""

from __future__ import annotations

from .host import (
    HOST_API_VERSION,
    LoadedPlugin,
    PluginContext,
    PluginError,
    PluginHost,
    RegisteredRoute,
)
from .manifest import (
    KNOWN_CAPABILITIES,
    Manifest,
    ManifestError,
    load_manifest,
    parse_manifest,
)

__all__ = [
    "HOST_API_VERSION",
    "KNOWN_CAPABILITIES",
    "LoadedPlugin",
    "Manifest",
    "ManifestError",
    "PluginContext",
    "PluginError",
    "PluginHost",
    "RegisteredRoute",
    "load_manifest",
    "parse_manifest",
]
