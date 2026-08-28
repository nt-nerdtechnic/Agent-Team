import { describe, it, expect, vi, beforeEach } from 'vitest'

const store: Record<string, unknown> = {}
vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: vi.fn((key: string, fallback: unknown) => (key in store ? store[key] : fallback)),
  settingsSet: vi.fn((key: string, value: unknown) => {
    store[key] = value
  }),
}))

import { DEFAULT_LOOP_PROMPT, LOOP_PROMPT_SETTING_KEY } from '../loopPrompt'
import {
  PROMPT_SKILLS_SETTING_KEY,
  builtinPromptSkills,
  castablePromptSkills,
  defaultPromptSkill,
  loadPromptSkills,
  nextSkillId,
  normalizePromptSkills,
  resolvePromptSkill,
  ringGeometry,
  ringSlotOffsets,
  savePromptSkills,
  RING_MAX_SLOTS,
  RING_R_MAX,
  RING_R_MIN,
  RING_SLOT_D,
  RING_SLOT_GAP,
  type PromptSkill,
} from '../promptSkills'

function skill(over: Partial<PromptSkill> = {}): PromptSkill {
  return {
    id: 'x',
    name: 'X',
    icon: 'advance',
    description: '',
    prompt: 'do the thing',
    resumePrompt: '',
    maxTurns: 0,
    category: 'dev',
    enabled: true,
    isDefault: false,
    ...over,
  }
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key]
})

describe('normalizePromptSkills', () => {
  it('falls back to the builtin seeded from the legacy prompt', () => {
    const skills = normalizePromptSkills(null, 'legacy text')
    expect(skills).toHaveLength(1)
    expect(skills[0].prompt).toBe('legacy text')
    expect(skills[0].isDefault).toBe(true)
  })

  it('treats an empty array and a non-array the same as missing', () => {
    expect(normalizePromptSkills([])[0].prompt).toBe(DEFAULT_LOOP_PROMPT)
    expect(normalizePromptSkills('nonsense')[0].prompt).toBe(DEFAULT_LOOP_PROMPT)
  })

  it('drops entries with no prompt to send', () => {
    const skills = normalizePromptSkills([skill({ id: 'a' }), skill({ id: 'b', prompt: '   ' })])
    expect(skills.map((s) => s.id)).toEqual(['a'])
  })

  it('keeps exactly one default even when several claim it', () => {
    const skills = normalizePromptSkills([
      skill({ id: 'a', isDefault: true }),
      skill({ id: 'b', isDefault: true }),
    ])
    expect(skills.filter((s) => s.isDefault).map((s) => s.id)).toEqual(['a'])
  })

  it('promotes the first enabled skill when the flagged default is disabled', () => {
    const skills = normalizePromptSkills([
      skill({ id: 'a', isDefault: true, enabled: false }),
      skill({ id: 'b' }),
    ])
    expect(defaultPromptSkill(skills).id).toBe('b')
  })

  it('de-duplicates ids instead of letting a later entry shadow an earlier one', () => {
    const skills = normalizePromptSkills([skill({ id: 'dup', name: 'One' }), skill({ id: 'dup', name: 'Two' })])
    expect(new Set(skills.map((s) => s.id)).size).toBe(2)
  })

  it('coerces unknown icons and negative turn counts', () => {
    const [s] = normalizePromptSkills([skill({ icon: 'nope' as never, maxTurns: -3 })])
    expect(s.icon).toBe('advance')
    expect(s.maxTurns).toBe(0)
  })
})

describe('loadPromptSkills', () => {
  it('migrates the legacy single prompt on first run', () => {
    store[LOOP_PROMPT_SETTING_KEY] = 'my old loop prompt'
    const skills = loadPromptSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].prompt).toBe('my old loop prompt')
  })

  it('prefers stored skills over the legacy key once they exist', () => {
    store[LOOP_PROMPT_SETTING_KEY] = 'my old loop prompt'
    store[PROMPT_SKILLS_SETTING_KEY] = [skill({ id: 'a', prompt: 'new one', isDefault: true })]
    expect(loadPromptSkills().map((s) => s.prompt)).toEqual(['new one'])
  })
})

