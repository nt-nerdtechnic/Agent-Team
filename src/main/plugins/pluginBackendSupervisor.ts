import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { TextDecoder } from 'node:util'

/** Private Electron-main seam for Backend Wire v1 conformance tests. */
export const MCP_PROTOCOL_REVISION = '2026-07-28'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'
const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId'
const EVENT_FILTER_KEY = 'dev.navide/pluginEvents'
const PROTOCOL_ERROR_MESSAGE = 'Backend plugin returned an invalid protocol message.'
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const MAX_IGNORED_REQUEST_IDS = 256
const MAX_ACTIVE_SUBSCRIPTIONS = 256

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
  /** Host-projected package event allowlist; never supplied by the child. */
  approvedEvents: readonly string[]
}

const AUTHENTICATED_RUNTIME = Symbol('navide.authenticatedBackendRuntime')
const AUTHENTICATED_AUDIENCE = Symbol('navide.authenticatedBackendAudience')
const AUTHENTICATED_RUNTIMES = new WeakSet<object>()

export type AuthenticatedBackendRuntime = BackendRuntimeContext & {
  readonly [AUTHENTICATED_RUNTIME]: true
  readonly [AUTHENTICATED_AUDIENCE]: object
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
    this.stack = undefined
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

export interface BackendPluginEvent {
  subscriptionId: WireRequestId
  event: string
  payload: JsonValue
}

export interface BackendPluginProgress {
  progressToken: WireRequestId
  progress: number
  total?: number
  message?: string
}

export interface BackendPluginSubscriptionOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (progress: BackendPluginProgress) => void
}

export type BackendPluginSubscriptionCloseReason =
  | 'backend-closed'
  | 'backend-unavailable'
  | 'cancelled'
  | 'view-destroyed'
  | 'plugin-stopping'
  | 'protocol-error'
  | 'timeout'

export interface BackendPluginSubscriptionResult {
  reason: BackendPluginSubscriptionCloseReason
  error?: BackendPluginError
}

export interface BackendPluginSubscription {
  readonly subscriptionId: WireRequestId | undefined
  readonly acknowledged: Promise<void>
  readonly settled: Promise<BackendPluginSubscriptionResult>
  dispose(reason?: 'cancelled' | 'view-destroyed'): void
}

export interface PluginBackendClient {
  call<Result extends JsonValue>(
    name: string,
    args: JsonValue,
    options?: BackendPluginCallOptions
  ): Promise<Result>
  subscribe(
    events: readonly string[],
    listener: (event: BackendPluginEvent) => void,
    options?: BackendPluginSubscriptionOptions
  ): BackendPluginSubscription
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
  readonly generation: ChildGeneration
  readonly resolve: (response: BackendWireResponse) => void
  readonly reject: (error: BackendPluginError) => void
  readonly cleanup: () => void
}

interface ChildGeneration {
  readonly id: number
  readonly child: ChildProcessWithoutNullStreams
  exited: boolean
  stdoutBuffer: Buffer
  readonly exitPromise: Promise<void>
  resolveExit?: () => void
  terminationTask?: Promise<void>
  listeners: {
    stdout: (chunk: Buffer | string) => void
    stderr: (chunk: Buffer | string) => void
    error: () => void
    exit: () => void
  }
}

interface SuccessResponse {
  kind: 'success'
  id: WireRequestId
  value?: JsonValue
  serverInfo: BackendServerInfo
  subscriptionId?: WireRequestId
}

interface PluginErrorResponse {
  kind: 'plugin-error'
  id: WireRequestId
  pluginCode: string
}

interface ProtocolErrorResponse {
  kind: 'protocol-error'
  id?: WireRequestId
}

type BackendWireResponse = SuccessResponse | PluginErrorResponse | ProtocolErrorResponse

interface SubscriptionAcknowledgedNotification {
  kind: 'subscription-acknowledged'
  subscriptionId: WireRequestId
  events: readonly string[]
}

interface EventNotification {
  kind: 'event'
  subscriptionId: WireRequestId
  event: string
  payload: JsonValue
}

interface ProgressNotification {
  kind: 'progress'
  progressToken: WireRequestId
  progress: number
  total?: number
  message?: string
}

type BackendWireNotification =
  | SubscriptionAcknowledgedNotification
  | EventNotification
  | ProgressNotification

export type BackendWireHostFrame = BackendWireResponse | BackendWireNotification

type SubscriptionPhase = 'pending-ack' | 'active' | 'reconnecting' | 'settled'

