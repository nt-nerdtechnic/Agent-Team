import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { TextDecoder } from 'node:util'

/**
 * Private Electron-main seam for the unary subset of Backend Wire v1.
 * Catalog activation, subscriptions, events, and restart policy belong to
 * later runtime issues; this module owns one child and one in-flight call map.
 */
export const MCP_PROTOCOL_REVISION = '2026-07-28'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'
const PROTOCOL_ERROR_MESSAGE = 'Backend plugin returned an invalid protocol message.'
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const MAX_IGNORED_REQUEST_IDS = 256

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface BackendRuntimeContext {
  pluginId: string
  packageVersion: string
  workspaceId: string | null
  instanceId: string | null
  contributionKey: string | null
  hostWindowId: string | null
}

export interface BackendPluginLaunchSpec {
  pluginId: string
  packageVersion: string
  entryFile: string
  protocolVersion: 1
  activation: 'startup'
}

const AUTHENTICATED_RUNTIME = Symbol('navide.authenticatedBackendRuntime')

export type AuthenticatedBackendRuntime = BackendRuntimeContext & {
  readonly [AUTHENTICATED_RUNTIME]: true
}

export type BackendPluginErrorCode =
  | 'INVALID_ACTIVATION'
  | 'INVALID_RUNTIME'
  | 'INVALID_ARGUMENT'
  | 'NOT_READY'
  | 'TIMEOUT'
  | 'USER_CANCELLED'
  | 'PLUGIN_ERROR'
  | 'BACKEND_UNAVAILABLE'
  | 'PROTOCOL_ERROR'
  | 'PLUGIN_STOPPING'

const ERROR_MESSAGES: Record<BackendPluginErrorCode, string> = {
  INVALID_ACTIVATION: 'Backend plugin activation is invalid.',
  INVALID_RUNTIME: 'Backend runtime is invalid.',
  INVALID_ARGUMENT: 'Backend call arguments are invalid.',
  NOT_READY: 'Backend plugin is not ready.',
  TIMEOUT: 'Backend plugin call timed out.',
  USER_CANCELLED: 'Backend plugin call was cancelled.',
  PLUGIN_ERROR: 'Plugin request failed.',
  BACKEND_UNAVAILABLE: 'Backend plugin is unavailable.',
  PROTOCOL_ERROR: PROTOCOL_ERROR_MESSAGE,
  PLUGIN_STOPPING: 'Backend plugin is stopping.',
}

export class BackendPluginError extends Error {
  readonly code: BackendPluginErrorCode
  readonly requestId?: WireRequestId
  readonly pluginCode?: string

  constructor(
    code: BackendPluginErrorCode,
    message = ERROR_MESSAGES[code],
    options: { requestId?: WireRequestId; pluginCode?: string } = {}
  ) {
    super(message)
    this.name = 'BackendPluginError'
    this.code = code
    this.requestId = options.requestId
    this.pluginCode = options.pluginCode
  }
}

export type WireRequestId = string | number

export interface BackendPluginCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface PluginBackendClient {
  call<Result extends JsonValue>(
    name: string,
    args: JsonValue,
    options?: BackendPluginCallOptions
  ): Promise<Result>
}

export interface BackendServerInfo {
  name: string
  version: string
}

export interface BackendHealth {
  value: JsonValue
  serverInfo: BackendServerInfo
}

export interface PluginBackendSupervisorOptions {
  environment: Readonly<Record<string, string>>
  spawnProcess?: (entryFile: string, options: SpawnOptions) => ChildProcessWithoutNullStreams
  clientCapabilities?: { [key: string]: JsonValue }
  clientInfo?: { name: string; version: string }
  healthTimeoutMs?: number
  callTimeoutMs?: number
  shutdownTimeoutMs?: number
  maxFrameBytes?: number
  onStderr?: (chunk: string) => void
}

interface PendingRequest {
  readonly resolve: (response: BackendWireResponse) => void
  readonly reject: (error: BackendPluginError) => void
  readonly cleanup: () => void
}

