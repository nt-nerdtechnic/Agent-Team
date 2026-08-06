import { describe, it, expect } from 'vitest'
import { parseConflicts, buildResolved, hasConflicts, countConflicts } from '../conflict-parser'

const SIMPLE = `line before
<<<<<<< HEAD
ours line 1
ours line 2
=======
theirs line 1
>>>>>>> feature
line after
`

const TWO_CONFLICTS = `section1
<<<<<<< HEAD
alpha_ours
=======
alpha_theirs
>>>>>>> feat
section2
<<<<<<< HEAD
beta_ours
=======
beta_theirs
>>>>>>> feat
section3
`

const NO_CONFLICT = `just a normal
file with no markers
`

// merge.conflictStyle=diff3 / zdiff3 adds a ||||||| common-ancestor block.
const DIFF3 = `line before
<<<<<<< HEAD
ours line 1
||||||| merged common ancestors
base line 1
base line 2
=======
theirs line 1
>>>>>>> feature
line after
`

const DIFF3_EMPTY_BASE = `<<<<<<< HEAD
ours only
||||||| 4b825dc
=======
theirs only
>>>>>>> feature
`

const DIFF3_EMPTY_SIDES = `head
<<<<<<< HEAD
||||||| base
base only
=======
>>>>>>> feature
tail
`

// Content that merely looks like markers must not be treated as one.
const DIFF3_LOOKALIKE = `<<<<<<< HEAD
ours ||| not a marker
||||||| base
base has ======= inside prose
=======
theirs ends with >>> arrows
>>>>>>> feature
`

const DIFF3_NO_TRAILING_NEWLINE = `<<<<<<< HEAD
ours tail
||||||| base
base tail
=======
theirs tail
>>>>>>> feature`

describe('hasConflicts', () => {
  it('returns true when markers present', () => expect(hasConflicts(SIMPLE)).toBe(true))
  it('returns false for clean file', () => expect(hasConflicts(NO_CONFLICT)).toBe(false))
})

describe('parseConflicts', () => {
  it('splits simple conflict into 3 sections', () => {
    const sections = parseConflicts(SIMPLE)
    expect(sections.map((s) => s.kind)).toEqual(['context', 'conflict', 'context'])
  })

  it('captures ours/theirs lines correctly', () => {
    const sections = parseConflicts(SIMPLE)
    const c = sections[1]
    expect(c.kind).toBe('conflict')
    if (c.kind === 'conflict') {
      expect(c.ours).toEqual(['ours line 1', 'ours line 2'])
      expect(c.theirs).toEqual(['theirs line 1'])
      expect(c.oursLabel).toBe('HEAD')
      expect(c.theirsLabel).toBe('feature')
    }
  })

  it('handles two conflict blocks', () => {
    const sections = parseConflicts(TWO_CONFLICTS)
    expect(countConflicts(sections)).toBe(2)
  })

  it('returns single context for clean file', () => {
    const sections = parseConflicts(NO_CONFLICT)
    expect(sections).toHaveLength(1)
    expect(sections[0].kind).toBe('context')
  })
})

describe('buildResolved', () => {
  it('accept ours', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(sections, new Map([[0, 'ours']]), new Map())
    expect(result).toContain('ours line 1')
    expect(result).not.toContain('theirs line 1')
    expect(result).toContain('line before')
    expect(result).toContain('line after')
  })

  it('accept theirs', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(sections, new Map([[0, 'theirs']]), new Map())
    expect(result).toContain('theirs line 1')
    expect(result).not.toContain('ours line 1')
  })

  it('accept both: ours first then theirs', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(sections, new Map([[0, 'both']]), new Map())
    const oursPos = result.indexOf('ours line 1')
    const theirsPos = result.indexOf('theirs line 1')
    expect(oursPos).toBeGreaterThanOrEqual(0)
    expect(theirsPos).toBeGreaterThanOrEqual(0)
    expect(oursPos).toBeLessThan(theirsPos)
  })

  it('manual edit overrides', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(
      sections,
      new Map([[0, 'manual']]),
      new Map([[0, 'hand crafted line']]),
    )
    expect(result).toContain('hand crafted line')
    expect(result).not.toContain('ours line 1')
    expect(result).not.toContain('theirs line 1')
  })

  it('two conflicts with different choices', () => {
    const sections = parseConflicts(TWO_CONFLICTS)
    const result = buildResolved(
      sections,
      new Map([[0, 'ours'], [1, 'theirs']]),
      new Map(),
    )
    expect(result).toContain('alpha_ours')
    expect(result).not.toContain('alpha_theirs')
    expect(result).toContain('beta_theirs')
    expect(result).not.toContain('beta_ours')
  })

  it('always ends with newline', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(sections, new Map([[0, 'ours']]), new Map())
    expect(result.endsWith('\n')).toBe(true)
  })
})

