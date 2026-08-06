import { describe, expect, it } from 'vitest'

import { echoLanded, echoTimeoutFor, growthNeededFor, normalizeForMatch, TAIL_MATCH_LEN } from '../injectEcho'

describe('normalizeForMatch', () => {
  it('drops whitespace so a re-indented echo still matches', () => {
    expect(normalizeForMatch('hello   world\n  again')).toBe('helloworldagain')
  })

  it("drops the TUI's frame characters", () => {
    // A wrapped line puts the frame between our own characters; leaving it in
    // breaks an otherwise exact match.
    expect(normalizeForMatch('db/schema.sql │\n│ 裡定義了')).toBe('db/schema.sql裡定義了')
  })
})

describe('growthNeededFor', () => {
  it('caps at the flat minimum for long payloads', () => {
    expect(growthNeededFor(500)).toBe(40)
  })

  it('scales down for a short prompt that can never grow 40 chars', () => {
    expect(growthNeededFor(38)).toBe(19)
  })

  it('keeps a floor that noise cannot reach', () => {
    expect(growthNeededFor(4)).toBe(8)
  })
})

describe('echoLanded', () => {
  const text = '請只用一句話回答，不要使用任何工具：db/schema.sql 裡定義了哪些資料表？'
  const normalized = normalizeForMatch(text)
  const tail = normalized.slice(-TAIL_MATCH_LEN)

  it('matches a wrapped echo that the TUI framed mid-sentence', () => {
    // The exact shape that caused a duplicate injection: our prompt wrapped,
    // with the frame drawn at the break.
    const buffer = '❯ 請只用一句話回答，不要使用任何工具：db/schema.sql │\n│   裡定義了哪些資料表？'

    expect(echoLanded(buffer, tail, 5, normalized.length)).toBe(true)
  })

  it('accepts growth alone when the tail cannot be matched', () => {
    expect(echoLanded('[Pasted text +12 lines]', tail, 25, normalized.length)).toBe(true)
  })

  it('rejects an empty echo with no growth — nothing landed', () => {
    expect(echoLanded('❯ ', tail, 0, normalized.length)).toBe(false)
  })

  it('a short prompt no longer needs 40 chars of growth', () => {
    const short = normalizeForMatch('回答 A 或 B')

    expect(echoLanded('unrelated', 'nomatch', 10, short.length)).toBe(true)
  })
})

describe('echoTimeoutFor', () => {
  it('gives a short prompt enough time for a freshly booted CLI', () => {
    // At the old 2.5s floor a just-spawned pane resent a ~40 char prompt three
    // times before its first echo appeared.
    expect(echoTimeoutFor(40)).toBe(6_000)
  })

  it('caps long payloads at the ceiling', () => {
    expect(echoTimeoutFor(90_000)).toBe(8_000)
  })

  it('scales between the floor and the ceiling', () => {
    expect(echoTimeoutFor(42_000)).toBe(7_000)
  })
})
