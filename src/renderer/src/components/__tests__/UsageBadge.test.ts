// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import UsageBadge from '../UsageBadge.vue'
import { i18n } from '../../i18n'
import type { UsageSnapshot } from '../../composables/useUsage'
import {
  cliAccountSwitchKey,
  createCliAccountSwitchHandler,
  type CliAccountIdentity,
  type CliAccountSwitchHandler,
  type CliProfile,
  type SetDefaultResult,
  type useCliProfiles,
} from '../../composables/useCliProfiles'

// Mock boundary: keep useUsage's pure formatters real, replace the singleton
// readers (usageFor) and the backend call (refreshUsage) with controllable fns.
const usage = vi.hoisted(() => ({
  usageFor: vi.fn<(agentKey: string | undefined | null) => UsageSnapshot | undefined>(),
  accountUsageFor:
    vi.fn<
      (agentKey: string | undefined | null, profileId: string | null) => UsageSnapshot | undefined
    >(),
  refreshUsage: vi.fn(),
}))
vi.mock('../../composables/useUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useUsage')>()
  return {
    ...actual,
    usageFor: usage.usageFor,
    accountUsageFor: usage.accountUsageFor,
    refreshUsage: usage.refreshUsage,
  }
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
    unregistered?: CliAccountIdentity | null
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
    unregisteredFor: vi.fn((): CliAccountIdentity | null => opts.unregistered ?? null),
  }
  return { fake, setDefault }
}

