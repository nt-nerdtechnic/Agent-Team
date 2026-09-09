// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { initSettingsBackend, settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import ControlPane from '../ControlPane.vue'

const RAILS_KEY = 'agentTeam.workspaceRails'
const ACTIVE_KEY = 'agentTeam.activeWorkspaceRail'

/** What the global settings store holds for the rails. */
const stored = (): string => settingsGet<string>(RAILS_KEY, '')

/** Wire the settings module to a fake backend, so a broadcast from "another
 *  window" travels the real path (ui.settings_changed → cache → listeners)
 *  rather than a shortcut invented for the test. */
async function withSettingsBackend() {
  const mock = createMockBackend('connected')
  initSettingsBackend(mock.backend)
  await Promise.resolve()
  return mock
}

/** What another window regrouping looks like on the wire. */
const broadcastRails = (mock: Awaited<ReturnType<typeof withSettingsBackend>>, value: unknown) =>
  mock.emit('ui.settings_changed', { settings: { [RAILS_KEY]: value } })

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
  paneIds: [],
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
async function makeRail(wrapper: VueWrapper, name: string, color?: number): Promise<void> {
  await wrapper.find('.ws-bar-add').trigger('click')
  const field = wrapper.find('.ws-gdlg-in')
  await field.setValue(name)
  if (color !== undefined) await wrapper.findAll('.ws-gsw')[color].trigger('click')
  await field.trigger('keydown.enter')
}

/** The rails as stored, decoded. */
const railsOf = (): { id: string; name: string; members: string[]; color?: number }[] =>
  JSON.parse(stored() || '[]')

/** One gesture, one DataTransfer — the way a real drag works.
 *
 *  Handing each event its own object hides bugs: the first check in every
 *  handler is `types.includes(...)`, and a fresh object that was never
 *  setData'd fails it, so the assertion passes without the rule ever running. */
function makeDataTransfer() {
  const store: Record<string, string> = {}
  return {
    types: [] as string[],
    effectAllowed: '',
    setData(key: string, value: string) {
      store[key] = value
      if (!this.types.includes(key)) this.types.push(key)
    },
    getData(key: string) {
      return store[key] ?? ''
    },
  }
}

/** Step onto All. Creating a group switches to it, and a brand new group has
 *  no members — so the list is empty and there is no heading to drag. */
async function showAll(wrapper: VueWrapper): Promise<void> {
  await wrapper.findAll('.ws-bar')[0].trigger('click')
}

/** Start dragging a workspace heading, returning the gesture's DataTransfer. */
async function startWsDrag(wrapper: VueWrapper, index = 0) {
  const dt = makeDataTransfer()
  await wrapper.findAll('.ws-head')[index].trigger('dragstart', { dataTransfer: dt })
  return dt
}

/** Move the pointer to `clientX` over the sidebar row. happy-dom reports a
 *  zeroed rect, so clientX IS the distance from the left edge. */