interface SuccessResponse {
  kind: 'success'
  id: WireRequestId
  value: JsonValue
  serverInfo: BackendServerInfo
}

interface PluginErrorResponse {
  kind: 'plugin-error'
  id: WireRequestId
  pluginCode: string
}

interface ProtocolErrorResponse {
  kind: 'protocol-error'
  id: WireRequestId
}

type BackendWireResponse = SuccessResponse | PluginErrorResponse | ProtocolErrorResponse

type SupervisorState = 'idle' | 'starting' | 'ready' | 'failed' | 'closed'

class JsonScanner {
  private index = 0

  constructor(private readonly text: string) {}

  parse(): void {
    this.parseValue()
    if (this.index !== this.text.length) throw new Error('trailing JSON data')
  }

  private parseValue(): void {
    const character = this.text[this.index]
    if (character === '"') {
      this.parseString()
      return
    }
    if (character === '{') {
      this.parseObject()
      return
    }
    if (character === '[') {
      this.parseArray()
      return
    }
    if (character === 't') {
      this.parseLiteral('true')
      return
    }
    if (character === 'f') {
      this.parseLiteral('false')
      return
    }
    if (character === 'n') {
      this.parseLiteral('null')
      return
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      this.parseNumber()
      return
    }
    throw new Error('invalid JSON value')
  }

  private parseString(): string {
    const start = this.index
    this.index += 1
    while (this.index < this.text.length) {
      const character = this.text[this.index]
      if (character === '"') {
        this.index += 1
        return this.text.slice(start, this.index)
      }
      if (character === '\\') {
        const escape = this.text[this.index + 1]
        if (escape === 'u') {
          const digits = this.text.slice(this.index + 2, this.index + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new Error('invalid Unicode escape')
          this.index += 6
        } else if (escape && '"\\/bfnrt'.includes(escape)) {
          this.index += 2
        } else {
          throw new Error('invalid string escape')
        }
        continue
      }
      if (character.charCodeAt(0) < 0x20) throw new Error('control character in string')
      this.index += 1
    }
    throw new Error('unterminated string')
  }

  private parseObject(): void {
    this.index += 1
    const keys = new Set<string>()
    if (this.text[this.index] === '}') {
      this.index += 1
      return
    }
    while (true) {
      if (this.text[this.index] !== '"') throw new Error('object key is not a string')
      const rawKey = this.parseString()
      let key: unknown
      try {
        key = JSON.parse(rawKey)
      } catch {
        throw new Error('invalid object key')
      }
      if (typeof key !== 'string' || keys.has(key)) throw new Error('duplicate object key')
      keys.add(key)
      if (this.text[this.index] !== ':') throw new Error('object key has no value')
      this.index += 1
      this.parseValue()
      if (this.text[this.index] === '}') {
        this.index += 1
        return
      }
      if (this.text[this.index] !== ',') throw new Error('invalid object separator')
      this.index += 1
    }
  }

  private parseArray(): void {
    this.index += 1
    if (this.text[this.index] === ']') {
      this.index += 1
      return
    }
    while (true) {
      this.parseValue()
      if (this.text[this.index] === ']') {
        this.index += 1
        return
      }
      if (this.text[this.index] !== ',') throw new Error('invalid array separator')
      this.index += 1
    }
  }

  private parseLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      throw new Error('invalid JSON literal')
    }
    this.index += literal.length
  }

  private parseNumber(): void {
    const number = this.text
      .slice(this.index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0]
    if (!number) throw new Error('invalid JSON number')
    this.index += number.length
  }
}

