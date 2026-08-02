# CLAUDE.md

Agent-Team: Electron (Vue 3 + TypeScript, pnpm) frontend + Python (uv) backend.
This file is a router — read the referenced file BEFORE doing the matching work.

## Route table

| Situation | Read first |
|---|---|
| Running tests / typecheck / build / dev app; git & commit rules; worktrees | `.claude/playbook/10-ops.md` |
| Touching terminal, xterm, PTY, WebSocket, or panes | `.claude/playbook/20-pitfalls.md` |
| Why this repo leaks tokens + the giant-file protocol | `.claude/playbook/00-diagnosis.md` |
| Delegation, model choice, judgment calls (Claude Code only) | `~/.claude/playbook/` (see route table in global CLAUDE.md) |

Read routed files on demand, not all up front.

## Always-on rules (the expensive-to-violate subset)

1. **Tests**: `pnpm test:run`, never `pnpm test` (watch mode hangs). Backend:
   `uv --project backend run pytest backend/tests` (the path argument is
   required — without it pytest misses backend's ini config). Run verification
   commands bare — no pipe to tail/head (it eats the exit code).
2. **Never clear terminal scrollback** — no `term.clear()` in any
   resize/redraw path.
3. **No self-initiated commits** — the user decides when to commit, unless
   they explicitly authorized committing for the task.
4. **No UI automation** (cliclick/screencapture/AppleScript) — the user tests
   UI manually.
5. **Giant files** (App.vue ~7K lines, GitPane.vue ~3K,
   EditorWindowApp.vue ~2.6K, backend/agent_team_backend/app.py ~2.7K):
   Grep tool to locate → Read with offset/limit → batch edits through one
   subagent. Never whole-file Read, never bash/python inline search.

## Workflow (Plan Documents)

Plan mode is **opt-in only** — enter it solely when the user explicitly asks
(e.g. "建立計畫", "plan 模式", invoking `cursor-plan-mode-workflow`).
Never create a plan file proactively, even for complex tasks; without a plan,
state assumptions and implement directly.

When a plan exists or was explicitly requested:

1. Plans are agent-authored HTML in `.agent-team/plans/` per
   `.agent-team/plans/_spec.md` (copy `_template.html` to start). Do not
   publish plans as claude.ai artifacts; the user views them in the app.
2. Updates (todo status, stage, review notes): Edit only the `plan-meta`
   JSON block plus its matching visible markup — never rewrite the file.
3. Approval gate: write code only when the plan's `stage` is `approved` or
   later. The user saying "開始" means: set `stage: approved` + `approvedAt`,
   then start.
4. Legacy `.cursor/plans/*.plan.md` stay readable; never create new ones.

## Language

**Codebase language: English** — all code, comments, commit messages, variable
names, and in-repo documentation.

## Behavioral core

1. **Think first**: state assumptions; if multiple readings exist, list them —
   don't pick silently; if truly unclear, ask.
2. **Minimum code**: only what was asked; no speculative abstraction,
   flexibility, or impossible-case error handling.
3. **Surgical changes**: every changed line maps to the request; don't
   "improve" adjacent code; clean up only orphans your own change created.
4. **Goal-driven**: turn the task into verifiable acceptance criteria before
   coding ("fix bug" → "write a reproducing test, make it pass"), then loop
   until they verify.
