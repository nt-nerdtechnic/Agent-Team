// @vitest-environment happy-dom
// GitWindowApp (the navide.git standalone window) — wiring tests for the
// "Editorial Calm" design: the checkbox-IS-the-stage-state file card, the
// commit composer, conflict quick-resolution, the sidebar "⋯" popover menus
// (branches / stashes / worktrees / remotes), and the diff detail. The backend
// is mocked at the useBackend seam (exactly what the plugin build aliases), so
// every assertion is on the real useGit → send() wire format.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { extractDropPaths, shellEscape } from '../../lib/drop'
import { aiTerminalPaneId } from '../../lib/aiCliContext'
import { i18n } from '../../i18n'

// The CLI dock's terminal host pulls in useTerminal/xterm — stub it with the
// imperative surface the dock drives (reattach/fit are called on first open).
vi.mock('../AiCliTerminal.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'AiCliTerminal',
    props: ['paneId', 'backend', 'workspacePath'],
    inheritAttrs: false,
    setup(_, { expose }) {
      expose({
        spawn: vi.fn(async () => undefined),
        tryReattach: vi.fn(async () => undefined),
        pasteText: vi.fn(),
        interrupt: vi.fn(async () => undefined),
        kill: vi.fn(async () => undefined),
        cancelPendingCreate: vi.fn(async () => undefined),
        fitTerminal: vi.fn(),
        focus: vi.fn(),
        status: ref('idle'),
        displayStatus: ref('idle'),
        lastRawActivityAt: ref(0),
        sessionId: ref(''),
        error: ref('')
      })
      return () => h('div', { class: 'stub-AiCliTerminal' })
    }
  })
}))

interface SentCall {
  type: string
  payload: Record<string, unknown>
}

const sends = vi.hoisted(() => ({ calls: [] as { type: string; payload: Record<string, unknown> }[] }))

// Per-test override for the git.status payload.
const statusOverride = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }))

function baseStatus(): Record<string, unknown> {
  return {
    is_git_repo: true,
    branch: 'main',
    remote_branch: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: [{ path: 'src/staged.ts', status: 'M' }],
    unstaged: [{ path: 'src/a.ts', status: 'M' }],
    untracked: [{ path: 'src/new.ts', status: '?' }],
    ignored: [],
    operation_in_progress: ''
  }
}

vi.mock('../../composables/useBackend', () => {
  function payloadFor(type: string): unknown {
    if (type === 'git.status') return statusOverride.value ?? baseStatus()
    if (type === 'git.branches')
      return {
        ok: true,
        branches: [
          { name: 'main', is_current: true, is_remote: false, tracking: 'origin/main' },
          { name: 'feature-x', is_current: false, is_remote: false, tracking: '' },
          { name: 'origin/feature-y', is_current: false, is_remote: true, tracking: '' }
        ]
      }
    if (type === 'git.log') return { ok: true, commits: [] }
    if (type === 'git.stash_list')
      return { ok: true, stashes: [{ index: 0, ref: 'stash@{0}', message: 'wip sidebar' }] }
    if (type === 'git.remotes')
      return { ok: true, remotes: [{ name: 'origin', fetch_url: 'https://example.com/r.git', push_url: 'https://example.com/r.git' }] }
    if (type === 'git.tags') return { ok: true, tags: [] }
    if (type === 'git.worktrees')
      return {
        ok: true,
        worktrees: [
          {
            path: '/tmp/ws', head: 'abc1234', branch: 'main', is_main: true,
            detached: false, bare: false, locked: false, lock_reason: '',
            prunable: false, prune_reason: ''
          },
          {
            path: '/tmp/wt-feature', head: 'def5678', branch: 'feature-x', is_main: false,
            detached: false, bare: false, locked: false, lock_reason: '',
            prunable: false, prune_reason: ''
          }
        ]
      }
    if (type === 'ui.pick_folder') return { ok: true, path: '/tmp/picked' }
    if (type === 'issues.provider')
      return { ok: true, provider: 'github', cli_available: true, authenticated: true }
    if (type === 'issues.list')
      return {
        ok: true,
        provider: 'github',
        issues: [
          {
            number: 7, title: 'Sidebar parity', state: 'open', author: 'neillu',
            labels: [], assignees: [], updated_at: '', url: 'https://example.com/issues/7'
          }
        ]
      }
    if (type === 'git.config_get')
      return { ok: true, config: { 'user.name': 'neillu' }, allowed_keys: ['user.name', 'user.email'] }
    if (type === 'ui.settings.get') return { ok: true, settings: {} }
    return { ok: true }
  }
  return {
    useBackend: () => ({
      status: ref('connected'),
      wsUrl: ref(''),
      httpUrl: ref(''),
      shell: ref(''),
      port: ref(0),
      pid: ref(0),
      lastError: ref(''),
      send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
        sends.calls.push({ type, payload })
        return {
          id: 'r',
          type,
          ok: true,
          payload: payloadFor(type),
          error: null,
          timestamp: new Date().toISOString()
        }
      }),
      on: vi.fn(() => () => {}),
      restart: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    })
  }
})

