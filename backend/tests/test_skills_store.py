from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend import skills_store
from agent_team_backend.skills_store import (
    SKILL_FILE_SIZE_LIMIT,
    SkillConflictError,
    SkillNotFoundError,
    SkillValidationError,
    SkillsStore,
    SkillsStoreError,
)


@pytest.fixture
def store(tmp_path: Path) -> SkillsStore:
    return SkillsStore(
        root=tmp_path / "skills",
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[],
    )


def test_create_list_and_get_skill(store: SkillsStore) -> None:
    created = store.create_skill("review-code", "Review a change")

    assert created["skill"]["fields"] == {
        "name": "review-code",
        "description": "Review a change",
    }
    assert created["skill"]["enabled"] is True
    assert created["skill"]["native_conflict"] is False
    assert store.runtime_root.joinpath("review-code").is_symlink()
    listed = store.list_skills()
    assert listed["skills"] == [
        {
            "name": "review-code",
            "description": "Review a change",
            "enabled": True,
            "native_conflict": False,
            "targets": None,
            "revision": created["skill"]["revision"],
            "valid": True,
            "path": str(store.root / "review-code"),
            "attachments": [],
        }
    ]
    assert listed["root"] == str(store.root)
    assert {entry["key"] for entry in listed["agents"]} >= {"claude", "kimi", "pi", "opencode"}


def test_save_preserves_unknown_nested_frontmatter_and_body(store: SkillsStore) -> None:
    created = store.create_skill("review-code", "Before")
    skill_file = store.root / "review-code" / "SKILL.md"
    skill_file.write_text(
        "---\n"
        "name: review-code\n"
        "description: Before\n"
        "metadata:\n"
        "  openclaw:\n"
        "    emoji: 🧭\n"
        "allowed-tools:\n"
        "- Read\n"
        "---\n"
        "# Existing body\n\nKeep this.\n",
        encoding="utf-8",
    )
    current = store.get_skill("review-code")["skill"]

    saved = store.save_skill(
        "review-code",
        {"description": "After", "user-invocable": True},
        current["body"],
        current["revision"],
    )["skill"]

    assert saved["description"] == "After"
    assert saved["fields"]["metadata"] == {"openclaw": {"emoji": "🧭"}}
    assert saved["fields"]["allowed-tools"] == ["Read"]
    assert saved["fields"]["user-invocable"] is True
    assert saved["body"] == "# Existing body\n\nKeep this.\n"
    assert saved["revision"] != created["skill"]["revision"]


def test_stale_save_does_not_modify_file(store: SkillsStore) -> None:
    skill = store.create_skill("review-code", "Before")["skill"]
    skill_file = store.root / "review-code" / "SKILL.md"
    skill_file.write_text(skill_file.read_text(encoding="utf-8") + "external", encoding="utf-8")
    before = skill_file.read_bytes()

    with pytest.raises(SkillConflictError):
        store.save_skill("review-code", {"description": "After"}, "body", skill["revision"])

    assert skill_file.read_bytes() == before


@pytest.mark.parametrize("name", ["../escape", "UPPER", ".hidden", "two words", "a" * 65])
def test_create_rejects_invalid_names(store: SkillsStore, name: str) -> None:
    with pytest.raises(SkillValidationError):
        store.create_skill(name, "Description")

    assert not store.root.exists()


def test_symlink_skill_directory_is_rejected(store: SkillsStore, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text("---\nname: escape\n---\n", encoding="utf-8")
    store.root.mkdir()
    (store.root / "escape").symlink_to(outside, target_is_directory=True)

    with pytest.raises(SkillValidationError):
        store.get_skill("escape")

    listed = store.list_skills()["skills"]
    assert listed[0]["valid"] is False
    assert listed[0]["native_conflict"] is False


def test_symlink_root_is_rejected_by_every_public_store_operation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    outside = tmp_path / "outside"
    skill_dir = outside / "existing"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: existing\ndescription: Outside\n---\nbody",
        encoding="utf-8",
    )
    root_link = tmp_path / "skills-link"
    root_link.symlink_to(outside, target_is_directory=True)
    store = SkillsStore(
        root=root_link,
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[],
    )
    trashed: list[str] = []
    monkeypatch.setattr(skills_store, "send2trash", trashed.append)

    operations = [
        store.list_skills,
        lambda: store.get_skill("existing"),
        lambda: store.create_skill("new-skill", "New"),
        lambda: store.save_skill("existing", {}, "body", "revision"),
        lambda: store.set_enabled("existing", False),
        lambda: store.delete_skill("existing"),
        store.rebuild_runtime_projection,
    ]
    for operation in operations:
        with pytest.raises(SkillValidationError, match="root"):
            operation()

    assert trashed == []
    assert not (outside / "new-skill").exists()
    assert (skill_dir / "SKILL.md").exists()


