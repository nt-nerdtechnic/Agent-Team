// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
import { paneStatusLabelText } from '../../lib/paneStatusLabel'

// The sidebar's tally pills — a workspace heading's total, a run group's rows —
// used to be neutral grey whatever the panes under them were doing. The pane
// rows answer "is anything wrong here?" with a coloured dot, but a folded
// section hides exactly those rows, so the heading was the one thing left on
// screen and it said nothing. These cover the status the pill now carries.

const specs = [{ agentKey: 'claude', label: 'Claude Code' }]

const pane = (id: string, status: string) => ({
  id,
  agentLabel: id,
  status,
  command: 'c',
  origin: 'manual',
  isMinimized: false,
  isCommander: false,
})

const lineageRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  depth: 0,
  hasChildren: false,
  collapsed: false,
  ...over,
})

const row = (over: Record<string, unknown> = {}) => ({
  path: '/Users/me/Desktop/Agent-Team',
  label: 'Agent-Team',
  displayPath: '~/Desktop',
  isCurrent: true,
  collapsed: false,
  count: 2,
  paneIds: ['p1', 'p2'],
  lineage: [],
  groups: [{ id: '', name: '', rows: [lineageRow('p1'), lineageRow('p2')] }],
  ...over,
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
      roles: [],
      stages: [],
      panes: [pane('p1', 'running'), pane('p2', 'idle')],
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: {
        available: false,
        version: '',
        defaultModel: '',
        models: [],
        benchmarkResults: [],
      },
      autoAnswerEnabled: false,
      workspace: '/Users/me/Desktop/Agent-Team',
      existingProject: null,
      workspaces: [row()],
      ...extra,
    } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
}

/** The workspace heading's pill; the group headings' pills come after it. */
const wsPill = (w: VueWrapper) => w.findAll('.ws-count')[0]

describe('ControlPane – the heading count pill carries a status', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('paints the workspace tally with the loudest status under it', () => {
    wrapper = mountWith({ panes: [pane('p1', 'running'), pane('p2', 'error')] })
    expect(wsPill(wrapper).text()).toBe('2')
    expect(wsPill(wrapper).attributes('data-state')).toBe('error')
  })

  it('prefers a pane waiting on the user to panes that are still moving', () => {
    wrapper = mountWith({ panes: [pane('p1', 'running'), pane('p2', 'awaiting')] })
    expect(wsPill(wrapper).attributes('data-state')).toBe('awaiting')
  })

  it('spells the colour out in the tooltip', () => {
    // A tint with no words is a legend nobody has — the mistake the group dot
    // shipped with.
    wrapper = mountWith({ panes: [pane('p1', 'running'), pane('p2', 'idle')] })
    // Resolved through the shared label function, so a rename in Settings
    // moves the tooltip with every other surface's wording.
    expect(wsPill(wrapper).attributes('title')).toBe(paneStatusLabelText('running'))
    expect(wsPill(wrapper).attributes('title')).toBeTruthy()
  })

  it('still counts, and now colours, a pane a folded subtree is hiding', () => {
    // `count` is taken from paneIds precisely so folding does not shrink it;
    // the colour is rolled up from the same set so the two cannot disagree.
    wrapper = mountWith({
      panes: [pane('p1', 'idle'), pane('kid', 'error')],
      workspaces: [
        row({
          count: 2,
          paneIds: ['p1', 'kid'],
          groups: [
            { id: '', name: '', rows: [lineageRow('p1', { hasChildren: true, collapsed: true })] },
          ],
        }),
      ],
    })
    expect(wsPill(wrapper).text()).toBe('2')
    expect(wsPill(wrapper).attributes('data-state')).toBe('error')
    // Still folded: this is about the heading, not about unfolding.
    expect(wrapper.findAll('.agent-item')).toHaveLength(1)
  })

  it('leaves an empty workspace tally neutral rather than inventing a status', () => {
    wrapper = mountWith({
      panes: [],
      workspaces: [row({ count: 0, paneIds: [], groups: [{ id: '', name: '', rows: [] }] })],
    })
    expect(wsPill(wrapper).attributes('data-state')).toBeUndefined()
    expect(wsPill(wrapper).attributes('title')).toBeUndefined()
  })

  it('leaves the run-group tally neutral — that row has its own state key', () => {
    // Two colour scales on one row (a three-state key, a nine-state status)
    // read as two signals disagreeing. The workspace heading is the one with
    // nothing else to say it.
    wrapper = mountWith({
      panes: [pane('p1', 'idle'), pane('p2', 'error')],
      workspaces: [
        row({
          groups: [
            { id: 'g1', name: 'Run 1', rows: [lineageRow('p1')] },
            { id: 'g2', name: 'Run 2', rows: [lineageRow('p2')] },
          ],
        }),
      ],
    })
    const pills = wrapper.findAll('.ws-count')
    // [0] is the workspace heading; the group headings follow in order.
    expect(pills[0].attributes('data-state')).toBe('error')
    expect(pills[1].attributes('data-state')).toBeUndefined()
    expect(pills[2].attributes('data-state')).toBeUndefined()
    // The group's own run-state key is untouched and still there.
    expect(wrapper.findAll('.ws-grp-key')).toHaveLength(2)
  })

  it('puts a question ahead of an error, because only one of them is blocking', () => {
    wrapper = mountWith({ panes: [pane('p1', 'error'), pane('p2', 'awaiting')] })
    expect(wsPill(wrapper).attributes('data-state')).toBe('awaiting')
  })
})
