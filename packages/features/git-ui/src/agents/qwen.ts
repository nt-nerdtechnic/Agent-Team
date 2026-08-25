/** Qwen Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'qwen',
  label: 'Qwen Code',
  defaultCommand: 'qwen',
  skipPermissionFlag: '--yolo',
  resumeArgs: (id) => `--resume ${id}`,
  needsSessionMarker: true,
  turnEndInferredFromSilence: true,
  supportsRebuild: true,
  // Measured on a real PTY: the CLI itself emits `ESC[?1049h` during startup
  // (probe read 17768 bytes of startup output) and keeps the conversation there.
  fullScreenTui: true,
  // A line appended to the file the pane was launched watching. It reaches the
  // CLI's own message queue, never its composer, so someone typing in the pane
  // has nothing to lose by a message arriving — `holdsInputBox` is false.
  //
  // The mid-turn hold is still kept, and deliberately: the CLI aggregates
  // several plain queued messages into ONE submission, so pushing a second
  // message into a busy pane can merge two agents' messages into a single turn.
  pushChannel: { kind: 'input-file', holdsInputBox: false },
  hint: 'generalist'
} as const satisfies AgentSpec
