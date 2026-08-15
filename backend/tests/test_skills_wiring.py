from __future__ import annotations

import json
import shlex
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.base import SkillsWiring
from agent_team_backend.cli_vendors.registry import VENDORS
from agent_team_backend.plugins.builtin.navide_skills import skills_wiring


def _skill(root: Path, name: str) -> Path:
    path = root / name
    path.mkdir(parents=True)
    return path


class _Store:
    """Minimal SkillsStore stand-in: a managed root and a per-agent list."""

    def __init__(self, managed: Path, targets: dict[str, list[str]] | None = None) -> None:
        self._managed = managed
        self._targets = targets or {}

    @property
    def runtime_root(self) -> Path:
        return self._managed

    def rebuild_runtime_projection(self) -> Path:
        return self._managed

    def targets_for(self, agent_key: str) -> list[str]:
        if agent_key in self._targets:
            return self._targets[agent_key]
        if not self._managed.is_dir():
            return []
        return sorted(entry.name for entry in self._managed.iterdir())


def _view(
    tmp_path: Path,
    wiring: SkillsWiring,
    *,
    agent_key: str = "claude",
    targets: dict[str, list[str]] | None = None,
    native: Path | None = None,
) -> Path | None:
    return skills_wiring.prepare_view(
        agent_key,
        wiring,
        store=_Store(tmp_path / "managed", targets),
        native_root=native or (tmp_path / "native"),
        view_root=tmp_path / "view",
    )


def test_view_uses_the_vendor_layout_and_drops_native_collisions(tmp_path: Path) -> None:
    _skill(tmp_path / "native", "same")
    _skill(tmp_path / "managed", "managed")
    _skill(tmp_path / "managed", "same")

    view = _view(tmp_path, SkillsWiring(flag="--add-dir", view_layout=(".claude", "skills")))

    assert view == tmp_path / "view"
    projected = view / ".claude" / "skills"
    assert sorted(path.name for path in projected.iterdir()) == ["managed"]
    assert (projected / "managed").resolve() == (tmp_path / "managed" / "managed").resolve()


def test_view_reserves_native_regular_file_names(tmp_path: Path) -> None:
    native = tmp_path / "native"
    native.mkdir()
    (native / "same").write_text("reserved", encoding="utf-8")
    _skill(tmp_path / "managed", "same")

    view = _view(tmp_path, SkillsWiring(flag="--add-dir", view_layout=(".claude", "skills")))

    assert view is None
    assert list((tmp_path / "view" / ".claude" / "skills").iterdir()) == []


def test_view_without_layout_holds_skills_directly(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "alpha")

    view = _view(tmp_path, SkillsWiring(flag="--skills-dir"), agent_key="kimi")

    assert view is not None
    assert sorted(path.name for path in view.iterdir()) == ["alpha"]


def test_view_honours_per_agent_targets(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "alpha")
    _skill(tmp_path / "managed", "beta")

    view = _view(
        tmp_path,
        SkillsWiring(flag="--skills-dir"),
        agent_key="kimi",
        targets={"kimi": ["beta"]},
    )

    assert view is not None
    assert [path.name for path in view.iterdir()] == ["beta"]


def test_view_is_rebuilt_so_a_removed_skill_does_not_linger(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "alpha")
    wiring = SkillsWiring(flag="--skills-dir")
    assert _view(tmp_path, wiring, agent_key="kimi") is not None

    (tmp_path / "managed" / "alpha").rmdir()

    assert _view(tmp_path, wiring, agent_key="kimi") is None
    assert list((tmp_path / "view").iterdir()) == []


def test_wire_command_is_idempotent_and_preserves_shell_wrapper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    view = tmp_path / "dir with spaces"
    (view / ".claude" / "skills").mkdir(parents=True)
    monkeypatch.setattr(skills_wiring, "prepare_view", lambda *a, **k: view)
    command = ["/bin/zsh", "-ilc", "claude resume abc"]

    once = skills_wiring.wire_command("claude", command, None)
    twice = skills_wiring.wire_command("claude", once, None)

    expected = str(view / ".claude" / "skills")
    assert once[:-1] == command[:-1]
    assert once[-1] == f"claude resume abc --add-dir {shlex.quote(expected)}"
    assert twice == once


