// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

// The rail strip: one cell per group of workspaces, All pinned first, filtering
// the list beside it. Its promise is that switching cells moves NOTHING else —
// not the workspace on screen, not a pane, not the terminal.

const localPanes = [
  { id: 'p1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false },
]

const A = '/Users/me/Desktop/Agent-Team'
const B = '/Users/me/Desktop/Navide-Server'

const wsRow = (path: string, label: string, count = 1) => ({
  path,
  label,
  displayPath: '~/Desktop',
  isCurrent: true,
  collapsed: false,
  count,
  lineage: [],
  groups: [],
})

function mountWith(extra: Record<string, unknown> = {}): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      agentSpecs: [],
      roles: [],
      stages: [],
      panes: localPanes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false,
      existingProject: null,
      workspace: A,
      workspaces: [wsRow(A, 'Agent-Team'), wsRow(B, 'Navide-Server')],
      ...extra,
    } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
}

/** Make a group through the UI, the way the user does. */
async function makeRail(wrapper: VueWrapper, name: string): Promise<void> {
  await wrapper.find('.ws-radd').trigger('click')
  const field = wrapper.find('.ws-rname-in')
  await field.setValue(name)
  await field.trigger('keydown.enter')
}

/** Drop a workspace heading onto a cell — the drag the sidebar already
 *  supports, landing on a new target. */
async function dropOnCell(wrapper: VueWrapper, cellIndex: number, path: string): Promise<void> {
  const cells = wrapper.findAll('.ws-rcell')
  await cells[cellIndex].trigger('drop', {
    dataTransfer: {
      types: ['application/x-workspace-path'],
      getData: () => path,
    },
  })
}

const names = (wrapper: VueWrapper): string[] =>
  wrapper.findAll('.ws-name').map((n) => n.text())

