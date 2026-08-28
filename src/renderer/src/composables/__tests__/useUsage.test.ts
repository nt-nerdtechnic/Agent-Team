// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import {
  __resetUsageForTest,
  accountUsageFor,
  formatRemaining,
  formatResetCountdown,
  initUsage,
  remainingPercent,
  remainingTier,
  usageFor,
  type UsageSnapshot
} from '../useUsage'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

// Local test fixture — the frontend no longer keeps a provider allowlist
// (the backend payload is the single source of who has a usage provider).
const TEST_PROVIDERS = [
  'claude', 'codex', 'kimi', 'grok', 'antigravity', 'opencode',
  'qwen', 'kilo', 'pi', 'copilot', 'cursor'
] as const

function snap(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'claude',
    status: 'ok',
    planType: null,
    windows: [{ kind: 'session', label: 'Session (5h)', usedPercent: 42, resetsAt: null }],
    fetchedAt: '2026-07-24T00:00:00Z',
    error: null,
    ...overrides
  }
}

type Handler = (raw: unknown) => void

function fakeBackend(): {
  backend: {
    status: ReturnType<typeof ref<string>>
    send: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
  }
  emit: (type: string, payload: unknown) => void
} {
  const handlers = new Map<string, Handler>()
  const backend = {
    status: ref('connected'),
    send: vi.fn(async () => ({ ok: true, payload: {} })),
    on: vi.fn((type: string, cb: Handler) => {
      handlers.set(type, cb)
      return () => handlers.delete(type)
    })
  }
  return { backend, emit: (type, payload) => handlers.get(type)?.(payload) }
}

describe('useUsage store', () => {
  beforeEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })
  afterEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })

  it('sends usage.configure on connect and applies usage.changed broadcasts', async () => {
    const { backend, emit } = fakeBackend()
    initUsage(backend as never)
    await Promise.resolve()
    expect(backend.send).toHaveBeenCalledWith(
      'usage.configure',
      expect.objectContaining({ enabled: true, intervalSec: 300 })
    )
    emit('usage.changed', { providers: { claude: snap() } })
    expect(usageFor('claude')?.windows[0].usedPercent).toBe(42)
  })

  it('usageFor maps only supported agent keys', () => {
    const { backend, emit } = fakeBackend()
    initUsage(backend as never)
    const providers: Record<string, UsageSnapshot> = {}
    for (const key of TEST_PROVIDERS) providers[key] = snap({ provider: key })
    emit('usage.changed', { providers })
    for (const key of TEST_PROVIDERS) {
      expect(usageFor(key), key).toBeDefined()
    }
    expect(usageFor('aider')).toBeUndefined()
    expect(usageFor('terminal')).toBeUndefined()
    expect(usageFor(undefined)).toBeUndefined()
  })

  it('stores account snapshots by provider and stable slot id', () => {
    const { backend, emit } = fakeBackend()
    initUsage(backend as never)
    emit('usage.changed', {
      providers: { claude: snap({ fetchedAt: '2026-07-24T03:00:00Z' }) },
      accounts: {
        claude: {
          __default__: snap({ windows: [{ kind: 'session', label: 'Session', usedPercent: 20, resetsAt: null }] }),
          p1: snap({ windows: [{ kind: 'session', label: 'Session', usedPercent: 70, resetsAt: null }] }),
        },
      },
    })

    expect(accountUsageFor('claude', null)?.windows[0].usedPercent).toBe(20)
    expect(accountUsageFor('claude', 'p1')?.windows[0].usedPercent).toBe(70)
    expect(accountUsageFor('claude', 'missing')).toBeUndefined()
    expect(usageFor('claude')?.fetchedAt).toBe('2026-07-24T03:00:00Z')
  })

  it('clears account snapshots when a legacy backend sends providers only', () => {
    const { backend, emit } = fakeBackend()
    initUsage(backend as never)
    emit('usage.changed', {
      providers: { claude: snap() },
      accounts: { claude: { p1: snap() } },
    })
    expect(accountUsageFor('claude', 'p1')).toBeDefined()

    emit('usage.changed', { providers: { claude: snap({ fetchedAt: '2026-07-24T04:00:00Z' }) } })
    expect(accountUsageFor('claude', 'p1')).toBeUndefined()
    expect(usageFor('claude')?.fetchedAt).toBe('2026-07-24T04:00:00Z')
  })

  it('remainingPercent inverts the first window and gates on status', () => {
    expect(remainingPercent(snap())).toBe(58)
    expect(remainingPercent(snap({ status: 'expired' }))).toBeNull()
    expect(remainingPercent(snap({ windows: [] }))).toBeNull()
    expect(remainingPercent(undefined)).toBeNull()
  })

  it('remainingPercent headline skips per-model windows (spent Fable promo)', () => {
    // A maxed promotional "Fable only" (weekly-model, 100% used, not enforced)
    // must not drive the badge when a healthy general window exists.
    const withFable = snap({
      windows: [
        { kind: 'session', label: 'Session (5h)', usedPercent: 4, resetsAt: null },
        { kind: 'weekly', label: 'Weekly (all models)', usedPercent: 92, resetsAt: null },
        { kind: 'weekly-model', label: 'Fable only', usedPercent: 100, resetsAt: null }
      ]
    })
    expect(remainingPercent(withFable)).toBe(96) // session, never Fable's 0%
    // Degenerate: only a per-model window → fall back to it.
    const onlyFable = snap({
      windows: [{ kind: 'weekly-model', label: 'Fable only', usedPercent: 100, resetsAt: null }]
    })
    expect(remainingPercent(onlyFable)).toBe(0)
  })

  it('remainingPercent ignores cached windows whose reset has passed', () => {
    const stale = snap({
      stale: true,
      staleExpired: true,
      windows: [
        { kind: 'session', label: 'Session', usedPercent: 20, resetsAt: null, expired: true },
        { kind: 'weekly', label: 'Weekly', usedPercent: 60, resetsAt: null },
      ],
    })
    expect(remainingPercent(stale)).toBe(40)
    expect(remainingPercent({ ...stale, windows: [stale.windows[0]] })).toBeNull()
  })

  it('remainingTier thresholds: >40 ok, 15-40 warn, <15 crit', () => {
    expect(remainingTier(58)).toBe('ok')
    expect(remainingTier(41)).toBe('ok')
    expect(remainingTier(40)).toBe('warn')
    expect(remainingTier(15)).toBe('warn')
    expect(remainingTier(14.9)).toBe('crit')
    expect(remainingTier(0)).toBe('crit')
  })

  it('formatRemaining rounds and keeps the <1% special case', () => {
    expect(formatRemaining(58.4)).toBe('58%')
    expect(formatRemaining(0.5)).toBe('<1%')
    expect(formatRemaining(0)).toBe('0%')
  })

  it('formatResetCountdown renders d/h/m tiers and empty for the past', () => {
    const now = Date.parse('2026-07-24T00:00:00Z')
    expect(formatResetCountdown('2026-07-24T03:15:00Z', now)).toBe('3h 15m')
    expect(formatResetCountdown('2026-07-26T02:00:00Z', now)).toBe('2d 2h')
    expect(formatResetCountdown('2026-07-24T00:12:00Z', now)).toBe('12m')
    expect(formatResetCountdown('2026-07-23T00:00:00Z', now)).toBe('')
    expect(formatResetCountdown(null, now)).toBe('')
    expect(formatResetCountdown('not-a-date', now)).toBe('')
  })
})