interface SubscriptionState {
  readonly events: readonly string[]
  readonly runtime: BackendRuntimeContext
  readonly binding: AuthenticatedBackendRuntime
  readonly listener: (event: BackendPluginEvent) => void
  readonly onProgress?: (progress: BackendPluginProgress) => void
  readonly signal?: AbortSignal
  readonly acknowledged: Promise<void>
  readonly resolveAcknowledged: () => void
  readonly rejectAcknowledged: (error: BackendPluginError) => void
  readonly settled: Promise<BackendPluginSubscriptionResult>
  readonly resolveSettled: (result: BackendPluginSubscriptionResult) => void
  publicSubscription: BackendPluginSubscription
  readonly timeoutAt?: number
  timeoutTimer?: ReturnType<typeof setTimeout>
  abortListener?: () => void
  phase: SubscriptionPhase
  generation?: ChildGeneration
  requestId?: WireRequestId
  progressToken?: WireRequestId
  settledOnce: boolean
  acknowledgedOnce: boolean
}

type SupervisorState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'closed'

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

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is { [key: string]: unknown } {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key))
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
  if (!isRequestId(frame.id) || !isRecord(frame.result)) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (
    !hasOnlyKeys(frame.result, ['resultType', 'value', '_meta']) ||
    !Object.prototype.hasOwnProperty.call(frame.result, 'resultType') ||
    !Object.prototype.hasOwnProperty.call(frame.result, '_meta') ||
    frame.result.resultType !== 'complete'
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  const hasValue = Object.prototype.hasOwnProperty.call(frame.result, 'value')
  if (hasValue && !isJsonValue(frame.result.value)) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const meta = frame.result._meta
  if (!isRecord(meta)) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const info = serverInfo(meta[SERVER_INFO_KEY])
  if (!info) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const subscriptionId = meta[SUBSCRIPTION_ID_KEY]
  if (subscriptionId !== undefined && !isRequestId(subscriptionId)) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (!hasValue && subscriptionId === undefined) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const value = frame.result.value
  return {
    kind: 'success',
    id: frame.id,
    ...(hasValue ? { value: value as JsonValue } : {}),
    serverInfo: info,
    ...(subscriptionId !== undefined ? { subscriptionId } : {}),
  }
}

function validateErrorResponse(frame: { [key: string]: unknown }): BackendWireResponse {
  if (
    !hasOnlyKeys(frame, ['jsonrpc', 'id', 'error']) ||
    !Object.prototype.hasOwnProperty.call(frame, 'jsonrpc') ||
    !Object.prototype.hasOwnProperty.call(frame, 'error') ||
    frame.jsonrpc !== '2.0'
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  const hasId = Object.prototype.hasOwnProperty.call(frame, 'id')
  if ((hasId && !isRequestId(frame.id)) || !isRecord(frame.error)) {
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
      !hasId ||
      !isRecord(frame.error.data) ||
      typeof frame.error.data.code !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/u.test(frame.error.data.code)
    ) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    return { kind: 'plugin-error', id: frame.id as WireRequestId, pluginCode: frame.error.data.code }
  }
  return {
    kind: 'protocol-error',
    ...(hasId ? { id: frame.id as WireRequestId } : {}),
  }
}

function validateResponse(frame: JsonValue): BackendWireResponse {
  if (!isRecord(frame)) throw new Error(PROTOCOL_ERROR_MESSAGE)
  if (Object.prototype.hasOwnProperty.call(frame, 'result')) return validateSuccessResponse(frame)
  if (Object.prototype.hasOwnProperty.call(frame, 'error')) return validateErrorResponse(frame)
  throw new Error(PROTOCOL_ERROR_MESSAGE)
}

function subscriptionMeta(value: unknown): WireRequestId {
  if (!hasExactKeys(value, [SUBSCRIPTION_ID_KEY]) || !isRequestId(value[SUBSCRIPTION_ID_KEY])) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  return value[SUBSCRIPTION_ID_KEY]
}

function eventFilter(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const events = value.map((event) => {
    if (!isMethodName(event)) throw new Error(PROTOCOL_ERROR_MESSAGE)
    return event
  })
  if (new Set(events).size !== events.length) throw new Error(PROTOCOL_ERROR_MESSAGE)
  return events
}

