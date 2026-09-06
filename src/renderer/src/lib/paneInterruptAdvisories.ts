/**
 * paneInterruptAdvisories.ts
 *
 * What an interrupt sent from outside the window actually landed on.
 *
 * `ui.pane.interrupt` presses a key in somebody else's terminal. Whether that
 * ends a turn, clears a half-typed line or does nothing at all depends
 * entirely on what the pane was doing at the moment the byte went in — and
 * that is knowable only here, in the window that owns the pane. An MCP caller
 * reading a bare `ok: true` would take "the key was pressed" for "the agent
 * stopped", which is the one conclusion this must never let it draw.
 *
 * Like paneCloseAdvisories these do not refuse anything. Interrupting an idle
 * pane is a real thing to want (clearing whatever is sitting in its input box
 * is the usual reason), so the answer is a record, not a gate.
 */

export interface PaneInterruptFacts {
  /** Messaging name, for readable text. Falls back to the id. */
  name: string
  /** Whether an interrupt byte was actually written to a live PTY. */
  sent: boolean
  /** Pane status at the moment of the interrupt, if known. */
  status?: string
  /** What the pane was blocked on, when its status was `awaiting`. */
  awaitingKind?: string
}

/** Statuses where a turn is genuinely in flight, so the interrupt had
 *  something to cut short. `awaiting` is deliberately NOT one of them: a pane
 *  parked on a question is producing nothing, and interrupting throws the
 *  question away rather than stopping work — which earns its own note below
 *  instead of silence. */
const WORKING_STATUSES: readonly string[] = ['running', 'starting']

export function interruptAdvisoriesFor(facts: PaneInterruptFacts): string[] {
  const who = facts.name.trim() || '這個 pane'
  const status = facts.status || ''

  if (!facts.sent) {
    // Nothing was written, so none of the notes below can apply.
    return [
      `「${who}」背後沒有在執行的 CLI（狀態 ${status || 'not-opened'}），` +
        `沒有送出任何中斷位元組`,
    ]
  }

  const advisories: string[] = []
  if (status === 'awaiting') {
    const kind = facts.awaitingKind ? `（${facts.awaitingKind}）` : ''
    advisories.push(
      `「${who}」當時停在等人回答的地方${kind}，中斷讓那個問題連同還沒做的決定一起消失，` +
        `而不是打斷一段正在跑的工作`,
    )
  } else if (!WORKING_STATUSES.includes(status)) {
    advisories.push(
      `「${who}」在中斷送出時的狀態是 ${status || 'unknown'}，沒有正在跑的 turn 可以打斷；` +
        `中斷鍵通常會清掉輸入框裡已經打好、還沒送出的字`,
    )
  }
  return advisories
}