describe('ControlPane – workspace rails', () => {
  let wrapper: VueWrapper
  beforeEach(() => sessionStorage.clear())
  afterEach(() => {
    wrapper?.unmount()
    sessionStorage.clear()
  })

  it('shows no rail at all when the window holds no workspace headings', () => {
    wrapper = mountWith({ workspaces: undefined })
    expect(wrapper.find('.ws-rail').exists()).toBe(false)
  })

  it('shows no rail in a detached window, which is one workspace by definition', () => {
    wrapper = mountWith({ detachedWindow: true })
    expect(wrapper.find('.ws-rail').exists()).toBe(false)
  })

  it('starts as a lone ＋ rather than a strip of one', () => {
    wrapper = mountWith()
    expect(wrapper.find('.ws-rail').exists()).toBe(true)
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(1)
    expect(wrapper.find('.ws-rcell').classes()).toContain('ws-radd')
    // and the list is untouched
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('＋ opens a naming field instead of a blocking prompt', async () => {
    wrapper = mountWith()
    expect(wrapper.find('.ws-rname-in').exists()).toBe(false)
    await wrapper.find('.ws-radd').trigger('click')
    expect(wrapper.find('.ws-rname-in').exists()).toBe(true)
  })

  it('naming a group adds All plus that group, and shows the new one', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶案')
    const cells = wrapper.findAll('.ws-rcell')
    // All, the new group, ＋
    expect(cells).toHaveLength(3)
    expect(cells[1].classes()).toContain('on')
    expect(cells[1].find('.ws-rglyph').text()).toBe('客')
    // Nothing is filed there yet, so the list is empty rather than unfiltered.
    expect(names(wrapper)).toEqual([])
    expect(wrapper.find('.ws-rail-empty').exists()).toBe(true)
  })

  it('Escape abandons the naming field without making a group', async () => {
    wrapper = mountWith()
    await wrapper.find('.ws-radd').trigger('click')
    const field = wrapper.find('.ws-rname-in')
    await field.setValue('未完成')
    await field.trigger('keydown.esc')
    expect(wrapper.find('.ws-rname-in').exists()).toBe(false)
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(1)
  })

  it('a blank name makes nothing', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '   ')
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(1)
  })

  it('dropping a workspace onto a cell files it there and the list follows', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶案')
    await dropOnCell(wrapper, 1, B)
    expect(names(wrapper)).toEqual(['Navide-Server'])
    // The cell counts the panes it now holds.
    expect(wrapper.findAll('.ws-rcell')[1].find('.ws-rbump').text()).toBe('1')
  })

  it('All shows every workspace again', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶案')
    await dropOnCell(wrapper, 1, B)
    await wrapper.findAll('.ws-rcell')[0].trigger('click')
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
    expect(wrapper.findAll('.ws-rcell')[0].classes()).toContain('on')
  })

  it('dropping onto All takes a workspace back out of every group', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶案')
    await dropOnCell(wrapper, 1, B)
    await dropOnCell(wrapper, 0, B)
    expect(names(wrapper)).toEqual([])
    await wrapper.findAll('.ws-rcell')[0].trigger('click')
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('membership is exclusive: filing into a second group leaves the first', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '產品')
    await makeRail(wrapper, '客戶')
    await dropOnCell(wrapper, 1, B)
    await dropOnCell(wrapper, 2, B)
    const cells = wrapper.findAll('.ws-rcell')
    expect(cells[1].find('.ws-rbump').exists()).toBe(false)
    expect(cells[2].find('.ws-rbump').text()).toBe('1')
  })

  it('dots the group holding the workspace on screen, even from another group', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '產品')
    await dropOnCell(wrapper, 1, A) // A is props.workspace
    await makeRail(wrapper, '客戶')
    const cells = wrapper.findAll('.ws-rcell')
    // Looking at 客戶, still working in 產品.
    expect(cells[2].classes()).toContain('on')
    expect(cells[1].find('.ws-rdot').exists()).toBe(true)
    expect(cells[2].find('.ws-rdot').exists()).toBe(false)
    // All never gets one: it holds the current workspace by definition.
    expect(cells[0].find('.ws-rdot').exists()).toBe(false)
  })

  it('dims a group whose members are all closed but keeps it on the strip', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await dropOnCell(wrapper, 1, '/Users/me/Desktop/never-opened')
    await wrapper.findAll('.ws-rcell')[0].trigger('click')
    const cell = wrapper.findAll('.ws-rcell')[1]
    expect(cell.exists()).toBe(true)
    expect(cell.classes()).toContain('dim')
  })

  it('right-clicking a group opens rename/delete; right-clicking All does not', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await wrapper.findAll('.ws-rcell')[0].trigger('contextmenu')
    expect(wrapper.findAll('.ws-ctx-menu')).toHaveLength(0)
    await wrapper.findAll('.ws-rcell')[1].trigger('contextmenu')
    expect(wrapper.findAll('.ws-ctx-menu')).toHaveLength(1)
  })

  it('deleting a group keeps its workspaces and falls back to All', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await dropOnCell(wrapper, 1, B)
    await wrapper.findAll('.ws-rcell')[1].trigger('contextmenu')
    const del = wrapper.findAll('.ws-ctx-menu .ws-ctx-opt').at(-1)!
    await del.trigger('click')
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(1)
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('renaming a group re-glyphs its cell', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await wrapper.findAll('.ws-rcell')[1].trigger('contextmenu')
    await wrapper.find('.ws-ctx-menu .ws-ctx-opt').trigger('click')
    const field = wrapper.find('.ws-rname-in')
    expect((field.element as HTMLInputElement).value).toBe('客戶')
    await field.setValue('內部')
    await field.trigger('keydown.enter')
    expect(wrapper.findAll('.ws-rcell')[1].find('.ws-rglyph').text()).toBe('內')
  })

  it('survives a reload: rails and the chosen one come back from sessionStorage', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await dropOnCell(wrapper, 1, B)
    wrapper.unmount()

    wrapper = mountWith()
    const cells = wrapper.findAll('.ws-rcell')
    expect(cells).toHaveLength(3)
    expect(cells[1].classes()).toContain('on')
    expect(names(wrapper)).toEqual(['Navide-Server'])
  })

  it('a stored group that no longer exists shows everything, not nothing', () => {
    sessionStorage.setItem('agentTeam.workspaceRails', '[]')
    sessionStorage.setItem('agentTeam.activeWorkspaceRail', 'wr-gone')
    wrapper = mountWith()
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('corrupt stored rails cost the grouping, never the list', () => {
    sessionStorage.setItem('agentTeam.workspaceRails', 'not json at all')
    wrapper = mountWith()
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(1)
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('the All glyph follows the interface language', async () => {
    // The cell shows a name's first character, so a locale switch has to
    // re-glyph it: the strip is built in a computed, and a t() call that does
    // not track the locale would freeze it in the language it was first drawn.
    const before = i18n.global.locale.value
    try {
      i18n.global.locale.value = 'en-US'
      wrapper = mountWith()
      await makeRail(wrapper, '客戶')
      expect(wrapper.findAll('.ws-rcell')[0].find('.ws-rglyph').text()).toBe('A')
      i18n.global.locale.value = 'zh-TW'
      await wrapper.vm.$nextTick()
      expect(wrapper.findAll('.ws-rcell')[0].find('.ws-rglyph').text()).toBe('全')
    } finally {
      i18n.global.locale.value = before
    }
  })

  it('switching groups emits nothing — the strip moves the view, not the work', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await dropOnCell(wrapper, 1, B)
    await wrapper.findAll('.ws-rcell')[0].trigger('click')
    await wrapper.findAll('.ws-rcell')[1].trigger('click')
    expect(wrapper.emitted('switch-to-workspace')).toBeUndefined()
    expect(wrapper.emitted('close-workspace')).toBeUndefined()
    expect(wrapper.emitted('detach-workspace')).toBeUndefined()
    expect(wrapper.emitted('toggle-workspace')).toBeUndefined()
  })
})
