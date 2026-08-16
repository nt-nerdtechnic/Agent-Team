/**
 * sessionMarkerTurn.ts
 *
 * Vendors in the "marker camp" (every spec with `needsSessionMarker`) cannot
 * pin a session id at launch, so App.vue types Navide's own marker —
 * `<!-- agent-team-session: at-pane:<paneId> -->` — into a fresh pane as a
 * standalone prompt (sendSessionMarkerBootstrap). It is a REAL prompt, so the
 * CLI answers it with an ordinary assistant message, and every marker-camp
 * reader turns that answer into a normal `turn_complete` carrying text.
 *
 * That turn is Navide talking to itself: the user never started it. Its text
 * must not title the pane, must not chime "done", and must not be scanned for
 * inter-CLI MSG/SPAWN blocks.
 *
 * The gate is armed by the send itself (not by anything in the CLI log), so it
 * covers every marker-camp vendor identically — including cursor, whose reader
 * drops the marker's user row outright, and the vendors whose readers blank it
 * to "" via user_prompt_text(). It uses no time window: slow CLIs are free to
 * take minutes to answer.
 *
 * Kept out of App.vue because the handler is a closure inside an SFC the suite
 * cannot mount — same reason questionActionFor lives in cliAwaitingInput.ts.
 */

import { isInjectedMessageText } from './agentMessaging'
import { USER_RECORD_DETAILS } from './cliAwaitingInput'

/** What one `agent.activity` event means for an ARMED session-marker gate.
 *
 *  - 'suppress': this turn ended the marker's own turn — disarm and drop its
 *    user-visible side effects.
 *  - 'disarm': the user's own prompt arrived first (readers report a user
 *    record before that prompt's turn_complete), so the marker's turn is no
 *    longer the next one. Disarm without suppressing anything — this is what
 *    keeps a genuine first turn from ever being swallowed, e.g. when a CLI
 *    answers the marker with nothing a reader can see.
 *  - null: says nothing either way; leave the gate armed.
 *
 *  Callers must only consult this while the pane's gate is armed. */
export type MarkerTurnAction = 'suppress' | 'disarm' | null

export function markerTurnActionFor(ev: {
  event_type?: string
  detail?: string
  text?: string
}): MarkerTurnAction {
  if (ev.event_type === 'turn_complete') return 'suppress'
  if (ev.event_type !== 'agent_active') return null
  // A user record with real text is the person typing. The marker's own user
  // record never qualifies: user_prompt_text() blanks it (it opens with '<'),
  // and cursor's reader emits nothing for it at all. Injected envelopes are
  // Navide's too, so they disarm nothing either.
  if (ev.detail === undefined || !USER_RECORD_DETAILS.has(ev.detail)) return null
  if (!ev.text || isInjectedMessageText(ev.text)) return null
  return 'disarm'
}
