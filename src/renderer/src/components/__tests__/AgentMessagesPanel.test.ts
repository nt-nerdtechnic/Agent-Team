// @vitest-environment happy-dom
// AgentMessagesPanel (the right-rail "Messages" tab) — the inter-CLI delivery
// log. The panel reads the useAgentMessaging singleton directly, so every
// assertion goes through the real composable rather than a stubbed prop.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '../../i18n'
import AgentMessagesPanel from '../AgentMessagesPanel.vue'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  type MessagingDeps,
} from '../../composables/useAgentMessaging'

let clock: number
let idlePanes: Set<string>
let deliverResult: boolean
/** When set, `deliver` parks on it — used to observe the `delivering` status. */
let deliverGate: Promise<void> | null

const deps: MessagingDeps = {
  now: () => clock,
  deliver: async () => {
    if (deliverGate) await deliverGate
    return deliverResult
  },
  isPaneIdle: (paneId) => idlePanes.has(paneId),
}

let m: ReturnType<typeof useAgentMessaging>

function mountPanel(): VueWrapper {
  return mount(AgentMessagesPanel, { global: { plugins: [i18n] } })
}

function rowIds(wrapper: VueWrapper): (string | undefined)[] {
  return wrapper.findAll('[data-msg-id]').map((el) => el.attributes('data-msg-id'))
}

function routes(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.msg-route').map((el) => el.text())
}

describe('AgentMessagesPanel', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set()
    deliverResult = true
    deliverGate = null
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('shows the empty state when nothing has been sent', () => {
    wrapper = mountPanel()

    expect(wrapper.find('.msg-empty').text()).toBe(i18n.global.t('msg.empty'))
    expect(rowIds(wrapper)).toEqual([])
  })

  it('lists messages newest first', () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.registerPane('p2', 'codex', 'beta') // never idle → everything stays queued
    m.sendMessage('alpha', 'beta', 'first')
    m.sendMessage('alpha', 'beta', 'second')
    wrapper = mountPanel()

    expect(rowIds(wrapper)).toEqual(['2', '1'])
    expect(routes(wrapper)).toEqual(['alpha → beta', 'alpha → beta'])
    expect(wrapper.findAll('.msg-preview').map((el) => el.text())).toEqual(['second', 'first'])
  })

  it('expands and collapses a row', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.sendMessage('alpha', 'nobody', 'the full body')
    wrapper = mountPanel()

    expect(wrapper.find('.msg-detail').exists()).toBe(false)

    await wrapper.get('[data-msg-id="1"]').trigger('click')
    const detail = wrapper.get('.msg-detail')
    expect(detail.get('pre').text()).toBe('the full body')
    // The failure reason only shows in the expanded block.
    expect(detail.get('.msg-reason').text()).toContain('unknown target')

    await wrapper.get('[data-msg-id="1"]').trigger('click')
    expect(wrapper.find('.msg-detail').exists()).toBe(false)
  })

  it('shows only one expanded row at a time', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.sendMessage('alpha', 'nobody', 'one')
    m.sendMessage('alpha', 'nobody', 'two')
    wrapper = mountPanel()

    await wrapper.get('[data-msg-id="1"]').trigger('click')
    await wrapper.get('[data-msg-id="2"]').trigger('click')

    expect(wrapper.findAll('.msg-detail')).toHaveLength(1)
    expect(wrapper.get('.msg-detail').get('pre').text()).toBe('two')
  })

  it('pauses and resumes delivery from the header button', async () => {
    wrapper = mountPanel()
    const btn = wrapper.get('[data-act="pause"]')

    expect(btn.text()).toBe(i18n.global.t('msg.pause'))
    expect(wrapper.find('.msg-paused').exists()).toBe(false)

    await btn.trigger('click')
    expect(m.paused.value).toBe(true)
    expect(btn.text()).toBe(i18n.global.t('msg.resume'))
    expect(wrapper.get('.msg-paused').text()).toBe(i18n.global.t('msg.paused-banner'))

    await btn.trigger('click')
    expect(m.paused.value).toBe(false)
    expect(btn.text()).toBe(i18n.global.t('msg.pause'))
    expect(wrapper.find('.msg-paused').exists()).toBe(false)
  })

  it('clears finished rows but keeps the ones still in flight', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.registerPane('p2', 'codex', 'beta') // never idle → stays queued
    m.sendMessage('alpha', 'nobody', 'this one failed')
    m.sendMessage('alpha', 'beta', 'still queued')
    wrapper = mountPanel()
    expect(rowIds(wrapper)).toEqual(['2', '1'])

    await wrapper.get('[data-act="clear"]').trigger('click')

    expect(rowIds(wrapper)).toEqual(['2'])
    expect(wrapper.get('.msg-preview').text()).toBe('still queued')
  })

  it('badges a message that crossed a workspace boundary', () => {
    m.registerPane('p2', 'codex', 'beta') // never idle → stays queued
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'from another project',
      remoteWorkspace: '/ws/alpha',
    })
    wrapper = mountPanel()

    const badge = wrapper.get('.msg-xws')
    expect(badge.text()).toBe(i18n.global.t('msg.cross-workspace-badge'))
    expect(badge.attributes('title')).toBe('/ws/alpha')
  })

  it('renders no untranslated i18n keys across every row state', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.registerPane('p2', 'codex', 'beta')
    m.registerPane('p3', 'qwen', 'gamma')
    m.registerPane('p4', 'grok', 'delta')

    // failed
    m.sendMessage('alpha', 'nobody', 'no such pane')
    // queued (target never idle)
    m.sendMessage('alpha', 'beta', 'waiting its turn')
    // delivered
    idlePanes.add('p3')
    m.sendMessage('alpha', 'gamma', 'went through')
    m.pump()
    await flushPromises()
    // delivering — parked inside deliver()
    let release = (): void => {}
    deliverGate = new Promise<void>((resolve) => {
      release = resolve
    })
    idlePanes.add('p4')
    m.sendMessage('alpha', 'delta', 'in flight')
    m.pump()
    await flushPromises()
    // inbound cross-workspace, for the badge
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'from another project',
      remoteWorkspace: '/ws/alpha',
    })

    wrapper = mountPanel()
    // Paused banner + an expanded detail block, so those strings render too.
    await wrapper.get('[data-act="pause"]').trigger('click')
    await wrapper.get('[data-msg-id="1"]').trigger('click')

    expect(wrapper.findAll('[data-st]').map((el) => el.attributes('data-st'))).toEqual(
      expect.arrayContaining(['queued', 'delivering', 'delivered', 'failed'])
    )
    expect(wrapper.text()).toContain(i18n.global.t('msg.panel-title'))
    // vue-i18n only warns on a missing key and renders the key itself, so a typo
    // would otherwise sail through every structural assertion above. html() also
    // covers the keys that only reach `title` attributes.
    expect(wrapper.text()).not.toContain('msg.')
    expect(wrapper.html()).not.toContain('msg.')

    release()
    await flushPromises()
  })
})
