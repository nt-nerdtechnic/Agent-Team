// @vitest-environment happy-dom
// TaskerPanel (the right-rail "Tasker" tab) — filter semantics, row expansion,
// the mandatory delete confirmation, inline `ok: false` error reporting, and the
// executions.changed rescan. The backend is passed in as a prop, so every
// assertion is on the real wire payloads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref, type Component, type Ref } from 'vue'
import { i18n } from '@navide/ui-foundation'
import type { useBackend } from '../../composables/useBackend'

const wire = {
  calls: [] as { type: string; payload: Record<string, unknown> }[],
  /** Per-test override of the payload returned for a given request type. */
  overrides: new Map<string, unknown>(),
  /** Types whose next response fails at the envelope level (`ok: false`). */
  envelopeErrors: new Map<string, string>(),
  listeners: new Map<string, Set<(p: unknown) => void>>(),
  /** Request type parked until the test releases it, plus its gate. */
  holdType: null as string | null,
  hold: Promise.resolve() as Promise<void>,
}

/** Park the next request of `type`; returns the release callback. The response
 *  body is captured before parking, so it carries the state of that moment. */
function holdNext(type: string): () => void {
  let release = (): void => {}
  wire.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  wire.holdType = type
  return release
}

function snapshot(): Record<string, unknown> {
  return {
    platform: 'darwin',
    scanned_at: 1_770_000_000,
    crontab: {
      supported: true,
      error: null,
      entries: [
        {
          id: 'c1',
          name: 'backup-photos',
          schedule: '30 2 * * *',
          schedule_kind: 'standard',
          command: '~/bin/backup-photos.sh --destination /Volumes/Archive',
          raw: '30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive',
          enabled: true,
        },
        {
          id: 'c2',
          name: 'warm-cache',
          schedule: '@reboot',
          schedule_kind: 'special',
          command: '~/bin/warm-cache.sh',
          raw: '@reboot ~/bin/warm-cache.sh',
          enabled: true,
        },
        {
          id: 'c3',
          name: 'old-report',
          schedule: '0 9 * * 1',
          schedule_kind: 'standard',
          command: '~/bin/weekly-report.sh',
          raw: '# [NAVIDE-DISABLED] 0 9 * * 1 ~/bin/weekly-report.sh',
          enabled: false,
        },
      ],
    },
    launch_agents: {
      supported: true,
      error: null,
      agents: [
        {
          label: 'com.syncthing.syncthing',
          name: 'Syncthing',
          plist_path: '/Users/t/Library/LaunchAgents/com.syncthing.syncthing.plist',
          plist_exists: true,
          scope: 'user',
          managed: true,
          runtime_known: true,
          loaded: true,
          running: true,
          pid: 921,
          last_exit_code: null,
          keep_alive: true,
          run_at_load: false,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
        {
          label: 'local.nightly.index',
          name: 'Nightly Index',
          plist_path: '/Users/t/Library/LaunchAgents/local.nightly.index.plist',
          plist_exists: true,
          scope: 'user',
          managed: true,
          runtime_known: true,
          loaded: true,
          running: false,
          pid: null,
          last_exit_code: 78,
          keep_alive: false,
          run_at_load: false,
          start_interval: null,
          start_calendar: [{ Hour: 3, Minute: 0 }],
          comment: null,
        },
        {
          label: 'local.legacy.backup',
          name: 'Legacy Backup',
          plist_path: '/Users/t/Library/LaunchAgents/local.legacy.backup.plist',
          plist_exists: true,
          scope: 'user',
          managed: true,
          runtime_known: true,
          loaded: false,
          running: false,
          pid: null,
          last_exit_code: 0,
          keep_alive: false,
          run_at_load: true,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
        {
          // /Library/LaunchAgents is bootstrapped into gui/$UID, so launchctl
          // can see it: read-only, but with a real state.
          label: 'com.vendor.updater',
          name: 'Vendor Updater',
          plist_path: '/Library/LaunchAgents/com.vendor.updater.plist',
          plist_exists: true,
          scope: 'system-agent',
          managed: false,
          runtime_known: true,
          loaded: true,
          running: true,
          pid: 400,
          last_exit_code: null,
          keep_alive: true,
          run_at_load: false,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
        {
          // A system daemon: invisible to `launchctl list` without root, so
          // every runtime field is null rather than false.
          label: 'com.vendor.daemon',
          name: 'Vendor Daemon',
          plist_path: '/Library/LaunchDaemons/com.vendor.daemon.plist',
          plist_exists: true,
          scope: 'system-daemon',
          managed: false,
          runtime_known: false,
          loaded: null,
          running: null,
          pid: null,
          last_exit_code: null,
          keep_alive: true,
          run_at_load: false,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
        {
          // …and a daemon `launchctl list` *can* see: a daemon's runtime state
          // is not always unknown, so the Daemons section must not hardcode it.
          label: 'com.vendor.visible',
          name: 'Visible Daemon',
          plist_path: '/Library/LaunchDaemons/com.vendor.visible.plist',
          plist_exists: true,
          scope: 'system-daemon',
          managed: false,
          runtime_known: true,
          loaded: true,
          running: true,
          pid: 77,
          last_exit_code: null,
          keep_alive: true,
          run_at_load: false,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
      ],
    },
  }
}

function fakeBackend(): ReturnType<typeof useBackend> {
  return {
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref(''),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
      wire.calls.push({ type, payload })
      const override = wire.overrides.get(type)
      const body =
        override !== undefined ? override : type === 'executions.list' ? snapshot() : { ok: true }
      const envelopeError = wire.envelopeErrors.get(type)
      if (wire.holdType === type) {
        wire.holdType = null
        await wire.hold
      }
      if (envelopeError !== undefined) {
        return {
          id: 'r',
          type,
          ok: false,
          payload: null,
          error: { message: envelopeError },
          timestamp: '',
        }
      }
      return { id: 'r', type, ok: true, payload: body, error: null, timestamp: '' }
    }),
    on: (type: string, cb: (p: unknown) => void) => {
      let set = wire.listeners.get(type)
      if (!set) {
        set = new Set()
        wire.listeners.set(type, set)
      }
      set.add(cb)
      return () => set!.delete(cb)
    },
    restart: vi.fn(),
    stop: vi.fn(),
  } as unknown as ReturnType<typeof useBackend>
}

/** Freshly imported per test — see the module reset in `beforeEach`. */
let TaskerPanel: Component

async function mountPanel(
  backend: ReturnType<typeof useBackend> = fakeBackend()
): Promise<VueWrapper> {
  const wrapper = mount(TaskerPanel, {
    props: { backend },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return wrapper
}

function cronSection(wrapper: VueWrapper) {
  return wrapper.get('[data-section="crontab"]')
}
function agentSection(wrapper: VueWrapper) {
  return wrapper.get('[data-section="launchagent"]')
}
function daemonSection(wrapper: VueWrapper) {
  return wrapper.get('[data-section="daemon"]')
}
function cronIds(wrapper: VueWrapper): (string | undefined)[] {
  return cronSection(wrapper)
    .findAll('[data-entry-id]')
    .map((el) => el.attributes('data-entry-id'))
}
function labelsIn(section: ReturnType<typeof agentSection>): (string | undefined)[] {
  return section.findAll('[data-agent-label]').map((el) => el.attributes('data-agent-label'))
}
function agentLabels(wrapper: VueWrapper): (string | undefined)[] {
  return labelsIn(agentSection(wrapper))
}
function daemonLabels(wrapper: VueWrapper): (string | undefined)[] {
  return labelsIn(daemonSection(wrapper))
}
function scopesIn(section: ReturnType<typeof agentSection>): (string | undefined)[] {
  return section.findAll('[data-scope]').map((el) => el.attributes('data-scope'))
}

describe('TaskerPanel', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(async () => {
    wire.calls.length = 0
    wire.overrides.clear()
    wire.envelopeErrors.clear()
    wire.listeners.clear()
    wire.holdType = null
    wire.hold = Promise.resolve()
    // The panel keeps its last scan at module scope so remounting the rail tab
    // doesn't shell out again; a fresh module per test starts that cache empty.
    vi.resetModules()
    TaskerPanel = ((await import('../TaskerPanel.vue')) as { default: Component }).default
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('scans on mount, and the Agents section defaults to showing all', async () => {
    wrapper = await mountPanel()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
    // crontab defaults to "enabled" — the disabled entry is hidden.
    expect(cronIds(wrapper)).toEqual(['c1', 'c2'])
    // Agents default to "all": the point of the section is seeing what is
    // registered, not only what happens to be up right now.
    expect(agentSection(wrapper).get('[data-filter="all"]').classes()).toContain('on')
    expect(agentLabels(wrapper)).toHaveLength(4)
  })

  it('splits agents and daemons into their own sections by scope', async () => {
    wrapper = await mountPanel()

    // Agents: both the user's own and /Library/LaunchAgents — never a daemon.
    expect(agentLabels(wrapper)).toEqual([
      'com.syncthing.syncthing',
      'local.nightly.index',
      'local.legacy.backup',
      'com.vendor.updater',
    ])
    expect(scopesIn(agentSection(wrapper))).toEqual([
      'user',
      'user',
      'user',
      'system-agent',
    ])

    // Daemons: nothing but /Library/LaunchDaemons.
    expect(daemonLabels(wrapper)).toEqual(['com.vendor.daemon', 'com.vendor.visible'])
    expect(new Set(scopesIn(daemonSection(wrapper)))).toEqual(new Set(['system-daemon']))

    // Each header counts its own section, not the whole payload.
    expect(agentSection(wrapper).get('.tk-count').text()).toBe(
      i18n.global.t('executions.count', { count: 4 })
    )
    expect(daemonSection(wrapper).get('.tk-count').text()).toBe(
      i18n.global.t('executions.count', { count: 2 })
    )
  })

  it('gives the Daemons section no filters and no actions at all', async () => {
    wrapper = await mountPanel()

    // A filter over rows that are read-only and mostly unknowable would be a
    // control that changes nothing.
    expect(daemonSection(wrapper).findAll('.tk-chip')).toHaveLength(0)
    expect(daemonSection(wrapper).findAll('.tk-act')).toHaveLength(0)
    expect(daemonSection(wrapper).findAll('.tk-acts')).toHaveLength(0)
  })

  it('does not hardcode a daemon as unknown when launchctl can see it', async () => {
    wrapper = await mountPanel()

    const visible = daemonSection(wrapper).get('[data-agent-label="com.vendor.visible"]')
    expect(visible.get('.tk-dot').classes()).toEqual(['tk-dot'])
    expect(visible.text()).toContain(i18n.global.t('executions.tag.pid', { pid: 77 }))

    const unknown = daemonSection(wrapper).get('[data-agent-label="com.vendor.daemon"]')
    expect(unknown.get('.tk-dot').classes()).toEqual(['tk-dot', 'unknown'])
  })

  it('expands and collapses rows in both launchd sections', async () => {
    wrapper = await mountPanel()

    const agent = agentSection(wrapper).get('[data-agent-label="com.vendor.updater"]')
    const daemon = daemonSection(wrapper).get('[data-agent-label="com.vendor.daemon"]')

    await agent.get('.tk-row-head').trigger('click')
    await daemon.get('.tk-row-head').trigger('click')
    // One expanded set across both sections, so both stay open at once.
    expect(agent.find('.tk-detail').exists()).toBe(true)
    expect(daemon.get('.tk-detail').text()).toContain(
      '/Library/LaunchDaemons/com.vendor.daemon.plist'
    )

    await daemon.get('.tk-row-head').trigger('click')
    expect(daemon.find('.tk-detail').exists()).toBe(false)
    expect(agent.find('.tk-detail').exists()).toBe(true)
  })

  it('filters crontab entries by enabled state', async () => {
    wrapper = await mountPanel()

    await cronSection(wrapper).get('[data-filter="disabled"]').trigger('click')
    expect(cronIds(wrapper)).toEqual(['c3'])

    await cronSection(wrapper).get('[data-filter="all"]').trigger('click')
    expect(cronIds(wrapper)).toEqual(['c1', 'c2', 'c3'])

    await cronSection(wrapper).get('[data-filter="enabled"]').trigger('click')
    expect(cronIds(wrapper)).toEqual(['c1', 'c2'])
  })

  it('filters Agents by running-or-loaded, and never touches the Daemons section', async () => {
    wrapper = await mountPanel()

    await agentSection(wrapper).get('[data-filter="stopped"]').trigger('click')
    expect(agentLabels(wrapper)).toEqual(['local.legacy.backup'])
    expect(daemonLabels(wrapper)).toHaveLength(2)

    await agentSection(wrapper).get('[data-filter="all"]').trigger('click')
    expect(agentLabels(wrapper)).toHaveLength(4)

    await agentSection(wrapper).get('[data-filter="running"]').trigger('click')
    expect(agentLabels(wrapper)).toEqual([
      'com.syncthing.syncthing',
      'local.nightly.index',
      'com.vendor.updater',
    ])
    expect(daemonLabels(wrapper)).toHaveLength(2)
  })

  // ── system-level jobs (read-only) ─────────────────────────────────────────

  it('gives read-only rows no action buttons at all', async () => {
    wrapper = await mountPanel()

    const managed = agentSection(wrapper).get('[data-agent-label="com.syncthing.syncthing"]')
    expect(managed.find('.tk-act-toggle').exists()).toBe(true)
    expect(managed.find('.tk-act-remove').exists()).toBe(true)

    // /Library/LaunchAgents lives in the Agents section but stays read-only.
    expect(
      agentSection(wrapper).get('[data-agent-label="com.vendor.updater"]').findAll('.tk-act')
    ).toHaveLength(0)
  })

  it('never calls an unknown state "stopped"', async () => {
    wrapper = await mountPanel()
    const stopped = i18n.global.t('executions.state.not-loaded')
    const unknown = i18n.global.t('executions.state.unknown')

    const row = daemonSection(wrapper).get('[data-agent-label="com.vendor.daemon"]')
    await row.get('.tk-row-head').trigger('click')
    expect(row.text()).not.toContain(stopped)
    expect(row.get('.tk-detail').text()).toContain(unknown)
    // A hollow dot, not the grey "stopped" one, and no dimmed row.
    expect(row.get('.tk-dot').classes()).toEqual(['tk-dot', 'unknown'])
    expect(row.classes()).not.toContain('off')
  })

  it('keeps an unknown state out of both Agents filters', async () => {
    // The backend only reports runtime_known: false for system daemons, so this
    // shape cannot reach the Agents section today — but the filter guard is what
    // keeps "unknown" from being silently counted as stopped, so pin it here.
    const opaque = snapshot()
    const agents = (opaque.launch_agents as { agents: Record<string, unknown>[] }).agents
    agents.push({
      ...agents[3],
      label: 'com.vendor.opaque',
      name: 'Opaque Agent',
      plist_path: '/Library/LaunchAgents/com.vendor.opaque.plist',
      runtime_known: false,
      loaded: null,
      running: null,
      pid: null,
    })
    wire.overrides.set('executions.list', opaque)
    wrapper = await mountPanel()

    // Unknown is neither running nor stopped: it appears under "all" only.
    await agentSection(wrapper).get('[data-filter="running"]').trigger('click')
    expect(agentLabels(wrapper)).not.toContain('com.vendor.opaque')
    await agentSection(wrapper).get('[data-filter="stopped"]').trigger('click')
    expect(agentLabels(wrapper)).not.toContain('com.vendor.opaque')
    await agentSection(wrapper).get('[data-filter="all"]').trigger('click')
    expect(agentLabels(wrapper)).toContain('com.vendor.opaque')
  })

  it('tags each system row with its scope and leaves user rows untagged', async () => {
    wrapper = await mountPanel()

    const tagsOf = (
      section: ReturnType<typeof agentSection>,
      label: string
    ): string[] =>
      section
        .get(`[data-agent-label="${label}"]`)
        .findAll('.tk-tag.scope')
        .map((el) => el.text())

    expect(tagsOf(agentSection(wrapper), 'com.syncthing.syncthing')).toEqual([])
    expect(tagsOf(agentSection(wrapper), 'com.vendor.updater')).toEqual([
      i18n.global.t('executions.scope.system-agent'),
    ])
    expect(tagsOf(daemonSection(wrapper), 'com.vendor.daemon')).toEqual([
      i18n.global.t('executions.scope.system-daemon'),
    ])

    // The expanded detail names the scope and the full plist path, so the user
    // can tell which directory a job came from.
    const row = agentSection(wrapper).get('[data-agent-label="com.vendor.updater"]')
    await row.get('.tk-row-head').trigger('click')
    const detail = row.get('.tk-detail').text()
    expect(detail).toContain(i18n.global.t('executions.scope.system-agent'))
    expect(detail).toContain('/Library/LaunchAgents/com.vendor.updater.plist')
  })

  it('keeps the same label registered in two directories as two rows', async () => {
    const twins = snapshot()
    const label = 'com.google.keystone.agent'
    const base = (
      (twins.launch_agents as { agents: Record<string, unknown>[] }).agents as Record<
        string,
        unknown
      >[]
    )[0]
    ;(twins.launch_agents as { agents: Record<string, unknown>[] }).agents = [
      { ...base, label, name: 'Keystone', plist_path: `/Users/t/Library/LaunchAgents/${label}.plist` },
      {
        ...base,
        label,
        name: 'Keystone',
        plist_path: `/Library/LaunchAgents/${label}.plist`,
        scope: 'system-agent',
        managed: false,
      },
    ]
    wire.overrides.set('executions.list', twins)
    wrapper = await mountPanel()

    expect(agentLabels(wrapper)).toEqual([label, label])
    // Rows are keyed by plist path, so expanding one must not expand the other.
    const rows = agentSection(wrapper).findAll('[data-agent-key]')
    await rows[0].get('.tk-row-head').trigger('click')
    expect(rows[0].find('.tk-detail').exists()).toBe(true)
    expect(rows[1].find('.tk-detail').exists()).toBe(false)
    // Only the user copy is actionable.
    expect(rows[0].findAll('.tk-act')).toHaveLength(2)
    expect(rows[1].findAll('.tk-act')).toHaveLength(0)
  })

  it('collapses a crontab row by default and reveals command + raw when expanded', async () => {
    wrapper = await mountPanel()
    const row = cronSection(wrapper).get('[data-entry-id="c1"]')

    expect(row.find('.tk-detail').exists()).toBe(false)
    expect(row.text()).not.toContain('/Volumes/Archive')

    await row.get('.tk-row-head').trigger('click')
    const detail = row.get('.tk-detail')
    expect(detail.text()).toContain('~/bin/backup-photos.sh --destination /Volumes/Archive')
    expect(detail.text()).toContain('30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive')

    await row.get('.tk-row-head').trigger('click')
    expect(row.find('.tk-detail').exists()).toBe(false)
  })

  it('reveals a LaunchAgent label and plist path when its row is expanded', async () => {
    wrapper = await mountPanel()
    const row = agentSection(wrapper).get('[data-agent-label="local.nightly.index"]')

    expect(row.find('.tk-detail').exists()).toBe(false)
    await row.get('.tk-row-head').trigger('click')

    const detail = row.get('.tk-detail')
    expect(detail.text()).toContain('local.nightly.index')
    expect(detail.text()).toContain('/Users/t/Library/LaunchAgents/local.nightly.index.plist')
  })

  it('toggles a crontab entry with its raw line as the target', async () => {
    wrapper = await mountPanel()

    await cronSection(wrapper).get('[data-entry-id="c1"] .tk-act-toggle').trigger('click')
    await flushPromises()

    const toggles = wire.calls.filter((c) => c.type === 'executions.set_enabled')
    expect(toggles).toHaveLength(1)
    expect(toggles[0].payload).toEqual({
      kind: 'crontab',
      target: '30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive',
      enabled: false,
    })
    // A successful mutation rescans.
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(2)
  })

  it('never removes a crontab entry without a confirmation', async () => {
    wrapper = await mountPanel()
    const row = cronSection(wrapper).get('[data-entry-id="c1"]')

    await row.get('.tk-act-remove').trigger('click')
    // Clicking the trash icon must not reach the backend on its own.
    expect(wire.calls.filter((c) => c.type === 'executions.remove')).toHaveLength(0)

    const confirm = row.get('.tk-confirm')
    // The prompt shows the exact line that will disappear from the crontab.
    expect(confirm.text()).toContain(
      '30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive'
    )

    await confirm.get('.tk-confirm-ok').trigger('click')
    await flushPromises()

    const removals = wire.calls.filter((c) => c.type === 'executions.remove')
    expect(removals).toHaveLength(1)
    expect(removals[0].payload).toEqual({
      kind: 'crontab',
      target: '30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive',
    })
  })

  it('cancelling the confirmation sends nothing', async () => {
    wrapper = await mountPanel()
    const row = cronSection(wrapper).get('[data-entry-id="c1"]')

    await row.get('.tk-act-remove').trigger('click')
    await row.get('.tk-confirm .tk-confirm-cancel').trigger('click')

    expect(row.find('.tk-confirm').exists()).toBe(false)
    expect(wire.calls.filter((c) => c.type === 'executions.remove')).toHaveLength(0)
  })

  it('confirms a LaunchAgent removal with its label and plist path', async () => {
    wrapper = await mountPanel()
    const row = agentSection(wrapper).get('[data-agent-label="local.nightly.index"]')

    await row.get('.tk-act-remove').trigger('click')
    expect(wire.calls.filter((c) => c.type === 'executions.remove')).toHaveLength(0)

    const confirm = row.get('.tk-confirm')
    expect(confirm.text()).toContain('local.nightly.index')
    expect(confirm.text()).toContain('/Users/t/Library/LaunchAgents/local.nightly.index.plist')

    await confirm.get('.tk-confirm-ok').trigger('click')
    await flushPromises()

    const removals = wire.calls.filter((c) => c.type === 'executions.remove')
    expect(removals).toHaveLength(1)
    expect(removals[0].payload).toEqual({ kind: 'launchagent', target: 'local.nightly.index' })
  })

  it('surfaces an ok:false error inline under the section that failed', async () => {
    wrapper = await mountPanel()
    wire.overrides.set('executions.set_enabled', {
      ok: false,
      error: 'Boot-out failed: 5: Input/output error',
    })

    await agentSection(wrapper)
      .get('[data-agent-label="com.syncthing.syncthing"] .tk-act-toggle')
      .trigger('click')
    await flushPromises()

    const err = wrapper.get('[data-error-section="launchagent"]')
    expect(err.text()).toContain('Boot-out failed: 5: Input/output error')
    // A failed mutation must not claim success by rescanning.
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
    // The error belongs to its own section only.
    expect(wrapper.find('[data-error-section="crontab"]').exists()).toBe(false)
  })

  it('clears the inline error on the next rescan', async () => {
    wrapper = await mountPanel()
    wire.overrides.set('executions.set_enabled', { ok: false, error: 'nope' })

    await agentSection(wrapper)
      .get('[data-agent-label="com.syncthing.syncthing"] .tk-act-toggle')
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-error-section="launchagent"]').exists()).toBe(true)

    await wrapper.get('.tk-rescan').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-error-section="launchagent"]').exists()).toBe(false)
  })

  it('rescans when the backend broadcasts executions.changed', async () => {
    wrapper = await mountPanel()
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)

    wire.listeners.get('executions.changed')?.forEach((cb) => cb(undefined))
    await flushPromises()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(2)
  })

  it('says the platform is unsupported instead of showing an empty list', async () => {
    const unsupported = snapshot()
    unsupported.platform = 'linux'
    ;(unsupported.launch_agents as Record<string, unknown>) = {
      supported: false,
      error: null,
      agents: [],
    }
    wire.overrides.set('executions.list', unsupported)
    wrapper = await mountPanel()

    for (const section of [agentSection(wrapper), daemonSection(wrapper)]) {
      expect(section.find('.tk-unsupported').exists()).toBe(true)
      expect(section.find('.tk-empty').exists()).toBe(false)
    }
  })

  it('still renders an empty section rather than hiding the category', async () => {
    const none = snapshot()
    ;(none.launch_agents as Record<string, unknown>).agents = []
    wire.overrides.set('executions.list', none)
    wrapper = await mountPanel()

    // The user has to be able to tell "this category exists, it is just empty"
    // apart from "this category is gone".
    for (const section of [agentSection(wrapper), daemonSection(wrapper)]) {
      expect(section.get('.tk-empty').text()).toBe(i18n.global.t('executions.empty'))
      expect(section.get('.tk-count').text()).toBe(
        i18n.global.t('executions.count', { count: 0 })
      )
    }
    expect(daemonSection(wrapper).get('.tk-sec-title').text()).toBe(
      i18n.global.t('executions.daemons.title')
    )
  })

  it('renders the Daemons section even when only agents are registered', async () => {
    const agentsOnly = snapshot()
    const section = agentsOnly.launch_agents as { agents: Record<string, unknown>[] }
    section.agents = section.agents.filter((a) => a.scope !== 'system-daemon')
    wire.overrides.set('executions.list', agentsOnly)
    wrapper = await mountPanel()

    expect(agentLabels(wrapper)).toHaveLength(4)
    expect(daemonLabels(wrapper)).toHaveLength(0)
    expect(daemonSection(wrapper).find('.tk-empty').exists()).toBe(true)
  })

  it('shows a section-level scan error reported by the backend', async () => {
    const broken = snapshot()
    ;(broken.crontab as Record<string, unknown>) = {
      supported: true,
      error: 'crontab: permission denied',
      entries: [],
    }
    wire.overrides.set('executions.list', broken)
    wrapper = await mountPanel()

    expect(cronSection(wrapper).get('.tk-sec-error').text()).toContain('permission denied')
  })

  it('renders no untranslated i18n keys, including expanded and confirming rows', async () => {
    wrapper = await mountPanel()

    // Show every row shape: disabled crontab entries and stopped agents too.
    await cronSection(wrapper).get('[data-filter="all"]').trigger('click')
    await agentSection(wrapper).get('[data-filter="all"]').trigger('click')
    // Expanded detail blocks (including the "loaded, not running" state note).
    await cronSection(wrapper).get('[data-entry-id="c1"] .tk-row-head').trigger('click')
    await agentSection(wrapper)
      .get('[data-agent-label="local.nightly.index"] .tk-row-head')
      .trigger('click')
    // …and the read-only daemon, whose scope tag and "state unknown" note are
    // the only place several of the new keys appear.
    await daemonSection(wrapper)
      .get('[data-agent-label="com.vendor.daemon"] .tk-row-head')
      .trigger('click')
    // Both section titles are on screen, so a missing one would show up below.
    expect(wrapper.text()).toContain(i18n.global.t('executions.launchagents.title'))
    expect(wrapper.text()).toContain(i18n.global.t('executions.daemons.title'))
    // vue-i18n only warns on a missing key and renders the key itself, so a
    // typo would otherwise sail through every structural assertion above.
    expect(wrapper.findAll('.tk-detail')).toHaveLength(3)
    expect(wrapper.text()).not.toContain('executions.')
    // html() also covers the keys that only reach `title` attributes.
    expect(wrapper.html()).not.toContain('executions.')

    // Only one confirmation can be open at a time, so check each in turn.
    await cronSection(wrapper).get('[data-entry-id="c1"] .tk-act-remove').trigger('click')
    expect(cronSection(wrapper).findAll('.tk-confirm')).toHaveLength(1)
    expect(wrapper.html()).not.toContain('executions.')

    await agentSection(wrapper)
      .get('[data-agent-label="local.nightly.index"] .tk-act-remove')
      .trigger('click')
    expect(agentSection(wrapper).findAll('.tk-confirm')).toHaveLength(1)
    expect(wrapper.html()).not.toContain('executions.')
  })

  it('discards a scan that started before a mutation and landed after it', async () => {
    wrapper = await mountPanel()

    // A rescan is still in flight (the backend shells out; this can take a while).
    const releaseStaleScan = holdNext('executions.list')
    await wrapper.get('.tk-rescan').trigger('click')

    // Meanwhile the user disables c1 and the post-mutation scan comes back first.
    const disabled = snapshot()
    const entries = (disabled.crontab as { entries: Record<string, unknown>[] }).entries
    entries[0].id = 'c1-off'
    entries[0].enabled = false
    entries[0].raw = `# [NAVIDE-DISABLED] ${entries[0].raw}`
    wire.overrides.set('executions.list', disabled)

    await cronSection(wrapper).get('[data-entry-id="c1"] .tk-act-toggle').trigger('click')
    await flushPromises()
    expect(cronIds(wrapper)).toEqual(['c2'])

    // The stale scan (captured before the mutation) must not resurrect c1.
    releaseStaleScan()
    await flushPromises()
    expect(cronIds(wrapper)).toEqual(['c2'])
  })

  it('disables the confirmation OK while another mutation is in flight', async () => {
    wrapper = await mountPanel()

    const row = cronSection(wrapper).get('[data-entry-id="c1"]')
    await row.get('.tk-act-remove').trigger('click')
    expect(row.get('.tk-confirm-ok').attributes('disabled')).toBeUndefined()

    // A second row starts a mutation while this prompt is open.
    const releaseToggle = holdNext('executions.set_enabled')
    await cronSection(wrapper).get('[data-entry-id="c2"] .tk-act-toggle').trigger('click')
    await flushPromises()

    // mutate() would early-return, so the button must not look clickable.
    expect(row.get('.tk-confirm-ok').attributes('disabled')).toBeDefined()

    releaseToggle()
    await flushPromises()
  })

  it('confirms only the clicked row when two crontab lines are identical', async () => {
    const twins = snapshot()
    const raw = '0 * * * * ~/bin/twin.sh'
    ;(twins.crontab as Record<string, unknown>).entries = [
      {
        id: 'abc123-0',
        name: 'twin',
        schedule: '0 * * * *',
        schedule_kind: 'standard',
        command: '~/bin/twin.sh',
        raw,
        enabled: true,
      },
      {
        id: 'abc123-1',
        name: 'twin',
        schedule: '0 * * * *',
        schedule_kind: 'standard',
        command: '~/bin/twin.sh',
        raw,
        enabled: true,
      },
    ]
    wire.overrides.set('executions.list', twins)
    wrapper = await mountPanel()

    await cronSection(wrapper).get('[data-entry-id="abc123-1"] .tk-act-remove').trigger('click')

    expect(cronSection(wrapper).findAll('.tk-confirm')).toHaveLength(1)
    expect(
      cronSection(wrapper).get('[data-entry-id="abc123-1"]').find('.tk-confirm').exists()
    ).toBe(true)
    expect(
      cronSection(wrapper).get('[data-entry-id="abc123-0"]').find('.tk-confirm').exists()
    ).toBe(false)
  })

  it('surfaces an envelope-level failure of a mutation', async () => {
    wrapper = await mountPanel()
    wire.envelopeErrors.set('executions.set_enabled', 'backend disconnected')

    await cronSection(wrapper).get('[data-entry-id="c1"] .tk-act-toggle').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-error-section="crontab"]').text()).toContain('backend disconnected')
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
  })

  it('surfaces an envelope-level failure of the scan itself', async () => {
    wire.envelopeErrors.set('executions.list', 'session closed')
    wrapper = await mountPanel()

    expect(wrapper.get('.tk-scan-error').text()).toContain('session closed')
  })

  it('keeps an unread error through a broadcast refresh but clears it on rescan', async () => {
    wrapper = await mountPanel()
    wire.overrides.set('executions.set_enabled', { ok: false, error: 'Boot-out failed' })

    await agentSection(wrapper)
      .get('[data-agent-label="com.syncthing.syncthing"] .tk-act-toggle')
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-error-section="launchagent"]').exists()).toBe(true)

    // Another window's mutation must not wipe an error the user hasn't read.
    wire.listeners.get('executions.changed')?.forEach((cb) => cb(undefined))
    await flushPromises()
    expect(wrapper.find('[data-error-section="launchagent"]').exists()).toBe(true)

    await wrapper.get('.tk-rescan').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-error-section="launchagent"]').exists()).toBe(false)
  })

  it('reuses the cached scan when the panel is remounted', async () => {
    wrapper = await mountPanel()
    wrapper.unmount()

    wrapper = await mountPanel()

    // Switching rail tabs must not shell out to crontab/launchctl again.
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
    expect(cronIds(wrapper)).toEqual(['c1', 'c2'])
  })

  it('forgets expanded rows whose ids disappeared from the latest scan', async () => {
    wrapper = await mountPanel()
    await cronSection(wrapper).get('[data-entry-id="c1"] .tk-row-head').trigger('click')
    expect(cronSection(wrapper).get('[data-entry-id="c1"]').find('.tk-detail').exists()).toBe(true)

    // Disabling rewrites the raw line, so the backend hands back a different id.
    const renamed = snapshot()
    const entries = (renamed.crontab as { entries: Record<string, unknown>[] }).entries
    entries[0].id = 'c1-renamed'
    wire.overrides.set('executions.list', renamed)
    await wrapper.get('.tk-rescan').trigger('click')
    await flushPromises()

    expect(cronSection(wrapper).get('[data-entry-id="c1-renamed"]').find('.tk-detail').exists()).toBe(
      false
    )
    // And the orphan id is gone, so the old row would not reappear expanded.
    wire.overrides.delete('executions.list')
    await wrapper.get('.tk-rescan').trigger('click')
    await flushPromises()
    expect(cronSection(wrapper).get('[data-entry-id="c1"]').find('.tk-detail').exists()).toBe(false)
  })

  it('stops listening for executions.changed once unmounted', async () => {
    wrapper = await mountPanel()
    wrapper.unmount()
    wrapper = undefined

    wire.listeners.get('executions.changed')?.forEach((cb) => cb(undefined))
    await flushPromises()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
  })
  // Regression: the panel mounts with the app when Tasker was the last active
  // tab, i.e. while the backend is still starting. Scanning then would burn the
  // client timeout ("Scan failed: request executions.list timeout") and, with no
  // retry, leave both sections permanently empty.
  it('does not scan before the backend is connected', async () => {
    const backend = fakeBackend()
    ;(backend.status as Ref<string>).value = 'starting'

    wrapper = await mountPanel(backend)

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(0)
    expect(wrapper.find('.tk-scan-error').exists()).toBe(false)
  })

  it('scans once the backend reaches connected, with no user action', async () => {
    const backend = fakeBackend()
    const status = backend.status as Ref<string>
    status.value = 'starting'
    wrapper = await mountPanel(backend)

    status.value = 'connected'
    await flushPromises()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
    expect(cronIds(wrapper)).toEqual(['c1', 'c2'])
  })

  it('rescans after a reconnect', async () => {
    const backend = fakeBackend()
    const status = backend.status as Ref<string>
    wrapper = await mountPanel(backend)
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)

    status.value = 'disconnected'
    await flushPromises()
    status.value = 'connected'
    await flushPromises()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(2)
  })

  it('gives the shelling-out RPCs more budget than the client default', async () => {
    // executions.* run crontab/launchctl, and the service allows each command
    // 10s — the same as the client default, which leaves zero headroom.
    const backend = fakeBackend()
    wrapper = await mountPanel(backend)

    const send = backend.send as unknown as { mock: { calls: unknown[][] } }
    const timeout = send.mock.calls.find((a) => a[0] === 'executions.list')?.[2]
    expect(typeof timeout).toBe('number')
    expect(timeout as number).toBeGreaterThan(10_000)
  })
})
