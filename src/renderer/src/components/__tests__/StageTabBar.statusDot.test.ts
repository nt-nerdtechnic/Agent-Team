// @vitest-environment happy-dom
// The status dot on each StageTabBar tab: one leading dot per tab, coloured by
// the tab's rolled-up status. The dot must survive a rename (it sits outside
// the label/input branch) so the tab does not shift width while typing, and it
// must carry hover/AT text — a bare colour is not a signal for everyone.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import StageTabBar, { type TabItem } from '../StageTabBar.vue'

const tabs: TabItem[] = [
  { key: 'rg-1', label: 'Main', count: 12, type: 'stage', status: 'active' },
  { key: 'rg-2', label: 'Specs', count: 7, type: 'stage', status: 'idle' },
  { key: 'rg-3', label: 'Empty', count: 0, type: 'stage', status: 'empty' }
]

function mountBar(items: TabItem[] = tabs) {
  return mount(StageTabBar, {
    props: { tabs: items, modelValue: 'rg-1' },
    global: { plugins: [i18n] }
  })
}

describe('StageTabBar – status dot', () => {
  it('renders one dot per tab, carrying that tab\'s status', () => {
    const dots = mountBar().findAll('.tab-dot')
    expect(dots).toHaveLength(3)
    expect(dots.map((d) => d.attributes('data-state'))).toEqual(['active', 'idle', 'empty'])
  })

  it('gives the dot hover and accessible text', () => {
    const dot = mountBar().findAll('.tab-dot')[0]
    expect(dot.attributes('title')).toBeTruthy()
    expect(dot.attributes('aria-label')).toBe(dot.attributes('title'))
  })

  it('keeps the dot while a tab is being renamed', async () => {
    const wrapper = mountBar()
    await wrapper.findAll('.tab-btn')[0].trigger('dblclick')

    expect(wrapper.find('.tab-rename-input').exists()).toBe(true)
    expect(wrapper.findAll('.tab-dot')).toHaveLength(3)
  })

  it('places the dot before the label so it reads as a leading indicator', () => {
    const tab = mountBar().findAll('.tab-btn')[0]
    const children = Array.from(tab.element.children).map((el) => el.className)
    expect(children.indexOf('tab-dot')).toBeLessThan(children.indexOf('tab-label'))
  })
})

describe('StageTabBar – the shape of the status dot', () => {
  it('matches the sidebar group key rather than being a circle', () => {
    // The tab dot and ControlPane's .ws-grp-key show the SAME value, from the
    // same rollupTabStatus() call, for the same group. Two shapes read as two
    // different kinds of indicator, so the geometry is kept in step on purpose.
    const bar = readFileSync(resolve(__dirname, '../StageTabBar.vue'), 'utf8')
    const dot = bar.match(/\.tab-dot \{[^}]*\}/)?.[0] ?? ''
    expect(dot).toContain('width: 7px')
    expect(dot).toContain('height: 7px')
    expect(dot).toContain('border-radius: 2px')

    const pane = readFileSync(resolve(__dirname, '../ControlPane.vue'), 'utf8')
    const key = pane.match(/\.ws-grp-key \{[^}]*\}/)?.[0] ?? ''
    expect(key).toContain('width: 7px')
    expect(key).toContain('height: 7px')
    expect(key).toContain('border-radius: 2px')
  })
})