def test_symlink_attachment_is_rejected(store: SkillsStore, tmp_path: Path) -> None:
    store.create_skill("review-code", "Review")
    outside = tmp_path / "secret.txt"
    outside.write_text("secret", encoding="utf-8")
    (store.root / "review-code" / "secret.txt").symlink_to(outside)

    with pytest.raises(SkillValidationError):
        store.get_skill("review-code")


def test_malformed_yaml_fails_without_mutation(store: SkillsStore) -> None:
    store.create_skill("review-code", "Review")
    skill_file = store.root / "review-code" / "SKILL.md"
    skill_file.write_text("---\nname: [unterminated\n---\nbody\n", encoding="utf-8")
    before = skill_file.read_bytes()

    with pytest.raises(SkillValidationError):
        store.get_skill("review-code")

    assert skill_file.read_bytes() == before


def test_oversized_skill_fails_without_mutation(store: SkillsStore) -> None:
    store.create_skill("review-code", "Review")
    skill_file = store.root / "review-code" / "SKILL.md"
    skill_file.write_bytes(b"x" * (SKILL_FILE_SIZE_LIMIT + 1))
    before = skill_file.read_bytes()

    with pytest.raises(SkillValidationError, match="size limit"):
        store.get_skill("review-code")

    assert skill_file.read_bytes() == before


def test_oversized_save_fails_without_mutation(store: SkillsStore) -> None:
    skill = store.create_skill("review-code", "Review")["skill"]
    skill_file = store.root / "review-code" / "SKILL.md"
    before = skill_file.read_bytes()

    with pytest.raises(SkillValidationError, match="size limit"):
        store.save_skill(
            "review-code",
            {},
            "x" * (SKILL_FILE_SIZE_LIMIT + 1),
            skill["revision"],
        )

    assert skill_file.read_bytes() == before


def test_enable_state_controls_runtime_projection(store: SkillsStore) -> None:
    store.create_skill("first", "First")
    store.create_skill("second", "Second")

    disabled = store.set_enabled("first", False)["skill"]

    assert disabled["enabled"] is False
    assert not (store.runtime_root / "first").exists()
    assert (store.runtime_root / "second").is_symlink()
    assert (store.root / "first" / "SKILL.md").exists()
    assert json.loads(store.state_path.read_text(encoding="utf-8")) == {
        "enabled": {"first": False, "second": True}
    }


def test_rebuild_projection_is_idempotent_and_skips_invalid_skills(store: SkillsStore) -> None:
    store.create_skill("valid", "Valid")
    invalid_dir = store.root / "invalid"
    invalid_dir.mkdir()
    (invalid_dir / "SKILL.md").write_text("not frontmatter", encoding="utf-8")

    first = store.rebuild_runtime_projection()
    second = store.rebuild_runtime_projection()

    assert first == second == store.runtime_root
    assert sorted(path.name for path in store.runtime_root.iterdir()) == ["valid"]


