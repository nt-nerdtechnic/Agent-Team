"""Builtin backend plugins bundled with the application.

Each child directory is a plugin dir (plugin.json + backend.py) discovered by
:func:`..wiring.builtin_plugins_root` on startup. This in-process Python import
path is reserved for bundled v1 compatibility plugins; installed packages are
never discovered here.
"""
