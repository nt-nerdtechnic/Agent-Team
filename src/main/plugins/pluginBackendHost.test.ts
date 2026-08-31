import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginBackendHost, type PluginBackendHostOptions } from './pluginBackendHost'
import type {
  BackendPluginLaunchSpec,
  PluginBackendSupervisorOptions,
} from './pluginBackendSupervisor'
import { PluginBackendSupervisor } from './pluginBackendSupervisor'
import { createProductionPlansBridgeDispatcher } from './plansBridge'
import {
  MAX_BACKEND_CALLS_PER_INSTANCE,
  MAX_BACKEND_CHILDREN,
  MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE,
  MAX_BACKEND_TIMEOUT_MS,
} from './pluginBackendLimits'

const fixture = fileURLToPath(new URL('./test-fixtures/backend-wire-child.mjs', import.meta.url))
const packagedFixture = join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans')
const packagedGoFixture = join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans-go')
const packagedFixtureEnabled = process.env.NAVIDE_TEST_PACKAGED_PLANS === '1'
if (packagedFixtureEnabled && (!existsSync(packagedFixture) || !existsSync(packagedGoFixture))) {
  throw new Error(
    `NAVIDE_TEST_PACKAGED_PLANS=1 requires packaged fixtures at ${packagedFixture} and ${packagedGoFixture}; run pnpm run build:plans:fixture first.`,
  )
}
const packagedBackendEnvironment: Record<string, string> = {}
for (const key of ['TMPDIR', 'TEMP', 'TMP'] as const) {
  const value = process.env[key]
  if (typeof value === 'string' && value.length > 0) packagedBackendEnvironment[key] = value
}
const activation: BackendPluginLaunchSpec = {
  pluginId: 'navide.plans',
  packageVersion: '0.1.92',
  packageDir: process.cwd(),
  entryFile: fixture,
  protocolVersion: 1,
  activation: 'startup',
  approvedMethods: ['fixture.delay', 'fixture.echo', 'fixture.emit', 'fixture.exit', 'plans.resolve_root'],
  approvedEvents: ['fixture.changed', 'plans.changed'],
  approvedBridgePorts: ['filesystem'],
}

const runtime = {
  pluginId: activation.pluginId,
  packageVersion: activation.packageVersion,
  workspaceId: 'workspace-1',
  instanceId: 'view-1',
  contributionKey: 'navide.plans.window',
  hostWindowId: 'window-1',
} as const

function makeHost(entryFile = fixture): PluginBackendHost {
  const options: PluginBackendSupervisorOptions = {
    // PyInstaller --onefile needs a writable temp directory for extraction;
    // keep the test launcher aligned with the Host's minimal environment.
    environment: { ...packagedBackendEnvironment, NAVIDE_FIXTURE: 'backend-wire' },
    bridgeDispatcher: createProductionPlansBridgeDispatcher(),
    spawnProcess: (nextEntryFile, spawnOptions) =>
      spawn(nextEntryFile === fixture ? process.execPath : nextEntryFile, nextEntryFile === fixture ? [nextEntryFile] : [], {
        ...spawnOptions,
        env: spawnOptions.env,
      }) as ChildProcessWithoutNullStreams,
  }
  const hostOptions: PluginBackendHostOptions = {
    createSupervisor: (nextActivation) => {
      return new PluginBackendSupervisor({ ...nextActivation, entryFile }, options)
    },
    resolvePlanRoot: async ({ workspacePath }) => workspacePath,
  }
  return new PluginBackendHost(hostOptions)
}