function mountBadge(
  cliProfiles: FakeCliProfiles,
  opts: { switchHandler?: CliAccountSwitchHandler; attach?: boolean } = {},
): VueWrapper {
  return mount(UsageBadge, {
    props: {
      agentKey: 'claude',
      cliProfiles: cliProfiles as unknown as ReturnType<typeof useCliProfiles>,
    },
    // Only the dismissal tests need a real document tree: events dispatched on
    // a detached node never reach the document-level listeners.
    ...(opts.attach ? { attachTo: document.body } : {}),
    // Teleport is stubbed so the popover renders inside the wrapper.
    global: {
      plugins: [i18n],
      stubs: { teleport: true },
      // Mimic the main window providing the quiescence-aware switch handler.
      provide: opts.switchHandler
        ? { [cliAccountSwitchKey as symbol]: opts.switchHandler }
        : {},
    },
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
  usage.accountUsageFor.mockReset()
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

  it('keeps cached quota visible and marks its refresh state', async () => {
    usage.usageFor.mockReturnValue(
      snapshot({
        stale: true,
        lastSuccessAt: '2026-07-25T00:00:00Z',
        refreshStatus: 'rate-limited',
      }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.get('.usage-badge')
    expect(badge.text()).toContain('70%')
    expect(badge.text()).toContain('cached')
    expect(badge.classes()).toContain('cached')

    await openPopover(wrapper)
    expect(wrapper.get('.usage-pop-cached').text()).toContain('rate limited')
  })

  it('does not present cached remaining quota after the reset has passed', async () => {
    usage.usageFor.mockReturnValue(
      snapshot({
        stale: true,
        staleExpired: true,
        refreshStatus: 'unavailable',
        windows: [
          { kind: 'session', label: 'Session', usedPercent: 30, resetsAt: null, expired: true },
        ],
      }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    expect(wrapper.get('.usage-badge').text()).toBe('⚠')

    await openPopover(wrapper)
    expect(wrapper.get('.usage-pop-expired').text()).toContain('Cached quota reset has passed')
    expect(wrapper.find('.usage-bar').exists()).toBe(false)
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

  it('shows each row remaining percent from its own account slot', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockImplementation((_agent, profileId) =>
      profileId === 'p1'
        ? snapshot({
            windows: [{ kind: 'session', label: 'Session', usedPercent: 90, resetsAt: null }],
          })
        : snapshot(), // default slot: 30% used → 70% left
    )
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'Work')] }).fake)
    await openPopover(wrapper)
    const pcts = wrapper.findAll('.usage-acct-pct')
    expect(pcts.map((p) => p.text())).toEqual(['70%', '10%'])
    expect(pcts[1].classes()).toContain('crit')
  })

  it('shows a signed-out row as signed out, never as leftover quota', async () => {
    // An account with no stored credentials keeps whatever was last cached for
    // it. Rendering that number advertises quota for something that cannot run
    // — the row must say it is signed out instead.
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockReturnValue(snapshot({ stale: true }))
    wrapper = mountBadge(
      makeCliProfiles({
        profiles: [profile('p1', 'Work')],
        identities: {
          __default__: { email: null, signedIn: false },
          p1: { email: 'work@example.com', signedIn: true },
        },
      }).fake,
    )
    await openPopover(wrapper)

    const rows = wrapper.findAll('.usage-acct')
    expect(rows[0].find('.usage-acct-out').exists()).toBe(true)
    expect(rows[0].find('.usage-acct-pct').exists()).toBe(false)
    // The signed-in row is untouched.
    expect(rows[1].find('.usage-acct-out').exists()).toBe(false)
    expect(rows[1].find('.usage-acct-pct').text()).toBe('~70%')
  })

  it('marks a row whose numbers came from cache, and leaves live rows plain', async () => {
    // A parked slot that could not be polled falls back to its last good
    // numbers — possibly days old. The row must not read as a live quota.
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockImplementation((_agent, profileId) =>
      profileId === 'p1'
        ? snapshot({ stale: true, lastSuccessAt: '2026-07-20T00:00:00Z' })
        : snapshot(),
    )
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'Work')] }).fake)
    await openPopover(wrapper)
    const pcts = wrapper.findAll('.usage-acct-pct')
    expect(pcts[0].classes()).not.toContain('stale')
    expect(pcts[0].text()).toBe('70%')
    expect(pcts[0].attributes('title')).toBe('')
    expect(pcts[1].classes()).toContain('stale')
    expect(pcts[1].text()).toBe('~70%')
    expect(pcts[1].attributes('title')).toContain('Cached')
  })

  it('omits the row percent when a slot has no fetched snapshot', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockReturnValue(undefined)
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'Work')] }).fake)
    await openPopover(wrapper)
    expect(wrapper.findAll('.usage-acct-pct')).toHaveLength(0)
  })

  it('renders an extra row for a live but unregistered account, labeled by its email', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      unregistered: { email: 'outside@example.com', signedIn: true },
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    const unregisteredRow = wrapper.get('.usage-acct-unregistered')
    expect(unregisteredRow.text()).toContain('outside@example.com')
    expect(unregisteredRow.text()).toContain('Unregistered')
    // It comes first, ahead of Default and the registered profiles.
    expect(wrapper.findAll('.usage-acct')[0].element).toBe(unregisteredRow.element)
  })

  it('falls back to an "identity unknown" label when the unregistered account has no email', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({ unregistered: { email: null, signedIn: true } })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    expect(wrapper.get('.usage-acct-unregistered').text()).toContain('identity unknown')
  })

  it('shows the account list for the unregistered row alone, with no other profiles', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({ unregistered: { email: 'solo@example.com', signedIn: true } })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    expect(wrapper.findAll('.usage-acct')).toHaveLength(1)
    expect(wrapper.get('.usage-acct-unregistered').text()).toContain('solo@example.com')
  })

  it('does not render the unregistered row when the agent has none', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'Work')] }).fake)
    await openPopover(wrapper)
    expect(wrapper.find('.usage-acct-unregistered').exists()).toBe(false)
  })

  it('the unregistered row is not a button and does not trigger a switch', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, setDefault } = makeCliProfiles({
      unregistered: { email: 'outside@example.com', signedIn: true },
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    const row = wrapper.get('.usage-acct-unregistered')
    expect(row.element.tagName).not.toBe('BUTTON')
    await row.trigger('click')
    expect(setDefault).not.toHaveBeenCalled()
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

  it('marks the target row busy and drops competing clicks until it settles', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    let release: (res: { ok: boolean }) => void = () => {}
    const setDefault = vi.fn(
      () => new Promise<{ ok: boolean }>((resolve) => { release = resolve }),
    )
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work'), profile('p2', 'Personal')],
      defaultId: null,
      setDefault,
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    // Re-query after every render: a DOMWrapper captured earlier does not see
    // children added by a later patch.
    const rows = (): ReturnType<VueWrapper['findAll']> => wrapper!.findAll('.usage-acct')
    await rows()[1].trigger('click')
    await settle()

    // In flight: spinner on the clicked row only, every row unclickable.
    expect(wrapper.findAll('.usage-acct-spin')).toHaveLength(1)
    expect(rows()[1].find('.usage-acct-spin').exists()).toBe(true)
    expect(rows().every((r) => r.attributes('disabled') !== undefined)).toBe(true)
    await rows()[2].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)

    release({ ok: true })
    await settle()
    expect(wrapper.findAll('.usage-acct-spin')).toHaveLength(0)
    expect(rows()[1].attributes('disabled')).toBeUndefined()
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('releases the busy row when the switch fails', async () => {
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

    expect(wrapper.findAll('.usage-acct-spin')).toHaveLength(0)
    // A second attempt is possible after the failure — the guard is not sticky.
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(2)
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

describe('UsageBadge – quiescence switch handler', () => {
  it('routes the switch through the provided handler instead of setDefault', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, setDefault } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
    })
    const handler = vi.fn(async (): Promise<SetDefaultResult> => ({ ok: true }))
    wrapper = mountBadge(fake, { switchHandler: handler })
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(handler).toHaveBeenCalledWith('claude', 'p1')
    expect(setDefault).not.toHaveBeenCalled()
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('blocked switch: confirm accepted → forced setDefault → usage refreshed', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const setDefault = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'PANES_RUNNING', count: 2, message: 'in use' })
      .mockResolvedValueOnce({ ok: true })
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
      setDefault,
    })
    notify.confirm.mockResolvedValue(true)
    const handler = createCliAccountSwitchHandler(
      { setDefault: fake.setDefault as unknown as ReturnType<typeof useCliProfiles>['setDefault'] },
      {
        confirm: (message, opts) => notify.confirm(message, opts) as Promise<boolean>,
        agentLabel: () => 'Claude Code',
        startLogin: () => {},
      },
    )
    wrapper = mountBadge(fake, { switchHandler: handler })
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(notify.confirm).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenNthCalledWith(1, 'claude', 'p1')
    expect(setDefault).toHaveBeenNthCalledWith(2, 'claude', 'p1', { force: true })
    expect(notify.alert).not.toHaveBeenCalled()
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('blocked switch: declined confirm switches nothing and stays silent', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const setDefault = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'PANES_RUNNING', count: 2, message: 'in use' })
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
      setDefault,
    })
    notify.confirm.mockResolvedValue(false)
    const handler = createCliAccountSwitchHandler(
      { setDefault: fake.setDefault as unknown as ReturnType<typeof useCliProfiles>['setDefault'] },
      {
        confirm: (message, opts) => notify.confirm(message, opts) as Promise<boolean>,
        agentLabel: () => 'Claude Code',
        startLogin: () => {},
      },
    )
    wrapper = mountBadge(fake, { switchHandler: handler })
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(notify.alert).not.toHaveBeenCalled()
    expect(usage.refreshUsage).not.toHaveBeenCalled()
  })

  it('without a handler, a PANES_RUNNING failure alerts its message (no force)', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const setDefault = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'PANES_RUNNING', count: 1, message: 'panes running' })
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
      setDefault,
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', 'p1')
    expect(notify.alert).toHaveBeenCalledTimes(1)
    expect(notify.alert.mock.calls[0][0]).toBe('panes running')
    expect(usage.refreshUsage).not.toHaveBeenCalled()
  })
})

