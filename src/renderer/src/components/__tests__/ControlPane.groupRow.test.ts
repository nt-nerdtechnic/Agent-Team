// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// The run-group row used to be a read-only micro-heading: a dot, a name, a
// count, and nothing else — no container, no actions, and nothing anywhere
// saying what the dot meant. These cover what it gained: a sticky tinted
// header, a neutral rail down its members, and one action of its own.

const specs = [
  { agentKey: 'claude', label: 'Claude Code' },
  { agentKey: 'codex', label: 'Codex' },
  { agentKey: 'terminal', label: 'Terminal' }
]

const panes = [
  { id: 'p1', agentLabel: 'Antigravity 發布流程', status: 'running', command: 'c', origin: 'manual', isMinimized: false, isCommander: false },
  { id: 'p2', agentLabel: 'Navide MCP', status: 'idle', command: 'c', origin: 'manual', isMinimized: false, isCommander: false },
  { id: 'p3', agentLabel: 'Synara', status: 'idle', command: 'c', origin: 'manual', isMinimized: false, isCommander: false }
]

const row = (over: Record<string, unknown> = {}) => ({
  path: '/Users/me/Desktop/Agent-Team',
  label: 'Agent-Team',
  displayPath: '~/Desktop/Agent-Team',
  isCurrent: true,
  collapsed: false,
  count: 3,
  lineage: [],
  remote: [],
  ...over
})

/** Two real groups: two panes in the first, one in the second. */
const grouped = () => row({
  groups: [
    { id: 'g1', name: 'Run 1', rows: [
      { id: 'p1', depth: 0, hasChildren: false, collapsed: false },
      { id: 'p2', depth: 0, hasChildren: false, collapsed: false }
    ] },
    { id: 'g2', name: '需求整理', rows: [
      { id: 'p3', depth: 0, hasChildren: false, collapsed: false }
    ] }
  ]
})

/** A workspace nobody has grouped: one bare section, no heading. */
const ungrouped = () => row({
  count: 1,
  groups: [{ id: '', name: '', rows: [{ id: 'p1', depth: 0, hasChildren: false, collapsed: false }] }]
})

function mountWith(extra: Record<string, unknown> = {}): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: { send: vi.fn().mockResolvedValue({ payload: { deps: [] } }) },
      agentSpecs: specs,
      roles: [{ key: 'reviewer', label: 'Reviewer' }],
      stages: [],
      panes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false,
      // canSpawn needs a workspace; without one the ＋ is not rendered.
      workspace: '/Users/me/Desktop/Agent-Team',
      existingProject: null,
      workspaces: [grouped()],
      ...extra
    } as never,
    global: { mocks: { $t: (key: string) => key } }
  })
}