describe('PluginBackendHost', () => {
  const hosts: PluginBackendHost[] = []

  afterEach(async () => {
    delete (globalThis as unknown as { nav?: unknown }).nav
    await Promise.all(hosts.splice(0).map((host) => host.close()))
  })

  it('routes a bound view through the matching package version', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    await expect(host.call('view-1', 'fixture.echo', {
      value: 42,
      runtime: { workspaceId: 'forged' },
    })).resolves.toEqual({
      arguments: {
        value: 42,
        runtime: { workspaceId: 'forged' },
      },
      runtime,
    })
  })

  it('creates an independent supervisor and root binding for each view', async () => {
    const supervisors: Array<{
      clientFor: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }> = []
    const createSupervisor = vi.fn((
      _activation: BackendPluginLaunchSpec,
      _options: PluginBackendSupervisorOptions,
    ) => {
      const client = {
        call: vi.fn(async () => null as never),
        subscribe: vi.fn(() => ({
          acknowledged: Promise.resolve(),
          settled: Promise.resolve({ reason: 'cancelled' as const }),
          dispose: vi.fn(),
        })),
      }
      const supervisor = {
        start: vi.fn(async () => ({
          value: null,
          serverInfo: { name: 'controlled', version: '1.0.0' },
        })),
        clientFor: vi.fn(() => client),
        close: vi.fn(async () => undefined),
      }
      supervisors.push(supervisor)
      return supervisor as unknown as PluginBackendSupervisor
    })
    const host = new PluginBackendHost({
      createSupervisor,
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())
    host.bindView({ ...runtime, instanceId: 'view-2', hostWindowId: 'window-2' }, activation.packageDir, process.cwd())

    await expect(host.call('view-1', 'fixture.echo', null)).resolves.toBeNull()
    await expect(host.call('view-2', 'fixture.echo', null)).resolves.toBeNull()
    expect(createSupervisor).toHaveBeenCalledTimes(2)
    expect(supervisors[0]).not.toBe(supervisors[1])
    const firstOptions = createSupervisor.mock.calls[0]?.[1]
    const secondOptions = createSupervisor.mock.calls[1]?.[1]
    expect(firstOptions?.authorizedPlanRoot)
      .not.toBe(secondOptions?.authorizedPlanRoot)
  })

  it('caps bound child process slots and releases a failed root binding', async () => {
    const createSupervisor = vi.fn(() => ({
      start: vi.fn(async () => ({
        value: null,
        serverInfo: { name: 'controlled', version: '1.0.0' },
      })),
      clientFor: vi.fn(() => ({ call: vi.fn(async () => null as never), subscribe: vi.fn() })),
      close: vi.fn(async () => undefined),
    }) as unknown as PluginBackendSupervisor)
    const resolvePlanRoot = vi.fn(async () => tmpdir())
    const host = new PluginBackendHost({ createSupervisor, resolvePlanRoot })
    hosts.push(host)
    host.register(activation)
    await expect(host.bindView(runtime, activation.packageDir, process.cwd()))
      .rejects.toMatchObject({ code: 'INVALID_RUNTIME' })

    const cappedHost = new PluginBackendHost({
      createSupervisor,
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(cappedHost)
    cappedHost.register(activation)
    for (let index = 0; index < MAX_BACKEND_CHILDREN; index += 1) {
      cappedHost.bindView({
        ...runtime,
        instanceId: `view-${index}`,
        hostWindowId: `window-${index}`,
      }, activation.packageDir, process.cwd())
    }
    expect(() => cappedHost.bindView({
      ...runtime,
      instanceId: 'view-over-cap',
      hostWindowId: 'window-over-cap',
    }, activation.packageDir, process.cwd())).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_LIMIT' }),
    )
  })

  it('rejects a filesystem binding without a Host root resolver', async () => {
    const createSupervisor = vi.fn(() => undefined as unknown as PluginBackendSupervisor)
    const host = new PluginBackendHost({ createSupervisor })
    hosts.push(host)
    host.register(activation)

    await expect(host.bindView(runtime, activation.packageDir, process.cwd()))
      .rejects.toMatchObject({ code: 'INVALID_RUNTIME' })
    expect(createSupervisor).not.toHaveBeenCalled()
  })

  it('binds a non-filesystem activation without a Host root resolver', async () => {
    const supervisor = {
      close: vi.fn(async () => undefined),
    } as unknown as PluginBackendSupervisor
    const createSupervisor = vi.fn(() => supervisor)
    const host = new PluginBackendHost({ createSupervisor })
    hosts.push(host)
    const nonFilesystemActivation = { ...activation, approvedBridgePorts: [] }
    host.register(nonFilesystemActivation)

    await expect(host.bindView(runtime, nonFilesystemActivation.packageDir, process.cwd()))
      .resolves.toBeUndefined()
    expect(createSupervisor).toHaveBeenCalledOnce()
  })

  it('routes the Plans root operation and event through the non-Python fixture', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    let resolveEvent!: (payload: unknown) => void
    const eventReceived = new Promise<unknown>((resolve) => {
      resolveEvent = resolve
    })
    const subscription = await host.subscribe('view-1', 'plans.changed', resolveEvent)
    await subscription.acknowledged

    await expect(host.call('view-1', 'plans.resolve_root', {
      workspace_path: process.cwd(),
    })).resolves.toEqual({ ok: true, root: process.cwd() })
    await expect(eventReceived).resolves.toEqual({ workspace_path: process.cwd() })
  })

  it('rejects unbound views and methods outside the Host allowlist', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    await expect(host.call('other-view', 'fixture.echo', null))
      .rejects.toMatchObject({ code: 'INVALID_RUNTIME' })
    await expect(host.call('view-1', 'fixture.notallowed', null))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('requires an exact package version for activation lookup', () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)

    expect(host.activationFor('navide.plans', activation.packageVersion, activation.packageDir)).toBe(activation)
    expect(host.activationFor('navide.plans', '9.9.9', activation.packageDir)).toBeUndefined()
    expect(host.activationFor('navide.plans', activation.packageVersion, join(process.cwd(), '..'))).toBeUndefined()
  })

  it('fails closed for missing, non-directory, and symlinked package roots', () => {
    const host = makeHost()
    hosts.push(host)
    const root = mkdtempSync(join(tmpdir(), 'navide-backend-root-'))
    const symlink = join(root, 'package-link')
    symlinkSync(process.cwd(), symlink)
    try {
      expect(() => host.register({
        ...activation,
        packageDir: join(root, 'missing'),
      })).toThrowError(expect.objectContaining({ code: 'INVALID_ACTIVATION' }))
      expect(() => host.register({
        ...activation,
        packageDir: fixture,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_ACTIVATION' }))
      expect(() => host.register({
        ...activation,
        packageDir: symlink,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_ACTIVATION' }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a timeout above the Host-private bound before child dispatch', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    await expect(host.call('view-1', 'fixture.echo', null, {
      timeoutMs: MAX_BACKEND_TIMEOUT_MS + 1,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('enforces per-view call and subscription limits', async () => {
    const settledSubscriptions: Array<() => void> = []
    const controlledSupervisor = {
      start: vi.fn(async () => ({
        value: null,
        serverInfo: { name: 'controlled', version: '1.0.0' },
      })),
      clientFor: vi.fn(() => ({
        call: vi.fn(async () => null as never),
        subscribe: vi.fn(() => {
          let settle!: () => void
          const settled = new Promise<{ reason: 'cancelled' }>((resolve) => {
            settle = () => resolve({ reason: 'cancelled' })
          })
          settledSubscriptions.push(settle)
          return {
            acknowledged: Promise.resolve(),
            settled,
            dispose: settle,
          }
        }),
      })),
      close: vi.fn(async () => undefined),
    } as unknown as PluginBackendSupervisor
    const host = new PluginBackendHost({
      createSupervisor: () => controlledSupervisor,
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    const calls = Array.from({ length: MAX_BACKEND_CALLS_PER_INSTANCE }, () =>
      host.call('view-1', 'fixture.delay', { milliseconds: 10_000 })
    )
    await expect(host.call('view-1', 'fixture.delay', { milliseconds: 10_000 }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })

    const subscriptions = await Promise.all(
      Array.from({ length: MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE }, () =>
        host.subscribe('view-1', 'fixture.changed', () => undefined)
      )
    )
    await expect(host.subscribe('view-1', 'fixture.changed', () => undefined))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })

    for (const subscription of subscriptions) subscription.dispose()
    await Promise.all(calls)
    for (const settle of settledSubscriptions) settle()
  })

  it('cancels an in-flight call when the view is destroyed', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    const pending = host.call('view-1', 'fixture.delay', { milliseconds: 10_000 })
    host.unbindView('view-1')

    await expect(pending).rejects.toMatchObject({ code: 'USER_CANCELLED' })
  })

  it('rejects forged package and view identity at the binding boundary', () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)

    expect(() => host.bindView({ ...runtime, packageVersion: '9.9.9' }, activation.packageDir))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RUNTIME' }))
    expect(() => host.bindView(runtime, join(process.cwd(), '..')))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RUNTIME' }))
    expect(() => host.bindView({ ...runtime, workspaceId: '' }, activation.packageDir))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RUNTIME' }))
  })

  it('settles a view subscription when the Host unbinds the view', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    const subscription = await host.subscribe('view-1', 'fixture.changed', () => undefined)
    await subscription.acknowledged
    host.unbindView('view-1')

    await expect(subscription.settled).resolves.toMatchObject({ reason: 'view-destroyed' })
  })
})

describe('packaged Plans backend', () => {
  const run = packagedFixtureEnabled ? it : it.skip
  const hosts: PluginBackendHost[] = []

  afterEach(async () => {
    delete (globalThis as unknown as { nav?: unknown }).nav
    await Promise.all(hosts.splice(0).map((host) => host.close()))
  })

  for (const [label, entryFile] of [
    ['Python', packagedFixture],
    ['Go', packagedGoFixture],
  ] as const) {
    run(`${label} completes resolve_root and emits plans.changed from the same child`, async () => {
      const host = makeHost(entryFile)
      hosts.push(host)
      host.register({
        ...activation,
        entryFile,
        approvedMethods: ['plans.resolve_root'],
        approvedEvents: ['plans.changed'],
      })
      host.bindView(runtime, activation.packageDir, process.cwd())

      let resolveEvent!: (payload: unknown) => void
      const eventReceived = new Promise<unknown>((resolve) => {
        resolveEvent = resolve
      })
      const subscription = await host.subscribe('view-1', 'plans.changed', resolveEvent)
      await subscription.acknowledged

      await expect(host.call('view-1', 'plans.resolve_root', {
        workspace_path: process.cwd(),
      })).resolves.toEqual({ ok: true, root: process.cwd() })
      await expect(eventReceived).resolves.toEqual({ workspace_path: process.cwd() })
    })

    run(`${label} settles cancellation, timeout, and child crash without hanging the Host`, async () => {
      const host = makeHost(entryFile)
      hosts.push(host)
      host.register({
        ...activation,
        entryFile,
        approvedMethods: ['fixture.delay', 'fixture.exit'],
        approvedEvents: [],
      })
      host.bindView(runtime, activation.packageDir, process.cwd())

      const controller = new AbortController()
      const cancelled = host.call(
        'view-1',
        'fixture.delay',
        { milliseconds: 10_000 },
        { signal: controller.signal },
      )
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ code: 'USER_CANCELLED' })

      await expect(host.call('view-1', 'fixture.delay', { milliseconds: 10_000 }, { timeoutMs: 20 }))
        .rejects.toMatchObject({ code: 'TIMEOUT' })
      await expect(host.call('view-1', 'fixture.exit', null))
        .rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    })
  }
})
