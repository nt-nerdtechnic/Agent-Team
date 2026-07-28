"""Plugin wiring tests: discovery, batch startup/shutdown, failure isolation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.plugins import wiring
from agent_team_backend.plugins.host import PluginHost

TRACKING_BACKEND = """
calls = []


def activate(context):
    calls.append("activate")


def deactivate():
    calls.append("deactivate")
"""

BAD_DEACTIVATE_BACKEND = """
def activate(context):
    pass


def deactivate():
    raise RuntimeError("deactivate boom")
"""


def _manifest(plugin_id: str, activation: list[str] | None = None) -> dict:
    publisher, name = plugin_id.split(".", 1)
    return {
        "id": plugin_id,
        "name": name,
        "version": "0.1.0",
        "publisher": publisher,
        "engines": {"navide": "^0.1.0"},
        "activationEvents": activation or [],
    }


def _write_plugin(
    directory: Path, manifest: dict, backend: str = TRACKING_BACKEND
) -> Path:
    """Materialize a plugin dir with a manifest and a backend.py."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    (directory / "backend.py").write_text(backend, encoding="utf-8")
    return directory


# -- plugins_root / discovery ---------------------------------------------


def test_plugins_root_env_absent_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(wiring.PLUGINS_DIR_ENV, raising=False)
    assert wiring.plugins_root() is None
    # startup with no env still boots the bundled builtin plugins.
    host = PluginHost()
    assert wiring.startup(host) == ["navide.plans", "navide.skills"]
    wiring.shutdown(host)

    monkeypatch.setenv(wiring.PLUGINS_DIR_ENV, "  ")
    assert wiring.plugins_root() is None


def test_discover_skips_frontend_only_dirs(tmp_path: Path) -> None:
    full = _write_plugin(tmp_path / "full", _manifest("pub.full"))

    frontend_only = tmp_path / "frontend-only"
    frontend_only.mkdir()
    (frontend_only / "manifest.json").write_text("{}", encoding="utf-8")

    no_backend = tmp_path / "no-backend"
    no_backend.mkdir()
    (no_backend / "plugin.json").write_text(
        json.dumps(_manifest("pub.nobackend")), encoding="utf-8"
    )

    (tmp_path / "stray.txt").write_text("not a plugin", encoding="utf-8")

    assert wiring.discover_backend_plugin_dirs(tmp_path) == [full]


def test_discover_nonexistent_root(tmp_path: Path) -> None:
    assert wiring.discover_backend_plugin_dirs(tmp_path / "nope") == []


# -- startup ----------------------------------------------------------------


def test_startup_activates_onstartup_only(tmp_path: Path) -> None:
    _write_plugin(tmp_path / "auto", _manifest("pub.auto", ["onStartup"]))
    _write_plugin(tmp_path / "lazy", _manifest("pub.lazy"))

    host = PluginHost()
    activated = wiring.startup(host, tmp_path)

    assert activated == ["pub.auto"]
    assert host.get("pub.auto").activated is True
    # The lazy plugin is loaded (registered) but not activated.
    lazy = host.get("pub.lazy")
    assert lazy is not None
    assert lazy.activated is False


def test_startup_isolates_broken_manifest(tmp_path: Path) -> None:
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "plugin.json").write_text("not json", encoding="utf-8")
    (broken / "backend.py").write_text("", encoding="utf-8")
    _write_plugin(tmp_path / "good", _manifest("pub.good", ["onStartup"]))

    host = PluginHost()
    activated = wiring.startup(host, tmp_path)

    assert activated == ["pub.good"]
    assert [m.id for m in host.list_loaded()] == ["pub.good"]


def test_startup_isolates_activate_failure_and_unloads(tmp_path: Path) -> None:
    _write_plugin(
        tmp_path / "explodes",
        _manifest("pub.explodes", ["onStartup"]),
        backend="def activate(context):\n    raise RuntimeError('boom')\n",
    )
    _write_plugin(tmp_path / "good", _manifest("pub.good", ["onStartup"]))

    host = PluginHost()
    activated = wiring.startup(host, tmp_path)

    assert activated == ["pub.good"]
    # The failed plugin was rolled back, not left half-started.
    assert host.get("pub.explodes") is None
    assert [m.id for m in host.list_loaded()] == ["pub.good"]


def test_startup_isolates_import_failure(tmp_path: Path) -> None:
    _write_plugin(
        tmp_path / "cursed",
        _manifest("pub.cursed", ["onStartup"]),
        backend="raise RuntimeError('import boom')\n",
    )
    _write_plugin(tmp_path / "good", _manifest("pub.good", ["onStartup"]))

    host = PluginHost()
    activated = wiring.startup(host, tmp_path)

    assert activated == ["pub.good"]
    assert host.get("pub.cursed") is None


def test_duplicate_id_first_wins(tmp_path: Path) -> None:
    first = _write_plugin(tmp_path / "a-first", _manifest("pub.dupe", ["onStartup"]))
    _write_plugin(tmp_path / "b-second", _manifest("pub.dupe", ["onStartup"]))

    host = PluginHost()
    activated = wiring.startup(host, tmp_path)

    assert activated == ["pub.dupe"]
    assert host.get("pub.dupe").context.plugin_dir == first


# -- shutdown ----------------------------------------------------------------


def test_shutdown_unloads_all_despite_deactivate_error(tmp_path: Path) -> None:
    _write_plugin(
        tmp_path / "bad",
        _manifest("pub.bad", ["onStartup"]),
        backend=BAD_DEACTIVATE_BACKEND,
    )
    _write_plugin(tmp_path / "good", _manifest("pub.good", ["onStartup"]))

    host = PluginHost()
    assert wiring.startup(host, tmp_path) == ["pub.bad", "pub.good"]

    wiring.shutdown(host)

    assert host.list_loaded() == []
    assert host.get("pub.bad") is None
    assert host.get("pub.good") is None


# -- app singleton ------------------------------------------------------------


def test_app_exposes_plugin_host_singleton() -> None:
    from agent_team_backend import app

    assert isinstance(app.plugin_host, PluginHost)
