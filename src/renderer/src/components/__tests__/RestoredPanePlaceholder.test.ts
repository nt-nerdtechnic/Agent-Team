// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RestoredPanePlaceholder from '../RestoredPanePlaceholder.vue'

function mountPlaceholder(realizing = false) {
  return mount(RestoredPanePlaceholder, {
    props: {
      paneId: 'saved-pane-1',
      title: 'Planning',
      subtitle: 'Claude · Architect',
      pipeTag: 'P01',
      isFocus: true,
      realizing,
    },
    global: {
      mocks: {
        $t: (key: string) => ({
          'pane.terminal.click-to-resume': 'Click to resume',
          'pane.terminal.resuming': 'Resuming…',
          'pane.terminal.minimize-tooltip': 'Minimize to sidebar',
        })[key] ?? key,
      },
    },
  })
}

describe('RestoredPanePlaceholder', () => {
  it('shows persisted pane metadata without a terminal host', () => {
    const wrapper = mountPlaceholder()

    expect(wrapper.attributes('data-pane-id')).toBe('saved-pane-1')
    expect(wrapper.classes()).toContain('pane-focus')
    expect(wrapper.text()).toContain('P01')
    expect(wrapper.text()).toContain('Planning')
    expect(wrapper.text()).toContain('Claude · Architect')
    expect(wrapper.text()).toContain('Click to resume')
    expect(wrapper.find('.terminal').exists()).toBe(false)
    expect(wrapper.find('.xterm').exists()).toBe(false)
  })

  it('activates only from a mouse click while idle', async () => {
    const wrapper = mountPlaceholder()

    await wrapper.trigger('click')
    expect(wrapper.emitted('activate')).toHaveLength(1)

    await wrapper.trigger('keydown', { key: 'Enter' })
    await wrapper.trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('activate')).toHaveLength(1)
  })

  it('does not activate while realization is already in flight', async () => {
    const wrapper = mountPlaceholder(true)

    await wrapper.trigger('click')
    expect(wrapper.emitted('activate')).toBeUndefined()
    expect(wrapper.text()).toContain('Resuming…')
    expect(wrapper.attributes('aria-busy')).toBe('true')
  })

  it('keeps minimize and context-menu actions separate from activation', async () => {
    const wrapper = mountPlaceholder()

    await wrapper.get('.minimize-btn').trigger('click')
    expect(wrapper.emitted('minimize')).toHaveLength(1)
    expect(wrapper.emitted('activate')).toBeUndefined()

    await wrapper.trigger('contextmenu')
    expect(wrapper.emitted('context-menu')).toHaveLength(1)
    expect(wrapper.emitted('activate')).toBeUndefined()
  })
})
