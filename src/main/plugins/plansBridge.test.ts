import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  createInMemoryPlansCorePorts,
  createInMemoryPlansBridgeDispatcher,
  createProductionPlansCorePorts,
  createProductionPlansBridgeDispatcher,
  type BackendBridgeDispatcher,
  type PlansBridgeContext,
  type PlansBridgeRequest,
} from './plansBridge'
import type { BackendRuntimeContext } from './pluginBackendSupervisor'
import {
  MAX_BACKEND_BRIDGE_RESULT_BYTES,
  MAX_BACKEND_BRIDGE_CHUNK_BYTES,
} from './pluginBackendLimits'

const runtime = {
  pluginId: 'navide.plans',
  packageVersion: '0.1.93',
  workspaceId: 'workspace-1',
  instanceId: 'view-1',
  contributionKey: 'navide.plans.window',
  hostWindowId: 'window-1',
} as const

function context(
  signal: AbortSignal,
  events: Array<{ event: string; payload: unknown }> = [],
  workspacePath?: string,
  runtimeValue: BackendRuntimeContext = runtime,
  authorizedPlanRoot = workspacePath,
): PlansBridgeContext {
  return {
    runtime: runtimeValue,
    ...(workspacePath === undefined ? {} : { workspacePath }),
    ...(authorizedPlanRoot === undefined ? {} : { authorizedPlanRoot }),
    requestId: 'bridge:test',
    signal,
    emit: (event, payload) => events.push({ event, payload }),
  }
}

function request(
  port: PlansBridgeRequest['port'],
  operation: string,
  arguments_: PlansBridgeRequest['arguments'],
): PlansBridgeRequest {
  return {
    id: 'bridge:test',
    origin: { kind: 'call', requestId: 'call-1' },
    port,
    operation,
    arguments: arguments_,
  }
}

