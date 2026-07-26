// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import UsageBadge from '../UsageBadge.vue'
import { i18n } from '../../i18n'
import type { UsageSnapshot } from '../../composables/useUsage'
import type {
  CliAccountIdentity,
  CliProfile,
  SetDefaultResult,
  useCliProfiles,
} from '../../composables/useCliProfiles'

// Mock boundary: keep useUsage's pure formatters real, replace the singleton
// readers (usageFor) and the backend call (refreshUsage) with controllable fns.
const usage = vi.hoisted(() => ({
  usageFor: vi.fn<(agentKey: string | undefined | null) => UsageSnapshot | undefined>(),
  refreshUsage: vi.fn(),
}))
vi.mock('../../composables/useUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useUsage')>()
  return { ...actual, usageFor: usage.usageFor, refreshUsage: usage.refreshUsage }
})

const notify = vi.hoisted(() => ({
  toast: vi.fn(),
  alert: vi.fn(),
  confirm: vi.fn(),
  prompt: vi.fn(),
}))
vi.mock('../../composables/useNotify', () => ({ useNotify: () => notify }))

const executeCommand = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../keybindings/commandRegistry', () => ({ executeCommand }))

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'claude',
    status: 'ok',
    planType: 'max',
    windows: [{ kind: 'session', label: 'Session', usedPercent: 30, resetsAt: null }],
    fetchedAt: '2026-07-25T00:00:00Z',
    error: null,
    ...over,
  }
}

function profile(id: string, name: string): CliProfile {
  return { id, agentKey: 'claude', name, createdAt: '2026-07-01T00:00:00Z' }
}

type FakeCliProfiles = ReturnType<typeof makeCliProfiles>['fake']

// Fake object mimicking the subset of useCliProfiles() UsageBadge reads.
function makeCliProfiles(
  opts: {
    profiles?: CliProfile[]
    defaultId?: string | null
    identities?: Record<string, CliAccountIdentity>
    setDefault?: ReturnType<typeof vi.fn>
  } = {},
) {
  const profiles = opts.profiles ?? []
  const setDefault =
    opts.setDefault ?? vi.fn(async (): Promise<SetDefaultResult> => ({ ok: true }))
  const fake = {
    hasProfiles: vi.fn(() => profiles.length > 0),
    profilesForAgent: vi.fn(() => profiles),
    defaultProfileId: vi.fn(() => opts.defaultId ?? null),
    setDefault,
    identityFor: vi.fn(
      (_agent: string, profileId: string | null): CliAccountIdentity | null =>
        opts.identities?.[profileId ?? '__default__'] ?? null,
    ),
  }
  return { fake, setDefault }
}

