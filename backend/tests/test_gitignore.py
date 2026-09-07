"""The matcher is checked against git itself, not against expectations.

A hand-written table of "this should be ignored" only ever encodes what the
author already believed. Since a wrong answer here is silent — a mis-ignored
path just stops refreshing the Git panel — the table is generated instead: a
real repo is built on disk, `git check-ignore` is asked about every path in it,
and the matcher has to agree on all of them.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agent_team_backend.gitignore import GitIgnore

# Ignore files covering the syntax that shows up in real projects, plus the
# three rules a naive implementation gets wrong: nested override, negation
# order, and "no negation escapes an excluded directory".
IGNORE_FILES: dict[str, str] = {
    ".gitignore": """
# comment, and a blank line follow

node_modules/
dist-release/
dist-local/
dist-plugins/
*.log
!keep.log
build
/rooted.txt
docs/*.tmp
**/deep-anywhere/
cache/**
src/**/generated.ts
question?.txt
range[0-9].bin
trailing-space \n
""",
    "packages/.gitignore": """
# deeper file wins over the root's
!*.log
local-only/
""",
    ".git/info/exclude": """
excluded-by-info/
*.infotmp
""",
}

# Every path here is created on disk (files and dirs), then both git and the
# matcher are asked about it. Mixes hits, near-misses, and the paths whose
# answers only differ if precedence is implemented correctly.
PATHS: list[str] = [
    "README.md",
    "rooted.txt",
    "sub/rooted.txt",
    "build",
    "sub/build",
    "app.log",
    "keep.log",
    "sub/app.log",
    "packages/app.log",
    "packages/nested/app.log",
    "packages/local-only/x.txt",
    "local-only/x.txt",
    "node_modules/left-pad/index.js",
    "sub/node_modules/x.js",
    "dist-release/mac/Navide.app",
    "dist-local/out.zip",
    "dist-plugins/git/manifest.json",
    "dist-other/keep.txt",
    "docs/notes.tmp",
    "docs/nested/notes.tmp",
    "a/b/deep-anywhere/f.txt",
    "deep-anywhere/f.txt",
    "cache/a/b/c.bin",
    "src/x/y/generated.ts",
    "src/generated.ts",
    "question1.txt",
    "questionAB.txt",
    "range7.bin",
    "rangeX.bin",
    "excluded-by-info/f.txt",
    "scratch.infotmp",
    ".gitignore",
]

DIRS: set[str] = {
    "build",
    "sub/build",
    "dist-other",
    "local-only",
}


def _git(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=30
    )


@pytest.fixture(scope="module")
def repo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("ignore-repo")
    init = _git("init", "-q", cwd=root)
    if init.returncode != 0:
        pytest.skip(f"git init unavailable: {init.stderr.strip()}")
    # Subjects first, rules second. `.gitignore` is itself one of the paths
    # under test, and creating it as a subject last would overwrite the rules
    # with "x" — leaving git and the matcher agreeing that nothing is ignored,
    # which every comparison in this file would have called a pass.
    for rel in PATHS:
        if rel in IGNORE_FILES:
            continue
        p = root / rel
        if rel in DIRS:
            p.mkdir(parents=True, exist_ok=True)
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("x", encoding="utf-8")
    for rel, text in IGNORE_FILES.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        # Written verbatim: the trailing-space line is part of what is tested.
        p.write_text(text.lstrip("\n"), encoding="utf-8")
    # The sweep compares two answers and passes when they agree, including when
    # both are "not ignored" — so it cannot notice that the rules went missing.
    # Assert the fixture built what it meant to before any comparison runs.
    assert "node_modules/" in (root / ".gitignore").read_text(encoding="utf-8")
    assert _git_says_ignored(root, "node_modules/left-pad/index.js")
    return root


def _git_says_ignored(root: Path, rel: str) -> bool:
    # `check-ignore` exits 0 when the path is ignored, 1 when it is not.
    return _git("check-ignore", "-q", "--", rel, cwd=root).returncode == 0


@pytest.mark.parametrize("rel", PATHS)
def test_matches_git_check_ignore(repo: Path, rel: str) -> None:
    gi = GitIgnore(repo)
    parts = tuple(Path(rel).parts)
    is_dir = (repo / rel).is_dir()
    assert gi.ignored(parts, is_dir) == _git_says_ignored(repo, rel), (
        f"{rel}: git says "
        f"{'ignored' if _git_says_ignored(repo, rel) else 'not ignored'}"
    )


def test_the_case_this_was_written_for(repo: Path) -> None:
    """The watcher's hardcoded list has `dist` and misses `dist-release`.

    Segment equality is why: `"dist-release" != "dist"`. This is the whole
    reported symptom — a packaging run writing into dist-release fired a git
    refresh per file — so it gets its own named test rather than living only
    inside the parametrised sweep.
    """
    gi = GitIgnore(repo)
    for name in ("dist-release", "dist-local", "dist-plugins"):
        assert gi.ignored((name, "x.txt"), False), name
    # And the near-miss stays visible: it is not in any ignore file.
    assert not gi.ignored(("dist-other", "keep.txt"), False)


def test_nothing_below_an_excluded_dir_is_rescued(repo: Path) -> None:
    """`!*.log` in packages/ must not pull a file out of node_modules/.

    git never descends into an excluded directory, so the negation is never
    even considered. Implementations that test the full path against every
    pattern get this wrong and un-ignore the file.
    """
    assert gi_ignored(repo, "node_modules/pkg/app.log")
    assert _git_says_ignored(repo, "node_modules/pkg/app.log")


def test_a_deeper_ignore_file_overrides_the_root(repo: Path) -> None:
    assert gi_ignored(repo, "app.log")
    assert not gi_ignored(repo, "packages/app.log")


def test_reads_git_info_exclude(repo: Path) -> None:
    assert gi_ignored(repo, "scratch.infotmp")


def gi_ignored(root: Path, rel: str) -> bool:
    return GitIgnore(root).ignored(tuple(Path(rel).parts), (root / rel).is_dir())


def test_rules_are_cached_and_invalidated(repo: Path, tmp_path: Path) -> None:
    """Re-reading a .gitignore per event would be the same I/O this avoids."""
    root = tmp_path / "cache-repo"
    (root / "sub").mkdir(parents=True)
    (root / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
    gi = GitIgnore(root)
    assert gi.ignored(("ignored.txt",), False)
    # Rewritten on disk, but the cached rules stand until told otherwise.
    (root / ".gitignore").write_text("other.txt\n", encoding="utf-8")
    assert gi.ignored(("ignored.txt",), False)
    gi.invalidate(())
    assert not gi.ignored(("ignored.txt",), False)
    assert gi.ignored(("other.txt",), False)


def test_unreadable_or_absent_ignore_file_is_not_an_error(tmp_path: Path) -> None:
    gi = GitIgnore(tmp_path / "does-not-exist")
    assert not gi.ignored(("anything.txt",), False)


def test_oversized_ignore_file_is_skipped_rather_than_parsed(tmp_path: Path) -> None:
    root = tmp_path / "huge"
    root.mkdir()
    (root / ".gitignore").write_text("x\n" * 200_000, encoding="utf-8")
    assert not GitIgnore(root).ignored(("x",), False)


# ── escapes and wildcards, the same way: git decides ─────────────────────────
#
# Kept in its own repo because some of these patterns (a bare `**`) match
# everything, which would drown out the sweep above. `[a\-z]` is here because
# the first implementation got it wrong in the direction that hurts: it read
# the escaped hyphen as a range and silently ignored `b.txt` and `].txt` —
# ordinary source files the Git panel would then stop reporting.

ESCAPE_CASES: list[tuple[str, list[str]]] = [
    (r"[a\-z].txt", ["a.txt", "z.txt", "-.txt", "b.txt", "].txt", "^.txt", "az.txt"]),
    (r"[!x]y.txt", ["yy.txt", "xy.txt", "zy.txt"]),
    (r"[]]x.txt", ["]x.txt", "ax.txt"]),
    (r"[a\]z]q.txt", ["aq.txt", "]q.txt", "zq.txt", "bq.txt"]),
    (r"[unclosed.txt", ["[unclosed.txt", "u.txt"]),
    (r"a**b", ["aXXb", "ab", "axb", "aX/Yb"]),
    ("**", ["f.txt", "d/n.txt"]),
    ("foo/**/bar", ["foo/bar", "foo/x/bar", "foo/x/y/bar", "other/bar"]),
    ("/rooted", ["rooted", "sub/rooted"]),
    (r"\#literal.txt", ["#literal.txt", "literal.txt"]),
    (r"\!bang.txt", ["!bang.txt", "bang.txt"]),
    ("docs/", ["docs/a.txt", "sub/docs/a.txt", "docs"]),
]


@pytest.mark.parametrize(
    ("pattern", "paths"), ESCAPE_CASES, ids=[c[0] for c in ESCAPE_CASES]
)
def test_escapes_and_wildcards_match_git(
    pattern: str, paths: list[str], tmp_path: pytest.TempPathFactory
) -> None:
    root = Path(str(tmp_path)) / "esc"
    root.mkdir()
    if _git("init", "-q", cwd=root).returncode != 0:
        pytest.skip("git unavailable")
    (root / ".gitignore").write_text(pattern + "\n", encoding="utf-8")
    for rel in paths:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.exists():
            p.write_text("x", encoding="utf-8")
    gi = GitIgnore(root)
    for rel in paths:
        mine = gi.ignored(tuple(Path(rel).parts), (root / rel).is_dir())
        theirs = _git_says_ignored(root, rel)
        assert mine == theirs, (
            f"pattern {pattern!r} path {rel!r}: "
            f"git says {'ignored' if theirs else 'not ignored'}, matcher says "
            f"{'ignored' if mine else 'not ignored'}"
        )


def test_an_escaped_hyphen_is_a_hyphen_not_a_range(tmp_path: Path) -> None:
    """The regression this class of test exists for, pinned on its own.

    `[a\\-z]` is the set {a, -, z}. Compiled naively it becomes the range
    `\\`..`z`, which swallows `b`, `]` and `^` — a silent over-ignore, the
    failure mode where the Git panel just stops mentioning a file.
    """
    root = tmp_path / "hyphen"
    root.mkdir()
    (root / ".gitignore").write_text("[a\\-z].txt\n", encoding="utf-8")
    gi = GitIgnore(root)
    for name in ("a.txt", "z.txt", "-.txt"):
        assert gi.ignored((name,), False), name
    for name in ("b.txt", "].txt", "^.txt", "az.txt"):
        assert not gi.ignored((name,), False), name