async function dragTo(wrapper: VueWrapper, dt: unknown, clientX: number) {
  await wrapper.find('.ws-rail-wrap').trigger('dragover', { dataTransfer: dt, clientX })
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

/** Whether the flyout is hidden.
 *
 *  NOT `isVisible()` — in this test-utils/happy-dom pairing it returns true for
 *  an element that plainly carries `style="display: none"`, so every assertion
 *  built on it would pass no matter what the component did. Read the style
 *  v-show actually writes. */
const flyoutHidden = (wrapper: VueWrapper): boolean =>
  (wrapper.find('.ws-flyout').attributes('style') ?? '').includes('display: none')

/** The one thing these tests structurally cannot catch.
 *
 *  jsdom does no layout and no clipping, so a popup positioned inside the
 *  scrolling pane list renders perfectly in every test and is invisible in the
 *  app — which is exactly what shipped: the first naming field was
 *  `position: absolute` inside the strip, clipped by `.part-bottom`'s
 *  `overflow-y: auto` and painted over by the status bar at z-index 200.
 *  Clicking ＋ looked like a dead button.
 *
 *  With no runtime signal to assert on, reading the stylesheet is the honest
 *  check rather than the lazy one. Parses the rule block instead of searching
 *  the file for a substring, which any neighbouring rule would satisfy. */
describe('ControlPane – popups escape the scroller', () => {
  const source = readFileSync(resolve(__dirname, '../ControlPane.vue'), 'utf8')

  const ruleBody = (selector: string): string => {
    const at = source.indexOf(`\n${selector} {`)
    expect(at, `${selector} not found in ControlPane.vue`).toBeGreaterThan(-1)
    const open = source.indexOf('{', at)
    return source.slice(open + 1, source.indexOf('}', open))
  }

  // The dialog is the one that regressed; the menus are the precedent it has
  // to keep matching.
  it.each(['.ws-gdlg', '.ws-ctx-menu'])('%s is fixed, not absolute', (selector) => {
    const body = ruleBody(selector)
    expect(body).toMatch(/position:\s*fixed/)
    expect(body).not.toMatch(/position:\s*absolute/)
  })

  it('.ws-gdlg sits above the status bar', () => {
    // 200 is the status bar and titlebar; anything lower is painted over.
    const z = /z-index:\s*(\d+)/.exec(ruleBody('.ws-gdlg'))
    expect(z).not.toBeNull()
    expect(Number(z![1])).toBeGreaterThan(200)
  })
})

describe('ControlPane – workspace rails', () => {
  let wrapper: VueWrapper
  beforeEach(() => {
    sessionStorage.clear()
    __resetSettingsForTest()
  })
  afterEach(() => {
    wrapper?.unmount()
    sessionStorage.clear()
    __resetSettingsForTest()
  })

  it('shows no strip at all when the window holds no workspace headings', () => {
    wrapper = mountWith({ workspaces: undefined })
    expect(wrapper.find('.ws-strip').exists()).toBe(false)
  })

  it('shows no strip in a detached window, which is one workspace by definition', () => {
    wrapper = mountWith({ detachedWindow: true })
    expect(wrapper.find('.ws-strip').exists()).toBe(false)
  })

  it('starts as a lone ＋ rather than a strip of one', () => {
    wrapper = mountWith()
    expect(wrapper.find('.ws-strip').exists()).toBe(true)
    // Only the add bar; no All bar to sit alone next to nothing.
    expect(wrapper.findAll('.ws-bar')).toHaveLength(1)
    expect(wrapper.find('.ws-bar').classes()).toContain('ws-bar-add')
    // and the list is untouched
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('the flyout\'s New group opens the naming field too', async () => {
    // The strip's add bar and the flyout's row are two different buttons for
    // the same thing; makeRail only ever exercised the first.
    wrapper = mountWith()
    await wrapper.find('.ws-strip').trigger('mouseenter')
    const add = wrapper.find('.ws-flyout .ws-radd')
    expect(add.exists()).toBe(true)
    await add.trigger('click')
    expect(wrapper.find('.ws-gdlg-in').exists()).toBe(true)
  })

  it('＋ opens a naming field instead of a blocking prompt', async () => {
    wrapper = mountWith()
    expect(wrapper.find('.ws-gdlg-in').exists()).toBe(false)
    await wrapper.find('.ws-radd').trigger('click')
    expect(wrapper.find('.ws-gdlg-in').exists()).toBe(true)
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
    const field = wrapper.find('.ws-gdlg-in')
    await field.setValue('未完成')
    await field.trigger('keydown.esc')
    expect(wrapper.find('.ws-gdlg-in').exists()).toBe(false)
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(1)
  })

  it('a blank name makes nothing, and says so by staying open', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '   ')
    expect(wrapper.findAll('.ws-bar')).toHaveLength(1)
    // Closing on a blank name is indistinguishable from the button being
    // broken — which is exactly how the first version of this read.
    expect(wrapper.find('.ws-gdlg').exists()).toBe(true)
    expect(wrapper.find('.ws-gbtn.primary').attributes('disabled')).toBeDefined()
  })

  it('names the group and paints it in one dialog', async () => {
    wrapper = mountWith()
    await wrapper.find('.ws-bar-add').trigger('click')
    expect(wrapper.find('.ws-gdlg').exists()).toBe(true)
    // Six swatches, the first unused one preselected.
    const swatches = wrapper.findAll('.ws-gsw')
    expect(swatches).toHaveLength(6)
    expect(swatches[0].classes()).toContain('on')

    await wrapper.find('.ws-gdlg-in').setValue('客戶案')
    await swatches[3].trigger('click')
    expect(wrapper.findAll('.ws-gsw')[3].classes()).toContain('on')
    await wrapper.find('.ws-gbtn.primary').trigger('click')

    expect(railsOf()).toEqual([
      { id: expect.stringMatching(/^wr-\d+$/), name: '客戶案', members: [], color: 3 },
    ])
    expect(wrapper.find('.ws-gdlg').exists()).toBe(false)
  })

  it('offers the next unused colour to each new group', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, 'a')
    await wrapper.find('.ws-bar-add').trigger('click')
    expect(wrapper.findAll('.ws-gsw')[1].classes()).toContain('on')
  })

  it('Cancel closes without making anything', async () => {
    wrapper = mountWith()
    await wrapper.find('.ws-bar-add').trigger('click')
    await wrapper.find('.ws-gdlg-in').setValue('丟掉')
    await wrapper.find('.ws-gbtn').trigger('click') // the ghost one comes first
    expect(wrapper.find('.ws-gdlg').exists()).toBe(false)
    expect(railsOf()).toEqual([])
  })

  it('reopens on the existing name and colour when renaming', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶', 4)
    await wrapper.findAll('.ws-bar')[1].trigger('contextmenu')
    await wrapper.find('.ws-ctx-menu .ws-ctx-opt').trigger('click')
    expect((wrapper.find('.ws-gdlg-in').element as HTMLInputElement).value).toBe('客戶')
    expect(wrapper.findAll('.ws-gsw')[4].classes()).toContain('on')
  })

  it('repaints a group without touching its members', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶', 1)
    await dropOnCell(wrapper, 1, B)
    await wrapper.findAll('.ws-bar')[1].trigger('contextmenu')
    await wrapper.find('.ws-ctx-menu .ws-ctx-opt').trigger('click')
    await wrapper.findAll('.ws-gsw')[5].trigger('click')
    await wrapper.find('.ws-gbtn.primary').trigger('click')
    expect(railsOf()).toEqual([
      { id: expect.stringMatching(/^wr-\d+$/), name: '客戶', members: [B], color: 5 },
    ])
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

  it('renaming a group re-glyphs its flyout row', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await wrapper.findAll('.ws-rcell')[1].trigger('contextmenu')
    await wrapper.find('.ws-ctx-menu .ws-ctx-opt').trigger('click')
    const field = wrapper.find('.ws-gdlg-in')
    expect((field.element as HTMLInputElement).value).toBe('客戶')
    await field.setValue('內部')
    await field.trigger('keydown.enter')
    expect(wrapper.findAll('.ws-rcell')[1].find('.ws-rglyph').text()).toBe('內')
  })

  it('remounting keeps both the groups and the cell you were on', async () => {
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
    settingsSet(RAILS_KEY, '[]')
    sessionStorage.setItem(ACTIVE_KEY, 'wr-gone')
    wrapper = mountWith()
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('corrupt stored rails cost the grouping, never the list', () => {
    settingsSet(RAILS_KEY, 'not json at all')
    wrapper = mountWith()
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(1)
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  /* ── the 8px strip ─────────────────────────────────────────────────────
     The bars are what is on screen all the time; the flyout is the same list
     with room for words. The strip's whole justification is width, so these
     guard that it stays one column of bars and that the flyout never joins
     the layout. */

  it('draws one coloured bar per group, plus All and the ＋', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '產品')
    await makeRail(wrapper, '客戶')
    const bars = wrapper.findAll('.ws-bar')
    expect(bars).toHaveLength(4) // All + 2 groups + add
    expect(bars[0].classes()).toContain('all')
    expect(bars[3].classes()).toContain('ws-bar-add')
    // Distinct hues: on an 8px bar the colour is the only label.
    const hue = (i: number) => bars[i].attributes('style') ?? ''
    expect(hue(1)).not.toBe('')
    expect(hue(2)).not.toBe('')
    expect(hue(1)).not.toBe(hue(2))
  })

  it('marks the active bar, the current group and an empty one', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '產品')
    await dropOnCell(wrapper, 1, A) // A is props.workspace
    await makeRail(wrapper, '空組')
    expect(wrapper.findAll('.ws-bar')[2].classes()).toContain('on') // looking at 空組
    expect(wrapper.findAll('.ws-bar')[1].classes()).toContain('cur') // still working in 產品

    // Dimming is for a group you are NOT on: the one you are looking at stays
    // solid even when it holds nothing, or the strip would fade out under you.
    expect(wrapper.findAll('.ws-bar')[2].classes()).not.toContain('dim')
    await wrapper.findAll('.ws-bar')[0].trigger('click') // step onto All
    expect(wrapper.findAll('.ws-bar')[2].classes()).toContain('dim')
  })

  it('keeps the flyout out of the layout until the pointer reaches the edge', async () => {
    wrapper = mountWith()
    // Shut on the very first render, before anything has been clicked. This
    // assertion has to come BEFORE makeRail: finishing a group name closes the
    // flyout as a side effect, which would mask a flyout that opened by
    // default (it did — a mutation run caught exactly that).
    expect(flyoutHidden(wrapper)).toBe(true)

    await makeRail(wrapper, '客戶')
    // Rendered (so it can be tabbed to) but not shown.
    expect(wrapper.find('.ws-flyout').exists()).toBe(true)
    expect(flyoutHidden(wrapper)).toBe(true)

    await wrapper.find('.ws-strip').trigger('mouseenter')
    expect(flyoutHidden(wrapper)).toBe(false)

    await wrapper.find('.ws-strip').trigger('mouseleave')
    expect(flyoutHidden(wrapper)).toBe(true)
  })

  it('opens the flyout for a drag, so the drop targets are bigger than 8px', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await wrapper.find('.ws-strip').trigger('dragover', {
      dataTransfer: { types: ['application/x-workspace-path'], getData: () => B },
    })
    expect(flyoutHidden(wrapper)).toBe(false)
    // …and closes once the workspace lands somewhere.
    await dropOnCell(wrapper, 1, B)
    expect(flyoutHidden(wrapper)).toBe(true)
  })

  it('ignores a drag that is not a workspace heading', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await wrapper.find('.ws-strip').trigger('dragover', {
      dataTransfer: { types: ['text/plain'], getData: () => 'nope' },
    })
    expect(flyoutHidden(wrapper)).toBe(true)
  })

  it('keeps the flyout out while a group is being named', async () => {
    wrapper = mountWith()
    await wrapper.find('.ws-strip').trigger('mouseenter')
    await wrapper.find('.ws-bar-add').trigger('click')
    await wrapper.find('.ws-strip').trigger('mouseleave')
    // Closing it here would take the half-typed name with it.
    expect(wrapper.find('.ws-gdlg-in').exists()).toBe(true)
  })

  /* ── dragging a workspace into a group ─────────────────────────────────
     The strip is 8px. If the flyout only opened when the pointer hit it, the
     drop targets would be reachable only by first hitting a target the same
     size — which is the problem the flyout exists to solve. */

  it('lets a lone workspace be dragged once a group exists', async () => {
    // The drag floor was written for reorder and detach, which both need a
    // second workspace. Filing into a group does not — and while the old floor
    // stood, a window holding one project could never give the rail anything.
    wrapper = mountWith({ workspaces: [wsRow(A, 'Agent-Team')] })
    // The ATTRIBUTE, not el.draggable: Vue deliberately writes `draggable` as
    // an attribute rather than a DOM property (that property is a boolean, so
    // the string "false" would coerce to true), and happy-dom does not
    // implement the property at all. The attribute is what the browser reads.
    const draggable = () => wrapper.find('.ws-head').attributes('draggable')

    expect(draggable()).toBe('false') // no groups yet: nothing to drag it to
    await makeRail(wrapper, '客戶')
    await showAll(wrapper)
    expect(draggable()).toBe('true')
  })

  it('still refuses to detach the only workspace', async () => {
    wrapper = mountWith({ workspaces: [wsRow(A, 'Agent-Team')] })
    await makeRail(wrapper, '客戶')
    await showAll(wrapper)
    const head = wrapper.find('.ws-head')

    await head.trigger('dragstart', { dataTransfer: makeDataTransfer() })
    // Released far outside the window — the gesture that detaches.
    await head.trigger('dragend', { clientX: -50, clientY: -50, screenX: 0, screenY: 0 })
    // Draggable for filing, but pulling the last one out would empty the window.
    expect(wrapper.emitted('detach-workspace')).toBeUndefined()
  })

  it('files the lone workspace into a group end to end', async () => {
    wrapper = mountWith({ workspaces: [wsRow(A, 'Agent-Team')] })
    await makeRail(wrapper, '客戶')
    await showAll(wrapper)
    const dt = await startWsDrag(wrapper)
    await dragTo(wrapper, dt, 20)
    await wrapper.findAll('.ws-rcell')[1].trigger('drop', { dataTransfer: dt })
    expect(railsOf()[0].members).toEqual([A])
  })

  it('lights the bars up while a workspace is being dragged', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await showAll(wrapper)
    expect(wrapper.find('.ws-bars').classes()).not.toContain('hot')

    await startWsDrag(wrapper)
    expect(wrapper.find('.ws-bars').classes()).toContain('hot')

    await wrapper.findAll('.ws-head')[0].trigger('dragend')
    expect(wrapper.find('.ws-bars').classes()).not.toContain('hot')
  })

  it('opens the flyout when the drag comes near the left edge', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await showAll(wrapper)
    const dt = await startWsDrag(wrapper)
    expect(flyoutHidden(wrapper)).toBe(true)

    await dragTo(wrapper, dt, 20)
    expect(flyoutHidden(wrapper)).toBe(false)
  })

  it('leaves the flyout shut for a drag out in the list, where reordering happens', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await showAll(wrapper)
    const dt = await startWsDrag(wrapper)
    await dragTo(wrapper, dt, 160)
    // Opening here would cover the very rows a reorder has to land on.
    expect(flyoutHidden(wrapper)).toBe(true)
  })

  it('keeps the flyout open once the pointer is on it', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await showAll(wrapper)
    const dt = await startWsDrag(wrapper)
    await dragTo(wrapper, dt, 20)
    // The flyout it just opened is 178px wide; one threshold would close it
    // the moment the pointer moved onto the thing it opened.
    await dragTo(wrapper, dt, 150)
    expect(flyoutHidden(wrapper)).toBe(false)
    // Far enough away and it does close.
    await dragTo(wrapper, dt, 260)
    expect(flyoutHidden(wrapper)).toBe(true)
  })

  it('ignores pointer movement when no workspace is being dragged', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    const dt = makeDataTransfer()
    dt.setData('application/x-workspace-path', A)
    await dragTo(wrapper, dt, 10)
    // No dragstart happened — a stray dragover must not open it.
    expect(flyoutHidden(wrapper)).toBe(true)
  })

  it('files the workspace when it lands, end to end', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await showAll(wrapper)
    const dt = await startWsDrag(wrapper, 1) // the Navide-Server heading
    await dragTo(wrapper, dt, 20)
    await wrapper.findAll('.ws-rcell')[1].trigger('drop', { dataTransfer: dt })

    expect(railsOf()[0].members).toEqual([B])
    expect(flyoutHidden(wrapper)).toBe(true)
    expect(wrapper.find('.ws-bars').classes()).not.toContain('hot')
  })

  /* ── where each half lives ─────────────────────────────────────────────
     Groups belong to the projects and go to the shared store; the cell you
     are on belongs to this window and does not. Getting this backwards would
     either lose the groups on restart or make two windows fight over which
     one is showing. */

  it('writes the groups to the shared settings store, not to sessionStorage', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    await dropOnCell(wrapper, 1, B)
    expect(railsOf()).toEqual([
      { id: expect.stringMatching(/^wr-\d+$/), name: '客戶', members: [B], color: 0 },
    ])
    expect(sessionStorage.getItem(RAILS_KEY)).toBeNull()
  })

  it('keeps the chosen cell in sessionStorage, out of the shared store', async () => {
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    const railId = JSON.parse(stored())[0].id
    expect(sessionStorage.getItem(ACTIVE_KEY)).toBe(railId)
    expect(settingsGet(ACTIVE_KEY, null)).toBeNull()
  })

  it('restores groups written before this window existed', () => {
    // What a restart looks like: the settings cache is seeded from the host
    // snapshot before first paint, with no sessionStorage to help.
    settingsSet(RAILS_KEY, JSON.stringify([{ id: 'wr-1', name: '客戶', members: [B] }]))
    wrapper = mountWith()
    const cells = wrapper.findAll('.ws-rcell')
    expect(cells).toHaveLength(3)
    expect(cells[1].find('.ws-rglyph').text()).toBe('客')
    // …and starts on All, because a restart should not open onto a filtered
    // subset nobody remembers choosing.
    expect(cells[0].classes()).toContain('on')
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('follows a regroup made in another window', async () => {
    const mock = await withSettingsBackend()
    wrapper = mountWith()
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(1)

    broadcastRails(mock, JSON.stringify([{ id: 'wr-9', name: '外部', members: [A] }]))
    await wrapper.vm.$nextTick()

    const cells = wrapper.findAll('.ws-rcell')
    expect(cells).toHaveLength(3)
    expect(cells[1].find('.ws-rglyph').text()).toBe('外')
    expect(names(wrapper)).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('does not write back a group that arrived from another window', async () => {
    const mock = await withSettingsBackend()
    wrapper = mountWith()
    const incoming = JSON.stringify([{ id: 'wr-9', name: '外部', members: [A] }])

    broadcastRails(mock, incoming)
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 700)) // past the 500ms settings flush

    // Adopted locally…
    expect(stored()).toBe(incoming)
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(3)
    // …but never sent back out: echoing is how two windows ping-pong a list.
    expect(mock.sent.filter((m) => m.type === 'ui.settings.set')).toEqual([])
  })

  it('ignores settings changes that are not about the rails', async () => {
    const mock = await withSettingsBackend()
    wrapper = mountWith()
    await makeRail(wrapper, '客戶')
    const before = stored()

    mock.emit('ui.settings_changed', { settings: { 'agentTeam.somethingElse': 1 } })
    await wrapper.vm.$nextTick()

    expect(stored()).toBe(before)
    expect(wrapper.findAll('.ws-rcell')).toHaveLength(3)
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
