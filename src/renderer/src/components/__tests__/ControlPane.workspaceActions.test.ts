// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// Every workspace heading carries ↻ (rebuild this project's CLIs) and the
// history button. Both emitted no payload and App answered them from
// currentWorkspace, so whichever heading you clicked, they acted on the
// workspace on screen — and ↻'s enabled state came from there too. These pin
// each heading to its own workspace.

const A = '/Users/me/Desktop/alpha'
const B = '/Users/me/Desktop/beta'

const wsRow = (path: string, label: string) => ({
  path,
  label,
  displayPath: '~/Desktop',
  isCurrent: true,
  collapsed: false,
  count: 1, paneIds: [],
  lineage: [],
  groups: [{ id: '', name: '', rows: [] }],
  remote: [],
})

const panes = [
  { id: 'a1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: A },
  { id: 'b1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: B },
]

function mountWith(extra: Record<string, unknown> = {}): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: { send: vi.fn().mockResolvedValue({ payload: { deps: [] } }) },
      agentSpecs: [{ agentKey: 'claude', label: 'Claude Code' }],
      roles: [],
      stages: [],
      panes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false,
      workspace: A,
      existingProject: null,
      workspaces: [wsRow(A, 'alpha'), wsRow(B, 'beta')],
      ...extra,
    } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
}

/** [rebuild, history] for the nth workspace heading. */
const actsOf = (wrapper: VueWrapper, n: number) =>
  wrapper.findAll('.ws-head')[n].findAll('.ws-act')

describe('ControlPane – the buttons on a workspace heading', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('rebuilds the workspace whose heading was clicked, not the one on screen', async () => {
    wrapper = mountWith({ rebuildableByWorkspace: { [A]: 1, [B]: 1 } })
    await actsOf(wrapper, 1)[0].trigger('click')
    expect(wrapper.emitted('rebuild-all')).toEqual([[B]])
  })

  it('opens the history of the workspace whose heading was clicked', async () => {
    wrapper = mountWith({ rebuildableByWorkspace: { [A]: 1, [B]: 1 } })
    await actsOf(wrapper, 1)[1].trigger('click')
    expect(wrapper.emitted('open-history')).toEqual([[B]])
  })

  it('names the viewed workspace too, rather than leaving it to a fallback', async () => {
    wrapper = mountWith({ rebuildableByWorkspace: { [A]: 1 } })
    await actsOf(wrapper, 0)[0].trigger('click')
    await actsOf(wrapper, 0)[1].trigger('click')
    expect(wrapper.emitted('rebuild-all')).toEqual([[A]])
    expect(wrapper.emitted('open-history')).toEqual([[A]])
  })

  it('enables ↻ per workspace, so an empty project does not offer it', () => {
    // One window-wide flag meant a project with nothing to rebuild showed the
    // button live, and one with panes to rebuild showed it dead.
    wrapper = mountWith({ rebuildableByWorkspace: { [B]: 2 } })
    expect(actsOf(wrapper, 0)[0].attributes('disabled')).toBeDefined()
    expect(actsOf(wrapper, 1)[0].attributes('disabled')).toBeUndefined()
  })

  it('treats a heading path with a trailing slash as the same workspace', () => {
    wrapper = mountWith({
      workspaces: [wsRow(`${A}/`, 'alpha')],
      rebuildableByWorkspace: { [A]: 1 },
    })
    expect(actsOf(wrapper, 0)[0].attributes('disabled')).toBeUndefined()
  })

  it('disables ↻ everywhere while a rebuild batch is running', () => {
    wrapper = mountWith({ rebuildableByWorkspace: { [A]: 1, [B]: 1 }, rebuildingAll: true })
    expect(actsOf(wrapper, 0)[0].attributes('disabled')).toBeDefined()
    expect(actsOf(wrapper, 1)[0].attributes('disabled')).toBeDefined()
  })
})
