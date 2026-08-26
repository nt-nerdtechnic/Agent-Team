import { AGENT_SPECS, type AgentSpec } from './agents'
import {
  agentUsesBracketedPaste as terminalUsesBracketedPaste,
  encodeShiftEnter as encodeTerminalShiftEnter,
} from '@navide/terminal'

export function agentProfileFor(agentKey?: string): AgentSpec | undefined {
  const key = agentKey?.toLowerCase()
  const canonical = key === 'claude-code' ? 'claude' : key === 'agy' ? 'antigravity' : key
  return AGENT_SPECS.find((spec) => spec.agentKey === canonical)
}

export function encodeShiftEnter(agentKey?: string): string {
  return encodeTerminalShiftEnter(agentProfileFor(agentKey))
}

export function agentUsesBracketedPaste(agentKey?: string): boolean {
  return terminalUsesBracketedPaste(agentProfileFor(agentKey))
}
