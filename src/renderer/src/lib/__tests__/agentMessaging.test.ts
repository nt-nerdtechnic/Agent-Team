import { describe, it, expect } from 'vitest'
import {
  MSG_START,
  MSG_END,
  MSG_ENVELOPE_PREFIX,
  SPAWN_START,
  SPAWN_END,
  isQualifiedTarget,
  isTurnInFlight,
  VENDORS_WITHOUT_TURN_END,
  parseMessages,
  parseSpawns,
  renderSpawnKickoff,
  sanitizeMessageContent,
  renderEnvelope,
  renderFailureNotice,
  renderSpawnNotice,
  reasonToEnglish,
  isInjectedMessageText,
  pushCooldownMs,
  PUSH_COOLDOWN_MS,
  PUSH_RETRY_COOLDOWN_MS,
  MSG_NOTICE_PREFIX,
  MSG_SPAWN_FAILED_PREFIX,
  MSG_SPAWN_PARTIAL_PREFIX,
  defaultMessagingName,
  normalizeMessagingName,
  uniqueMessagingName,
} from '../agentMessaging'

describe('parseMessages', () => {
  it('parses a single block with multiline content', () => {
    const text = `前言
${MSG_START} to: codex-1
第一行
第二行
${MSG_END}
後記`
    expect(parseMessages(text)).toEqual([{ target: 'codex-1', content: '第一行\n第二行' }])
  })

  it('parses multiple blocks in one turn', () => {
    const text = `${MSG_START} to: a-1
hi a
${MSG_END}
${MSG_START} to: b-2
hi b
${MSG_END}`
    expect(parseMessages(text)).toEqual([
      { target: 'a-1', content: 'hi a' },
      { target: 'b-2', content: 'hi b' },
    ])
  })

  it('ignores blocks inside fenced code blocks', () => {
    const text = ['```', `${MSG_START} to: codex-1`, 'nope', MSG_END, '```'].join('\n')
    expect(parseMessages(text)).toEqual([])
  })

  it('tolerates a missing MSG-END (closes at end of text)', () => {
    const text = `${MSG_START} to: codex-1
tail content`
    expect(parseMessages(text)).toEqual([{ target: 'codex-1', content: 'tail content' }])
  })

  it('closes the previous block when a new MSG-START appears', () => {
    const text = `${MSG_START} to: a-1
first
${MSG_START} to: b-1
second
${MSG_END}`
    expect(parseMessages(text)).toEqual([
      { target: 'a-1', content: 'first' },
      { target: 'b-1', content: 'second' },
    ])
  })

  it('requires markers to be bare lines (no leading whitespace)', () => {
    const text = `  ${MSG_START} to: codex-1
content
${MSG_END}`
    expect(parseMessages(text)).toEqual([])
  })

  it('drops blocks with empty target or empty content', () => {
    const noTarget = `${MSG_START} to:
content
${MSG_END}`
    const noContent = `${MSG_START} to: codex-1
${MSG_END}`
    expect(parseMessages(noTarget)).toEqual([])
    expect(parseMessages(noContent)).toEqual([])
  })

  it('keeps fenced code inside message content', () => {
    const text = [`${MSG_START} to: codex-1`, '```js', 'const x = 1', '```', MSG_END].join('\n')
    expect(parseMessages(text)).toEqual([
      { target: 'codex-1', content: '```js\nconst x = 1\n```' },
    ])
  })

  it('handles empty input', () => {
    expect(parseMessages('')).toEqual([])
  })
})

