// @vitest-environment happy-dom
// Why the picture on screen might be old, said correctly.
//
// The window showed "The link is down, so this is the last thing the server
// said." under a connection card that was green, at the same moment, on the
// same screen — because a snapshot read that failed left the previous list up
// and the only sentence available for an out-of-date list named the link. A
// failed read says nothing about the socket: the handler can throw while the
// connection is perfectly healthy, which is exactly what a locked keychain
// under `p2p.network.snapshot` used to do.
//
// Mounted, not source-scanned: "these two sentences are never both on screen"
// is a statement about what is rendered, and a grep for the key would pass
// against a template that shows both.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import AccountModal from '../AccountModal.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { usePairingState, _resetForTest } from '../../composables/usePairingState'

let wrapper: VueWrapper | undefined
const original = i18n.global.locale.value

afterEach(() => {
  _resetForTest()
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = original
  delete (window as unknown as Record<string, unknown>).agentTeam
})

const t = (key: string) => i18n.global.t(key)

/** A window whose link is up and whose first snapshot arrived. */
async function mountConnected() {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    trustConfirm: vi.fn().mockResolvedValue({ token: 't' }),
  }
  const mock = createMockBackend('connected')
  mock.setResponse('p2p.link.status', {
    status: { state: 'connected', accountEmail: 'a@b.c', serverUrl: 'wss://x', emailVerified: true },
  })
  mock.setResponse('p2p.network.snapshot', {
    state: 'connected',
    deviceId: 'me',
    devices: [
      { deviceId: 'me', deviceName: 'This one', isLocal: true, online: true, paneCount: 1, panes: [] },
      { deviceId: 'f9c30189', deviceName: 'M4', isLocal: false, online: true, paneCount: 1, panes: [] },
    ],
  })
  wrapper = mount(AccountModal, {
    props: { open: true, backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return mock
}

describe('when the picture might be out of date', () => {
  it('says nothing about it while the reads are coming back', async () => {
    await mountConnected()

    expect(wrapper!.text()).not.toContain(t('settings.p2p.network.not-current'))
    expect(wrapper!.text()).not.toContain(t('settings.p2p.network.link-offline'))
  })

  it('does not blame the link for a read that failed', async () => {
    // The contradiction as it was reported: a green connection card above a
    // sentence saying the link was down.
    const mock = await mountConnected()
    mock.setRejection('p2p.network.snapshot')

    await usePairingState(mock.backend as never).refresh()
    await flushPromises()

    expect(wrapper!.text()).toContain(t('settings.p2p.network.not-current'))
    expect(wrapper!.text()).not.toContain(t('settings.p2p.network.link-offline'))
    // And the list it is warning about is still there: emptying it would be a
    // claim of its own — that these machines went away.
    expect(wrapper!.findAll('.dev')).toHaveLength(2)
  })

  it('stops saying it once a read comes back', async () => {
    const mock = await mountConnected()
    mock.setRejection('p2p.network.snapshot')
    await usePairingState(mock.backend as never).refresh()
    await flushPromises()
    expect(wrapper!.text()).toContain(t('settings.p2p.network.not-current'))

    mock.clearRejection('p2p.network.snapshot')
    await usePairingState(mock.backend as never).refresh()
    await flushPromises()

    expect(wrapper!.text()).not.toContain(t('settings.p2p.network.not-current'))
  })
})
