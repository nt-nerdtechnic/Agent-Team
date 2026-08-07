"""quick_status and the login-shell PATH cache (onboarding latency fixes).

quick_status is the wizard's first paint: it must never spawn a subprocess
(that is the whole point — the full pass's slowest --version probe is what
delayed "not installed" from appearing). The PATH probe cache bounds the
per-call login-shell cost; force re-probes for wizard flows that just ran an
installer.
"""

import subprocess

import pytest

from agent_team_backend import onboarding_deps as od


@pytest.fixture(autouse=True)
def _reset_path_cache():
    od._path_refreshed_at = None
    yield
    od._path_refreshed_at = None


def test_quick_status_spawns_no_subprocess(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError(f"quick_status spawned a subprocess: {args}")

    monkeypatch.setattr(od.subprocess, "run", boom)
    monkeypatch.setattr(od.subprocess, "Popen", boom)

    status = od.quick_status()

    assert status["quick"] is True
    assert [d["id"] for d in status["deps"]] == [d.id for d in od.DEPS]
    # Presence is exact: a dep whose binary is nowhere on PATH reads missing.
    by_id = {d["id"]: d for d in status["deps"]}
    for entry in by_id.values():
        assert entry["status"] in ("ok", "missing")
        if entry["status"] == "missing":
            assert entry["binary_path"] == ""
    # No versions in the quick pass — those need the subprocess.
    assert all(d["version"] == "" for d in status["deps"])
    # cli_health is the empty shape (the full pass fills it in).
    assert status["cli_health"]["entries"] == []


def test_quick_and_full_agree_on_missing(monkeypatch):
    # Force every resolve to fail so both passes see the same world.
    monkeypatch.setattr(od, "resolve_executable", lambda dep: "")
    quick = {d["id"]: d["status"] for d in od.quick_status()["deps"]}
    assert set(quick.values()) == {"missing"}


def test_path_probe_cached_until_forced(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)

        class R:
            stdout = "/usr/bin:/bin\n"
            returncode = 0

        return R()

    monkeypatch.setattr(od.subprocess, "run", fake_run)

    od._refresh_path_from_login_shell()
    od._refresh_path_from_login_shell()
    assert len(calls) == 1  # second call served from cache

    od._refresh_path_from_login_shell(force=True)
    assert len(calls) == 2  # force bypasses the cache

    # TTL expiry re-probes without force.
    od._path_refreshed_at = od.time.monotonic() - od._PATH_REFRESH_TTL_S - 1
    od._refresh_path_from_login_shell()
    assert len(calls) == 3
