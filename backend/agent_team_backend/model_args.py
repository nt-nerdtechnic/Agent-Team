"""Shape of a model / effort value, enforced before one can be stored.

A model id is data placed after a flag on a command line. If it can carry
whitespace or begin with a dash, `model = "sonnet --some-flag"` splits into
extra argv entries and hands the spawn a flag nobody asked for — reachable by
anyone who can open a pane, including a remote agent reached through cli_send.

This lives here, rather than only at the point where argv is assembled,
because the value is PERSISTED. Once a bad one reaches `pane.model` it is
replayed on every restore, far from any assembly site, and whether that is
safe then depends on every future assembler remembering to check. Refusing at
the two entry points instead makes "a stored model is argument-safe" an
invariant of the store rather than a convention among its readers.

The renderer keeps its own copy in
src/renderer/src/platform/plugin-shell/lib/cliModel.ts, since it is what
actually builds argv. The two are compared over shared vectors by
test_shape_guard_agrees_with_the_renderers_copy — behaviourally, not
textually, because the anchors differ on purpose: Python's `$` also matches
just before a trailing newline while JavaScript's does not, so `\\A/\\Z` here
is what makes the two engines agree.
"""

from __future__ import annotations

import re

# The dash is excluded from the FIRST position by giving that position its own
# class. `[A-Za-z0-9._:/-]+` alone matches a leading-dash flag, which is the
# whole attack it is meant to stop.
ARGUMENT_SAFE = re.compile(r"\A[A-Za-z0-9._:/][A-Za-z0-9._:/-]*\Z")


def refuse_unsafe_shape(model: str, effort: str) -> str:
    """Why these values cannot go on a command line, or "" if they can.

    Values are trimmed first, so surrounding whitespace is accepted rather
    than refused — matching the renderer, which trims inside modelArgsFor.
    Empty means "not requested" and is always fine.
    """
    if model.strip() and not ARGUMENT_SAFE.match(model.strip()):
        return (
            "model must be a single bare id — no spaces, and not starting with "
            "'-'. A value like \"sonnet --some-flag\" would reach the CLI as two "
            "arguments and pass it a flag you did not intend."
        )
    if effort.strip() and not ARGUMENT_SAFE.match(effort.strip()):
        return "effort must be a single bare word — no spaces, and not starting with '-'."
    return ""