describe('parseMessages correlation id', () => {
  it('parses a `re:` field alongside the target', () => {
    const text = `${MSG_START} to: codex-1 re: abc123:7
done
${MSG_END}`
    expect(parseMessages(text)).toEqual([
      { target: 'codex-1', content: 'done', replyTo: 'abc123:7' },
    ])
  })

  it('leaves replies without a `re:` field unlinked (older format)', () => {
    const text = `${MSG_START} to: codex-1
done
${MSG_END}`
    const [block] = parseMessages(text)
    expect(block).toEqual({ target: 'codex-1', content: 'done' })
    expect(block.replyTo).toBeUndefined()
  })

  it('keeps a target whose name merely contains "re"', () => {
    const text = `${MSG_START} to: restore-1
hi
${MSG_END}`
    expect(parseMessages(text)).toEqual([{ target: 'restore-1', content: 'hi' }])
  })

  it('keeps a qualified target intact when a `re:` field follows', () => {
    const text = `${MSG_START} to: other-ws/codex-1 re: k1
hi
${MSG_END}`
    expect(parseMessages(text)).toEqual([
      { target: 'other-ws/codex-1', content: 'hi', replyTo: 'k1' },
    ])
  })
})

describe('parseSpawns', () => {
  it('parses a full block', () => {
    const text = `前言
${SPAWN_START}
agent: claude
name: worker-2
task: 跑一次前端測試並回報結果
${SPAWN_END}
後記`
    expect(parseSpawns(text)).toEqual([
      { agent: 'claude', name: 'worker-2', task: '跑一次前端測試並回報結果' },
    ])
  })

  it('keeps everything after task: down to SPAWN-END as a multiline task', () => {
    const text = `${SPAWN_START}
agent: codex
name: builder
task: 第一步
第二步
name: 這行屬於 task，不是欄位
${SPAWN_END}`
    expect(parseSpawns(text)).toEqual([
      { agent: 'codex', name: 'builder', task: '第一步\n第二步\nname: 這行屬於 task，不是欄位' },
    ])
  })

  it('returns missing fields as empty strings so failures can be reported', () => {
    const text = `${SPAWN_START}
agent: claude
${SPAWN_END}`
    expect(parseSpawns(text)).toEqual([{ agent: 'claude', name: '', task: '' }])
  })

  it('tolerates a missing SPAWN-END (closes at end of text)', () => {
    const text = `${SPAWN_START}
agent: claude
name: w
task: tail`
    expect(parseSpawns(text)).toEqual([{ agent: 'claude', name: 'w', task: 'tail' }])
  })

  it('closes the previous block when a new SPAWN-START appears', () => {
    const text = `${SPAWN_START}
agent: claude
name: a
task: one
${SPAWN_START}
agent: codex
name: b
task: two
${SPAWN_END}`
    expect(parseSpawns(text)).toEqual([
      { agent: 'claude', name: 'a', task: 'one' },
      { agent: 'codex', name: 'b', task: 'two' },
    ])
  })

  it('ignores blocks inside fenced code blocks', () => {
    const text = ['```', SPAWN_START, 'agent: claude', 'name: x', 'task: nope', SPAWN_END, '```'].join('\n')
    expect(parseSpawns(text)).toEqual([])
  })

  it('requires markers to be bare lines (no leading whitespace)', () => {
    const text = `  ${SPAWN_START}
agent: claude
name: x
task: y
${SPAWN_END}`
    expect(parseSpawns(text)).toEqual([])
  })

  it('handles empty input', () => {
    expect(parseSpawns('')).toEqual([])
  })
})

describe('renderSpawnKickoff', () => {
  it('keeps the task verbatim and appends a one-line MSG report instruction', () => {
    const kickoff = renderSpawnKickoff('修好登入 bug\n然後跑測試', 'boss-1')
    expect(kickoff.startsWith('修好登入 bug\n然後跑測試\n\n')).toBe(true)
    const hint = kickoff.split('\n').at(-1) as string
    expect(hint).toContain(`${MSG_START} to: boss-1`)
    expect(hint).toContain(MSG_END)
    // The instruction must never itself parse as a bare MSG marker line.
    expect(parseMessages(kickoff)).toEqual([])
  })
})

