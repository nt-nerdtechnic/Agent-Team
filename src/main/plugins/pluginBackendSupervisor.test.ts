import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendPluginError,
  createAuthenticatedBackendRuntime,
  MCP_PROTOCOL_REVISION,
  parseBackendWireFrame,
  PluginBackendSupervisor,
  type AuthenticatedBackendRuntime,
  type BackendPluginEvent,
  type BackendPluginLaunchSpec,
  type PluginBackendSupervisorOptions,
  type BackendRuntimeContext,
} from './pluginBackendSupervisor'

const fixture = fileURLToPath(new URL('./test-fixtures/backend-wire-child.mjs', import.meta.url))

const activation: BackendPluginLaunchSpec = {
  pluginId: 'acme.backend',
  packageVersion: '1.2.3',
  entryFile: fixture,
  protocolVersion: 1,
  activation: 'startup',
  approvedEvents: ['fixture.changed'],
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

function makeSupervisor(
  overrides: Partial<PluginBackendSupervisorOptions> = {}
): PluginBackendSupervisor {
  return new PluginBackendSupervisor(activation, {
    ...overrides,
    environment: overrides.environment ?? { NAVIDE_FIXTURE: 'backend-wire' },
    spawnProcess: (entryFile, options) =>
      spawn(process.execPath, [entryFile], {
        ...options,
        env: options.env,
      }) as ChildProcessWithoutNullStreams,
  })
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
      new BackendPluginError('INVALID_ARGUMENT')
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
    expect(error.stack).toBeUndefined()
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
})