export function parseBackendWireFrame(raw: Uint8Array | string): JsonValue {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
  if (bytes.length === 0) throw new Error(PROTOCOL_ERROR_MESSAGE)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (bytes.includes(0x0a) || bytes.includes(0x0d)) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (text.length === 0 || text.includes('\ufeff')) throw new Error(PROTOCOL_ERROR_MESSAGE)

  try {
    new JsonScanner(text).parse()
    const value: unknown = JSON.parse(text)
    if (!isJsonValue(value)) throw new Error('not a JSON value')
    return value
  } catch {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : isRecord(value) && Object.values(value).every((item) => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is { [key: string]: unknown } {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function isRequestId(value: unknown): value is WireRequestId {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value))
  )
}

function isClientMeta(value: unknown): value is { [key: string]: JsonValue } {
  if (
    !isRecord(value) ||
    value['io.modelcontextprotocol/protocolVersion'] !== MCP_PROTOCOL_REVISION ||
    !isRecord(value['io.modelcontextprotocol/clientCapabilities'])
  ) {
    return false
  }
  const clientInfo = value['io.modelcontextprotocol/clientInfo']
  return (
    clientInfo === undefined ||
    (hasExactKeys(clientInfo, ['name', 'version']) &&
      typeof clientInfo.name === 'string' &&
      clientInfo.name.length > 0 &&
      typeof clientInfo.version === 'string' &&
      clientInfo.version.length > 0)
  )
}

function isRuntimeContext(value: unknown): value is BackendRuntimeContext {
  return (
    hasExactKeys(value, [
      'pluginId',
      'packageVersion',
      'workspaceId',
      'instanceId',
      'contributionKey',
      'hostWindowId',
    ]) &&
    typeof value.pluginId === 'string' &&
    value.pluginId.length > 0 &&
    typeof value.packageVersion === 'string' &&
    value.packageVersion.length > 0 &&
    ['workspaceId', 'instanceId', 'contributionKey', 'hostWindowId'].every(
      (key) => value[key] === null || typeof value[key] === 'string'
    )
  )
}

function isMethodName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/u.test(value)
}

function serverInfo(value: unknown): BackendServerInfo | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.version !== 'string' ||
    value.version.length === 0
  ) {
    return undefined
  }
  return { name: value.name, version: value.version }
}

