/**
 * Host-owned executable profiles shared by renderer adapters and the main
 * process. Rich renderer agent specs add UI and resume metadata, but the
 * executable and unattended-mode flag live here so the two launch paths cannot
 * silently drift.
 */
export const AI_CLI_PROFILES = {
  claude: { command: 'claude', yoloFlag: '--dangerously-skip-permissions' },
  codex: { command: 'codex', yoloFlag: '--dangerously-bypass-approvals-and-sandbox' },
  antigravity: { command: 'agy', yoloFlag: '--dangerously-skip-permissions' },
  grok: { command: 'grok' },
  kimi: { command: 'kimi', yoloFlag: '--yolo' },
  opencode: { command: 'opencode', yoloFlag: '--auto' },
  qwen: { command: 'qwen', yoloFlag: '--yolo' },
  kilo: { command: 'kilo', yoloFlag: '--auto' },
  pi: { command: 'pi' },
  copilot: { command: 'copilot', yoloFlag: '--yolo' },
  cursor: { command: 'agent', yoloFlag: '--force' },
  aider: { command: 'aider', yoloFlag: '--yes-always' },
  muse: { command: 'muse', yoloFlag: '--disable-approval' },
} as const

export type AiCliProfileId = keyof typeof AI_CLI_PROFILES
