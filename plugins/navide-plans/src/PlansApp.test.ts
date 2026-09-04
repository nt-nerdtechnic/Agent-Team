// @vitest-environment happy-dom
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { bindPlansLocale, bootstrapPlansI18n } from './plansI18n'

const state = vi.hoisted(() => ({
  preferences: {} as Record<string, unknown>,
  sets: [] as Array<{ key: string; value: unknown }>,
  list: [] as Array<Record<string, unknown>>,
  documents: {} as Record<string, Record<string, unknown>>,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  subscriptionListener: null as ((payload: unknown) => void) | null,
  subscribe: vi.fn(),
  callCapability: vi.fn(),
  loadTheme: vi.fn(),
  toast: vi.fn(),
}))

const existingPath = '.agent-team/plans/existing_a1b2c3.html'
let PlansApp: any
let wrapper: VueWrapper | null = null

beforeAll(async () => {
  vi.doMock('@navide/plugin-ui', () => ({
    SafeAiCliPanel: { name: 'SafeAiCliPanel', template: '<div data-test="ai-panel" />' },
    createAiCliSessionController: vi.fn(() => ({ dispose: vi.fn() })),
  }))
  vi.doMock('@navide/plugin-ui/foundation', () => ({
    useNotify: () => ({ toast: state.toast }),
    useTheme: () => ({ loadTheme: state.loadTheme }),
  }))
  vi.doMock('vue-i18n', async (importOriginal) => {
    const actual = await importOriginal<typeof import('vue-i18n')>()
    return {
      ...actual,
      useI18n: (options?: Parameters<typeof actual.useI18n>[0]) => {
        try {
          return actual.useI18n(options)
        } catch {
          return {
            t: (key: string, params?: Record<string, unknown>) =>
              params ? `${key}:${JSON.stringify(params)}` : key,
          }
        }
      },
    }
  })
  window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&rel_path=${encodeURIComponent(existingPath)}`)
  PlansApp = (await import('./PlansApp.vue')).default
})

beforeEach(() => {
  window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&rel_path=${encodeURIComponent(existingPath)}`)
  state.preferences = {}
  state.sets.length = 0
  state.calls.length = 0
  state.subscriptionListener = null
  state.subscribe.mockImplementation((event: string, listener: (payload: unknown) => void) => {
    expect(event).toBe('plans.changed')
    state.subscriptionListener = listener
    return {
      ready: Promise.resolve(),
      settled: Promise.resolve(),
      dispose: vi.fn(),
    }
  })
  vi.stubGlobal('nav', {
    ready: vi.fn(),
    onOpenTarget: vi.fn(() => vi.fn()),
    callCapability: async (namespace: string, method: string, args: Record<string, unknown>) => {
      if (namespace === 'storage' && method === 'get') {
        const key = String(args.key)
        return {
          reqId: 'storage',
          ok: true,
          result: {
            found: Object.prototype.hasOwnProperty.call(state.preferences, key),
            ...(Object.prototype.hasOwnProperty.call(state.preferences, key)
              ? { value: state.preferences[key] }
              : {}),
          },
        }
      }
      if (namespace === 'storage' && method === 'set') {
        const key = String(args.key)
        state.sets.push({ key, value: args.value })
        state.preferences[key] = args.value
        return { reqId: 'storage', ok: true, result: null }
      }
      return { reqId: 'capability', ok: true, result: await state.callCapability(namespace, method, args) }
    },
    on: vi.fn(() => vi.fn()),
    callBackend: async (reqId: string, name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args })
      if (name === 'plans.list') return { reqId, ok: true, result: state.list }
      if (name === 'plans.read') {
        return { reqId, ok: true, result: state.documents[String(args.rel_path)] }
      }
      if (name === 'plans.create') {
        const relPath = '.agent-team/plans/new-plan_a1b2c3.html'
        state.list = [...state.list, {
          rel_path: relPath,
          name: String(args.name),
          stage: 'draft',
          meta: {
            schemaVersion: 1,
            name: String(args.name),
            overview: String(args.overview),
            stage: 'draft',
            todos: [],
            reviewNotes: [],
          },
        }]
        state.documents[relPath] = {
          rel_path: relPath,
          meta: state.list.at(-1)?.meta ?? null,
          html: '<html />',
        }
        return { reqId, ok: true, result: { rel_path: relPath } }
      }
      if (name === 'plans.rename') {
        const from = String(args.from)
        const to = String(args.to)
        const item = state.list.find((plan) => plan.rel_path === from)
        if (item) {
          item.rel_path = to
          state.documents[to] = state.documents[from]
          delete state.documents[from]
        }
        return { reqId, ok: true, result: { to } }
      }
      if (name === 'plans.delete') {
        const relPath = String(args.rel_path)
        state.list = state.list.filter((plan) => plan.rel_path !== relPath)
        delete state.documents[relPath]
        return { reqId, ok: true, result: null }
      }
      return { reqId, ok: true, result: null }
    },
    cancelBackend: vi.fn(),
    subscribeBackend: (event: string, listener: (payload: unknown) => void) =>
      state.subscribe(event, listener),
  })
  state.callCapability.mockReset()
  state.callCapability.mockResolvedValue({ opened: true })
  state.list = [{
    rel_path: existingPath,
    name: 'Existing plan',
    stage: 'approved',
    meta: {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'approved',
      todos: [],
      reviewNotes: [],
    },
  }]
  state.documents = {
    [existingPath]: {
      rel_path: existingPath,
      meta: state.list[0].meta,
      html: '<html />',
    },
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

async function mountPlans(options: Parameters<typeof shallowMount>[1] = {}): Promise<VueWrapper> {
  const { global: globalOptions, ...rest } = options
  wrapper = shallowMount(PlansApp, {
    ...rest,
    global: {
      stubs: { SafeAiCliPanel: true },
      ...globalOptions,
    },
  })
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('PlansApp', () => {
  it('renders translated Chinese Plans strings on first mount when bootstrapped with locale=zh-TW', async () => {
    window.history.replaceState(
      {},
      '',
      `/?workspace_path=%2Fworkspace&locale=zh-TW&rel_path=${encodeURIComponent(existingPath)}`,
    )
    const realI18n = createI18n({
      legacy: false,
      locale: 'en-US',
      fallbackLocale: 'zh-TW',
      messages: {
        'en-US': {
          action: {
            'open-in-editor': 'Open in editor',
            'copy-path': 'Copy path',
            create: 'Create',
            rename: 'Rename',
            delete: 'Delete',
            cancel: 'Cancel',
          },
        },
        'zh-TW': {
          action: {
            'open-in-editor': '在編輯器中開啟',
            'copy-path': '複製路徑',
            create: '建立',
            rename: '重新命名',
            delete: '刪除',
            cancel: '取消',
          },
        },
      },
    })
    bootstrapPlansI18n(realI18n, window.location.search)

    const view = await mountPlans({
      global: {
        plugins: [realI18n],
      },
    })

    expect(view.text()).toContain('新增計畫')
    expect(view.text()).toContain('所有文件')
    expect(view.text()).toContain('審查留言')
    expect(view.text()).not.toContain('pane.plans.v2.new-plan')
    expect(view.text()).not.toContain('pane.plans.review-notes')
  })

  it('renders translated English Plans strings on first mount when bootstrapped with locale=en-US while default is zh-TW before any host event', async () => {
    window.history.replaceState(
      {},
      '',
      `/?workspace_path=%2Fworkspace&locale=en-US&rel_path=${encodeURIComponent(existingPath)}`,
    )
    const realI18n = createI18n({
      legacy: false,
      locale: 'zh-TW',
      fallbackLocale: 'zh-TW',
      messages: {
        'en-US': {
          action: {
            'open-in-editor': 'Open in editor',
            'copy-path': 'Copy path',
            create: 'Create',
            rename: 'Rename',
            delete: 'Delete',
            cancel: 'Cancel',
          },
        },
        'zh-TW': {
          action: {
            'open-in-editor': '在編輯器中開啟',
            'copy-path': '複製路徑',
            create: '建立',
            rename: '重新命名',
            delete: '刪除',
            cancel: '取消',
          },
        },
      },
    })
    bootstrapPlansI18n(realI18n, window.location.search)
    let hostEventListener: ((payload: unknown) => void) | null = null
    bindPlansLocale(realI18n, (_event, listener) => {
      hostEventListener = listener
      return vi.fn()
    })

    const view = await mountPlans({
      global: {
        plugins: [realI18n],
      },
    })

    expect(hostEventListener).toBeTypeOf('function')
    expect(view.text()).toContain('New plan')
    expect(view.text()).toContain('All documents')
    expect(view.text()).toContain('Review Notes')
    expect(view.text()).not.toContain('新增計畫')
    expect(view.text()).not.toContain('所有文件')
    expect(view.text()).not.toContain('審查留言')
    expect(view.text()).not.toContain('pane.plans.v2.new-plan')
    expect(view.text()).not.toContain('pane.plans.review-notes')
  })
  it('restores workspace preferences and refreshes from plans.changed', async () => {
    state.preferences = {
      'plans.filter': 'approved',
      'plans.sort': 'title',
      'plans.sortdir': 'asc',
      'plans.group': 'stage',
      'plans.collapsed': JSON.stringify(['approved']),
      'plans.recent': JSON.stringify([existingPath]),
      'plans.pinned': JSON.stringify([existingPath]),
    }
    const view = await mountPlans()

    expect(view.findAll('select')[0].element).toHaveProperty('value', 'approved')
    expect(view.findAll('select')[1].element).toHaveProperty('value', 'title')
    expect(state.sets).toEqual([])
    expect(state.subscribe).toHaveBeenCalledOnce()
    expect(state.calls.filter(({ name }) => name === 'plans.list')).toHaveLength(1)

    await state.subscriptionListener?.({ workspace_path: '/workspace' })
    await flushPromises()
    expect(state.calls.filter(({ name }) => name === 'plans.list')).toHaveLength(2)
  })

  it('keeps in-memory fallback on initial empty preference read without calling setWorkspacePreference', async () => {
    state.preferences = {}
    const view = await mountPlans()

    // Defaults applied in memory
    expect(view.findAll('select')[0].element).toHaveProperty('value', 'all')
    expect(view.findAll('select')[1].element).toHaveProperty('value', 'updated')

    // Did not write default fallbacks into workspace storage
    expect(state.sets).toEqual([])

    // Explicit user change does persist
    const filterSelect = view.findAll('select')[0]
    await filterSelect.setValue('draft')
    await filterSelect.trigger('change')
    await flushPromises()

    expect(state.sets).toContainEqual({
      key: 'plans.filter',
      value: 'draft',
    })
  })

  it('loads the initial rel_path document in the standalone view without opening it in the editor', async () => {
    const view = await mountPlans()

    expect(state.calls).toContainEqual({
      name: 'plans.read',
      args: { rel_path: existingPath },
    })
    expect(view.find('.selected-document h2').text()).toBe('Existing plan')
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())
  })

  it('selects a document on standalone row click without opening it in the editor', async () => {
    const secondPath = '.agent-team/plans/second_a1b2c3.html'
    state.list = [
      ...state.list,
      {
        rel_path: secondPath,
        name: 'Second plan',
        stage: 'draft',
        meta: {
          schemaVersion: 1,
          name: 'Second plan',
          overview: 'Second overview',
          stage: 'draft',
          todos: [],
          reviewNotes: [],
        },
      },
    ]
    state.documents[secondPath] = {
      rel_path: secondPath,
      meta: state.list[1].meta,
      html: '<html />',
    }

    const view = await mountPlans()
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())

    const rows = view.findAll('.plan-row')
    await rows[1].trigger('click')
    await flushPromises()

    expect(state.calls).toContainEqual({
      name: 'plans.read',
      args: { rel_path: secondPath },
    })
    expect(view.find('.selected-document h2').text()).toBe('Second plan')
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())
  })

  it('opens the selected document in editor only from explicit toolbar or context-menu actions', async () => {
    const view = await mountPlans()
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())

    const openButton = view.find('.content-toolbar .toolbar-actions button')
    expect(openButton.text()).toBe('action.open-in-editor')
    await openButton.trigger('click')
    await flushPromises()

    expect(state.callCapability).toHaveBeenCalledWith('ui', 'openInEditor', { path: existingPath })
    state.callCapability.mockClear()

    const row = view.find('button.plan-row')
    await row.trigger('contextmenu', { clientX: 50, clientY: 50 })
    await flushPromises()

    const contextMenuOpen = view.findAll('.context-menu button')
      .find((button) => button.text() === 'action.open-in-editor')
    expect(contextMenuOpen).toBeDefined()
    await contextMenuOpen!.trigger('click')
    await flushPromises()

    expect(state.callCapability).toHaveBeenCalledWith('ui', 'openInEditor', { path: existingPath })
  })

  it('opens a selected document in the packaged Plans window from the left contribution', async () => {
    window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&contribution=left`)
    const view = await mountPlans()

    await view.find('.plan-row').trigger('click')
    await flushPromises()

    expect(state.callCapability).toHaveBeenCalledWith('ui', 'openPlansWindow', { path: existingPath })
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())
  })

  it('creates a plan through the package backend', async () => {
    const view = await mountPlans()
    const inputs = view.findAll('.create-form input')
    await inputs[0].setValue('New plan')
    await inputs[1].setValue('A new overview')
    await view.find('.create-form textarea').setValue('First todo')
    await view.find('.create-form').trigger('submit')
    await flushPromises()

    expect(state.calls.map(({ name }) => name)).toContain('plans.create')
    expect(view.text()).toContain('.agent-team/plans/new-plan_a1b2c3.html')
  })

  it('renames a plan through the package backend', async () => {
    const view = await mountPlans()
    vi.spyOn(window, 'prompt').mockReturnValue('renamed_a1b2c3.html')
    const renameButton = view.findAll('.content-toolbar .toolbar-actions button')
      .find((button) => button.text() === 'action.rename')
    expect(renameButton).toBeDefined()
    await renameButton!.trigger('click')
    await flushPromises()

    expect(state.calls).toContainEqual({
      name: 'plans.rename',
      args: { from: existingPath, to: '.agent-team/plans/renamed_a1b2c3.html' },
    })
  })

  it('deletes a plan through the package backend', async () => {
    const view = await mountPlans()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const deleteButton = view.find('.content-toolbar .toolbar-actions button.danger')
    await deleteButton.trigger('click')
    await flushPromises()
    await nextTick()

    expect(state.calls).toContainEqual({
      name: 'plans.delete',
      args: { rel_path: existingPath },
    })
  })

  it('formats progress using pane.plans.progress-done translation key', async () => {
    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'approved',
      todos: [
        { id: 'todo-1', content: 'T1', status: 'done' },
        { id: 'todo-2', content: 'T2', status: 'pending' },
        { id: 'todo-3', content: 'T3', status: 'pending' },
      ],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta

    const view = await mountPlans()
    const toolbarProgress = view.find('.plan-toolbar-progress')
    expect(toolbarProgress.text()).toContain('pane.plans.progress-done')
    expect(toolbarProgress.text()).toContain('"done":1')
    expect(toolbarProgress.text()).toContain('"total":3')
  })

  it('renders iframe with stripped scripts and strict nonce CSP in srcdoc', async () => {
    state.documents[existingPath].html =
      '<!doctype html><html><head><script>alert("evil")</script></head><body><p>Clean body</p></body></html>'

    const view = await mountPlans()
    const iframe = view.find('iframe.plan-doc-frame')
    expect(iframe.exists()).toBe(true)

    const srcdoc = iframe.attributes('srcdoc') ?? ''
    expect(srcdoc).not.toContain('alert("evil")')
    expect(srcdoc).toContain('Content-Security-Policy')
    expect(srcdoc).toContain("default-src 'none'")
    expect(srcdoc).toMatch(/script-src 'nonce-[0-9a-f]{32}'/)
    expect(srcdoc).toContain('data-todo-id')
  })

  it('safely handles todo-clicked only from the preview frame with known todo ID', async () => {
    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'approved',
      todos: [
        { id: 'todo-1', content: 'T1', status: 'pending' },
      ],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body><li data-todo-id="todo-1">T1</li></body></html>'

    const view = await mountPlans()
    const iframeEl = view.find('iframe.plan-doc-frame').element as HTMLIFrameElement
    const frameWin = {} as Window
    Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })

    const srcdoc = iframeEl.getAttribute('srcdoc') || ''
    const tokenMatch = srcdoc.match(/documentToken:\s*"([0-9a-f]{32})"/)
    const validToken = tokenMatch ? tokenMatch[1] : ''

    // 1. Rejected: mismatched window source
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validToken },
    }))
    await flushPromises()
    expect(state.calls.filter((c) => c.name === 'plans.update_todo')).toHaveLength(0)

    // 2. Rejected: null source (both event.source and getSourceWindow could be null)
    window.dispatchEvent(new MessageEvent('message', {
      source: null,
      data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validToken },
    }))
    await flushPromises()
    expect(state.calls.filter((c) => c.name === 'plans.update_todo')).toHaveLength(0)

    // 3. Rejected: unknown todo ID
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'unlisted-todo', documentToken: validToken },
    }))
    await flushPromises()
    expect(state.calls.filter((c) => c.name === 'plans.update_todo')).toHaveLength(0)

    // 4. Rejected: missing token, legacy token alias, or wrong document token
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'todo-1' },
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'todo-1', token: validToken },
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: 'wrong-or-stale-token' },
    }))
    await flushPromises()
    expect(state.calls.filter((c) => c.name === 'plans.update_todo')).toHaveLength(0)

    // 5. Accepted: matching frame window, valid documentToken, and valid todo ID
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validToken },
    }))
    await flushPromises()
    expect(state.calls).toContainEqual({
      name: 'plans.update_todo',
      args: {
        rel_path: existingPath,
        todo_id: 'todo-1',
        status: 'done',
      },
    })
  })

  it('prevents cross-document todo mutation race when switching documents while plans.read is deferred', async () => {
    const planBPath = '.agent-team/plans/plan_b_112233.html'
    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'approved',
      todos: [{ id: 'todo-1', content: 'T1', status: 'pending' }],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body><li data-todo-id="todo-1">T1</li></body></html>'

    state.list.push({
      rel_path: planBPath,
      name: 'Plan B',
      stage: 'draft',
      meta: {
        schemaVersion: 1,
        name: 'Plan B',
        overview: 'Overview B',
        stage: 'draft',
        todos: [{ id: 'todo-1', content: 'T1 in B', status: 'pending' }],
        reviewNotes: [],
      },
    })
    state.documents[planBPath] = {
      rel_path: planBPath,
      meta: state.list[1].meta,
      html: '<html><body><li data-todo-id="todo-1">T1 in B</li></body></html>',
    }

    let resolveReadB!: () => void
    const deferredReadB = new Promise<void>((resolve) => {
      resolveReadB = resolve
    })

    const originalCallBackend = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.read' && args.rel_path === planBPath) {
        await deferredReadB
      }
      return originalCallBackend(reqId, name, args)
    }

    const view = await mountPlans()
    const iframeEl = view.find('iframe.plan-doc-frame').element as HTMLIFrameElement
    const frameWin = {} as Window
    Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })

    const readCallsForA = () =>
      state.calls.filter((c) => c.name === 'plans.read' && c.args.rel_path === existingPath).length
    const initialReadsForA = readCallsForA()

    const srcdocA = iframeEl.getAttribute('srcdoc') || ''
    const tokenMatchA = srcdocA.match(/documentToken:\s*"([0-9a-f]{32})"/)
    const validTokenA = tokenMatchA ? tokenMatchA[1] : ''

    // 1. User initiates switch to Plan B
    const rows = view.findAll('.plan-row')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    await rows[1].trigger('click')

    // 2. While read(B) is deferred, user clicks todo-1 in Plan A's preview iframe
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frameWin,
        data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validTokenA },
      }),
    )
    await flushPromises()

    // Assertion 1: plans.update_todo targets Plan A, NOT Plan B
    expect(state.calls).toContainEqual({
      name: 'plans.update_todo',
      args: {
        rel_path: existingPath,
        todo_id: 'todo-1',
        status: 'done',
      },
    })
    expect(state.calls.filter((c) => c.name === 'plans.update_todo' && c.args.rel_path === planBPath)).toHaveLength(0)

    // Assertion 2: No redundant plans.read(A) was called while B is pending
    expect(readCallsForA()).toBe(initialReadsForA)

    // Assertion 3: selected is still Plan A prior to B resolving
    expect(view.find('.selected-document h2').text()).toBe('Existing plan')

    // 3. Resolve Plan B's read
    resolveReadB()
    await flushPromises()

    // Assertion 4: Plan B is applied only after B resolves
    expect(view.find('.selected-document h2').text()).toBe('Plan B')
  })

  it('prevents out-of-order plans.read results when B is read then C is read, and C resolves first', async () => {
    const planBPath = '.agent-team/plans/plan_b.html'
    const planCPath = '.agent-team/plans/plan_c.html'

    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Plan A',
      overview: 'Overview A',
      stage: 'approved',
      todos: [{ id: 'todo-1', content: 'T1', status: 'pending' }],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body>Plan A</body></html>'

    state.list.push({
      rel_path: planBPath,
      name: 'Plan B',
      stage: 'in-progress',
      meta: {
        schemaVersion: 1,
        name: 'Plan B',
        overview: 'Overview B',
        stage: 'in-progress',
        todos: [{ id: 'tb-1', content: 'TB', status: 'pending' }],
        reviewNotes: [],
      },
    })
    state.documents[planBPath] = {
      rel_path: planBPath,
      meta: state.list[1].meta,
      html: '<html><body>Plan B</body></html>',
    }

    state.list.push({
      rel_path: planCPath,
      name: 'Plan C',
      stage: 'done',
      meta: {
        schemaVersion: 1,
        name: 'Plan C',
        overview: 'Overview C',
        stage: 'done',
        todos: [{ id: 'tc-1', content: 'TC', status: 'done' }],
        reviewNotes: [],
      },
    })
    state.documents[planCPath] = {
      rel_path: planCPath,
      meta: state.list[2].meta,
      html: '<html><body>Plan C</body></html>',
    }

    let resolveReadB!: () => void
    const deferredReadB = new Promise<void>((resolve) => {
      resolveReadB = resolve
    })

    let resolveReadC!: () => void
    const deferredReadC = new Promise<void>((resolve) => {
      resolveReadC = resolve
    })

    const originalCallBackend = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.read' && args.rel_path === planBPath) {
        await deferredReadB
      } else if (name === 'plans.read' && args.rel_path === planCPath) {
        await deferredReadC
      }
      return originalCallBackend(reqId, name, args)
    }

    const view = await mountPlans()

    // Find rows
    const rows = view.findAll('.plan-row')
    expect(rows.length).toBeGreaterThanOrEqual(3)

    // 1. Click Plan B (starts read B, which is deferred)
    await rows[1].trigger('click')

    // 2. Click Plan C (starts read C, which is also deferred)
    await rows[2].trigger('click')

    // 3. Resolve C first
    resolveReadC()
    await flushPromises()

    // Verify C is displayed
    expect(view.find('.selected-document h2').text()).toBe('Plan C')
    const iframeC = view.find('iframe.plan-doc-frame')
    const cSrcdoc = iframeC.attributes('srcdoc') ?? ''
    expect(cSrcdoc).toContain('Plan C')

    // 4. Resolve B afterward
    resolveReadB()
    await flushPromises()

    // Stale B must NOT revert the UI from C
    expect(view.find('.selected-document h2').text()).toBe('Plan C')
    const iframeAfterB = view.find('iframe.plan-doc-frame')
    expect(iframeAfterB.attributes('srcdoc')).toBe(cSrcdoc)
  })

  it('prevents a refresh for A from overwriting B when selection changed to B after refresh started', async () => {
    const planBPath = '.agent-team/plans/plan_b.html'

    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Plan A',
      overview: 'Overview A',
      stage: 'approved',
      todos: [{ id: 'todo-1', content: 'T1', status: 'pending' }],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body>Plan A</body></html>'

    state.list.push({
      rel_path: planBPath,
      name: 'Plan B',
      stage: 'draft',
      meta: {
        schemaVersion: 1,
        name: 'Plan B',
        overview: 'Overview B',
        stage: 'draft',
        todos: [{ id: 'tb-1', content: 'TB', status: 'pending' }],
        reviewNotes: [],
      },
    })
    state.documents[planBPath] = {
      rel_path: planBPath,
      meta: state.list[1].meta,
      html: '<html><body>Plan B</body></html>',
    }

    let resolveRefreshA!: () => void
    let interceptA = false
    const deferredRefreshA = new Promise<void>((resolve) => {
      resolveRefreshA = resolve
    })

    const originalCallBackend = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (interceptA && name === 'plans.read' && args.rel_path === existingPath) {
        await deferredRefreshA
      }
      return originalCallBackend(reqId, name, args)
    }

    const view = await mountPlans()
    expect(view.find('.selected-document h2').text()).toBe('Plan A')

    // Start intercepting reads for A (simulating delayed refresh)
    interceptA = true

    // Trigger refresh for A (e.g. via toolbar refresh or todo click)
    const refreshBtn = view.find('button[title*="重新整理"], button[title*="Refresh"]')
    if (refreshBtn.exists()) {
      await refreshBtn.trigger('click')
    } else {
      // Direct todo toggle
      const frameEl = view.find('iframe.plan-doc-frame').element as HTMLIFrameElement
      const frameWin = {} as Window
      Object.defineProperty(frameEl, 'contentWindow', { value: frameWin, configurable: true })
      const srcdocA = frameEl.getAttribute('srcdoc') || ''
      const tokenMatchA = srcdocA.match(/documentToken:\s*"([0-9a-f]{32})"/)
      const validTokenA = tokenMatchA ? tokenMatchA[1] : ''
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frameWin,
          data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validTokenA },
        }),
      )
    }

    // Now user switches to Plan B
    const rows = view.findAll('.plan-row')
    await rows[1].trigger('click')
    await flushPromises()

    // B is now selected and displayed
    expect(view.find('.selected-document h2').text()).toBe('Plan B')
    const bSrcdoc = view.find('iframe.plan-doc-frame').attributes('srcdoc') ?? ''
    expect(bSrcdoc).toContain('Plan B')

    // Now resolve deferred read/refresh for A
    resolveRefreshA()
    await flushPromises()

    // The UI must remain on Plan B and not revert to Plan A
    expect(view.find('.selected-document h2').text()).toBe('Plan B')
    expect(view.find('iframe.plan-doc-frame').attributes('srcdoc')).toBe(bSrcdoc)
  })

  it('localizes stage labels across recent, grouped, and archived rows and formats progress bar percentage', async () => {
    state.preferences['plans.recent'] = JSON.stringify([existingPath])
    state.preferences['plans.collapsed'] = JSON.stringify([])
    state.list = [
      {
        rel_path: existingPath,
        name: 'Approved Plan',
        stage: 'approved',
        overview: 'Overview',
        todos: { total: 2, by_status: { done: 1 } },
        meta: {
          schemaVersion: 1,
          name: 'Approved Plan',
          overview: 'Overview',
          stage: 'approved',
          todos: [
            { id: 't1', content: 'T1', status: 'done' },
            { id: 't2', content: 'T2', status: 'pending' },
          ],
          reviewNotes: [],
        },
      },
      {
        rel_path: '.agent-team/plans/archived.html',
        name: 'Archived Plan',
        stage: 'done',
        overview: 'Archived Overview',
        meta: {
          schemaVersion: 1,
          name: 'Archived Plan',
          overview: 'Archived Overview',
          stage: 'done',
          archivedAt: '2026-09-01T00:00:00Z',
          todos: [],
          reviewNotes: [],
        },
      },
    ]
    state.documents[existingPath] = {
      rel_path: existingPath,
      meta: state.list[0].meta,
      html: '<html><body>Content</body></html>',
    }
    state.documents['.agent-team/plans/archived.html'] = {
      rel_path: '.agent-team/plans/archived.html',
      meta: state.list[1].meta,
      html: '<html><body>Archived</body></html>',
    }

    const view = await mountPlans()

    // 1. Recent row chip has localized label
    const recentChip = view.find('.plan-row--compact .plan-chip--stage-approved')
    expect(recentChip.exists()).toBe(true)
    expect(recentChip.text()).toBe('pane.plans.stage-approved')

    // 2. Grouped row chip has localized label
    const groupedChip = view.find('.plans-section .plan-row:not(.plan-row--compact) .plan-chip--stage-approved')
    expect(groupedChip.exists()).toBe(true)
    expect(groupedChip.text()).toBe('pane.plans.stage-approved')

    // 3. Archived row chip has localized label
    const archivedChip = view.find('.plan-row--done .plan-chip--stage-done')
    expect(archivedChip.exists()).toBe(true)
    expect(archivedChip.text()).toBe('pane.plans.stage-done')

    // 4. Progress bar width formatted as percentage
    const fillEl = view.find('.plan-toolbar-progress + .plan-progress-bar .plan-progress-fill')
    expect(fillEl.exists()).toBe(true)
    expect(fillEl.attributes('style')).toContain('width: 50%;')
  })

  it('decouples openInEditor so clicking open-in-editor invokes capability without mutating selectedPath', async () => {
    state.list = [
      {
        rel_path: existingPath,
        name: 'Plan A',
        stage: 'draft',
        meta: { schemaVersion: 1, name: 'Plan A', overview: '', stage: 'draft', todos: [], reviewNotes: [] },
      },
    ]
    state.documents[existingPath] = {
      rel_path: existingPath,
      meta: state.list[0].meta,
      html: '<html><body>A</body></html>',
    }

    const capabilityCalls: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
    state.callCapability.mockImplementation(async (namespace: string, method: string, args: Record<string, unknown>) => {
      capabilityCalls.push({ namespace, method, args })
      return { opened: true }
    })

    const view = await mountPlans()
    expect(view.find('.selected-document h2').text()).toBe('Plan A')

    const openEditorBtn = view.find('button[title="action.open-in-editor"]')
    expect(openEditorBtn.exists()).toBe(true)
    await openEditorBtn.trigger('click')
    await flushPromises()

    expect(capabilityCalls).toContainEqual({
      namespace: 'ui',
      method: 'openInEditor',
      args: { path: existingPath },
    })
    expect(view.find('.selected-document h2').text()).toBe('Plan A')
  })
})
