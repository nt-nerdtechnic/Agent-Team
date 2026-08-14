import json
import os
from pathlib import Path

import pytest

from agent_team_backend.codex_home import CodexHomeManager
from agent_team_backend.skills_store import SkillsStore


def test_prepare_symlinks_shared_codex_state(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    real.mkdir()
    (real / "auth.json").write_text("{}", encoding="utf-8")
    (real / "config.toml").write_text("model = 'x'\n", encoding="utf-8")
    (real / "skills").mkdir()
    panes = tmp_path / "panes"

    home = CodexHomeManager(real_home=real, panes_root=panes).prepare("pane-1")

    assert home == panes / "pane-1"
    assert (home / "auth.json").is_symlink()
    assert (home / "config.toml").is_symlink()
    assert (home / "skills").is_symlink()
    assert (home / "sessions").exists() is False


def test_cleanup_removes_only_per_pane_home_not_symlink_targets(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    real.mkdir()
    auth = real / "auth.json"
    auth.write_text("{}", encoding="utf-8")
    panes = tmp_path / "panes"
    manager = CodexHomeManager(real_home=real, panes_root=panes)
    home = manager.prepare("pane-1")
    (home / "sessions").mkdir()
    (home / "sessions" / "rollout.jsonl").write_text("{}", encoding="utf-8")

    assert manager.cleanup("pane-1") is True

    assert home.exists() is False
    assert auth.exists() is True
    assert auth.read_text(encoding="utf-8") == "{}"


def test_find_session_home_prefers_default_home(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    day_dir = real / "sessions" / "2026" / "06" / "08"
    day_dir.mkdir(parents=True)
    (day_dir / "rollout-2026-06-08T16-31-16-legacy-id-1.jsonl").write_text("{}", encoding="utf-8")
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    assert manager.find_session_home("legacy-id-1") == real
    assert manager.find_session_home("unknown-id") is None


def test_find_session_home_locates_pane_home_sessions(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "sessions").mkdir(parents=True)
    panes = tmp_path / "panes"
    pane_sessions = panes / "old-pane-home" / "sessions" / "2026" / "06" / "10"
    pane_sessions.mkdir(parents=True)
    (pane_sessions / "rollout-2026-06-10T12-00-00-pane-id-9.jsonl").write_text("{}", encoding="utf-8")
    manager = CodexHomeManager(real_home=real, panes_root=panes)

    assert manager.find_session_home("pane-id-9") == panes / "old-pane-home"


def test_find_session_home_refreshes_managed_skills_for_resume(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "skills" / "native").mkdir(parents=True)
    managed = tmp_path / "managed"
    (managed / "enabled").mkdir(parents=True)
    panes = tmp_path / "panes"
    manager = CodexHomeManager(
        real_home=real,
        panes_root=panes,
        managed_skills_root=managed,
    )
    home = manager.prepare("pane-1")
    sessions = home / "sessions"
    sessions.mkdir()
    (sessions / "rollout-resume-id.jsonl").write_text("{}", encoding="utf-8")
    assert (home / "skills" / "enabled").exists()

    (managed / "enabled").rmdir()

    assert manager.find_session_home("resume-id") == home
    assert not (home / "skills" / "enabled").exists()
    assert (home / "skills" / "native").exists()


def test_archived_session_routes_home_but_is_not_resumable(tmp_path: Path) -> None:
    # `codex archive` moves the rollout into archived_sessions/ and codex then
    # REFUSES `codex resume <id>` ("session <id> is archived. Run `codex
    # unarchive <id>` ..."). Routing still needs the owning home; preflight
    # must report the session as gone so the pane can heal onto a fresh id.
    real = tmp_path / "real-codex"
    (real / "sessions").mkdir(parents=True)
    panes = tmp_path / "panes"
    archived = panes / "pane-home" / "archived_sessions"
    archived.mkdir(parents=True)
    (archived / "rollout-2026-06-10T12-00-00-archived-id-1.jsonl").write_text(
        "{}", encoding="utf-8")
    live = panes / "pane-home" / "sessions" / "2026" / "06" / "11"
    live.mkdir(parents=True)
    (live / "rollout-2026-06-11T12-00-00-live-id-1.jsonl").write_text("{}", encoding="utf-8")
    manager = CodexHomeManager(real_home=real, panes_root=panes)

    assert manager.find_session_home("archived-id-1") == panes / "pane-home"
    assert manager.find_resumable_session_home("archived-id-1") is None
    # A live rollout answers both questions the same way.
    assert manager.find_session_home("live-id-1") == panes / "pane-home"
    assert manager.find_resumable_session_home("live-id-1") == panes / "pane-home"


def test_session_exists_preflight_rejects_archived_rollout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent_team_backend.cli_vendors import codex as codex_vendor

    archived = tmp_path / ".codex" / "archived_sessions"
    archived.mkdir(parents=True)
    (archived / "rollout-2026-06-10T12-00-00-archived-id-2.jsonl").write_text(
        "{}", encoding="utf-8")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

    assert codex_vendor._session_exists("/ws", "archived-id-2") is False
    # ... while routing still knows which home owns it.
    assert codex_vendor.CodexHomeManager().find_session_home(
        "archived-id-2") == tmp_path / ".codex"


def test_find_session_home_rejects_unsafe_or_empty_id(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "sessions").mkdir(parents=True)
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    assert manager.find_session_home("") is None
    assert manager.find_session_home("*") is None
    assert manager.find_session_home("../escape") is None


def test_cleanup_rejects_unsafe_home_id(tmp_path: Path) -> None:
    manager = CodexHomeManager(real_home=tmp_path / "real", panes_root=tmp_path / "panes")

    try:
        manager.cleanup("../real")
    except ValueError:
        pass
    else:
        raise AssertionError("unsafe home id should be rejected")


def test_prepare_merges_native_and_managed_skills_with_native_precedence(
    tmp_path: Path,
) -> None:
    real = tmp_path / "real-codex"
    native = real / "skills"
    managed = tmp_path / "managed"
    for root, names in (
        (native, ("native", "same")),
        (managed, ("managed", "same", "file-conflict")),
    ):
        for name in names:
            (root / name).mkdir(parents=True)
    (native / "file-conflict").write_text("reserved", encoding="utf-8")
    manager = CodexHomeManager(
        real_home=real,
        panes_root=tmp_path / "panes",
        managed_skills_root=managed,
    )

    home = manager.prepare("pane-1")

    skills = home / "skills"
    assert skills.is_symlink()
    assert sorted(path.name for path in skills.iterdir()) == ["managed", "native", "same"]
    assert (skills / "same").resolve() == (native / "same").resolve()
    assert (skills / "managed").resolve() == (managed / "managed").resolve()


def test_prepare_removes_disabled_managed_skill_on_next_spawn(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "skills" / "native").mkdir(parents=True)
    managed = tmp_path / "managed"
    (managed / "enabled").mkdir(parents=True)
    manager = CodexHomeManager(
        real_home=real,
        panes_root=tmp_path / "panes",
        managed_skills_root=managed,
    )
    home = manager.prepare("pane-1")
    assert (home / "skills" / "enabled").exists()

    (managed / "enabled").rmdir()
    manager.prepare("pane-1")

    assert not (home / "skills" / "enabled").exists()
    assert (home / "skills" / "native").exists()


def test_prepare_refreshes_default_central_projection(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "skills" / "native").mkdir(parents=True)
    store = SkillsStore()
    store.create_skill("managed", "Managed")
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    home = manager.prepare("pane-1")

    assert (home / "skills" / "native").exists()
    assert (home / "skills" / "managed" / "SKILL.md").exists()


def test_prepare_skill_view_failure_does_not_block_spawn(
    tmp_path: Path, monkeypatch
) -> None:
    real = tmp_path / "real-codex"
    (real / "skills" / "native").mkdir(parents=True)
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    def fail_mkdtemp(*_args, **_kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr("agent_team_backend.cli_vendors.codex.tempfile.mkdtemp", fail_mkdtemp)

    home = manager.prepare("pane-1")

    assert home == tmp_path / "panes" / "pane-1"
    assert (home / "skills").is_symlink()
    assert (home / "skills" / "native").exists()


# ── stranded in-pane login promotion ─────────────────────────────────────────

def _write_pane_auth(path: Path, token: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"tokens": {"access_token": token}}), encoding="utf-8"
    )


def test_promote_stranded_auth_adopts_newest_pane_login(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    panes = tmp_path / "panes"
    manager = CodexHomeManager(real_home=real, panes_root=panes)
    old = panes / "pane-old" / "auth.json"
    _write_pane_auth(old, "old-token")
    os.utime(old, (1, 1))
    new = panes / "pane-new" / "auth.json"
    _write_pane_auth(new, "new-token")

    assert manager.promote_stranded_auth() is True

    real_auth = real / "auth.json"
    assert real_auth.is_file() and not real_auth.is_symlink()
    assert "new-token" in real_auth.read_text(encoding="utf-8")
    # The promoted pane now writes through to the shared credential.
    assert new.is_symlink()
    assert new.resolve() == real_auth
    # Other stranded logins are left untouched (they may be other accounts).
    assert old.is_file() and not old.is_symlink()
    # Idempotent once the real credential exists.
    assert manager.promote_stranded_auth() is False


def test_promote_stranded_auth_never_overwrites_real_auth(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    real.mkdir()
    (real / "auth.json").write_text('{"keep": true}', encoding="utf-8")
    panes = tmp_path / "panes"
    manager = CodexHomeManager(real_home=real, panes_root=panes)
    stranded = panes / "pane-1" / "auth.json"
    _write_pane_auth(stranded, "pane-token")

    assert manager.promote_stranded_auth() is False

    assert (real / "auth.json").read_text(encoding="utf-8") == '{"keep": true}'
    assert stranded.is_file() and not stranded.is_symlink()


def test_promote_stranded_auth_noop_without_candidates(tmp_path: Path) -> None:
    manager = CodexHomeManager(
        real_home=tmp_path / "real", panes_root=tmp_path / "panes"
    )
    # Neither the panes root nor any stranded login exists (fresh install
    # before any codex pane spawned).
    assert manager.promote_stranded_auth() is False
    assert (tmp_path / "real" / "auth.json").exists() is False


def test_prepare_adopts_stranded_login_for_new_pane(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    panes = tmp_path / "panes"
    manager = CodexHomeManager(real_home=real, panes_root=panes)
    stranded = panes / "pane-1" / "auth.json"
    _write_pane_auth(stranded, "pane1-token")

    home = manager.prepare("pane-2")

    # pane-1's in-pane login became the shared credential and pane-2
    # spawns already logged in.
    assert (real / "auth.json").is_file()
    assert (home / "auth.json").is_symlink()
    assert stranded.is_symlink()