def test_wire_command_repeats_the_flag_for_each_skill(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    view = tmp_path / "view"
    _skill(view, "alpha")
    _skill(view, "beta")
    monkeypatch.setattr(skills_wiring, "prepare_view", lambda *a, **k: view)

    wired = skills_wiring.wire_command("pi", "pi", None)

    assert wired == (
        f"pi --skill {shlex.quote(str(view / 'alpha'))}"
        f" --skill {shlex.quote(str(view / 'beta'))}"
    )


def test_replacing_flag_passes_back_the_discovery_roots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    (home / ".kimi-code" / "skills").mkdir(parents=True)
    project = tmp_path / "project"
    (project / ".agents" / "skills").mkdir(parents=True)
    view = tmp_path / "view"
    _skill(view, "alpha")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(skills_wiring, "prepare_view", lambda *a, **k: view)

    wired = skills_wiring.wire_command("kimi", "kimi", None, "pane", {}, str(project))

    # Ours first, then only the discovery roots that actually exist: ~/.agents
    # was never created, so passing it would invent a root kimi never had.
    assert wired == (
        f"kimi --skills-dir {shlex.quote(str(view))}"
        f" --skills-dir {shlex.quote(str(home / '.kimi-code' / 'skills'))}"
        f" --skills-dir {shlex.quote(str(project / '.agents' / 'skills'))}"
    )


def test_config_env_merges_instead_of_replacing_mcp_wiring(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    view = tmp_path / "view"
    _skill(view, "alpha")
    monkeypatch.setattr(skills_wiring, "prepare_view", lambda *a, **k: view)
    env = {"OPENCODE_CONFIG_CONTENT": json.dumps({"mcp": {"navide-plans": {"type": "remote"}}})}

    command = skills_wiring.wire_command("opencode", "opencode", None, "pane", env, "")

    document = json.loads(env["OPENCODE_CONFIG_CONTENT"])
    assert command == "opencode"  # the variable carries it, not the command line
    assert document["mcp"] == {"navide-plans": {"type": "remote"}}
    assert document["skills"]["paths"] == [str(view)]


def test_config_env_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    view = tmp_path / "view"
    _skill(view, "alpha")
    monkeypatch.setattr(skills_wiring, "prepare_view", lambda *a, **k: view)
    env: dict[str, str] = {}

    skills_wiring.wire_command("opencode", "opencode", None, "pane", env, "")
    skills_wiring.wire_command("opencode", "opencode", None, "pane", env, "")

    assert json.loads(env["OPENCODE_CONFIG_CONTENT"])["skills"]["paths"] == [str(view)]


def test_config_env_keeps_a_users_own_skill_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    view = tmp_path / "view"
    _skill(view, "alpha")
    monkeypatch.setattr(skills_wiring, "prepare_view", lambda *a, **k: view)
    env = {"OPENCODE_CONFIG_CONTENT": json.dumps({"skills": {"paths": ["/mine"]}})}

    skills_wiring.wire_command("opencode", "opencode", None, "pane", env, "")

    assert json.loads(env["OPENCODE_CONFIG_CONTENT"])["skills"]["paths"] == ["/mine", str(view)]


@pytest.mark.parametrize("agent_key", ["kilo", "aider", "terminal"])
def test_wire_command_noops_for_agents_without_wiring(
    agent_key: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("no view should be prepared")

    monkeypatch.setattr(skills_wiring, "prepare_view", fail_if_called)
    command = ["/bin/zsh", "-ilc", agent_key]

    assert skills_wiring.wire_command(agent_key, command, None) is command


def test_wire_command_failure_does_not_block_spawn(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*_args, **_kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(skills_wiring, "prepare_view", fail)

    assert skills_wiring.wire_command("claude", "claude", None) == "claude"


def test_every_vendor_declares_its_skills_capability() -> None:
    """A wired vendor must also be marked supported, or the UI lies."""
    for key, spec in VENDORS.items():
        if spec.skills_wiring is not None:
            assert spec.skills_supported, key
        wiring = spec.skills_wiring
        if wiring is None:
            continue
        # Exactly one surface per vendor: the injection layer picks the branch
        # from whichever field is set, so two would make it ambiguous.
        surfaces = [
            bool(wiring.flag),
            bool(wiring.config_env),
            bool(wiring.root_env),
            bool(wiring.project_rel),
        ]
        assert sum(surfaces) == 1, key
        if wiring.config_env:
            assert wiring.config_paths_key, key
        if wiring.root_env:
            assert wiring.skills_rel, key
        if wiring.replaces_discovery:
            assert wiring.discovery_home or wiring.discovery_project, key


# ── Config-home surface (codex, copilot, qwen, grok, antigravity, muse) ──────

CODEX = SkillsWiring(root_env="CODEX_HOME", root_home=(".codex",), skills_rel=("skills",))
GROK = SkillsWiring(root_env="HOME", skills_rel=(".agents", "skills"))


def _root(
    tmp_path: Path,
    wiring: SkillsWiring,
    *,
    agent_key: str = "codex",
    pane_id: str = "pane-1",
    env: dict[str, str] | None = None,
    targets: dict[str, list[str]] | None = None,
) -> tuple[str | None, dict[str, str]]:
    env = {} if env is None else env
    result = skills_wiring.prepare_root(
        agent_key,
        wiring,
        pane_id,
        env,
        store=_Store(tmp_path / "managed", targets),
        native_root=tmp_path / "native",
        home=tmp_path / "home",
    )
    return result, env


def test_config_home_mirrors_the_real_root_and_owns_only_the_skills_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = tmp_path / "home" / ".codex"
    (real / "sessions").mkdir(parents=True)
    (real / "auth.json").write_text("secret", encoding="utf-8")
    (real / "skills" / "mine").mkdir(parents=True)
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    root, env = _root(tmp_path, CODEX)

    assert root == str(tmp_path / "panes" / "codex" / "pane-1")
    shim = Path(root)
    # Everything but the skills directory stays the user's, by link.
    assert (shim / "auth.json").is_symlink()
    assert (shim / "auth.json").read_text(encoding="utf-8") == "secret"
    assert (shim / "sessions").is_symlink()
    # The skills directory is ours, and carries both sides.
    assert not (shim / "skills").is_symlink()
    assert sorted(p.name for p in (shim / "skills").iterdir()) == ["alpha", "mine"]
    assert (shim / "skills" / "alpha").resolve() == (tmp_path / "managed" / "alpha").resolve()
    assert (shim / "skills" / "mine").resolve() == (real / "skills" / "mine").resolve()
    assert env == {}


def test_config_home_never_displaces_a_users_own_skill_of_the_same_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_skill = tmp_path / "home" / ".codex" / "skills" / "alpha"
    real_skill.mkdir(parents=True)
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    root, _ = _root(tmp_path, CODEX)

    assert (Path(root) / "skills" / "alpha").resolve() == real_skill.resolve()


def test_config_home_survives_a_missing_real_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    root, _ = _root(tmp_path, CODEX)

    assert [p.name for p in (Path(root) / "skills").iterdir()] == ["alpha"]


def test_config_home_drops_links_whose_target_disappeared(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = tmp_path / "home" / ".codex"
    (real / "gone").mkdir(parents=True)
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")
    root, _ = _root(tmp_path, CODEX)
    assert (Path(root) / "gone").is_symlink()

    (real / "gone").rmdir()
    _root(tmp_path, CODEX)

    # A dangling link would shadow a name the CLI wants to create later.
    assert not (Path(root) / "gone").is_symlink()


def test_config_home_rides_an_existing_shim_instead_of_making_a_second(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """grok and antigravity get their HOME shim from MCP wiring."""
    mcp_shim = tmp_path / "mcp-shim"
    mcp_shim.mkdir()
    (mcp_shim / ".grok").mkdir()
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    root, env = _root(
        tmp_path, GROK, agent_key="grok", env={"HOME": str(mcp_shim)}
    )

    assert root == str(mcp_shim)
    assert (mcp_shim / ".agents" / "skills" / "alpha").is_symlink()
    # MCP's own directory in that shim is untouched.
    assert (mcp_shim / ".grok").is_dir()
    assert not (tmp_path / "panes").exists()


def test_config_home_declines_to_create_a_shim_mcp_wiring_owns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Creating grok's HOME shim here would make MCP wiring skip its own."""
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    root, env = _root(tmp_path, GROK, agent_key="grok")

    assert root is None
    assert env == {}
    assert not (tmp_path / "panes").exists()


@pytest.mark.parametrize("pane_id", ["", "..", ".", "pane/../escape", "pane id"])
def test_config_home_rejects_unusable_pane_ids(
    pane_id: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    root, _ = _root(tmp_path, CODEX, pane_id=pane_id)

    assert root is None


def test_wire_command_sets_the_home_variable_without_touching_the_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(skills_wiring, "prepare_root", lambda *a, **k: "/shimmed")
    env: dict[str, str] = {}

    command = skills_wiring.wire_command("codex", "codex resume x", None, "pane", env, "")

    assert command == "codex resume x"
    assert env == {"CODEX_HOME": "/shimmed"}


# ── Workspace surface (cursor) ──────────────────────────────────────────────

CURSOR = SkillsWiring(project_rel=(".cursor", "skills"))


def _sync(tmp_path: Path, cwd: Path, targets: dict[str, list[str]] | None = None) -> bool:
    return skills_wiring.sync_project_dir(
        "cursor",
        CURSOR,
        str(cwd),
        store=_Store(tmp_path / "managed", targets),
        native_root=tmp_path / "native",
    )


def test_project_dir_adds_our_links_and_keeps_them_out_of_git(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "alpha")
    cwd = tmp_path / "repo"
    (cwd / ".git" / "info").mkdir(parents=True)

    assert _sync(tmp_path, cwd) is True

    link = cwd / ".cursor" / "skills" / "alpha"
    assert link.resolve() == (tmp_path / "managed" / "alpha").resolve()
    exclude = (cwd / ".git" / "info" / "exclude").read_text(encoding="utf-8")
    assert "/.cursor/skills/" in exclude

    _sync(tmp_path, cwd)
    assert exclude == (cwd / ".git" / "info" / "exclude").read_text(encoding="utf-8")


def test_project_dir_removes_only_our_own_stale_links(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "alpha")
    _skill(tmp_path / "managed", "beta")
    cwd = tmp_path / "repo"
    _sync(tmp_path, cwd)
    assert (cwd / ".cursor" / "skills" / "beta").is_symlink()

    (tmp_path / "managed" / "beta").rmdir()
    _sync(tmp_path, cwd)

    assert not (cwd / ".cursor" / "skills" / "beta").is_symlink()
    assert (cwd / ".cursor" / "skills" / "alpha").is_symlink()


def test_project_dir_never_touches_what_the_user_put_there(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "alpha")
    cwd = tmp_path / "repo"
    theirs = cwd / ".cursor" / "skills" / "theirs"
    theirs.mkdir(parents=True)
    (theirs / "SKILL.md").write_text("mine", encoding="utf-8")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (cwd / ".cursor" / "skills" / "linked").symlink_to(elsewhere, target_is_directory=True)

    _sync(tmp_path, cwd)

    assert (theirs / "SKILL.md").read_text(encoding="utf-8") == "mine"
    assert (cwd / ".cursor" / "skills" / "linked").resolve() == elsewhere.resolve()
    assert (cwd / ".cursor" / "skills" / "alpha").is_symlink()


def test_project_dir_leaves_a_users_directory_of_the_same_name_alone(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "alpha")
    cwd = tmp_path / "repo"
    theirs = cwd / ".cursor" / "skills" / "alpha"
    theirs.mkdir(parents=True)

    _sync(tmp_path, cwd)

    assert not (cwd / ".cursor" / "skills" / "alpha").is_symlink()


def test_project_dir_noops_without_a_working_directory(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "alpha")

    assert skills_wiring.wire_command("cursor", "agent", None, "pane", {}, "") == "agent"


def test_config_home_adopts_entries_the_cli_created_in_the_shim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "home" / ".codex").mkdir(parents=True)
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")
    root, _ = _root(tmp_path, CODEX)
    # A fresh login the CLI wrote into its shim on the previous run.
    (Path(root) / "auth.json").write_text("fresh", encoding="utf-8")

    _root(tmp_path, CODEX)

    real = tmp_path / "home" / ".codex" / "auth.json"
    assert real.read_text(encoding="utf-8") == "fresh"
    assert (Path(root) / "auth.json").is_symlink()


def test_config_home_never_adopts_our_own_links_into_the_users_skills(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "home" / ".codex" / "skills").mkdir(parents=True)
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    _root(tmp_path, CODEX)
    _root(tmp_path, CODEX)

    assert list((tmp_path / "home" / ".codex" / "skills").iterdir()) == []


def test_config_home_keeps_a_suppressed_discovery_root_reachable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """copilot stops scanning ~/.agents/skills once COPILOT_HOME is set."""
    (tmp_path / "home" / ".copilot" / "skills" / "theirs").mkdir(parents=True)
    (tmp_path / "home" / ".agents" / "skills" / "shared").mkdir(parents=True)
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")
    wiring = SkillsWiring(
        root_env="COPILOT_HOME",
        root_home=(".copilot",),
        skills_rel=("skills",),
        discovery_home=((".agents", "skills"),),
    )

    root, _ = _root(tmp_path, wiring, agent_key="copilot")

    assert sorted(p.name for p in (Path(root) / "skills").iterdir()) == [
        "alpha", "shared", "theirs",
    ]


def test_config_home_never_writes_through_a_mirrored_link(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A shim that mirrored the whole home has .agents as a link to the real
    one; descending through it would plant managed links in the user's tree."""
    real_agents = tmp_path / "home" / ".agents" / "skills"
    real_agents.mkdir(parents=True)
    (real_agents / "theirs").mkdir()
    shim = tmp_path / "mcp-shim"
    shim.mkdir()
    (shim / ".agents").symlink_to(tmp_path / "home" / ".agents", target_is_directory=True)
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    _root(tmp_path, GROK, agent_key="grok", env={"HOME": str(shim)})

    # The user's real directory is untouched…
    assert [p.name for p in real_agents.iterdir()] == ["theirs"]
    # …and the shim now owns a real directory carrying both.
    assert not (shim / ".agents").is_symlink()
    assert sorted(p.name for p in (shim / ".agents" / "skills").iterdir()) == [
        "alpha", "theirs",
    ]


def test_config_home_does_not_try_to_adopt_the_directory_it_built(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    (tmp_path / "home" / ".agents" / "skills").mkdir(parents=True)
    shim = tmp_path / "mcp-shim"
    shim.mkdir()
    (shim / ".agents").symlink_to(tmp_path / "home" / ".agents", target_is_directory=True)
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    _root(tmp_path, GROK, agent_key="grok", env={"HOME": str(shim)})
    with caplog.at_level("WARNING"):
        _root(tmp_path, GROK, agent_key="grok", env={"HOME": str(shim)})

    assert "exists in both the shim and the real tree" not in caplog.text
    assert (shim / ".agents" / "skills" / "alpha").is_symlink()


def test_config_home_does_not_reconcile_a_shim_it_does_not_own(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """MCP's shim holds its own config directory; moving that into the user's
    home would leave our MCP config sitting in ~/.grok."""
    (tmp_path / "home").mkdir()
    shim = tmp_path / "mcp-shim"
    (shim / ".grok").mkdir(parents=True)
    (shim / ".grok" / "mcp.json").write_text("{}", encoding="utf-8")
    _skill(tmp_path / "managed", "alpha")
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")

    _root(tmp_path, GROK, agent_key="grok", env={"HOME": str(shim)})

    assert (shim / ".grok" / "mcp.json").is_file()
    assert not (tmp_path / "home" / ".grok").exists()
