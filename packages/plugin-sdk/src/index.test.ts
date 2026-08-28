import { describe, expect, it, vi } from 'vitest'
import { createPluginSettingsStore, type PluginContext } from './index'

describe('public plugin SDK adapters', () => {
  it('derives storage identity from PluginContext instead of plugin input', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ found: true, value: { density: 'compact' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(true)
    const context = { capabilities: { invoke } } as unknown as PluginContext
    const settings = createPluginSettingsStore(context, 'workspace')

    await expect(settings.get('view')).resolves.toEqual({ density: 'compact' })
    await expect(settings.set('view', { density: 'comfortable' })).resolves.toBeUndefined()
    await expect(settings.delete('view')).resolves.toBe(true)
    expect(invoke.mock.calls).toEqual([
      ['storage.get', { scope: 'workspace', key: 'view' }],
      ['storage.set', { scope: 'workspace', key: 'view', value: { density: 'comfortable' } }],
      ['storage.delete', { scope: 'workspace', key: 'view' }],
    ])
  })
})
