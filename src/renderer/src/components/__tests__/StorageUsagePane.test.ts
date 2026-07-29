// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import StorageUsagePane from '../StorageUsagePane.vue'
import { i18n } from '../../i18n'
import { createMockBackend } from '../../composables/__tests__/mockBackend'

function report() {
  return {
    generatedAt: '2026-07-29T00:00:00.000Z',
    staleDays: 30,
    totalBytes: 3_500_000_000,
    disk: { totalBytes: 500_000_000_000, freeBytes: 120_000_000_000 },
    groups: [
      {
        id: 'appData',
        rootPath: '/Users/test/Library/Application Support/Navide',
        totalBytes: 1_200_000_000,
        items: [
          {
            id: 'rotatedLogs',
            bytes: 900_000_000,
            fileCount: 4200,
            paths: ['/Users/test/Library/Application Support/Navide/Cache'],
            risk: 'safe',
            cleanable: true,
            handledBy: 'backend',
            note: null,
          },
          {
            id: 'storeBackups',
            bytes: 300_000_000,
            fileCount: 120,
            paths: ['/Users/test/Library/Application Support/Navide/logs'],
            risk: 'safe',
            cleanable: true,
            handledBy: 'backend',
            note: 'Rotated daily',
          },
          {
            id: 'appDataOther',
            bytes: 10_000_000,
            fileCount: 8,
            paths: ['/Users/test/Library/Application Support/Navide/sessions'],
            risk: 'danger',
            cleanable: false,
            handledBy: 'backend',
            note: null,
          },
        ],
      },
      {
        id: 'electron',
        rootPath: '/Users/test/Library/Application Support/Navide',
        totalBytes: 800_000_000,
        items: [
          {
            id: 'chromiumCache',
            bytes: 800_000_000,
            fileCount: 900,
            paths: ['/Users/test/Library/Application Support/Navide/Cache/Cache_Data'],
            risk: 'safe',
            cleanable: true,
            handledBy: 'electron',
            note: null,
          },
        ],
      },
      {
        id: 'workspaces',
        rootPath: '/Users/test/code',
        totalBytes: 1_500_000_000,
        items: [
          {
            id: 'pipelineLogs',
            bytes: 1_500_000_000,
            fileCount: 90_000,
            paths: ['/Users/test/code/demo/node_modules'],
            risk: 'caution',
            cleanable: true,
            handledBy: 'backend',
            note: null,
          },
        ],
      },
    ],
    errors: [{ path: '/Users/test/Library/Caches/locked', message: 'permission denied' }],
  }
}

