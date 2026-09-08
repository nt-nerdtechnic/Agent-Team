import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_ERROR_CODES } from '@navide/plugin-contracts'
import {
  createPluginCapabilityClient,
  createPluginViewRuntimeClient,
  createPluginBackendClient,
  PluginBackendError,
  createPluginSettingsStore,
  type PluginContext,
} from './index'

interface TestBackendBridge {
  callBackend: ReturnType<typeof vi.fn>
  cancelBackend: ReturnType<typeof vi.fn>
  subscribeBackend: ReturnType<typeof vi.fn>
}

interface TestCapabilityBridge {
  callCapability: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function installBackendBridge(bridge: TestBackendBridge): void {
  ;(globalThis as unknown as { nav: TestBackendBridge }).nav = bridge
}

afterEach(() => {
  delete (globalThis as unknown as { nav?: TestBackendBridge }).nav
})

describe('public plugin SDK adapters', () => {
  it('routes typed public capabilities and events through the SDK boundary', async () => {
    const unsubscribe = vi.fn()
    const bridge: TestCapabilityBridge = {
      callCapability: vi.fn((namespace: string, method: string) => Promise.resolve({
        reqId: 'cap-1',
        ok: true,
        result: namespace === 'storage' && method === 'get'
          ? { found: true, value: 'compact' }
          : null,
      })),
      on: vi.fn((_type: string, _listener: (payload: unknown) => void) => unsubscribe),
    }
    ;(globalThis as unknown as { nav: TestCapabilityBridge }).nav = bridge

    const client = createPluginCapabilityClient()
    await expect(client.capabilities.invoke('storage.get', { scope: 'workspace', key: 'density' }))
      .resolves.toEqual({ found: true, value: 'compact' })
    const listener = vi.fn()
    const subscription = client.events.subscribe('aiCli.exited', listener)
    subscription.dispose()

    expect(bridge.callCapability).toHaveBeenCalledWith(
      'storage',
      'get',
      { scope: 'workspace', key: 'density' },
    )
    expect(bridge.on).toHaveBeenCalledWith('aiCli.exited', listener)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('maps legacy broker errors to stable public PluginError codes', async () => {
    const bridge: TestCapabilityBridge = {
      callCapability: vi.fn(() => Promise.resolve({
        reqId: 'cap-2',
        ok: false,
        error: { code: 'CAP_DENIED', message: 'not granted' },
      })),
      on: vi.fn(),
    }
    ;(globalThis as unknown as { nav: TestCapabilityBridge }).nav = bridge

    await expect(createPluginCapabilityClient().capabilities.invoke('storage.get', {
      scope: 'workspace',
      key: 'density',
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED', message: 'not granted' })
  })

  it('models the Host RESOURCE_LIMIT code instead of flattening it to INTERNAL_ERROR', async () => {
    // The Host emits RESOURCE_LIMIT into the plugin-facing capability envelope
    // (backend round-trip limits). An unmodeled code is silently downgraded to
    // INTERNAL_ERROR, which no exhaustive switch on PluginErrorCode can see.
    expect(PLUGIN_ERROR_CODES).toContain('RESOURCE_LIMIT')

    const bridge: TestCapabilityBridge = {
      callCapability: vi.fn(() => Promise.resolve({
        reqId: 'cap-3',
        ok: false,
        error: { code: 'RESOURCE_LIMIT', message: 'backend call limit reached' },
      })),
      on: vi.fn(),
    }
    ;(globalThis as unknown as { nav: TestCapabilityBridge }).nav = bridge

    await expect(createPluginCapabilityClient().capabilities.invoke('storage.get', {
      scope: 'workspace',
      key: 'density',
    })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', message: 'backend call limit reached' })
  })

  it('adapts view readiness and open targets through the public SDK', () => {
    const removeTargetListener = vi.fn()
    const bridge = {
      ready: vi.fn(),
      onOpenTarget: vi.fn(() => removeTargetListener),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge

    const client = createPluginViewRuntimeClient()
    const listener = vi.fn()
    client.ready()
    const target = client.onOpenTarget(listener)
    target.dispose()

    expect(bridge.ready).toHaveBeenCalledOnce()
    expect(bridge.onOpenTarget).toHaveBeenCalledWith(listener)
    expect(removeTargetListener).toHaveBeenCalledOnce()
  })

  it('keeps the package-local stack for errors created in the renderer', () => {
    const error = new PluginBackendError('INVALID_ARGUMENT', 'bad arguments')

    expect(error.stack).toContain('PluginBackendError')
  })

  it('routes backend calls through the private Host bridge without exposing identity fields', async () => {
    const bridge: TestBackendBridge = {
      callBackend: vi.fn((reqId: string) =>
        Promise.resolve({ reqId, ok: true, result: { root: '/workspace' } })
      ),
      cancelBackend: vi.fn(),
      subscribeBackend: vi.fn(() => ({
        ready: Promise.resolve(),
        settled: Promise.resolve(),
        dispose: vi.fn(),
      })),
    }
    installBackendBridge(bridge)

    const client = createPluginBackendClient()
    await expect(client.call('plans.resolve_root', { workspace_path: '/workspace' }))
      .resolves.toEqual({ root: '/workspace' })

    expect(bridge.callBackend).toHaveBeenCalledWith(
      expect.any(String),
      'plans.resolve_root',
      { workspace_path: '/workspace' },
      undefined,
    )
  })

  it('cancels an in-flight backend call through its exact request id', async () => {
    const bridge: TestBackendBridge = {
      callBackend: vi.fn(() => new Promise(() => undefined)),
      cancelBackend: vi.fn(),
      subscribeBackend: vi.fn(() => ({
        ready: Promise.resolve(),
        settled: Promise.resolve(),
        dispose: vi.fn(),
      })),
    }
    installBackendBridge(bridge)
    const controller = new AbortController()
    const client = createPluginBackendClient()
    const pending = client.call('plans.resolve_root', null, { signal: controller.signal })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'USER_CANCELLED' })
    expect(bridge.cancelBackend).toHaveBeenCalledWith(bridge.callBackend.mock.calls[0][0])
  })

  it('preserves a Host resource-limit code through the public SDK', async () => {
    const bridge: TestBackendBridge = {
      callBackend: vi.fn((reqId: string) => Promise.resolve({
        reqId,
        ok: false,
        error: { code: 'RESOURCE_LIMIT', message: 'too many calls' },
      })),
      cancelBackend: vi.fn(),
      subscribeBackend: vi.fn(() => ({
        ready: Promise.resolve(),
        settled: Promise.resolve(),
        dispose: vi.fn(),
      })),
    }
    installBackendBridge(bridge)

    await expect(createPluginBackendClient().call('plans.resolve_root', null))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT', message: 'too many calls' })
  })

  it('adapts a backend event disposer to the public Disposable contract', async () => {
    const dispose = vi.fn()
    const bridge: TestBackendBridge = {
      callBackend: vi.fn(),
      cancelBackend: vi.fn(),
      subscribeBackend: vi.fn(() => ({ ready: Promise.resolve(), settled: Promise.resolve(), dispose })),
    }
    installBackendBridge(bridge)
    const listener = vi.fn()
    const client = createPluginBackendClient()

    const subscription = client.subscribe('plans.changed', listener)
    await subscription.ready
    await subscription.settled
    subscription.dispose()

    expect(bridge.subscribeBackend).toHaveBeenCalledWith('plans.changed', listener)
    expect(dispose).toHaveBeenCalledOnce()
  })

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
