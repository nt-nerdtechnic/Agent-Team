// @vitest-environment happy-dom
import { shallowMount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import GitLeftApp from '../GitLeftApp.vue'

vi.mock('@navide/plugin-ui/shared', () => ({
  onSettingsChanged: vi.fn(() => () => undefined),
  settingsGet: vi.fn(() => ''),
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
})
