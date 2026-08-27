// Prompt skills: the reusable one-shot instructions a CLI pane's ∞ button can
// cast. Each skill is one WHOLE prompt — skills are mutually exclusive, never
// concatenated (see .agent-team/plans/prompt-prompt-skills_70c667.html).
//
// Storage lives in the unified settings store under PROMPT_SKILLS_SETTING_KEY.
// The default skill's prompt is mirrored back to LOOP_PROMPT_SETTING_KEY on
// every save, so a downgrade to a build that predates skills still finds a
// usable loop prompt where it expects one.
import { DEFAULT_LOOP_PROMPT, LOOP_PROMPT_SETTING_KEY } from './loopPrompt'
import { settingsGet, settingsSet } from './settings'

export const PROMPT_SKILLS_SETTING_KEY = 'prompt-skills'

/** Icon names, not SVG strings: the drawing can change without touching a
 *  user's stored skills. Rendered by PromptSkillIcon.vue. */
export const PROMPT_SKILL_ICONS = ['advance', 'green', 'scan', 'doc', 'refactor', 'edit'] as const
export type PromptSkillIcon = (typeof PROMPT_SKILL_ICONS)[number]

export interface PromptSkill {
  id: string
  name: string
  icon: PromptSkillIcon
  description: string
  /** The whole injected instruction. LOOP_DONE_INSTRUCTION is appended at
   *  injection time, exactly as it is for the legacy single prompt. */
  prompt: string
  /** Per-skill resume text; empty means fall back to the global setting. */
  resumePrompt: string
  /** Stop the loop after this many turns. 0 means unlimited (today's behavior). */
  maxTurns: number
  category: string
  enabled: boolean
  /** Which skill a plain click on ∞ casts. Exactly one skill carries it. */
  isDefault: boolean
}