describe('UsageBadge – popover placement', () => {
  it('flips above the badge when the drop-down would run off the bottom', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 700,
      bottom: 720,
      left: 100,
      right: 140,
      width: 40,
      height: 20,
      x: 100,
      y: 700,
      toJSON: () => ({}),
    } as DOMRect)

    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    await nextTick()

    // 720 + 6 + 200 overflows the 768px viewport → top = 700 - 6 - 200.
    expect(wrapper.find('.usage-pop').attributes('style')).toContain('top: 494px')
    heightSpy.mockRestore()
    rectSpy.mockRestore()
  })

  it('keeps the drop-down placement when there is room below', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      bottom: 60,
      left: 100,
      right: 140,
      width: 40,
      height: 20,
      x: 100,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect)

    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    await nextTick()

    expect(wrapper.find('.usage-pop').attributes('style')).toContain('top: 66px')
    heightSpy.mockRestore()
    rectSpy.mockRestore()
  })
})

describe('UsageBadge – popover dismissal', () => {
  // Hover-only dismissal stranded the panel over the UI whenever a mouseleave
  // was missed (window blur, re-render under the cursor) — GitHub issue #17.
  it('closes on Escape', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    expect(wrapper.find('.usage-pop').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(false)
  })

  it('ignores keys other than Escape', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(true)
  })

  it('closes on a pointerdown outside the popover', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(false)
  })

  it('stays open on a pointerdown inside the popover', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'A account')] }).fake, {
      attach: true,
    })
    await openPopover(wrapper)

    wrapper.find('.usage-acct').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(true)
  })

  it('stays open on a pointerdown on the badge itself', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake, { attach: true })
    await openPopover(wrapper)

    wrapper.find('.usage-badge').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(true)
  })

  it('closes when the window loses focus', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)

    window.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(false)
  })

  it('drops the document listeners when the popover closes', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)

    const removeSpy = vi.spyOn(document, 'removeEventListener')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
    removeSpy.mockRestore()
  })

  it('drops the document listeners when unmounted while open', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const w = mountBadge(makeCliProfiles().fake)
    await openPopover(w)

    const removeSpy = vi.spyOn(document, 'removeEventListener')
    w.unmount()
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    removeSpy.mockRestore()
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
