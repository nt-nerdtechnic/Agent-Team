# AGENTS.md

Agent-Team: Electron (Vue 3 + TypeScript, pnpm) frontend + Python (uv) backend.
This file is a router — read the referenced file BEFORE doing the matching work.

## Route table

| Situation | Read first |
|---|---|
| Running tests / typecheck / build / dev app; git & commit rules; worktrees | `.Codex/playbook/10-ops.md` |
| Touching terminal, xterm, PTY, WebSocket, or panes | `.Codex/playbook/20-pitfalls.md` |
| Why this repo leaks tokens + the giant-file protocol | `.Codex/playbook/00-diagnosis.md` |
| Delegation, model choice, judgment calls (Codex only) | `~/.Codex/playbook/` (see route table in global AGENTS.md) |

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

## Workflow (Cursor Plan Mode)

Plan-driven development:

1. Before implementation, read the latest `.plan.md` under `.cursor/plans/`.
2. Implement by the plan's `todos` phases; update each todo's `status` in the
   plan file as phases complete.
3. No plan + complex task → Discovery → Clarify → Plan Artifact first.

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