/** The skill a fresh install starts with — the legacy loop prompt, verbatim. */
export function builtinPromptSkills(legacyPrompt = DEFAULT_LOOP_PROMPT): PromptSkill[] {
  return [
    {
      id: 'advance',
      name: '開發推進',
      icon: 'advance',
      description: '持續推進到完成度 100%，完成後產出 HTML 報告書。',
      prompt: legacyPrompt,
      resumePrompt: '',
      maxTurns: 0,
      category: 'dev',
      enabled: true,
      isDefault: true,
    },
  ]
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asIcon(value: unknown): PromptSkillIcon {
  return PROMPT_SKILL_ICONS.includes(value as PromptSkillIcon)
    ? (value as PromptSkillIcon)
    : 'advance'
}

function asTurns(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Slugify `name` into an id that doesn't collide with `taken`. Non-ASCII
 *  names (the common case here) leave nothing to slugify, hence the `skill`
 *  stem plus a counter. */
export function nextSkillId(taken: readonly string[], name: string): string {
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'skill'
  if (!taken.includes(stem)) return stem
  for (let i = 2; ; i += 1) {
    const candidate = `${stem}-${i}`
    if (!taken.includes(candidate)) return candidate
  }
}

/** Coerce whatever is in the settings store into a valid skill list.
 *
 *  Guarantees the rest of the app relies on: at least one skill, every id
 *  unique and non-empty, and exactly one `isDefault`. A stored list that is
 *  missing/!Array/empty falls back to the builtin seeded from `legacyPrompt`
 *  — that is the one-time migration off LOOP_PROMPT_SETTING_KEY. */
export function normalizePromptSkills(raw: unknown, legacyPrompt = DEFAULT_LOOP_PROMPT): PromptSkill[] {
  if (!Array.isArray(raw) || raw.length === 0) return builtinPromptSkills(legacyPrompt)
  const ids: string[] = []
  const skills: PromptSkill[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const prompt = asString(e.prompt)
    if (!prompt.trim()) continue // a skill with nothing to send is not a skill
    const name = asString(e.name).trim() || '未命名技能'
    const rawId = asString(e.id).trim()
    const id = rawId && !ids.includes(rawId) ? rawId : nextSkillId(ids, name)
    ids.push(id)
    skills.push({
      id,
      name,
      icon: asIcon(e.icon),
      description: asString(e.description),
      prompt,
      resumePrompt: asString(e.resumePrompt),
      maxTurns: asTurns(e.maxTurns),
      category: asString(e.category, 'custom'),
      enabled: e.enabled !== false,
      isDefault: e.isDefault === true,
    })
  }
  if (skills.length === 0) return builtinPromptSkills(legacyPrompt)
  // Exactly one default: keep the first one flagged, else promote the first
  // enabled skill (a disabled default would leave a plain ∞ click with nothing
  // to cast).
  const flagged = skills.findIndex((s) => s.isDefault && s.enabled)
  const chosen = flagged >= 0 ? flagged : Math.max(0, skills.findIndex((s) => s.enabled))
  return skills.map((s, i) => ({ ...s, isDefault: i === chosen }))
}

/** Read the skill list, migrating from the legacy single prompt on first run. */
export function loadPromptSkills(): PromptSkill[] {
  const legacy = settingsGet(LOOP_PROMPT_SETTING_KEY, DEFAULT_LOOP_PROMPT)
  return normalizePromptSkills(settingsGet<unknown>(PROMPT_SKILLS_SETTING_KEY, null), legacy)
}

/** Persist the list, mirroring the default skill's prompt to the legacy key. */
export function savePromptSkills(skills: readonly PromptSkill[]): PromptSkill[] {
  const normalized = normalizePromptSkills(skills as unknown)
  settingsSet(PROMPT_SKILLS_SETTING_KEY, normalized)
  settingsSet(LOOP_PROMPT_SETTING_KEY, defaultPromptSkill(normalized).prompt)
  return normalized
}

/** The skill a plain ∞ click casts. Never null: normalize guarantees one. */
export function defaultPromptSkill(skills: readonly PromptSkill[]): PromptSkill {
  return skills.find((s) => s.isDefault) ?? skills[0]
}

/** Look up by id, falling back to the default skill when the id is unknown
 *  (a stale pane can hold the id of a skill the user has since deleted). */
export function resolvePromptSkill(skills: readonly PromptSkill[], id: string | null | undefined): PromptSkill {
  if (!id) return defaultPromptSkill(skills)
  return skills.find((s) => s.id === id) ?? defaultPromptSkill(skills)
}

/** Skills offered by the ∞ picker: enabled only, default first. */
export function castablePromptSkills(skills: readonly PromptSkill[]): PromptSkill[] {
  const enabled = skills.filter((s) => s.enabled)
  return enabled.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/* ── Ring geometry ──────────────────────────────────────────────────────────
 * The ∞ picker lays its slots on an arc centered on straight-down. Radius is
 * SOLVED from the slot count rather than fixed: neighbours sit STEP_DEG apart,
 * so the chord between two centers is 2·R·sin(step/2), and requiring that
 * chord to be one slot wide plus a gap gives R. One slot then hugs the button
 * while five fan out far enough not to touch — a fixed radius did the
 * opposite, floating a lone slot 74px away for no reason.
 */

/** Slot diameter and the visual gap kept between two neighbours. */
export const RING_SLOT_D = 40
export const RING_SLOT_GAP = 12
/** Closest a slot may sit to the button, and the furthest the ring may push
 *  out before it stops reading as attached to it. */
export const RING_R_MIN = 46
export const RING_R_MAX = 92
/** Angle between neighbours, and the widest fan allowed. */
export const RING_STEP_DEG = 44
export const RING_SPAN_MAX_DEG = 140
/** Above this many skills the ring is replaced by the list layout. */
export const RING_MAX_SLOTS = 5

export interface RingGeometry {
  radius: number
  /** Degrees between neighbours (0 for a single slot). */
  step: number
  /** Angle of the first slot; 90° is straight down. */
  start: number
}

export function ringGeometry(count: number): RingGeometry {
  if (count <= 1) return { radius: RING_R_MIN, step: 0, start: 90 }
  const span = Math.min(RING_SPAN_MAX_DEG, RING_STEP_DEG * (count - 1))
  const step = span / (count - 1)
  const chord = RING_SLOT_D + RING_SLOT_GAP
  const needed = chord / (2 * Math.sin((step * Math.PI) / 360))
  return {
    radius: Math.min(RING_R_MAX, Math.max(RING_R_MIN, needed)),
    step,
    start: 90 - span / 2,
  }
}

/** Slot center offsets from the ring origin (the button's bottom center).
 *
 *  Index 0 is the LEFTMOST slot: the list arrives default-first and the digit
 *  keys are 1..n, so reading order has to run left-to-right like every other
 *  menu. Angles are measured from the +x axis, which walks right-to-left, so
 *  the arc is traversed backwards here. */
export function ringSlotOffsets(count: number): { x: number; y: number }[] {
  const { radius, step, start } = ringGeometry(count)
  return Array.from({ length: count }, (_, i) => {
    const rad = ((180 - start - step * i) * Math.PI) / 180
    return { x: Math.cos(rad) * radius, y: Math.sin(rad) * radius }
  })
}
