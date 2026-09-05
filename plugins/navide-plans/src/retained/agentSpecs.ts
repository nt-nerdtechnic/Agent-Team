// Private projection of the retained v1 execution picker. The parity test
// checks order, labels and hints against the host registry until v1 is removed.
export const CLI_AGENT_SPECS = [
  { agentKey: 'claude', label: 'Claude Code', hint: 'planner + reviewer' },
  { agentKey: 'codex', label: 'Codex', hint: 'implementer' },
  { agentKey: 'antigravity', label: 'Antigravity CLI', hint: 'generalist' },
  { agentKey: 'grok', label: 'Grok CLI', hint: 'generalist' },
  { agentKey: 'kimi', label: 'Kimi Code', hint: 'generalist' },
  { agentKey: 'opencode', label: 'OpenCode', hint: 'generalist' },
  { agentKey: 'qwen', label: 'Qwen Code', hint: 'generalist' },
  { agentKey: 'kilo', label: 'Kilo Code', hint: 'generalist' },
  { agentKey: 'pi', label: 'Pi', hint: 'generalist' },
  { agentKey: 'copilot', label: 'Copilot CLI', hint: 'generalist' },
  { agentKey: 'cursor', label: 'Cursor CLI', hint: 'generalist' },
  { agentKey: 'aider', label: 'Aider', hint: 'generalist' },
  { agentKey: 'muse', label: 'Muse Code', hint: 'generalist' },
  { agentKey: 'droid', label: 'Droid', hint: 'generalist' },
] as const