describe('savePromptSkills', () => {
  it('mirrors the default skill prompt back to the legacy key', () => {
    savePromptSkills([
      skill({ id: 'a', prompt: 'first' }),
      skill({ id: 'b', prompt: 'second', isDefault: true }),
    ])
    expect(store[LOOP_PROMPT_SETTING_KEY]).toBe('second')
    expect((store[PROMPT_SKILLS_SETTING_KEY] as PromptSkill[]).map((s) => s.id)).toEqual(['a', 'b'])
  })
})

describe('resolvePromptSkill', () => {
  const skills = normalizePromptSkills([
    skill({ id: 'a', prompt: 'A', isDefault: true }),
    skill({ id: 'b', prompt: 'B' }),
  ])

  it('returns the named skill', () => {
    expect(resolvePromptSkill(skills, 'b').prompt).toBe('B')
  })

  it('falls back to the default for a deleted or absent id', () => {
    expect(resolvePromptSkill(skills, 'gone').prompt).toBe('A')
    expect(resolvePromptSkill(skills, null).prompt).toBe('A')
  })
})

describe('castablePromptSkills', () => {
  it('hides disabled skills and puts the default first', () => {
    const skills = normalizePromptSkills([
      skill({ id: 'a' }),
      skill({ id: 'b', enabled: false }),
      skill({ id: 'c', isDefault: true }),
    ])
    expect(castablePromptSkills(skills).map((s) => s.id)).toEqual(['c', 'a'])
  })
})

describe('nextSkillId', () => {
  it('slugifies and de-duplicates', () => {
    expect(nextSkillId([], 'Fix Until Green')).toBe('fix-until-green')
    expect(nextSkillId(['fix-until-green'], 'Fix Until Green')).toBe('fix-until-green-2')
  })

  it('falls back to a stem for names with nothing to slugify', () => {
    expect(nextSkillId([], '修到全綠')).toBe('skill')
    expect(nextSkillId(['skill'], '修到全綠')).toBe('skill-2')
  })
})

describe('builtinPromptSkills', () => {
  it('carries the legacy default prompt verbatim', () => {
    expect(builtinPromptSkills()[0].prompt).toBe(DEFAULT_LOOP_PROMPT)
  })
})

describe('ringGeometry', () => {
  it('keeps a lone slot close to the button instead of floating it out', () => {
    expect(ringGeometry(1)).toEqual({ radius: RING_R_MIN, step: 0, start: 90 })
  })

  it('grows the radius only as far as the spacing rule demands', () => {
    const radii = [1, 2, 3, 4, 5].map((n) => ringGeometry(n).radius)
    // Monotonic, never below the floor, never past the ceiling.
    for (let i = 1; i < radii.length; i += 1) expect(radii[i]).toBeGreaterThanOrEqual(radii[i - 1])
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(RING_R_MIN)
    expect(Math.max(...radii)).toBeLessThanOrEqual(RING_R_MAX)
  })

  it('leaves at least one slot width plus the gap between neighbours', () => {
    for (let n = 2; n <= RING_MAX_SLOTS; n += 1) {
      const offsets = ringSlotOffsets(n)
      for (let i = 1; i < offsets.length; i += 1) {
        const dx = offsets[i].x - offsets[i - 1].x
        const dy = offsets[i].y - offsets[i - 1].y
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(RING_SLOT_D + RING_SLOT_GAP - 0.01)
      }
    }
  })

  it('centers the fan on straight down and keeps every slot below the button', () => {
    for (let n = 1; n <= RING_MAX_SLOTS; n += 1) {
      const offsets = ringSlotOffsets(n)
      for (const o of offsets) expect(o.y).toBeGreaterThan(0)
      const xs = offsets.map((o) => o.x)
      // Symmetric about the button: leftmost and rightmost mirror each other.
      expect(Math.abs(Math.min(...xs) + Math.max(...xs))).toBeLessThan(0.01)
    }
  })
})

describe('ringSlotOffsets ordering', () => {
  it('puts the first skill on the left so digit keys read left-to-right', () => {
    const xs = ringSlotOffsets(5).map((o) => o.x)
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]).toBeGreaterThan(xs[i - 1])
  })
})