def test_delete_moves_directory_to_trash_and_removes_state(
    store: SkillsStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    store.create_skill("review-code", "Review")
    trashed: list[str] = []
    trash = tmp_path / "Trash"
    trash.mkdir()

    def fake_send2trash(path: str) -> None:
        trashed.append(path)
        Path(path).rename(trash / Path(path).name)

    monkeypatch.setattr(skills_store, "send2trash", fake_send2trash)

    assert store.delete_skill("review-code") == {"name": "review-code", "deleted": True}
    assert trashed == [str(store.root / "review-code")]
    assert store.list_skills()["skills"] == []
    assert json.loads(store.state_path.read_text(encoding="utf-8")) == {"enabled": {}}
    assert list(store.runtime_root.iterdir()) == []


def test_delete_trash_failure_keeps_skill_and_state(
    store: SkillsStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.create_skill("review-code", "Review")

    def fail_send2trash(_path: str) -> None:
        raise OSError("trash unavailable")

    monkeypatch.setattr(skills_store, "send2trash", fail_send2trash)

    with pytest.raises(SkillsStoreError, match="could not move"):
        store.delete_skill("review-code")

    assert (store.root / "review-code" / "SKILL.md").exists()
    assert store.get_skill("review-code")["skill"]["enabled"] is True


def test_delete_validates_state_before_moving_skill_to_trash(
    store: SkillsStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.create_skill("review-code", "Review")
    store.state_path.write_text("{invalid", encoding="utf-8")
    trashed: list[str] = []
    monkeypatch.setattr(skills_store, "send2trash", trashed.append)

    with pytest.raises(SkillValidationError, match="state"):
        store.delete_skill("review-code")

    assert trashed == []
    assert (store.root / "review-code" / "SKILL.md").exists()


def test_projection_refresh_failure_does_not_fail_committed_mutations(
    store: SkillsStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def fail_projection() -> Path:
        raise OSError("runtime unavailable")

    monkeypatch.setattr(store, "rebuild_runtime_projection", fail_projection)
    created = store.create_skill("review-code", "Review")["skill"]
    saved = store.save_skill(
        "review-code",
        {"description": "Updated"},
        "body",
        created["revision"],
    )["skill"]
    disabled = store.set_enabled("review-code", False)["skill"]
    trash = tmp_path / "Trash"
    trash.mkdir()
    monkeypatch.setattr(
        skills_store,
        "send2trash",
        lambda path: Path(path).rename(trash / Path(path).name),
    )

    deleted = store.delete_skill("review-code")

    assert saved["description"] == "Updated"
    assert disabled["enabled"] is False
    assert deleted == {"name": "review-code", "deleted": True}
    assert (trash / "review-code" / "SKILL.md").exists()


def test_missing_skill_raises_not_found(store: SkillsStore) -> None:
    with pytest.raises(SkillNotFoundError):
        store.get_skill("missing")


def test_skill_payloads_report_native_claude_or_codex_name_conflicts(
    tmp_path: Path,
) -> None:
    claude_native = tmp_path / "claude-native"
    codex_native = tmp_path / "codex-native"
    (claude_native / "review-code").mkdir(parents=True)
    codex_native.mkdir()
    (codex_native / "explain-code").write_text("native entry", encoding="utf-8")
    store = SkillsStore(
        root=tmp_path / "managed",
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[claude_native, codex_native],
    )

    review = store.create_skill("review-code", "Review")["skill"]
    explain = store.create_skill("explain-code", "Explain")["skill"]
    assert review["native_conflict"] is True
    assert explain["native_conflict"] is True
    assert {item["name"]: item["native_conflict"] for item in store.list_skills()["skills"]} == {
        "explain-code": True,
        "review-code": True,
    }
    assert store.get_skill("review-code")["skill"]["native_conflict"] is True

    saved = store.save_skill(
        "review-code",
        {"description": "Updated"},
        review["body"],
        review["revision"],
    )["skill"]
    assert saved["native_conflict"] is True
    assert store.set_enabled("review-code", False)["skill"]["native_conflict"] is True


def test_native_conflict_inspection_failure_is_non_blocking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    native_root = tmp_path / "native"
    native_root.mkdir()
    native_entry = native_root / "review-code"
    original_is_dir = Path.is_dir

    def flaky_is_dir(path: Path) -> bool:
        if path == native_entry:
            raise OSError("permission denied")
        return original_is_dir(path)

    monkeypatch.setattr(Path, "is_dir", flaky_is_dir)
    store = SkillsStore(
        root=tmp_path / "managed",
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[native_root],
    )

    created = store.create_skill("review-code", "Review")

    assert created["skill"]["native_conflict"] is False
    assert store.list_skills()["skills"][0]["native_conflict"] is False


def test_broken_native_symlink_reports_name_conflict(tmp_path: Path) -> None:
    native_root = tmp_path / "native"
    native_root.mkdir()
    (native_root / "review-code").symlink_to(tmp_path / "missing-skill")
    store = SkillsStore(
        root=tmp_path / "managed",
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[native_root],
    )

    created = store.create_skill("review-code", "Review")

    assert created["skill"]["native_conflict"] is True
    assert store.list_skills()["skills"][0]["native_conflict"] is True


def test_targets_default_to_every_agent_and_stay_out_of_the_state_file(
    store: SkillsStore,
) -> None:
    store.create_skill("shared", "Shared")

    assert store.get_skill("shared")["skill"]["targets"] is None
    assert store.targets_for("kimi") == ["shared"]
    # No targets set means no "targets" key at all: an untouched library keeps
    # the state file byte-identical to what earlier versions wrote.
    assert json.loads(store.state_path.read_text(encoding="utf-8")) == {
        "enabled": {"shared": True}
    }


def test_set_targets_restricts_delivery_and_survives_a_reload(store: SkillsStore) -> None:
    store.create_skill("only-pi", "Pi only")
    store.create_skill("everywhere", "All agents")

    store.set_targets("only-pi", ["pi"])

    assert store.targets_for("pi") == ["everywhere", "only-pi"]
    assert store.targets_for("claude") == ["everywhere"]
    assert json.loads(store.state_path.read_text(encoding="utf-8"))["targets"] == {
        "only-pi": ["pi"]
    }
    assert store.list_skills()["skills"][1]["targets"] == ["pi"]


def test_set_targets_none_restores_every_agent(store: SkillsStore) -> None:
    store.create_skill("scoped", "Scoped")
    store.set_targets("scoped", ["pi"])

    store.set_targets("scoped", None)

    assert store.targets_for("claude") == ["scoped"]
    assert "targets" not in json.loads(store.state_path.read_text(encoding="utf-8"))


def test_empty_targets_deliver_to_nobody(store: SkillsStore) -> None:
    store.create_skill("parked", "Parked")

    store.set_targets("parked", [])

    assert store.targets_for("claude") == []
    assert store.get_skill("parked")["skill"]["targets"] == []


def test_disabled_skill_is_never_targeted(store: SkillsStore) -> None:
    store.create_skill("off", "Off")
    store.set_targets("off", ["pi"])

    store.set_enabled("off", False)

    assert store.targets_for("pi") == []
    # Toggling enabled must not drop the target list it was carrying.
    assert store.get_skill("off")["skill"]["targets"] == ["pi"]


def test_set_targets_rejects_unusable_agent_keys(store: SkillsStore) -> None:
    store.create_skill("guarded", "Guarded")

    for agents in (["../escape"], ["UPPER"], [""], "pi", [1]):
        with pytest.raises(SkillValidationError):
            store.set_targets("guarded", agents)  # type: ignore[arg-type]

    assert store.get_skill("guarded")["skill"]["targets"] is None


def test_set_targets_requires_an_existing_skill(store: SkillsStore) -> None:
    with pytest.raises(SkillNotFoundError):
        store.set_targets("missing", ["pi"])


def test_agent_targets_reports_every_vendors_capability() -> None:
    states = {entry["key"]: entry["state"] for entry in skills_store.agent_targets()}

    # Every CLI with a skills mechanism is wired to the managed library.
    for key in (
        "claude", "codex", "copilot", "qwen", "kimi", "grok",
        "opencode", "pi", "muse", "cursor", "antigravity",
    ):
        assert states[key] == "wired", key
    # No skills mechanism exists in these CLIs at all, so the matrix must show
    # them as impossible rather than merely switched off.
    assert states["kilo"] == "unsupported"
    assert states["aider"] == "unsupported"
    assert set(states.values()) <= {"wired", "planned", "unsupported"}