async function mountPane() {
  const mock = createMockBackend('connected')
  mock.setResponse('storage.usage', report())
  mock.setResponse('storage.cleanup', { totalFreedBytes: 1_200_000_000, results: [] })
  const wrapper = mount(StorageUsagePane, {
    props: { backend: mock.backend, workspacePaths: ['/Users/test/code/demo'] },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, mock }
}

describe('StorageUsagePane', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('scans on mount and renders every group and item', async () => {
    const mounted = await mountPane()
    wrapper = mounted.wrapper

    const scans = mounted.mock.sent.filter((s) => s.type === 'storage.usage')
    expect(scans).toHaveLength(1)
    expect(scans[0].payload).toEqual({
      workspacePaths: ['/Users/test/code/demo'],
      staleDays: 30,
    })

    expect(wrapper.findAll('.su-item')).toHaveLength(5)
    const cache = wrapper.get('[data-item-id="rotatedLogs"]')
    // Labels resolve through settings.storage.item.<id>.label.
    expect(cache.get('.su-item-label').text()).toBe('Rotated backend logs')
    expect(cache.get('.su-size').text()).toBe('858 MB')
    expect(cache.get('.su-count').text()).toContain('4200')
    expect(cache.get('.su-risk').text()).toBe('Safe')
    // The backend note renders as secondary text.
    expect(wrapper.get('[data-item-id="storeBackups"]').get('.su-item-note').text()).toBe(
      'Rotated daily'
    )
    // Permission problems are a warning, not a failed scan.
    expect(wrapper.get('.su-warnings').text()).toContain('permission denied')
    expect(wrapper.find('.su-error').exists()).toBe(false)
  })

  it('sorts items inside a group by size descending', async () => {
    const mounted = await mountPane()
    wrapper = mounted.wrapper
    // Groups render in backend order, so the first three rows are the appData group.
    const ids = wrapper
      .findAll('[data-item-id]')
      .map((el) => el.attributes('data-item-id'))
      .slice(0, 3)
    expect(ids).toEqual(['rotatedLogs', 'storeBackups', 'appDataOther'])
  })

  it('renders no checkbox for non-cleanable items', async () => {
    const mounted = await mountPane()
    wrapper = mounted.wrapper
    expect(wrapper.get('[data-item-id="appDataOther"]').find('.su-check').exists()).toBe(false)
    expect(wrapper.get('[data-item-id="appDataOther"]').classes()).toContain('su-item-locked')
    expect(wrapper.get('[data-item-id="rotatedLogs"]').find('.su-check').exists()).toBe(true)
  })

  it('cleans only safe cleanable items, and never sends electron-handled ids to the backend', async () => {
    const clearElectronCaches = vi
      .fn()
      .mockResolvedValue({ ok: true, freedBytes: 800_000_000, error: null })
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      storage: { clearElectronCaches },
    }
    const mounted = await mountPane()
    wrapper = mounted.wrapper

    await wrapper.get('.su-clean-safe').trigger('click')
    await flushPromises()
    // One summary confirm, listing exactly the safe cleanable items.
    const confirmIds = wrapper
      .findAll('[data-confirm-id]')
      .map((el) => el.attributes('data-confirm-id'))
    expect(confirmIds).toEqual(['rotatedLogs', 'storeBackups', 'chromiumCache'])

    await wrapper.get('.su-confirm-ok').trigger('click')
    await flushPromises()

    const cleanups = mounted.mock.sent.filter((s) => s.type === 'storage.cleanup')
    expect(cleanups).toHaveLength(1)
    // chromiumCache is handledBy: 'electron' → bridge only.
    expect(cleanups[0].payload.itemIds).toEqual(['rotatedLogs', 'storeBackups'])
    expect(clearElectronCaches).toHaveBeenCalledWith({ chromium: true, updater: false })

    // Freed bytes are summed across both paths, then the pane rescans.
    expect(wrapper.get('.su-result').text()).toContain('1.9 GB')
    expect(mounted.mock.sent.filter((s) => s.type === 'storage.usage')).toHaveLength(2)
  })

  it('surfaces a clear message when the electron cache bridge is missing', async () => {
    const mounted = await mountPane()
    wrapper = mounted.wrapper

    await wrapper.get('.su-clean-safe').trigger('click')
    await flushPromises()
    await wrapper.get('.su-confirm-ok').trigger('click')
    await flushPromises()

    expect(wrapper.get('.su-cleanup-warning').text()).toContain('desktop bridge is unavailable')
  })

  it('still reports freed bytes when the electron pass only partially succeeds', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      storage: {
        clearElectronCaches: vi.fn().mockResolvedValue({
          ok: false,
          freedBytes: 800_000_000,
          error: 'An update download is in progress — the updater cache was left untouched.',
        }),
      },
    }
    const mounted = await mountPane()
    wrapper = mounted.wrapper

    await wrapper.get('.su-clean-safe').trigger('click')
    await flushPromises()
    await wrapper.get('.su-confirm-ok').trigger('click')
    await flushPromises()

    expect(wrapper.get('.su-result').text()).toContain('1.9 GB')
    expect(wrapper.get('.su-cleanup-warning').text()).toContain('update download is in progress')
    expect(wrapper.find('.su-failures').exists()).toBe(false)
  })

  it('enables "Clean selected" only once a non-safe item is checked', async () => {
    const mounted = await mountPane()
    wrapper = mounted.wrapper

    const cleanSelected = wrapper.get('.su-clean-selected')
    expect(cleanSelected.attributes('disabled')).toBeDefined()

    // A safe item alone is not enough — that is what "Clean safe items" is for.
    await wrapper.get('[data-item-id="rotatedLogs"] .su-check').setValue(true)
    expect(wrapper.get('.su-clean-selected').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-item-id="pipelineLogs"] .su-check').setValue(true)
    expect(wrapper.get('.su-clean-selected').attributes('disabled')).toBeUndefined()

    await wrapper.get('.su-clean-selected').trigger('click')
    await flushPromises()
    expect(
      wrapper.findAll('[data-confirm-id]').map((el) => el.attributes('data-confirm-id'))
    ).toEqual(['rotatedLogs', 'pipelineLogs'])
  })

  it('rescans with the new threshold when staleDays changes', async () => {
    const mounted = await mountPane()
    wrapper = mounted.wrapper

    await wrapper.get('.su-stale-select').setValue('90')
    await flushPromises()

    const scans = mounted.mock.sent.filter((s) => s.type === 'storage.usage')
    expect(scans).toHaveLength(2)
    expect(scans[1].payload.staleDays).toBe(90)
  })
})