describe('ControlPane – the run-group row', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('says what the group dot means, per state', () => {
    wrapper = mountWith()
    const keys = wrapper.findAll('.ws-grp-key')
    // The dot was the one thing on the row with no words attached to it.
    expect(keys[0].attributes('title')).toBe('label.run-group-active')
    expect(keys[1].attributes('title')).toBe('label.run-group-idle')
  })

  it('marks every member of a group, and only the last one as last', () => {
    wrapper = mountWith()
    const items = wrapper.findAll('.agent-item')
    expect(items.map((i) => i.classes().includes('in-group'))).toEqual([true, true, true])
    // The rail bridges the list gap between rows and stops at the group's own
    // end, so exactly one row per group carries the terminator.
    expect(items.map((i) => i.classes().includes('in-group-last'))).toEqual([false, true, true])
  })

  it('leaves the rows of an ungrouped workspace without a rail', () => {
    // A workspace nobody has grouped must look exactly as it did before: no
    // heading, and therefore nothing for a rail to run beside.
    wrapper = mountWith({ workspaces: [ungrouped()], panes: [panes[0]] })
    expect(wrapper.findAll('.ws-grp')).toHaveLength(0)
    expect(wrapper.find('.agent-item').classes()).not.toContain('in-group')
  })

  it('offers ＋ on a real group but never on a bare section', () => {
    wrapper = mountWith()
    expect(wrapper.findAll('.ws-grp-add')).toHaveLength(2)
    wrapper.unmount()
    wrapper = mountWith({ workspaces: [ungrouped()], panes: [panes[0]] })
    expect(wrapper.findAll('.ws-grp-add')).toHaveLength(0)
  })

  it('opens an agent in the group whose ＋ was clicked', async () => {
    wrapper = mountWith()
    // Second group, so a pass-through of "the active tab" could not produce it.
    await wrapper.findAll('.ws-grp-add')[1].trigger('click')
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[1].trigger('click')
    const payload = wrapper.emitted('spawn')?.[0]?.[0] as Record<string, unknown>
    expect(payload.agentKey).toBe('codex')
    expect(payload.runGroupId).toBe('g2')
    expect(payload.workspacePath).toBe('/Users/me/Desktop/Agent-Team')
  })

  it('carries the group through the Terminal entry too', async () => {
    wrapper = mountWith()
    await wrapper.findAll('.ws-grp-add')[0].trigger('click')
    await wrapper.find('.ws-add-term').trigger('click')
    const payload = wrapper.emitted('spawn')?.[0]?.[0] as Record<string, unknown>
    expect(payload.agentKey).toBe('terminal')
    expect(payload.runGroupId).toBe('g1')
  })

  it('does not name a group when the workspace heading opened the menu', async () => {
    // The heading's ＋ has no group to point at; the pane must land wherever
    // the active tab says, which is App.vue's call, not the sidebar's.
    wrapper = mountWith()
    await wrapper.find('.ws-add').trigger('click')
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[1].trigger('click')
    const payload = wrapper.emitted('spawn')?.[0]?.[0] as Record<string, unknown>
    expect(payload.runGroupId).toBeUndefined()
  })

  it('forgets the group once the menu is closed and reopened elsewhere', async () => {
    // The override is one-shot, like the workspace override beside it.
    wrapper = mountWith()
    await wrapper.findAll('.ws-grp-add')[1].trigger('click')
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[0].trigger('click')
    await wrapper.find('.ws-add').trigger('click')
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[0].trigger('click')
    const second = wrapper.emitted('spawn')?.[1]?.[0] as Record<string, unknown>
    expect(second.runGroupId).toBeUndefined()
  })

  it('puts the full pane name in its tooltip', () => {
    // The name truncates in a narrow sidebar, and the tooltip used to say only
    // "rename" — so a cut-off name could not be read at all.
    wrapper = mountWith()
    const title = wrapper.findAll('.badge')[0].attributes('title') ?? ''
    expect(title.startsWith('Antigravity 發布流程')).toBe(true)
    expect(title).toContain('action.rename')
  })
})

describe('ControlPane – the styling contract of the group row', () => {
  const css = readFileSync(resolve(__dirname, '../ControlPane.vue'), 'utf8')

  it('sticks the group heading clear of the section header', () => {
    // .agent-list-hdr sticks at 0 in the same scroller; a group heading at 0
    // would sit under it.
    expect(css).toMatch(/\.ws-grp\s*\{[^}]*position:\s*sticky/)
    expect(css).toMatch(/\.ws-grp\s*\{[^}]*top:\s*29px/)
  })

  it('paints the sticky heading over an opaque background', () => {
    // A translucent tint alone would let the rows scroll through it.
    expect(css).toMatch(/\.ws-grp\s*\{[^}]*background:\s*linear-gradient\(var\(--bg-subtle\), var\(--bg-subtle\)\), var\(--bg-base\)/)
  })

  it('keeps the group heading inside the sidebar width', () => {
    // No global border-box reset exists, and .sidebar clips its overflow.
    expect(css).toMatch(/\.ws-grp\s*\{[^}]*box-sizing:\s*border-box/)
  })

  it('spends exactly 2px of indentation on the rail', () => {
    expect(css).toMatch(/\.ws-head ~ \.agent-item \{ padding-left: 22px; \}/)
    expect(css).toMatch(/\.ws-head ~ \.agent-item\.in-group \{[^}]*padding-left:\s*24px/)
  })

  it('keeps the rail neutral rather than status-coloured', () => {
    // Two different groups can both be running, so a status colour here could
    // not answer "which group am I in" — that is the sticky heading's job.
    const rail = css.match(/\.ws-head ~ \.agent-item\.in-group::before \{[^}]*\}/)?.[0] ?? ''
    expect(rail).toContain('background: var(--border-default)')
    expect(rail).not.toContain('--success-fg')
    expect(rail).not.toContain('--attention-emphasis')
  })

  it('lets the subtitle yield before the pane name does', () => {
    expect(css).toMatch(/\.agent-line-sub \{[^}]*flex-shrink:\s*4/)
  })
})
