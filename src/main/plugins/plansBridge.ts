/**
 * Host-private Plans-to-core port inventory and adapter composition.
 *
 * This module is intentionally not exported through the plugin SDK. A packaged
 * child can address only the validated `port`/`operation` pair below; it never
 * receives a filesystem handle, WebSocket, route table, terminal object, or
 * runtime identity. The supervisor supplies the authenticated runtime to the
 * adapter context after resolving the child request's parent origin.
 */

import {
  mkdirSync,
  closeSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch as watchPath,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type {
  BackendRuntimeContext,
  JsonValue,
  WireRequestId,
} from './pluginBackendSupervisor'
import {
  MAX_BACKEND_BRIDGE_CHUNK_BYTES,
  MAX_BACKEND_BRIDGE_QUEUE_BYTES,
  MAX_BACKEND_BRIDGE_RESULT_BYTES,
} from './pluginBackendLimits'
import {
  canonicalExistingDirectory,
  resolveWorkspaceRelativePath,
  workspaceMutationPathError,
} from './workspacePathPolicy'

export const PLANS_BRIDGE_PORTS = [
  'filesystem',
  'workspace-storage',
  'terminal',
  'agent-messaging',
  'routes',
  'streams',
  'spawn',
] as const

export type PlansBridgePort = (typeof PLANS_BRIDGE_PORTS)[number]

export type PlansBridgeErrorCode =
  | 'CAPABILITY_DENIED'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'WORKSPACE_SCOPE_VIOLATION'
  | 'USER_CANCELLED'
  | 'TIMEOUT'
  | 'RESOURCE_LIMIT'
  | 'RESULT_TOO_LARGE'
  | 'BACKEND_UNAVAILABLE'
  | 'PLUGIN_STOPPING'
  | 'INTERNAL_ERROR'

export class PlansBridgeError extends Error {
  readonly code: PlansBridgeErrorCode

  constructor(code: PlansBridgeErrorCode, message?: string) {
    super(message)
    this.name = 'PlansBridgeError'
    this.code = code
  }
}

export interface PlansBridgeOrigin {
  kind: 'call' | 'subscription'
  requestId: WireRequestId
}

export interface PlansBridgeRequest {
  id: WireRequestId
  origin: PlansBridgeOrigin
  port: PlansBridgePort
  operation: string
  arguments: JsonValue
}

export interface PlansBridgeContext {
  readonly runtime: BackendRuntimeContext
  /** Host-bound workspace path; never serialized into the child request. */
  readonly workspacePath?: string
  /** Canonical Host-authorized Plans repository root; never payload-selected. */
  readonly authorizedPlanRoot?: string
  readonly requestId: WireRequestId
  readonly signal: AbortSignal
  /** Emit one bounded internal stream event back to the child. */
  emit(event: string, payload: JsonValue): void
}

export interface PlansFilesystemPort {
  readFile(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  writeFile(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  listDir(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  listFilesFlat(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  statPath(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  delete(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  rename(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  resolveRoot(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  watch(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansWorkspaceStoragePort {
  get(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  set(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  delete(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansTerminalPort {
  create(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  input(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  resize(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  interrupt(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  kill(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  reattach(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  redraw(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansAgentMessagingPort {
  list(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  send(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  subscribe(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansRoutesPort {
  invoke(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansStreamsPort {
  open(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  write(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  end(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  cancel(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansSpawnPort {
  transform(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansCorePorts {
  filesystem: PlansFilesystemPort
  workspaceStorage: PlansWorkspaceStoragePort
  terminal: PlansTerminalPort
  agentMessaging: PlansAgentMessagingPort
  routes: PlansRoutesPort
  streams: PlansStreamsPort
  spawn: PlansSpawnPort
}

export interface BackendBridgeDispatcher {
  dispatch(request: PlansBridgeRequest, context: PlansBridgeContext): Promise<JsonValue>
}

type PortOperation = {
  [P in PlansBridgePort]: readonly string[]
}

const PORT_OPERATIONS: PortOperation = {
  filesystem: [
    'read_file',
    'write_file',
    'list_dir',
    'list_files_flat',
    'stat_path',
    'delete',
    'rename',
    'resolve_root',
    'watch',
  ],
  'workspace-storage': ['get', 'set', 'delete'],
  terminal: ['create', 'input', 'resize', 'interrupt', 'kill', 'reattach', 'redraw'],
  'agent-messaging': ['list', 'send', 'subscribe'],
  routes: ['invoke'],
  streams: ['open', 'write', 'end', 'cancel'],
  spawn: ['transform'],
}

export function isPlansBridgePort(value: unknown): value is PlansBridgePort {
  return typeof value === 'string' && (PLANS_BRIDGE_PORTS as readonly string[]).includes(value)
}

export function isPlansBridgeOrigin(value: unknown): value is PlansBridgeOrigin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 2 &&
    (record.kind === 'call' || record.kind === 'subscription') &&
    ((typeof record.requestId === 'string' && record.requestId.length > 0) ||
      (typeof record.requestId === 'number' && Number.isInteger(record.requestId) && Number.isFinite(record.requestId)))
  )
}

export function isPlansBridgeOperation(port: PlansBridgePort, value: unknown): value is string {
  return typeof value === 'string' && PORT_OPERATIONS[port].includes(value)
}

function recordArguments(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlansBridgeError('INVALID_ARGUMENT', 'Bridge arguments must be an object.')
  }
  return value as Record<string, JsonValue>
}

function requiredString(arguments_: JsonValue, key: string): string {
  const value = recordArguments(arguments_)[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlansBridgeError('INVALID_ARGUMENT', `Bridge argument '${key}' is invalid.`)
  }
  return value
}

function pathString(arguments_: JsonValue, key: string): string {
  const value = recordArguments(arguments_)[key]
  if (typeof value !== 'string') {
    throw new PlansBridgeError('INVALID_ARGUMENT', `Bridge argument '${key}' is invalid.`)
  }
  return value
}

function authorizedPlanRoot(context: PlansBridgeContext): string {
  const root = context.authorizedPlanRoot
  if (!root) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
  const canonical = canonicalExistingDirectory(root)
  if (!canonical || canonical !== root) {
    throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
  }
  return canonical
}

function safePlanPath(
  arguments_: JsonValue,
  key: string,
  context: PlansBridgeContext,
  allowRoot = true,
): string {
  const relPath = pathString(arguments_, key)
  if (relPath.includes('\u0000')) {
    throw new PlansBridgeError('INVALID_ARGUMENT', `Bridge argument '${key}' is invalid.`)
  }
  const candidate = resolveWorkspaceRelativePath(authorizedPlanRoot(context), relPath, allowRoot)
  if (!candidate) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
  return candidate
}

function exactPathArguments(
  arguments_: JsonValue,
  key: string,
  context: PlansBridgeContext,
  allowRoot = true,
): string {
  exactArguments(arguments_, [key])
  return safePlanPath(arguments_, key, context, allowRoot)
}

function mutationPath(context: PlansBridgeContext, path: string): string {
  const violation = workspaceMutationPathError(authorizedPlanRoot(context), path)
  if (violation) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION', violation)
  return path
}

function exactArguments(arguments_: JsonValue, expectedKeys: readonly string[]): void {
  const values = recordArguments(arguments_)
  if (Object.keys(values).some((key) => !expectedKeys.includes(key)) ||
      expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(values, key))) {
    throw new PlansBridgeError('INVALID_ARGUMENT')
  }
}

function readFileBounded(path: string): string {
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(MAX_BACKEND_BRIDGE_RESULT_BYTES + 1)
  let offset = 0
  try {
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (count === 0) break
      offset += count
    }
  } finally {
    closeSync(fd)
  }
  if (offset > MAX_BACKEND_BRIDGE_RESULT_BYTES) {
    throw new PlansBridgeError('RESULT_TOO_LARGE', 'Workspace file exceeds the Bridge result limit.')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
  } catch {
    throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file is not valid UTF-8.')
  }
}

function ensureWorkspaceRuntime(context: PlansBridgeContext): void {
  if (
    typeof context.runtime.pluginId !== 'string' ||
    context.runtime.pluginId.length === 0 ||
    typeof context.runtime.packageVersion !== 'string' ||
    context.runtime.packageVersion.length === 0 ||
    typeof context.runtime.workspaceId !== 'string' ||
    context.runtime.workspaceId.length === 0
  ) {
    throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
  }
}

function runtimeOwnerKey(runtime: BackendRuntimeContext): string {
  return JSON.stringify([
    runtime.pluginId,
    runtime.packageVersion,
    runtime.workspaceId,
    runtime.instanceId,
    runtime.contributionKey,
    runtime.hostWindowId,
  ])
}

function deniedPort<T extends object>(port: string): T {
  const fail = async (): Promise<JsonValue> => {
    throw new PlansBridgeError('CAPABILITY_DENIED', `Plans port '${port}' is not connected.`)
  }
  return fail as unknown as T
}

function deniedCorePorts(): PlansCorePorts {
  return {
    filesystem: {
      readFile: deniedPort('filesystem'),
      writeFile: deniedPort('filesystem'),
      listDir: deniedPort('filesystem'),
      listFilesFlat: deniedPort('filesystem'),
      statPath: deniedPort('filesystem'),
      delete: deniedPort('filesystem'),
      rename: deniedPort('filesystem'),
      resolveRoot: deniedPort('filesystem'),
      watch: deniedPort('filesystem'),
    },
    workspaceStorage: {
      get: deniedPort('workspace-storage'),
      set: deniedPort('workspace-storage'),
      delete: deniedPort('workspace-storage'),
    },
    terminal: {
      create: deniedPort('terminal'),
      input: deniedPort('terminal'),
      resize: deniedPort('terminal'),
      interrupt: deniedPort('terminal'),
      kill: deniedPort('terminal'),
      reattach: deniedPort('terminal'),
      redraw: deniedPort('terminal'),
    },
    agentMessaging: {
      list: deniedPort('agent-messaging'),
      send: deniedPort('agent-messaging'),
      subscribe: deniedPort('agent-messaging'),
    },
    routes: { invoke: deniedPort('routes') },
    streams: {
      open: deniedPort('streams'),
      write: deniedPort('streams'),
      end: deniedPort('streams'),
      cancel: deniedPort('streams'),
    },
    spawn: { transform: deniedPort('spawn') },
  }
}

export function createPlansBridgeDispatcher(ports: PlansCorePorts): BackendBridgeDispatcher {
  return Object.freeze({
    async dispatch(request: PlansBridgeRequest, context: PlansBridgeContext): Promise<JsonValue> {
      if (context.signal.aborted) {
        throw new PlansBridgeError('USER_CANCELLED')
      }
      if (!isPlansBridgePort(request.port) || !isPlansBridgeOperation(request.port, request.operation)) {
        throw new PlansBridgeError('METHOD_NOT_FOUND')
      }
      switch (request.port) {
        case 'filesystem': {
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            read_file: ports.filesystem.readFile.bind(ports.filesystem),
            write_file: ports.filesystem.writeFile.bind(ports.filesystem),
            list_dir: ports.filesystem.listDir.bind(ports.filesystem),
            list_files_flat: ports.filesystem.listFilesFlat.bind(ports.filesystem),
            stat_path: ports.filesystem.statPath.bind(ports.filesystem),
            delete: ports.filesystem.delete.bind(ports.filesystem),
            rename: ports.filesystem.rename.bind(ports.filesystem),
            resolve_root: ports.filesystem.resolveRoot.bind(ports.filesystem),
            watch: ports.filesystem.watch.bind(ports.filesystem),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'workspace-storage': {
          ensureWorkspaceRuntime(context)
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            get: ports.workspaceStorage.get.bind(ports.workspaceStorage),
            set: ports.workspaceStorage.set.bind(ports.workspaceStorage),
            delete: ports.workspaceStorage.delete.bind(ports.workspaceStorage),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'terminal': {
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            create: ports.terminal.create.bind(ports.terminal),
            input: ports.terminal.input.bind(ports.terminal),
            resize: ports.terminal.resize.bind(ports.terminal),
            interrupt: ports.terminal.interrupt.bind(ports.terminal),
            kill: ports.terminal.kill.bind(ports.terminal),
            reattach: ports.terminal.reattach.bind(ports.terminal),
            redraw: ports.terminal.redraw.bind(ports.terminal),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'agent-messaging': {
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            list: ports.agentMessaging.list.bind(ports.agentMessaging),
            send: ports.agentMessaging.send.bind(ports.agentMessaging),
            subscribe: ports.agentMessaging.subscribe.bind(ports.agentMessaging),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'routes':
          return ports.routes.invoke.call(ports.routes, request.arguments, context)
        case 'streams': {
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            open: ports.streams.open.bind(ports.streams),
            write: ports.streams.write.bind(ports.streams),
            end: ports.streams.end.bind(ports.streams),
            cancel: ports.streams.cancel.bind(ports.streams),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'spawn':
          return ports.spawn.transform.call(ports.spawn, request.arguments, context)
      }
    },
  })
}

function createProductionFilesystemPort(): PlansFilesystemPort {
  const emitChanged = (context: PlansBridgeContext, root: string, event: string, path: string | null): void => {
    if (context.signal.aborted) return
    context.emit('filesystem.changed', {
      workspace_path: root,
      event,
      ...(path === null ? {} : { path }),
    })
  }
  const watcher = async (arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue> => {
    const root = exactPathArguments(arguments_, 'rel_path', context)
    if (!canonicalExistingDirectory(root)) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    let watcherHandle: FSWatcher | undefined
    try {
      watcherHandle = watchPath(root, { recursive: true }, (event, filename) => {
        emitChanged(context, root, event, filename ? String(filename) : null)
      })
    } catch {
      // Linux does not support recursive fs.watch. Watching the workspace root
      // still gives the package a bounded change signal and keeps the adapter
      // available on every supported Host platform.
      try {
        watcherHandle = watchPath(root, (event, filename) => {
          emitChanged(context, root, event, filename ? String(filename) : null)
        })
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace watcher is unavailable.')
      }
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false
      const finish = (error?: PlansBridgeError): void => {
        if (settled) return
        settled = true
        context.signal.removeEventListener('abort', onAbort)
        watcherHandle?.removeListener('error', onError)
        watcherHandle?.removeListener('close', onClose)
        if (error) rejectPromise(error)
        else resolvePromise()
      }
      const onAbort = (): void => {
        watcherHandle?.close()
        finish()
      }
      const onError = (): void => {
        watcherHandle?.close()
        finish(new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace watcher failed.'))
      }
      const onClose = (): void => {
        if (context.signal.aborted) finish()
        else finish(new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace watcher closed.'))
      }
      watcherHandle?.on('error', onError)
      watcherHandle?.on('close', onClose)
      if (context.signal.aborted) {
        onAbort()
        return
      }
      context.signal.addEventListener('abort', onAbort, { once: true })
    })
    return null
  }
  return {
    async readFile(arguments_, context) {
      const file = exactPathArguments(arguments_, 'rel_path', context)
      try {
        return { content: readFileBounded(file) }
      } catch (error) {
        if (error instanceof PlansBridgeError) throw error
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file is unavailable.')
      }
    },
    async writeFile(arguments_, context) {
      const values = recordArguments(arguments_)
      exactArguments(arguments_, ['rel_path', 'content'])
      const file = mutationPath(context, safePlanPath(arguments_, 'rel_path', context, false))
      if (typeof values.content !== 'string') throw new PlansBridgeError('INVALID_ARGUMENT')
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, values.content, 'utf8')
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file could not be written.')
      }
      return { ok: true }
    },
    async listDir(arguments_, context) {
      const directory = exactPathArguments(arguments_, 'rel_path', context)
      try {
        return { entries: readdirSync(directory) }
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace directory is unavailable.')
      }
    },
    async listFilesFlat(arguments_, context) {
      const directory = exactPathArguments(arguments_, 'rel_path', context)
      try {
        return {
          entries: readdirSync(directory).filter((entry) => extname(entry) !== ''),
        }
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace directory is unavailable.')
      }
    },
    async statPath(arguments_, context) {
      const path = exactPathArguments(arguments_, 'rel_path', context)
      try {
        const entry = statSync(path)
        return { exists: true, isDirectory: entry.isDirectory(), size: entry.size }
      } catch {
        return { exists: false, isDirectory: false, size: 0 }
      }
    },
    async delete(arguments_, context) {
      const path = mutationPath(context, exactPathArguments(arguments_, 'rel_path', context, false))
      try {
        rmSync(path, { recursive: true, force: false })
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace path could not be deleted.')
      }
      return { ok: true }
    },
    async rename(arguments_, context) {
      exactArguments(arguments_, ['from', 'to'])
      const from = mutationPath(context, safePlanPath(arguments_, 'from', context, false))
      const to = mutationPath(context, safePlanPath(arguments_, 'to', context, false))
      try {
        mkdirSync(dirname(to), { recursive: true })
        renameSync(from, to)
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace path could not be renamed.')
      }
      return { ok: true }
    },
    async resolveRoot(arguments_, context) {
      exactArguments(arguments_, [])
      return { root: authorizedPlanRoot(context) }
    },
    watch: watcher,
  }
}

function createProductionStoragePort(): PlansWorkspaceStoragePort {
  return {
    async get() {
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace storage adapter is not connected.')
    },
    async set() {
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace storage adapter is not connected.')
    },
    async delete() {
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace storage adapter is not connected.')
    },
  }
}

export function createProductionPlansCorePorts(
  overrides: Partial<PlansCorePorts> = {},
): PlansCorePorts {
  const denied = deniedCorePorts()
  return {
    ...denied,
    ...overrides,
    filesystem: overrides.filesystem ?? createProductionFilesystemPort(),
    workspaceStorage: overrides.workspaceStorage ?? createProductionStoragePort(),
  }
}

interface InMemoryWatch {
  readonly root: string
  readonly context: PlansBridgeContext
}

interface InMemoryOwnedStream {
  readonly owner: string
  usedBytes: number
}

export interface InMemoryPlansCoreOptions {
  files?: Readonly<Record<string, string>>
  root?: string
}

function workspaceRootFor(context: PlansBridgeContext, fallback: string): string {
  return resolve(context.authorizedPlanRoot ?? fallback)
}

function virtualMutationPathError(root: string, candidate: string): string | null {
  const resolvedCandidate = resolve(candidate)
  if (resolvedCandidate !== root && !resolvedCandidate.startsWith(`${root}${sep}`)) {
    return 'path escapes the Host workspace binding'
  }
  if (resolvedCandidate === root) return 'workspace root cannot be mutated'
  const relativePath = resolvedCandidate.slice(root.length).replace(/^[/\\]/u, '')
  if (relativePath.split(/[\\/]/u).some((segment) => segment === '.git')) {
    return 'Git metadata paths are protected'
  }
  return null
}

export function createInMemoryPlansCorePorts(options: InMemoryPlansCoreOptions = {}): PlansCorePorts {
  const root = resolve(options.root ?? '/workspace')
  const files = new Map(Object.entries(options.files ?? {}))
  const storage = new Map<string, JsonValue>()
  const sessions = new Map<string, string>()
  const streams = new Map<string, InMemoryOwnedStream>()
  const watchers = new Set<InMemoryWatch>()
  const notify = (path: string, event: string): void => {
    for (const watcher of watchers) {
      const prefix = watcher.root.endsWith(sep) ? watcher.root : `${watcher.root}${sep}`
      if (path !== watcher.root && !path.startsWith(prefix)) continue
      watcher.context.emit('filesystem.changed', { workspace_path: watcher.root, event, path })
    }
  }
  const pathFor = (
    arguments_: JsonValue,
    context?: PlansBridgeContext,
    pathKey = 'rel_path',
    allowRoot = true,
  ): string => {
    const workspace = context?.authorizedPlanRoot ?? root
    if (resolve(workspace) !== root) {
      throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    }
    const relPath = pathString(arguments_, pathKey)
    if (relPath.includes('\u0000')) {
      throw new PlansBridgeError('INVALID_ARGUMENT')
    }
    const normalized = relPath.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) {
      throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    }
    const candidate = resolve(workspace, normalized)
    const prefix = workspace.endsWith(sep) ? workspace : `${workspace}${sep}`
    if (candidate !== workspace && !candidate.startsWith(prefix)) {
      throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    }
    if (!allowRoot && candidate === workspace) {
      throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    }
    return candidate
  }
  const ownerFor = (context: PlansBridgeContext): string => runtimeOwnerKey(context.runtime)
  const filesystem: PlansFilesystemPort = {
    async readFile(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      const path = pathFor(arguments_, context)
      const content = files.get(path)
      if (content === undefined) throw new PlansBridgeError('BACKEND_UNAVAILABLE')
      if (Buffer.byteLength(content, 'utf8') > MAX_BACKEND_BRIDGE_RESULT_BYTES) {
        throw new PlansBridgeError('RESULT_TOO_LARGE', 'Workspace file exceeds the Bridge result limit.')
      }
      return { content }
    },
    async writeFile(arguments_, context) {
      const values = recordArguments(arguments_)
      exactArguments(arguments_, ['rel_path', 'content'])
      if (typeof values.content !== 'string') throw new PlansBridgeError('INVALID_ARGUMENT')
      const path = pathFor(arguments_, context)
      if (virtualMutationPathError(workspaceRootFor(context, root), path)) {
        throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      }
      files.set(path, values.content)
      notify(path, 'change')
      return { ok: true }
    },
    async listDir(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      const directory = pathFor(arguments_, context)
      const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`
      const entries = new Set<string>()
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) entries.add(path.slice(prefix.length).split(sep)[0])
      }
      return { entries: [...entries] }
    },
    async listFilesFlat(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      return filesystem.listDir(arguments_, context)
    },
    async statPath(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      const path = pathFor(arguments_, context)
      const content = files.get(path)
      return {
        exists: content !== undefined,
        isDirectory: false,
        size: content === undefined ? 0 : Buffer.byteLength(content, 'utf8'),
      }
    },
    async delete(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      const path = pathFor(arguments_, context, 'rel_path', false)
      if (virtualMutationPathError(workspaceRootFor(context, root), path)) {
        throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      }
      files.delete(path)
      notify(path, 'delete')
      return { ok: true }
    },
    async rename(arguments_, context) {
      exactArguments(arguments_, ['from', 'to'])
      const from = pathFor(arguments_, context, 'from', false)
      const to = pathFor(arguments_, context, 'to', false)
      if (virtualMutationPathError(workspaceRootFor(context, root), from) ||
          virtualMutationPathError(workspaceRootFor(context, root), to)) {
        throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      }
      const content = files.get(from)
      if (content !== undefined) {
        files.delete(from)
        files.set(to, content)
      }
      notify(to, 'rename')
      return { ok: true }
    },
    async resolveRoot(arguments_, context) {
      exactArguments(arguments_, [])
      const workspace = workspaceRootFor(context, root)
      if (workspace !== root) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      return { root }
    },
    async watch(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      const watchRoot = pathFor(arguments_, context)
      if (watchRoot !== root) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      const registration = { root: watchRoot, context }
      watchers.add(registration)
      await new Promise<void>((resolvePromise) => {
        const close = (): void => {
          watchers.delete(registration)
          resolvePromise()
        }
        if (context.signal.aborted) close()
        else context.signal.addEventListener('abort', close, { once: true })
      })
      return null
    },
  }
  const workspaceStorage: PlansWorkspaceStoragePort = {
    async get(arguments_, context) {
      const values = recordArguments(arguments_)
      const key = storageKey(values, context, ['scope', 'key'])
      return { found: storage.has(key), ...(storage.has(key) ? { value: storage.get(key)! } : {}) }
    },
    async set(arguments_, context) {
      const values = recordArguments(arguments_)
      const key = storageKey(values, context, ['scope', 'key', 'value'])
      if (!Object.prototype.hasOwnProperty.call(values, 'value') || !isJsonValue(values.value)) {
        throw new PlansBridgeError('INVALID_ARGUMENT')
      }
      storage.set(key, values.value)
      return null
    },
    async delete(arguments_, context) {
      const values = recordArguments(arguments_)
      const key = storageKey(values, context, ['scope', 'key'])
      const deleted = storage.delete(key)
      return deleted
    },
  }
  const terminal: PlansTerminalPort = {
    async create(_arguments_, context) {
      const id = `terminal-${randomUUID()}`
      sessions.set(id, ownerFor(context))
      return { terminal_session_id: id }
    },
    async input(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
    async resize(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
    async interrupt(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
    async kill(arguments_, context) {
      const id = requireSession(arguments_, sessions, context)
      sessions.delete(id)
      return { ok: true }
    },
    async reattach(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
    async redraw(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
  }
  const agentMessaging: PlansAgentMessagingPort = {
    async list() { return { agents: [] } },
    async send() { return { ok: true } },
    async subscribe() { return { ok: true } },
  }
  const routes: PlansRoutesPort = {
    async invoke(arguments_, context) {
      const values = recordArguments(arguments_)
      if (values.route !== 'plans.resolve_root' || Object.keys(values).length !== 1) {
        throw new PlansBridgeError('METHOD_NOT_FOUND')
      }
      return filesystem.resolveRoot({}, context)
    },
  }
  const streamsPort: PlansStreamsPort = {
    async open(_arguments_, context) {
      const id = `stream-${randomUUID()}`
      streams.set(id, { owner: ownerFor(context), usedBytes: 0 })
      return { stream_id: id, credit_bytes: MAX_BACKEND_BRIDGE_QUEUE_BYTES }
    },
    async write(arguments_, context) {
      const values = recordArguments(arguments_)
      const id = requiredString(arguments_, 'stream_id')
      const stream = streams.get(id)
      if (!stream) throw new PlansBridgeError('INVALID_ARGUMENT')
      if (stream.owner !== ownerFor(context)) throw new PlansBridgeError('CAPABILITY_DENIED')
      if (typeof values.chunk_base64 !== 'string') throw new PlansBridgeError('INVALID_ARGUMENT')
      const bytes = Buffer.from(values.chunk_base64, 'base64')
      if (bytes.length > MAX_BACKEND_BRIDGE_CHUNK_BYTES) throw new PlansBridgeError('RESOURCE_LIMIT')
      const usedBytes = stream.usedBytes
      if (usedBytes + bytes.length > MAX_BACKEND_BRIDGE_QUEUE_BYTES) {
        throw new PlansBridgeError('RESOURCE_LIMIT')
      }
      stream.usedBytes = usedBytes + bytes.length
      return { accepted_bytes: bytes.length, credit_bytes: MAX_BACKEND_BRIDGE_QUEUE_BYTES - usedBytes - bytes.length }
    },
    async end(arguments_, context) {
      const id = requireStream(arguments_, streams, context)
      streams.delete(id)
      return { ok: true }
    },
    async cancel(arguments_, context) {
      const id = requireStream(arguments_, streams, context)
      streams.delete(id)
      return { ok: true }
    },
  }
  return {
    filesystem,
    workspaceStorage,
    terminal,
    agentMessaging,
    routes,
    streams: streamsPort,
    spawn: {
      async transform(arguments_) {
        if (!isJsonValue(arguments_)) throw new PlansBridgeError('INVALID_ARGUMENT')
        return arguments_
      },
    },
  }
}

function storageKey(
  values: Record<string, JsonValue>,
  context: PlansBridgeContext,
  allowedKeys: readonly string[],
): string {
  if (Object.keys(values).some((key) => !allowedKeys.includes(key))) {
    throw new PlansBridgeError('INVALID_ARGUMENT')
  }
  if (values.scope !== 'plugin' && values.scope !== 'workspace') {
    throw new PlansBridgeError('INVALID_ARGUMENT')
  }
  if (typeof values.key !== 'string' || values.key.length === 0 || values.key.includes('\u0000')) {
    throw new PlansBridgeError('INVALID_ARGUMENT')
  }
  if (values.scope === 'workspace') ensureWorkspaceRuntime(context)
  return [
    context.runtime.pluginId,
    context.runtime.packageVersion,
    values.scope,
    values.scope === 'workspace' ? context.runtime.workspaceId : '',
    values.key,
  ].join('\u0000')
}

function requireSession(
  arguments_: JsonValue,
  sessions: Map<string, string>,
  context: PlansBridgeContext,
): string {
  const id = requiredString(arguments_, 'terminal_session_id')
  if (sessions.get(id) !== runtimeOwnerKey(context.runtime)) throw new PlansBridgeError('CAPABILITY_DENIED')
  return id
}

function requireStream(
  arguments_: JsonValue,
  streams: Map<string, InMemoryOwnedStream>,
  context: PlansBridgeContext,
): string {
  const id = requiredString(arguments_, 'stream_id')
  const stream = streams.get(id)
  const owner = runtimeOwnerKey(context.runtime)
  if (!stream) throw new PlansBridgeError('INVALID_ARGUMENT')
  if (stream.owner !== owner) throw new PlansBridgeError('CAPABILITY_DENIED')
  return id
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || value === null || seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.values(value).every((item) => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

/** Default Host composition: real filesystem/watch port, other ports fail closed until their core owners are injected. */
export function createProductionPlansBridgeDispatcher(
  overrides: Partial<PlansCorePorts> = {},
): BackendBridgeDispatcher {
  return createPlansBridgeDispatcher(createProductionPlansCorePorts(overrides))
}

export function createInMemoryPlansBridgeDispatcher(
  options: InMemoryPlansCoreOptions = {},
): BackendBridgeDispatcher {
  return createPlansBridgeDispatcher(createInMemoryPlansCorePorts(options))
}
