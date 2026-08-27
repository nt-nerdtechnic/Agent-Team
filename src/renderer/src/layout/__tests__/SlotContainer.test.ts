// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import SlotContainer from '../SlotContainer.vue'

function mountSlot(props: Record<string, unknown> = {}): VueWrapper {
  return mount(SlotContainer, {
    props: { slotId: 'down', views: ['history', 'tasker'], active: 'history', collapsed: false, ...props },
    slots: { default: (p: { viewId: string | null }) => h('div', { class: 'body-probe' }, p.viewId ?? 'none') },
    global: { mocks: { $t: (key: string) => key } },
  } as never) as VueWrapper
}

describe('SlotContainer', () => {
  it('renders nothing at all for an empty slot', () => {
    // An empty slot is a legal resting state, and it must take no space —
    // the grid row it sits in resolves to 0px only if nothing is drawn.
    const w = mountSlot({ views: [], active: null })
    expect(w.find('.slot').exists()).toBe(false)
    expect(w.find('.body-probe').exists()).toBe(false)
    w.unmount()
  })

  it('renders one tab per assigned view, in that order', () => {
    const w = mountSlot({ views: ['tasker', 'history'] })
    expect(w.findAll('.slot-tab-label').map((n) => n.text())).toEqual(['label.tasker', 'label.history'])
    w.unmount()
  })

  it('skips view ids the registry does not know', () => {
    const w = mountSlot({ views: ['history', 'a-view-that-was-removed'] })
    expect(w.findAll('.slot-tab')).toHaveLength(1)
    w.unmount()
  })

  it('passes only the active view to the body', () => {
    const w = mountSlot({ active: 'tasker' })
    expect(w.find('.body-probe').text()).toBe('tasker')
    w.unmount()
  })

  it('falls back to the first view when the active one is not in the slot', () => {
    // Happens the moment another window moves that view somewhere else.
    const w = mountSlot({ active: 'messages' })
    expect(w.find('.body-probe').text()).toBe('history')
    w.unmount()
  })

  it('asks the parent to switch, never switching on its own', async () => {
    const w = mountSlot()
    await w.findAll('.slot-tab')[1].trigger('click')
    expect(w.emitted('update:active')).toEqual([['tasker']])
    // The parent did not act, so the body still shows the old view.
    expect(w.find('.body-probe').text()).toBe('history')
    w.unmount()
  })

  it('does not re-announce the tab that is already active', async () => {
    const w = mountSlot()
    await w.findAll('.slot-tab')[0].trigger('click')
    expect(w.emitted('update:active')).toBeUndefined()
    w.unmount()
  })

  it('reopens when a tab is clicked while collapsed', async () => {
    const w = mountSlot({ collapsed: true })
    await w.findAll('.slot-tab')[1].trigger('click')
    expect(w.emitted('update:collapsed')).toEqual([[false]])
    expect(w.emitted('update:active')).toEqual([['tasker']])
    w.unmount()
  })

  it('keeps the body mounted while collapsed so its state survives', () => {
    // v-show, not v-if: a collapse must not throw away scroll position or an
    // in-flight request the way unmounting would.
    const w = mountSlot({ collapsed: true })
    const body = w.find('.slot-body')
    expect(body.exists()).toBe(true)
    expect(body.attributes('style')).toContain('display: none')
    expect(w.find('.body-probe').exists()).toBe(true)
    w.unmount()
  })

  it('points the chevron the way the body would move, per slot', async () => {
    const up = mountSlot({ slotId: 'up' })
    const down = mountSlot({ slotId: 'down' })
    expect(up.find('.slot-collapse').text()).toBe('⌃')
    expect(down.find('.slot-collapse').text()).toBe('⌄')
    await up.setProps({ collapsed: true })
    await down.setProps({ collapsed: true })
    expect(up.find('.slot-collapse').text()).toBe('⌄')
    expect(down.find('.slot-collapse').text()).toBe('⌃')
    up.unmount()
    down.unmount()
  })

  it('toggles collapse through the parent', async () => {
    const w = mountSlot()
    await w.find('.slot-collapse').trigger('click')
    expect(w.emitted('update:collapsed')).toEqual([[true]])
    w.unmount()
  })

  it('carries its slot id as a class so the shell can place it', () => {
    const w = mountSlot({ slotId: 'up' })
    expect(w.find('.slot').classes()).toContain('slot--up')
    w.unmount()
  })
})
