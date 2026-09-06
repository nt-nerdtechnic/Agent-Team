/**
 * paneCloseAdvisories.ts
 *
 * What closing a pane costs, said out loud.
 *
 * Creating a pane goes through a gate: the request is evaluated, a taken name
 * is refused, and volume advisories are handed back so the caller learns what
 * its spawn just did. Closing one had none of that — `ui.pane.close` kills the
 * pane and its PTY and answers nothing, so an agent could end another agent's
 * work mid-turn, drop the messages queued for it, and orphan the panes it had
 * spawned, without any of that appearing anywhere.
 *
 * These advisories do not refuse the close. Force-quitting a pane is a
 * legitimate thing to want — sometimes stopping it IS the point — and turning
 * it into a gate would break callers that rely on it. What was missing is the
 * record: the caller should be able to tell afterwards that it did something
 * with consequences, the same way the spawn side already tells it.
 */

export interface PaneCloseFacts {
  /** Messaging name, for readable text. Falls back to the id. */
  name: string
  /** Pane status at the moment of the close, if known. */
  status?: string
  /** Messages queued for this pane that have not been delivered. */
  queuedMessages: number
  /** Panes this one spawned that are still open. */
  childCount: number
}

/** Statuses that mean the agent is in the middle of something. `awaiting` is
 *  included: it is blocked on a question, so closing discards the decision
 *  someone was about to make rather than merely stopping output. */
const BUSY_STATUSES: readonly string[] = ['running', 'starting', 'awaiting']

export function closeAdvisoriesFor(facts: PaneCloseFacts): string[] {
  const advisories: string[] = []
  const who = facts.name.trim() || '這個 pane'

  if (facts.status && BUSY_STATUSES.includes(facts.status)) {
    advisories.push(
      `「${who}」在關閉時的狀態是 ${facts.status}，也就是它正在做事或正等著有人回答；` +
        `這一輪的工作沒有留下結果`,
    )
  }
  if (facts.queuedMessages > 0) {
    advisories.push(
      `還有 ${facts.queuedMessages} 則訊息排隊等著送進「${who}」，隨著 pane 一起消失了；` +
        `寄件方會收到 pane-closed 而不是自己的回覆`,
    )
  }
  if (facts.childCount > 0) {
    advisories.push(
      `「${who}」開出的 ${facts.childCount} 個子 pane 仍在執行，但它們回報的對象已經不在了`,
    )
  }
  return advisories
}
