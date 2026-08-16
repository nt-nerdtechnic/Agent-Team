from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import native_skills
from agent_team_backend.cli_vendors.base import SkillsWiring
from agent_team_backend.cli_vendors.registry import VENDORS
from agent_team_backend.plugins.builtin.navide_skills import skills_wiring


def _skill(root: Path, name: str) -> Path:
    path = root / name
    path.mkdir(parents=True)
    return path


class _Store:
    """Minimal SkillsStore stand-in: a shared root, per-agent lists, and an
    optional set of native skills with their own opt-in targets."""

    def __init__(
        self,
        managed: Path,
        targets: dict[str, list[str]] | None = None,
        native: list[Any] | None = None,
        native_targets: dict[str, list[str]] | None = None,
    ) -> None:
        self._managed = managed
        self._targets = targets or {}
        self._native = native or []
        self._native_targets = native_targets or {}

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

    def native_skills(self) -> list[Any]:
        return self._native

    def native_targets_for(self, agent_key: str) -> list[str]:
        return [real for real, agents in self._native_targets.items() if agent_key in agents]


def _native(tmp_path: Path, name: str, owner: str = "copilot") -> Any:
    """A native skill living under a fake vendor root, owned by ``owner``."""
    real = tmp_path / "vendor" / owner / name
    real.mkdir(parents=True, exist_ok=True)
    (real / "SKILL.md").write_text(f"---\nname: {name}\ndescription: d\n---\n", encoding="utf-8")
    return native_skills.NativeSkill(
        name=name, description="d", source=owner, owner_agent=owner,
        path=str(real), real_path=str(real.resolve()),
    )


