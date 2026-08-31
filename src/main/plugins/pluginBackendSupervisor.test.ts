import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendPluginError,
  createAuthenticatedBackendRuntime,
  MCP_PROTOCOL_REVISION,
  parseBackendWireFrame,
  parseBackendWireHostFrame,
  PluginBackendSupervisor,
  type AuthenticatedBackendRuntime,
  type BackendPluginEvent,
  type BackendPluginLaunchSpec,
  type PluginBackendSupervisorOptions,
  type BackendRuntimeContext,
} from './pluginBackendSupervisor'
import {
  createInMemoryPlansBridgeDispatcher,
  createProductionPlansBridgeDispatcher,
} from './plansBridge'
import { MAX_BACKEND_BRIDGE_RESULT_BYTES } from './pluginBackendLimits'

const fixture = fileURLToPath(new URL('./test-fixtures/backend-wire-child.mjs', import.meta.url))
const packagedFixtureEnabled = process.env.NAVIDE_TEST_PACKAGED_PLANS === '1'
const packagedFixtures = [
  ['Python', join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans')],
  ['Go', join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans-go')],
] as const
if (packagedFixtureEnabled && packagedFixtures.some(([, entryFile]) => !existsSync(entryFile))) {
  throw new Error('NAVIDE_TEST_PACKAGED_PLANS=1 requires both packaged Plans fixtures; run pnpm run build:plans:fixture first.')
}
const packagedBackendEnvironment: Record<string, string> = {}
for (const key of ['TMPDIR', 'TEMP', 'TMP'] as const) {
  const value = process.env[key]
  if (typeof value === 'string' && value.length > 0) packagedBackendEnvironment[key] = value
}

const activation: BackendPluginLaunchSpec = {
  pluginId: 'acme.backend',
  packageVersion: '1.2.3',
  packageDir: process.cwd(),
  entryFile: fixture,
  protocolVersion: 1,
  activation: 'startup',
  approvedMethods: [
    'fixture.cancelcount',
    'fixture.close',
    'fixture.delay',
    'fixture.duplicateevent',
    'fixture.duplicatekeys',
    'fixture.echo',
    'fixture.bridge',
    'fixture.emit',
    'fixture.exit',
    'fixture.forgedruntime',
    'fixture.forgedevent',
    'fixture.lateresponse',
    'fixture.multiline',
    'fixture.unknownmethod',
    'fixture.unknownnotification',
    'fixture.badversion',
    'fixture.progress',
    'fixture.protocolerror',
    'fixture.publicerror',
    'fixture.stderr',
    'plans.resolve_root',
  ],
  approvedEvents: ['fixture.changed', 'plans.changed'],
  approvedBridgePorts: ['filesystem'],
}

const runtime: BackendRuntimeContext = {
  pluginId: activation.pluginId,
  packageVersion: activation.packageVersion,
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  contributionKey: 'acme.backend.panel',
  hostWindowId: 'window-1',
}

const authenticatedRuntime = createAuthenticatedBackendRuntime(runtime)

const packagedActivation = {
  pluginId: 'navide.plans',
  packageVersion: '0.1.92',
  packageDir: process.cwd(),
  protocolVersion: 1 as const,
  activation: 'startup' as const,
  approvedMethods: [
    'fixture.cancelcount',
    'fixture.close',
    'fixture.delay',
    'fixture.duplicateevent',
    'fixture.duplicatekeys',
    'fixture.echo',
    'fixture.forgedevent',
    'fixture.emit',
    'fixture.exit',
    'fixture.forgedruntime',
    'fixture.lateresponse',
    'fixture.multiline',
    'fixture.unknownmethod',
    'fixture.unknownnotification',
    'fixture.badversion',
    'fixture.progress',
    'fixture.protocolerror',
    'fixture.publicerror',
    'fixture.stderr',
    'plans.resolve_root',
  ],
  approvedEvents: ['fixture.changed', 'plans.changed'],
  approvedBridgePorts: ['filesystem'] as const,
}

const packagedRuntime = createAuthenticatedBackendRuntime({
  pluginId: packagedActivation.pluginId,
  packageVersion: packagedActivation.packageVersion,
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  contributionKey: 'navide.plans.window',
  hostWindowId: 'window-1',
})

function makeSupervisor(
  overrides: Partial<PluginBackendSupervisorOptions> = {}
): PluginBackendSupervisor {
  return new PluginBackendSupervisor(activation, {
    ...overrides,
    environment: overrides.environment ?? { NAVIDE_FIXTURE: 'backend-wire' },
    spawnProcess: overrides.spawnProcess ?? ((entryFile, options) =>
      spawn(process.execPath, [entryFile], {
        ...options,
        env: options.env,
      }) as ChildProcessWithoutNullStreams),
  })
}

function makePackagedSupervisor(entryFile: string): PluginBackendSupervisor {
  return new PluginBackendSupervisor(
    { ...packagedActivation, entryFile },
    {
      environment: packagedBackendEnvironment,
      bridgeDispatcher: createProductionPlansBridgeDispatcher(),
      authorizedPlanRoot: { value: process.cwd() },
      spawnProcess: (nextEntryFile, options) =>
        spawn(nextEntryFile, [], { ...options, env: options.env }) as ChildProcessWithoutNullStreams,
    },
  )
}

function makeControlledChild(
  generation: number,
  ignoredMethods: readonly string[] = [],
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let exited = false
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').trim().split('\n')) {
      if (!line) continue
      const frame = JSON.parse(line) as {
        id?: string | number
        method?: string
        params?: { name?: string }
      }
      if (frame.id === undefined || ignoredMethods.includes(frame.params?.name ?? '')) continue
      stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            resultType: 'complete',
            value: { generation },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'controlled', version: '1.0.0' } },
          },
        })}\n`
      )
    }
  })
  const killSignals: Array<NodeJS.Signals | number | undefined> = []
  const kill = (signal?: NodeJS.Signals | number): boolean => {
    killSignals.push(signal)
    if (exited) return true
    exited = true
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  return Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill,
    killSignals,
    pid: generation,
  }) as unknown as ChildProcessWithoutNullStreams
}

function makeBridgeChild(onFrame?: (frame: string) => void): ChildProcessWithoutNullStreams {
  const child = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let input = ''
  let exited = false
  let parentCallId = ''
  const writeFrame = (frame: string): void => {
    onFrame?.(frame)
    stdout.write(frame)
  }
  stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    while (true) {
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const frame = JSON.parse(input.slice(0, newline)) as {
        id?: string
        method?: string
        params?: { name?: string; arguments?: unknown }
        result?: { value?: unknown }
        error?: unknown
      }
      input = input.slice(newline + 1)
      if (frame.method === 'navide/health' && frame.id) {
        writeFrame(`${JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            resultType: 'complete',
            value: { ok: true },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'bridge-child', version: '1.0.0' } },
          },
        })}\n`)
        continue
      }
      if (frame.method === 'navide/call' && frame.id && frame.params?.name === 'fixture.bridge') {
        parentCallId = frame.id
        writeFrame(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 'bridge:child-request',
          method: 'navide/host/call',
          params: {
            origin: { kind: 'call', requestId: frame.id },
            port: 'filesystem',
            operation: 'resolve_root',
            arguments: {},
          },
        })}\n`)
        continue
      }
      if (frame.id === 'bridge:child-request' && frame.result && frame.id) {
        writeFrame(`${JSON.stringify({
          jsonrpc: '2.0',
          id: parentCallId,
          result: {
            resultType: 'complete',
            value: frame.result.value,
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'bridge-child', version: '1.0.0' } },
          },
        })}\n`)
      }
      if (frame.id === 'bridge:child-request' && frame.error && parentCallId) {
        writeFrame(`${JSON.stringify({
          jsonrpc: '2.0',
          id: parentCallId,
          error: frame.error,
        })}\n`)
      }
    }
  })
  const kill = (): boolean => {
    if (exited) return true
    exited = true
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  return Object.assign(child, { stdin, stdout, stderr, kill, pid: 99 }) as unknown as ChildProcessWithoutNullStreams
}