describe('sanitizeMessageContent', () => {
  it('breaks control-marker tokens so they cannot re-trigger parsers', () => {
    const dirty = `before\n---ASK-START---\nquestion\n---ASK-END---\nafter`
    const clean = sanitizeMessageContent(dirty)
    expect(clean).not.toContain('---ASK-START---')
    expect(clean).not.toContain('---ASK-END---')
    expect(clean).toContain('ASK-START')
  })

  it('breaks MSG markers embedded mid-line too', () => {
    const clean = sanitizeMessageContent(`quote: ${MSG_START} to: x`)
    expect(clean).not.toContain(MSG_START)
  })

  it('breaks SPAWN markers so forwarded content cannot trigger a spawn', () => {
    const dirty = `${SPAWN_START}\nagent: claude\nname: x\ntask: y\n${SPAWN_END}`
    const clean = sanitizeMessageContent(dirty)
    expect(clean).not.toContain(SPAWN_START)
    expect(clean).not.toContain(SPAWN_END)
    expect(parseSpawns(clean)).toEqual([])
  })

  it('leaves normal text untouched', () => {
    expect(sanitizeMessageContent('普通內容 --- 分隔線')).toBe('普通內容 --- 分隔線')
  })
})

describe('renderEnvelope', () => {
  it('contains sender header, sanitized content, and one-line reply hint', () => {
    const env = renderEnvelope('claude-1', `hello\n---REPORT-START---`)
    const lines = env.split('\n')
    expect(lines[0]).toBe(`${MSG_ENVELOPE_PREFIX} claude-1`)
    expect(env).not.toContain('---REPORT-START---')
    const hint = lines[lines.length - 1]
    expect(hint).toContain('MSG-START')
    // Hint must never itself be a parseable bare marker line.
    expect(parseMessages(env)).toEqual([])
  })

  it('omits the reply hint when disabled', () => {
    const env = renderEnvelope('claude-1', 'hello', { includeReplyHint: false })
    expect(env).toBe(`${MSG_ENVELOPE_PREFIX} claude-1\nhello`)
  })

  it('asks for the correlation id back in the reply hint', () => {
    const env = renderEnvelope('claude-1', 'hello', { correlationId: 'abc123:7' })
    const hint = env.split('\n').pop() ?? ''
    expect(hint).toContain('to: claude-1 re: abc123:7')
    // Still not a parseable bare marker line.
    expect(parseMessages(env)).toEqual([])
  })

  it('carries no correlation id when none is given, and none when hinting is off', () => {
    expect(renderEnvelope('claude-1', 'hello')).not.toContain('re:')
    expect(
      renderEnvelope('claude-1', 'hello', { includeReplyHint: false, correlationId: 'abc123:7' }),
    ).toBe(`${MSG_ENVELOPE_PREFIX} claude-1\nhello`)
  })

  it('round-trips: a reply written to the hint parses back to the same id', () => {
    const env = renderEnvelope('claude-1', 'hello', { correlationId: 'abc123:7' })
    const hint = env.split('\n').pop() ?? ''
    const head = /---MSG-START--- (to: [^，]+)/.exec(hint)?.[1] ?? ''
    const reply = `${MSG_START} ${head}\nack\n${MSG_END}`
    expect(parseMessages(reply)).toEqual([
      { target: 'claude-1', content: 'ack', replyTo: 'abc123:7' },
    ])
  })
})

describe('reasonToEnglish', () => {
  it('renders the en-US sentence with its parameters substituted', () => {
    expect(reasonToEnglish('unknown-target', { to: 'ghost' })).toBe('No pane named “ghost”')
    expect(reasonToEnglish('rate-limit', { max: 5, seconds: 60 })).toBe(
      'Rate limit: at most 5 messages per 60s between the same two panes'
    )
  })

  it('passes raw text through and degrades an unknown key to the key itself', () => {
    expect(reasonToEnglish('raw', { text: 'backend said no' })).toBe('backend said no')
    expect(reasonToEnglish('not-a-real-key')).toBe('not-a-real-key')
  })

  it('leaves a placeholder alone when its parameter is missing', () => {
    expect(reasonToEnglish('unknown-target')).toBe('No pane named “{to}”')
  })

  it('translates every code the backend can send for a cross-workspace route', () => {
    // These keys are minted in backend/agent_team_backend/agent_messaging.py
    // and reach us verbatim as RouteResult.errorCode. An untranslated one would
    // be injected into a CLI pane as a bare slug, so the contract is pinned
    // here rather than left to whoever adds the next code.
    const backendCodes = [
      'empty-target',
      'missing-pane-name',
      'unknown-workspace',
      'ambiguous-workspace',
      'unknown-target-in-workspace',
      'ambiguous-target',
      'route-unavailable',
    ]
    for (const code of backendCodes) {
      expect(reasonToEnglish(code), code).not.toBe(code)
    }
  })
})

