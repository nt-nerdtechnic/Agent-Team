/**
 * Host-owned executable profiles shared by renderer adapters and the main
 * process. Rich renderer agent specs add UI and resume metadata, but the
 * executable and unattended-mode flag live here so the two launch paths cannot
 * silently drift.
 */
export const AI_CLI_PROFILES = {
  claude: { label: 'Claude Code', command: 'claude', yoloFlag: '--dangerously-skip-permissions' },
  codex: { label: 'Codex', command: 'codex', yoloFlag: '--dangerously-bypass-approvals-and-sandbox' },
  antigravity: { label: 'Antigravity CLI', command: 'agy', yoloFlag: '--dangerously-skip-permissions' },
  grok: { label: 'Grok CLI', command: 'grok' },
  kimi: { label: 'Kimi Code', command: 'kimi', yoloFlag: '--yolo' },
  opencode: { label: 'OpenCode', command: 'opencode', yoloFlag: '--auto' },
  qwen: { label: 'Qwen Code', command: 'qwen', yoloFlag: '--yolo' },
  kilo: { label: 'Kilo Code', command: 'kilo', yoloFlag: '--auto' },
  pi: { label: 'Pi', command: 'pi' },
  copilot: { label: 'Copilot CLI', command: 'copilot', yoloFlag: '--yolo' },
  cursor: { label: 'Cursor CLI', command: 'agent', yoloFlag: '--force' },
  aider: { label: 'Aider', command: 'aider', yoloFlag: '--yes-always' },
  muse: { label: 'Muse Code', command: 'muse', yoloFlag: '--disable-approval' },
} as const

export type AiCliProfileId = keyof typeof AI_CLI_PROFILES
