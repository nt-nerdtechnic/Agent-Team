/**
 * Meta Muse Code — identity and spawn only.
 *
 * Resume, turn signals, paste protocol and login recovery are unset on
 * purpose: Muse Code's public documentation stops at install and login, so
 * the shape of `muse replay`, its session ids and its TUI input handling are
 * unverified. Each unset field means the app treats that capability as
 * unsupported here rather than guessing — see the backend note in
 * cli_vendors/muse.py.
 */

import type { AgentSpec } from './types'

export const SPEC: AgentSpec = {
  agentKey: 'muse',
  label: 'Muse Code',
  defaultCommand: 'muse',
  hint: 'generalist'
}