describe('PluginBackendSupervisor', () => {
  const supervisors: PluginBackendSupervisor[] = []

  afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()))
  })

  it('starts a child process and completes health plus one unary call', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)

    const health = await supervisor.start()
    expect(health.value).toEqual({
      method: 'navide/health',
      protocolVersion: MCP_PROTOCOL_REVISION,
      requestIdIsNonNull: true,
      clientCapabilities: {},
    })
    expect(health.serverInfo).toEqual({ name: 'fixture.backend', version: '1.0.0' })

    const result = await supervisor.clientFor(authenticatedRuntime).call('fixture.echo', {
      value: 42,
      runtime: { hostWindowId: 'caller-supplied-value' },
    })
    expect(result).toEqual({
      arguments: {
        value: 42,
        runtime: { hostWindowId: 'caller-supplied-value' },
      },
      runtime,
    })
  })

  it('rejects a method that is not in the Host activation allowlist', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.notallowed', null)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('dispatches a private Bridge request with the authenticated parent runtime', async () => {
    let bridgeRequest: unknown
    const supervisor = makeSupervisor({
      bridgeDispatcher: createInMemoryPlansBridgeDispatcher(),
      spawnProcess: () => makeBridgeChild((frame) => {
        if (frame.includes('navide/host/call')) {
          bridgeRequest = JSON.parse(frame.trim())
        }
      }),
    })
    supervisors.push(supervisor)

    await supervisor.start()
    await expect(
      supervisor.clientFor(authenticatedRuntime, { workspacePath: '/workspace' }).call('fixture.bridge', null)
    ).resolves.toEqual({ root: '/workspace' })
    expect(bridgeRequest).toEqual({
      jsonrpc: '2.0',
      id: 'bridge:child-request',
      method: 'navide/host/call',
      params: {
        origin: { kind: 'call', requestId: expect.any(String) },
        port: 'filesystem',
        operation: 'resolve_root',
        arguments: {},
      },
    })
    expect(bridgeRequest).not.toHaveProperty('params.runtime')
  })

  it('aborts a pending Bridge dispatcher when the child crashes', async () => {
    let child: ChildProcessWithoutNullStreams | undefined
    let bridgeStarted!: () => void
    const bridgeStart = new Promise<void>((resolve) => {
      bridgeStarted = resolve
    })
    let bridgeAborted!: () => void
    const bridgeAbort = new Promise<void>((resolve) => {
      bridgeAborted = resolve
    })
    const supervisor = makeSupervisor({
      bridgeDispatcher: {
        dispatch: async (_request, context) => {
          bridgeStarted()
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) {
              resolve()
              return
            }
            context.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          bridgeAborted()
          throw new Error('bridge aborted')
        },
      },
      spawnProcess: () => {
        child = makeBridgeChild()
        return child
      },
    })
    supervisors.push(supervisor)

    await supervisor.start()
    const pending = supervisor
      .clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
      .call('fixture.bridge', null)
    await bridgeStart
    ;(child as unknown as EventEmitter).emit('exit', 17, null)

    await expect(pending).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    await expect(bridgeAbort).resolves.toBeUndefined()
  })

  it('returns a stable error when a private Bridge result exceeds its encoded bound', async () => {
    const supervisor = makeSupervisor({
      bridgeDispatcher: {
        dispatch: async () => ({ content: 'x'.repeat(MAX_BACKEND_BRIDGE_RESULT_BYTES) }),
      },
      spawnProcess: () => makeBridgeChild(),
    })
    supervisors.push(supervisor)

    await supervisor.start()
    const error = await supervisor
      .clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
      .call('fixture.bridge', null)
      .catch((value) => value)

    expect(error).toMatchObject({
      code: 'RESULT_TOO_LARGE',
      pluginCode: 'RESULT_TOO_LARGE',
    })
  })

  it('acknowledges a subscription before delivering the requested event', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const received: unknown[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      (event) => received.push(event)
    )

    await subscription.acknowledged
    expect(received).toEqual([])

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.emit', {
        event: 'fixture.changed',
        payload: { value: 1 },
      })
    ).resolves.toEqual({ ok: true })

    await vi.waitFor(() => {
      expect(received).toEqual([
        {
          subscriptionId: subscription.subscriptionId,
          event: 'fixture.changed',
          payload: { value: 1 },
        },
      ])
    })

    subscription.dispose()
  })

  it('rejects events outside the Host-approved package catalog', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    expect(() =>
      supervisor.clientFor(authenticatedRuntime).subscribe(['fixture.other'], () => undefined)
    ).toThrowError(new BackendPluginError('INVALID_ARGUMENT'))
  })

  it('rejects malformed subscription options with a stable public error', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const client = supervisor.clientFor(authenticatedRuntime)
    expect(() =>
      client.subscribe(['fixture.changed'], () => undefined, {
        onProgress: 'not-a-listener' as unknown as () => void,
      })
    ).toThrowError(new BackendPluginError('INVALID_ARGUMENT'))
    expect(() =>
      client.subscribe(['fixture.changed'], () => undefined, {
        signal: {} as AbortSignal,
      })
    ).toThrowError(new BackendPluginError('INVALID_ARGUMENT'))
  })

  it('fails closed when the child emits before acknowledgment', async () => {
    const supervisor = makeSupervisor({
      environment: {
        NAVIDE_FIXTURE: 'backend-wire',
        NAVIDE_FIXTURE_EVENT_BEFORE_ACK: '1',
      },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )

    await expect(subscription.acknowledged).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Backend plugin returned an invalid protocol message.',
    })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'protocol-error' })
  })

  it('fails closed when an event addresses an unknown subscription', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await subscription.acknowledged

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.forgedevent', { subscriptionId: 'forged-subscription' })
      .catch((value) => value)

    expect(error).toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Backend plugin returned an invalid protocol message.',
    })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'protocol-error' })
  })

  it('fails closed when a child emits an event outside the requested filter', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await subscription.acknowledged

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.emit', { event: 'fixture.other', payload: null })
      .catch((value) => value)

    expect(error).toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'protocol-error' })
  })

  it('fails closed on an unknown notification or duplicate subscription event keys', async () => {
    for (const method of ['fixture.unknownnotification', 'fixture.duplicateevent']) {
      const supervisor = makeSupervisor()
      supervisors.push(supervisor)
      await supervisor.start()
      const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
        ['fixture.changed'],
        () => undefined
      )
      await subscription.acknowledged

      const error = await supervisor.clientFor(authenticatedRuntime).call(method, null).catch((value) => value)
      expect(error).toMatchObject({
        code: 'PROTOCOL_ERROR',
        message: 'Backend plugin returned an invalid protocol message.',
      })
      await expect(subscription.settled).resolves.toMatchObject({ reason: 'protocol-error' })
    }
  })

  it('settles cancellation and view destruction exactly once', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const cancelled = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await cancelled.acknowledged
    cancelled.dispose()
    cancelled.dispose('view-destroyed')
    await expect(cancelled.settled).resolves.toMatchObject({ reason: 'cancelled' })

    const destroyed = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await destroyed.acknowledged
    destroyed.dispose('view-destroyed')
    destroyed.dispose()

    await expect(destroyed.settled).resolves.toMatchObject({ reason: 'view-destroyed' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)
    ).resolves.toEqual(2)
  })

  it('ignores queued acknowledgment, event, and closure after cancel-before-ack', async () => {
    const supervisor = makeSupervisor({
      environment: {
        NAVIDE_FIXTURE: 'backend-wire',
        NAVIDE_FIXTURE_LATE_ACK_AFTER_CANCEL: '1',
      },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const received: BackendPluginEvent[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      (event) => received.push(event)
    )
    subscription.dispose()

    await expect(subscription.acknowledged).rejects.toMatchObject({ code: 'USER_CANCELLED' })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'cancelled' })
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)
    ).resolves.toEqual(1)
    expect(received).toEqual([])
  })

  it('settles a subscription timeout and sends one cancellation', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined,
      { timeoutMs: 20 }
    )
    await subscription.acknowledged

    await expect(subscription.settled).resolves.toMatchObject({ reason: 'timeout' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)
    ).resolves.toEqual(1)
  })

  it('bounds active subscription state', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const client = supervisor.clientFor(authenticatedRuntime)
    const subscriptions = Array.from({ length: 256 }, () =>
      client.subscribe(['fixture.changed'], () => undefined)
    )
    await Promise.all(subscriptions.map((subscription) => subscription.acknowledged))

    expect(() => client.subscribe(['fixture.changed'], () => undefined)).toThrowError(
      new BackendPluginError('RESOURCE_LIMIT')
    )

    subscriptions.forEach((subscription) => subscription.dispose())
    await Promise.all(subscriptions.map((subscription) => subscription.settled))
  })

  it('delivers progress only to the owning subscription', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const progress: unknown[] = []
    const otherProgress: unknown[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined,
      { onProgress: (value) => progress.push(value) }
    )
    const other = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined,
      { onProgress: (value) => otherProgress.push(value) }
    )
    await subscription.acknowledged
    await other.acknowledged
    const subscriptionId = subscription.subscriptionId
    expect(subscriptionId).toEqual(expect.any(String))
    if (subscriptionId === undefined) throw new Error('Expected a subscription id.')

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.progress', {
        subscriptionId,
      })
    ).resolves.toEqual({ ok: true })
    expect(progress).toEqual([
      {
        progressToken: subscription.subscriptionId,
        progress: 1,
        total: 2,
        message: 'fixture progress',
      },
    ])
    expect(otherProgress).toEqual([])
    subscription.dispose()
    other.dispose()
  })

  it('settles a backend-initiated graceful subscription closure once', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await subscription.acknowledged
    const subscriptionId = subscription.subscriptionId
    expect(subscriptionId).toEqual(expect.any(String))
    if (subscriptionId === undefined) throw new Error('Expected a subscription id.')

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.close', {
        subscriptionId,
      })
    ).resolves.toEqual({ ok: true })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'backend-closed' })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'backend-closed' })
  })

  it('re-establishes only the live subscription after child restart', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const received: BackendPluginEvent[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      (event) => received.push(event)
    )
    await subscription.acknowledged
    const firstSubscriptionId = subscription.subscriptionId
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.emit', {
        event: 'fixture.changed',
        payload: { generation: 1 },
      })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(received).toHaveLength(1))

    const cancelled = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await cancelled.acknowledged
    cancelled.dispose()
    await expect(cancelled.settled).resolves.toMatchObject({ reason: 'cancelled' })

    await expect(supervisor.restart()).resolves.toMatchObject({
      serverInfo: { name: 'fixture.backend', version: '1.0.0' },
    })
    expect(subscription.subscriptionId).not.toBe(firstSubscriptionId)
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.emit', {
        event: 'fixture.changed',
        payload: { generation: 2 },
      })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received[1].payload).toEqual({ generation: 2 })
  })

  it('can restart after an unexpected child exit and restore the live subscription', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const received: BackendPluginEvent[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      (event) => received.push(event)
    )
    await subscription.acknowledged

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.exit', null)
    ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    await expect(supervisor.restart()).resolves.toBeDefined()

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.emit', {
        event: 'fixture.changed',
        payload: { recovered: true },
      })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0].payload).toEqual({ recovered: true })
  })

  it('drains a completing request before switching the child generation', async () => {
    const supervisor = makeSupervisor({ drainTimeoutMs: 250 })
    supervisors.push(supervisor)
    await supervisor.start()

    const pending = supervisor.clientFor(authenticatedRuntime).call('fixture.delay', { milliseconds: 20 })
    const restarting = supervisor.restart()
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await expect(pending).resolves.toEqual({ delayed: true })
    await expect(restarting).resolves.toMatchObject({
      serverInfo: { name: 'fixture.backend', version: '1.0.0' },
    })
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).resolves.toMatchObject({ runtime })
  })

  it('continues an in-flight call Bridge request while the generation drains', async () => {
    let bridgeStarted!: () => void
    const bridgeStart = new Promise<void>((resolve) => {
      bridgeStarted = resolve
    })
    let releaseBridge!: () => void
    const bridgeRelease = new Promise<void>((resolve) => {
      releaseBridge = resolve
    })
    const supervisor = makeSupervisor({
      bridgeDispatcher: {
        dispatch: async () => {
          bridgeStarted()
          await bridgeRelease
          return { root: '/workspace' }
        },
      },
      spawnProcess: () => makeBridgeChild(),
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const pending = supervisor
      .clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
      .call('fixture.bridge', null)
    await bridgeStart
    const restarting = supervisor.restart()
    releaseBridge()

    await expect(pending).resolves.toEqual({ root: '/workspace' })
    await expect(restarting).resolves.toMatchObject({
      serverInfo: { name: 'bridge-child', version: '1.0.0' },
    })
  })

  it('ignores late events from a previous child generation', async () => {
    const children: ChildProcessWithoutNullStreams[] = []
    const stderr: string[] = []
    const supervisor = makeSupervisor({
      onStderr: (chunk) => stderr.push(chunk),
      spawnProcess: () => {
        const child = makeControlledChild(children.length + 1)
        children.push(child)
        return child
      },
    })
    supervisors.push(supervisor)

    await supervisor.start()
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).resolves.toEqual({ generation: 1 })
    await supervisor.restart()

    const previous = children[0]
    ;(previous.stdout as unknown as PassThrough).write(
      '{"jsonrpc":"2.0","id":"late-old-response","error":{"code":-32600,"message":"late"}}\n'
    )
    ;(previous.stderr as unknown as PassThrough).write('late old stderr')
    previous.emit('exit', 0, null)

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).resolves.toEqual({ generation: 2 })
    expect(stderr).toEqual([])
  })

  it('requires an explicit child environment and does not inherit the host environment', async () => {
    expect(() =>
      new PluginBackendSupervisor(activation, {} as PluginBackendSupervisorOptions)
    ).toThrowError(new BackendPluginError('INVALID_ACTIVATION'))

    let spawnOptions: Parameters<NonNullable<PluginBackendSupervisorOptions['spawnProcess']>>[1] | undefined
    const supervisor = new PluginBackendSupervisor(activation, {
      environment: { NAVIDE_FIXTURE: 'backend-wire' },
      spawnProcess: (entryFile, options) => {
        spawnOptions = options
        return spawn(process.execPath, [entryFile], {
          ...options,
          env: options.env,
        }) as ChildProcessWithoutNullStreams
      },
    })
    supervisors.push(supervisor)

    await supervisor.start()

    expect(spawnOptions?.env).toEqual({ NAVIDE_FIXTURE: 'backend-wire' })
    expect(spawnOptions?.env).not.toHaveProperty('PATH')
  })

  it.each([
    ['non-string value', { NAVIDE_FIXTURE: 123 }],
    ['NUL in a key', { 'NAVIDE_FIXTURE\u0000': 'backend-wire' }],
    ['NUL in a value', { NAVIDE_FIXTURE: 'backend\u0000wire' }],
    ['invalid key', { 'NAVIDE-FIXTURE': 'backend-wire' }],
  ])('rejects an environment with %s', (_label, environment) => {
    expect(() =>
      new PluginBackendSupervisor(activation, {
        environment: environment as unknown as Record<string, string>,
      })
    ).toThrowError(new BackendPluginError('INVALID_ACTIVATION'))
  })

  it('only accepts an authenticated binding for the activated package', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    expect(() => supervisor.clientFor(runtime as unknown as AuthenticatedBackendRuntime)).toThrowError(
      new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.')
    )
    expect(() =>
      supervisor.clientFor(createAuthenticatedBackendRuntime({ ...runtime, pluginId: 'acme.other' }))
    ).toThrowError(new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.'))
    expect(() =>
      supervisor.clientFor(
        createAuthenticatedBackendRuntime({ ...runtime, packageVersion: '9.9.9' })
      )
    ).toThrowError(new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.'))
    expect(() =>
      createAuthenticatedBackendRuntime({ ...runtime, forged: 'field' } as BackendRuntimeContext)
    ).toThrowError(new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.'))
  })

  it('does not accept a cloned authentication brand or audience', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const forged = { ...authenticatedRuntime } as AuthenticatedBackendRuntime
    for (const symbol of Object.getOwnPropertySymbols(authenticatedRuntime)) {
      const descriptor = Object.getOwnPropertyDescriptor(authenticatedRuntime, symbol)
      if (descriptor) Object.defineProperty(forged, symbol, descriptor)
    }

    expect(() => supervisor.clientFor(forged)).toThrowError(
      new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.')
    )
  })

  it('preserves a public plugin error without exposing transport details', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.publicerror', null)
      .catch((value) => value)
    expect(error).toBeInstanceOf(BackendPluginError)
    expect(error).toMatchObject({
      code: 'PLUGIN_ERROR',
      pluginCode: 'INVALID_ARGUMENT',
      requestId: expect.any(String),
      message: 'Plugin request failed.',
    })
    expect(error.stack).toEqual(expect.any(String))
    expect(String(error)).not.toContain('fixture')
    expect(String(error)).not.toContain('transport')
    expect(String(error)).not.toContain('stack')
  })

  it('maps a protocol error with no optional data to a safe protocol error', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.protocolerror', null)
      .catch((value) => value)
    expect(error).toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Backend plugin returned an invalid protocol message.',
    })
  })

  it.each([
    ['wrong version', 'fixture.badversion'],
    ['duplicate keys', 'fixture.duplicatekeys'],
    ['multiline frame', 'fixture.multiline'],
    ['unknown method', 'fixture.unknownmethod'],
    ['forged runtime fields', 'fixture.forgedruntime'],
  ])('fails closed on %s from the child process', async (_label, method) => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor.clientFor(authenticatedRuntime).call(method, null).catch((value) => value)
    expect(error).toBeInstanceOf(BackendPluginError)
    expect(error).toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Backend plugin returned an invalid protocol message.',
    })
    expect(String(error)).not.toContain(fixture)
  })

  it('times out once and sends a cancellation notification', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.delay', { milliseconds: 100 }, { timeoutMs: 20 })
      .catch((value) => value)
    expect(error).toMatchObject({
      code: 'TIMEOUT',
      message: 'Backend plugin call timed out.',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)).resolves.toEqual(1)
  })

  it('maps an aborted call to user cancellation and sends the same wire notification', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const controller = new AbortController()
    const promise = supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.delay', { milliseconds: 100 }, { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toMatchObject({
      code: 'USER_CANCELLED',
      message: 'Backend plugin call was cancelled.',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)).resolves.toEqual(1)
  })

  it('retires a cancellation tombstone after a late response', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const timeoutError = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.delay', { milliseconds: 100 }, { timeoutMs: 5 })
      .catch((value) => value)
    const requestId = (timeoutError as BackendPluginError).requestId
    expect(requestId).toEqual(expect.any(String))
    if (requestId === undefined) throw new Error('Expected a timeout request id.')

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.lateresponse', { requestId })
    ).resolves.toEqual({ ok: true })

    const repeatedResponseError = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.lateresponse', { requestId })
      .catch((value) => value)
    expect(repeatedResponseError).toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('bounds cancellation tombstones', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const firstError = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.delay', { milliseconds: 100 }, { timeoutMs: 5 })
      .catch((value) => value)
    expect(firstError).toMatchObject({ code: 'TIMEOUT' })
    const firstRequestId = (firstError as BackendPluginError).requestId
    expect(firstRequestId).toEqual(expect.any(String))
    if (firstRequestId === undefined) throw new Error('Expected a timeout request id.')

    let lastRequestId: string | number | undefined
    for (let index = 0; index < 256; index += 1) {
      const error = await supervisor
        .clientFor(authenticatedRuntime)
        .call('fixture.delay', { milliseconds: 100 }, { timeoutMs: 5 })
        .catch((value) => value)
      expect(error).toMatchObject({ code: 'TIMEOUT' })
      lastRequestId = (error as BackendPluginError).requestId
    }
    expect(lastRequestId).toEqual(expect.any(String))
    if (lastRequestId === undefined) throw new Error('Expected a timeout request id.')

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.lateresponse', {
        requestId: lastRequestId,
      })
    ).resolves.toEqual({ ok: true })

    const evictedResponseError = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.lateresponse', { requestId: firstRequestId })
      .catch((value) => value)
    expect(evictedResponseError).toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('maps an unexpected child exit to a safe unavailable error', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor.clientFor(authenticatedRuntime).call('fixture.exit', null).catch((value) => value)
    expect(error).toBeInstanceOf(BackendPluginError)
    expect(error).toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
    })
    expect(String(error)).not.toContain('exit')
    expect(String(error)).not.toContain('SIG')
  })

  it('routes stderr away from the protocol stream', async () => {
    const stderr = vi.fn()
    const supervisor = makeSupervisor({ onStderr: stderr })
    supervisors.push(supervisor)
    await supervisor.start()

    await expect(supervisor.clientFor(authenticatedRuntime).call('fixture.stderr', null)).resolves.toEqual({ ok: true })
    expect(stderr).toHaveBeenCalledWith('fixture diagnostic: /private/internal/path\n')
  })

  it('gracefully closes the child and can be closed again', async () => {
    let child: ChildProcessWithoutNullStreams | undefined
    const supervisor = new PluginBackendSupervisor(activation, {
      spawnProcess: (entryFile, options) => {
        child = spawn(process.execPath, [entryFile], {
          ...options,
          env: options.env,
        }) as ChildProcessWithoutNullStreams
        return child
      },
      environment: { NAVIDE_FIXTURE: 'backend-wire' },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    await supervisor.close()
    await supervisor.close()
    expect(child?.exitCode).not.toBeNull()
  })

  it('drains existing work, rejects new work, and force-terminates an unresponsive child', async () => {
    let child: ChildProcessWithoutNullStreams | undefined
    const supervisor = new PluginBackendSupervisor(activation, {
      environment: { NAVIDE_FIXTURE: 'backend-wire' },
      drainTimeoutMs: 5,
      shutdownTimeoutMs: 5,
      callTimeoutMs: 1_000,
      spawnProcess: () => {
        child = makeControlledChild(1, ['fixture.echo'])
        return child
      },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const pending = supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    const closing = supervisor.close()
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await closing

    const signals = (child as unknown as { killSignals: Array<string | number | undefined> }).killSignals
    expect(signals).toContain('SIGTERM')
  })

  it('does not respawn a child when close races a restart drain', async () => {
    const children: ChildProcessWithoutNullStreams[] = []
    const supervisor = makeSupervisor({
      drainTimeoutMs: 5,
      shutdownTimeoutMs: 5,
      callTimeoutMs: 1_000,
      spawnProcess: () => {
        const child = makeControlledChild(children.length + 1, ['fixture.echo'])
        children.push(child)
        return child
      },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const pending = supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    const restarting = supervisor.restart()
    const closing = supervisor.close()

    const pendingError = await pending.catch((error: unknown) => error)
    expect(pendingError).toBeInstanceOf(BackendPluginError)
    expect(['BACKEND_UNAVAILABLE', 'PLUGIN_STOPPING']).toContain(
      (pendingError as BackendPluginError).code,
    )
    await expect(restarting).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await closing
    expect(children).toHaveLength(1)
  })

  it('does not spawn after close wins a pending root refresh', async () => {
    let releaseRoot!: (root: string) => void
    const root = new Promise<string>((resolve) => {
      releaseRoot = resolve
    })
    let spawnCount = 0
    const supervisor = makeSupervisor({
      authorizedPlanRoot: { value: null },
      refreshAuthorizedPlanRoot: () => root,
      spawnProcess: () => {
        spawnCount += 1
        return makeControlledChild(1)
      },
    })
    supervisors.push(supervisor)

    const starting = supervisor.start()
    await Promise.resolve()
    const closing = supervisor.close()
    releaseRoot(process.cwd())

    await expect(starting).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await closing
    expect(spawnCount).toBe(0)
  })

  for (const [label, entryFile] of packagedFixtures) {
    const run = packagedFixtureEnabled ? it : it.skip

    run(`${label} passes the shared Backend Wire call and event corpus`, async () => {
      const supervisor = makePackagedSupervisor(entryFile)
      supervisors.push(supervisor)
      await expect(supervisor.start()).resolves.toMatchObject({
        serverInfo: { name: 'navide.plans', version: '0.1.92' },
      })
      const client = supervisor.clientFor(packagedRuntime, {
        workspacePath: process.cwd(),
        authorizedPlanRoot: process.cwd(),
      })
      await expect(client.call('fixture.echo', {
          value: 42,
        }),
      ).resolves.toEqual({ arguments: { value: 42 }, runtime: packagedRuntime })

      const received: BackendPluginEvent[] = []
      const progress: unknown[] = []
      const subscription = client.subscribe(
        ['fixture.changed', 'plans.changed'],
        (event) => received.push(event),
        { onProgress: (value) => progress.push(value) },
      )
      await subscription.acknowledged
      const subscriptionId = subscription.subscriptionId
      expect(subscriptionId).toEqual(expect.any(String))
      if (subscriptionId === undefined) throw new Error('Expected a subscription id.')
      await expect(client.call('plans.resolve_root', {
        workspace_path: process.cwd(),
      })).resolves.toEqual({ ok: true, root: process.cwd() })
      await vi.waitFor(() => {
        expect(received.some((event) => event.event === 'plans.changed')).toBe(true)
      })
      await expect(client.call('fixture.progress', { subscriptionId })).resolves.toEqual({ ok: true })
      expect(progress).toEqual([{
        progressToken: subscriptionId,
        progress: 1,
        total: 2,
        message: 'fixture progress',
      }])
      await expect(
        client.call('fixture.emit', {
          subscriptionId,
          event: 'fixture.changed',
          payload: { value: 1 },
        }),
      ).resolves.toEqual({ ok: true })
      await vi.waitFor(() => {
        expect(received.some((event) => event.event === 'fixture.changed' && event.payload &&
          typeof event.payload === 'object' && 'value' in event.payload && event.payload.value === 1)).toBe(true)
      })
      await expect(client.call('fixture.close', { subscriptionId })).resolves.toEqual({ ok: true })
      await expect(subscription.settled).resolves.toMatchObject({ reason: 'backend-closed' })
    })

    run(`${label} settles cancellation and timeout in the shared corpus`, async () => {
      const supervisor = makePackagedSupervisor(entryFile)
      supervisors.push(supervisor)
      await supervisor.start()

      const controller = new AbortController()
      const cancelled = supervisor.clientFor(packagedRuntime).call(
        'fixture.delay',
        { milliseconds: 100 },
        { signal: controller.signal },
      )
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ code: 'USER_CANCELLED' })
      await expect(
        supervisor.clientFor(packagedRuntime).call('fixture.delay', { milliseconds: 100 }, { timeoutMs: 10 }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' })
      await expect(
        supervisor.clientFor(packagedRuntime).call('fixture.cancelcount', null),
      ).resolves.toBe(2)
    })

    run(`${label} restores the core after child crash and restart`, async () => {
      const supervisor = makePackagedSupervisor(entryFile)
      supervisors.push(supervisor)
      await supervisor.start()
      const received: BackendPluginEvent[] = []
      const subscription = supervisor.clientFor(packagedRuntime).subscribe(
        ['fixture.changed'],
        (event) => received.push(event),
      )
      await subscription.acknowledged

      await expect(
        supervisor.clientFor(packagedRuntime).call('fixture.exit', null),
      ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
      await expect(supervisor.restart()).resolves.toMatchObject({
        serverInfo: { name: 'navide.plans', version: '0.1.92' },
      })
      await expect(
        supervisor.clientFor(packagedRuntime).call('fixture.emit', {
          event: 'fixture.changed',
          payload: { recovered: true },
        }),
      ).resolves.toEqual({ ok: true })
      await vi.waitFor(() => expect(received.at(-1)?.payload).toEqual({ recovered: true }))
      subscription.dispose()
    })
  }

  it('rejects non-compact, duplicate-key, multiline, and invalid UTF-8 frames', () => {
    expect(() =>
      parseBackendWireFrame('{"jsonrpc": "2.0"}')
    ).toThrow('Backend plugin returned an invalid protocol message.')
    expect(() =>
      parseBackendWireFrame('{"id":1,"id":2}')
    ).toThrow('Backend plugin returned an invalid protocol message.')
    expect(() =>
      parseBackendWireFrame('{"jsonrpc":"2.0"}\n{"jsonrpc":"2.0"}')
    ).toThrow('Backend plugin returned an invalid protocol message.')
    expect(() => parseBackendWireFrame(Uint8Array.of(0xff))).toThrow(
      'Backend plugin returned an invalid protocol message.'
    )
  })

  it('parses only the private Bridge request shape and excludes runtime identity', () => {
    expect(parseBackendWireHostFrame(JSON.stringify({
      jsonrpc: '2.0',
      id: 'bridge:1',
      method: 'navide/host/call',
      params: {
        origin: { kind: 'call', requestId: 'parent-1' },
        port: 'filesystem',
        operation: 'resolve_root',
        arguments: { workspace_path: '/workspace' },
      },
    }))).toEqual({
      kind: 'bridge-request',
      id: 'bridge:1',
      origin: { kind: 'call', requestId: 'parent-1' },
      port: 'filesystem',
      operation: 'resolve_root',
      arguments: { workspace_path: '/workspace' },
    })
    expect(() => parseBackendWireHostFrame(JSON.stringify({
      jsonrpc: '2.0',
      id: 'bridge:2',
      method: 'navide/host/call',
      params: {
        origin: { kind: 'call', requestId: 'parent-1' },
        port: 'filesystem',
        operation: 'resolve_root',
        arguments: { workspace_path: '/workspace' },
        runtime,
      },
    }))).toThrow('Backend plugin returned an invalid protocol message.')
    expect(() => parseBackendWireHostFrame(JSON.stringify({
      jsonrpc: '2.0',
      id: 'bridge:',
      method: 'navide/host/call',
      params: {
        origin: { kind: 'call', requestId: 'parent-1' },
        port: 'filesystem',
        operation: 'resolve_root',
        arguments: { workspace_path: '/workspace' },
      },
    }))).toThrow('Backend plugin returned an invalid protocol message.')
  })
})