describe('parseConflicts – diff3 / zdiff3 base block', () => {
  function conflictAt(content: string, idx = 0) {
    const s = parseConflicts(content).filter((x) => x.kind === 'conflict')[idx]
    if (s.kind !== 'conflict') throw new Error('not a conflict section')
    return s
  }

  it('reports hasBase=false and an empty base for 2-way conflicts', () => {
    const c = conflictAt(SIMPLE)
    expect(c.hasBase).toBe(false)
    expect(c.base).toEqual([])
  })

  it('captures the base block instead of swallowing it into ours', () => {
    const c = conflictAt(DIFF3)
    expect(c.hasBase).toBe(true)
    expect(c.ours).toEqual(['ours line 1'])
    expect(c.base).toEqual(['base line 1', 'base line 2'])
    expect(c.theirs).toEqual(['theirs line 1'])
    expect(c.oursLabel).toBe('HEAD')
    expect(c.theirsLabel).toBe('feature')
  })

  it('never leaks the ||||||| marker into any side', () => {
    const c = conflictAt(DIFF3)
    for (const side of [c.ours, c.base, c.theirs]) {
      expect(side.some((l) => l.startsWith('|||||||'))).toBe(false)
    }
  })

  it('distinguishes an empty base block from no base block', () => {
    const c = conflictAt(DIFF3_EMPTY_BASE)
    expect(c.hasBase).toBe(true)
    expect(c.base).toEqual([])
    expect(c.ours).toEqual(['ours only'])
    expect(c.theirs).toEqual(['theirs only'])
  })

  it('handles empty ours and empty theirs sides', () => {
    const c = conflictAt(DIFF3_EMPTY_SIDES)
    expect(c.ours).toEqual([])
    expect(c.base).toEqual(['base only'])
    expect(c.theirs).toEqual([])
  })

  it('treats marker lookalikes inside content as ordinary lines', () => {
    const c = conflictAt(DIFF3_LOOKALIKE)
    expect(c.ours).toEqual(['ours ||| not a marker'])
    expect(c.base).toEqual(['base has ======= inside prose'])
    expect(c.theirs).toEqual(['theirs ends with >>> arrows'])
  })

  it('parses a file whose final line has no trailing newline', () => {
    const c = conflictAt(DIFF3_NO_TRAILING_NEWLINE)
    expect(c.hasBase).toBe(true)
    expect(c.base).toEqual(['base tail'])
    expect(c.theirsLabel).toBe('feature')
  })
})

describe('buildResolved – diff3 choices', () => {
  it('accept ours drops both the base and theirs sides', () => {
    const result = buildResolved(parseConflicts(DIFF3), new Map([[0, 'ours']]), new Map())
    expect(result).toContain('ours line 1')
    expect(result).not.toContain('base line 1')
    expect(result).not.toContain('theirs line 1')
    expect(result).not.toContain('|||||||')
  })

  it('accept base keeps only the common ancestor', () => {
    const result = buildResolved(parseConflicts(DIFF3), new Map([[0, 'base']]), new Map())
    expect(result).toContain('base line 1')
    expect(result).toContain('base line 2')
    expect(result).not.toContain('ours line 1')
    expect(result).not.toContain('theirs line 1')
    expect(result).toContain('line before')
    expect(result).toContain('line after')
  })

  it('accept both keeps ours then theirs and never the base', () => {
    const result = buildResolved(parseConflicts(DIFF3), new Map([[0, 'both']]), new Map())
    expect(result.indexOf('ours line 1')).toBeLessThan(result.indexOf('theirs line 1'))
    expect(result).not.toContain('base line 1')
  })

  it('accept base on an empty base block removes the whole conflict', () => {
    const result = buildResolved(parseConflicts(DIFF3_EMPTY_BASE), new Map([[0, 'base']]), new Map())
    expect(result).toBe('\n')
  })

  it('accept ours on an empty ours side removes the whole conflict', () => {
    const result = buildResolved(parseConflicts(DIFF3_EMPTY_SIDES), new Map([[0, 'ours']]), new Map())
    expect(result).toBe('head\ntail\n')
  })

  it('resolves a file with no trailing newline into a newline-terminated file', () => {
    const result = buildResolved(
      parseConflicts(DIFF3_NO_TRAILING_NEWLINE), new Map([[0, 'theirs']]), new Map(),
    )
    expect(result).toBe('theirs tail\n')
  })
})
