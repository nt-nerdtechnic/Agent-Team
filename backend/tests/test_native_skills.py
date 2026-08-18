from __future__ import annotations

import os
from pathlib import Path

import pytest

from agent_team_backend import native_skills


def _skill(root: Path, name: str, description: str = "d") -> Path:
    path = root / name
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\nbody\n", encoding="utf-8"
    )
    return path


def _snapshot(home: Path) -> set[tuple[str, int, int]]:
    """Every path under home with size and mtime — the write-nothing witness."""
    out = set()
    for dirpath, dirnames, filenames in os.walk(home):
        for name in dirnames + filenames:
            p = Path(dirpath) / name
            st = p.lstat()
            out.add((str(p), st.st_size, st.st_mtime_ns))
    return out


def test_scan_reads_every_native_root(tmp_path: Path) -> None:
    home = tmp_path
    _skill(home / ".claude" / "skills", "alpha", "A")
    _skill(home / ".copilot" / "skills", "beta", "B")
    _skill(home / ".gemini" / "skills", "gamma", "G")

    found = {s.name: s for s in native_skills.scan(home)}

    assert set(found) == {"alpha", "beta", "gamma"}
    assert found["alpha"].source == "claude"
    assert found["alpha"].description == "A"
    assert found["beta"].owner_agent == "copilot"
    # gemini's directory belongs to antigravity as an agent.
    assert found["gamma"].owner_agent == "antigravity"


def test_scan_never_writes(tmp_path: Path) -> None:
    home = tmp_path
    _skill(home / ".claude" / "skills", "alpha")
    (home / ".copilot" / "skills").mkdir(parents=True)
    before = _snapshot(home)

    native_skills.scan(home)
    native_skills.scan(home)

    assert _snapshot(home) == before


def test_scan_dedupes_links_to_one_directory(tmp_path: Path) -> None:
    """ego-browser: one real directory reachable from three roots."""
    home = tmp_path
    real = tmp_path / "share" / "ego-skills"
    _skill(real.parent, "ego-skills")
    for rel in ((".claude", "skills"), (".grok", "skills"), (".qwen", "skills")):
        root = home.joinpath(*rel)
        root.mkdir(parents=True, exist_ok=True)
        (root / "ego-browser").symlink_to(real, target_is_directory=True)

    found = native_skills.scan(home)

    assert len(found) == 1
    assert found[0].source == "claude"  # first root in NATIVE_ROOTS order
    assert set(found[0].aliases) == {"grok", "qwen"}
    assert found[0].real_path == str(real.resolve())


def test_scan_keeps_separate_copies_apart(tmp_path: Path) -> None:
    """Same name in two roots but different directories = two skills."""
    home = tmp_path
    _skill(home / ".claude" / "skills", "plan")
    _skill(home / ".codex" / "skills", "plan")

    found = native_skills.scan(home)

    assert [(s.source, s.name) for s in found] == [("claude", "plan"), ("codex", "plan")]


def test_shared_root_is_not_a_native_root(tmp_path: Path) -> None:
    home = tmp_path
    _skill(home / ".agents" / "skills", "shared")

    assert native_skills.scan(home) == []


def test_exclude_real_paths_drops_links_into_the_shared_root(tmp_path: Path) -> None:
    home = tmp_path
    shared = _skill(home / ".agents" / "skills", "shared")
    root = home / ".claude" / "skills"
    root.mkdir(parents=True)
    (root / "shared").symlink_to(shared, target_is_directory=True)
    _skill(root, "own")

    found = native_skills.scan(home, exclude_real_paths={shared.resolve()})

    assert [s.name for s in found] == ["own"]


def test_broken_skill_is_listed_but_marked_invalid(tmp_path: Path) -> None:
    home = tmp_path
    (home / ".codex" / "skills" / "runtime").mkdir(parents=True)  # no SKILL.md
    bad = home / ".codex" / "skills" / "bad"
    bad.mkdir()
    (bad / "SKILL.md").write_text("no frontmatter here", encoding="utf-8")

    found = {s.name: s for s in native_skills.scan(home)}

    assert found["runtime"].valid is False
    assert "missing" in found["runtime"].error
    assert found["bad"].valid is False
    assert "frontmatter" in found["bad"].error


@pytest.mark.parametrize("name", [".hidden", "UPPER", "has space", "..", "a" * 65])
def test_scan_skips_names_no_cli_would_load(tmp_path: Path, name: str) -> None:
    root = tmp_path / ".claude" / "skills"
    root.mkdir(parents=True)
    try:
        (root / name).mkdir()
    except OSError:
        pytest.skip("filesystem rejects this name")

    assert native_skills.scan(tmp_path) == []


def test_missing_and_unreadable_roots_are_skipped(tmp_path: Path) -> None:
    home = tmp_path
    _skill(home / ".claude" / "skills", "alpha")
    (home / ".copilot").mkdir()
    (home / ".copilot" / "skills").write_text("a file, not a directory", encoding="utf-8")

    assert [s.name for s in native_skills.scan(home)] == ["alpha"]
