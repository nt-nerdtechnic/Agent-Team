// Deciding whether a CLI pane is parked on the user — blocked on a permission
// prompt or a question — as opposed to having finished its turn. The two look
// identical on the PTY: a prompt paints once and then goes silent, exactly
// like a turn that ended, so the RUNNING/idle heuristic cannot separate them
// and needs an out-of-band signal.
//
// There are two such signals, and which one a pane gets depends on its vendor:
//   • A notification hook we install, whose payload names the situation. This
//     is authoritative and is what claude/qwen/copilot use.
//   • Otherwise the prompt is recognized from the text it paints — the vendor
//     declares the shape in its `awaitingInput` spec (see agents/types.ts).
//
// Where each CLI stands, and why (surveyed 2026-08-08):
//
//   claude    hook   Notification, ~/.claude/settings.json
//   qwen      hook   Notification, ~/.qwen/settings.json (Claude's schema)
//   copilot   hook   notification, ~/.copilot/hooks/*.json (own file)
//   codex     text   Has a PermissionRequest hook, deliberately unused: Codex
//                    gates new hooks behind a trust screen the user must clear
//                    per pane, and again on every change to the hook file.
//   aider     text   No hook system at all. Its --notifications-command fires
//                    identically for "waiting" and "turn ended" and carries no
//                    payload, so it cannot answer the question.
//   kimi      —      Has PermissionRequest/PermissionResult hooks, but they
//                    fire only when an approval RPC surface exists, unverified
//                    for the TUI, and the payload's outer envelope (where a
//                    session id would live) was never confirmed. Attribution
//                    would fail silently.
//   opencode  —      Best mechanism of any of them (permission.updated over
//                    an SSE /event stream) but it needs the pane spawned with
//                    `--port`: without one the TUI serves no HTTP listener.
//                    Its on-screen strings are i18n keys, so text is out too.
//   kilo      —      An opencode fork; same story, and not installed here.
//   cursor    —      No permission event. Its beforeShellExecution hook is a
//                    synchronous gate — using it would make Navide part of the
//                    approval decision, not an observer of it.
//   antigravity —    Hook docs unpublished; no known waiting event.
//   grok      —      Hooks exist but carry no permission event; its
//                    Notification is for background delegations. The TUI is
//                    compiled to bytecode, so no strings to match either.
//   pi        —      Documented as deliberately having no permission prompts.
//                    It never stops to ask, so the state does not exist.

import { AGENT_SPECS } from '../agents'

/** Notification types that block the turn until the user answers. Claude's
 *  other types are informational: `idle_prompt` fires every time a turn ends
 *  (the pane is genuinely idle then), and auth_success / elicitation_complete
 *  / elicitation_response all report something that already finished.
 *  Source: https://code.claude.com/docs/en/hooks.md */
const AWAITING_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'permission_prompt', // Claude wants approval for a tool call
  'elicitation_dialog', // an MCP server opened a form and is waiting on it
  'agent_needs_input', // a background session is waiting (Claude Code 2.1.198+)
])

/** Notification types that mean the wait is over.
 *
 *  A hook fires once and never repeats, so unlike the polled pattern watcher
 *  it cannot re-check whether the prompt is still up — it needs an explicit
 *  release. Without one, the waits that end WITHOUT the CLI producing output
 *  (an MCP form submitted, a background session finishing, a turn ending on a
 *  prompt nobody answered) would hold AWAITING forever, which also parks the
 *  pane out of inter-CLI messaging and MCP dispatch. */
const RESOLVED_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'idle_prompt', // the turn ended; the CLI wants the next instruction
  'agent_idle', // copilot's spelling of the same thing
  'elicitation_complete', // the MCP form was submitted or dismissed
  'elicitation_response', // its answer went back to the server
  'agent_completed', // the background session finished or failed
])

/** True when a Notification hook payload means the pane is waiting on the user.
 *
 *  An unknown or missing type is NOT awaiting. The field is absent on Claude
 *  builds that predate it, and treating "unknown" as awaiting would light the
 *  badge on every `idle_prompt` — i.e. after every single turn — which also
 *  parks the pane out of inter-CLI messaging and MCP dispatch while it is in
 *  fact free. Losing the badge on an old build is the cheaper failure. */
export function notificationMeansAwaiting(notificationType: string | undefined): boolean {
  return notificationType !== undefined && AWAITING_NOTIFICATION_TYPES.has(notificationType)
}

/** True when a Notification hook payload means an earlier wait has ended.
 *
 *  Deliberately a whitelist and not `!notificationMeansAwaiting(...)`: an
 *  unrecognized type must do NOTHING. Clearing on unknown values would let a
 *  future notification type silently cancel a real permission prompt. */
export function notificationEndsAwaiting(notificationType: string | undefined): boolean {
  return notificationType !== undefined && RESOLVED_NOTIFICATION_TYPES.has(notificationType)
}

function awaitingSpecFor(agentKey: string): { pattern: RegExp } | undefined {
  return AGENT_SPECS.find((s) => s.agentKey === agentKey)?.awaitingInput
}

/** Whether this vendor's prompts can be recognized from PTY text at all.
 *  False for claude (it uses the hook instead) and for CLIs whose prompt shape
 *  has not been identified — those keep the plain idle/running behaviour. */
export function hasAwaitingPattern(agentKey: string): boolean {
  return awaitingSpecFor(agentKey) !== undefined
}

/** True when `screen` shows this vendor's prompt waiting for an answer.
 *
 *  `screen` must be the RENDERED text (useTerminal.readRenderedText), not the
 *  raw clean buffer: a TUI repaints its box in place, so an answered prompt
 *  stops appearing here by itself, while the raw stream keeps every frame it
 *  ever painted and would match forever.
 *
 *  Matching is whitespace-collapsed (mirrors matchLoginExpired) because the
 *  rendered text carries the hard-wraps a narrow pane inserts mid-phrase, so
 *  an unnormalized "Do you want to\nproceed?" would never match. Always false
 *  for vendors without a spec. */
export function matchAwaitingInput(agentKey: string, screen: string): boolean {
  const spec = awaitingSpecFor(agentKey)
  return spec !== undefined && spec.pattern.test(screen.replace(/\s+/g, ' '))
}
