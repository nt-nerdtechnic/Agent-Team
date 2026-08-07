/**
 * One file per vendor; this assembler is the canonical list. Adding a CLI:
 * copy `_template.ts` to `<key>.ts`, then register it here (one line, in
 * display order). The backend registry test cross-checks the key set.
 */

import type { AgentSpec } from './types'
import { SPEC as aider } from './aider'
import { SPEC as antigravity } from './antigravity'
import { SPEC as claude } from './claude'
import { SPEC as codex } from './codex'
import { SPEC as copilot } from './copilot'
import { SPEC as cursor } from './cursor'
import { SPEC as grok } from './grok'
import { SPEC as kilo } from './kilo'
import { SPEC as kimi } from './kimi'
import { SPEC as opencode } from './opencode'
import { SPEC as pi } from './pi'
import { SPEC as qwen } from './qwen'
import { SPEC as terminal } from './terminal'

export type { AgentSpec, PaneArgContext } from './types'

// Display order (spawn menus, settings) — deliberate, not alphabetical.
export const AGENT_SPECS: AgentSpec[] = [
  claude,
  codex,
  antigravity,
  grok,
  kimi,
  opencode,
  qwen,
  kilo,
  pi,
  copilot,
  cursor,
  aider,
  terminal
]

/** Specs that are real CLI agents (excludes the plain-shell terminal entry). */
export const CLI_AGENT_SPECS: AgentSpec[] = AGENT_SPECS.filter((s) => s.agentKey !== 'terminal')
