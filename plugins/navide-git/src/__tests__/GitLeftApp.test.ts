// @vitest-environment happy-dom
import { flushPromises, shallowMount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import GitLeftApp from '../GitLeftApp.vue'

const settingsListeners: ((keys: string[]) => void)[] = []
const loadTheme = vi.fn()

vi.mock('@navide/plugin-ui/shared', () => ({
  onSettingsChanged: vi.fn((cb: (keys: string[]) => void) => {
    settingsListeners.push(cb)
    return () => undefined
  }),
  settingsGet: vi.fn(() => ''),
  useKeybindings: vi.fn(() => ({ registerCommand: vi.fn() })),
}))

vi.mock('@navide/plugin-ui/foundation', () => ({
  useTheme: () => ({ loadTheme }),
}))

vi.mock('../components/MultiRepoGit.vue', () => ({
  default: {
    name: 'MultiRepoGit',
    template: '<div data-test="multi-repo-git" />',
  },
}))

describe('GitLeftApp', () => {
  it('owns a full-height shell around the Git contribution', () => {
    const wrapper = shallowMount(GitLeftApp, {
      props: {
        surfacePorts: {} as never,
        hostPort: {
          getState: vi.fn(async () => null),
          onStateChanged: vi.fn(() => () => undefined),
          dispatch: vi.fn(async () => undefined),
        } as never,
        legacyRepoSelection: {} as never,
      },
    })

    expect(wrapper.element.classList.contains('git-left-root')).toBe(true)
    expect(wrapper.findComponent({ name: 'MultiRepoGit' }).exists()).toBe(true)
  })

  it('adopts the stored theme and follows later switches', async () => {
    settingsListeners.length = 0
    loadTheme.mockClear()
    const wrapper = shallowMount(GitLeftApp, {
      props: {
        surfacePorts: {} as never,
        hostPort: {
          getState: vi.fn(async () => null),
          onStateChanged: vi.fn(() => () => undefined),
          dispatch: vi.fn(async () => undefined),
        } as never,
        legacyRepoSelection: {} as never,
      },
    })
    await flushPromises()

    // mount.ts only stamps data-theme once from the entry query; that snapshot
    // is stale as soon as the user switches theme.
    expect(loadTheme).toHaveBeenCalledTimes(1)
    // No backend fallback: passing one makes loadTheme write the theme back to
    // the shared store, which the Host mirrors — see themeCallSites.test.ts.
    expect(loadTheme).toHaveBeenCalledWith()

    settingsListeners.forEach((cb) => cb(['agent-team:theme']))
    expect(loadTheme).toHaveBeenCalledTimes(2)

    settingsListeners.forEach((cb) => cb(['agent-team:theme-custom']))
    expect(loadTheme).toHaveBeenCalledTimes(3)

    settingsListeners.forEach((cb) => cb(['agentTeam.somethingElse']))
    expect(loadTheme).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })
})
