import { describe, it, expect } from 'vitest'
import {
  MSG_START,
  MSG_END,
  MSG_ENVELOPE_PREFIX,
  parseMessages,
  sanitizeMessageContent,
  renderEnvelope,
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