function validateNotification(frame: JsonValue): BackendWireNotification {
  if (!isRecord(frame) || !hasExactKeys(frame, ['jsonrpc', 'method', 'params']) || frame.jsonrpc !== '2.0') {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (frame.method === 'notifications/subscriptions/acknowledged') {
    if (!hasExactKeys(frame.params, ['_meta', 'notifications'])) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    const notifications = frame.params.notifications
    if (!hasExactKeys(notifications, [EVENT_FILTER_KEY])) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    return {
      kind: 'subscription-acknowledged',
      subscriptionId: subscriptionMeta(frame.params._meta),
      events: eventFilter(notifications[EVENT_FILTER_KEY]),
    }
  }
  if (frame.method === 'notifications/navide/event') {
    if (!hasExactKeys(frame.params, ['_meta', 'event', 'payload']) || !isMethodName(frame.params.event)) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (!isJsonValue(frame.params.payload)) throw new Error(PROTOCOL_ERROR_MESSAGE)
    return {
      kind: 'event',
      subscriptionId: subscriptionMeta(frame.params._meta),
      event: frame.params.event,
      payload: frame.params.payload,
    }
  }
  if (frame.method === 'notifications/progress') {
    if (!hasOnlyKeys(frame.params, ['progressToken', 'progress', 'total', 'message'])) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (
      !isRecord(frame.params) ||
      !isRequestId(frame.params.progressToken) ||
      typeof frame.params.progress !== 'number' ||
      !Number.isFinite(frame.params.progress) ||
      (frame.params.total !== undefined &&
        (typeof frame.params.total !== 'number' || !Number.isFinite(frame.params.total))) ||
      (frame.params.message !== undefined && typeof frame.params.message !== 'string')
    ) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    return {
      kind: 'progress',
      progressToken: frame.params.progressToken,
      progress: frame.params.progress,
      ...(frame.params.total !== undefined ? { total: frame.params.total } : {}),
      ...(frame.params.message !== undefined ? { message: frame.params.message } : {}),
    }
  }
  throw new Error(PROTOCOL_ERROR_MESSAGE)
}

/** Host-owned framing and semantic seam for child-to-Host Backend Wire frames. */
export function parseBackendWireHostFrame(raw: Uint8Array | string): BackendWireHostFrame {
  const frame = parseBackendWireFrame(raw)
  try {
    if (isRecord(frame) && typeof frame.method === 'string') return validateNotification(frame)
    return validateResponse(frame)
  } catch {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
}

function sameEventFilter(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((event) => right.includes(event))
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
  Object.defineProperty(copy, AUTHENTICATED_AUDIENCE, {
    value: Object.freeze({}),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  AUTHENTICATED_RUNTIMES.add(copy)
  return Object.freeze(copy) as AuthenticatedBackendRuntime
}

export class PluginBackendSupervisor {
  private readonly spawnProcess: NonNullable<PluginBackendSupervisorOptions['spawnProcess']>
  private readonly environment: Readonly<Record<string, string>>
  private readonly approvedEvents: readonly string[]
  private readonly clientCapabilities: { [key: string]: JsonValue }
  private readonly clientInfo?: { name: string; version: string }
  private readonly healthTimeoutMs: number
  private readonly callTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly maxFrameBytes: number
  private readonly onStderr?: (chunk: string) => void
  private state: SupervisorState = 'idle'
  private currentGeneration?: ChildGeneration
  private nextGenerationId = 0
  private readonly pending = new Map<WireRequestId, PendingRequest>()
  private readonly subscriptions = new Set<SubscriptionState>()
  private readonly subscriptionsByRequestId = new Map<WireRequestId, SubscriptionState>()
  private readonly subscriptionsByProgressToken = new Map<WireRequestId, SubscriptionState>()
  private readonly ignoredRequestIds = new Set<WireRequestId>()
  private startTask?: Promise<BackendHealth>
  private restartTask?: Promise<BackendHealth>
  private health?: BackendHealth
  private failure?: BackendPluginError
  private readonly activation: BackendPluginLaunchSpec

  constructor(
    activation: BackendPluginLaunchSpec,
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
      !isApprovedEventList(activation.approvedEvents) ||
      !options ||
      !isEnvironmentMap(options.environment)
    ) {
      throw new BackendPluginError('INVALID_ACTIVATION')
    }
    this.activation = Object.freeze({
      ...activation,
      approvedEvents: Object.freeze([...activation.approvedEvents]),
    })
    this.environment = Object.freeze({ ...options.environment })
    this.approvedEvents = this.activation.approvedEvents
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
    if (this.state === 'restarting' && this.restartTask) return this.restartTask
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
      subscribe: (
        events: readonly string[],
        listener: (event: BackendPluginEvent) => void,
        options?: BackendPluginSubscriptionOptions
      ): BackendPluginSubscription => this.subscribeWithRuntime(binding, runtime, events, listener, options),
    })
  }

  async restart(): Promise<BackendHealth> {
    if (this.state === 'closed') throw new BackendPluginError('PLUGIN_STOPPING')
    if (this.state === 'idle' || this.state === 'starting') {
      throw new BackendPluginError('NOT_READY')
    }
    if (this.state === 'restarting' && this.restartTask) return this.restartTask

    this.restartTask = this.restartInternal()
    try {
      return await this.restartTask
    } finally {
      this.restartTask = undefined
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed' && !this.currentGeneration) return
    this.state = 'closed'
    this.rejectPending(new BackendPluginError('PLUGIN_STOPPING'))
    this.settleAllSubscriptions({ reason: 'plugin-stopping', error: new BackendPluginError('PLUGIN_STOPPING') })
    this.ignoredRequestIds.clear()
    const generation = this.currentGeneration
    if (!generation) return
    await this.requestTermination(generation, false)
    this.disposeGeneration(generation)
    if (this.currentGeneration === generation) this.currentGeneration = undefined
  }

  private subscribeWithRuntime(
    binding: AuthenticatedBackendRuntime,
    runtime: BackendRuntimeContext,
    events: readonly string[],
    listener: (event: BackendPluginEvent) => void,
    options: BackendPluginSubscriptionOptions = {}
  ): BackendPluginSubscription {
    if (this.state !== 'ready') {
      throw this.failure ?? new BackendPluginError(this.state === 'closed' ? 'PLUGIN_STOPPING' : 'NOT_READY')
    }
    if (
      !isRecord(options) ||
      (options.signal !== undefined && !isAbortSignalLike(options.signal)) ||
      (options.onProgress !== undefined && typeof options.onProgress !== 'function')
    ) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (!isViewRuntime(runtime) || !isAuthenticatedRuntime(binding) || !isRuntimeContext(binding)) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    if (
      !isApprovedEventList(events) ||
      events.length === 0 ||
      events.some((event) => !this.approvedEvents.includes(event)) ||
      typeof listener !== 'function' ||
      (options.timeoutMs !== undefined && !isPositiveFiniteNumber(options.timeoutMs))
    ) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (this.subscriptions.size >= MAX_ACTIVE_SUBSCRIPTIONS) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (options.signal?.aborted) {
      throw new BackendPluginError('USER_CANCELLED')
    }

    let resolveAcknowledged!: () => void
    let rejectAcknowledged!: (error: BackendPluginError) => void
    const acknowledged = new Promise<void>((resolve, reject) => {
      resolveAcknowledged = resolve
      rejectAcknowledged = reject
    })
    let resolveSettled!: (result: BackendPluginSubscriptionResult) => void
    const settled = new Promise<BackendPluginSubscriptionResult>((resolve) => {
      resolveSettled = resolve
    })
    const timeoutAt = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs
    const state = {
      events: Object.freeze([...events]),
      runtime: Object.freeze({ ...runtime }),
      binding,
      listener,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      acknowledged,
      resolveAcknowledged,
      rejectAcknowledged,
      settled,
      resolveSettled,
      publicSubscription: undefined as unknown as BackendPluginSubscription,
      ...(timeoutAt !== undefined ? { timeoutAt } : {}),
      phase: 'pending-ack' as SubscriptionPhase,
      settledOnce: false,
      acknowledgedOnce: false,
    } as SubscriptionState
    const publicSubscription: BackendPluginSubscription = {
      get subscriptionId(): WireRequestId | undefined {
        return state.requestId
      },
      acknowledged,
      settled,
      dispose: (reason = 'cancelled'): void => {
        this.cancelSubscription(state, reason)
      },
    }
    state.publicSubscription = publicSubscription
    this.subscriptions.add(state)
    if (options.timeoutMs !== undefined) {
      state.timeoutTimer = setTimeout(() => this.timeoutSubscription(state), options.timeoutMs)
    }
    if (options.signal) {
      state.abortListener = (): void => this.cancelSubscription(state, 'cancelled')
      options.signal.addEventListener('abort', state.abortListener, { once: true })
    }
    this.issueSubscription(state)
    return publicSubscription
  }

  private issueSubscription(state: SubscriptionState): void {
    if (state.settledOnce || this.state !== 'ready') return
    const generation = this.currentGeneration
    if (!generation) {
      this.failProcess(undefined, 'BACKEND_UNAVAILABLE')
      return
    }
    const requestId = this.nextRequestId()
    state.generation = generation
    state.requestId = requestId
    state.progressToken = requestId
    state.phase = 'pending-ack'
    this.subscriptionsByRequestId.set(requestId, state)
    this.subscriptionsByProgressToken.set(requestId, state)
    try {
      if (generation.exited || generation.child.stdin.destroyed || generation.child.stdin.writableEnded) {
        throw new Error('closed')
      }
      generation.child.stdin.write(
        encodeFrame({
          jsonrpc: '2.0',
          id: requestId,
          method: 'subscriptions/listen',
          params: {
            _meta: this.clientMeta(requestId),
            notifications: { [EVENT_FILTER_KEY]: [...state.events] },
            runtime: { ...state.runtime },
          },
        })
      )
    } catch {
      this.failProcess(generation, 'BACKEND_UNAVAILABLE')
    }
  }

  private timeoutSubscription(state: SubscriptionState): void {
    if (state.settledOnce) return
    this.cancelSubscription(state, 'cancelled', 'timeout')
  }

  private cancelSubscription(
    state: SubscriptionState,
    reason: 'cancelled' | 'view-destroyed',
    timeout?: 'timeout'
  ): void {
    if (state.settledOnce) return
    const requestId = state.requestId
    const error = new BackendPluginError(
      timeout === 'timeout' ? 'TIMEOUT' : 'USER_CANCELLED',
      undefined,
      requestId === undefined ? {} : { requestId }
    )
    this.settleSubscription(
      state,
      {
        reason: timeout === 'timeout' ? 'timeout' : reason === 'view-destroyed' ? 'view-destroyed' : 'cancelled',
        error,
      },
      true
    )
  }

  private settleSubscription(
    state: SubscriptionState,
    result: BackendPluginSubscriptionResult,
    sendCancellation: boolean
  ): void {
    if (state.settledOnce) return
    state.settledOnce = true
    state.phase = 'settled'
    const requestId = state.requestId
    const generation = state.generation
    if (requestId !== undefined) {
      this.subscriptionsByRequestId.delete(requestId)
      this.subscriptionsByProgressToken.delete(requestId)
      if (sendCancellation) {
        this.rememberIgnoredRequestId(requestId)
        this.sendCancellation(requestId, result.reason, generation)
      }
    }
    state.generation = undefined
    if (state.timeoutTimer !== undefined) clearTimeout(state.timeoutTimer)
    if (state.abortListener && state.signal) {
      state.signal.removeEventListener('abort', state.abortListener)
    }
    state.abortListener = undefined
    if (!state.acknowledgedOnce) {
      state.acknowledgedOnce = true
      state.rejectAcknowledged(
        result.error ?? new BackendPluginError('BACKEND_UNAVAILABLE', undefined, requestId === undefined ? {} : { requestId })
      )
    }
    this.subscriptions.delete(state)
    state.resolveSettled(result)
  }

  private settleAllSubscriptions(result: BackendPluginSubscriptionResult): void {
    for (const state of [...this.subscriptions]) {
      this.settleSubscription(state, result, false)
    }
  }

  private detachSubscriptionsForRestart(): void {
    for (const state of [...this.subscriptions]) {
      if (state.settledOnce) continue
      if (state.timeoutAt !== undefined && state.timeoutAt <= Date.now()) {
        this.cancelSubscription(state, 'cancelled', 'timeout')
        continue
      }
      if (!this.isRestorableSubscription(state)) {
        this.settleSubscription(
          state,
          { reason: 'backend-unavailable', error: new BackendPluginError('BACKEND_UNAVAILABLE') },
          false
        )
        continue
      }
      if (state.requestId !== undefined) {
        this.rememberIgnoredRequestId(state.requestId)
        this.subscriptionsByRequestId.delete(state.requestId)
        this.subscriptionsByProgressToken.delete(state.requestId)
      }
      state.requestId = undefined
      state.progressToken = undefined
      state.generation = undefined
      state.phase = 'reconnecting'
    }
  }

  private restoreSubscriptions(): void {
    for (const state of [...this.subscriptions]) {
      if (state.settledOnce) continue
      if (state.timeoutAt !== undefined && state.timeoutAt <= Date.now()) {
        this.cancelSubscription(state, 'cancelled', 'timeout')
        continue
      }
      if (!this.isRestorableSubscription(state)) {
        this.settleSubscription(
          state,
          { reason: 'backend-unavailable', error: new BackendPluginError('BACKEND_UNAVAILABLE') },
          false
        )
        continue
      }
      this.issueSubscription(state)
    }
  }

  private isRestorableSubscription(state: SubscriptionState): boolean {
    return (
      isAuthenticatedRuntime(state.binding) &&
      isRuntimeContext(state.binding) &&
      state.binding.pluginId === this.activation.pluginId &&
      state.binding.packageVersion === this.activation.packageVersion &&
      isViewRuntime(state.runtime) &&
      state.events.every((event) => this.approvedEvents.includes(event))
    )
  }

  private async restartInternal(): Promise<BackendHealth> {
    this.state = 'restarting'
    this.rejectPending(new BackendPluginError('BACKEND_UNAVAILABLE'), true)
    this.detachSubscriptionsForRestart()
    const generation = this.currentGeneration
    if (generation) await this.requestTermination(generation, true)
    if ((this.state as SupervisorState) === 'closed') {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    if (generation) {
      this.disposeGeneration(generation)
      if (this.currentGeneration === generation) this.currentGeneration = undefined
    }
    this.failure = undefined
    this.state = 'starting'
    this.startTask = this.startInternal()
    try {
      const health = await this.startTask
      if ((this.state as SupervisorState) !== 'ready') {
        throw this.failure ?? new BackendPluginError('BACKEND_UNAVAILABLE')
      }
      this.restoreSubscriptions()
      return health
    } catch (value) {
      const error = value instanceof BackendPluginError
        ? value
        : new BackendPluginError('BACKEND_UNAVAILABLE')
      this.settleAllSubscriptions({ reason: 'backend-unavailable', error })
      throw error
    } finally {
      this.startTask = undefined
    }
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
        this.failProcess(
          this.currentGeneration,
          error.code === 'PROTOCOL_ERROR' ? 'PROTOCOL_ERROR' : 'BACKEND_UNAVAILABLE'
        )
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
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnProcess(this.activation.entryFile, options)
    } catch {
      throw new BackendPluginError('BACKEND_UNAVAILABLE')
    }
    if (!child?.stdin || !child.stdout || !child.stderr) {
      throw new BackendPluginError('BACKEND_UNAVAILABLE')
    }
    let resolveExit!: () => void
    const generation: ChildGeneration = {
      id: ++this.nextGenerationId,
      child,
      exited: false,
      stdoutBuffer: Buffer.alloc(0),
      exitPromise: new Promise<void>((resolve) => {
        resolveExit = resolve
      }),
      resolveExit: undefined,
      listeners: undefined as never,
    }
    generation.resolveExit = resolveExit
    generation.listeners = {
      stdout: (chunk) => this.onStdout(generation, chunk),
      stderr: (chunk) => this.onStderrChunk(generation, chunk),
      error: () => this.failProcess(generation, 'BACKEND_UNAVAILABLE'),
      exit: () => this.onChildExit(generation),
    }
    this.currentGeneration = generation
    child.stdout.on('data', generation.listeners.stdout)
    child.stderr.on('data', generation.listeners.stderr)
    child.on('error', generation.listeners.error)
    child.on('exit', generation.listeners.exit)
  }

  private disposeGeneration(generation: ChildGeneration): void {
    generation.child.stdout.removeListener('data', generation.listeners.stdout)
    generation.child.stderr.removeListener('data', generation.listeners.stderr)
    generation.child.removeListener('error', generation.listeners.error)
    generation.child.removeListener('exit', generation.listeners.exit)
  }

  private onStdout(generation: ChildGeneration, chunk: Buffer | string): void {
    if (
      this.currentGeneration !== generation ||
      this.state === 'closed' ||
      this.state === 'failed' ||
      this.state === 'restarting'
    ) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    generation.stdoutBuffer = Buffer.concat([generation.stdoutBuffer, bytes])
    if (generation.stdoutBuffer.length > this.maxFrameBytes && !generation.stdoutBuffer.includes(0x0a)) {
      this.failProcess(generation, 'PROTOCOL_ERROR')
      return
    }
    while (true) {
      const newline = generation.stdoutBuffer.indexOf(0x0a)
      if (newline < 0) {
        if (generation.stdoutBuffer.length > this.maxFrameBytes) this.failProcess(generation, 'PROTOCOL_ERROR')
        return
      }
      const line = generation.stdoutBuffer.subarray(0, newline)
      generation.stdoutBuffer = generation.stdoutBuffer.subarray(newline + 1)
      if (line.length > this.maxFrameBytes || line.includes(0x0d)) {
        this.failProcess(generation, 'PROTOCOL_ERROR')
        return
      }
      let frame: BackendWireHostFrame
      try {
        frame = parseBackendWireHostFrame(line)
      } catch {
        this.failProcess(generation, 'PROTOCOL_ERROR')
        return
      }
      try {
        this.handleFrame(generation, frame)
      } catch {
        this.failProcess(generation, 'PROTOCOL_ERROR')
        return
      }
    }
  }

  private onStderrChunk(generation: ChildGeneration, chunk: Buffer | string): void {
    if (this.currentGeneration !== generation || this.state === 'closed' || this.state === 'restarting') return
    if (!this.onStderr) return
    try {
      this.onStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    } catch {
      /* Diagnostic sinks must not affect protocol ownership. */
    }
  }

  private onChildExit(generation: ChildGeneration): void {
    if (generation.exited) return
    generation.exited = true
    generation.resolveExit?.()
    generation.resolveExit = undefined
    this.disposeGeneration(generation)
    if (this.currentGeneration !== generation) return
    this.ignoredRequestIds.clear()
    if (this.state !== 'closed' && this.state !== 'failed' && this.state !== 'restarting') {
      this.failProcess(generation, generation.stdoutBuffer.length > 0 ? 'PROTOCOL_ERROR' : 'BACKEND_UNAVAILABLE', false)
    }
  }

  private handleFrame(generation: ChildGeneration, frame: BackendWireHostFrame): void {
    if (this.currentGeneration !== generation) return
    if (
      frame.kind === 'subscription-acknowledged' ||
      frame.kind === 'event' ||
      frame.kind === 'progress'
    ) {
      this.handleNotification(generation, frame)
      return
    }
    this.handleResponse(generation, frame)
  }

  private handleNotification(generation: ChildGeneration, notification: BackendWireNotification): void {
    if (this.currentGeneration !== generation) return
    if (notification.kind === 'subscription-acknowledged') {
      const state = this.subscriptionsByRequestId.get(notification.subscriptionId)
      if (!state) {
        if (this.ignoredRequestIds.has(notification.subscriptionId)) return
        throw new Error(PROTOCOL_ERROR_MESSAGE)
      }
      if (
        state.generation !== generation ||
        state.phase !== 'pending-ack' ||
        !sameEventFilter(state.events, notification.events)
      ) {
        throw new Error(PROTOCOL_ERROR_MESSAGE)
      }
      state.phase = 'active'
      if (!state.acknowledgedOnce) {
        state.acknowledgedOnce = true
        state.resolveAcknowledged()
      }
      return
    }
    if (notification.kind === 'event') {
      const state = this.subscriptionsByRequestId.get(notification.subscriptionId)
      if (!state) {
        if (this.ignoredRequestIds.has(notification.subscriptionId)) return
        throw new Error(PROTOCOL_ERROR_MESSAGE)
      }
      if (state.generation !== generation || state.phase !== 'active' || !state.events.includes(notification.event)) {
        throw new Error(PROTOCOL_ERROR_MESSAGE)
      }
      try {
        state.listener({
          subscriptionId: notification.subscriptionId,
          event: notification.event,
          payload: notification.payload,
        })
      } catch {
        /* Listener failures must not alter protocol ownership. */
      }
      return
    }
    const state = this.subscriptionsByProgressToken.get(notification.progressToken)
    if (!state) {
      if (this.ignoredRequestIds.has(notification.progressToken)) return
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (
      state.generation !== generation ||
      (state.phase !== 'pending-ack' && state.phase !== 'active')
    ) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (state.onProgress) {
      try {
        state.onProgress({
          progressToken: notification.progressToken,
          progress: notification.progress,
          ...(notification.total !== undefined ? { total: notification.total } : {}),
          ...(notification.message !== undefined ? { message: notification.message } : {}),
        })
      } catch {
        /* Diagnostic listeners must not affect protocol ownership. */
      }
    }
  }

  private handleResponse(generation: ChildGeneration, response: BackendWireResponse): void {
    if (this.currentGeneration !== generation) return
    const requestId = response.id
    if (requestId === undefined) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    const pending = this.pending.get(requestId)
    if (pending) {
      if (pending.generation !== generation) return
      if (response.kind === 'success') {
        this.settle(requestId, () => pending.resolve(response))
        return
      }
      if (response.kind === 'plugin-error') {
        this.settle(
          requestId,
          () =>
            pending.reject(
              new BackendPluginError('PLUGIN_ERROR', undefined, {
                requestId,
                pluginCode: response.pluginCode,
              })
            )
        )
        return
      }
      this.settle(
        requestId,
        () => pending.reject(new BackendPluginError('PROTOCOL_ERROR', undefined, { requestId }))
      )
      return
    }

    const subscription = this.subscriptionsByRequestId.get(requestId)
    if (subscription) {
      if (subscription.generation !== generation) return
      if (
        response.kind === 'success' &&
        response.subscriptionId === requestId &&
        subscription.phase === 'active'
      ) {
        this.settleSubscription(subscription, { reason: 'backend-closed' }, false)
        return
      }
      const error = response.kind === 'plugin-error'
        ? new BackendPluginError('PLUGIN_ERROR', undefined, {
            requestId,
            pluginCode: response.pluginCode,
          })
        : new BackendPluginError('PROTOCOL_ERROR', undefined, { requestId })
      this.settleSubscription(
        subscription,
        {
          reason: response.kind === 'plugin-error' ? 'backend-unavailable' : 'protocol-error',
          error,
        },
        false
      )
      return
    }
    if (this.ignoredRequestIds.delete(requestId)) return
    throw new Error(PROTOCOL_ERROR_MESSAGE)
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
    if (response.kind !== 'success' || response.value === undefined || response.subscriptionId !== undefined) {
      throw new BackendPluginError(response.kind === 'plugin-error' ? 'PLUGIN_ERROR' : 'PROTOCOL_ERROR')
    }
    return { value: response.value, serverInfo: response.serverInfo }
  }

  private clientMeta(progressToken?: WireRequestId): { [key: string]: JsonValue } {
    const meta: { [key: string]: JsonValue } = {
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_REVISION,
      'io.modelcontextprotocol/clientCapabilities': { ...this.clientCapabilities },
    }
    if (this.clientInfo) meta['io.modelcontextprotocol/clientInfo'] = { ...this.clientInfo }
    if (progressToken !== undefined) meta.progressToken = progressToken
    return meta
  }

  private sendRequest(
    frame: JsonValue,
    options: BackendPluginCallOptions
  ): Promise<BackendWireResponse> {
    const requestId = isRecord(frame) && isRequestId(frame.id) ? frame.id : undefined
    const generation = this.currentGeneration
    if (requestId === undefined || !generation || generation.exited) {
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
        generation,
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
        if (generation.exited || generation.child.stdin.destroyed || generation.child.stdin.writableEnded) {
          throw new Error('closed')
        }
        generation.child.stdin.write(encodeFrame(frame))
      } catch {
        this.failProcess(generation, 'BACKEND_UNAVAILABLE')
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
    this.sendCancellation(requestId, undefined, pending.generation)
  }

  private sendCancellation(
    requestId: WireRequestId,
    reason?: string,
    generation?: ChildGeneration
  ): void {
    try {
      if (
        !generation ||
        this.currentGeneration !== generation ||
        generation.exited ||
        generation.child.stdin.destroyed
      ) return
      generation.child.stdin.write(
        encodeFrame({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId, ...(reason ? { reason } : {}) },
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

  private rejectPending(error: BackendPluginError, rememberRequestIds = false): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId)
      if (rememberRequestIds) this.rememberIgnoredRequestId(requestId)
      pending.cleanup()
      pending.reject(error)
    }
  }

  private failProcess(
    generation: ChildGeneration | undefined,
    code: 'BACKEND_UNAVAILABLE' | 'PROTOCOL_ERROR',
    terminate = true
  ): void {
    if (generation && this.currentGeneration !== generation) return
    if (this.state === 'closed' || this.state === 'restarting') return
    const error = this.failure ?? new BackendPluginError(code)
    if (code === 'PROTOCOL_ERROR') {
      this.settleAllSubscriptions({ reason: 'protocol-error', error })
    } else {
      this.detachSubscriptionsForRestart()
    }
    this.failure = error
    this.state = 'failed'
    this.ignoredRequestIds.clear()
    this.rejectPending(error)
    if (terminate && generation && !generation.exited) {
      void this.requestTermination(generation, code === 'PROTOCOL_ERROR')
    }
  }

  private requestTermination(generation: ChildGeneration, force: boolean): Promise<void> {
    if (generation.exited) return Promise.resolve()
    if (generation.terminationTask && !force) return generation.terminationTask
    const child = generation.child
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
      if (await waitForExit(generation.exitPromise, this.shutdownTimeoutMs)) return
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      if (await waitForExit(generation.exitPromise, this.shutdownTimeoutMs)) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      await waitForExit(generation.exitPromise, this.shutdownTimeoutMs)
    })()
    generation.terminationTask = task
    return task
  }

  private nextRequestId(): string {
    let requestId: string
    do {
      requestId = randomUUID()
    } while (
      this.pending.has(requestId) ||
      this.subscriptionsByRequestId.has(requestId) ||
      this.ignoredRequestIds.has(requestId)
    )
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
    AUTHENTICATED_RUNTIMES.has(value) &&
    (value as { [AUTHENTICATED_RUNTIME]?: true })[AUTHENTICATED_RUNTIME] === true &&
    typeof (value as { [AUTHENTICATED_AUDIENCE]?: object })[AUTHENTICATED_AUDIENCE] === 'object'
  )
}

function isViewRuntime(value: BackendRuntimeContext): boolean {
  return (
    typeof value.workspaceId === 'string' &&
    value.workspaceId.length > 0 &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    typeof value.contributionKey === 'string' &&
    value.contributionKey.length > 0 &&
    typeof value.hostWindowId === 'string' &&
    value.hostWindowId.length > 0
  )
}

function isApprovedEventList(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((event) => isMethodName(event))
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
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
