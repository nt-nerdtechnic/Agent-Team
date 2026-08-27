// Loop launch button: unified-store setting keys, default prompts, and the
// session-limit reset-time parser used for unattended loop auto-resume.
export const LOOP_PROMPT_SETTING_KEY = 'loop-prompt-text'

export const DEFAULT_LOOP_PROMPT =
  '啟動持續開發推進的Loop直到完成度超過100%，確保開發完成之後建立對應的HTML報告書，檢查這個功能是否都正常運作，並且不要影響到原本正常的程式碼'

export const LOOP_RESUME_SETTING_KEY = 'loop-resume-text'

export const DEFAULT_LOOP_RESUME = '繼續'

/** End-of-turn marker the loop asks the CLI to print when it judges the WHOLE
 *  task complete. The app watches for it (as the turn's final line, via
 *  turnEndsWithSentinel) to auto-stop the loop instead of resending the resume
 *  prompt forever — the app-level analogue of a pipeline stage sentinel. */
export const LOOP_DONE_MARKER = '<<LOOP_DONE>>'

/** End-of-turn marker the CLI prints when this turn did nothing but WAIT on
 *  something the loop cannot observe — a background task, another pane's
 *  reply, a long-running command it has already started.
 *
 *  This is the vendor-agnostic half of the background-wait fix. Only claude
 *  and opencode report tool use at a granularity the loop can read; for the
 *  other eleven the CLI itself is the only thing that knows it is parked, so
 *  the loop asks it to say so instead of guessing from the wording (which was
 *  tried and does not work — see turnMadeProgress). */
export const LOOP_WAIT_MARKER = '<<LOOP_WAIT>>'

/** Suffix appended to every loop injection (start + resume) so the CLI knows
 *  which marker to emit. Kept out of the stored loop-prompt setting so the
 *  user's editable text stays clean.
 *
 *  Both markers are described in ONE paragraph on purpose: this text rides on
 *  every single continue, so a second paragraph would be paid for on every
 *  turn of every loop for the life of the run. */
export const LOOP_DONE_INSTRUCTION =
  `\n\n（重要：當你判定整個任務已全部完成、確認功能正常且無需再繼續時，請在回覆的最後獨立一行「只」輸出 ${LOOP_DONE_MARKER} 這個標記，前後不要有任何其他文字；只要還需要繼續，就絕對不要輸出這個標記。若你這一輪只是在等待外部事件（背景任務、他人回覆、已啟動的長時間指令），無事可做也無法推進，請改在最後獨立一行「只」輸出 ${LOOP_WAIT_MARKER}。）`

/** Append the done-marker instruction to a loop prompt at injection time. */
export function withLoopDoneInstruction(prompt: string): string {
  return prompt + LOOP_DONE_INSTRUCTION
}

/** CLI session-limit message, e.g.
 *  "You've hit your session limit · resets 4:30am (Asia/Taipei)". */
export const SESSION_LIMIT_RE =
  /hit your .{0,40}limit.*?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i

/** Match the session-limit message in `text`, tolerating the TUI's hard
 *  line-wrapping in narrow panes (cleanBuffer keeps the wrap `\n`, which the
 *  regex `.`/`.{0,40}` gaps cannot cross). Whitespace runs are collapsed to
 *  single spaces before matching. Returns the normalized matched message
 *  (suitable for parseLimitReset) or null when no limit message is present. */
export function matchSessionLimit(text: string): string | null {
  const m = SESSION_LIMIT_RE.exec(text.replace(/\s+/g, ' '))
  return m ? m[0] : null
}

/** Slice the not-yet-consumed portion of a rolling capped buffer, given the
 *  monotonic total of chars ever appended (`totalSeen`) and the total that had
 *  been appended when the caller last consumed (`baseline`). The buffer keeps
 *  only the tail of the stream, so the unconsumed region is its last
 *  `totalSeen - baseline` chars (clamped to the buffer), further capped to the
 *  last `maxChars` to bound regex scanning cost. */
export function unseenTail(
  buffer: string,
  totalSeen: number,
  baseline: number,
  maxChars: number
): string {
  const unseen = Math.min(Math.max(0, totalSeen - baseline), buffer.length)
  return buffer.slice(buffer.length - unseen).slice(-maxChars)
}

/** Local HH:mm (24h) for the loop badge's resume/estimate times and the
 *  loop-paused notification. Single source — badge and notification must
 *  render the same clock. */
export function formatLoopTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

/** Safety margin added past the parsed reset time before resuming. */
export const LIMIT_RESET_BUFFER_MS = 2 * 60_000

/** Heuristic pre-limit estimate window: Claude's rolling 5-hour session quota,
 *  used to show an approximate reset time while the loop is still running. */
export const LOOP_ESTIMATE_WINDOW_MS = 5 * 60 * 60_000

/** Parse a session-limit message and return the epoch ms to auto-resume at:
 *  the next occurrence of the parsed wall-clock time in the message's IANA
 *  timezone (already past today → tomorrow), plus LIMIT_RESET_BUFFER_MS.
 *  Returns null when the message doesn't match or can't be interpreted
 *  (unknown timezone, out-of-range time) — callers fail open. */
export function parseLimitReset(message: string, now: number = Date.now()): number | null {
  const m = SESSION_LIMIT_RE.exec(message)
  if (!m) return null
  const rawHour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3].toLowerCase()
  // Drop ALL whitespace, not just edges: matchSessionLimit's normalization
  // turns a TUI line-wrap inside the timezone parens into an inner space
  // ("Asia/ Taipei"), and IANA names never legitimately contain spaces.
  const timeZone = m[4].replace(/\s+/g, '')
  if (rawHour < 1 || rawHour > 12 || minute > 59) return null
  const targetHour = (rawHour % 12) + (meridiem === 'pm' ? 12 : 0)

  // Current wall-clock time in the target timezone. The wall-clock delta to
  // the target equals the absolute delta (DST shifts inside the wait window
  // are an accepted approximation).
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(now)
  } catch {
    return null // unknown/invalid IANA timezone name
  }
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN)
  const nowHour = get('hour')
  const nowMinute = get('minute')
  const nowSecond = get('second')
  if (!Number.isFinite(nowHour) || !Number.isFinite(nowMinute) || !Number.isFinite(nowSecond)) {
    return null
  }

  const targetSecOfDay = targetHour * 3600 + minute * 60
  const nowSecOfDay = nowHour * 3600 + nowMinute * 60 + nowSecond
  let deltaSec = targetSecOfDay - nowSecOfDay
  if (deltaSec <= 0) deltaSec += 24 * 3600
  return now + deltaSec * 1000 + LIMIT_RESET_BUFFER_MS
}