function mountBadge(cliProfiles: FakeCliProfiles): VueWrapper {
  return mount(UsageBadge, {
    props: {
      agentKey: 'claude',
      cliProfiles: cliProfiles as unknown as ReturnType<typeof useCliProfiles>,
    },
    // Teleport is stubbed so the popover renders inside the wrapper.
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
}

/** Hover the badge and advance past the 150ms open delay. */
async function openPopover(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.usage-badge').trigger('mouseenter')
  await vi.advanceTimersByTimeAsync(200)
  await nextTick()
}

/** Flush chained microtasks from async click handlers (no timers involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await nextTick()
}

let wrapper: VueWrapper | undefined

beforeAll(() => {
  i18n.global.locale.value = 'en-US'
})

beforeEach(() => {
  vi.useFakeTimers()
  usage.usageFor.mockReset()
  usage.refreshUsage.mockClear()
  notify.alert.mockClear()
  notify.confirm.mockReset()
  executeCommand.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
})

describe('UsageBadge – badge rendering', () => {
  it('shows the formatted remaining percent when usage data is present', () => {
    usage.usageFor.mockReturnValue(snapshot()) // 30% used → 70% left
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.find('.usage-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('70%')
    expect(badge.classes()).toContain('ok')
  })

  it('applies the crit tier class when remaining quota is low', () => {
    usage.usageFor.mockReturnValue(
      snapshot({ windows: [{ kind: 'session', label: 'Session', usedPercent: 92, resetsAt: null }] }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.find('.usage-badge')
    expect(badge.text()).toBe('8%')
    expect(badge.classes()).toContain('crit')
  })

  it('shows the warning glyph when credentials are expired', () => {
    usage.usageFor.mockReturnValue(snapshot({ status: 'expired', windows: [] }))
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.find('.usage-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('⚠')
  })

  it('renders nothing when the agent has no usage snapshot', () => {
    usage.usageFor.mockReturnValue(undefined)
    wrapper = mountBadge(makeCliProfiles().fake)
    expect(wrapper.find('.usage-badge').exists()).toBe(false)
  })
})

describe('UsageBadge – popover account list', () => {
  it('hides the switch section when the agent has no extra profiles', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    expect(wrapper.find('.usage-pop').exists()).toBe(true)
    expect(wrapper.find('.usage-pop-switch-title').exists()).toBe(false)
    expect(wrapper.find('.usage-acct-list').exists()).toBe(false)
    // The "Add / manage accounts…" entry is always available.
    expect(wrapper.find('.usage-acct-manage').exists()).toBe(true)
  })

  it('lists the Default row plus every profile, labeled by identity email', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work'), profile('p2', 'Side')],
      identities: { p1: { email: 'work@example.com', signedIn: true } },
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    const rows = wrapper.findAll('.usage-acct')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('Default (built-in)')
    expect(rows[1].text()).toContain('work@example.com') // identity email wins
    expect(rows[2].text()).toContain('Side') // fallback to profile name
  })

  it('marks the row matching defaultProfileId as active with a tick', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work'), profile('p2', 'Side')],
      defaultId: 'p2',
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    const rows = wrapper.findAll('.usage-acct')
    expect(rows[0].classes()).not.toContain('active')
    expect(rows[1].classes()).not.toContain('active')
    expect(rows[2].classes()).toContain('active')
    expect(rows[2].find('.usage-acct-tick').exists()).toBe(true)
    expect(rows[0].find('.usage-acct-tick').exists()).toBe(false)
  })

  it('marks the Default row active when no default profile is set', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({ profiles: [profile('p1', 'Work')], defaultId: null })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    const rows = wrapper.findAll('.usage-acct')
    expect(rows[0].classes()).toContain('active')
    expect(rows[0].find('.usage-acct-tick').exists()).toBe(true)
    expect(rows[1].classes()).not.toContain('active')
  })
})

describe('UsageBadge – selectProfile', () => {
  it('switches to a profile: setDefault(agent, id) then refreshUsage', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, setDefault } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', 'p1')
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('switches back to Default: setDefault(agent, null) then refreshUsage', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, setDefault } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: 'p1',
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[0].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', null)
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('clicking the already-active row is a no-op', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, setDefault } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: 'p1',
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).not.toHaveBeenCalled()
    expect(usage.refreshUsage).not.toHaveBeenCalled()
  })

  it('failure with a message shows an alert and skips the refresh', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const setDefault = vi.fn().mockResolvedValue({ ok: false, message: 'switch failed' })
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
      setDefault,
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(notify.alert).toHaveBeenCalledTimes(1)
    expect(notify.alert.mock.calls[0][0]).toBe('switch failed')
    expect(notify.confirm).not.toHaveBeenCalled()
    expect(usage.refreshUsage).not.toHaveBeenCalled()
  })
})

describe('UsageBadge – manage accounts', () => {
  it('opens Settings › Accounts via the command registry', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    await wrapper.find('.usage-acct-manage').trigger('click')
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsAccounts')
    // Popover closes so the settings modal opens on top unobstructed.
    expect(wrapper.find('.usage-pop').exists()).toBe(false)
  })
})