import GitWindowApp from '../../GitWindowApp.vue'

const STUBS = {
  GitHistoryModal: true,
  GitCredentialModal: true,
  NotificationHost: true,
  DiffPane: true,
  BranchDiffPane: true
}

function callsOf(type: string): SentCall[] {
  return sends.calls.filter((c) => c.type === type)
}

type DragStub = Event & {
  dataTransfer: { setData: ReturnType<typeof vi.fn>; effectAllowed: string }
}

function rowFor(w: VueWrapper, file: string): DOMWrapper<Element> {
  const row = w.findAll('.frow').find((r) => r.text().includes(file))
  expect(row, file).toBeDefined()
  return row!
}

function dispatchDragStart(row: DOMWrapper<Element>): DragStub {
  const ev = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.assign(ev, {
    dataTransfer: { types: [], getData: () => '', setData: vi.fn(), effectAllowed: '' }
  })
  row.element.dispatchEvent(ev)
  return ev as DragStub
}

function textPlainPayload(ev: DragStub): string | undefined {
  const call = ev.dataTransfer.setData.mock.calls.find(([type]) => type === 'text/plain')
  return call?.[1] as string | undefined
}

async function mountApp(): Promise<VueWrapper> {
  window.history.replaceState({}, '', '/?workspace_path=%2Ftmp%2Fws')
  const wrapper = mount(GitWindowApp, { global: { stubs: STUBS, plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

describe('GitWindowApp — Editorial Calm wiring', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    sends.calls.length = 0
    statusOverride.value = null
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('loads the repo surface on mount (status, log, branches, worktrees)', async () => {
    wrapper = await mountApp()
    for (const t of [
      'git.status',
      'git.log',
      'git.branches',
      'git.remotes',
      'git.tags',
      'git.stash_list',
      'git.worktrees'
    ]) {
      expect(callsOf(t).length, t).toBeGreaterThan(0)
    }
    expect(callsOf('git.status')[0]!.payload.workspace_path).toBe('/tmp/ws')
  })

  it('stages via the checkbox and unstages via the checked checkbox', async () => {
    wrapper = await mountApp()
    const rows = wrapper.findAll('.frow')
    const unstagedRow = rows.find((r) => r.text().includes('a.ts'))
    await unstagedRow!.find('button.chk:not(.on)').trigger('click')
    await flushPromises()
    expect(callsOf('git.stage')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      files: ['src/a.ts']
    })

    const stagedRow = wrapper.findAll('.frow').find((r) => r.text().includes('staged.ts'))
    await stagedRow!.find('button.chk.on').trigger('click')
    await flushPromises()
    expect(callsOf('git.unstage')[0]!.payload).toMatchObject({ files: ['src/staged.ts'] })
  })

  it('stages all and unstages all from the list header links', async () => {
    wrapper = await mountApp()
    const stageAll = wrapper.findAll('.hdr-actions .linkbtn').find((b) => b.text() === 'Stage all')
    await stageAll!.trigger('click')
    await flushPromises()
    expect(callsOf('git.stage_all').length).toBe(1)

    const unstageAll = wrapper.findAll('.hdr-actions .linkbtn').find((b) => b.text() === 'Unstage all')
    await unstageAll!.trigger('click')
    await flushPromises()
    expect(callsOf('git.unstage')[0]!.payload).toMatchObject({ files: ['src/staged.ts'] })
  })

  it('commits the staged files with the composed message', async () => {
    wrapper = await mountApp()
    await wrapper.find('textarea.cmp-input').setValue('feat: editorial calm')
    const btn = wrapper.find('button.commitbtn')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()
    expect(callsOf('git.commit')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      message: 'feat: editorial calm'
    })
  })

  it('disables commit when nothing is staged and no operation is in progress', async () => {
    statusOverride.value = { ...baseStatus(), staged: [] }
    wrapper = await mountApp()
    await wrapper.find('textarea.cmp-input').setValue('msg')
    expect(wrapper.find('button.commitbtn').attributes('disabled')).toBeDefined()
  })

  it('shows the operation banner and conflict quick-resolution during a merge', async () => {
    statusOverride.value = {
      ...baseStatus(),
      operation_in_progress: 'merge',
      unstaged: [{ path: 'src/conflict.ts', status: 'U' }]
    }
    wrapper = await mountApp()
    expect(wrapper.find('.op-banner').text()).toContain('merge in progress')
    const conflictRow = wrapper.find('.frow.conflict')
    expect(conflictRow.exists()).toBe(true)
    const ours = conflictRow.findAll('button.linkbtn').find((b) => b.text() === 'ours')
    await ours!.trigger('click')
    await flushPromises()
    expect(callsOf('git.resolve_ours')[0]!.payload).toMatchObject({ filepath: 'src/conflict.ts' })
  })

  it('makes every file row draggable with its absolute path as text/plain', async () => {
    wrapper = await mountApp()
    for (const [file, expected] of [
      ['staged.ts', '/tmp/ws/src/staged.ts'],
      ['a.ts', '/tmp/ws/src/a.ts'],
      ['new.ts', '/tmp/ws/src/new.ts']
    ] as const) {
      const row = rowFor(wrapper, file)
      expect(row.attributes('draggable'), file).toBe('true')
      const ev = dispatchDragStart(row)
      expect(textPlainPayload(ev), file).toBe(expected)
      expect(ev.dataTransfer.effectAllowed, file).toBe('copy')
    }
  })

  it('makes conflict rows draggable too', async () => {
    statusOverride.value = {
      ...baseStatus(),
      operation_in_progress: 'merge',
      unstaged: [{ path: 'src/conflict.ts', status: 'U' }]
    }
    wrapper = await mountApp()
    const row = wrapper.find('.frow.conflict')
    expect(row.attributes('draggable')).toBe('true')
    expect(textPlainPayload(dispatchDragStart(row))).toBe('/tmp/ws/src/conflict.ts')
  })

  it('normalizes a trailing slash in the workspace path and tolerates a missing dataTransfer', async () => {
    window.history.replaceState({}, '', '/?workspace_path=%2Ftmp%2Fws%2F')
    wrapper = mount(GitWindowApp, { global: { stubs: STUBS, plugins: [i18n] } })
    await flushPromises()
    expect(textPlainPayload(dispatchDragStart(rowFor(wrapper, 'a.ts')))).toBe('/tmp/ws/src/a.ts')

    const bare = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.assign(bare, { dataTransfer: null })
    expect(() => rowFor(wrapper!, 'a.ts').element.dispatchEvent(bare)).not.toThrow()
  })

  it('emits a payload the terminal drop handler turns into a shell-escaped path', async () => {
    // The contract with the main window: GitWindowApp only sets text/plain, and
    // TerminalPane runs extractDropPaths → shellEscape → pasteText on it.
    wrapper = await mountApp()
    const payload = textPlainPayload(dispatchDragStart(rowFor(wrapper, 'a.ts')))

    const original = window.agentTeam
    window.agentTeam = { getPathForFile: () => '' } as unknown as typeof window.agentTeam
    try {
      const drop = {
        dataTransfer: {
          items: [],
          files: [],
          getData: (type: string) => (type === 'text/plain' ? payload : '')
        }
      } as unknown as DragEvent
      const paths = extractDropPaths(drop)
      expect(paths).toEqual(['/tmp/ws/src/a.ts'])
      expect(paths.map(shellEscape).join(' ')).toBe("'/tmp/ws/src/a.ts'")
    } finally {
      window.agentTeam = original
    }
  })

  it('shows a clicked file diff in the bottom DiffPane detail', async () => {
    wrapper = await mountApp()
    const row = wrapper.findAll('.frow').find((r) => r.text().includes('a.ts'))
    await row!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.detail').exists()).toBe(true)
    const diff = wrapper.findComponent({ name: 'DiffPane' })
    expect(diff.attributes('filepath')).toBe('src/a.ts')
  })

  it('hosts the shared AI CLI dock with this window\'s width key, pane id and context', async () => {
    wrapper = await mountApp()
    // The shared shell (AiCliDock) owns the rail/resize/eager-mount and the
    // CLI state machine — covered in depth by AiCliDock.test.ts. Here: it is
    // wired to this window's workspace, width key and per-workspace derived
    // pane id, and the terminal mounts eagerly (PTY ownership claim) while
    // the panel starts closed.
    const dock = wrapper.findComponent({ name: 'AiCliDock' })
    expect(dock.exists()).toBe(true)
    expect(dock.props('widthKey')).toBe('git-ai-panel-width')
    expect(dock.props('workspacePath')).toBe('/tmp/ws')
    expect(dock.props('paneId')).toBe(aiTerminalPaneId('git', '/tmp/ws'))
    expect(dock.props('origin')).toBe('git-window')
    expect(typeof dock.props('buildContext')).toBe('function')
    // The injected context reflects this window's git status snapshot.
    const context = (dock.props('buildContext') as () => string)()
    expect(context).toContain('Workspace: /tmp/ws')
    expect(context).toContain('Current branch: main')
    expect(context).toContain('src/staged.ts')
    const term = wrapper.findComponent({ name: 'AiCliTerminal' })
    expect(term.exists()).toBe(true)
    expect(term.props('workspacePath')).toBe('/tmp/ws')
    expect(term.props('paneId')).toBe(aiTerminalPaneId('git', '/tmp/ws'))
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).toBe('none')

    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await flushPromises()
    expect(panelEl.style.display).not.toBe('none')
  })

  it('switches branch only via the explicit ↵ button, never on row click', async () => {
    wrapper = await mountApp()
    const rows = wrapper.findAll('.branch-row')
    const feature = rows.find((r) => r.text().includes('feature-x'))
    await feature!.trigger('click')
    await flushPromises()
    expect(callsOf('git.switch_branch').length).toBe(0)

    await feature!.find('button[title="Switch"]').trigger('click')
    await flushPromises()
    expect(callsOf('git.switch_branch')[0]!.payload).toMatchObject({ name: 'feature-x' })

    // The current branch row offers no action buttons at all.
    const current = rows.find((r) => r.classes().includes('current'))
    expect(current!.find('button[title="Switch"]').exists()).toBe(false)
  })

  it('deletes a branch from its right-click context menu (GitPane style)', async () => {
    wrapper = await mountApp()
    const feature = wrapper.findAll('.branch-row').find((r) => r.text().includes('feature-x'))
    await feature!.trigger('contextmenu')
    const del = wrapper.findAll('.menu-item').find((m) => m.text().startsWith('Delete branch'))
    expect(del).toBeTruthy()
  })

  it('drives stash actions from the Stashes card buttons', async () => {
    wrapper = await mountApp()
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Stashes'))
    await hdr!.trigger('click')
    await flushPromises()
    const row = wrapper.findAll('.generic-row').find((r) => r.text().includes('wip sidebar'))
    await row!.find('button[title="Pop (apply & remove)"]').trigger('click')
    await flushPromises()
    expect(callsOf('git.stash_pop').length).toBe(1)
  })

  it('drives worktree lock and reveal from the Worktrees card buttons', async () => {
    wrapper = await mountApp()
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Worktrees'))
    await hdr!.trigger('click')
    await flushPromises()
    const row = wrapper.findAll('.generic-row').find((r) => r.text().includes('wt-feature'))
    await row!.find('button[title="Lock"]').trigger('click')
    await flushPromises()
    expect(callsOf('git.lock_worktree')[0]!.payload).toMatchObject({ worktree_path: '/tmp/wt-feature' })
    await row!.find('button[title="Reveal in Finder"]').trigger('click')
    await flushPromises()
    expect(callsOf('ui.reveal_path')[0]!.payload).toMatchObject({ path: '/tmp/wt-feature' })
  })

  it('opens the remote URL through the ui.open_external host capability', async () => {
    wrapper = await mountApp()
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Remotes'))
    await hdr!.trigger('click')
    await flushPromises()
    await wrapper.find('button[title="Open remote URL"]').trigger('click')
    await flushPromises()
    expect(callsOf('ui.open_external')[0]!.payload).toMatchObject({ url: 'https://example.com/r.git' })
  })

  it('lazy-loads the Issues card on expand and lists issues (GitPane parity)', async () => {
    wrapper = await mountApp()
    expect(callsOf('issues.provider').length).toBe(0)
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Issues'))
    await hdr!.trigger('click')
    await flushPromises()
    expect(callsOf('issues.provider').length).toBe(1)
    expect(callsOf('issues.list').length).toBe(1)
    const row = wrapper.findAll('.generic-row').find((r) => r.text().includes('#7'))
    expect(row).toBeTruthy()
  })

  it('loads git config on Config card expand and edits a key inline', async () => {
    wrapper = await mountApp()
    // useGit auto-loads config once at mount; expanding the card reloads it.
    const before = callsOf('git.config_get').length
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Config'))
    await hdr!.trigger('click')
    await flushPromises()
    expect(callsOf('git.config_get').length).toBe(before + 1)
    const row = wrapper.findAll('.config-row').find((r) => r.text().includes('user.name'))
    await row!.find('.config-val').trigger('click')
    await row!.find('input.config-inline-input').setValue('newname')
    const save = row!.findAll('button').find((b) => b.text() === '✓')
    await save!.trigger('click')
    await flushPromises()
    expect(callsOf('git.config_set')[0]!.payload).toMatchObject({ key: 'user.name', value: 'newname' })
  })

  it('opens the branch-diff view with a sensible base/compare preselection', async () => {
    wrapper = await mountApp()
    const btn = wrapper.findAll('.navi button').find((b) => b.text() === 'Branch diff')
    await btn!.trigger('click')
    await flushPromises()
    const selects = wrapper.findAll('select.ed-select')
    expect(selects.length).toBe(2)
    expect((selects[0]!.element as HTMLSelectElement).value).toBe('main')
  })
})
