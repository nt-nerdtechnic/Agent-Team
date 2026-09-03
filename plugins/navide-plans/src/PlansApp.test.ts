// @vitest-environment happy-dom
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrapPlansI18n } from './plansI18n'

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

  it('opens the selected document through the Host ui.openInEditor capability', async () => {
    const view = await mountPlans()

    expect(state.callCapability).toHaveBeenCalledWith('ui', 'openInEditor', { path: existingPath })
    const openButton = view.find('.content-toolbar .toolbar-actions button')
    await openButton.trigger('click')
    await flushPromises()
    expect(state.callCapability).toHaveBeenLastCalledWith('ui', 'openInEditor', { path: existingPath })
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
})
