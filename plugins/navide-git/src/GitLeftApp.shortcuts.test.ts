// @vitest-environment happy-dom
import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeCommand } from '@navide/plugin-ui/shared'
import { _resetKeybindingsState, _resetRegistry } from '@navide/plugin-ui/shared/testing'
import GitLeftApp from './GitLeftApp.vue'

describe('GitLeftApp Host shortcuts', () => {
  beforeEach(() => {
    _resetRegistry()
    _resetKeybindingsState()
    window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace&contribution=left')
  })

  afterEach(() => {
    _resetRegistry()
    _resetKeybindingsState()
  })

  it('forwards only the registered Host command through the contribution port', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const wrapper = shallowMount(GitLeftApp, {
      props: {
        surfacePorts: {} as never,
        legacyRepoSelection: {} as never,
        hostPort: {
          getState: vi.fn().mockResolvedValue(null),
          onStateChanged: vi.fn(() => () => undefined),
          dispatch,
        },
      },
    })
    await flushPromises()

    expect(executeCommand('workbench.action.openGitWindow')).toBe(true)
    expect(executeCommand('workbench.action.saveAll')).toBe(false)
    await flushPromises()
    expect(dispatch).toHaveBeenCalledWith({
      operation: 'execute_host_command',
      command: 'workbench.action.openGitWindow',
    })

    wrapper.unmount()
  })
})
