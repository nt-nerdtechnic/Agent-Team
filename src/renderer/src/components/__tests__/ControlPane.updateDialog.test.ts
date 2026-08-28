// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
import { useNotify } from '@navide/plugin-ui/foundation'
import type { UpdateState } from '../../../../shared/updater'

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
  autoAnswerEnabled: false,
  existingProject: null,
  canRebuildAll: true,
  rebuildingAll: false
} as unknown as Record<string, unknown>

describe('ControlPane – update toast vs decision dialog', () => {
  let wrapper: VueWrapper
  let pushState: (state: UpdateState) => void

  async function announce(state: Partial<UpdateState>): Promise<void> {
    pushState({ status: 'available', currentVersion: '1.0.0', ...state })
    await nextTick()
  }

  beforeEach(() => {
    // Minimal preload bridge: enough for useUpdater to subscribe so the test
    // can push updater states into the component.
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      version: '1.0.0',
      updater: {
        onStateChanged: (cb: (state: UpdateState) => void) => {
          pushState = cb
          return () => {}
        },
        getState: async (): Promise<UpdateState> => ({ status: 'idle', currentVersion: '1.0.0' }),
        getSettings: async () => ({ autoCheck: true, autoDownload: true, channel: 'stable' })
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: minimalProps,
      global: { mocks: { $t: (key: string) => key } }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    // useNotify is a module-level singleton — drain it between tests.
    const notify = useNotify()
    if (notify.dialog.value) notify.resolveDialog(false)
    for (const t of [...notify.toasts.value]) notify.dismissToast(t.id)
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('keeps the toast for patch updates (and for severity-less states)', async () => {
    const notify = useNotify()
    await announce({ availableVersion: '1.0.1', severity: 'patch' })
    expect(notify.toasts.value).toHaveLength(1)
    expect(notify.dialog.value).toBeNull()

    await announce({ availableVersion: '1.0.2' }) // old main process: no severity
    expect(notify.toasts.value).toHaveLength(2)
    expect(notify.dialog.value).toBeNull()
  })

  it('opens a confirm dialog instead of a toast for minor/major updates', async () => {
    const notify = useNotify()
    await announce({ availableVersion: '2.0.0', severity: 'major', releaseNotes: 'Big rewrite' })
    expect(notify.toasts.value).toHaveLength(0)
    expect(notify.dialog.value).toMatchObject({ kind: 'confirm' })
    expect(notify.dialog.value!.message).toContain('Big rewrite')
  })

  it('does not re-prompt for the same version after Later', async () => {
    const notify = useNotify()
    await announce({ availableVersion: '2.0.0', severity: 'major' })
    notify.resolveDialog(false) // Later
    // Bounce through another status so the watch re-fires for the same version.
    pushState({ status: 'not-available', currentVersion: '1.0.0' })
    await nextTick()
    await announce({ availableVersion: '2.0.0', severity: 'major' })
    expect(notify.dialog.value).toBeNull()
    expect(notify.toasts.value).toHaveLength(0)
  })
})
