"""In-process `.gitignore` matcher for the filesystem watcher.

Why not shell out: the watcher asks "is this path interesting?" once per
filesystem event, on the observer thread. `git check-ignore` would put a
subprocess on that path — spending exactly the resource the filter exists to
save, on every write of every build artefact. So the rules are parsed here and
matched in memory.

Why not a library: the backend ships as a PyInstaller bundle, and this is the
only caller. The subset of gitignore(5) implemented is the whole of it that
appears in real ignore files:

    blank lines and `#` comments      `!` negation (last match wins)
    trailing `/` (directories only)   leading or embedded `/` (anchored)
    `*` and `?` (never cross `/`)     `**` (crosses `/`)
    `[a-z]` character classes         `\\` escapes

Faithful to two git rules that a naive "any pattern matches" implementation
gets wrong:

  * Precedence is per directory, deepest .gitignore last — a nested file
    overrides the root's, and within one file the last matching line wins.
  * Once a directory is excluded, nothing under it can be brought back by a
    later negation. git does not descend into it, so neither do we.

Correctness here is silent when wrong — a mis-ignored path just stops
refreshing the UI — so `test_gitignore.py` cross-checks this module against
real `git check-ignore` output rather than against its own expectations.
"""

from __future__ import annotations

import re
import threading
from pathlib import Path

# A pathological ignore file should not become a pathological regex list. Both
# limits are far above anything real: the largest .gitignore in the wild
# (github/gitignore's aggregate) is well under 1000 lines.
_MAX_IGNORE_BYTES = 256 * 1024
_MAX_PATTERNS_PER_FILE = 2000


class _Rule:
    """One compiled ignore line."""

    __slots__ = ("regex", "negated", "dir_only", "anchored")

    def __init__(
        self, regex: re.Pattern[str], negated: bool, dir_only: bool, anchored: bool
    ) -> None:
        self.regex = regex
        self.negated = negated
        self.dir_only = dir_only
        # Decides what the regex is matched against: the path relative to the
        # directory holding this rule, or just the last segment.
        self.anchored = anchored


def _split_escaped(line: str) -> str:
    """Strip trailing whitespace that is not backslash-escaped.

    gitignore(5): "Trailing spaces are ignored unless they are quoted with a
    backslash". A line of `build \\ ` keeps one space and drops the rest.
    """
    i = len(line)
    while i > 0 and line[i - 1] in " \t":
        # An odd number of backslashes before this space escapes it.
        backslashes = 0
        j = i - 2
        while j >= 0 and line[j] == "\\":
            backslashes += 1
            j -= 1
        if backslashes % 2 == 1:
            break
        i -= 1
    return line[:i]


def _class_end(pat: str, start: int) -> int:
    """Index of the `]` closing the bracket expression opened at `start`.

    A `]` immediately after the opening bracket (or after its negation) is a
    literal, and a backslash escapes the next character — so neither closes the
    class. -1 when the class is never closed, which makes the `[` a literal.
    """
    i = start + 1
    if i < len(pat) and pat[i] in "!^":
        i += 1
    if i < len(pat) and pat[i] == "]":
        i += 1
    while i < len(pat):
        if pat[i] == "\\" and i + 1 < len(pat):
            i += 2
            continue
        if pat[i] == "]":
            return i
        i += 1
    return -1


def _char_class(body: str) -> str:
    """A gitignore bracket expression as a Python one.

    Escapes are re-emitted rather than passed through. `[a\\-z]` is the three
    characters a, - and z; handing `a\\-z` straight to `re` makes it the range
    `\\`..`z` instead, which silently swallows `b`, `]` and `^` — and a
    swallowed path is one the Git panel quietly stops reporting.
    """
    out = ["["]
    i = 0
    if body.startswith(("!", "^")):
        out.append("^")
        i = 1
    if i < len(body) and body[i] == "]":
        out.append("\\]")
        i += 1
    while i < len(body):
        c = body[i]
        if c == "\\" and i + 1 < len(body):
            out.append(re.escape(body[i + 1]))
            i += 2
            continue
        out.append("\\" + c if c in "^]\\" else c)
        i += 1
    out.append("]")
    return "".join(out)


def _glob_to_regex(pat: str) -> str | None:
    """Translate one gitignore glob into a regex body.

    `*` and `?` stop at a separator; `**` is the only wildcard that crosses
    one, and only in the three positions git gives it meaning (`**/` leading,
    `/**` trailing, `/**/` embedded). A `**` anywhere else is, per gitignore(5),
    just two `*` — which is what falling through to the `*` branch produces.
    """
    out: list[str] = []
    i = 0
    n = len(pat)
    while i < n:
        c = pat[i]
        if c == "\\" and i + 1 < n:
            out.append(re.escape(pat[i + 1]))
            i += 2
            continue
        if c == "*":
            if pat.startswith("**/", i) and (i == 0 or pat[i - 1] == "/"):
                out.append("(?:.*/)?")  # leading `**/`: any number of dirs
                i += 3
                continue
            if pat.startswith("/**", i) and i + 3 == n:
                out.append("/.*")  # trailing `/**`: everything below
                i += 3
                continue
            if pat.startswith("/**/", i):
                out.append("/(?:.*/)?")  # embedded `/**/`
                i += 4
                continue
            out.append("[^/]*")
            i += 1
            continue
        if c == "?":
            out.append("[^/]")
            i += 1
            continue
        if c == "[":
            close = _class_end(pat, i)
            if close == -1:
                # git drops a pattern whose bracket is never closed — it
                # matches nothing at all, rather than falling back to a literal
                # `[`. Verified against `git check-ignore`; treating it as a
                # literal made the matcher ignore a file git reports.
                return None
            out.append(_char_class(pat[i + 1 : close]))
            i = close + 1
            continue
        out.append(re.escape(c))
        i += 1
    return "".join(out)