async function runCoreCorpus(create: () => ReturnType<typeof createInMemoryPlansBridgeDispatcher>) {
  const dispatcher = create()
  const controller = new AbortController()
  const bridgeContext = context(controller.signal, [], '/workspace')

  await expect(dispatcher.dispatch(
    request('filesystem', 'resolve_root', {}),
    bridgeContext,
  )).resolves.toEqual({ root: '/workspace' })

  await expect(dispatcher.dispatch(
    request('filesystem', 'rename', {
      from: 'old-plan.md',
      to: 'new-plan.md',
    }),
    bridgeContext,
  )).resolves.toEqual({ ok: true })

  await expect(dispatcher.dispatch(
    request('workspace-storage', 'set', { scope: 'workspace', key: 'draft', value: { version: 1 } }),
    bridgeContext,
  )).resolves.toBeNull()
  await expect(dispatcher.dispatch(
    request('workspace-storage', 'get', { scope: 'workspace', key: 'draft' }),
    bridgeContext,
  )).resolves.toEqual({ found: true, value: { version: 1 } })

  await expect(dispatcher.dispatch(
    request('streams', 'open', null),
    bridgeContext,
  )).resolves.toMatchObject({ credit_bytes: expect.any(Number) })
  await expect(dispatcher.dispatch(
    request('spawn', 'transform', { command: 'python', args: ['-c', 'pass'] }),
    bridgeContext,
  )).resolves.toEqual({ command: 'python', args: ['-c', 'pass'] })
  await expect(dispatcher.dispatch(
    request('filesystem', 'unknown', null),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' })

  const watcher = dispatcher.dispatch(
    request('filesystem', 'watch', { rel_path: '' }),
    bridgeContext,
  )
  controller.abort()
  await expect(watcher).resolves.toBeNull()
}

function createProductionCorpusDispatcher(): BackendBridgeDispatcher {
  const injectedCore = createInMemoryPlansCorePorts({ root: process.cwd() })
  return createProductionPlansBridgeDispatcher({
    // The production composition owns the filesystem/watch implementation;
    // the remaining core owners are explicit dependencies until their
    // production lifecycle is activated by Issue 23E.
    workspaceStorage: injectedCore.workspaceStorage,
    terminal: injectedCore.terminal,
    agentMessaging: injectedCore.agentMessaging,
    routes: injectedCore.routes,
    streams: injectedCore.streams,
    spawn: injectedCore.spawn,
  })
}

async function runAdapterCorpus(
  create: () => BackendBridgeDispatcher,
): Promise<void> {
  const dispatcher = create()
  const workspacePath = process.cwd()
  const controller = new AbortController()
  const bridgeContext = context(controller.signal, [], workspacePath)

  await expect(dispatcher.dispatch(
    request('filesystem', 'resolve_root', {}),
    bridgeContext,
  )).resolves.toEqual({ root: workspacePath })

  await expect(dispatcher.dispatch(
    request('filesystem', 'delete', { rel_path: '' }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
  await expect(dispatcher.dispatch(
    request('filesystem', 'write_file', { rel_path: '', content: 'root' }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
  await expect(dispatcher.dispatch(
    request('filesystem', 'list_dir', { rel_path: '', workspace_path: workspacePath }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

  await expect(dispatcher.dispatch(
    request('workspace-storage', 'set', { scope: 'workspace', key: 'filters', value: { open: true } }),
    bridgeContext,
  )).resolves.toBeNull()
  await expect(dispatcher.dispatch(
    request('workspace-storage', 'get', { scope: 'workspace', key: 'filters' }),
    bridgeContext,
  )).resolves.toEqual({ found: true, value: { open: true } })

  const opened = await dispatcher.dispatch(request('streams', 'open', null), bridgeContext)
  if (
    opened === null ||
    typeof opened !== 'object' ||
    Array.isArray(opened) ||
    typeof opened.stream_id !== 'string'
  ) throw new Error('Stream adapter returned an invalid stream id.')
  const streamId = opened.stream_id
  const fullChunk = Buffer.alloc(MAX_BACKEND_BRIDGE_CHUNK_BYTES).toString('base64')
  for (let index = 0; index < 4; index += 1) {
    await expect(dispatcher.dispatch(
      request('streams', 'write', { stream_id: streamId, chunk_base64: fullChunk }),
      bridgeContext,
    )).resolves.toEqual({
      accepted_bytes: MAX_BACKEND_BRIDGE_CHUNK_BYTES,
      credit_bytes: (3 - index) * MAX_BACKEND_BRIDGE_CHUNK_BYTES,
    })
  }
  await expect(dispatcher.dispatch(
    request('streams', 'write', { stream_id: streamId, chunk_base64: 'eA==' }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  await expect(dispatcher.dispatch(
    request('streams', 'write', {
      stream_id: streamId,
      chunk_base64: Buffer.alloc(MAX_BACKEND_BRIDGE_CHUNK_BYTES + 1).toString('base64'),
    }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  await expect(dispatcher.dispatch(
    request('streams', 'end', { stream_id: streamId }),
    bridgeContext,
  )).resolves.toEqual({ ok: true })

  await expect(dispatcher.dispatch(
    request('filesystem', 'read_file', { rel_path: '../other-workspace' }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })

  const watcher = dispatcher.dispatch(
    request('filesystem', 'watch', { rel_path: '' }),
    bridgeContext,
  )
  controller.abort()
  await expect(watcher).resolves.toBeNull()
}

describe('Plans Host Bridge ports', () => {
  it('keeps the in-memory adapter behind the explicit port contract', async () => {
    await runCoreCorpus(() => createInMemoryPlansBridgeDispatcher())
  })

  it('does not start an adapter operation after its context is cancelled', async () => {
    const dispatcher = createInMemoryPlansBridgeDispatcher()
    const controller = new AbortController()
    controller.abort()

    await expect(dispatcher.dispatch(
      request('terminal', 'create', null),
      context(controller.signal, [], '/workspace'),
    )).rejects.toMatchObject({ code: 'USER_CANCELLED' })
  })

  it('keeps in-memory terminal and stream resources bound to their runtime', async () => {
    const dispatcher = createInMemoryPlansBridgeDispatcher()
    const ownerController = new AbortController()
    const ownerContext = context(ownerController.signal)
    const otherContext = context(
      new AbortController().signal,
      [],
      undefined,
      { ...runtime, instanceId: 'view-2' },
    )
    const session = await dispatcher.dispatch(
      request('terminal', 'create', null),
      ownerContext,
    )
    const sessionId = (session as { terminal_session_id: string }).terminal_session_id
    await expect(dispatcher.dispatch(
      request('terminal', 'kill', { terminal_session_id: sessionId }),
      otherContext,
    )).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })

    const stream = await dispatcher.dispatch(request('streams', 'open', null), ownerContext)
    const streamId = (stream as { stream_id: string }).stream_id
    await expect(dispatcher.dispatch(
      request('streams', 'end', { stream_id: streamId }),
      otherContext,
    )).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
  })

  it('renames the requested source path in the in-memory filesystem adapter', async () => {
    const dispatcher = createInMemoryPlansBridgeDispatcher({
      root: '/workspace',
      files: { '/workspace/old-plan.md': 'draft' },
    })
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], '/workspace')

    await expect(dispatcher.dispatch(
      request('filesystem', 'rename', {
        from: 'old-plan.md',
        to: 'new-plan.md',
      }),
      bridgeContext,
    )).resolves.toEqual({ ok: true })
    await expect(dispatcher.dispatch(
      request('filesystem', 'read_file', { rel_path: 'new-plan.md' }),
      bridgeContext,
    )).resolves.toEqual({ content: 'draft' })
    await expect(dispatcher.dispatch(
      request('filesystem', 'read_file', { rel_path: 'old-plan.md' }),
      bridgeContext,
    )).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
  })

  it('protects Git metadata and symlink escapes on production mutations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-outside-'))
    const dispatcher = createProductionPlansBridgeDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(root, '.git', 'config'), 'safe', 'utf8')
    symlinkSync(outside, join(root, 'linked'))
    symlinkSync(join(root, 'missing-target'), join(root, 'dangling'))
    symlinkSync(root, join(root, 'root-link'))
    try {
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_file', { rel_path: '.git/hooks/pre-commit', content: 'bad' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'delete', { rel_path: '.git/config' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'rename', { from: 'notes.md', to: '.git/notes.md' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_file', { rel_path: 'linked/new.txt', content: 'escape' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_file', { rel_path: 'dangling/new.txt', content: 'escape' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'delete', { rel_path: 'root-link' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'rename', { from: 'root-link', to: 'notes.md' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('safe')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a filesystem read before it can exceed the bridge result bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-large-'))
    const dispatcher = createProductionPlansBridgeDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    writeFileSync(
      join(root, 'large.md'),
      Buffer.alloc(MAX_BACKEND_BRIDGE_RESULT_BYTES + 1, 0x61),
    )
    try {
      await expect(dispatcher.dispatch(
        request('filesystem', 'read_file', { rel_path: 'large.md' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['production composition', createProductionCorpusDispatcher],
    ['in-memory composition', () => createInMemoryPlansBridgeDispatcher({ root: process.cwd() })],
  ] as const)('passes the shared authorization, cancellation, stream, and backpressure corpus in the %s', async (_label, create) => {
    await runAdapterCorpus(create)
  })

  it('uses the same production dispatcher seam for the real filesystem root', async () => {
    const dispatcher = createProductionPlansBridgeDispatcher()
    const controller = new AbortController()
    await expect(dispatcher.dispatch(
      request('filesystem', 'resolve_root', {}),
      context(controller.signal, [], process.cwd()),
    )).resolves.toEqual({ root: process.cwd() })
    await expect(dispatcher.dispatch(
      request('workspace-storage', 'get', { scope: 'workspace', key: 'draft' }),
      context(controller.signal, [], process.cwd()),
    )).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
  })

  it('does not let a workspace storage payload choose its partition identity', async () => {
    const dispatcher = createInMemoryPlansBridgeDispatcher()
    const controller = new AbortController()
    await expect(dispatcher.dispatch(
      request('workspace-storage', 'set', {
        scope: 'workspace',
        key: 'draft',
        value: { pluginId: 'forged.plugin', workspaceId: 'forged-workspace' },
      }),
      context(controller.signal),
    )).resolves.toBeNull()
    await expect(dispatcher.dispatch(
      request('workspace-storage', 'get', { scope: 'workspace', key: 'draft' }),
      context(controller.signal),
    )).resolves.toEqual({
      found: true,
      value: { pluginId: 'forged.plugin', workspaceId: 'forged-workspace' },
    })
    await expect(dispatcher.dispatch(
      request('workspace-storage', 'get', {
        scope: 'workspace',
        key: 'draft',
        workspaceId: 'forged-workspace',
      }),
      context(controller.signal),
    )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it.each([
    ['production', () => createProductionPlansBridgeDispatcher()],
    ['in-memory', () => createInMemoryPlansBridgeDispatcher()],
  ] as const)('rejects a workspace path outside the Host binding in the %s adapter', async (_label, create) => {
    const dispatcher = create()
    const controller = new AbortController()
    await expect(dispatcher.dispatch(
      request('filesystem', 'read_file', { rel_path: '../other-workspace' }),
      context(controller.signal, [], '/workspace'),
    )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
  })
})