function validateSuccessResponse(frame: { [key: string]: unknown }): SuccessResponse {
  if (!hasExactKeys(frame, ['jsonrpc', 'id', 'result']) || frame.jsonrpc !== '2.0') {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (!isRequestId(frame.id) || !hasExactKeys(frame.result, ['resultType', 'value', '_meta'])) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (frame.result.resultType !== 'complete' || !isJsonValue(frame.result.value)) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  const meta = frame.result._meta
  if (!isRecord(meta)) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const info = serverInfo(meta[SERVER_INFO_KEY])
  if (!info) throw new Error(PROTOCOL_ERROR_MESSAGE)
  return { kind: 'success', id: frame.id, value: frame.result.value, serverInfo: info }
}

function validateErrorResponse(frame: { [key: string]: unknown }): BackendWireResponse {
  if (!hasExactKeys(frame, ['jsonrpc', 'id', 'error']) || frame.jsonrpc !== '2.0') {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (!isRequestId(frame.id) || !isRecord(frame.error)) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  const errorKeys = Object.keys(frame.error)
  if (
    !Object.prototype.hasOwnProperty.call(frame.error, 'code') ||
    !Object.prototype.hasOwnProperty.call(frame.error, 'message') ||
    errorKeys.some((key) => key !== 'code' && key !== 'message' && key !== 'data')
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (
    typeof frame.error.code !== 'number' ||
    !Number.isInteger(frame.error.code) ||
    typeof frame.error.message !== 'string' ||
    frame.error.message.length === 0 ||
    (frame.error.data !== undefined && !isJsonValue(frame.error.data))
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (frame.error.code === 1000) {
    if (
      !isRecord(frame.error.data) ||
      typeof frame.error.data.code !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/u.test(frame.error.data.code)
    ) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    return { kind: 'plugin-error', id: frame.id, pluginCode: frame.error.data.code }
  }
  return { kind: 'protocol-error', id: frame.id }
}

function validateResponse(frame: JsonValue): BackendWireResponse {
  if (!isRecord(frame)) throw new Error(PROTOCOL_ERROR_MESSAGE)
  if (Object.prototype.hasOwnProperty.call(frame, 'result')) return validateSuccessResponse(frame)
  if (Object.prototype.hasOwnProperty.call(frame, 'error')) return validateErrorResponse(frame)
  throw new Error(PROTOCOL_ERROR_MESSAGE)
}

function encodeFrame(frame: JsonValue): Buffer {
  const encoded = JSON.stringify(frame)
  if (typeof encoded !== 'string' || encoded.includes('\n') || encoded.includes('\r')) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  return Buffer.from(`${encoded}\n`, 'utf8')
}

function defaultSpawnProcess(entryFile: string, options: SpawnOptions): ChildProcessWithoutNullStreams {
  return spawn(entryFile, [], options) as ChildProcessWithoutNullStreams
}

function waitForExit(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, timeoutMs)
    void exitPromise.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export function createAuthenticatedBackendRuntime(
  runtime: BackendRuntimeContext
): AuthenticatedBackendRuntime {
  // The future Host adapter calls this only after resolving its authenticated
  // binding. The private symbol prevents a plugin-supplied plain object from
  // being accepted by clientFor().
  if (!isRuntimeContext(runtime)) {
    throw new BackendPluginError('INVALID_RUNTIME')
  }
  const copy = { ...runtime }
  Object.defineProperty(copy, AUTHENTICATED_RUNTIME, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return Object.freeze(copy) as AuthenticatedBackendRuntime
}

export class PluginBackendSupervisor {
  private readonly spawnProcess: NonNullable<PluginBackendSupervisorOptions['spawnProcess']>
  private readonly environment: Readonly<Record<string, string>>
  private readonly clientCapabilities: { [key: string]: JsonValue }
  private readonly clientInfo?: { name: string; version: string }
  private readonly healthTimeoutMs: number
  private readonly callTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly maxFrameBytes: number
  private readonly onStderr?: (chunk: string) => void
  private state: SupervisorState = 'idle'
  private child?: ChildProcessWithoutNullStreams
  private childExited = false
  private stdoutBuffer = Buffer.alloc(0)
  private readonly pending = new Map<WireRequestId, PendingRequest>()
  private readonly ignoredRequestIds = new Set<WireRequestId>()
  private startTask?: Promise<BackendHealth>
  private health?: BackendHealth
  private failure?: BackendPluginError
  private exitPromise?: Promise<void>
  private resolveExit?: () => void
  private terminationTask?: Promise<void>

  constructor(
    private readonly activation: BackendPluginLaunchSpec,
    options: PluginBackendSupervisorOptions
  ) {
    if (
      !activation ||
      typeof activation.pluginId !== 'string' ||
      activation.pluginId.length === 0 ||
      typeof activation.packageVersion !== 'string' ||
      activation.packageVersion.length === 0 ||
      typeof activation.entryFile !== 'string' ||
      activation.entryFile.length === 0 ||
      activation.protocolVersion !== 1 ||
      activation.activation !== 'startup' ||
      !options ||
      !isEnvironmentMap(options.environment)
    ) {
      throw new BackendPluginError('INVALID_ACTIVATION')
    }
    this.environment = Object.freeze({ ...options.environment })
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess
    this.clientCapabilities = options.clientCapabilities ?? {}
    this.clientInfo = options.clientInfo
    this.healthTimeoutMs = options.healthTimeoutMs ?? 5_000
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 250
    this.maxFrameBytes = options.maxFrameBytes ?? 1_048_576
    this.onStderr = options.onStderr
    if (
      !isRecord(this.clientCapabilities) ||
      !isJsonValue(this.clientCapabilities) ||
      (this.clientInfo !== undefined &&
        (!hasExactKeys(this.clientInfo, ['name', 'version']) ||
          typeof this.clientInfo.name !== 'string' ||
          this.clientInfo.name.length === 0 ||
          typeof this.clientInfo.version !== 'string' ||
          this.clientInfo.version.length === 0)) ||
      !isPositiveFiniteNumber(this.healthTimeoutMs) ||
      !isPositiveFiniteNumber(this.callTimeoutMs) ||
      !isPositiveFiniteNumber(this.shutdownTimeoutMs) ||
      !isPositiveFiniteNumber(this.maxFrameBytes)
    ) {
      throw new BackendPluginError('INVALID_ACTIVATION')
    }
  }

  async start(): Promise<BackendHealth> {
    if (this.state === 'ready' && this.health) return this.health
    if (this.state === 'starting' && this.startTask) return this.startTask
    if (this.state === 'failed') {
      throw this.failure ?? new BackendPluginError('BACKEND_UNAVAILABLE')
    }
    if (this.state === 'closed') throw new BackendPluginError('PLUGIN_STOPPING')

    this.state = 'starting'
    this.startTask = this.startInternal()
    try {
      return await this.startTask
    } finally {
      this.startTask = undefined
    }
  }

  clientFor(binding: AuthenticatedBackendRuntime): PluginBackendClient {
    if (!isAuthenticatedRuntime(binding) || !isRuntimeContext(binding)) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    if (
      binding.pluginId !== this.activation.pluginId ||
      binding.packageVersion !== this.activation.packageVersion
    ) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    const runtime = { ...binding }
    return Object.freeze({
      call: <Result extends JsonValue>(
        name: string,
        args: JsonValue,
        options?: BackendPluginCallOptions
      ): Promise<Result> => this.callWithRuntime<Result>(runtime, name, args, options),
    })
  }

  async close(): Promise<void> {
    if (this.state === 'closed' && !this.child) return
    this.state = 'closed'
    this.rejectPending(new BackendPluginError('PLUGIN_STOPPING'))
    this.ignoredRequestIds.clear()
    const child = this.child
    if (!child) return
    await this.requestTermination(false)
    this.child = undefined
  }

  private async startInternal(): Promise<BackendHealth> {
    try {
      this.spawnChild()
      const id = this.nextRequestId()
      const response = await this.sendRequest(
        {
          jsonrpc: '2.0',
          id,
          method: 'navide/health',
          params: { _meta: this.clientMeta() },
        },
        { timeoutMs: this.healthTimeoutMs }
      )
      const health = this.successResult(response)
      this.health = health
      this.state = 'ready'
      return health
    } catch (value) {
      const error = value instanceof BackendPluginError
        ? value
        : new BackendPluginError('BACKEND_UNAVAILABLE')
      if (this.state !== 'closed' && this.state !== 'failed') {
        this.failProcess(error.code === 'PROTOCOL_ERROR' ? 'PROTOCOL_ERROR' : 'BACKEND_UNAVAILABLE')
      }
      throw error
    }
  }

  private spawnChild(): void {
    const options: SpawnOptions = {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...this.environment },
    }
    try {
      this.child = this.spawnProcess(this.activation.entryFile, options)
    } catch {
      throw new BackendPluginError('BACKEND_UNAVAILABLE')
    }
    if (!this.child?.stdin || !this.child.stdout || !this.child.stderr) {
      throw new BackendPluginError('BACKEND_UNAVAILABLE')
    }
    this.childExited = false
    this.stdoutBuffer = Buffer.alloc(0)
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve
    })
    this.child.stdout.on('data', (chunk: Buffer | string) => this.onStdout(chunk))
    this.child.stderr.on('data', (chunk: Buffer | string) => this.onStderrChunk(chunk))
    this.child.on('error', () => this.failProcess('BACKEND_UNAVAILABLE'))
    this.child.on('exit', () => this.onChildExit())
  }

  private onStdout(chunk: Buffer | string): void {
    if (this.state === 'closed' || this.state === 'failed') return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes])
    if (this.stdoutBuffer.length > this.maxFrameBytes && !this.stdoutBuffer.includes(0x0a)) {
      this.failProcess('PROTOCOL_ERROR')
      return
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a)
      if (newline < 0) {
        if (this.stdoutBuffer.length > this.maxFrameBytes) this.failProcess('PROTOCOL_ERROR')
        return
      }
      const line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (line.length > this.maxFrameBytes || line.includes(0x0d)) {
        this.failProcess('PROTOCOL_ERROR')
        return
      }
      let frame: JsonValue
      try {
        frame = parseBackendWireFrame(line)
      } catch {
        this.failProcess('PROTOCOL_ERROR')
        return
      }
      try {
        this.handleResponse(frame)
      } catch {
        this.failProcess('PROTOCOL_ERROR')
        return
      }
    }
  }

  private onStderrChunk(chunk: Buffer | string): void {
    if (!this.onStderr) return
    try {
      this.onStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    } catch {
      /* Diagnostic sinks must not affect protocol ownership. */
    }
  }

  private onChildExit(): void {
    this.childExited = true
    this.ignoredRequestIds.clear()
    this.resolveExit?.()
    this.resolveExit = undefined
    if (this.state !== 'closed' && this.state !== 'failed') {
      this.failProcess(this.stdoutBuffer.length > 0 ? 'PROTOCOL_ERROR' : 'BACKEND_UNAVAILABLE', false)
    }
  }

  private handleResponse(frame: JsonValue): void {
    const response = validateResponse(frame)
    const pending = this.pending.get(response.id)
    if (!pending) {
      if (this.ignoredRequestIds.delete(response.id)) return
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (response.kind === 'success') {
      this.settle(response.id, () => pending.resolve(response))
      return
    }
    if (response.kind === 'plugin-error') {
      this.settle(
        response.id,
        () =>
          pending.reject(
            new BackendPluginError('PLUGIN_ERROR', undefined, {
              requestId: response.id,
              pluginCode: response.pluginCode,
            })
          )
      )
      return
    }
    this.settle(
      response.id,
      () => pending.reject(new BackendPluginError('PROTOCOL_ERROR', undefined, { requestId: response.id }))
    )
  }

  private async callWithRuntime<Result extends JsonValue>(
    runtime: BackendRuntimeContext,
    name: string,
    args: JsonValue,
    options: BackendPluginCallOptions = {}
  ): Promise<Result> {
    if (this.state !== 'ready') {
      throw this.failure ?? new BackendPluginError(this.state === 'closed' ? 'PLUGIN_STOPPING' : 'NOT_READY')
    }
    if (!isMethodName(name) || !isJsonValue(args)) throw new BackendPluginError('INVALID_ARGUMENT')
    const id = this.nextRequestId()
    const response = await this.sendRequest(
      {
        jsonrpc: '2.0',
        id,
        method: 'navide/call',
        params: {
          _meta: this.clientMeta(),
          name,
          arguments: args,
          runtime: { ...runtime },
        },
      },
      options
    )
    const result = this.successResult(response)
    return result.value as Result
  }

  private successResult(response: BackendWireResponse): BackendHealth {
    if (response.kind !== 'success') {
      throw new BackendPluginError(response.kind === 'plugin-error' ? 'PLUGIN_ERROR' : 'PROTOCOL_ERROR')
    }
    return { value: response.value, serverInfo: response.serverInfo }
  }

  private clientMeta(): { [key: string]: JsonValue } {
    const meta: { [key: string]: JsonValue } = {
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_REVISION,
      'io.modelcontextprotocol/clientCapabilities': { ...this.clientCapabilities },
    }
    if (this.clientInfo) meta['io.modelcontextprotocol/clientInfo'] = { ...this.clientInfo }
    return meta
  }

  private sendRequest(
    frame: JsonValue,
    options: BackendPluginCallOptions
  ): Promise<BackendWireResponse> {
    const requestId = isRecord(frame) && isRequestId(frame.id) ? frame.id : undefined
    if (requestId === undefined || !this.child || this.childExited) {
      return Promise.reject(new BackendPluginError('BACKEND_UNAVAILABLE'))
    }
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs
    if (!isPositiveFiniteNumber(timeoutMs)) {
      return Promise.reject(new BackendPluginError('INVALID_ARGUMENT'))
    }
    if (options.signal?.aborted) {
      return Promise.reject(new BackendPluginError('USER_CANCELLED', undefined, { requestId }))
    }

    return new Promise<BackendWireResponse>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        this.cancelPending(requestId, 'TIMEOUT')
      }, timeoutMs)
      const abort = (): void => this.cancelPending(requestId, 'USER_CANCELLED')
      options.signal?.addEventListener('abort', abort, { once: true })
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
      }
      const pending: PendingRequest = {
        resolve: (response) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(response)
        },
        reject: (error) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        },
        cleanup,
      }
      this.pending.set(requestId, pending)
      try {
        if (this.child?.stdin.destroyed || this.child?.stdin.writableEnded) throw new Error('closed')
        this.child?.stdin.write(encodeFrame(frame))
      } catch {
        this.failProcess('BACKEND_UNAVAILABLE')
      }
    })
  }

  private cancelPending(requestId: WireRequestId, code: 'TIMEOUT' | 'USER_CANCELLED'): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    this.rememberIgnoredRequestId(requestId)
    pending.cleanup()
    pending.reject(new BackendPluginError(code, undefined, { requestId }))
    this.sendCancellation(requestId)
  }

  private sendCancellation(requestId: WireRequestId): void {
    try {
      if (!this.child || this.childExited || this.child.stdin.destroyed) return
      this.child.stdin.write(
        encodeFrame({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId },
        })
      )
    } catch {
      /* Cancellation is best effort; the original safe error has already settled. */
    }
  }

  private settle(requestId: WireRequestId, action: () => void): void {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Error(PROTOCOL_ERROR_MESSAGE)
    this.pending.delete(requestId)
    pending.cleanup()
    action()
  }

  private rejectPending(error: BackendPluginError): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId)
      pending.cleanup()
      pending.reject(error)
    }
  }

  private failProcess(code: 'BACKEND_UNAVAILABLE' | 'PROTOCOL_ERROR', terminate = true): void {
    if (this.state === 'closed') return
    const error = this.failure ?? new BackendPluginError(code)
    this.failure = error
    this.state = 'failed'
    this.ignoredRequestIds.clear()
    this.rejectPending(error)
    if (terminate && this.child && !this.childExited) void this.requestTermination(code === 'PROTOCOL_ERROR')
  }

  private requestTermination(force: boolean): Promise<void> {
    if (!this.child || this.childExited) return Promise.resolve()
    if (this.terminationTask && !force) return this.terminationTask
    const child = this.child
    const task = (async (): Promise<void> => {
      if (force) {
        try {
          child.stdin.destroy()
        } catch {
          /* already closed */
        }
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
      } else {
        try {
          child.stdin.end()
        } catch {
          /* already closed */
        }
      }
      if (await waitForExit(this.exitPromise ?? Promise.resolve(), this.shutdownTimeoutMs)) return
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      if (await waitForExit(this.exitPromise ?? Promise.resolve(), this.shutdownTimeoutMs)) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      await waitForExit(this.exitPromise ?? Promise.resolve(), this.shutdownTimeoutMs)
    })()
    this.terminationTask = task
    return task
  }

  private nextRequestId(): string {
    let requestId: string
    do {
      requestId = randomUUID()
    } while (this.pending.has(requestId) || this.ignoredRequestIds.has(requestId))
    return requestId
  }

  private rememberIgnoredRequestId(requestId: WireRequestId): void {
    this.ignoredRequestIds.delete(requestId)
    this.ignoredRequestIds.add(requestId)
    while (this.ignoredRequestIds.size > MAX_IGNORED_REQUEST_IDS) {
      const oldest = this.ignoredRequestIds.values().next()
      if (oldest.done) return
      this.ignoredRequestIds.delete(oldest.value)
    }
  }
}

function isAuthenticatedRuntime(value: unknown): value is AuthenticatedBackendRuntime {
  return (
    isRecord(value) &&
    (value as { [AUTHENTICATED_RUNTIME]?: true })[AUTHENTICATED_RUNTIME] === true
  )
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isEnvironmentMap(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string' || !ENVIRONMENT_KEY_PATTERN.test(key)) return false
    const environmentValue = value[key]
    return typeof environmentValue === 'string' && !environmentValue.includes('\u0000')
  })
}