def _compile(line: str) -> _Rule | None:
    """One line of a .gitignore into a rule, or None if it is not a rule."""
    line = _split_escaped(line.rstrip("\n").rstrip("\r"))
    if not line or line.startswith("#"):
        return None
    negated = False
    if line.startswith("!"):
        negated = True
        line = line[1:]
    elif line.startswith("\\") and len(line) > 1 and line[1] in "#!":
        line = line[1:]
    if not line:
        return None
    dir_only = line.endswith("/")
    if dir_only:
        line = line[:-1]
        if not line:
            return None
    # A slash anywhere but the very end anchors the pattern to the directory
    # holding the .gitignore; without one it matches a basename at any depth.
    anchored = "/" in line
    if line.startswith("/"):
        line = line[1:]
        if not line:
            return None
    body = _glob_to_regex(line)
    if body is None:
        return None
    try:
        regex = re.compile("^" + body + "$")
    except re.error:
        return None
    return _Rule(regex, negated, dir_only, anchored)


def _parse(text: str) -> tuple[list[_Rule], list[_Rule]]:
    """Split a .gitignore's rules into (anchored, basename-matched).

    Kept apart because they are matched against different strings — the path
    relative to the ignore file's directory, and the last segment — and doing
    that split once per file beats doing it once per event.
    """
    anchored: list[_Rule] = []
    floating: list[_Rule] = []
    for idx, raw in enumerate(text.splitlines()):
        if idx >= _MAX_PATTERNS_PER_FILE:
            break
        rule = _compile(raw)
        if rule is None:
            continue
        (anchored if rule.anchored else floating).append(rule)
    return anchored, floating


class GitIgnore:
    """The ignore rules in effect under one repo root.

    Files are read on first use and cached per directory, so a steady stream of
    events in an already-seen tree touches no disk at all. `invalidate()` drops
    one directory's entry when its .gitignore is written.
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        # rel-dir parts -> (anchored rules, basename rules); () is the root.
        self._cache: dict[tuple[str, ...], tuple[list[_Rule], list[_Rule]]] = {}
        self._lock = threading.Lock()

    def invalidate(self, dir_parts: tuple[str, ...] = ()) -> None:
        """Forget one directory's rules. Called when its .gitignore changes."""
        with self._lock:
            self._cache.pop(dir_parts, None)

    def _rules_for(self, dir_parts: tuple[str, ...]) -> tuple[list[_Rule], list[_Rule]]:
        with self._lock:
            hit = self._cache.get(dir_parts)
        if hit is not None:
            return hit
        d = self._root.joinpath(*dir_parts)
        texts: list[str] = []
        # `.git/info/exclude` is a repo-local ignore file with the same syntax
        # and lower precedence than the root .gitignore. Navide's own MCP
        # wiring writes to it, so skipping it would leave those paths noisy.
        if not dir_parts:
            texts.append(self._read(self._root / ".git" / "info" / "exclude"))
        texts.append(self._read(d / ".gitignore"))
        anchored: list[_Rule] = []
        floating: list[_Rule] = []
        for text in texts:
            if not text:
                continue
            a, f = _parse(text)
            anchored.extend(a)
            floating.extend(f)
        out = (anchored, floating)
        with self._lock:
            self._cache[dir_parts] = out
        return out

    @staticmethod
    def _read(path: Path) -> str:
        try:
            if path.stat().st_size > _MAX_IGNORE_BYTES:
                return ""
            return path.read_text(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            return ""

    def ignored(self, parts: tuple[str, ...], is_dir: bool) -> bool:
        """True if git would ignore this workspace-relative path.

        Each ancestor is tested before the path itself: git never looks inside
        an excluded directory, so an excluded ancestor settles the answer and
        no negation deeper down can undo it.
        """
        if not parts:
            return False
        # Every directory above the path contributes rules, and each prefix is
        # judged against all of them. Fetching the sets once here rather than
        # inside the prefix loop is what keeps this O(depth) lookups instead of
        # O(depth²) — it matters because a `git checkout` can put thousands of
        # events through this on the watcher's single dispatch thread.
        levels = [self._rules_for(parts[:d]) for d in range(len(parts))]
        for depth in range(1, len(parts) + 1):
            # Only the final component's kind is known from the event; every
            # prefix of it is a directory by construction.
            candidate_is_dir = is_dir if depth == len(parts) else True
            if self._match(parts, depth, candidate_is_dir, levels):
                return True
        return False

    def _match(
        self,
        parts: tuple[str, ...],
        depth: int,
        is_dir: bool,
        levels: list[tuple[list[_Rule], list[_Rule]]],
    ) -> bool:
        """Whether `parts` is excluded by the ignore files above it.

        Shallowest file first, so a nested .gitignore's rules are applied last
        and win; within one file the last matching line wins, which falls out
        of overwriting `decision` as we go.
        """
        decision: bool | None = None
        name = parts[depth - 1]
        for base_depth in range(depth):
            anchored, floating = levels[base_depth]
            if not anchored and not floating:
                continue
            rel = "/".join(parts[base_depth:depth])
            for rule in anchored:
                if rule.dir_only and not is_dir:
                    continue
                if rule.regex.match(rel):
                    decision = not rule.negated
            # A pattern with no slash is matched against the basename, at any
            # depth below the file that declared it.
            for rule in floating:
                if rule.dir_only and not is_dir:
                    continue
                if rule.regex.match(name):
                    decision = not rule.negated
        return decision is True
