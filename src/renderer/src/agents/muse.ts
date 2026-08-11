/**
 * Meta Muse Code — identity, spawn, permission bypass and resume.
 *
 * Meta's public documentation (https://dev.meta.ai/docs/muse-code/, checked
 * 2026-08-11) now covers permissions, interactive use and headless runs, so
 * the parts it pins down exactly are wired here: `muse resume <id>` is a
 * SUBCOMMAND (like codex's), and the approval layer has documented opt-out
 * flags.
 *
 * Turn signals, paste protocol and login recovery stay unset on purpose —
 * they depend on a log reader, and no real Muse session file has been seen
 * here to validate one against. `supportsRebuild` is withheld for the same
 * reason: the Rebuild button needs a discovered session id, and only that
 * reader can supply one. See the backend note in cli_vendors/muse.py.
 */

import type { AgentSpec } from './types'

export const SPEC: AgentSpec = {
  agentKey: 'muse',
  label: 'Muse Code',
  defaultCommand: 'muse',
  // Two documented ways to stop the prompting: `--yolo` drops BOTH the
  // approval layer and the OS sandbox (Meta scopes it to "CI containers
  // only"), while `--disable-approval` drops only the approval prompts and
  // keeps the sandbox confining writes to the workspace. YOLO mode here means
  // "don't stop to ask", not "remove OS containment", so the narrower flag is
  // the match; `--yolo` remains available to type as a custom command.
  skipPermissionFlag: '--disable-approval',
  // Subcommand, NOT a --flag. Documented as `muse resume <fork-id>`; whether
  // that id is the same uuid `muse exec --session-id` takes is NOT stated, so
  // only the command shape is claimed here — nothing infers an id from it.
  resumeArgs: (id) => `resume ${id}`,
  resumeCommandPattern: /^muse\s+resume\s+\S+/,
  hint: 'generalist'
}
