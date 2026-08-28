// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'

const state = vi.hoisted(() => {
  const readiness = { status: 'failed' as 'failed' | 'ready', error: new Error('snapshot unavailable') }
  const retrySettings = vi.fn(async () => {
    readiness.status = 'ready'
  })
  return { readiness, retrySettings }
})

vi.mock('@navide/plugin-ui/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@navide/plugin-ui/shared')>()
  return {
    ...actual,
    settingsReadiness: state.readiness,
    retrySettings: state.retrySettings,
  }
})

import SettingsReadinessNotice from './SettingsReadinessNotice.vue'

describe('SettingsReadinessNotice', () => {
  beforeEach(() => {
    state.readiness.status = 'failed'
    state.retrySettings.mockClear()
  })

  it('keeps the v2 surface actionable after a failed snapshot', async () => {
    const wrapper = mount(SettingsReadinessNotice, { global: { plugins: [i18n] } })

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    await wrapper.get('button').trigger('click')

    expect(state.retrySettings).toHaveBeenCalledOnce()
    expect(state.readiness.status).toBe('ready')
  })
})