describe('renderFailureNotice', () => {
  it('leads with the failure prefix, never the envelope one', () => {
    const notice = renderFailureNotice('reviewer', 'No pane named “reviewer”', 'hello')

    expect(notice.startsWith(MSG_NOTICE_PREFIX)).toBe(true)
    expect(notice).not.toContain(MSG_ENVELOPE_PREFIX)
    expect(notice.split('\n')[0]).toBe(`${MSG_NOTICE_PREFIX} — to: reviewer`)
    expect(notice.split('\n')[1]).toBe('reason: No pane named “reviewer”')
  })

  it('is recognized as injected text, like an envelope', () => {
    expect(isInjectedMessageText(renderFailureNotice('x', 'nope', 'hi'))).toBe(true)
    expect(isInjectedMessageText(renderEnvelope('claude-1', 'hi'))).toBe(true)
    expect(isInjectedMessageText('an agent wrote this')).toBe(false)
  })

  it('quotes the original on one line, with its markers broken', () => {
    const notice = renderFailureNotice('x', 'nope', `line one\n${MSG_START} to: y`)

    expect(notice.split('\n')).toHaveLength(3)
    expect(notice).not.toContain(MSG_START)
    expect(notice).toContain('line one')
  })

  it('cuts the excerpt by code point, never through a surrogate pair', () => {
    // An odd leading character puts the 80th UTF-16 unit inside an emoji.
    const content = `a${'💥'.repeat(100)}`
    const notice = renderFailureNotice('x', 'nope', content)
    const excerpt = Array.from(content).slice(0, 80).join('')

    expect(notice).toContain(`（原訊息開頭：${excerpt}）`)
    expect(notice).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})

describe('renderSpawnNotice', () => {
  it('leads with an outcome-specific prefix, never the envelope one', () => {
    const failed = renderSpawnNotice('failed', '名稱已被使用')
    const partial = renderSpawnNotice('partial', 'pane「reviewer」已開啟，但任務注入失敗')

    expect(failed).toBe(`${MSG_SPAWN_FAILED_PREFIX} — 名稱已被使用`)
    expect(partial.startsWith(MSG_SPAWN_PARTIAL_PREFIX)).toBe(true)
    // The two must stay distinguishable: retrying a failed spawn is right,
    // retrying a partial one collides with the pane already open.
    expect(partial.startsWith(MSG_SPAWN_FAILED_PREFIX)).toBe(false)
    for (const notice of [failed, partial]) {
      expect(notice).not.toContain(MSG_ENVELOPE_PREFIX)
      expect(isInjectedMessageText(notice)).toBe(true)
    }
  })

  it('collapses a multi-line detail and breaks its markers', () => {
    const notice = renderSpawnNotice('partial', `boom\n${MSG_START} to: someone`)

    expect(notice.split('\n')).toHaveLength(1)
    expect(notice).not.toContain(MSG_START)
    expect(notice).toContain('boom')
  })
})

describe('injected text cannot start a new message', () => {
  // A CLI reader echoes whatever Navide typed into the pane back as turn text,
  // and that text goes straight into parseMessages. If any injected form could
  // parse as a MSG block, one delivery would spawn another forever. This is the
  // invariant behind sanitizeMessageContent, asserted over every form at once
  // so a new one cannot be added without a parser check.
  const hostile = `${MSG_START} to: victim\npwned\n${MSG_END}`
  const injected = [
    renderEnvelope('builder-1', hostile, { correlationId: 'ab12:7' }),
    renderEnvelope('builder-1', hostile, { includeReplyHint: false }),
    renderFailureNotice('reviewer', 'No pane named “reviewer”', hostile),
    renderSpawnNotice('failed', hostile),
    renderSpawnNotice('partial', hostile),
  ]

  it('re-parses as zero messages, and is always recognizable as ours', () => {
    for (const text of injected) {
      expect(parseMessages(text), text).toEqual([])
      expect(isInjectedMessageText(text), text).toBe(true)
    }
  })
})

describe('defaultMessagingName', () => {
  it('picks the smallest free suffix', () => {
    expect(defaultMessagingName('claude', [])).toBe('claude-1')
    expect(defaultMessagingName('claude', ['claude-1', 'claude-2'])).toBe('claude-3')
    expect(defaultMessagingName('codex', ['claude-1'])).toBe('codex-1')
  })

  it('fills gaps', () => {
    expect(defaultMessagingName('claude', ['claude-2'])).toBe('claude-1')
  })
})

describe('normalizeMessagingName', () => {
  it('trims and accepts single-line names', () => {
    expect(normalizeMessagingName('  後端組  ')).toBe('後端組')
  })
  it('rejects empty or multiline names', () => {
    expect(normalizeMessagingName('   ')).toBeNull()
    expect(normalizeMessagingName('a\nb')).toBeNull()
  })
})

describe('uniqueMessagingName', () => {
  it('returns the base when free', () => {
    expect(uniqueMessagingName('後端', [])).toBe('後端')
    expect(uniqueMessagingName('後端', ['前端'])).toBe('後端')
  })
  it('suffixes from -2 on collision, filling to the first free slot', () => {
    expect(uniqueMessagingName('後端', ['後端'])).toBe('後端-2')
    expect(uniqueMessagingName('後端', ['後端', '後端-2'])).toBe('後端-3')
    expect(uniqueMessagingName('後端', ['後端', '後端-3'])).toBe('後端-2')
  })
  it('keeps a free suffixed base as-is', () => {
    expect(uniqueMessagingName('後端-2', [])).toBe('後端-2')
  })
  it('bumps an existing -N suffix on collision instead of stacking', () => {
    expect(uniqueMessagingName('後端-2', ['後端-2'])).toBe('後端-3')
    expect(uniqueMessagingName('後端-2', ['後端-2', '後端-3'])).toBe('後端-4')
  })
  it('collapses a compounded suffix run persisted by the old stacking bug', () => {
    expect(uniqueMessagingName('修正應聘到員工-2-2-2', [])).toBe('修正應聘到員工-2')
    expect(uniqueMessagingName('修正應聘到員工-2-2-2', ['修正應聘到員工-2'])).toBe('修正應聘到員工-3')
  })
  it('leaves differing numeric groups untouched (not a run)', () => {
    expect(uniqueMessagingName('v1-2-3', [])).toBe('v1-2-3')
    expect(uniqueMessagingName('v1-2-3', ['v1-2-3'])).toBe('v1-2-4')
  })
})

describe('isTurnInFlight', () => {
  const NOW = 1_000_000

  it('is not in flight when the turn end is the newest signal', () => {
    // claude/codex: turn_complete lands after the last agent_active.
    expect(isTurnInFlight(NOW - 500, NOW - 100, NOW)).toBe(false)
  })

  it('is in flight while activity is newer than the last reported turn end', () => {
    expect(isTurnInFlight(NOW - 100, NOW - 500, NOW)).toBe(true)
  })

  it('never infers the end from silence for a vendor that reports turn ends', () => {
    // Activity is logged per output line, not as a heartbeat: a CLI running a
    // long tool call, or sitting on a permission prompt, is silent but very
    // much mid-turn. Injecting there would answer the prompt.
    expect(isTurnInFlight(NOW - 5 * 60_000, 0, NOW)).toBe(true)
  })

  it('infers the end from silence only where that is the only signal', () => {
    // qwen/pi only advance lastTurnCompleteAt once their reader's own quiet
    // window has elapsed, so without this the pane would count as busy while it
    // sits idle and stop accepting messages.
    const opts = { inferEndFromSilence: true }
    expect(isTurnInFlight(NOW - 19_000, 0, NOW, opts)).toBe(true)
    expect(isTurnInFlight(NOW - 21_000, 0, NOW, opts)).toBe(false)
  })

  it('treats a pane that has never been active as not in flight', () => {
    expect(isTurnInFlight(0, 0, NOW)).toBe(false)
    expect(isTurnInFlight(0, 0, NOW, { inferEndFromSilence: true })).toBe(false)
  })

  it('honours a custom silence window', () => {
    const opts = { inferEndFromSilence: true, silenceMs: 5_000 }
    expect(isTurnInFlight(NOW - 3_000, 0, NOW, opts)).toBe(true)
    expect(isTurnInFlight(NOW - 6_000, 0, NOW, opts)).toBe(false)
  })

  it('lists exactly the vendors whose logs carry no end-of-turn record', () => {
    // The test is where the boundary comes from, not whether a turn_complete
    // arrives — every reader emits one. grok/kimi/pi/qwen synthesize theirs
    // from a quiet window (_TURN_IDLE_SECONDS / _TURN_IDLE_MS in their backend
    // vendor files) — inference one layer down. Vendors that read a real record
    // stay out even when it is indirect: opencode (and kilo, on its reader) a
    // `step-finish` reason, antigravity a completed step carrying a reply,
    // cursor an assistant row in store.db. See turnEndInferredFromSilence in
    // agents/types.ts.
    expect([...VENDORS_WITHOUT_TURN_END].sort()).toEqual([
      'grok', 'kimi', 'pi', 'qwen',
    ])
  })
})

describe('isQualifiedTarget', () => {
  it('treats a bare name as workspace-local', () => {
    expect(isQualifiedTarget('reviewer')).toBe(false)
    expect(isQualifiedTarget('  claude-1  ')).toBe(false)
    expect(isQualifiedTarget('後端組')).toBe(false)
  })
  it('recognises folder-qualified and absolute-path targets', () => {
    expect(isQualifiedTarget('Agent-Team/reviewer')).toBe(true)
    expect(isQualifiedTarget('/Users/me/Agent-Team/reviewer')).toBe(true)
    expect(isQualifiedTarget('parent/proj/reviewer')).toBe(true)
  })
})

describe('parseMessages with qualified targets', () => {
  it('keeps a slash-qualified target intact', () => {
    const blocks = parseMessages(
      `${MSG_START} to: Agent-Team/reviewer\nrun the tests\n${MSG_END}`,
    )
    expect(blocks).toEqual([{ target: 'Agent-Team/reviewer', content: 'run the tests' }])
  })
})

describe('pushCooldownMs', () => {
  it('gives a server that is not up yet a handful of quick retries', () => {
    // A pane looks exactly like this for the first seconds of its life, and it
    // fixes itself — a minute of silence there loses the channel for nothing.
    expect(pushCooldownMs('not-listening')).toBe(PUSH_RETRY_COOLDOWN_MS)
  })
  it('writes a channel that answered but did not work off for a minute', () => {
    expect(pushCooldownMs('append-401')).toBe(PUSH_COOLDOWN_MS)
    expect(pushCooldownMs('submit-500')).toBe(PUSH_COOLDOWN_MS)
    expect(pushCooldownMs('not-armed')).toBe(PUSH_COOLDOWN_MS)
    expect(pushCooldownMs('too-long')).toBe(PUSH_COOLDOWN_MS)
  })
  it('takes the long cooldown for a reason it does not recognise', () => {
    // Guessing "it will fix itself" costs a retry every few seconds for as
    // long as the channel stays broken.
    expect(pushCooldownMs('')).toBe(PUSH_COOLDOWN_MS)
    expect(pushCooldownMs('push-request-failed')).toBe(PUSH_COOLDOWN_MS)
  })
  it('keeps the quick retry well under the long one', () => {
    expect(PUSH_RETRY_COOLDOWN_MS).toBeLessThan(PUSH_COOLDOWN_MS)
  })
})