def _store_with_native(tmp_path: Path, agent_key: str, name: str = "alpha", owner: str = "copilot") -> _Store:
    skill = _native(tmp_path, name, owner)
    return _Store(tmp_path / "managed", native=[skill], native_targets={skill.real_path: [agent_key]})


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
    store: _Store | None = None,
) -> tuple[str | None, dict[str, str]]:
    env = {} if env is None else env
    # codex/grok read the shared root themselves, so the thing that reaches
    # them through delivery is a native skill from another CLI.
    store = store or _store_with_native(tmp_path, agent_key)
    result = skills_wiring.prepare_root(
        agent_key,
        wiring,
        pane_id,
        env,
        store=store,
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
    assert (shim / "skills" / "alpha").resolve() == (tmp_path / "vendor" / "copilot" / "alpha").resolve()
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


def _sync(tmp_path: Path, cwd: Path, store: _Store | None = None) -> bool:
    return skills_wiring.sync_project_dir(
        "cursor",
        CURSOR,
        str(cwd),
        store=store or _store_with_native(tmp_path, "cursor"),
        native_root=tmp_path / "native",
    )


def test_project_dir_adds_our_links_and_keeps_them_out_of_git(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "alpha")
    cwd = tmp_path / "repo"
    (cwd / ".git" / "info").mkdir(parents=True)

    assert _sync(tmp_path, cwd) is True

    link = cwd / ".cursor" / "skills" / "alpha"
    assert link.resolve() == (tmp_path / "vendor" / "copilot" / "alpha").resolve()
    exclude = (cwd / ".git" / "info" / "exclude").read_text(encoding="utf-8")
    assert "/.cursor/skills/" in exclude

    _sync(tmp_path, cwd)
    assert exclude == (cwd / ".git" / "info" / "exclude").read_text(encoding="utf-8")


def test_project_dir_removes_only_our_own_stale_links(tmp_path: Path) -> None:
    alpha, beta = _native(tmp_path, "alpha"), _native(tmp_path, "beta")
    both = _Store(tmp_path / "managed", native=[alpha, beta],
                  native_targets={alpha.real_path: ["cursor"], beta.real_path: ["cursor"]})
    cwd = tmp_path / "repo"
    _sync(tmp_path, cwd, both)
    assert (cwd / ".cursor" / "skills" / "beta").is_symlink()

    only_alpha = _Store(tmp_path / "managed", native=[alpha],
                        native_targets={alpha.real_path: ["cursor"]})
    _sync(tmp_path, cwd, only_alpha)

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

    # copilot reads the shared root itself, so what reaches it by delivery is
    # a native skill from another CLI (here: one of claude's).
    root, _ = _root(
        tmp_path, wiring, agent_key="copilot",
        store=_store_with_native(tmp_path, "copilot", "alpha", owner="claude"),
    )

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


# ── Two sources, two "already reads it" rules ───────────────────────────────


def _sources(tmp_path: Path, agent_key: str, store: _Store) -> list[str]:
    return [p.name for p in skills_wiring._managed_sources(agent_key, store, tmp_path / "native")]


def test_shared_skill_is_not_delivered_to_a_cli_that_reads_the_shared_root(tmp_path: Path) -> None:
    _skill(tmp_path / "managed", "tdd")
    store = _Store(tmp_path / "managed")

    # claude does not read ~/.agents/skills → delivered.
    assert _sources(tmp_path, "claude", store) == ["tdd"]
    # codex reads it itself → a second copy would only shadow the original.
    assert _sources(tmp_path, "codex", store) == []


def test_native_skill_is_delivered_to_other_agents_but_never_its_owner(tmp_path: Path) -> None:
    skill = _native(tmp_path, "bug-buster", owner="copilot")
    store = _Store(
        tmp_path / "managed", native=[skill],
        native_targets={skill.real_path: ["claude", "copilot", "codex"]},
    )

    assert _sources(tmp_path, "claude", store) == ["bug-buster"]
    assert _sources(tmp_path, "codex", store) == ["bug-buster"]
    # copilot already reads its own directory.
    assert _sources(tmp_path, "copilot", store) == []


def test_native_skill_is_opt_in(tmp_path: Path) -> None:
    skill = _native(tmp_path, "bug-buster")
    store = _Store(tmp_path / "managed", native=[skill])  # no targets

    assert _sources(tmp_path, "claude", store) == []


def test_invalid_native_skill_is_never_delivered(tmp_path: Path) -> None:
    skill = _native(tmp_path, "broken")
    broken = native_skills.NativeSkill(**{**skill.__dict__, "valid": False, "error": "x"})
    store = _Store(tmp_path / "managed", native=[broken], native_targets={broken.real_path: ["claude"]})

    assert _sources(tmp_path, "claude", store) == []


def test_same_directory_reached_twice_is_delivered_once(tmp_path: Path) -> None:
    """A shared skill the user also linked from a native root: one skill."""
    shared = _skill(tmp_path / "managed", "dup")
    linked = native_skills.NativeSkill(
        name="dup", description="", source="claude", owner_agent="claude",
        path=str(tmp_path / "native" / "dup"), real_path=str(shared.resolve()),
    )
    store = _Store(tmp_path / "managed", native=[linked], native_targets={linked.real_path: ["kimi"]})

    assert _sources(tmp_path, "kimi", store) == ["dup"]


def test_native_name_collision_still_favours_the_native_copy(tmp_path: Path) -> None:
    """Shared 'plan' vs a different native 'plan' in the target's own root."""
    _skill(tmp_path / "managed", "plan")
    _skill(tmp_path / "native", "plan")  # claude's own, different directory
    store = _Store(tmp_path / "managed")

    assert _sources(tmp_path, "claude", store) == []


def test_every_shared_root_reader_is_declared() -> None:
    """The 'automatic' matrix cells come from this flag; keep it honest."""
    readers = sorted(
        key for key, spec in VENDORS.items()
        if spec.skills_wiring is not None and spec.skills_wiring.reads_shared_root
    )
    # Verified 2026-08-15 against each binary / official docs.
    assert readers == ["codex", "copilot", "cursor", "grok", "muse", "opencode"]
