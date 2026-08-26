import type { TerminalAgentProfile } from '../useTerminal'

export type TestAgentProfile = TerminalAgentProfile & { agentKey: string }

export const AGENT_SPECS: TestAgentProfile[] = [
  { agentKey: 'claude', bracketedPaste: true, fullScreenTui: true },
  { agentKey: 'codex', bracketedPaste: true, shiftEnterSequence: '\u001b[13;2u' },
  { agentKey: 'antigravity', bracketedPaste: true, fullScreenTui: true },
  { agentKey: 'grok' },
  { agentKey: 'kimi' },
  { agentKey: 'opencode', fullScreenTui: true },
  { agentKey: 'qwen', fullScreenTui: true },
  { agentKey: 'kilo', fullScreenTui: true },
  { agentKey: 'pi' },
  { agentKey: 'copilot', fullScreenTui: true },
  { agentKey: 'cursor' },
  { agentKey: 'aider' },
  { agentKey: 'muse' },
  { agentKey: 'terminal' },
]

export function agentProfileFor(agentKey?: string): TerminalAgentProfile | undefined {
  const key = agentKey?.toLowerCase()
  const canonical = key === 'claude-code' ? 'claude' : key === 'agy' ? 'antigravity' : key
  return AGENT_SPECS.find((profile) => profile.agentKey === canonical)
}
